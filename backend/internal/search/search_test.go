package search

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/scheduler"
)

type fakeEngine struct {
	search   func(context.Context, discovery.Request) (map[string]any, error)
	artists  func(context.Context, discovery.Request) (map[string]any, error)
	profiles func(context.Context, []string) ([]map[string]any, []map[string]string, error)
}

func emptyResult() map[string]any {
	return map[string]any{"candidates": []map[string]any{}, "authors": []map[string]any{}, "candidate_count": 0, "attempts": 1}
}
func (f fakeEngine) Search(ctx context.Context, r discovery.Request) (map[string]any, error) {
	if f.search != nil {
		return f.search(ctx, r)
	}
	return emptyResult(), nil
}
func (f fakeEngine) SearchArtists(ctx context.Context, r discovery.Request) (map[string]any, error) {
	if f.artists != nil {
		return f.artists(ctx, r)
	}
	return emptyResult(), nil
}
func (f fakeEngine) ArtistProfiles(ctx context.Context, names []string, _ scheduler.Policy, _ string, _ int) ([]map[string]any, []map[string]string, error) {
	if f.profiles != nil {
		return f.profiles(ctx, names)
	}
	return []map[string]any{}, []map[string]string{}, nil
}
func (f fakeEngine) Autocomplete(_ context.Context, q string, n int, _ scheduler.Policy, _ string) (map[string]any, error) {
	return map[string]any{"query": q, "items": []map[string]any{{"limit": n}}}, nil
}
func (f fakeEngine) EnrichPreviews(_ context.Context, result map[string]any, _ scheduler.Policy, _ string, _ float64) (map[string]any, error) {
	return result, nil
}
func fixtureService(t *testing.T, engine fakeEngine) *Service {
	t.Helper()
	s, err := New(Dependencies{Discovery: engine,
		Policy: func(context.Context, string) (scheduler.Policy, error) {
			p := scheduler.DefaultPolicy()
			p.ProxyMode = "direct"
			return p, nil
		},
		Credentials: func(_ context.Context, _ string, opt SourceOptions) (Credentials, error) {
			return Credentials{Reference: text(opt.CredentialsRef), CookiesFile: text(opt.CookiesFile), ConfigFile: text(opt.ConfigFile)}, nil
		},
		AuthStatus: func(context.Context, string) (map[string]any, error) {
			return map[string]any{"authorized": true, "state": "ready"}, nil
		}, ValidateStatic: func(string) error { return nil }, ValidateDirect: func(context.Context, string) error { return nil }, ValidateArgs: func(args []string) ([]string, error) { return args, nil }})
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func request(t *testing.T, raw string) Request {
	t.Helper()
	r, err := DecodeRequest([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func directory() map[string]any {
	return map[string]any{"authors": []map[string]any{{"id": 42, "name": "fixture", "works_url": "https://danbooru.donmai.us/posts?tags=fixture", "url": "https://danbooru.donmai.us/artists/42", "other_names": []string{"alias"}, "origin": "danbooru_artist_directory"}}}
}
func TestSourceOptionPresenceAndValidation(t *testing.T) {
	body := request(t, `{"keyword":" fixture ","sites":[" X ","twitter"],"proxy_mode":"required","cookies_file":"root","search_extra_args":["--verbose"],"source_options":{"x":{"proxy_mode":null,"cookies_file":null,"search_extra_args":["--quiet"]}}}`)
	p, err := buildPlan(body)
	if err != nil || !p.implicit || !reflect.DeepEqual(p.sites, []string{"danbooru", "twitter"}) {
		t.Fatal(p, err)
	}
	opt := p.options["twitter"]
	if opt.ProxyMode != nil || opt.CookiesFile != nil || opt.TimeoutSeconds != 180 || !reflect.DeepEqual(opt.ExtraArgs, []string{"--verbose", "--quiet"}) {
		t.Fatal(opt)
	}
	if text(p.options["danbooru"].ProxyMode) != "required" {
		t.Fatal(p)
	}
	for _, raw := range []string{`null`, `{}`, `{"keyword":" "}`, `{"keyword":"a","unknown":1}`, `{"keyword":"a","sites":null}`, `{"keyword":"a","sites":[null]}`, `{"keyword":"a","search_extra_args":[null]}`, `{"keyword":"a","timeout_seconds":null}`, `{"keyword":"a","source_options":null}`, `{"keyword":"a","source_options":{"x":null}}`, `{"keyword":"a","source_options":{"x":{"keyword":"b"}}}`, `{"keyword":"a","limit":1.2}`} {
		if _, err := DecodeRequest([]byte(raw)); err == nil {
			t.Fatal("accepted", raw)
		}
	}
	body = request(t, `{"keyword":"a","source_options":{"x":{},"twitter":{}}}`)
	if _, err := buildPlan(body); err == nil {
		t.Fatal("duplicate aliases accepted")
	}
}
func TestImplicitArtistDiscoveryAndSourceOrder(t *testing.T) {
	var calls atomic.Int32
	s := fixtureService(t, fakeEngine{
		artists: func(context.Context, discovery.Request) (map[string]any, error) {
			calls.Add(1)
			return directory(), nil
		},
		search: func(_ context.Context, r discovery.Request) (map[string]any, error) {
			if r.Site != "danbooru" {
				t.Error("native account search", r.Site)
			}
			return emptyResult(), nil
		},
		profiles: func(_ context.Context, names []string) ([]map[string]any, []map[string]string, error) {
			if !reflect.DeepEqual(names, []string{"fixture"}) {
				t.Error(names)
			}
			return []map[string]any{{"id": 42, "name": "fixture", "related_profiles": []map[string]any{{"url": "https://x.com/fixture", "crawl_site": "twitter", "crawl_url": "https://x.com/fixture/media", "active": true}, {"url": "https://pixiv.net/users/42", "crawl_site": "pixiv", "crawl_url": "https://www.pixiv.net/users/42/artworks", "active": true}, {"url": "https://x.com/inactive", "crawl_site": "twitter", "crawl_url": "https://x.com/inactive", "active": false}}}}, nil, nil
		},
	})
	result, err := s.Perform(context.Background(), request(t, `{"keyword":"fixture","sites":["pixiv","x"]}`))
	if err != nil {
		t.Fatal(err)
	}
	sources := rows(result["sources"])
	if calls.Load() != 1 || len(sources) != 2 || sources[0]["site"] != "pixiv" || sources[1]["site"] != "twitter" || result["address_count"] != 2 || len(rows(result["related_profiles"])) != 3 {
		t.Fatal(result, calls.Load())
	}
	for i, source := range sources {
		address := rows(source["addresses"])[0]
		if source["order"] != i || address["confidence"] != "verified" || address["origin"] != "danbooru_artist_url" {
			t.Fatal(source)
		}
	}
}
func TestUpstreamFailureIsPartialForAccounts(t *testing.T) {
	s := fixtureService(t, fakeEngine{search: func(context.Context, discovery.Request) (map[string]any, error) {
		return nil, &discovery.Error{Code: "encrypted_dns_unavailable", Message: "upstream unavailable"}
	}, artists: func(context.Context, discovery.Request) (map[string]any, error) {
		return nil, errors.New("directory failed")
	}})
	result, err := s.Perform(context.Background(), request(t, `{"keyword":"fixture","sites":["twitter","pixiv"]}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range rows(result["sources"]) {
		if source["status"] != "partial" || len(rows(source["enrichment_errors"])) != 1 || source["address_count"] != 0 {
			t.Fatal(source)
		}
	}
}
func TestPrimaryRunsBeforeAliasDirectoryAndSharesLookup(t *testing.T) {
	started := make(chan struct{})
	var once sync.Once
	var artistCalls atomic.Int32
	var aliasCalls atomic.Int32
	s := fixtureService(t, fakeEngine{artists: func(ctx context.Context, _ discovery.Request) (map[string]any, error) {
		artistCalls.Add(1)
		select {
		case <-started:
			return directory(), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}, search: func(_ context.Context, r discovery.Request) (map[string]any, error) {
		if *r.Keyword == "fixture" {
			once.Do(func() { close(started) })
		} else if *r.Keyword == "alias" {
			aliasCalls.Add(1)
		}
		result := emptyResult()
		result["search_url"] = "https://example.test"
		return result, nil
	}})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := s.Perform(ctx, request(t, `{"keyword":"fixture","sites":["exhentai","pawchive"]}`))
	if err != nil || artistCalls.Load() != 1 || aliasCalls.Load() != 2 {
		t.Fatal(result, err, artistCalls.Load(), aliasCalls.Load())
	}
}
func TestCancellationDrainsAllSearches(t *testing.T) {
	started := make(chan struct{}, 2)
	var active atomic.Int32
	block := func(ctx context.Context, _ discovery.Request) (map[string]any, error) {
		active.Add(1)
		defer active.Add(-1)
		started <- struct{}{}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	s := fixtureService(t, fakeEngine{search: block, artists: block})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	body := request(t, `{"keyword":"fixture","sites":["danbooru"]}`)
	go func() { _, err := s.Perform(ctx, body); done <- err }()
	for range 2 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("workers did not start")
		}
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || active.Load() != 0 {
			t.Fatal(err, active.Load())
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation leaked workers")
	}
}
func TestDesktopGlobalBudgetsAndASCIIAccounting(t *testing.T) {
	source := func(n int) map[string]any {
		rows := make([]map[string]any, n)
		for i := range rows {
			rows[i] = map[string]any{"id": i, "label": "fixture"}
		}
		return map[string]any{"site": "fixture", "addresses": rows}
	}
	result := Desktop(map[string]any{"sources": []map[string]any{source(700), source(400)}})
	sources := rows(result["sources"])
	if !result["projection_truncated"].(bool) || len(rows(sources[0]["addresses"])) != 700 || len(rows(sources[1]["addresses"])) != 300 {
		t.Fatal(result)
	}
	large := source(200)
	for _, row := range rows(large["addresses"]) {
		row["url"] = strings.Repeat("界", 8192)
	}
	result = Desktop(map[string]any{"sources": []map[string]any{large}})
	if result["projection_truncated"] != true || len(rows(rows(result["sources"])[0]["addresses"])) >= 200 {
		t.Fatal("ASCII byte budget not enforced")
	}
	if got, want := asciiRowSize(map[string]any{"label": "中😀\x7f<"}), len(`{"label":""}`)+6+12+6+1+1; got != want {
		t.Fatal(got, want)
	}
}
func TestSearchHTTPValidationAndProfiles(t *testing.T) {
	s := fixtureService(t, fakeEngine{})
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{
		{"GET", "/api/v1/search/sites", "", 200}, {"GET", "/api/v1/search/autocomplete?q=%20fixture%20&limit=200", "", 200}, {"GET", "/api/v1/search/autocomplete?q=", "", 422}, {"GET", "/api/v1/search/autocomplete", "", 422}, {"POST", "/api/v1/search?view=unknown", `{"keyword":"x"}`, 422}, {"POST", "/api/v1/search", `{"keyword":"x","hidden":true}`, 422}, {"POST", "/api/v1/search", `{"keyword":"x","sites":["unsupported"]}`, 422}, {"POST", "/api/v1/search", strings.Repeat(" ", 1<<20) + "x", 413}, {"PUT", "/api/v1/search", "", 405}, {"POST", "/api/v1/search?view=desktop", `{"keyword":"x","sites":["danbooru"]}`, 200},
	} {
		t.Run(tc.path+tc.method+tc.body[:min(15, len(tc.body))], func(t *testing.T) {
			w := httptest.NewRecorder()
			w.Header().Set("X-Request-ID", "server-id")
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			r.Header.Set("X-Request-ID", "client-id")
			s.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatal(w.Code, w.Body.String())
			}
			if tc.status >= 400 && (!strings.Contains(w.Body.String(), `"request_id":"server-id"`) || strings.Contains(w.Body.String(), "client-id")) {
				t.Fatal(w.Body.String())
			}
			if tc.path == "/api/v1/search?view=desktop" && !strings.Contains(w.Body.String(), `"response_profile":"desktop"`) {
				t.Fatal(w.Body.String())
			}
			if tc.method == "PUT" && w.Header().Get("Allow") != http.MethodPost {
				t.Fatal(w.Header())
			}
		})
	}
}

func TestAliasCapAndTimeoutCleanup(t *testing.T) {
	var aliases atomic.Int32
	s := fixtureService(t, fakeEngine{artists: func(context.Context, discovery.Request) (map[string]any, error) {
		result := directory()
		rows(result["authors"])[0]["other_names"] = []string{"alias_a", "alias_b", "alias_c", "alias_d", "alias_e"}
		return result, nil
	}, search: func(_ context.Context, r discovery.Request) (map[string]any, error) {
		if *r.Keyword != "fixture" {
			aliases.Add(1)
		}
		return emptyResult(), nil
	}})
	body := request(t, `{"keyword":"fixture","sites":["pawchive"]}`)
	if _, err := s.Perform(context.Background(), body); err != nil || aliases.Load() != 4 {
		t.Fatal(err, aliases.Load())
	}
	var active atomic.Bool
	s = fixtureService(t, fakeEngine{artists: func(ctx context.Context, _ discovery.Request) (map[string]any, error) {
		active.Store(true)
		defer active.Store(false)
		<-ctx.Done()
		return nil, ctx.Err()
	}})
	s.aliasWait = 5 * time.Millisecond
	result, err := s.Perform(context.Background(), body)
	if err != nil || active.Load() {
		t.Fatal(result, err, active.Load())
	}
	source := rows(result["sources"])[0]
	if source["status"] != "partial" || rows(source["enrichment_errors"])[0]["stage"] != "danbooru_alias_lookup" {
		t.Fatal(source)
	}
	projected := rows(Desktop(result)["sources"])[0]
	if projected["error"].(map[string]any)["code"] != "search_incomplete" {
		t.Fatalf("desktop must distinguish incomplete alias search from no matches: %v", projected)
	}
}

func TestProfilePromotesWeakEvidenceWithoutDuplicates(t *testing.T) {
	s := fixtureService(t, fakeEngine{profiles: func(context.Context, []string) ([]map[string]any, []map[string]string, error) {
		profile := map[string]any{"id": 42, "name": "fixture", "related_profiles": []map[string]any{{"url": "https://x.com/fixture", "crawl_site": "twitter", "crawl_url": "https://x.com/fixture/media", "active": true}}}
		return []map[string]any{profile}, nil, nil
	}})
	danbooru := emptySource(0, "danbooru")
	danbooru["addresses"] = []map[string]any{{"address_type": "artist_tag", "tag": "fixture"}}
	twitter := emptySource(1, "twitter")
	twitter["status"] = "failed"
	twitter["weak_evidence"] = []map[string]any{{"url": "https://twitter.com/fixture/media", "origin": "site_search", "confidence": "weak_evidence"}}
	body := request(t, `{"keyword":"fixture","sites":["danbooru","twitter"]}`)
	p, err := buildPlan(body)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, _, err := s.enrichProfiles(context.Background(), body, p, []map[string]any{danbooru, twitter}); err != nil {
			t.Fatal(err)
		}
	}
	if twitter["status"] != "partial" || twitter["address_count"] != 1 || twitter["weak_evidence_count"] != 0 {
		t.Fatal(twitter)
	}
	address := rows(twitter["addresses"])[0]
	if address["confidence"] != "verified" || !reflect.DeepEqual(address["origins"], []string{"site_search", "danbooru_artist_url"}) {
		t.Fatal(address)
	}
}
