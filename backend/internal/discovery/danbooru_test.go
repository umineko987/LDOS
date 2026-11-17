package discovery

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ldos/backend/internal/gallery"
	"ldos/backend/internal/network"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/scheduler"
)

type danTestPool struct {
	mu       sync.Mutex
	acquired []proxypool.Request
	released []bool
	nodes    []map[string]any
	noUS     bool
}

func (p *danTestPool) Acquire(_ context.Context, r proxypool.Request) (*proxypool.Lease, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.acquired = append(p.acquired, r)
	if p.noUS && len(r.NodeTags) > 0 && r.NodeTags[0] == "us" {
		return nil, nil
	}
	id, endpoint := "node-1", "http://127.0.0.1:29001"
	if len(r.ExcludeIDs) > 0 {
		id = "node-2"
		endpoint = "http://127.0.0.1:29002"
	}
	return &proxypool.Lease{Owner: r.Owner, NodeID: id, Name: id, Endpoint: endpoint, Protocol: "http"}, nil
}
func (p *danTestPool) Release(_ context.Context, _ string, fault bool, _ string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.released = append(p.released, fault)
	return nil
}
func (p *danTestPool) Status() map[string]any { return map[string]any{"nodes": p.nodes} }

type danTestValidator struct {
	mu      sync.Mutex
	direct  int
	proxies []string
	err     error
}

func (v *danTestValidator) ValidateStatic(string) (network.Target, error) {
	return network.Target{}, nil
}
func (v *danTestValidator) ValidateDirect(context.Context, string) ([]string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.direct++
	return nil, v.err
}
func (v *danTestValidator) ValidateProxy(_ context.Context, _ string, endpoint string) ([]string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.proxies = append(v.proxies, endpoint)
	return nil, v.err
}
func danTestAdapter() (*DanbooruAdapter, *danTestPool, *danTestValidator) {
	pool := &danTestPool{}
	validator := &danTestValidator{}
	return &DanbooruAdapter{Transport: &Transport{Pool: pool, Validator: validator}}, pool, validator
}
func danTestPolicy() scheduler.Policy { return scheduler.Policy{ProxyMode: "direct", HTTPTimeout: 3} }
func danTestRequest() Request {
	keyword := "fixture"
	return Request{Keyword: &keyword, Limit: 20, Policy: danTestPolicy(), TimeoutSeconds: 1}
}
func danErrorCode(t *testing.T, err error, code string) *Error {
	t.Helper()
	var public *Error
	if !errors.As(err, &public) || public.Code != code {
		t.Fatalf("error = %v, want %s", err, code)
	}
	return public
}

