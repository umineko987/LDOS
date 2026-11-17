package search

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/scheduler"
)

type lifecycleEngine struct {
	fakeEngine
	previews func(context.Context, map[string]any) (map[string]any, error)
}

func (e lifecycleEngine) EnrichPreviews(ctx context.Context, result map[string]any, _ scheduler.Policy, _ string, _ float64) (map[string]any, error) {
	return e.previews(ctx, result)
}

func lifecycleHTTP(s *Service, ctx context.Context, view, body string) (*httptest.ResponseRecorder, <-chan struct{}) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/api/v1/search?view="+view, strings.NewReader(body)).WithContext(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.ServeHTTP(w, r)
	}()
	return w, done
}

func lifecycleBody(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if w.Code != http.StatusOK {
		t.Fatalf("HTTP %d: %s", w.Code, w.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("invalid search response: %v; body=%s", err, w.Body.String())
	}
	return result
}

func lifecycleSource(t *testing.T, result map[string]any, site string) map[string]any {
	t.Helper()
	for _, source := range rows(result["sources"]) {
		if source["site"] == site {
			return source
		}
	}
	t.Fatalf("missing source %s: %v", site, result)
	return nil
}

func TestHTTPConcurrentSourceFailureKeepsOtherCandidates(t *testing.T) {
	for _, view := range []string{"legacy", "desktop"} {
		t.Run(view, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
				defer cancel()
				started := make(chan string, 2)
				release := make(chan struct{})
				s := fixtureService(t, fakeEngine{search: func(ctx context.Context, r discovery.Request) (map[string]any, error) {
					started <- r.Site
					select {
					case <-release:
					case <-ctx.Done():
						return nil, ctx.Err()
					}
					if r.Site == "pawchive" {
						return nil, &discovery.Error{Code: "proxy_unavailable", Message: "fixture proxy unavailable", Details: map[string]any{"attempts": 2, "proxy": map[string]any{"mode": "required"}}}
					}
					return ehResult(), nil
				}})
				w, done := lifecycleHTTP(s, ctx, view, `{"keyword":"fixture","sites":["pawchive","exhentai"]}`)
				synctest.Wait()
				if len(started) != 2 {
					t.Fatalf("sources did not start concurrently: %d started", len(started))
				}
				close(release)
				<-done
				result := lifecycleBody(t, w)
				sources := rows(result["sources"])
				if len(sources) != 2 || sources[0]["site"] != "pawchive" || sources[1]["site"] != "exhentai" {
					t.Fatalf("source order changed after concurrent completion: %v", sources)
				}
				failed := lifecycleSource(t, result, "pawchive")
				detail := objectValue(failed["error"])
				if failed["status"] != "failed" || detail["code"] != "proxy_unavailable" || detail["message"] != "fixture proxy unavailable" || count(failed["attempts"]) != 2 || len(rows(failed["addresses"])) != 0 {
					t.Fatalf("proxy failure became an empty success: %v", failed)
				}
				healthy := lifecycleSource(t, result, "exhentai")
				addresses := rows(healthy["addresses"])
				if healthy["status"] != "succeeded" || count(healthy["evidence_count"]) != 1 || len(addresses) != 1 || addresses[0]["url"] != "https://e-hentai.org/g/123/abcdef" {
					t.Fatalf("another source's failure swallowed the gallery: %v", healthy)
				}
				if view == "legacy" && (count(result["address_count"]) != 1 || objectValue(failed["proxy"])["mode"] != "required") {
					t.Fatalf("legacy response lost candidates or proxy diagnostics: %v", result)
				}
				if view == "desktop" && result["response_profile"] != "desktop" {
					t.Fatalf("desktop projection was not used: %v", result)
				}
			})
		})
	}
}

