package config

import (
	"errors"
	"math"
	"path/filepath"
	"strings"
	"time"
)

type Dedup struct {
	Enabled              bool    `json:"enabled"`
	PythonExecutable     string  `json:"python_executable"`
	WorkerScript         string  `json:"worker_script"`
	CoreScript           string  `json:"core_script"`
	AtlasScript          string  `json:"atlas_script"`
	ModelDir             string  `json:"model_dir"`
	Device               string  `json:"device"`
	Workers              int     `json:"workers"`
	TorchThreads         int     `json:"torch_threads"`
	TorchInteropThreads  int     `json:"torch_interop_threads"`
	DeepBatchSize        int     `json:"deep_batch_size"`
	NeighborBlockSize    int     `json:"neighbor_block_size"`
	PollIntervalSeconds  float64 `json:"poll_interval_seconds"`
	ShutdownGraceSeconds float64 `json:"shutdown_grace_seconds"`
	NoSSCD               bool    `json:"no_sscd"`
	NoDINO               bool    `json:"no_dino"`
}

type Tagger struct {
	Enabled              bool    `json:"enabled"`
	PythonExecutable     string  `json:"python_executable"`
	CLIScript            string  `json:"cli_script"`
	ModelDir             string  `json:"model_dir"`
	CachePath            string  `json:"cache_path"`
	ShutdownGraceSeconds float64 `json:"shutdown_grace_seconds"`
}

func (s *Settings) modelDefaults() {
	s.Dedup = Dedup{Enabled: true, Device: "auto", PollIntervalSeconds: 1, ShutdownGraceSeconds: 10}
	s.Tagger = Tagger{Enabled: true, ShutdownGraceSeconds: 10}
}

func (s *Settings) modelPaths(base string) {
	s.WorkspaceDir = resolve(base, s.WorkspaceDir, filepath.Dir(s.ProjectDir))
	python := filepath.Join(s.WorkspaceDir, ".venv", "bin", "python")
	s.Dedup.PythonExecutable = modelExecutable(base, s.Dedup.PythonExecutable, python)
	s.Tagger.PythonExecutable = modelExecutable(base, s.Tagger.PythonExecutable, python)
	s.Dedup.WorkerScript = resolve(base, s.Dedup.WorkerScript, filepath.Join(s.WorkspaceDir, "dedup", "dedup_review_worker.py"))
	s.Dedup.CoreScript = resolve(base, s.Dedup.CoreScript, filepath.Join(s.WorkspaceDir, "dedup", "dedup_core.py"))
	s.Dedup.AtlasScript = resolve(base, s.Dedup.AtlasScript, filepath.Join(s.WorkspaceDir, "dedup", "atlas_worker.py"))
	s.Dedup.ModelDir = resolve(base, s.Dedup.ModelDir, filepath.Join(s.WorkspaceDir, ".models"))
	s.Tagger.CLIScript = resolve(base, s.Tagger.CLIScript, filepath.Join(s.WorkspaceDir, "tagger", "cli.py"))
	s.Tagger.ModelDir = resolve(base, s.Tagger.ModelDir, filepath.Join(s.WorkspaceDir, "tagger", ".models"))
	s.Tagger.CachePath = resolve(base, s.Tagger.CachePath, filepath.Join(s.WorkspaceDir, "tagger", "tags.sqlite3"))
}

func modelExecutable(base, value, fallback string) string {
	if value == "" {
		return fallback
	}
	value = expandPath(value)
	if !strings.ContainsRune(value, '/') {
		return value
	}
	return resolve(base, value, fallback)
}

