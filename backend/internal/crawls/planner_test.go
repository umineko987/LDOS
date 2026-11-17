package crawls

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/gallery"
	"ldos/backend/internal/proxypool"
)

func TestCandidateDigestPythonGolden(t *testing.T) {
	cases := []struct {
		unit Unit
		want string
	}{{Unit{Site: "pixiv", URL: "https://www.pixiv.net/artworks/101"}, "a20a972e42d87f0014779c01330b5fa5faf53daf69e2f72a951479da9959a510"}, {Unit{Site: "twitter", URL: "https://x.com/作者/status/123", ExtraArgs: []string{"--range", "1", "<>&", "\u2028", `\u2028`}}, "cda5fd00581c4a7aaca243dabf242980a95c55ed6c0e91a2c83b651368b94ceb"}}
	for _, c := range cases {
		if got := CandidateDigest(c.unit); got != c.want {
			t.Fatalf("hash=%s want=%s", got, c.want)
		}
	}
	one := cases[0].unit
	two := one
	two.SourceID = "different-source"
	two.Kind = "different-kind"
	if len(Deduplicate([]Unit{one, two})) != 1 {
		t.Fatal("metadata changed task identity")
	}
	two.ExtraArgs = []string{"--range", "2"}
	if len(Deduplicate([]Unit{one, two})) != 2 {
		t.Fatal("media ranges collapsed")
	}
}
func TestSourceKeyContracts(t *testing.T) {
	for input, want := range map[string]string{"https://www.pixiv.net/en/artworks/0012": "pixiv:0012", "pixiv.net/i/42": "pixiv:42", "//www.pixiv.net/member_illust.php?mode=medium&amp;illust_id=42": "pixiv:42", "https://i.pximg.net/img-original/img/2020/42_p1.jpg": "pixiv:42", "https://img2.pixiv.net/img/user/42.jpg": "pixiv:42", "https://mobile.twitter.com/artist/status/123": "twitter:123", "https://www.fixupx.com/artist/statuses/456": "twitter:456", "https://evil.example/artworks/42": "", "https://pixiv.net/artworks/%34%32": "", "https://pixiv.net/not-artworks/42": "", "https://x.com/artist/status/42bad": ""} {
		if got := text(SourceKeyFromURL(input)); got != want {
			t.Fatalf("%s: %s != %s", input, got, want)
		}
	}
	if text(CandidateSourceKey("X", 123, "https://bad.invalid/")) != "twitter:123" {
		t.Fatal("site alias not canonical")
	}
}
func TestPlanMediaContracts(t *testing.T) {
	s, _, _ := fixture(t)
	p, _ := s.deps.PolicyFor(context.Background(), "pixiv")
	items := []map[string]any{{"id": "101", "site": "pixiv", "url": "https://www.pixiv.net/artworks/101", "kind": "work", "media_count": 2}, {"id": "42", "site": "twitter", "url": "https://x.com/artist/status/42", "media_count": 2, "media_urls": []any{" https://pbs.twimg.com/a.jpg ", "https://pbs.twimg.com/a.jpg", "https://video.twimg.com/b.mp4"}}, {"id": "13", "site": "danbooru", "url": "https://danbooru.donmai.us/posts/13", "metadata": map[string]any{"source": "https://www.pixiv.net/artworks/99"}}}
	units, proxies, err := s.PlanMedia(context.Background(), items, p, "direct", "", 10)
	good(t, err)
	if len(units) != 5 || len(proxies) != 0 {
		t.Fatal(units, proxies)
	}
	if !reflect.DeepEqual(units[0].ExtraArgs, []string{"--range", "1"}) || units[1].SourceID != "101:2" || text(units[2].SourceKey) != "twitter:42" || units[2].URL != "https://pbs.twimg.com/a.jpg" || text(units[4].SourceKey) != "pixiv:99" {
		t.Fatal(units)
	}
	_, _, err = s.PlanMedia(context.Background(), []map[string]any{{"site": "pixiv", "url": "https://www.pixiv.net/artworks/1", "media_count": 1000000000}}, p, "direct", "", 10)
	var planned *Error
	if !errors.As(err, &planned) || planned.Code != "crawl_plan_too_large" || integer(planned.Details.(map[string]any)["planned"]) != 1000000000 {
		t.Fatal(err)
	}
}
func TestTwitterMediaBypassesManagedCookies(t *testing.T) {
	s, _, _ := fixture(t)
	root := s.deps.Settings.ProjectDir
	cookie := filepath.Join(root, "cookies.txt")
	good(t, os.WriteFile(cookie, []byte("# Netscape HTTP Cookie File\n"), 0600))
	config := filepath.Join(root, "gallery.json")
	good(t, os.WriteFile(config, []byte(`{}`), 0600))
	var credentialCalls atomic.Int64
	s.deps.Credentials = func(context.Context, string, CredentialsRequest) (Credentials, error) {
		credentialCalls.Add(1)
		return Credentials{Reference: "managed-twitter", CookiesFile: cookie, ConfigFile: config}, nil
	}
	s.deps.Discovery.Transport.Gallery = captureFunc(func(_ context.Context, r gallery.CaptureRequest) (gallery.CaptureResult, error) {
		if r.CookiesFile != cookie || r.ConfigFile != config {
			t.Fatal("discovery lost credentials")
		}
		return gallery.CaptureResult{Stdout: `[[2,{"tweet_id":42,"count":1,"author":{"name":"artist"}}],[3,"https://pbs.twimg.com/media/a.jpg",{"tweet_id":42,"num":1}]]`}, nil
	})
	r := batchRequest("https://x.com/artist/media")
	r.Sources[0].Site = "twitter"
	b := createBatch(t, s, r)
	good(t, s.RunOnce(context.Background()))
	rows, err := s.ListTasks(context.Background(), str(b["id"]), "", 100, 0)
	good(t, err)
	if len(rows) != 1 {
		t.Fatal(rows)
	}
	task := rows[0]
	if task["cookies_file"] != nil || task["config_file"] != config || task["credentials_ref"] != "managed-twitter" || credentialCalls.Load() != 1 {
		t.Fatal(task, credentialCalls.Load())
	}
}
func TestDanbooruSuccessPreDeduplicatesLaterSources(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	httpCalls := 0
	s.deps.Discovery.Transport.HTTPRequest = func(_ context.Context, method, target string, params url.Values, body any, proxy string, timeout time.Duration) (discovery.HTTPResult, error) {
		httpCalls++
		if method != "GET" || target != "https://danbooru.donmai.us/posts.json" {
			t.Fatalf("unexpected request %s %s", method, target)
		}
		return discovery.HTTPResult{StatusCode: 200, Payload: []any{map[string]any{"id": 1, "source": "https://www.pixiv.net/artworks/101", "file_url": "https://cdn.donmai.us/a.jpg"}}}, nil
	}
	s.deps.Discovery.Transport.Gallery = captureFunc(func(_ context.Context, r gallery.CaptureRequest) (gallery.CaptureResult, error) {
		if r.Site != "pixiv" {
			t.Fatal("unexpected gallery fallback", r.Site)
		}
		return capturePixiv(101, 2), nil
	})
	r := batchRequest("https://www.pixiv.net/users/17")
	r.Sources = append([]Source{{Site: "danbooru", Addresses: []Address{{URL: "https://danbooru.donmai.us/posts?tags=artist"}}}}, r.Sources...)
	b := createBatch(t, s, r)
	id := str(b["id"])
	good(t, s.RunOnce(ctx))
	markTasks(t, s, id, "succeeded")
	good(t, s.RunOnce(ctx))
	good(t, s.RunOnce(ctx))
	b, err := s.Get(ctx, id)
	good(t, err)
	if b["status"] != "succeeded" || integer(b["pre_dedup_skipped_count"]) != 2 || integer(b["task_count"]) != 1 || httpCalls != 1 {
		t.Fatal(b, httpCalls)
	}
	a := batchAddresses(b)
	if a[1]["status"] != "succeeded" || integer(a[1]["planned_task_count"]) != 0 {
		t.Fatal(a)
	}
}
func TestEHIndexPaginationCookiesLeaseAndOrder(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	p, _ := s.deps.PolicyFor(ctx, "exhentai")
	p.ProxyMode = "required"
	cookie := filepath.Join(s.deps.Settings.ProjectDir, "eh.txt")
	good(t, os.WriteFile(cookie, []byte("# Netscape HTTP Cookie File\n.exhentai.org\tTRUE\t/\tFALSE\t0\tipb_member_id\t123\n"), 0600))
	calls := []string{}
	s.deps.HTTPClient = func(_ context.Context, endpoint string, timeout time.Duration) (*http.Client, func(), error) {
		if endpoint != "http://127.0.0.1:12345" || timeout <= 0 {
			t.Fatal(endpoint, timeout)
		}
		return &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			calls = append(calls, r.URL.String())
			if r.UserAgent() != "gallery-dl-backend/crawl-planner" || !strings.Contains(r.Header.Get("Cookie"), "ipb_member_id=123") || !strings.Contains(r.Header.Get("Cookie"), "nw=1") {
				t.Fatal(r.Header)
			}
			body := `<h1 id="gn">A &amp; B</h1><td>Length:</td><td>3 pages</td>`
			if r.URL.Query().Get("p") == "" {
				body += `<a href="https://exhentai.org/s/abcdef1234/42-2"></a><a href="https://exhentai.org/s/abcdef1234/42-1"></a><a href="https://exhentai.org/s/abcdef1234/99-1"></a>`
			} else {
				body += `<a href="https://exhentai.org/s/abcdef1234/42-3"></a>`
			}
			return response(200, body), nil
		})}, func() {}, nil
	}
	units, proxies, err := s.PlanMedia(ctx, []map[string]any{{"site": "exhentai", "url": "https://exhentai.org/g/42/abcdef1234/", "extra_args": []string{"--verbose"}}}, p, "required", cookie, 3)
	good(t, err)
	if len(units) != 3 || len(proxies) != 1 || len(calls) != 2 || proxies[0]["title"] != "A & B" || proxies[0]["node_id"] != "node-1" {
		t.Fatal(units, proxies, calls)
	}
	for i, u := range units {
		if !strings.HasSuffix(u.URL, fmt.Sprintf("42-%d", i+1)) || !reflect.DeepEqual(u.ExtraArgs, []string{"--range", "1", "--verbose"}) || u.SourceKey != nil {
			t.Fatal(u)
		}
	}
	pool := s.deps.Discovery.Transport.Pool.(*localPool)
	if pool.leases != 1 || pool.release != 1 {
		t.Fatal(pool)
	}
}
func TestEHFailuresAreClassifiedAndReleaseLeases(t *testing.T) {
	cases := []struct {
		name, html      string
		status, maximum int
		code            string
	}{{"auth", "", 200, 10, "authentication"}, {"limit", `<h1 id="gn">Title</h1><td>Length:</td><td>100 pages</td>`, 200, 1, "crawl_plan_too_large"}, {"missing header", `<a href="https://exhentai.org/s/abcdef1234/42-1"></a>`, 200, 10, "eh_gallery_plan_failed"}, {"gap", `<h1 id="gn">Title</h1><td>Length:</td><td>2 pages</td><a href="https://exhentai.org/s/abcdef1234/42-1"></a><a href="https://exhentai.org/s/abcdef1234/42-3"></a>`, 200, 10, "eh_gallery_plan_failed"}, {"http", `broken`, 503, 10, "eh_gallery_plan_failed"}}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, _, _ := fixture(t)
			var auth atomic.Int64
			s.deps.Discovery.Transport.AuthFailure = func(context.Context, string, string, string) (bool, error) { auth.Add(1); return true, nil }
			s.deps.HTTPClient = func(context.Context, string, time.Duration) (*http.Client, func(), error) {
				return &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return response(c.status, c.html), nil })}, func() {}, nil
			}
			p, _ := s.deps.PolicyFor(context.Background(), "exhentai")
			_, _, err := s.planEH(context.Background(), "https://exhentai.org/g/42/abcdef1234/", p, "required", "", c.maximum)
			var local *Error
			var upstream *discovery.Error
			code := ""
			if errors.As(err, &local) {
				code = local.Code
			} else if errors.As(err, &upstream) {
				code = upstream.Code
			}
			if code != c.code {
				t.Fatalf("%v: %s", err, code)
			}
			if c.name == "auth" && auth.Load() != 1 {
				t.Fatal("auth not notified")
			}
			pool := s.deps.Discovery.Transport.Pool.(*localPool)
			if pool.leases != pool.release {
				t.Fatal("leaked lease")
			}
		})
	}
}

