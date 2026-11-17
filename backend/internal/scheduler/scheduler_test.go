package scheduler

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ldos/backend/internal/store"
)

type runnerFunc func(context.Context, string, RunRequest) (RunResult, error)

func (f runnerFunc) Run(ctx context.Context, id string, r RunRequest) (RunResult, error) {
	return f(ctx, id, r)
}

type fakePool struct {
	mu       sync.Mutex
	lease    *Lease
	err      error
	requests []ProxyRequest
	releases int
	fault    bool
}

func (p *fakePool) Acquire(_ context.Context, r ProxyRequest) (*Lease, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.requests = append(p.requests, r)
	return p.lease, p.err
}
func (p *fakePool) Release(_ context.Context, _ string, fault bool, _ string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.releases++
	p.fault = fault
	return nil
}

func setup(t *testing.T, run Runner, pool ProxyPool, validate func(context.Context, string, string) (bool, error)) (*Scheduler, *store.Store) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if pool == nil {
		pool = &fakePool{}
	}
	if validate == nil {
		validate = func(context.Context, string, string) (bool, error) { return true, nil }
	}
	settings := DefaultSettings()
	settings.PollInterval = 5 * time.Millisecond
	settings.RetryJitter = 0
	settings.RetryBackoffCap = 0
	s, err := New(db, Dependencies{Runner: run, Proxy: pool, ValidateCredentials: validate}, settings)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := s.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	return s, db
}
func createTask(t *testing.T, db *store.Store, id, site, mode string, attempts int, policy map[string]any) {
	t.Helper()
	_, _, err := db.CreateTask(context.Background(), map[string]any{"id": id, "url": "https://example.org/file", "site": site, "output_dir": t.TempDir(), "proxy_mode": mode, "max_attempts": attempts, "policy": policy}, "")
	if err != nil {
		t.Fatal(err)
	}
}
func waitTask(t *testing.T, db *store.Store, id string, predicate func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		row, err := db.GetTask(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if predicate(row) {
			return row
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s: %#v", id, row)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
func startScheduler(t *testing.T, s *Scheduler) {
	t.Helper()
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
}
func succeeded(r map[string]any) bool { return r["status"] == "succeeded" }

func TestNativeTaskExecutionRetriesAndArtifacts(t *testing.T) {
	var calls atomic.Int32
	s, db := setup(t, runnerFunc(func(ctx context.Context, id string, r RunRequest) (RunResult, error) {
		if r.Policy.StallTimeout != 0 {
			return RunResult{}, errors.New("non-EH stall timeout")
		}
		if err := r.OnStarted(1234, "fake-marker"); err != nil {
			return RunResult{}, err
		}
		if calls.Add(1) == 1 {
			code := 128
			return RunResult{ExitCode: &code, OutputTail: "temporary download failure"}, nil
		}
		file := filepath.Join(r.OutputDir, "image.jpg")
		if err := os.WriteFile(file, []byte("image"), 0600); err != nil {
			return RunResult{}, err
		}
		if err := r.OnLine("stdout", file); err != nil {
			return RunResult{}, err
		}
		_ = r.OnLine("stderr", "Authorization: Bearer test-secret")
		code := 0
		return RunResult{ExitCode: &code}, nil
	}), nil, nil)
	createTask(t, db, "task", "danbooru", "direct", 3, map[string]any{"backoff_base_seconds": 0})
	startScheduler(t, s)
	row := waitTask(t, db, "task", succeeded)
	if row["attempt_count"] != int64(2) || row["artifact_count"] != int64(1) || row["artifact_bytes"] != int64(5) || row["pid"] != nil {
		t.Fatal(row)
	}
	logs, err := db.GetLogs(context.Background(), "task", 0, nil, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 2 {
		t.Fatal(logs)
	}
	for _, line := range logs {
		if strings.Contains(line["line"].(string), "test-secret") {
			t.Fatal(line)
		}
	}
}

func TestProxyFailureNeverSilentlyBypassesCore(t *testing.T) {
	for _, tc := range []struct {
		name, mode   string
		err          error
		wantCalls    int32
		wantAttempts int64
		wantStatus   string
	}{
		{"failed core prefer", "prefer", ErrPoolUnavailable, 0, 1, "failed"},
		{"empty required", "required", nil, 0, 2, "failed"},
		{"acquire error required", "required", errors.New("unavailable"), 0, 2, "failed"},
		{"empty prefer", "prefer", nil, 1, 1, "succeeded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			s, db := setup(t, runnerFunc(func(context.Context, string, RunRequest) (RunResult, error) {
				calls.Add(1)
				code := 0
				return RunResult{ExitCode: &code}, nil
			}), &fakePool{err: tc.err}, nil)
			createTask(t, db, "task", "pixiv", tc.mode, 2, map[string]any{"backoff_base_seconds": 0})
			startScheduler(t, s)
			row := waitTask(t, db, "task", func(r map[string]any) bool { return r["status"] == tc.wantStatus })
			if calls.Load() != tc.wantCalls || row["attempt_count"] != tc.wantAttempts {
				t.Fatal(calls.Load(), row)
			}
		})
	}
}

