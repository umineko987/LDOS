package discovery

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"ldos/backend/internal/gallery"
	"ldos/backend/internal/network"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/scheduler"
)

type transportPool struct {
	requests []proxypool.Request
	released []bool
	reasons  []string
	empty    bool
	err      error
}

func (p *transportPool) Acquire(_ context.Context, r proxypool.Request) (*proxypool.Lease, error) {
	p.requests = append(p.requests, r)
	if p.err != nil || p.empty {
		return nil, p.err
	}
	n := len(p.requests)
	return &proxypool.Lease{Owner: r.Owner, NodeID: fmt.Sprintf("node-%d", n), Endpoint: fmt.Sprintf("http://user:secret@proxy-%d.example:29001", n), Name: "proxy-1.example:29001", Protocol: "http"}, nil
}
func (p *transportPool) Release(ctx context.Context, _ string, fault bool, reason string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	p.released = append(p.released, fault)
	p.reasons = append(p.reasons, reason)
	return nil
}
func (p *transportPool) Status() map[string]any { return map[string]any{} }

type transportValidator struct {
	direct int
	proxy  []string
	err    error
}

func (v *transportValidator) ValidateStatic(raw string) (network.Target, error) {
	return network.ValidateSyntax(raw, false)
}
func (v *transportValidator) ValidateDirect(context.Context, string) ([]string, error) {
	v.direct++
	return nil, v.err
}
func (v *transportValidator) ValidateProxy(_ context.Context, _ string, endpoint string) ([]string, error) {
	v.proxy = append(v.proxy, endpoint)
	return nil, v.err
}
func nativeTransport(t *testing.T, p *transportPool, v Validator) *Transport {
	t.Helper()
	tr, err := NewTransport(nil, p, v, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	return tr
}
func retryOptions() ExecuteOptions {
	policy := scheduler.DefaultPolicy()
	policy.ProxyMode = "required"
	policy.RetryLimit = 1
	policy.BackoffBase = 0
	return ExecuteOptions{URL: "https://example.test/search", Prefix: "discover", Policy: policy, Secure: true, AcquireErrorFatal: true, Classify: func(err error, _ Attempt) *Failure { return &Failure{Message: err.Error()} }}
}
func TestTransportRetryUsesSameLeaseForDNSAndOperation(t *testing.T) {
	p := &transportPool{}
	v := &transportValidator{}
	tr := nativeTransport(t, p, v)
	options := retryOptions()
	seen := []string{}
	cleaned := 0
	options.Operation = func(_ context.Context, a Attempt) (any, error) {
		seen = append(seen, a.Endpoint())
		if a.Number == 1 {
			return nil, &Failure{Message: "proxy-1.example:29001 TLS failure", Retryable: true, ProxyFault: true}
		}
		return "ok", nil
	}
	options.Cleanup = func(Attempt) { cleaned++ }
	outcome, err := tr.Execute(context.Background(), options)
	if err != nil || outcome.Value != "ok" || outcome.Attempts != 2 {
		t.Fatal(outcome, err)
	}
	if !reflect.DeepEqual(seen, v.proxy) || !reflect.DeepEqual(p.requests[1].ExcludeIDs, []string{"node-1"}) || !reflect.DeepEqual(p.released, []bool{true, false}) || cleaned != 2 {
		t.Fatal(seen, v, p, cleaned)
	}
	if strings.Contains(p.reasons[0], "proxy-1.example") || strings.Contains(p.reasons[0], "29001") {
		t.Fatal(p.reasons)
	}
}
func TestTransportFailureAndCancellationRelease(t *testing.T) {
	for _, tc := range []struct {
		name  string
		dns   *network.Error
		code  string
		calls int
		fault bool
	}{
		{"nx", &network.Error{Code: "encrypted_dns_nxdomain", Message: "not found"}, "encrypted_dns_nxdomain", 1, false},
		{"upstream", &network.Error{Code: "encrypted_dns_unavailable", Message: "TLS", Retryable: true, ProxyFault: true}, "encrypted_dns_unavailable", 2, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := &transportPool{}
			v := &transportValidator{err: tc.dns}
			tr := nativeTransport(t, p, v)
			options := retryOptions()
			options.Operation = func(context.Context, Attempt) (any, error) { t.Fatal("operation after failed DNS"); return nil, nil }
			_, err := tr.Execute(context.Background(), options)
			var public *Error
			if !errors.As(err, &public) || public.Code != tc.code || len(p.released) != tc.calls {
				t.Fatal(err, p)
			}
			for _, fault := range p.released {
				if fault != tc.fault {
					t.Fatal(p)
				}
			}
		})
	}
	p := &transportPool{}
	tr := nativeTransport(t, p, &transportValidator{})
	ctx, cancel := context.WithCancel(context.Background())
	options := retryOptions()
	options.Operation = func(context.Context, Attempt) (any, error) { cancel(); return nil, ctx.Err() }
	if _, err := tr.Execute(ctx, options); !errors.Is(err, context.Canceled) || len(p.released) != 1 || p.released[0] {
		t.Fatal(err, p)
	}
}
func TestTransportProxyPreference(t *testing.T) {
	for _, mode := range []string{"prefer", "required"} {
		for _, state := range []string{"stopped", "unavailable", "healthy"} {
			t.Run(mode+"/"+state, func(t *testing.T) {
				p := &transportPool{empty: state == "stopped"}
				if state == "unavailable" {
					p.err = proxypool.ErrUnavailable
				}
				tr := nativeTransport(t, p, network.URLValidator{})
				options := retryOptions()
				options.Mode = mode
				called := false
				options.Operation = func(_ context.Context, attempt Attempt) (any, error) {
					called = true
					if (attempt.Endpoint() != "") != (state == "healthy") {
						t.Fatalf("unexpected endpoint: %q", attempt.Endpoint())
					}
					return "result", nil
				}
				result, err := tr.Execute(context.Background(), options)
				if mode == "required" && state != "healthy" {
					var public *Error
					if !errors.As(err, &public) || public.Code != "proxy_unavailable" || called {
						t.Fatal(err, called)
					}
					return
				}
				if err != nil || !called || result.Value != "result" || result.Proxy["used"] != (state == "healthy") {
					t.Fatal(result, err, called)
				}
				if state == "healthy" && (len(p.released) != 1 || p.released[0]) {
					t.Fatal(p.released)
				}
				if state != "healthy" && len(p.released) != 0 {
					t.Fatal(p.released)
				}
			})
		}
	}
}

