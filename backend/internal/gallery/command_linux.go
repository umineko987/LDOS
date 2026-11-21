// Package gallery owns Linux gallery-dl subprocess orchestration. Python is used
// only as the temporary gallery-dl library executor, never as a business service.
package gallery

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"ldos/backend/internal/danboorurate"
)

const workerModule = "ldos_gallery.worker_entry"
const DefaultMaxOutputBytes int64 = 64 * 1024 * 1024

var ErrCaptureLimit = errors.New("gallery-dl metadata output limit exceeded")

// Settings is deliberately independent of the backend's configuration package.
// New defaults an empty PythonExecutable to python3, zero TerminateGrace to five
// seconds, zero MaxLogLineChars to 4000, and nil ForbiddenArgs to managed options.
type Settings struct {
	RepoPath         string
	CacheFile        string
	PythonExecutable string
	TerminateGrace   time.Duration
	MaxLogLineChars  int
	ForbiddenArgs    []string
}

type EHDownloadOptions struct {
	ImageMode string // original (default) or resample
	GPPolicy  string // stop (default) or resized
}

// Request carries already-resolved paths and policies from the caller. Zero
// TaskTimeout disables the overall timer; zero GalleryRetries means no retries.
// Callbacks run synchronously and must return promptly. OnStarted runs exactly
// once after registration; an error terminates and reaps the worker before return.
type Request struct {
	resolve        bool   // internal metadata lookup, never a download CLI invocation
	resolveInput   []byte // non-nil for a batch; sent over stdin, not argv
	ID             string
	URL            string
	OutputDir      string
	ProxyURL       string
	CookiesFile    string
	ConfigFile     string
	CredentialsRef string
	Site           string
	HTTPTimeout    time.Duration
	TaskTimeout    time.Duration
	GalleryRetries int
	ExtraArgs      []string
	EHDownload     *EHDownloadOptions
	OnStarted      func(pid int, marker string) error
}

type RunRequest struct {
	Request
	StallTimeout time.Duration
	// Calls are serialized across streams. Errors are ignored to keep draining.
	OnLine func(stream, line string) error
}

type CaptureRequest struct {
	Request
	MaxOutputBytes int64 // combined stdout/stderr budget; zero uses 64 MiB
}

type ProcessResult struct {
	ExitCode int // Python-compatible negative signal number; -1 before start
	PID      int
	Marker   string
	TimedOut bool // task/stall timeout, not caller context cancellation
}

type RunResult struct {
	ProcessResult
	OutputTail string
}

type CaptureResult struct {
	ProcessResult
	Stdout string // protocol output; only literal resolved credentials are redacted
	Stderr string // full diagnostic redaction
}

type Runner struct {
	settings      Settings
	executorsRoot string
	mu            sync.Mutex
	active        map[string]*activeProcess
}

type activeProcess struct {
	cancel context.CancelFunc
	done   chan struct{}
}

func New(settings Settings, executorsRoot string) (*Runner, error) {
	if settings.RepoPath == "" || settings.CacheFile == "" {
		return nil, errors.New("gallery RepoPath and CacheFile are required")
	}
	if executorsRoot == "" {
		return nil, errors.New("gallery executors root is required")
	}
	if info, err := os.Stat(filepath.Join(executorsRoot, "ldos_gallery", "worker_entry.py")); err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("gallery executor package not found: %s", executorsRoot)
	}
	var err error
	for _, path := range []*string{&settings.RepoPath, &settings.CacheFile, &executorsRoot} {
		*path, err = filepath.Abs(*path)
		if err != nil {
			return nil, err
		}
	}
	if settings.PythonExecutable == "" {
		settings.PythonExecutable = "python3"
	}
	if settings.TerminateGrace == 0 {
		settings.TerminateGrace = 5 * time.Second
	}
	if settings.MaxLogLineChars == 0 {
		settings.MaxLogLineChars = 4000
	}
	if settings.TerminateGrace < 0 || settings.MaxLogLineChars < 0 {
		return nil, errors.New("gallery grace and log line limit must not be negative")
	}
	if settings.ForbiddenArgs == nil {
		settings.ForbiddenArgs = []string{
			"--proxy", "--destination", "--directory", "--config-ignore",
			"--ignore-config", "--server", "--write-log", "--input-file",
			"--exec", "--exec-after", "--option", "--config", "--config-json",
			"--config-yaml", "--config-toml", "--cookies", "--cookies-export",
			"--cookies-from-browser", "--cache-file", "--username", "--password",
			"-d", "-D", "-S", "-o", "-c", "-C", "-u", "-p",
		}
	} else {
		settings.ForbiddenArgs = append([]string(nil), settings.ForbiddenArgs...)
	}
	return &Runner{settings: settings, executorsRoot: executorsRoot, active: make(map[string]*activeProcess)}, nil
}

