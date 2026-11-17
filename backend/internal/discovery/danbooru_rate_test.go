package discovery

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"ldos/backend/internal/danboorurate"
	"ldos/backend/internal/gallery"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/scheduler"
)

type rateCapturer struct{ path string }

func (c rateCapturer) Capture(context.Context, gallery.CaptureRequest) (gallery.CaptureResult, error) {
	return gallery.CaptureResult{}, nil
}
func (c rateCapturer) DanbooruRatePath() string { return c.path }

func TestTransportUsesRunnerRatePath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cache", danboorurate.FileName)
	transport, err := NewTransport(rateCapturer{path}, nil, nil, t.TempDir(), nil)
	if err != nil || transport.DanbooruRatePath != path {
		t.Fatalf("runner limiter wiring: %v %v", transport, err)
	}
}

func TestDanbooruNativeAdaptersShareRateAcrossInstances(t *testing.T) {
	path := filepath.Join(t.TempDir(), danboorurate.FileName)
	var mu sync.Mutex
	var observed []time.Time
	request := func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
		mu.Lock()
		observed = append(observed, time.Now())
		mu.Unlock()
		return HTTPResult{StatusCode: 200, Payload: []any{}}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	errors := make(chan error, 3)
	for i := range 3 {
		adapter := &DanbooruAdapter{Transport: &Transport{DanbooruRatePath: path, HTTPRequest: request}}
		go func() {
			var err error
			if i%2 == 0 {
				_, err = adapter.danProfileJSON(ctx, danBaseURL+"/artists.json", nil, Attempt{}, scheduler.DefaultPolicy())
			} else {
				_, err = adapter.danJSONRequest(ctx, danBaseURL+"/posts.json", nil, Attempt{}, scheduler.DefaultPolicy())
			}
			errors <- err
		}()
	}
	for range 3 {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
	sort.Slice(observed, func(i, j int) bool { return observed[i].Before(observed[j]) })
	for i := 1; i < len(observed); i++ {
		if observed[i].Sub(observed[i-1]) < 950*time.Millisecond {
			t.Fatal("API and profiles did not share request spacing", observed)
		}
	}
}

func TestDanbooru429RetryUsesCooldownWithoutProxyPenalty(t *testing.T) {
	for _, profile := range []bool{false, true} {
		t.Run(strconv.FormatBool(profile), func(t *testing.T) {
			pool := &transportPool{}
			tr := nativeTransport(t, pool, &transportValidator{})
			adapter := &DanbooruAdapter{Transport: tr}
			policy := scheduler.DefaultPolicy()
			policy.ProxyMode, policy.RetryLimit, policy.BackoffBase = "required", 1, 0
			var observed []time.Time
			tr.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
				observed = append(observed, time.Now())
				if len(observed) == 1 {
					return HTTPResult{StatusCode: 429, Headers: http.Header{"Retry-After": {"2"}}}, nil
				}
				return HTTPResult{StatusCode: 200, Payload: []any{}}, nil
			}
			var err error
			if profile {
				_, err = adapter.ArtistProfile(context.Background(), "example", policy, "required")
			} else {
				_, err = adapter.APIJSON(context.Background(), danBaseURL+"/posts.json", nil, policy, "required", true)
			}
			if err != nil || len(observed) != 2 {
				t.Fatalf("retry failed: %v, times %v", err, observed)
			}
			if observed[1].Sub(observed[0]) < 1950*time.Millisecond {
				t.Fatal("retry ignored Retry-After", observed)
			}
			if !reflect.DeepEqual(pool.released, []bool{false, false}) || len(pool.requests[1].ExcludeIDs) != 0 {
				t.Fatal("429 penalized or excluded proxy", pool.released, pool.requests)
			}
		})
	}
}

func TestDanbooruHTTPFailureClassification(t *testing.T) {
	for _, test := range []struct {
		status       int
		body         string
		retry, fault bool
	}{{401, "", false, false}, {403, "insufficient privileges", false, false}, {403, "Cloudflare: Just a moment", true, true}, {408, "", true, false}, {425, "", true, false}, {429, "", true, false}, {500, "", true, false}} {
		t.Run(strconv.Itoa(test.status)+test.body, func(t *testing.T) {
			adapter := &DanbooruAdapter{Transport: &Transport{HTTPRequest: func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
				return HTTPResult{StatusCode: test.status, Text: test.body}, nil
			}}}
			for _, profile := range []bool{false, true} {
				var err error
				if profile {
					_, err = adapter.danProfileJSON(context.Background(), danBaseURL+"/artists.json", nil, Attempt{}, scheduler.DefaultPolicy())
				} else {
					_, err = adapter.danJSONRequest(context.Background(), danBaseURL+"/posts.json", nil, Attempt{}, scheduler.DefaultPolicy())
				}
				failure := danClassifyFailure(err, Attempt{Lease: &proxypool.Lease{}})
				if failure.Retryable != test.retry || failure.ProxyFault != test.fault {
					t.Fatalf("profile=%v: %+v", profile, failure)
				}
			}
		})
	}
	for _, test := range []struct {
		err          error
		retry, fault bool
	}{
		{errors.New("local configuration error"), false, false},
		{&net.DNSError{Err: "lookup failed"}, true, true},
	} {
		failure := danClassifyFailure(test.err, Attempt{Lease: &proxypool.Lease{}})
		if failure.Retryable != test.retry || failure.ProxyFault != test.fault {
			t.Fatalf("%v: %+v", test.err, failure)
		}
	}
}