func TestDanbooruSearchWithoutRunningProxyPool(t *testing.T) {
	for _, entry := range []string{"online", "browse"} {
		t.Run(entry, func(t *testing.T) {
			pool := &transportPool{empty: true}
			tr := nativeTransport(t, pool, network.URLValidator{})
			galleryCalls, httpCalls := 0, 0
			tr.Gallery = captureFunc(func(_ context.Context, r gallery.CaptureRequest) (gallery.CaptureResult, error) {
				galleryCalls++
				if r.ProxyURL != "" {
					t.Fatalf("unexpected gallery proxy: %q", r.ProxyURL)
				}
				return gallery.CaptureResult{Stdout: "[]"}, nil
			})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/posts.json" || r.URL.Query().Get("tags") != "umehara_sei" {
					t.Errorf("unexpected search request: %s", r.URL)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`[{"id":1,"file_url":"https://cdn.donmai.us/1.jpg","tag_string_artist":"umehara_sei"}]`))
			}))
			defer server.Close()
			tr.HTTPRequest = func(ctx context.Context, method, target string, params url.Values, body any, endpoint string, timeout time.Duration) (HTTPResult, error) {
				httpCalls++
				if endpoint != "" || target != danBaseURL+"/posts.json" {
					t.Fatalf("unexpected API route: %s via %q", target, endpoint)
				}
				return requestJSON(ctx, method, server.URL+"/posts.json", params, body, endpoint, timeout)
			}
			adapter := &DanbooruAdapter{Transport: tr, GalleryDiscover: (&GalleryAdapter{Transport: tr}).Discover}
			keyword := "umehara_sei"
			request := Request{Keyword: &keyword, Limit: 1, Policy: scheduler.DefaultPolicy(), TimeoutSeconds: 5}
			if entry == "online" {
				result, err := adapter.Search(context.Background(), request)
				if err != nil || result["candidate_count"] != 1 || galleryCalls != 1 {
					t.Fatal(result, err, galleryCalls)
				}
			} else {
				page, err := adapter.Browse(context.Background(), request, DanbooruBrowseOptions{Kind: "search", Query: keyword, Limit: 1})
				if err != nil {
					t.Fatal(err)
				}
				if len(page.Items) != 1 || page.Items[0].ID != "1" || galleryCalls != 0 {
					t.Fatal(page, galleryCalls)
				}
			}
			if httpCalls != 1 || len(pool.released) != 0 {
				t.Fatal(httpCalls, pool.released)
			}
		})
	}
}
func TestTransportDirectPreflight(t *testing.T) {
	p := &transportPool{empty: true}
	v := &transportValidator{}
	tr := nativeTransport(t, p, v)
	options := retryOptions()
	options.Mode = "direct"
	options.Operation = func(context.Context, Attempt) (any, error) { return nil, nil }
	if _, err := tr.Execute(context.Background(), options); err != nil || v.direct != 1 || len(p.requests) != 0 {
		t.Fatal(err, v)
	}
	options.DirectPrevalidated = true
	if _, err := tr.Execute(context.Background(), options); err != nil || v.direct != 1 {
		t.Fatal(err, v)
	}
}
func TestTransportHTTPIsExplicitAndDoesNotFollowRedirects(t *testing.T) {
	hit := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit++
		if r.URL.Path == "/redirect" {
			w.Header().Set("Location", "/next")
			w.WriteHeader(302)
			return
		}
		if r.Header.Get("User-Agent") != "gallery-dl-backend/0.3" || r.URL.Query().Get("fixture") != "yes" {
			t.Error(r.Header, r.URL)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer server.Close()
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	result, err := requestJSON(context.Background(), "POST", server.URL, url.Values{"fixture": []string{"yes"}}, map[string]any{"yes": true}, "", time.Second)
	if err != nil || result.JSONError != nil || result.Payload.(map[string]any)["ok"] != true {
		t.Fatal(result, err)
	}
	result, err = requestJSON(context.Background(), "GET", server.URL+"/redirect", nil, nil, "", time.Second)
	if err != nil || result.StatusCode != 302 || hit != 2 {
		t.Fatal(result, err, hit)
	}
}

type captureFunc func(context.Context, gallery.CaptureRequest) (gallery.CaptureResult, error)

func (f captureFunc) Capture(ctx context.Context, r gallery.CaptureRequest) (gallery.CaptureResult, error) {
	return f(ctx, r)
}
func TestGalleryAdapterProtocolAndPartialOutput(t *testing.T) {
	tr := nativeTransport(t, &transportPool{}, &transportValidator{})
	keyword := "fixture"
	policy := scheduler.DefaultPolicy()
	policy.ProxyMode = "direct"
	tr.Gallery = captureFunc(func(_ context.Context, r gallery.CaptureRequest) (gallery.CaptureResult, error) {
		if !reflect.DeepEqual(r.ExtraArgs, []string{"--dump-json", "--post-range", "1-3"}) || r.CookiesFile != "cookies" || r.CredentialsRef != "token" {
			t.Fatal(r)
		}
		if err := os.Mkdir(r.OutputDir, 0700); err != nil {
			t.Fatal(err)
		}
		return gallery.CaptureResult{ProcessResult: gallery.ProcessResult{ExitCode: 0}, Stdout: `[[2,{"id":123,"tag_string_artist":"fixture","file_url":"https://example.test/a.jpg"}],[-1,{"message":"late timeout"}]]`}, nil
	})
	adapter := GalleryAdapter{tr}
	result, err := adapter.Discover(context.Background(), Request{Site: "danbooru", URL: "https://example.test/posts", Keyword: &keyword, Limit: 3, Policy: policy, CookiesFile: "cookies", CredentialsRef: "token", TimeoutSeconds: 5})
	if err != nil || result["candidate_count"] != 1 || result["attempts"] != 1 {
		t.Fatal(result, err)
	}
	files, err := os.ReadDir(tr.RuntimeDir)
	if err != nil || len(files) != 0 {
		t.Fatal(files, err)
	}
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "discovery")); err != nil {
		t.Fatal(err)
	}
	if _, err := NewTransport(nil, nil, nil, root, nil); err == nil {
		t.Fatal("accepted discovery symlink")
	}
}