func TestHTTPCancellationDrainsConcurrentAliasWorkers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		started := make(chan string, 5)
		canceled := make(chan string, 5)
		release := make(chan struct{})
		unblock := sync.OnceFunc(func() { close(release) })
		defer unblock()
		var active atomic.Int32
		s := fixtureService(t, fakeEngine{
			artists: func(context.Context, discovery.Request) (map[string]any, error) {
				result := directory()
				rows(result["authors"])[0]["other_names"] = []string{"alias_a", "alias_b"}
				return result, nil
			},
			search: func(ctx context.Context, r discovery.Request) (map[string]any, error) {
				if r.Site == "exhentai" && *r.Keyword == "fixture" {
					return ehResult(), nil
				}
				active.Add(1)
				defer active.Add(-1)
				label := r.Site + ":" + *r.Keyword
				started <- label
				<-ctx.Done()
				canceled <- label
				// Cancellation must also wait for worker teardown before returning.
				<-release
				return nil, ctx.Err()
			},
		})
		w, done := lifecycleHTTP(s, ctx, "desktop", `{"keyword":"fixture","sites":["exhentai","pawchive"]}`)
		synctest.Wait()
		if len(started) != 5 || active.Load() != 5 {
			t.Fatalf("expected two aliases per site and one pending primary: started=%d active=%d", len(started), active.Load())
		}
		seen := map[string]bool{}
		for range 5 {
			seen[<-started] = true
		}
		for _, label := range []string{"exhentai:alias_a", "exhentai:alias_b", "pawchive:alias_a", "pawchive:alias_b", "pawchive:fixture"} {
			if !seen[label] {
				t.Fatalf("missing in-flight worker %s: %v", label, seen)
			}
		}
		cancel()
		synctest.Wait()
		if len(canceled) != 5 {
			t.Fatalf("cancellation did not reach every worker: %d/5", len(canceled))
		}
		select {
		case <-done:
			t.Fatal("HTTP handler returned before canceled workers finished cleanup")
		default:
		}
		unblock()
		<-done
		if active.Load() != 0 || w.Body.Len() != 0 {
			t.Fatalf("cancellation left workers or wrote a false response: active=%d body=%s", active.Load(), w.Body.String())
		}
	})
}

func TestHTTPAliasDeadlineDoesNotBecomeEmptySuccess(t *testing.T) {
	for _, view := range []string{"legacy", "desktop"} {
		t.Run(view, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
				defer cancel()
				aliasExit := make(chan error, 1)
				s := fixtureService(t, fakeEngine{
					artists: func(context.Context, discovery.Request) (map[string]any, error) { return directory(), nil },
					search: func(ctx context.Context, r discovery.Request) (map[string]any, error) {
						if *r.Keyword == "fixture" {
							return emptyResult(), nil
						}
						<-ctx.Done()
						aliasExit <- ctx.Err()
						return nil, ctx.Err()
					},
				})
				start := time.Now()
				w, done := lifecycleHTTP(s, ctx, view, `{"keyword":"fixture","sites":["exhentai"],"timeout_seconds":30}`)
				<-done
				if time.Since(start) != 10*time.Second || !errors.Is(<-aliasExit, context.DeadlineExceeded) {
					t.Fatal("alias search did not finish at its optional stage deadline")
				}
				source := lifecycleSource(t, lifecycleBody(t, w), "exhentai")
				detail := objectValue(source["error"])
				if source["status"] != "partial" || detail["code"] != "search_incomplete" || valueText(detail["message"]) == "" || len(rows(source["addresses"])) != 0 {
					t.Fatalf("unfinished alias search was presented as no matches: %v", source)
				}
				if view == "legacy" {
					issues := rows(source["enrichment_errors"])
					if len(issues) != 1 || issues[0]["stage"] != "danbooru_alias_search" || !strings.Contains(valueText(issues[0]["message"]), "alias") {
						t.Fatalf("alias deadline lost its stage diagnostics: %v", source)
					}
				} else if count(source["enrichment_error_count"]) != 1 {
					t.Fatalf("desktop projection lost the incomplete stage: %v", source)
				}
			})
		})
	}
}

