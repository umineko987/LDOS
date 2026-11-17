package gallery

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

const resolvedJSON = `{"site":"twitter","subcategory":"tweet","extractor":"TwitterTweetExtractor","supported":true,"host":"x.com"}`

func runResolveHelper(mode string) bool {
	if len(os.Args) != 10 || os.Args[2] != "ldos_gallery.worker_entry" || os.Args[3] != "--marker" ||
		os.Args[5] != "--gallery-root" || os.Args[7] != "--resolve" || os.Args[8] != "--" {
		panic("unexpected resolve protocol arguments")
	}
	if dir := os.Getenv("LDOS_HELPER_DIRECTORY"); dir != "" {
		if err := os.WriteFile(filepath.Join(dir, "worker.pid"), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
			panic(err)
		}
	}
	switch mode {
	case "helper:resolved":
		fmt.Println(resolvedJSON)
	case "helper:unsupported":
		fmt.Println(`{"site":"unknown","subcategory":"","extractor":"","supported":false,"host":""}`)
	case "helper:resolve-limit", "helper:resolve-limit-exit":
		fmt.Print(strings.Repeat("x", int(MaxResolveOutputBytes/2)+1))
		fmt.Fprint(os.Stderr, strings.Repeat("y", int(MaxResolveOutputBytes/2)+1))
		if mode == "helper:resolve-limit" {
			time.Sleep(time.Minute)
		}
	case "helper:resolve-invalid":
		fmt.Println(`{"site":"twitter"}`)
	case "helper:resolve-failure":
		fmt.Fprintln(os.Stderr, "token=secret-diagnostic")
		os.Exit(7)
	default:
		return false // Existing hang/tree/orphan helper exercises the same supervisor.
	}
	return true
}

func TestResolveCommandAndExecutorRoot(t *testing.T) {
	runner, _ := newTestRunner(t)
	if workerModule != "ldos_gallery.worker_entry" {
		t.Fatal("legacy business module is still enabled")
	}
	url := "--dump-json" // URL stays after the control separator; never becomes a CLI option.
	got, err := runner.BuildCommand("marker", Request{URL: url, resolve: true})
	want := []string{runner.settings.PythonExecutable, "-m", "ldos_gallery.worker_entry",
		"--marker", "marker", "--gallery-root", runner.settings.RepoPath, "--resolve", "--", url}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("resolve command = %q, %v", got, err)
	}
	legacy := t.TempDir()
	if err := os.Mkdir(filepath.Join(legacy, "gdl_backend"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "gdl_backend", "worker_entry.py"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{"", legacy} {
		if _, err := New(runner.settings, root); err == nil {
			t.Fatalf("accepted missing or legacy executor root %q", root)
		}
	}
}

func TestResolveProtocolAndFailures(t *testing.T) {
	runner, req := newTestRunner(t)
	t.Setenv("LDOS_HELPER_DIRECTORY", req.OutputDir)
	info, err := runner.Resolve(context.Background(), "helper:resolved")
	want := SiteInfo{Site: "twitter", Subcategory: "tweet", Extractor: "TwitterTweetExtractor", Supported: true, Host: "x.com"}
	if err != nil || info != want {
		t.Fatalf("resolve = %+v, %v", info, err)
	}
	assertReaped(t, resolveWorkerPID(t, req.OutputDir))
	info, err = runner.Resolve(context.Background(), "helper:unsupported")
	if err != nil || info != (SiteInfo{Site: "unknown"}) {
		t.Fatalf("unsupported = %+v, %v", info, err)
	}
	for _, mode := range []string{"helper:resolve-invalid", "helper:resolve-failure", "helper:resolve-limit", "helper:resolve-limit-exit"} {
		info, err = runner.Resolve(context.Background(), mode)
		if err == nil || info != (SiteInfo{}) || strings.Contains(err.Error(), "secret-diagnostic") {
			t.Fatalf("%s = %+v, %v", mode, info, err)
		}
		if strings.Contains(mode, "limit") && !errors.Is(err, ErrCaptureLimit) {
			t.Fatalf("missing capture limit: %v", err)
		}
		assertReaped(t, resolveWorkerPID(t, req.OutputDir))
	}
	if runner.ActiveCount() != 0 {
		t.Fatal("resolve leaked registry entry")
	}
	if _, err := os.Stat(runner.settings.CacheFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("resolve touched the cache: %v", err)
	}
}

func TestResolveRejectsMalformedProtocol(t *testing.T) {
	for _, value := range []string{
		"", "null", "[]", "{}", "log line\n" + resolvedJSON, resolvedJSON + "{}", resolvedJSON + " trailing",
		strings.Replace(resolvedJSON, `"supported":true`, `"supported":null`, 1),
		strings.Replace(resolvedJSON, `"supported":true`, `"supported":"true"`, 1),
		strings.Replace(resolvedJSON, `"site":"twitter"`, `"site":""`, 1),
		strings.Replace(resolvedJSON, `"host":`, `"extra":`, 1),
	} {
		if _, err := parseSiteInfo(value); err == nil {
			t.Errorf("accepted invalid protocol %q", value)
		}
	}
}

func TestResolveContextAndGroupCleanup(t *testing.T) {
	for _, mode := range []string{"helper:tree", "helper:orphan"} {
		t.Run(mode, func(t *testing.T) {
			runner, req := newTestRunner(t)
			t.Setenv("LDOS_HELPER_DIRECTORY", req.OutputDir)
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := runner.Resolve(ctx, mode); done <- err }()
			child := waitChild(t, req.OutputDir)
			if mode == "helper:tree" {
				cancel()
			}
			err := <-done
			if err == nil || (mode == "helper:tree" && !errors.Is(err, context.Canceled)) {
				t.Fatalf("resolve cleanup error: %v", err)
			}
			assertReaped(t, resolveWorkerPID(t, req.OutputDir))
			assertNotRunning(t, child)
			if runner.ActiveCount() != 0 {
				t.Fatal("resolve still active after cleanup")
			}
		})
	}
}