type noPool struct{ fail error }

func (p noPool) Acquire(context.Context, proxypool.Request) (*proxypool.Lease, error) {
	return nil, p.fail
}
func (noPool) Release(context.Context, string, bool, string) error { return nil }
func (noPool) Status() map[string]any                              { return map[string]any{} }
func TestEHRequiredProxyCannotFallBackDirect(t *testing.T) {
	s, _, _ := fixture(t)
	s.deps.Discovery.Transport.Pool = noPool{}
	s.deps.HTTPClient = func(context.Context, string, time.Duration) (*http.Client, func(), error) {
		t.Fatal("attempted direct fallback")
		return nil, nil, nil
	}
	p, _ := s.deps.PolicyFor(context.Background(), "exhentai")
	_, _, err := s.planEH(context.Background(), "https://exhentai.org/g/42/abcdef1234/", p, "required", "", 10)
	var e *discovery.Error
	if !errors.As(err, &e) || e.Code != "proxy_unavailable" {
		t.Fatal(err)
	}
}

type blockedValidator struct{ validator }

func (blockedValidator) ValidateDirect(_ context.Context, target string) ([]string, error) {
	if strings.Contains(target, "127.0.0.1") {
		return nil, errors.New("private target blocked")
	}
	return []string{"93.184.216.34"}, nil
}
func (v blockedValidator) ValidateProxy(ctx context.Context, target, _ string) ([]string, error) {
	return v.ValidateDirect(ctx, target)
}
func TestEHRedirectValidationAndCookieFileFailure(t *testing.T) {
	s, _, _ := fixture(t)
	s.deps.Discovery.Transport.Validator = blockedValidator{}
	calls := 0
	s.deps.HTTPClient = func(context.Context, string, time.Duration) (*http.Client, func(), error) {
		return &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			calls++
			r := response(302, "")
			r.Header.Set("Location", "http://127.0.0.1/private")
			return r, nil
		})}, func() {}, nil
	}
	p, _ := s.deps.PolicyFor(context.Background(), "exhentai")
	_, _, err := s.planEH(context.Background(), "https://exhentai.org/g/42/abcdef1234/", p, "direct", "", 10)
	if err == nil || !strings.Contains(err.Error(), "private target blocked") || calls != 1 {
		t.Fatal(err, calls)
	}
	_, _, err = s.planEH(context.Background(), "https://exhentai.org/g/42/abcdef1234/", p, "direct", filepath.Join(t.TempDir(), "missing.txt"), 10)
	var e *discovery.Error
	if !errors.As(err, &e) || e.Code != "cookies_error" {
		t.Fatal(err)
	}
}
