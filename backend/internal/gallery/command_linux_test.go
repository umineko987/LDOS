package gallery

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

func newTestRunner(t *testing.T) (*Runner, Request) {
	t.Helper()
	root := t.TempDir()
	repo := filepath.Join(root, "gallery-source")
	if err := os.MkdirAll(filepath.Join(repo, "gallery_dl"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "gallery_dl", "__init__.py"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	executors := filepath.Join(root, "executors")
	if err := os.MkdirAll(filepath.Join(executors, "ldos_gallery"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(executors, "ldos_gallery", "worker_entry.py"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(root, "output")
	if err := os.MkdirAll(output, 0o755); err != nil {
		t.Fatal(err)
	}
	helper, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("LDOS_GALLERY_HELPER", "1")
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	runner, err := New(Settings{RepoPath: repo, CacheFile: filepath.Join(root, "cache.sqlite3"),
		PythonExecutable: helper, TerminateGrace: 200 * time.Millisecond, MaxLogLineChars: 120}, executors)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runner.StopAll)
	return runner, Request{ID: "test", URL: "helper:exit", OutputDir: output, HTTPTimeout: 3 * time.Second}
}

func TestCommandAndManagedAbbreviations(t *testing.T) {
	runner, req := newTestRunner(t)
	for _, option := range []string{"--proxy=http://elsewhere", "--exec-afte", "--optio=x=y", "--config-j",
		"--cache-f=x", "--coo", "--user", "--dest", "--ignore-conf", "--exec-after-extra", "-psecret", "-d/tmp", "-ofoo"} {
		if _, err := runner.ValidateArgs([]string{option}); err == nil {
			t.Errorf("accepted managed option %q", option)
		}
	}
	req.URL, req.CookiesFile = "twitter:https://mobile.x.com/name/status/1", "cookies.txt"
	req.ProxyURL, req.ExtraArgs = "http://127.0.0.1:1234", []string{"--sleep", "0", "--range", "1"}
	for extension, flag := range map[string]string{".YAML": "--config-yaml", ".yml": "--config-yaml",
		".toml": "--config-toml", ".json": "--config-json", ".conf": "--config"} {
		req.ConfigFile = "settings" + extension
		command, err := runner.BuildCommand("marker", req)
		if err != nil {
			t.Fatal(err)
		}
		want := []string{runner.settings.PythonExecutable, "-m", workerModule, "--marker", "marker",
			"--gallery-root", runner.settings.RepoPath, "--", "--config-ignore", "--cache-file", runner.settings.CacheFile,
			"--no-colors", "--no-input", "--destination", req.OutputDir, "--http-timeout", "3.0", "--retries", "0",
			flag, req.ConfigFile, "--cookies", req.CookiesFile, "--proxy", req.ProxyURL, "--sleep", "0", "--range", "1",
			"--option", "extractor.twitter.cookies-update=false", req.URL}
		if !reflect.DeepEqual(command, want) {
			t.Fatalf("command mismatch\ngot  %q\nwant %q", command, want)
		}
	}
	req.URL, req.Site, req.EHDownload = "https://e-hentai.org/g/1/a/", "exhentai", &EHDownloadOptions{}
	command, err := runner.BuildCommand("eh", req)
	if err != nil || !slices.Contains(command, "extractor.exhentai.original=true") || !slices.Contains(command, "extractor.exhentai.gp=stop") {
		t.Fatalf("original EH options: %q, %v", command, err)
	}
	req.EHDownload.ImageMode, req.EHDownload.GPPolicy = "resample", "resized"
	command, err = runner.BuildCommand("eh", req)
	if err != nil || !slices.Contains(command, "extractor.exhentai.original=false") || strings.Contains(strings.Join(command, " "), "extractor.exhentai.gp=") {
		t.Fatalf("resampled EH options: %q, %v", command, err)
	}
	if slices.Contains(command, "extractor.twitter.cookies-update=false") || slices.Contains(command, "--no-part") {
		t.Fatal("unrelated or resume-breaking option")
	}
}

func TestCredentialEnvironment(t *testing.T) {
	runner, req := newTestRunner(t)
	t.Setenv("PYTHONPATH", "inherited-python-path")
	t.Setenv("GDL_WORKER_USERNAME", "stale-user")
	t.Setenv("GDL_WORKER_PASSWORD", "stale-password")
	t.Setenv("GDL_ACTIVITY_FILE", "stale-heartbeat")
	t.Setenv("GDL_ACTIVITY_STARTED_FILE", "stale-started")
	t.Setenv("GDL_CREDENTIAL_PROFILE_NAME__USERNAME", "resolved-user")
	t.Setenv("GDL_CREDENTIAL_PROFILE_NAME__PASSWORD", "resolved-password")
	req.CredentialsRef = "profile-name/"
	p, err := runner.prepare(req, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	env := environment(p.cmd.Env)
	if env["GDL_WORKER_USERNAME"] != "resolved-user" || env["GDL_WORKER_PASSWORD"] != "resolved-password" {
		t.Fatal("credentials not mapped")
	}
	if strings.Contains(strings.Join(p.cmd.Args, " "), "resolved-") {
		t.Fatal("credentials leaked into argv")
	}
	if env["PYTHONPATH"] != runner.executorsRoot+":"+runner.settings.RepoPath ||
		env["PYTHONNOUSERSITE"] != "1" || env["PYTHONSAFEPATH"] != "1" || env["PYTHONDONTWRITEBYTECODE"] != "1" ||
		env["PYTHONUNBUFFERED"] != "1" || env["PYTHONIOENCODING"] != "utf-8" || p.cmd.Dir != runner.settings.RepoPath {
		t.Fatal("incorrect worker runtime environment")
	}
	if env["GDL_ACTIVITY_FILE"] != filepath.Join(req.OutputDir, ".gdl-activity-"+p.marker) || env["GDL_ACTIVITY_STARTED_FILE"] != p.activity+".started" {
		t.Fatal("incorrect heartbeat paths")
	}
	req.CredentialsRef = ""
	p, err = runner.prepare(req, 0)
	if err != nil {
		t.Fatal(err)
	}
	env = environment(p.cmd.Env)
	for _, key := range []string{"GDL_WORKER_USERNAME", "GDL_WORKER_PASSWORD", "GDL_ACTIVITY_FILE", "GDL_ACTIVITY_STARTED_FILE"} {
		if env[key] != "" {
			t.Errorf("inherited worker state leaked: %s", key)
		}
	}
	req.CredentialsRef = "deliberately-missing-profile"
	if _, err := runner.prepare(req, 0); err == nil {
		t.Fatal("missing credentials accepted")
	}
}

func environment(values []string) map[string]string {
	result := make(map[string]string)
	for _, pair := range values {
		key, value, _ := strings.Cut(pair, "=")
		result[key] = value
	}
	return result
}
