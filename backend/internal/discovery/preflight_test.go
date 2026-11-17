package discovery

import (
	"context"
	"errors"
	"testing"

	"ldos/backend/internal/network"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/scheduler"
)

func TestCrawlPreflightDoesNotResolveDNSOrAcquireProxy(t *testing.T) {
	for _, mode := range []string{"prefer", "required", "direct"} {
		t.Run(mode, func(t *testing.T) {
			pool := &transportPool{err: proxypool.ErrUnavailable}
			validator := &transportValidator{err: errors.New("DNS must not run")}
			transport := nativeTransport(t, pool, validator)
			policy := scheduler.DefaultPolicy()
			policy.ProxyMode = mode
			if err := transport.ValidateTarget(context.Background(), "https://unresolvable.example.invalid/", "", policy); err != nil {
				t.Fatal(err)
			}
			if validator.direct != 0 || len(validator.proxy) != 0 || len(pool.requests) != 0 {
				t.Fatal("admission performed network work", validator, pool)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if err := transport.ValidateTarget(ctx, "https://example.test/", "", policy); !errors.Is(err, context.Canceled) {
				t.Fatal("cancellation ignored", err)
			}
			if err := transport.ValidateTarget(context.Background(), "file:///tmp/test", "", policy); err == nil {
				t.Fatal("invalid URL admitted")
			}
		})
	}
}

func TestURLOnlyValidationReachesSelectedTransport(t *testing.T) {
	for _, mode := range []string{"direct", "prefer", "required"} {
		t.Run(mode, func(t *testing.T) {
			pool := &transportPool{}
			transport, err := NewTransport(nil, pool, network.URLValidator{}, t.TempDir(), nil)
			if err != nil {
				t.Fatal(err)
			}
			options := retryOptions()
			options.Mode = mode
			options.URL = "https://unresolvable.example.invalid/search"
			calls := 0
			options.Operation = func(_ context.Context, attempt Attempt) (any, error) {
				calls++
				if attempt.Mode != mode || (attempt.Endpoint() == "") != (mode == "direct") {
					t.Fatal("wrong route", attempt)
				}
				return "requested", nil
			}
			outcome, err := transport.Execute(context.Background(), options)
			if err != nil || outcome.Value != "requested" || calls != 1 {
				t.Fatal("request blocked by DNS", outcome, err, calls)
			}
			if mode == "direct" && len(pool.requests) != 0 {
				t.Fatal("direct used proxy")
			}
			if mode != "direct" && (len(pool.requests) != 1 || len(pool.released) != 1) {
				t.Fatal("proxy lease not released", pool)
			}
		})
	}
}
