package diagnostics

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ldos/backend/internal/config"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/proxysources"
)

func settingsForTest(t *testing.T) config.Settings {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"proxy":{"enabled":false,"auto_start":false},"dedup":{"enabled":false},"server":{"port":9876}}`), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := config.Load(path, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func TestPublicViewsDoNotExposeSecrets(t *testing.T) {
	s := settingsForTest(t)
	s.Auth.AuthorizationProxy = "http://alice:AUTH_SECRET@127.0.0.1:9000/"
	s.Proxy.SubscriptionURLs = []string{"https://example.org/SUBSCRIPTION_SECRET"}
	s.Proxy.InlineNodes = []string{"ss://NODE_SECRET@host"}
	s.Proxy.ProbeURL = "https://bob:PROBE_SECRET@example.org/?key=QUERY_SECRET"
	for _, view := range []string{"legacy", "diagnostics"} {
		encoded, err := json.Marshal(Config(s, view))
		if err != nil {
			t.Fatal(err)
		}
		for _, secret := range []string{"AUTH_SECRET", "SUBSCRIPTION_SECRET", "NODE_SECRET", "PROBE_SECRET", "QUERY_SECRET"} {
			if strings.Contains(string(encoded), secret) {
				t.Fatalf("%s leaked %s", view, secret)
			}
		}
		if view == "diagnostics" && strings.Contains(string(encoded), s.RuntimeDir) {
			t.Fatal("diagnostic leaked local path")
		}
	}
	value := Scheduler(map[string]any{"running": true, "active": -2, "dispatch_loop": map[string]any{"state": "running", "operational": true, "last_error_category": "PASSWORD=secret"}}, nil)
	if value["tasks"].(map[string]any)["active"] != int64(0) {
		t.Fatal(value)
	}
	if Loop(map[string]any{"state": "unexpected_exit", "operational": true})["operational"] != false {
		t.Fatal("unexpected exit reported operational")
	}
}
func TestProjectProxyUsesEffectiveSources(t *testing.T) {
	for _, tc := range []struct {
		name                          string
		static, managed, subscription bool
		want                          int
	}{
		{"managed_subscription", false, true, true, 1},
		{"managed_empty", true, true, false, 0},
		{"static_sources", true, false, false, 3},
		{"unconfigured", false, false, false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := settingsForTest(t)
			s.Proxy.Enabled = true
			s.Gallery.PythonExecutable = filepath.Join(t.TempDir(), "missing-python")
			if tc.static {
				s.Proxy.SubscriptionURLs = []string{"https://static.example.test/sub", "https://static.example.test/sub", " "}
				s.Proxy.InlineNodes = []string{"http://127.0.0.1:18080"}
				s.Proxy.NodeFile = filepath.Join(s.RuntimeDir, "missing-nodes.txt")
			}
			if tc.managed {
				managed, err := proxysources.New(proxysources.Settings{}, s.RuntimeDir, s.ProjectDir)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := managed.ClearNodeFile(); err != nil {
					t.Fatal(err)
				}
				if tc.subscription {
					if _, err := managed.AddSubscription("https://managed.example.test/sub"); err != nil {
						t.Fatal(err)
					}
				}
			}
			sources, err := proxysources.New(s.Proxy.SourceSettings(), s.RuntimeDir, s.ProjectDir)
			if err != nil {
				t.Fatal(err)
			}
			pool := proxypool.New(s.Proxy.RuntimeSettings(s.RuntimeDir, s.ProjectDir), sources)
			running := pool.Status()
			running["running"] = true
			service := New(context.Background(), func() config.Settings { return s })
			defer service.Stop()
			for _, autoStart := range []bool{false, true} {
				s.Proxy.AutoStart = autoStart
				for _, live := range []map[string]any{nil, {"running": false}, pool.Status(), running} {
					wantStatus, wantSummary := "ok", "项目抓取代理池已配置"
					if tc.want == 0 {
						wantStatus, wantSummary = "error", "项目抓取代理池已启用，但没有配置节点源"
					} else if autoStart && live != nil && live["running"] != true {
						wantStatus, wantSummary = "error", "项目抓取代理池自动启动后未运行"
					}
					result := service.Readiness(context.Background(), true, live, nil, nil, nil)
					got := result["components"].(Snapshot)["project_proxy"]
					if got["source_count"] != tc.want || got["status"] != wantStatus || got["summary"] != wantSummary {
						t.Fatalf("auto_start=%t live=%t running=%t: count=%v status=%v summary=%v", autoStart, live != nil, live["running"] == true, got["source_count"], got["status"], got["summary"])
					}
				}
			}
			wantStatus := "ok"
			if tc.want == 0 {
				wantStatus = "error"
			}
			got := service.Doctor(context.Background())["components"].(Snapshot)["project_proxy"]
			if got["source_count"] != tc.want || got["status"] != wantStatus {
				t.Fatalf("doctor: count=%v status=%v", got["source_count"], got["status"])
			}
		})
	}
}

func TestReadinessUsesLiveDependencies(t *testing.T) {
	s := settingsForTest(t)
	if err := os.MkdirAll(filepath.Join(s.Gallery.RepoPath, "gallery_dl"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Gallery.RepoPath, "gallery_dl", "__init__.py"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	service := New(context.Background(), func() config.Settings { return s })
	defer service.Stop()
	tasks := map[string]any{"running": true, "dispatch_loop": map[string]any{"state": "running", "running": true, "operational": true}}
	crawls := map[string]any{"running": true}
	if value := service.Readiness(context.Background(), true, nil, nil, tasks, crawls); value["ready"] != true {
		t.Fatal(value)
	}
	python := s.Gallery.PythonExecutable
	s.Gallery.PythonExecutable = filepath.Join(t.TempDir(), "missing-python")
	if value := service.Readiness(context.Background(), true, nil, nil, tasks, crawls); value["ready"] != false {
		t.Fatal("missing executor not reflected")
	}
	s.Gallery.PythonExecutable = python
	if value := service.Readiness(context.Background(), false, nil, nil, tasks, crawls); value["ready"] != false {
		t.Fatal("database failure not reflected")
	}
	tasks["dispatch_loop"] = map[string]any{"state": "unexpected_exit", "operational": false}
	if value := service.Readiness(context.Background(), true, nil, nil, tasks, crawls); value["ready"] != false {
		t.Fatal("scheduler exit not reflected")
	}
}
func TestModelProbeCacheSingleFlightAndShutdown(t *testing.T) {
	s := settingsForTest(t)
	s.Dedup.Enabled = true
	service := New(context.Background(), func() config.Settings { return s })
	var calls atomic.Int64
	started, release := make(chan struct{}), make(chan struct{})
	service.probe = func(ctx context.Context, _ config.Settings) Snapshot {
		if calls.Add(1) == 1 {
			close(started)
		}
		select {
		case <-release:
		case <-ctx.Done():
		}
		return Snapshot{"dedup": component("ok", "ready", true)}
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if value := service.Models(context.Background(), false); value["dedup"]["status"] != "ok" {
				t.Error(value)
			}
		}()
	}
	<-started
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("concurrent cache calls: %d", calls.Load())
	}
	service.mu.Lock()
	service.at = time.Now().Add(-3 * time.Minute)
	service.mu.Unlock()
	if value := service.Models(context.Background(), false); value["dedup"]["stale"] != true {
		t.Fatal("stale cache blocked rather than refreshing")
	}
	service.Stop()
	if calls.Load() != 2 {
		t.Fatalf("refresh calls: %d", calls.Load())
	}
}
func TestProbeUsesControlledResults(t *testing.T) {
	s := settingsForTest(t)
	s.Dedup.Enabled = true
	s.Dedup.NoSSCD = true
	s.Dedup.NoDINO = true
	s.Dedup.PythonExecutable = filepath.Join(t.TempDir(), "python")
	s.Dedup.WorkerScript = filepath.Join(t.TempDir(), "worker.py")
	s.Dedup.CoreScript = filepath.Join(t.TempDir(), "core.py")
	for _, path := range []string{s.Dedup.WorkerScript, s.Dedup.CoreScript} {
		if err := os.WriteFile(path, nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(s.Dedup.PythonExecutable, []byte("#!/bin/sh\nprintf '%s\\n' '{\"torch_version\":\"2+cpu\",\"actual_device\":\"cpu\",\"cuda_available\":false,\"opencv_variants\":[\"opencv-python-headless\"],\"forbidden_cpu_package_count\":0}'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if value := probeModels(context.Background(), s); !ready(value) {
		t.Fatal(value)
	}
	if err := os.WriteFile(s.Dedup.PythonExecutable, []byte("#!/bin/sh\necho 'PRIVATE_PATH SECRET_PASSWORD' >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	value := probeModels(context.Background(), s)
	encoded, _ := json.Marshal(value)
	if ready(value) || strings.Contains(string(encoded), "SECRET_PASSWORD") || strings.Contains(string(encoded), "PRIVATE_PATH") {
		t.Fatal(string(encoded))
	}
}