// DanbooruRatePath is shared by native discovery and every gallery-dl worker.
func (r *Runner) DanbooruRatePath() string {
	return filepath.Join(filepath.Dir(r.settings.CacheFile), danboorurate.FileName)
}

// ValidateArgs blocks argparse abbreviations as well as exact managed flags and
// attached short-option values. It returns a copy, never mutating the request.
func (r *Runner) ValidateArgs(args []string) ([]string, error) {
	for _, arg := range args {
		token, _, _ := strings.Cut(arg, "=")
		for _, forbidden := range r.settings.ForbiddenArgs {
			long := strings.HasPrefix(forbidden, "--")
			if strings.HasPrefix(token, "--") && len(token) > 2 {
				if long && (strings.HasPrefix(token, forbidden) || strings.HasPrefix(forbidden, token)) {
					return nil, fmt.Errorf("gallery-dl 参数由后端管理: %s", forbidden)
				}
			} else if !long && strings.HasPrefix(arg, forbidden) {
				return nil, fmt.Errorf("gallery-dl 参数由后端管理: %s", forbidden)
			}
		}
	}
	return append([]string(nil), args...), nil
}

// BuildCommand returns argv including the interpreter. Credentials remain in the
// environment and are never placed in the command visible through /proc.
func (r *Runner) BuildCommand(marker string, req Request) ([]string, error) {
	if req.resolve {
		if req.resolveInput != nil {
			return []string{r.settings.PythonExecutable, "-m", workerModule, "--marker", marker,
				"--gallery-root", r.settings.RepoPath, "--resolve-batch", "--"}, nil
		}
		return []string{r.settings.PythonExecutable, "-m", workerModule, "--marker", marker,
			"--gallery-root", r.settings.RepoPath, "--resolve", "--", req.URL}, nil
	}
	extra, err := r.ValidateArgs(req.ExtraArgs)
	if err != nil {
		return nil, err
	}
	timeout := strconv.FormatFloat(req.HTTPTimeout.Seconds(), 'f', -1, 64)
	if !strings.Contains(timeout, ".") {
		timeout += ".0"
	}
	command := []string{r.settings.PythonExecutable, "-m", workerModule, "--marker", marker,
		"--gallery-root", r.settings.RepoPath, "--", "--config-ignore",
		"--cache-file", r.settings.CacheFile, "--no-colors", "--no-input",
		"--destination", req.OutputDir, "--http-timeout", timeout,
		"--retries", strconv.Itoa(req.GalleryRetries)}
	if req.ConfigFile != "" {
		flag := "--config"
		switch strings.ToLower(filepath.Ext(req.ConfigFile)) {
		case ".yaml", ".yml":
			flag = "--config-yaml"
		case ".toml":
			flag = "--config-toml"
		case ".json":
			flag = "--config-json"
		}
		command = append(command, flag, req.ConfigFile)
	}
	if req.CookiesFile != "" {
		command = append(command, "--cookies", req.CookiesFile)
	}
	if req.ProxyURL != "" {
		command = append(command, "--proxy", req.ProxyURL)
	}
	command = append(command, extra...)
	if req.Site == "exhentai" && req.EHDownload != nil {
		mode, policy := req.EHDownload.ImageMode, req.EHDownload.GPPolicy
		if mode == "" {
			mode = "original"
		}
		if policy == "" {
			policy = "stop"
		}
		if (mode != "original" && mode != "resample") || (policy != "stop" && policy != "resized") {
			return nil, errors.New("invalid EH image mode or GP policy")
		}
		command = append(command, "--option", "extractor.exhentai.original="+strconv.FormatBool(mode == "original"))
		if mode == "original" {
			command = append(command, "--option", "extractor.exhentai.gp="+policy)
		}
	}
	if req.CookiesFile != "" && isTwitterWebURL(req.URL) {
		command = append(command, "--option", "extractor.twitter.cookies-update=false")
	}
	return append(command, req.URL), nil
}