func TestResolveDeadlineAndAlreadyCanceled(t *testing.T) {
	runner, req := newTestRunner(t)
	t.Setenv("LDOS_HELPER_DIRECTORY", req.OutputDir)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runner.Resolve(ctx, "helper:hang"); !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-canceled resolve: %v", err)
	}
	if _, err := os.Stat(filepath.Join(req.OutputDir, "worker.pid")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("pre-canceled resolve started a worker")
	}
	for _, duration := range []time.Duration{300 * time.Millisecond, 0} {
		ctx := context.Background()
		cancel := func() {}
		if duration > 0 {
			ctx, cancel = context.WithTimeout(ctx, duration)
		}
		started := time.Now()
		_, err := runner.Resolve(ctx, "helper:hang")
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > ResolveTimeout+2*time.Second {
			t.Fatalf("bounded deadline: %v after %s", err, time.Since(started))
		}
		assertReaped(t, resolveWorkerPID(t, req.OutputDir))
	}
}

func TestResolveConcurrentStopAll(t *testing.T) {
	runner, _ := newTestRunner(t)
	done := make(chan error, 2)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	for i := 0; i < 2; i++ {
		go func() { _, err := runner.Resolve(ctx, "helper:hang"); done <- err }()
	}
	deadline := time.Now().Add(2 * time.Second)
	for runner.ActiveCount() != 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if runner.ActiveCount() != 2 {
		t.Fatal("concurrent resolves did not register independently")
	}
	runner.StopAll()
	for i := 0; i < 2; i++ {
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("StopAll resolve: %v", err)
		}
	}
	if runner.ActiveCount() != 0 {
		t.Fatal("StopAll left resolve registered")
	}
}

func resolveWorkerPID(t *testing.T, directory string) int {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(directory, "worker.pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(string(data))
	if err != nil {
		t.Fatal(err)
	}
	return pid
}