func TestDanbooruLocalLimiterErrorsAreNotProxyFaults(t *testing.T) {
	for _, profile := range []bool{false, true} {
		t.Run(strconv.FormatBool(profile), func(t *testing.T) {
			pool := &transportPool{}
			tr := nativeTransport(t, pool, &transportValidator{})
			tr.DanbooruRatePath = filepath.Join(t.TempDir(), "missing", danboorurate.FileName)
			tr.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
				t.Fatal("request made after limiter failure")
				return HTTPResult{}, nil
			}
			adapter := &DanbooruAdapter{Transport: tr}
			policy := scheduler.DefaultPolicy()
			policy.ProxyMode, policy.RetryLimit = "required", 2
			var err error
			if profile {
				_, err = adapter.ArtistProfile(context.Background(), "example", policy, "required")
			} else {
				_, err = adapter.APIJSON(context.Background(), danBaseURL+"/posts.json", nil, policy, "required", true)
			}
			var local *Error
			if !errors.As(err, &local) || local.Code != "danbooru_rate_limit_failed" || len(pool.requests) != 1 || !reflect.DeepEqual(pool.released, []bool{false}) {
				t.Fatal(err, pool.requests, pool.released)
			}
		})
	}
}

func TestDanbooruDefault429CooldownAndCancelledWait(t *testing.T) {
	tr := nativeTransport(t, &transportPool{}, &transportValidator{})
	calls := 0
	tr.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
		calls++
		return HTTPResult{StatusCode: 429}, nil
	}
	adapter := &DanbooruAdapter{Transport: tr}
	_, err := adapter.danJSONRequest(context.Background(), danBaseURL+"/posts.json", nil, Attempt{}, scheduler.DefaultPolicy())
	var api *danAPIError
	if !errors.As(err, &api) || api.proxyFault {
		t.Fatal(err)
	}
	data, err := os.ReadFile(tr.DanbooruRatePath)
	if err != nil {
		t.Fatal(err)
	}
	next, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil || time.Until(time.Unix(0, next)) < 900*time.Millisecond {
		t.Fatal("missing default cooldown", string(data), err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err = adapter.danProfileJSON(ctx, danBaseURL+"/artists.json", nil, Attempt{}, scheduler.DefaultPolicy())
	if !errors.Is(err, context.DeadlineExceeded) || calls != 1 {
		t.Fatal("cancelled request passed throttle", calls, err)
	}
}

func TestDanbooruCloudflareRetryIsThrottledAndFaultsProxy(t *testing.T) {
	for _, profile := range []bool{false, true} {
		t.Run(strconv.FormatBool(profile), func(t *testing.T) {
			pool := &transportPool{}
			tr := nativeTransport(t, pool, &transportValidator{})
			adapter := &DanbooruAdapter{Transport: tr}
			policy := scheduler.DefaultPolicy()
			policy.ProxyMode, policy.RetryLimit, policy.BackoffBase = "required", 1, 0
			var observed []time.Time
			tr.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
				observed = append(observed, time.Now())
				if len(observed) == 1 {
					return HTTPResult{StatusCode: 403, Text: "Cloudflare: Just a moment"}, nil
				}
				return HTTPResult{StatusCode: 200, Payload: []any{}}, nil
			}
			var err error
			if profile {
				_, err = adapter.ArtistProfile(context.Background(), "example", policy, "required")
			} else {
				_, err = adapter.APIJSON(context.Background(), danBaseURL+"/posts.json", nil, policy, "required", true)
			}
			if err != nil || len(observed) != 2 {
				t.Fatalf("challenge retry failed: %v, times %v", err, observed)
			}
			if observed[1].Sub(observed[0]) < 950*time.Millisecond {
				t.Fatal("challenge retry bypassed limiter", observed)
			}
			if !reflect.DeepEqual(pool.released, []bool{true, false}) || !reflect.DeepEqual(pool.requests[1].ExcludeIDs, []string{"node-1"}) {
				t.Fatal("Cloudflare did not fault and exclude proxy", pool.released, pool.requests)
			}
		})
	}
}

func TestDanbooruOrdinaryAuthErrorsNeverRetry(t *testing.T) {
	for _, status := range []int{401, 403} {
		for _, profile := range []bool{false, true} {
			pool := &transportPool{}
			tr := nativeTransport(t, pool, &transportValidator{})
			adapter := &DanbooruAdapter{Transport: tr}
			policy := scheduler.DefaultPolicy()
			policy.ProxyMode, policy.RetryLimit = "required", 3
			calls := 0
			tr.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
				calls++
				return HTTPResult{StatusCode: status, Text: "insufficient privileges"}, nil
			}
			if profile {
				_, _ = adapter.ArtistProfile(context.Background(), "example", policy, "required")
			} else {
				_, _ = adapter.APIJSON(context.Background(), danBaseURL+"/posts.json", nil, policy, "required", true)
			}
			if calls != 1 || !reflect.DeepEqual(pool.released, []bool{false}) {
				t.Fatalf("HTTP %d profile=%v retried or penalized proxy: %d %v", status, profile, calls, pool.released)
			}
		}
	}
}