func (s *Settings) normalizeModels() error {
	s.Dedup.Device = strings.ToLower(strings.TrimSpace(s.Dedup.Device))
	if s.Dedup.Device != "auto" && s.Dedup.Device != "cpu" && s.Dedup.Device != "cuda" {
		return errors.New("dedup.device must be auto, cpu or cuda")
	}
	for _, item := range []struct {
		value   *int
		maximum int
	}{{&s.Dedup.Workers, 64}, {&s.Dedup.TorchThreads, 128}, {&s.Dedup.TorchInteropThreads, 16}, {&s.Dedup.DeepBatchSize, 128}, {&s.Dedup.NeighborBlockSize, 8192}} {
		*item.value = max(0, *item.value)
		if *item.value > item.maximum {
			return errors.New("dedup resource limit out of range")
		}
	}
	for _, value := range []*float64{&s.Dedup.PollIntervalSeconds, &s.Dedup.ShutdownGraceSeconds, &s.Tagger.ShutdownGraceSeconds} {
		if math.IsNaN(*value) || math.IsInf(*value, 0) || math.Abs(*value) >= float64(math.MaxInt64)/float64(time.Second) {
			return errors.New("model execution duration out of range")
		}
	}
	s.Dedup.PollIntervalSeconds = max(.1, s.Dedup.PollIntervalSeconds)
	s.Dedup.ShutdownGraceSeconds = max(1, s.Dedup.ShutdownGraceSeconds)
	s.Tagger.ShutdownGraceSeconds = max(1, s.Tagger.ShutdownGraceSeconds)
	return nil
}

// Distribution paths come from the owning desktop supervisor, never a stale
// configuration copied from another installation. User choices remain in JSON.
func (s *Settings) applyDesktopPaths(getenv func(string) string) error {
	resource, data, python := getenv("LDOS_DESKTOP_RESOURCE_ROOT"), getenv("LDOS_DESKTOP_DATA_ROOT"), getenv("LDOS_DESKTOP_PYTHON")
	if resource == "" && data == "" && python == "" {
		return nil
	}
	if !filepath.IsAbs(resource) || !filepath.IsAbs(data) || !filepath.IsAbs(python) {
		return errors.New("desktop distribution paths must all be absolute")
	}
	resource, data, python = filepath.Clean(resource), filepath.Clean(data), filepath.Clean(python)
	if python != filepath.Join(resource, "runtime", "python", "bin", "python3.13") {
		return errors.New("desktop executors must use the bundled Python runtime")
	}
	app := filepath.Join(resource, "app")
	s.ProjectDir, s.WorkspaceDir = app, app
	s.RuntimeDir = filepath.Join(data, "runtime")
	s.DatabasePath = filepath.Join(s.RuntimeDir, "backend.sqlite3")
	s.DefaultOutputRoot = filepath.Join(data, "downloads")
	s.AllowedOutputRoots = []string{s.DefaultOutputRoot}
	s.AllowedConfigRoots = []string{filepath.Join(data, "credentials")}
	s.AllowedCookieRoots = []string{filepath.Join(data, "credentials")}
	s.Gallery.RepoPath = filepath.Join(app, "gallery-dl-codeberg")
	s.Gallery.CacheFile = filepath.Join(data, "credentials", "managed", "gallery-dl-cache.sqlite3")
	s.Gallery.PythonExecutable, s.Gallery.MigrateDefaultAuth = python, false
	s.Proxy.AllowedNodeRoots = []string{filepath.Join(data, "subscriptions")}
	s.Dedup.PythonExecutable = python
	s.Dedup.WorkerScript = filepath.Join(app, "dedup_review_worker.py")
	s.Dedup.CoreScript = filepath.Join(app, "dedup_core.py")
	s.Dedup.AtlasScript = filepath.Join(app, "atlas_worker.py")
	s.Dedup.ModelDir = filepath.Join(data, "models")
	s.Tagger.PythonExecutable = python
	s.Tagger.CLIScript = filepath.Join(app, "tagger", "cli.py")
	s.Tagger.ModelDir = filepath.Join(data, "tagger", "models")
	s.Tagger.CachePath = filepath.Join(data, "tagger", "tags.sqlite3")
	return nil
}
