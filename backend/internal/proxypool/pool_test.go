package proxypool

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

	"ldos/backend/internal/proxyparse"
	"ldos/backend/internal/proxysources"
	"ldos/backend/internal/proxytransport"
)

type testSources struct {
	snapshot proxysources.Snapshot
	calls    atomic.Int32
}

func (s *testSources) Snapshot() proxysources.Snapshot { s.calls.Add(1); return s.snapshot }

type testCore struct {
	err   error
	stops atomic.Int32
}

func (c *testCore) Start(context.Context, []proxyparse.Node) ([]proxytransport.Endpoint, error) {
	return nil, c.err
}
func (c *testCore) Stop() error          { c.stops.Add(1); return nil }
func (*testCore) Status() map[string]any { return map[string]any{"running": false} }
func testPool(t *testing.T) (*Pool, *atomic.Int64, *testSources) {
	t.Helper()
	clock := &atomic.Int64{}
	clock.Store(time.Now().UnixNano())
	sources := &testSources{snapshot: proxysources.Snapshot{ConfiguredRevision: "v1"}}
	pool := newPool(Settings{Enabled: true, Engine: "native", AllowSocks: true, ProbeURL: "https://target.example/", ProbeWorkers: 2, ProbeTimeout: time.Second, ProbeCacheTTL: time.Minute, FailCooldown: time.Second}, sources, dependencies{
		now: func() time.Time { return time.Unix(0, clock.Load()) },
		load: func(context.Context, proxysources.Snapshot, time.Duration) ([]proxyparse.Node, []string, error) {
			return []proxyparse.Node{
				{Scheme: "http", Host: "127.0.0.1", Port: 18001, Endpoint: "http://127.0.0.1:18001", Name: "日本 JP", Usable: true},
				{Scheme: "socks5", Host: "127.0.0.1", Port: 18002, Endpoint: "socks5://127.0.0.1:18002", Name: "US", Usable: true},
			}, nil, nil
		},
		probe: func(context.Context, string, string, time.Duration) (int, error) { return 204, nil },
	})
	if _, err := pool.Start(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Stop(context.Background(), true); err != nil {
			t.Error(err)
		}
	})
	return pool, clock, sources
}
func TestStatusSourceCountUsesCurrentSnapshot(t *testing.T) {
	p, _, sources := testPool(t)
	for _, running := range []bool{true, false} {
		if !running {
			if _, err := p.Stop(context.Background(), true); err != nil {
				t.Fatal(err)
			}
		}
		for _, tc := range []struct {
			snapshot proxysources.Snapshot
			want     int
		}{
			{proxysources.Snapshot{SubscriptionURLs: []string{"https://managed.example.test/sub"}, Source: "runtime", HasRuntimeOverride: true, RuntimeOverrideValid: true}, 1},
			{proxysources.Snapshot{NodeFile: "/missing-nodes.txt", InlineNodes: []string{"http://127.0.0.1:18080"}}, 2},
			{proxysources.Snapshot{Source: "runtime", HasRuntimeOverride: true, RuntimeOverrideValid: true}, 0},
		} {
			sources.snapshot = tc.snapshot
			before := sources.calls.Load()
			status := p.Status()
			if got := status["source_count"]; got != tc.want || status["running"] != running {
				t.Fatalf("running=%t: source_count=%v, want %d", running, got, tc.want)
			}
			if calls := sources.calls.Load() - before; calls != 1 {
				t.Fatalf("snapshots per status: %d", calls)
			}
		}
	}
}

