package config

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"time"

	"ldos/backend/internal/scheduler"
)

type Gallery struct {
	RepoPath              string   `json:"repo_path"`
	CacheFile             string   `json:"cache_file"`
	PythonExecutable      string   `json:"python_executable"`
	MigrateDefaultAuth    bool     `json:"migrate_default_auth"`
	DefaultHTTPTimeout    float64  `json:"default_http_timeout"`
	DefaultRetries        int      `json:"default_retries"`
	TerminateGraceSeconds float64  `json:"terminate_grace_seconds"`
	MaxLogLineChars       int      `json:"max_log_line_chars"`
	ForbiddenArgs         []string `json:"forbidden_args"`
}

type Scheduler struct {
	MaxConcurrentTasks     int     `json:"max_concurrent_tasks"`
	MaxConcurrentBatches   int     `json:"max_concurrent_batches"`
	PollIntervalSeconds    float64 `json:"poll_interval_seconds"`
	ShutdownGraceSeconds   float64 `json:"shutdown_grace_seconds"`
	MaxLogsPerTask         int     `json:"max_logs_per_task"`
	RetryJitterSeconds     float64 `json:"retry_jitter_seconds"`
	RetryBackoffCapSeconds float64 `json:"retry_backoff_cap_seconds"`
}

func (s *Settings) executionDefaults() {
	s.Gallery = Gallery{DefaultHTTPTimeout: 30, DefaultRetries: 2, TerminateGraceSeconds: 5, MaxLogLineChars: 4000, MigrateDefaultAuth: true}
	s.Scheduler = Scheduler{MaxConcurrentTasks: 20, MaxConcurrentBatches: 4, PollIntervalSeconds: .5, ShutdownGraceSeconds: 15, MaxLogsPerTask: 5000, RetryJitterSeconds: .5, RetryBackoffCapSeconds: 300}
	s.Proxy = defaultProxy()
	s.EncryptedDNS = defaultEncryptedDNS()
	s.Auth = Auth{BrowserLoginTimeoutSeconds: 900, BrowserPollIntervalSeconds: 1}
	s.modelDefaults()
}

func (s *Settings) executionPaths(base string, getenv func(string) string) {
	s.ProjectDir = resolve(base, s.ProjectDir, base)
	s.Gallery.RepoPath = resolve(base, s.Gallery.RepoPath, filepath.Join(s.ProjectDir, "..", "gallery-dl-codeberg"))
	s.Gallery.CacheFile = resolve(base, s.Gallery.CacheFile, filepath.Join(s.ProjectDir, "credentials", "managed", "gallery-dl-cache.sqlite3"))
	if s.Gallery.PythonExecutable == "" {
		s.Gallery.PythonExecutable = getenv("PYTHON")
		if s.Gallery.PythonExecutable == "" {
			candidate := filepath.Join(s.ProjectDir, ".venv", "bin", "python")
			if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
				s.Gallery.PythonExecutable = candidate
			} else {
				s.Gallery.PythonExecutable = "python3"
			}
		}
	}
	s.Gallery.PythonExecutable = modelExecutable(base, s.Gallery.PythonExecutable, "python3")
	s.modelPaths(base)
}

func (s *Settings) normalizeExecution() error {
	// Preserve the source loader's clamping for scheduler inputs, but reject
	// nonfinite/overflowing durations before converting them to time.Duration.
	maxSeconds := float64(math.MaxInt64) / float64(time.Second)
	for _, seconds := range []float64{s.Gallery.TerminateGraceSeconds, s.Scheduler.PollIntervalSeconds, s.Scheduler.ShutdownGraceSeconds, s.Scheduler.RetryJitterSeconds, s.Scheduler.RetryBackoffCapSeconds} {
		if math.IsNaN(seconds) || math.IsInf(seconds, 0) || math.Abs(seconds) >= maxSeconds {
			return errors.New("execution duration is out of range")
		}
	}
	s.Gallery.TerminateGraceSeconds = max(.2, s.Gallery.TerminateGraceSeconds)
	s.Scheduler.MaxConcurrentTasks = max(1, s.Scheduler.MaxConcurrentTasks)
	s.Scheduler.PollIntervalSeconds = max(.1, s.Scheduler.PollIntervalSeconds)
	s.Scheduler.ShutdownGraceSeconds = max(1, s.Scheduler.ShutdownGraceSeconds)
	s.Scheduler.MaxLogsPerTask = max(100, s.Scheduler.MaxLogsPerTask)
	s.Scheduler.RetryJitterSeconds = max(0, s.Scheduler.RetryJitterSeconds)
	s.Scheduler.RetryBackoffCapSeconds = max(1, s.Scheduler.RetryBackoffCapSeconds)
	if s.Scheduler.MaxConcurrentBatches < 1 || s.Scheduler.MaxConcurrentBatches > 16 {
		return errors.New("scheduler.max_concurrent_batches must be between 1 and 16")
	}
	if err := s.normalizeModels(); err != nil {
		return err
	}
	if err := s.normalizeProxy(); err != nil {
		return err
	}
	if err := s.Auth.normalize(); err != nil {
		return err
	}
	return s.EncryptedDNS.normalize()
}

func (s Scheduler) RuntimeSettings() scheduler.Settings {
	return scheduler.Settings{
		MaxConcurrent: s.MaxConcurrentTasks,
		PollInterval:  time.Duration(s.PollIntervalSeconds * float64(time.Second)),
		ShutdownGrace: time.Duration(s.ShutdownGraceSeconds * float64(time.Second)),
		RetryJitter:   s.RetryJitterSeconds, RetryBackoffCap: s.RetryBackoffCapSeconds,
	}
}