func isTwitterWebURL(value string) bool {
	lower := strings.ToLower(value)
	position := len(value)
	for _, scheme := range []string{"http://", "https://"} {
		if index := strings.Index(lower, scheme); index >= 0 && index < position {
			position = index
		}
	}
	if position < len(value) {
		value = value[position:]
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com":
		return true
	}
	return false
}

type preparedProcess struct {
	cmd      *exec.Cmd
	marker   string
	activity string
	started  string
	secrets  []string
}

func (r *Runner) prepare(req Request, stall time.Duration) (*preparedProcess, error) {
	info, err := os.Stat(filepath.Join(r.settings.RepoPath, "gallery_dl", "__init__.py"))
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("gallery-dl 源码目录无效: %s", r.settings.RepoPath)
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	p := &preparedProcess{marker: req.ID + "-" + hex.EncodeToString(nonce[:])}
	command, err := r.BuildCommand(p.marker, req)
	if err != nil {
		return nil, err
	}
	env := make(map[string]string)
	for _, item := range os.Environ() {
		key, value, _ := strings.Cut(item, "=")
		env[key] = value
	}
	if req.CredentialsRef != "" {
		key := strings.Map(func(char rune) rune {
			switch {
			case char >= 'a' && char <= 'z':
				return char - 'a' + 'A'
			case char >= 'A' && char <= 'Z', char >= '0' && char <= '9':
				return char
			default:
				return '_'
			}
		}, req.CredentialsRef)
		prefix := "GDL_CREDENTIAL_" + key + "_"
		p.secrets = []string{env[prefix+"USERNAME"], env[prefix+"PASSWORD"]}
		if p.secrets[0] == "" && p.secrets[1] == "" {
			return nil, fmt.Errorf("credentials_ref 未配置对应环境变量: %s", req.CredentialsRef)
		}
	}
	// Never let a previous worker's credentials or heartbeat paths leak into this job.
	delete(env, "GDL_WORKER_USERNAME")
	delete(env, "GDL_WORKER_PASSWORD")
	if len(p.secrets) != 0 {
		env["GDL_WORKER_USERNAME"], env["GDL_WORKER_PASSWORD"] = p.secrets[0], p.secrets[1]
	}
	if stall > 0 {
		output, err := filepath.Abs(req.OutputDir)
		if err != nil {
			return nil, err
		}
		p.activity = filepath.Join(output, ".gdl-activity-"+p.marker)
		p.started = p.activity + ".started"
	}
	env[danboorurate.Environment] = r.DanbooruRatePath()
	env["GDL_ACTIVITY_FILE"], env["GDL_ACTIVITY_STARTED_FILE"] = p.activity, p.started
	env["PYTHONUNBUFFERED"], env["PYTHONIOENCODING"] = "1", "utf-8"
	// Never import the legacy business package or an inherited user-site module.
	env["PYTHONPATH"] = r.executorsRoot + string(os.PathListSeparator) + r.settings.RepoPath
	env["PYTHONNOUSERSITE"], env["PYTHONSAFEPATH"] = "1", "1"
	env["PYTHONDONTWRITEBYTECODE"] = "1"
	p.cmd = exec.Command(command[0], command[1:]...)
	if req.resolveInput != nil {
		p.cmd.Stdin = bytes.NewReader(req.resolveInput)
	}
	p.cmd.Dir = r.settings.RepoPath
	p.cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	for key, value := range env {
		p.cmd.Env = append(p.cmd.Env, key+"="+value)
	}
	return p, nil
}
