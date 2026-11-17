package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestExecutionConfiguration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	load := func(data string) Settings {
		t.Helper()
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		s, err := Load(path, func(string) string { return "" })
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	s := load(`{}`)
	if s.ProjectDir != dir || s.Gallery.RepoPath != filepath.Join(dir, "..", "gallery-dl-codeberg") || s.Gallery.CacheFile != filepath.Join(dir, "credentials", "managed", "gallery-dl-cache.sqlite3") {
		t.Fatal(s)
	}
	if !s.Proxy.Enabled || s.Gallery.PythonExecutable != "python3" || s.Gallery.ForbiddenArgs != nil {
		t.Fatal(s)
	}
	runtime := s.Scheduler.RuntimeSettings()
	if runtime.MaxConcurrent != 20 || runtime.PollInterval != 500*time.Millisecond || runtime.ShutdownGrace != 15*time.Second || runtime.RetryJitter != .5 || runtime.RetryBackoffCap != 300 {
		t.Fatal(runtime)
	}
	s = load(`{"project_dir":"project","gallery":{"repo_path":"vendor/gallery","cache_file":"private/cache.sqlite3","python_executable":"/custom/python","forbidden_args":["--exec"],"terminate_grace_seconds":0},"proxy":{"enabled":false},"scheduler":{"max_concurrent_tasks":0,"poll_interval_seconds":0,"shutdown_grace_seconds":0,"max_logs_per_task":0,"retry_jitter_seconds":-1,"retry_backoff_cap_seconds":0}}`)
	if s.ProjectDir != filepath.Join(dir, "project") || s.Gallery.RepoPath != filepath.Join(dir, "vendor/gallery") || s.Gallery.CacheFile != filepath.Join(dir, "private/cache.sqlite3") || s.Proxy.Enabled {
		t.Fatal(s)
	}
	runtime = s.Scheduler.RuntimeSettings()
	if runtime.MaxConcurrent != 1 || runtime.PollInterval != 100*time.Millisecond || runtime.ShutdownGrace != time.Second || runtime.RetryJitter != 0 || runtime.RetryBackoffCap != 1 || s.Scheduler.MaxLogsPerTask != 100 || s.Gallery.TerminateGraceSeconds != .2 {
		t.Fatal(s)
	}
	for _, invalid := range []string{`{"gallery":{"terminate_grace_seconds":1e100}}`, `{"scheduler":{"poll_interval_seconds":1e100}}`, `{"proxy":{"enabled":"false"}}`, `{"scheduler":{"max_concurrent_tasks":1.5}}`} {
		if err := os.WriteFile(path, []byte(invalid), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path, func(string) string { return "" }); err == nil {
			t.Fatalf("accepted %s", invalid)
		}
	}
}
