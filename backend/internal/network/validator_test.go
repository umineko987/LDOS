package network

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type resolveFunc func(context.Context, string, string) ([]string, error)

func (f resolveFunc) Resolve(ctx context.Context, host, proxy string) ([]string, error) {
	return f(ctx, host, proxy)
}
func newTestValidator(t *testing.T, s ValidatorSettings, r DNSResolver) *Validator {
	t.Helper()
	v, err := NewValidator(s, r)
	if err != nil {
		t.Fatal(err)
	}
	v.lookup = func(context.Context, string) ([]string, error) {
		t.Error("unexpected local DNS fallback")
		return nil, errors.New("unexpected lookup")
	}
	return v
}

func TestValidatorPoliciesAndCacheAdmission(t *testing.T) {
	for _, tc := range []struct {
		name            string
		private, strict bool
		addresses       []string
		fail, cache     bool
	}{
		{"public", false, true, []string{"8.8.8.8"}, false, true},
		{"mixed strict", false, true, []string{"8.8.8.8", "127.0.0.1"}, true, false},
		{"mixed permissive", false, false, []string{"8.8.8.8", "127.0.0.1"}, false, false},
		{"allow private", true, true, []string{"127.0.0.1", "fd00::1"}, false, false},
		{"allow Teredo", true, false, []string{"2001::4a56:cac"}, false, false},
		{"invalid permissive", false, false, []string{"8.8.8.8", "bad"}, false, false},
		{"allow public", true, false, []string{"8.8.8.8"}, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := DefaultValidatorSettings()
			s.AllowPrivate, s.Strict = tc.private, tc.strict
			calls := 0
			v := newTestValidator(t, s, resolveFunc(func(_ context.Context, host, proxy string) ([]string, error) {
				calls++
				if host != "xn--tst-qla.example" || proxy != testProxy {
					t.Errorf("resolve %s %s", host, proxy)
				}
				return tc.addresses, nil
			}))
			got, err := v.ValidateProxy(context.Background(), "https://TÄST.Example./path", testProxy)
			if tc.fail {
				assertDNSError(t, err, "invalid_network_target", false)
			} else if err != nil || len(got) == 0 {
				t.Fatalf("%v %v", got, err)
			}
			if calls != 1 || v.CacheFallback("https://xn--tst-qla.example:8443/other") != tc.cache || v.CacheFallback("https://sub.xn--tst-qla.example/") {
				t.Fatalf("cache policy failed, calls=%d", calls)
			}
		})
	}
}

func TestValidatorLiteralDirectAndMissingProxy(t *testing.T) {
	calls := 0
	v := newTestValidator(t, DefaultValidatorSettings(), resolveFunc(func(context.Context, string, string) ([]string, error) { calls++; return []string{"8.8.8.8"}, nil }))
	for _, method := range []func(context.Context, string) ([]string, error){v.ValidateDirect, func(ctx context.Context, url string) ([]string, error) { return v.ValidateProxy(ctx, url, testProxy) }} {
		got, err := method(context.Background(), "https://8.8.8.8/")
		if err != nil || !reflect.DeepEqual(got, []string{"8.8.8.8"}) {
			t.Fatalf("%v %v", got, err)
		}
	}
	if calls != 0 || v.CacheFallback("https://8.8.8.8/") {
		t.Fatal("literal used resolver or cache")
	}
	_, err := v.ValidateProxy(context.Background(), "http://127.0.0.1/", testProxy)
	assertDNSError(t, err, "invalid_network_target", false)
	_, err = v.ValidateProxy(context.Background(), "https://8.8.8.8/", "")
	assertDNSError(t, err, "proxy_dns_failed", false)
	_, err = v.ValidateProxy(context.Background(), "https://example.com/", "")
	assertDNSError(t, err, "proxy_dns_failed", false)
	if calls != 0 {
		t.Fatal("invalid target invoked DNS")
	}
	local := 0
	v.lookup = func(_ context.Context, host string) ([]string, error) {
		local++
		if host != "example.com" {
			t.Errorf("host %s", host)
		}
		return []string{"8.8.8.8", "127.0.0.1"}, nil
	}
	if _, err := v.ValidateDirect(context.Background(), "https://example.com/"); err == nil || local != 1 || calls != 0 {
		t.Fatalf("direct strict: %v local=%d proxy=%d", err, local, calls)
	}
	s := DefaultValidatorSettings()
	s.AllowPrivate = true
	v = newTestValidator(t, s, nil)
	got, err := v.ValidateDirect(context.Background(), "https://private.example/")
	if err != nil || len(got) != 0 {
		t.Fatalf("allow private direct %v %v", got, err)
	}
}

