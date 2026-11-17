package discovery

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"reflect"
	"testing"
	"time"

	"ldos/backend/internal/network"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/scheduler"
)

type ehTestValidator struct {
	direct  int
	proxies []string
	err     error
}

func (v *ehTestValidator) ValidateStatic(string) (network.Target, error) {
	return network.Target{}, v.err
}
func (v *ehTestValidator) ValidateDirect(context.Context, string) ([]string, error) {
	v.direct++
	return []string{"1.1.1.1"}, v.err
}
func (v *ehTestValidator) ValidateProxy(_ context.Context, _ string, endpoint string) ([]string, error) {
	v.proxies = append(v.proxies, endpoint)
	return []string{"1.1.1.1"}, v.err
}

type ehTestRelease struct {
	owner     string
	fault     bool
	cancelled bool
}
type ehTestPool struct {
	requests []proxypool.Request
	releases []ehTestRelease
	err      error
}

func (p *ehTestPool) Acquire(_ context.Context, request proxypool.Request) (*proxypool.Lease, error) {
	p.requests = append(p.requests, request)
	if p.err != nil {
		return nil, p.err
	}
	id := fmt.Sprint(len(p.requests))
	return &proxypool.Lease{Owner: request.Owner, NodeID: id, Endpoint: "http://proxy" + id + ":8080"}, nil
}
func (p *ehTestPool) Release(ctx context.Context, owner string, fault bool, _ string) error {
	p.releases = append(p.releases, ehTestRelease{owner, fault, ctx.Err() != nil})
	return nil
}
func (p *ehTestPool) Status() map[string]any { return nil }
func ehTestCandidates(n int) []map[string]any {
	rows := []map[string]any{}
	for i := 1; i <= n; i++ {
		rows = append(rows, map[string]any{"id": fmt.Sprint(i), "url": fmt.Sprintf("https://e-hentai.org/g/%d/token%d/", i, i), "metadata": map[string]any{"gallery_token": fmt.Sprintf("token%d", i)}, "matched_keywords": []string{"fixture", "別名"}})
	}
	return rows
}
func ehTestResult(n int) map[string]any {
	return map[string]any{"candidates": ehTestCandidates(n), "authors": []map[string]any{}}
}
func ehTestRows(body any) HTTPResult {
	rows := []any{}
	for _, pair := range body.(map[string]any)["gidlist"].([]any) {
		gid := pair.([]any)[0]
		rows = append(rows, map[string]any{"gid": gid, "token": "api-token", "title": fmt.Sprintf("Gallery &amp; %v", gid), "title_jpn": "日本 &amp; 語", "thumb": "https://ehgt.org/cover.webp", "filecount": "7", "uploader": "author &amp; co", "tags": []any{"artist:fixture &amp; co"}})
	}
	return HTTPResult{StatusCode: 200, Payload: map[string]any{"gmetadata": rows}}
}
func TestExhentaiDelegation(t *testing.T) {
	keyword := "foo bar"
	original := Request{Keyword: &keyword, Limit: 20, CredentialsRef: "cred", CookiesFile: "cookie", ConfigFile: "config", ExtraArgs: []string{"--verbose"}, TimeoutSeconds: 30, Policy: scheduler.Policy{ProxyMode: "direct", HTTPTimeout: 60, GalleryRetries: 2}}
	var captured Request
	adapter := ExhentaiAdapter{GalleryDiscover: func(_ context.Context, r Request) (map[string]any, error) {
		captured = r
		return map[string]any{"ok": true}, nil
	}}
	if _, err := adapter.Search(context.Background(), original); err != nil {
		t.Fatal(err)
	}
	if captured.URL != "https://e-hentai.org/?f_search=foo+bar" || captured.Site != "exhentai" || captured.RangeKind != "child" {
		t.Fatalf("search: %+v", captured)
	}
	if captured.Policy.HTTPTimeout != 10 || captured.Policy.GalleryRetries != 0 || original.Policy.HTTPTimeout != 60 || original.Policy.GalleryRetries != 2 {
		t.Fatalf("search must bound each attempt without changing the download policy: %+v", captured.Policy)
	}
	if captured.CredentialsRef != original.CredentialsRef || captured.CookiesFile != original.CookiesFile || captured.ConfigFile != original.ConfigFile || !reflect.DeepEqual(captured.ExtraArgs, original.ExtraArgs) || captured.Keyword != original.Keyword {
		t.Fatalf("lost request fields: %+v", captured)
	}
	for _, path := range []string{"g", "s", "mpv"} {
		r := original
		r.URL = "https://exhentai.org/" + path + "/30/token/"
		if _, err := adapter.Discover(context.Background(), r); err != nil {
			t.Fatal(err)
		}
		if captured.RangeKind != "file" || captured.Limit != 1 {
			t.Fatalf("%s: %+v", path, captured)
		}
		r.RangeKind = "post"
		_, _ = adapter.Discover(context.Background(), r)
		if captured.RangeKind != "post" || captured.Limit != 20 {
			t.Fatalf("explicit range overwritten: %+v", captured)
		}
	}
	original.URL = "https://e-hentai.org/?f_search=foo"
	_, _ = adapter.Discover(context.Background(), original)
	if captured.RangeKind != "child" || captured.Limit != 20 {
		t.Fatalf("listing: %+v", captured)
	}
}
func TestExhentaiPreviewBatches(t *testing.T) {
	validator := &ehTestValidator{}
	sizes := []int{}
	transport := &Transport{Validator: validator, HTTPRequest: func(_ context.Context, method, target string, params url.Values, body any, endpoint string, timeout time.Duration) (HTTPResult, error) {
		if method != "POST" || target != ehAPI || endpoint != "" || timeout != 10*time.Second || len(params) != 0 {
			t.Fatalf("HTTP arguments: %s %s %s %s", method, target, endpoint, timeout)
		}
		request := body.(map[string]any)
		if request["method"] != "gdata" || request["namespace"] != 1 {
			t.Fatalf("request: %v", request)
		}
		sizes = append(sizes, len(request["gidlist"].([]any)))
		return ehTestRows(body), nil
	}}
	input := ehTestResult(30)
	candidates := input["candidates"].([]map[string]any)
	duplicate := ehTestCandidates(1)[0]
	duplicate["metadata"] = map[string]any{"gallery_token": "original-duplicate"}
	input["candidates"] = append(candidates, duplicate, map[string]any{"id": "missing", "metadata": map[string]any{}})
	adapter := ExhentaiAdapter{Transport: transport}
	result, err := adapter.EnrichPreviews(context.Background(), input, scheduler.Policy{ProxyMode: "direct", HTTPTimeout: 10}, "", 30)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sizes, []int{25, 5}) || validator.direct != 1 {
		t.Fatalf("batches %v validation %d", sizes, validator.direct)
	}
	if result["preview_count"] != 31 || result["preview_missing_count"] != 1 || result["candidate_count"] != 32 {
		t.Fatalf("counts: %v", result)
	}
	got := result["candidates"].([]map[string]any)
	for i := 0; i < 30; i++ {
		if got[i]["id"] != fmt.Sprint(i+1) || got[i]["title"] != fmt.Sprintf("Gallery & %d", i+1) {
			t.Fatalf("row %d: %v", i, got[i])
		}
	}
	if got[30]["metadata"].(map[string]any)["gallery_token"] != "original-duplicate" || !reflect.DeepEqual(got[0]["matched_keywords"], []string{"fixture", "別名"}) {
		t.Fatalf("provenance: %v", got[30])
	}
	metadata := got[0]["metadata"].(map[string]any)
	if metadata["title_jpn"] != "日本 & 語" || !reflect.DeepEqual(metadata["tags"], []string{"artist:fixture & co"}) || got[0]["author"].(map[string]any)["name"] != "author & co" {
		t.Fatalf("HTML normalization: %v", got[0])
	}
	authors := result["authors"].([]map[string]any)
	if len(authors) == 0 {
		t.Fatal("missing authors")
	}
	// A second enrichment must merge the same authors without duplication.
	_, err = adapter.EnrichPreviews(context.Background(), result, scheduler.Policy{ProxyMode: "direct", HTTPTimeout: 10}, "", 30)
	if err != nil || len(result["authors"].([]map[string]any)) != len(authors) {
		t.Fatalf("author merge: %v %v", result["authors"], err)
	}
}
func TestExhentaiPartialAndEmpty(t *testing.T) {
	adapter := ExhentaiAdapter{}
	result, err := adapter.EnrichPreviews(context.Background(), map[string]any{"candidates": []any{nil, "invalid", map[string]any{"id": "1"}}}, scheduler.Policy{}, "", 1)
	if err != nil || result["preview_count"] != 0 || result["preview_missing_count"] != 1 {
		t.Fatalf("empty: %v %v", result, err)
	}
	adapter.Transport = &Transport{Validator: &ehTestValidator{}, HTTPRequest: func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
		return HTTPResult{StatusCode: 200, Payload: map[string]any{"gmetadata": []any{map[string]any{"gid": 1, "error": "not available"}, nil}}}, nil
	}}
	result, err = adapter.EnrichPreviews(context.Background(), ehTestResult(2), scheduler.Policy{ProxyMode: "direct"}, "", 1)
	if err != nil || result["preview_count"] != 0 || result["preview_missing_count"] != 2 {
		t.Fatalf("partial: %v %v", result, err)
	}
}
func TestExhentaiFailureMapping(t *testing.T) {
	cases := []struct {
		name     string
		response HTTPResult
		err      error
		calls    int
	}{
		{"redirect", HTTPResult{StatusCode: 302}, nil, 1},
		{"forbidden", HTTPResult{StatusCode: 403}, nil, 1},
		{"server", HTTPResult{StatusCode: 503}, nil, 3},
		{"rate", HTTPResult{StatusCode: 429}, nil, 3},
		{"timeout", HTTPResult{}, &net.DNSError{Err: "timeout", IsTimeout: true}, 3},
		{"json", HTTPResult{StatusCode: 200, JSONError: errors.New("invalid JSON")}, nil, 1},
		{"empty-json", HTTPResult{StatusCode: 200, JSONError: io.EOF}, nil, 1},
		{"array", HTTPResult{StatusCode: 200, Payload: []any{}}, nil, 1},
		{"missing", HTTPResult{StatusCode: 200, Payload: map[string]any{}}, nil, 1},
		{"api-error", HTTPResult{StatusCode: 200, Payload: map[string]any{"error": "bad request"}}, nil, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			v := &ehTestValidator{}
			adapter := ExhentaiAdapter{Transport: &Transport{Validator: v, HTTPRequest: func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
				calls++
				return tc.response, tc.err
			}}}
			_, err := adapter.EnrichPreviews(context.Background(), ehTestResult(1), scheduler.Policy{ProxyMode: "direct", RetryLimit: 2}, "", 1)
			var public *Error
			if !errors.As(err, &public) || public.Code != "exhentai_preview_lookup_failed" || calls != tc.calls || v.direct != 1 {
				t.Fatalf("calls=%d direct=%d err=%v", calls, v.direct, err)
			}
		})
	}
}
func TestExhentaiProxyRetryAndBatchRelease(t *testing.T) {
	pool := &ehTestPool{}
	v := &ehTestValidator{}
	calls := 0
	adapter := ExhentaiAdapter{Transport: &Transport{Pool: pool, Validator: v, HTTPRequest: func(_ context.Context, _ string, _ string, _ url.Values, body any, endpoint string, timeout time.Duration) (HTTPResult, error) {
		calls++
		if endpoint != fmt.Sprintf("http://proxy%d:8080", calls) || timeout != time.Second {
			t.Fatalf("endpoint %s timeout %s", endpoint, timeout)
		}
		if calls == 1 {
			return HTTPResult{StatusCode: 503}, nil
		}
		return ehTestRows(body), nil
	}}}
	result, err := adapter.EnrichPreviews(context.Background(), ehTestResult(30), scheduler.Policy{ProxyMode: "required", RetryLimit: 1, NodeTags: []string{"eh"}, HTTPTimeout: 0.1}, "", 0.5)
	if err != nil {
		t.Fatal(err)
	}
	if result["preview_count"] != 30 || calls != 3 || len(pool.releases) != 3 || v.direct != 0 || len(v.proxies) != 3 {
		t.Fatalf("result=%v calls=%d releases=%v", result, calls, pool.releases)
	}
	if !pool.releases[0].fault || pool.releases[1].fault || pool.releases[2].fault {
		t.Fatalf("faults: %+v", pool.releases)
	}
	if !reflect.DeepEqual(pool.requests[1].ExcludeIDs, []string{"1"}) || len(pool.requests[2].ExcludeIDs) != 0 || !reflect.DeepEqual(pool.requests[0].NodeTags, []string{"eh"}) {
		t.Fatalf("requests: %+v", pool.requests)
	}
	for i, release := range pool.releases {
		if release.owner != pool.requests[i].Owner || release.cancelled {
			t.Fatalf("release: %+v", release)
		}
	}
}
func TestExhentaiCancellationAndValidation(t *testing.T) {
	t.Run("cancel releases lease", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		pool := &ehTestPool{}
		calls := 0
		adapter := ExhentaiAdapter{Transport: &Transport{Pool: pool, Validator: &ehTestValidator{}, HTTPRequest: func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
			calls++
			cancel()
			return HTTPResult{}, ctx.Err()
		}}}
		_, err := adapter.EnrichPreviews(ctx, ehTestResult(1), scheduler.Policy{ProxyMode: "required", RetryLimit: 2}, "", 1)
		if !errors.Is(err, context.Canceled) || calls != 1 || len(pool.releases) != 1 || pool.releases[0].fault || pool.releases[0].cancelled {
			t.Fatalf("cancel: %v %v", err, pool.releases)
		}
	})
	t.Run("direct validation fails before request", func(t *testing.T) {
		adapter := ExhentaiAdapter{Transport: &Transport{Validator: &ehTestValidator{err: errors.New("validation failed")}}}
		_, err := adapter.EnrichPreviews(context.Background(), ehTestResult(1), scheduler.Policy{ProxyMode: "direct"}, "", 1)
		var public *Error
		if !errors.As(err, &public) || public.Code != "invalid_network_target" {
			t.Fatal(err)
		}
	})
	t.Run("proxy acquire never falls back", func(t *testing.T) {
		pool := &ehTestPool{err: errors.New("acquire failed")}
		adapter := ExhentaiAdapter{Transport: &Transport{Pool: pool, Validator: &ehTestValidator{}}}
		_, err := adapter.EnrichPreviews(context.Background(), ehTestResult(1), scheduler.Policy{ProxyMode: "auto"}, "", 1)
		var public *Error
		if !errors.As(err, &public) || public.Code != "proxy_unavailable" {
			t.Fatal(err)
		}
	})
}
