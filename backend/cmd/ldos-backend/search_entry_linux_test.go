package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ldos/backend/internal/danboorucollect"
	"ldos/backend/internal/datasets"
	"ldos/backend/internal/discovery"
	"ldos/backend/internal/downloads"
	"ldos/backend/internal/gallery"
)

type runtimeSearchCapture func(context.Context, gallery.CaptureRequest) (gallery.CaptureResult, error)

func (f runtimeSearchCapture) Capture(ctx context.Context, req gallery.CaptureRequest) (gallery.CaptureResult, error) {
	return f(ctx, req)
}

// Use the production constructors and HTTP projections. Mock only the remote
// site and extractor; never replace the validator or proxy selection logic.
func TestNativeSearchEntryPointsWithStoppedProxy(t *testing.T) {
	for _, mode := range []string{"direct", "prefer", "required"} {
		t.Run(mode, func(t *testing.T) {
			b, _ := nativeBusinessFixture(t, false)
			settings := b.settings.snapshot()
			settings.Proxy.Enabled = true
			settings.Proxy.AutoStart = false
			settings.Server.AllowPrivateTargets = false
			settings.Server.StrictTargetDNS = true
			settings.EncryptedDNS.Enabled = true
			settings.DefaultSitePolicy = map[string]any{"proxy_mode": mode, "retry_limit": 0}
			var dnsHits atomic.Int32
			dns := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				dnsHits.Add(1)
				http.Error(w, "DNS preflight must not run", 500)
			}))
			defer dns.Close()
			settings.EncryptedDNS.Endpoint = dns.URL
			pool, err := newProxyRuntime(settings)
			nativeOK(t, err)
			t.Cleanup(func() { nativeOK(t, pool.stop()) })
			shared := downloads.New(settings.RuntimeDir)
			auth, vault, err := newAuthorizationRuntime(b.ctx, settings, shared)
			nativeOK(t, err)
			t.Cleanup(func() { nativeOK(t, auth.Stop()) })
			runner := b.discovery.Transport.Gallery.(*gallery.Runner)
			engine, validator, err := newDiscoveryRuntime(settings, runner, pool.pool, vault)
			nativeOK(t, err)
			ctx, cancel := context.WithTimeout(b.ctx, 5*time.Second)
			defer cancel()
			policy, err := runtimePolicy(ctx, settings, b.db, "danbooru")
			nativeOK(t, err)
			// Admission must remain syntax-only, even with old DNS flags present.
			nativeOK(t, engine.Transport.ValidateTarget(ctx, "https://media.example.invalid/image.jpg", mode, policy))
			var httpCalls, postCalls, captureCalls atomic.Int32
			site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				httpCalls.Add(1)
				if r.URL.Path == "/artists.json" {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte("[]"))
					return
				}
				postCalls.Add(1)
				if r.URL.Path != "/posts.json" || r.URL.Query().Get("tags") != "umehara_sei" {
					t.Errorf("unexpected site request: %s", r.URL)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`[{"id":101,"file_url":"https://cdn.donmai.us/101.jpg","tag_string_artist":"umehara_sei","file_ext":"jpg"}]`))
			}))
			defer site.Close()
			engine.Transport.Gallery = runtimeSearchCapture(func(_ context.Context, r gallery.CaptureRequest) (gallery.CaptureResult, error) {
				captureCalls.Add(1)
				if r.ProxyURL != "" {
					t.Error("stopped pool unexpectedly supplied a proxy")
				}
				return gallery.CaptureResult{Stdout: "[]"}, nil
			})
			requestJSON := engine.Transport.HTTPRequest
			engine.Transport.HTTPRequest = func(ctx context.Context, method, target string, params url.Values, body any, endpoint string, timeout time.Duration) (discovery.HTTPResult, error) {
				if endpoint != "" {
					t.Error("API unexpectedly uses a proxy")
				}
				u, err := url.Parse(target)
				if err != nil {
					return discovery.HTTPResult{}, err
				}
				return requestJSON(ctx, method, site.URL+u.Path, params, body, endpoint, timeout)
			}
			online, err := newSearchWithDiscovery(settings, b.db, runner, vault, auth, engine, validator)
			nativeOK(t, err)
			browse := danboorucollect.New(danboorucollect.Dependencies{Store: b.db, Datasets: b.datasets, Transport: engine.Transport, Browse: engine.Danbooru.Browse, Request: func(ctx context.Context) (discovery.Request, error) {
				p, err := runtimePolicy(ctx, settings, b.db, "danbooru")
				return discovery.Request{Site: "danbooru", Policy: p, ProxyMode: p.ProxyMode, TimeoutSeconds: 3}, err
			}})
			dataset, err := b.datasets.Create(ctx, datasets.CreateOptions{Name: "Search fixture", Kind: "character"})
			nativeOK(t, err)
			browseBody, err := json.Marshal(map[string]any{"kind": "search", "query": "umehara_sei", "limit": 1, "dataset_id": dataset["dataset_id"]})
			nativeOK(t, err)
			for _, entry := range []struct {
				name, path, body string
				handler          http.Handler
			}{
				{"online", "/api/v1/search?view=desktop", `{"keyword":"umehara_sei","sites":["danbooru"],"timeout_seconds":5}`, online},
				{"browse", "/api/v1/danbooru/browse", string(browseBody), browse.Handler()},
			} {
				t.Run(entry.name, func(t *testing.T) {
					req := httptest.NewRequest(http.MethodPost, entry.path, strings.NewReader(entry.body)).WithContext(ctx)
					out := httptest.NewRecorder()
					entry.handler.ServeHTTP(out, req)
					var body map[string]any
					nativeOK(t, json.Unmarshal(out.Body.Bytes(), &body))
					if entry.name == "online" {
						if out.Code != 200 {
							t.Fatalf("online HTTP %d: %s", out.Code, out.Body)
						}
						source := body["sources"].([]any)[0].(map[string]any)
						if mode == "required" {
							if source["status"] != "failed" || source["error"].(map[string]any)["code"] != "proxy_unavailable" {
								t.Fatal(source)
							}
						} else if len(source["addresses"].([]any)) != 1 || source["status"] != "succeeded" {
							t.Fatal(source)
						}
					} else if mode == "required" {
						if out.Code != 502 || body["error"].(map[string]any)["code"] != "proxy_unavailable" {
							t.Fatalf("required browse: %d %s", out.Code, out.Body)
						}
					} else if out.Code != 200 || len(body["items"].([]any)) != 1 {
						t.Fatalf("browse: %d %s", out.Code, out.Body)
					}
				})
			}
			if mode == "required" {
				if httpCalls.Load() != 0 || captureCalls.Load() != 0 {
					t.Fatal("required mode fell back to direct")
				}
			} else if postCalls.Load() != 2 || captureCalls.Load() == 0 {
				t.Fatalf("missing actual requests: HTTP=%d extractor=%d", httpCalls.Load(), captureCalls.Load())
			}
			if dnsHits.Load() != 0 {
				t.Fatal("legacy DNS flags enabled preflight")
			}
		})
	}
}