func TestLeaseIsolationAndRelease(t *testing.T) {
	p, clock, _ := testPool(t)
	ctx := context.Background()
	if lease, err := p.Acquire(ctx, Request{Owner: "none", AllowedIDs: []string{}}); err != nil || lease != nil {
		t.Fatal(lease, err)
	}
	var wg sync.WaitGroup
	leases := make(chan *Lease, 24)
	for range 24 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			lease, err := p.Acquire(ctx, Request{Owner: "one", NodeTags: []string{"jp"}})
			if err != nil {
				t.Error(err)
			}
			leases <- lease
		}()
	}
	wg.Wait()
	close(leases)
	id := ""
	for lease := range leases {
		if lease == nil {
			t.Fatal("no lease")
		}
		if id != "" && id != lease.NodeID {
			t.Fatal("duplicate ownership")
		}
		id = lease.NodeID
		lease.Tags[0] = "mutated"
	}
	if p.ActiveLeases() != 1 {
		t.Fatal("lease count")
	}
	if _, err := p.Reload(ctx, ""); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	second, err := p.Acquire(ctx, Request{Owner: "two"})
	if err != nil || second == nil || second.NodeID == id {
		t.Fatal(second, err)
	}
	if third, err := p.Acquire(ctx, Request{Owner: "three"}); err != nil || third != nil {
		t.Fatal(third, err)
	}
	if err := p.Release(ctx, "one", true, "password=secret"); err != nil {
		t.Fatal(err)
	}
	if blocked, err := p.Acquire(ctx, Request{Owner: "next", NodeTags: []string{"jp"}, ProbeBeforeUse: true}); blocked != nil || err != nil {
		t.Fatal(blocked, err)
	}
	clock.Add(int64(2 * time.Second))
	recovered, err := p.Acquire(ctx, Request{Owner: "next", NodeTags: []string{"jp"}, ProbeBeforeUse: true})
	if err != nil || recovered == nil {
		t.Fatal(recovered, err)
	}
	if strings.Contains(p.Status()["last_error"].(string), "secret") {
		t.Fatal("secret exposed")
	}
}
func TestProbeCacheAndSingleNodeMerge(t *testing.T) {
	p, clock, _ := testPool(t)
	ctx := context.Background()
	var probes atomic.Int32
	p.deps.probe = func(context.Context, string, string, time.Duration) (int, error) { probes.Add(1); return 200, nil }
	first, err := p.ProbeForTarget(ctx, "https://target.example/new?token=secret")
	if err != nil || !first.Cached || probes.Load() != 0 {
		t.Fatal(first, err)
	}
	first.Results[0].Healthy = false
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := p.ProbeForTarget(ctx, "https://different.example/path")
			if err != nil || r.Healthy != 2 {
				t.Error(r, err)
			}
		}()
	}
	wg.Wait()
	if probes.Load() != 2 {
		t.Fatal("single flight failed", probes.Load())
	}
	cached, _ := p.ProbeForTarget(ctx, "https://target.example/")
	if !cached.Results[0].Healthy {
		t.Fatal("cache aliased")
	}
	_, err = p.Probe(ctx, "https://target.example/", cached.Results[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	cached, _ = p.ProbeForTarget(ctx, "https://target.example/")
	if len(cached.Results) != 2 {
		t.Fatal("single-node probe truncated cache")
	}
	clock.Add(int64(time.Minute))
	_, _ = p.ProbeForTarget(ctx, "https://target.example/")
	if probes.Load() != 5 {
		t.Fatal("cache expiration", probes.Load())
	}
	if _, err = p.Probe(ctx, "http://insecure.example/", ""); err == nil {
		t.Fatal("non-HTTPS probe accepted")
	}
	if _, err = p.Probe(ctx, "https://user:secret@example.com/", ""); err == nil {
		t.Fatal("URL credential accepted")
	}
}
func TestForceStopCancelsPendingAcquire(t *testing.T) {
	p, _, _ := testPool(t)
	started := make(chan struct{})
	var once sync.Once
	p.deps.probe = func(ctx context.Context, _, _ string, _ time.Duration) (int, error) {
		once.Do(func() { close(started) })
		<-ctx.Done()
		return 0, ctx.Err()
	}
	done := make(chan error, 1)
	go func() {
		lease, err := p.Acquire(context.Background(), Request{Owner: "pending", ProbeBeforeUse: true})
		if lease != nil {
			t.Error("lease survived stop")
		}
		done <- err
	}()
	<-started
	if _, err := p.Stop(context.Background(), false); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := p.Stop(ctx, true); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if p.ActiveLeases() != 0 || len(p.pending) != 0 {
		t.Fatal("pending state leaked")
	}
}
func TestCoreFailureBlocksAcquireUntilNextStart(t *testing.T) {
	p, _, sources := testPool(t)
	p.settings.TransportCoreEnabled = true
	core := &testCore{err: errors.New("core failed")}
	p.deps.core = func() Core { return core }
	p.deps.load = func(context.Context, proxysources.Snapshot, time.Duration) ([]proxyparse.Node, []string, error) {
		return []proxyparse.Node{{Scheme: "vless", CoreConfig: map[string]any{"type": "vless"}}}, nil, nil
	}
	if _, err := p.Start(context.Background(), ""); err == nil {
		t.Fatal("missing core accepted")
	}
	if lease, err := p.Acquire(context.Background(), Request{Owner: "blocked"}); lease != nil || !errors.Is(err, ErrUnavailable) {
		t.Fatal(lease, err)
	}
	if core.stops.Load() != 1 {
		t.Fatal("failed startup did not clean core", core.stops.Load())
	}
	p.deps.load = func(context.Context, proxysources.Snapshot, time.Duration) ([]proxyparse.Node, []string, error) {
		return nil, nil, errors.New("subscription failed")
	}
	before := sources.calls.Load()
	_, _ = p.Start(context.Background(), "")
	if sources.calls.Load() != before+1 {
		t.Fatal("start consumed multiple snapshots")
	}
	if lease, err := p.Acquire(context.Background(), Request{Owner: "stopped"}); lease != nil || err != nil {
		t.Fatal(lease, err)
	}
}
func TestSubscriptionFetchOfflineBoundaries(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/nodes":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("http://127.0.0.1:19000#日本"))
		case "/large":
			w.Header().Set("Content-Length", "8388609")
		case "/redirect":
			http.Redirect(w, r, "/redirect", 302)
		default:
			http.Error(w, "private response", 503)
		}
	}))
	defer server.Close()
	nodes, err := fetchOne(context.Background(), server.URL+"/nodes", time.Second)
	if err != nil || len(nodes) != 1 || nodes[0].Name != "日本" {
		t.Fatal(nodes, err)
	}
	for _, path := range []string{"/large", "/redirect", "/secret-path?token=secret"} {
		if _, err := fetchOne(context.Background(), server.URL+path, time.Second); err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatal(err)
		}
	}
	snapshot := proxysources.Snapshot{SubscriptionURLs: []string{server.URL + "/secret"}, InlineNodes: []string{"http://127.0.0.1:19000"}}
	nodes, warnings, err := loadSources(context.Background(), snapshot, time.Second)
	if err != nil || len(nodes) != 1 || !reflect.DeepEqual(warnings, []string{"全部订阅地址拉取失败"}) {
		t.Fatal(nodes, warnings, err)
	}
	snapshot.InlineNodes = nil
	if _, _, err := loadSources(context.Background(), snapshot, time.Second); err == nil {
		t.Fatal("all-source failure hidden")
	}
}