func TestLeaseReleaseAndProbeAllowlist(t *testing.T) {
	pool := &fakePool{lease: &Lease{NodeID: "node1", Endpoint: "http://user:password@127.0.0.1:8000"}}
	s, db := setup(t, runnerFunc(func(_ context.Context, _ string, r RunRequest) (RunResult, error) {
		if r.ProxyURL != pool.lease.Endpoint {
			return RunResult{}, errors.New("missing real lease endpoint")
		}
		code := 8
		return RunResult{ExitCode: &code, OutputTail: "challenge"}, nil
	}), pool, nil)
	createTask(t, db, "task", "exhentai", "required", 1, map[string]any{"proxy_probe_scope": "missing-address"})
	startScheduler(t, s)
	row := waitTask(t, db, "task", func(r map[string]any) bool { return r["status"] == "failed" })
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if pool.releases != 1 || !pool.fault || len(pool.requests) != 1 || pool.requests[0].AllowedIDs == nil || len(pool.requests[0].AllowedIDs) != 0 {
		t.Fatal(pool)
	}
	if row["lease"] != nil || strings.Contains(row["latest_attempt"].(map[string]any)["proxy_endpoint"].(string), "password") {
		t.Fatal(row)
	}
}

func TestCancelAndShutdownDrainWorkers(t *testing.T) {
	for _, cancelTask := range []bool{true, false} {
		t.Run(map[bool]string{true: "cancel", false: "shutdown"}[cancelTask], func(t *testing.T) {
			started := make(chan struct{})
			stopped := make(chan struct{})
			s, db := setup(t, runnerFunc(func(ctx context.Context, _ string, r RunRequest) (RunResult, error) {
				close(started)
				<-ctx.Done()
				close(stopped)
				return RunResult{}, ctx.Err()
			}), nil, nil)
			createTask(t, db, "task", "twitter", "direct", 3, map[string]any{})
			startScheduler(t, s)
			select {
			case <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("not started")
			}
			if cancelTask {
				if _, err := s.Cancel(context.Background(), "task"); err != nil {
					t.Fatal(err)
				}
				waitTask(t, db, "task", func(r map[string]any) bool { return r["status"] == "cancelled" })
			} else {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if err := s.Stop(ctx); err != nil {
					t.Fatal(err)
				}
				row := waitTask(t, db, "task", func(r map[string]any) bool { return r["status"] == "queued" })
				if row["last_error_class"] != "backend_shutdown" {
					t.Fatal(row)
				}
			}
			select {
			case <-stopped:
			default:
				t.Fatal("worker not drained")
			}
		})
	}
}

func TestCredentialBlockedTasksResume(t *testing.T) {
	var allowed atomic.Bool
	s, db := setup(t, runnerFunc(func(context.Context, string, RunRequest) (RunResult, error) {
		code := 0
		return RunResult{ExitCode: &code}, nil
	}), nil, func(context.Context, string, string) (bool, error) { return allowed.Load(), nil })
	createTask(t, db, "task", "twitter", "direct", 1, map[string]any{})
	startScheduler(t, s)
	row := waitTask(t, db, "task", func(r map[string]any) bool { return r["last_error_class"] == "credentials_unavailable" })
	if row["status"] != "queued" || row["attempt_count"] != int64(0) {
		t.Fatal(row)
	}
	allowed.Store(true)
	s.Notify()
	waitTask(t, db, "task", succeeded)
}

func TestGlobalAndPerSiteConcurrency(t *testing.T) {
	started := make(chan string, 3)
	release := make(chan struct{})
	s, db := setup(t, runnerFunc(func(ctx context.Context, id string, r RunRequest) (RunResult, error) {
		started <- id
		select {
		case <-ctx.Done():
			return RunResult{}, ctx.Err()
		case <-release:
		}
		code := 0
		return RunResult{ExitCode: &code}, nil
	}), nil, nil)
	s.settings.MaxConcurrent = 2
	for _, row := range []struct{ id, site string }{{"a1", "a"}, {"a2", "a"}, {"b1", "b"}} {
		createTask(t, db, row.id, row.site, "direct", 1, map[string]any{"max_concurrency": 1})
	}
	startScheduler(t, s)
	first := []string{}
	for len(first) < 2 {
		select {
		case id := <-started:
			first = append(first, id)
		case <-time.After(3 * time.Second):
			t.Fatal("queue starved", first)
		}
	}
	if first[0][0] == first[1][0] {
		t.Fatal("site concurrency exceeded", first)
	}
	if s.Summary()["active"] != 2 {
		t.Fatal(s.Summary())
	}
	close(release)
	for _, id := range []string{"a1", "a2", "b1"} {
		waitTask(t, db, id, succeeded)
	}
}