func TestValidatorCacheTTLAndEviction(t *testing.T) {
	s := DefaultValidatorSettings()
	s.CacheTTL = 5 * time.Second
	s.CacheMaxEntries = 2
	v := newTestValidator(t, s, resolveFunc(func(context.Context, string, string) ([]string, error) { return []string{"8.8.8.8"}, nil }))
	now := time.Unix(100, 0)
	v.now = func() time.Time { return now }
	for _, host := range []string{"z.example", "a.example", "m.example"} {
		if _, err := v.ValidateProxy(context.Background(), "https://"+host+"/", testProxy); err != nil {
			t.Fatal(err)
		}
	}
	if v.CacheFallback("https://a.example/") || !v.CacheFallback("https://m.example/") || !v.CacheFallback("https://z.example/") {
		t.Fatal("equal TTL eviction must choose lexicographically first hostname")
	}
	now = now.Add(5*time.Second - time.Nanosecond)
	if !v.CacheFallback("https://m.example/") {
		t.Fatal("expired early")
	}
	now = now.Add(time.Nanosecond)
	if v.CacheFallback("https://m.example/") {
		t.Fatal("not expired at TTL")
	}
	for _, disabled := range []ValidatorSettings{{Strict: true, CacheTTL: 0, CacheMaxEntries: 2}, {Strict: true, CacheTTL: time.Second, CacheMaxEntries: 0}} {
		v := newTestValidator(t, disabled, resolveFunc(func(context.Context, string, string) ([]string, error) { return []string{"8.8.8.8"}, nil }))
		if _, err := v.ValidateProxy(context.Background(), "https://example.com/", testProxy); err != nil {
			t.Fatal(err)
		}
		if v.CacheFallback("https://example.com/") {
			t.Fatal("disabled cache admitted target")
		}
	}
}

func TestValidatorCacheNeverReplacesLiveResolution(t *testing.T) {
	calls := 0
	upstream := &Error{"encrypted_dns_nxdomain", "controlled", false, false}
	v := newTestValidator(t, DefaultValidatorSettings(), resolveFunc(func(context.Context, string, string) ([]string, error) {
		calls++
		if calls == 1 {
			return []string{"8.8.8.8"}, nil
		}
		return nil, upstream
	}))
	if _, err := v.ValidateProxy(context.Background(), "https://images.example/", testProxy); err != nil {
		t.Fatal(err)
	}
	if !v.CacheFallback("https://images.example/next") {
		t.Fatal("no preflight cache")
	}
	if _, err := v.ValidateProxy(context.Background(), "https://images.example/next", testProxy); err != upstream || calls != 2 {
		t.Fatalf("live result replaced: %v calls=%d", err, calls)
	}
	if _, err := v.ValidateProxy(context.Background(), "https://failure.example/", testProxy); err != upstream || v.CacheFallback("https://failure.example/") {
		t.Fatal("failed lookup cached")
	}
}

func TestValidatorCancellationAndConcurrentCache(t *testing.T) {
	v := newTestValidator(t, DefaultValidatorSettings(), resolveFunc(func(ctx context.Context, _, _ string) ([]string, error) { return nil, ctx.Err() }))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := v.ValidateProxy(ctx, "https://example.com/", testProxy)
	if !errors.Is(err, context.Canceled) || v.CacheFallback("https://example.com/") {
		t.Fatalf("cancelled proxy: %v", err)
	}
	v.lookup = func(ctx context.Context, _ string) ([]string, error) { return nil, ctx.Err() }
	if _, err := v.ValidateDirect(ctx, "https://example.com/"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled direct: %v", err)
	}
	var calls atomic.Int32
	s := DefaultValidatorSettings()
	s.CacheMaxEntries = 4
	v = newTestValidator(t, s, resolveFunc(func(context.Context, string, string) ([]string, error) { calls.Add(1); return []string{"8.8.8.8"}, nil }))
	v.now = func() time.Time { return time.Unix(100, 0) }
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				url := fmt.Sprintf("https://host%d.example/", i)
				if _, err := v.ValidateProxy(context.Background(), url, testProxy); err != nil {
					t.Error(err)
				}
				v.CacheFallback(url)
			}
		}(i)
	}
	wg.Wait()
	if calls.Load() != 240 || len(v.cache) != 4 {
		t.Fatalf("calls=%d cache=%d", calls.Load(), len(v.cache))
	}
}