func TestDanbooruPostsPaginationDeduplication(t *testing.T) {
	a, _, _ := danTestAdapter()
	calls := 0
	a.Transport.HTTPRequest = func(_ context.Context, method, target string, params url.Values, _ any, endpoint string, timeout time.Duration) (HTTPResult, error) {
		calls++
		if method != "GET" || target != danBaseURL+"/posts.json" || endpoint != "" || timeout != 3*time.Second {
			t.Fatalf("unexpected request %s %s %s %v", method, target, endpoint, timeout)
		}
		rows := []map[string]any{}
		switch calls {
		case 1:
			if params.Get("limit") != "200" || params.Get("page") != "" {
				t.Fatal(params)
			}
			for id := 1000; id >= 801; id-- {
				rows = append(rows, map[string]any{"id": id, "tag_string_artist": "fixture"})
			}
		case 2:
			if params.Get("page") != "b801" || params.Get("limit") != "2" {
				t.Fatal(params)
			}
			rows = []map[string]any{{"id": 801, "tag_string_artist": "fixture"}, {"id": 800, "tag_string_artist": "fixture"}}
		case 3:
			if params.Get("page") != "b800" || params.Get("limit") != "1" {
				t.Fatal(params)
			}
			rows = []map[string]any{{"id": 799, "tag_string_artist": "second"}}
		default:
			t.Fatal("unbounded pagination")
		}
		return HTTPResult{StatusCode: 200, Payload: rows}, nil
	}
	request := danTestRequest()
	request.Limit = 202
	result, err := a.SearchPostsAPI(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	rows := result["candidates"].([]map[string]any)
	if len(rows) != 202 || rows[0]["id"] != "1000" || rows[200]["id"] != "800" || rows[201]["id"] != "799" || result["author_count"] != 2 || result["attempts"] != 3 {
		t.Fatal(result)
	}
}
func TestDanbooruPostsRejectInvalidPagination(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload any
		limit   int
		calls   int
	}{{"shape", map[string]any{}, 2, 1}, {"missing IDs", []any{map[string]any{}, map[string]any{}}, 2, 1}, {"stalled cursor", []any{map[string]any{"id": 5}, map[string]any{"id": 5}}, 2, 2}} {
		t.Run(tc.name, func(t *testing.T) {
			a, _, _ := danTestAdapter()
			calls := 0
			a.Transport.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
				calls++
				return HTTPResult{StatusCode: 200, Payload: tc.payload}, nil
			}
			request := danTestRequest()
			request.Limit = tc.limit
			_, err := a.SearchPostsAPI(context.Background(), request)
			danErrorCode(t, err, "danbooru_api_protocol")
			if calls != tc.calls {
				t.Fatalf("calls %d", calls)
			}
		})
	}
}
func TestDanbooruAPIStatusRetryAndProxyRotation(t *testing.T) {
	for _, tc := range []struct {
		name         string
		status       int
		body         string
		jsonError    bool
		retry, fault bool
	}{{"challenge", 403, "Just a moment", false, true, true}, {"throttle", 429, "", false, true, false}, {"unavailable", 503, "", false, true, false}, {"request timeout", 408, "", false, true, false}, {"too early", 425, "", false, true, false}, {"forbidden", 403, "forbidden", false, false, false}, {"redirect", 302, "", false, false, false}, {"invalid JSON", 200, "", true, false, false}} {
		t.Run(tc.name, func(t *testing.T) {
			a, p, v := danTestAdapter()
			calls := 0
			endpoints := []string{}
			a.Transport.HTTPRequest = func(_ context.Context, _ string, _ string, _ url.Values, _ any, endpoint string, _ time.Duration) (HTTPResult, error) {
				calls++
				endpoints = append(endpoints, endpoint)
				if calls > 1 {
					return HTTPResult{StatusCode: 200, Payload: []any{}}, nil
				}
				response := HTTPResult{StatusCode: tc.status, Text: tc.body}
				if tc.jsonError {
					response.JSONError = errors.New("bad JSON")
				}
				return response, nil
			}
			policy := danTestPolicy()
			policy.ProxyMode = "required"
			policy.RetryLimit = 1
			outcome, err := a.APIJSON(context.Background(), danBaseURL+"/posts.json", nil, policy, "", true)
			if tc.retry {
				if err != nil || outcome.Attempts != 2 {
					t.Fatalf("%+v %v", outcome, err)
				}
			} else {
				public := danErrorCode(t, err, "danbooru_api_failed")
				if public.Details.(map[string]any)["status_code"] != tc.status {
					t.Fatal(public)
				}
			}
			if !reflect.DeepEqual(v.proxies, endpoints) || p.released[0] != tc.fault {
				t.Fatalf("validation %v endpoints %v release %v", v.proxies, endpoints, p.released)
			}
			for _, request := range p.acquired {
				if request.ProbeURL != danBaseURL+"/" {
					t.Fatal(request)
				}
			}
			if tc.retry && tc.fault {
				if !reflect.DeepEqual(p.acquired[1].ExcludeIDs, []string{"node-1"}) || outcome.Proxy["node_id"] != "node-2" {
					t.Fatal(p.acquired)
				}
			}
		})
	}
}
func TestDanbooruUSPreferenceFallbackAndExplicitPolicy(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		t.Run(fmt.Sprint(explicit), func(t *testing.T) {
			a, p, _ := danTestAdapter()
			p.nodes = []map[string]any{{"healthy": true, "tags": []string{"us"}}}
			p.noUS = true
			a.Transport.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
				return HTTPResult{StatusCode: 200, Payload: []any{}}, nil
			}
			policy := danTestPolicy()
			policy.ProxyMode = "required"
			probe := "https://custom.example/"
			policy.ProbeURL = &probe
			if explicit {
				policy.NodeTags = []string{"jp"}
			}
			_, err := a.APIJSON(context.Background(), danBaseURL+"/posts.json", nil, policy, "", true)
			if err != nil {
				t.Fatal(err)
			}
			if explicit {
				if len(p.acquired) != 1 || !reflect.DeepEqual(p.acquired[0].NodeTags, []string{"jp"}) {
					t.Fatal(p.acquired)
				}
			} else if len(p.acquired) != 2 || len(p.acquired[1].NodeTags) != 0 {
				t.Fatal(p.acquired)
			}
			for _, r := range p.acquired {
				if r.ProbeURL != probe {
					t.Fatal(r)
				}
			}
		})
	}
}
func TestDanbooruSearchGalleryCredentialsAndFallback(t *testing.T) {
	for _, artists := range []bool{false, true} {
		for _, kind := range []string{"success", "empty", "failure", "dns", "unexpected"} {
			t.Run(fmt.Sprintf("artists=%v/%s", artists, kind), func(t *testing.T) {
				a, _, _ := danTestAdapter()
				a.Transport.Gallery = danAuthTestCapturer{resolve: func(context.Context, gallery.Request) (http.Header, error) {
					return http.Header{}, nil
				}}
				request := danTestRequest()
				request.CredentialsRef = "credential"
				request.CookiesFile = "cookies"
				request.ConfigFile = "config"
				request.ExtraArgs = []string{"--filter", "score > 1"}
				galleryCalls, apiCalls := 0, 0
				a.GalleryDiscover = func(_ context.Context, r Request) (map[string]any, error) {
					galleryCalls++
					if r.CredentialsRef != request.CredentialsRef || r.CookiesFile != request.CookiesFile || r.ConfigFile != request.ConfigFile || r.TimeoutSeconds != request.TimeoutSeconds || r.Policy.ProbeURL == nil || *r.Policy.ProbeURL != danBaseURL+"/" {
						t.Fatal(r)
					}
					if artists {
						if r.RangeKind != "child" || !reflect.DeepEqual(r.ExtraArgs, request.ExtraArgs) || !strings.Contains(r.URL, "any_name_matches") {
							t.Fatal(r)
						}
					} else if r.RangeKind != "post" || !reflect.DeepEqual(r.ExtraArgs, request.ExtraArgs) {
						t.Fatal(r)
					}
					switch kind {
					case "failure":
						return nil, &Error{Code: "discovery_failed", Message: "fixture"}
					case "dns":
						return nil, &Error{Code: "proxy_dns_failed", Message: "fixture"}
					case "unexpected":
						return nil, errors.New("unexpected")
					}
					count := 0
					if kind == "success" {
						count = 1
					}
					return map[string]any{"candidate_count": count, "author_count": count}, nil
				}
				a.Transport.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
					apiCalls++
					return HTTPResult{StatusCode: 200, Payload: []any{}}, nil
				}
				search := a.Search
				if artists {
					search = a.SearchArtists
				}
				_, err := search(context.Background(), request)
				wantAPI := kind == "empty" || kind == "failure"
				if kind == "dns" {
					danErrorCode(t, err, "proxy_dns_failed")
				} else if kind == "unexpected" {
					if err == nil {
						t.Fatal("lost unexpected error")
					}
				} else if err != nil {
					t.Fatal(err)
				}
				if galleryCalls != 1 || (apiCalls > 0) != wantAPI {
					t.Fatalf("gallery %d API %d", galleryCalls, apiCalls)
				}
			})
		}
	}
}
func TestDanbooruFallbackTimeoutAndCancellation(t *testing.T) {
	for _, cancelParent := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelParent), func(t *testing.T) {
			a, _, _ := danTestAdapter()
			a.GalleryDiscover = func(context.Context, Request) (map[string]any, error) { return map[string]any{}, nil }
			a.Transport.HTTPRequest = func(ctx context.Context, _ string, _ string, _ url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
				<-ctx.Done()
				return HTTPResult{}, ctx.Err()
			}
			request := danTestRequest()
			request.TimeoutSeconds = .01
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if cancelParent {
				cancel()
			}
			_, err := a.Search(ctx, request)
			if cancelParent {
				if !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
			} else {
				public := danErrorCode(t, err, "discovery_failed")
				if public.Details.(map[string]any)["timeout_seconds"] != .01 {
					t.Fatal(public)
				}
			}
		})
	}
}
func TestDanbooruDiscoverTagsAndCredentials(t *testing.T) {
	for _, credential := range []string{"", "ref", "cookies", "config", "args", "keyword"} {
		t.Run(credential, func(t *testing.T) {
			a, _, v := danTestAdapter()
			request := danTestRequest()
			request.Keyword = nil
			request.URL = danBaseURL + "/posts/?tags=artist+tag"
			switch credential {
			case "ref":
				request.CredentialsRef = "ref"
			case "cookies":
				request.CookiesFile = "cookies"
			case "config":
				request.ConfigFile = "config"
			case "args":
				request.ExtraArgs = []string{"--verbose"}
			case "keyword":
				keyword := "artist"
				request.Keyword = &keyword
			}
			galleryCalls, apiCalls := 0, 0
			a.GalleryDiscover = func(context.Context, Request) (map[string]any, error) { galleryCalls++; return map[string]any{}, nil }
			a.Transport.HTTPRequest = func(_ context.Context, _ string, _ string, params url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
				apiCalls++
				if params.Get("tags") != "artist tag" {
					t.Fatal(params)
				}
				return HTTPResult{StatusCode: 200, Payload: []any{}}, nil
			}
			_, err := a.Discover(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			if credential == "" {
				if apiCalls != 1 || galleryCalls != 0 || v.direct != 0 {
					t.Fatalf("API %d gallery %d DNS %d", apiCalls, galleryCalls, v.direct)
				}
			} else if galleryCalls != 1 || apiCalls != 0 {
				t.Fatalf("API %d gallery %d", apiCalls, galleryCalls)
			}
		})
	}
}
func TestDanbooruArtistDirectoryAndAutocomplete(t *testing.T) {
	a, _, _ := danTestAdapter()
	a.Transport.HTTPRequest = func(_ context.Context, _ string, target string, params url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
		if strings.HasSuffix(target, "artists.json") {
			if params.Get("search[any_name_matches]") != "fixture name" || params.Get("limit") != "200" {
				t.Fatal(params)
			}
			return HTTPResult{StatusCode: 200, Payload: []any{map[string]any{"id": 12, "name": "fixture_name", "other_names": []string{"別名"}, "group_name": "circle"}, map[string]any{"name": ""}, "invalid"}}, nil
		}
		if params.Get("limit") != "20" || params.Get("version") != "1" || params.Get("search[type]") != "tag_query" {
			t.Fatal(params)
		}
		return HTTPResult{StatusCode: 200, Payload: []any{map[string]any{"value": " fixture_name ", "category": 1, "post_count": "42", "antecedent": "別名", "type": "tag-other-name"}, map[string]any{"value": "general", "category": 999}, map[string]any{"value": ""}, "invalid"}}, nil
	}
	request := danTestRequest()
	keyword := " fixture \n name "
	request.Keyword = &keyword
	request.Limit = 300
	result, err := a.SearchArtistsAPI(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	authors := result["authors"].([]map[string]any)
	if len(authors) != 1 || authors[0]["name"] != "fixture_name" || authors[0]["group_name"] != "circle" || result["candidate_count"] != 0 {
		t.Fatal(result)
	}
	result, err = a.Autocomplete(context.Background(), "fixture", 50, request.Policy, "")
	if err != nil {
		t.Fatal(err)
	}
	items := result["items"].([]map[string]any)
	if len(items) != 2 || items[0]["label"] != "fixture name" || items[0]["category"] != "artist" || items[0]["post_count"] != 42 || items[1]["category"] != "general" || items[1]["post_count"] != nil || items[1]["antecedent"] != nil {
		t.Fatal(result)
	}
}
func TestDanbooruArtistProfileExactIdentityAndLease(t *testing.T) {
	for _, exact := range []bool{false, true} {
		t.Run(fmt.Sprint(exact), func(t *testing.T) {
			a, p, v := danTestAdapter()
			calls := 0
			endpoints := []string{}
			a.Transport.HTTPRequest = func(_ context.Context, _ string, target string, params url.Values, _ any, endpoint string, _ time.Duration) (HTTPResult, error) {
				calls++
				endpoints = append(endpoints, endpoint)
				if strings.HasSuffix(target, "artists.json") {
					name := "different"
					if exact {
						name = "Artist_Name"
					}
					return HTTPResult{StatusCode: 200, Payload: []any{map[string]any{"id": 55, "name": name, "other_names": []string{"artist name"}}}}, nil
				}
				if params.Get("search[artist_id]") != "55" || params.Get("limit") != "100" {
					t.Fatal(params)
				}
				return HTTPResult{StatusCode: 200, Payload: []any{map[string]any{"id": 99, "url": "https://x.com/artist_name"}, map[string]any{"id": 100, "url": "https://www.pixiv.net/users/123", "is_active": false}}}, nil
			}
			policy := danTestPolicy()
			policy.ProxyMode = "required"
			profile, err := a.ArtistProfile(context.Background(), "artist name", policy, "")
			if err != nil {
				t.Fatal(err)
			}
			if exact {
				if profile["id"] != "55" {
					t.Fatal(profile)
				}
				links := profile["related_profiles"].([]map[string]any)
				if len(links) != 2 || links[0]["crawl_url"] != "https://x.com/artist_name/media" || links[0]["active"] != true || links[1]["active"] != false {
					t.Fatal(links)
				}
			} else if profile != nil || calls != 1 {
				t.Fatal(profile, calls)
			}
			if len(v.proxies) != 1 || len(p.released) != 1 || p.released[0] {
				t.Fatal(v.proxies, p.released)
			}
			for _, endpoint := range endpoints {
				if endpoint != v.proxies[0] {
					t.Fatal(endpoints, v.proxies)
				}
			}
		})
	}
}
func TestDanbooruArtistProfilesConcurrencyOrderAndIsolation(t *testing.T) {
	a, _, _ := danTestAdapter()
	var active, peak atomic.Int32
	started := make(chan string, 8)
	release := make(chan struct{})
	var calls sync.Map
	a.Transport.HTTPRequest = func(ctx context.Context, _ string, target string, params url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
		if strings.HasSuffix(target, "artist_urls.json") {
			return HTTPResult{StatusCode: 200, Payload: []any{}}, nil
		}
		name := params.Get("search[name]")
		calls.Store(name, true)
		current := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); current > old && !peak.CompareAndSwap(old, current); old = peak.Load() {
		}
		started <- name
		select {
		case <-release:
		case <-ctx.Done():
			return HTTPResult{}, ctx.Err()
		}
		if name == "bad" {
			return HTTPResult{StatusCode: 403, Text: "denied"}, nil
		}
		if name == "missing" {
			return HTTPResult{StatusCode: 200, Payload: []any{}}, nil
		}
		return HTTPResult{StatusCode: 200, Payload: []any{map[string]any{"id": 7, "name": name}}}, nil
	}
	type result struct {
		profiles []map[string]any
		failures []map[string]string
		err      error
	}
	done := make(chan result, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go func() {
		p, f, e := a.ArtistProfiles(ctx, []string{" a ", "bad", "c", "missing", "e", "a", "f", "ignored"}, danTestPolicy(), "", 6)
		done <- result{p, f, e}
	}()
	for i := 0; i < 4; i++ {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("four requests did not start")
		}
	}
	if peak.Load() != 4 {
		t.Fatalf("peak %d", peak.Load())
	}
	close(release)
	got := <-done
	if got.err != nil {
		t.Fatal(got.err)
	}
	names := []string{}
	for _, profile := range got.profiles {
		names = append(names, profile["name"].(string))
	}
	if !reflect.DeepEqual(names, []string{"a", "c", "e", "f"}) || len(got.failures) != 1 || got.failures[0]["artist"] != "bad" || peak.Load() > 4 {
		t.Fatal(names, got.failures, peak.Load())
	}
	if _, exists := calls.Load("ignored"); exists {
		t.Fatal("profile limit ignored")
	}
}
func TestDanbooruAPIDNSFailureDoesNotRequest(t *testing.T) {
	a, _, v := danTestAdapter()
	v.err = &network.Error{Code: "encrypted_dns_unavailable", Message: "fixture"}
	a.Transport.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
		t.Fatal("HTTP must not follow failed DNS validation")
		return HTTPResult{}, nil
	}
	_, err := a.APIJSON(context.Background(), danBaseURL+"/posts.json", nil, danTestPolicy(), "", true)
	danErrorCode(t, err, "encrypted_dns_unavailable")
}