func TestHTTPCompletedPrimarySurvivesSourceDeadline(t *testing.T) {
	for _, view := range []string{"legacy", "desktop"} {
		t.Run(view, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
				defer cancel()
				var directoryActive atomic.Int32
				previewContext := make(chan error, 1)
				engine := fakeEngine{
					artists: func(ctx context.Context, _ discovery.Request) (map[string]any, error) {
						directoryActive.Add(1)
						defer directoryActive.Add(-1)
						<-ctx.Done()
						return nil, ctx.Err()
					},
					search: func(context.Context, discovery.Request) (map[string]any, error) { return ehResult(), nil },
				}
				s := fixtureService(t, engine)
				s.deps.Discovery = lifecycleEngine{fakeEngine: engine, previews: func(ctx context.Context, _ map[string]any) (map[string]any, error) {
					previewContext <- ctx.Err()
					return nil, ctx.Err()
				}}
				start := time.Now()
				w, done := lifecycleHTTP(s, ctx, view, `{"keyword":"fixture","sites":["exhentai"],"timeout_seconds":20,"source_options":{"exhentai":{"timeout_seconds":5}}}`)
				<-done
				if time.Since(start) != 5*time.Second || !errors.Is(<-previewContext, context.DeadlineExceeded) || directoryActive.Load() != 0 {
					t.Fatalf("source deadline did not bound enrichment and drain the shared directory: elapsed=%s active=%d", time.Since(start), directoryActive.Load())
				}
				source := lifecycleSource(t, lifecycleBody(t, w), "exhentai")
				addresses := rows(source["addresses"])
				if source["status"] != "partial" || count(source["evidence_count"]) != 1 || len(addresses) != 1 || addresses[0]["url"] != "https://e-hentai.org/g/123/abcdef" {
					t.Fatalf("source deadline discarded an already completed primary result: %v", source)
				}
				if view == "legacy" {
					issues := rows(source["enrichment_errors"])
					if len(issues) != 2 || issues[0]["stage"] != "danbooru_alias_lookup" || issues[1]["stage"] != "exhentai_gallery_previews" || count(source["preview_missing_count"]) != 1 {
						t.Fatalf("retained results lost the failed optional stages: %v", source)
					}
				} else if count(source["enrichment_error_count"]) != 2 {
					t.Fatalf("desktop projection hid the optional stage failures: %v", source)
				}
			})
		})
	}
}

func TestHTTPSourceOptionsBoundOnlyTheirOwnSource(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		type observation struct {
			request discovery.Request
			ctx     context.Context
		}
		observed := make(chan observation, 3)
		release := make(chan struct{})
		s := fixtureService(t, fakeEngine{search: func(ctx context.Context, r discovery.Request) (map[string]any, error) {
			observed <- observation{request: r, ctx: ctx}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-release:
				return emptyResult(), nil
			}
		}})
		start := time.Now()
		w, done := lifecycleHTTP(s, ctx, "desktop", `{"keyword":"fixture","sites":["exhentai","pawchive","danbooru"],"timeout_seconds":20,"source_options":{"exhentai":{"timeout_seconds":5},"pawchive":{"timeout_seconds":9}}}`)
		synctest.Wait()
		if len(observed) != 3 {
			t.Fatalf("expected concurrent primary requests for all three sites, got %d", len(observed))
		}
		contexts := map[string]context.Context{}
		budgets := map[string]time.Duration{"exhentai": 5 * time.Second, "pawchive": 9 * time.Second, "danbooru": 20 * time.Second}
		for range 3 {
			call := <-observed
			budget := budgets[call.request.Site]
			deadline, ok := call.ctx.Deadline()
			if !ok || deadline.Sub(start) != budget || call.request.TimeoutSeconds != budget.Seconds() {
				t.Fatalf("wrong source budget for %s: deadline=%s timeout_seconds=%v want=%s", call.request.Site, deadline.Sub(start), call.request.TimeoutSeconds, budget)
			}
			contexts[call.request.Site] = call.ctx
		}
		// Advance the real source timers using synctest's clock, with no wall-clock wait.
		time.Sleep(5 * time.Second)
		synctest.Wait()
		if !errors.Is(contexts["exhentai"].Err(), context.DeadlineExceeded) || contexts["pawchive"].Err() != nil || contexts["danbooru"].Err() != nil {
			t.Fatalf("one source timeout canceled independent requests: EH=%v pawchive=%v danbooru=%v", contexts["exhentai"].Err(), contexts["pawchive"].Err(), contexts["danbooru"].Err())
		}
		select {
		case <-done:
			t.Fatal("handler returned before the other sites finished")
		default:
		}
		close(release)
		<-done
		result := lifecycleBody(t, w)
		failed := lifecycleSource(t, result, "exhentai")
		if failed["status"] != "failed" || objectValue(failed["error"])["code"] != "search_timeout" || valueText(objectValue(failed["error"])["message"]) == "" {
			t.Fatalf("HTTP projection hid the source timeout: %v", failed)
		}
		for _, site := range []string{"pawchive", "danbooru"} {
			if source := lifecycleSource(t, result, site); source["status"] != "succeeded" {
				t.Fatalf("healthy source inherited another source's deadline: %v", source)
			}
		}
	})
}
