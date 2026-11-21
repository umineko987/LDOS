package gallery

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The Go test executable doubles as a fake interpreter. It never imports Python
// or gallery-dl and uses only the temporary directory and inherited pipes.
func TestMain(m *testing.M) {
	if os.Getenv("LDOS_GALLERY_HELPER") == "1" && len(os.Args) > 1 && os.Args[1] == "-m" {
		runHelper()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func runHelper() {
	mode := os.Args[len(os.Args)-1]
	for _, arg := range os.Args {
		if arg == "--resolve-batch" {
			runBatchResolveHelper()
			return
		}
		if arg == "--resolve" && runResolveHelper(mode) {
			return
		}
	}
	touch := func(path string) {
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			panic(err)
		}
	}
	switch mode {
	case "helper:logs":
		for i := 0; i < 260; i++ {
			fmt.Printf("line-%03d\n", i)
		}
		fmt.Println(strings.Repeat("oversized-secret", 150000))
		fmt.Printf("%s %s token=log-secret https://user:pass@example.invalid/?code=hidden\n", os.Getenv("GDL_WORKER_USERNAME"), os.Getenv("GDL_WORKER_PASSWORD"))
		fmt.Fprintln(os.Stderr, "Authorization: Bearer diagnostic-secret")
		fmt.Println(strings.Repeat("长", 200))
		fmt.Print("last-line")
	case "helper:capture":
		fmt.Printf("{\"url\":\"https://example.invalid/?token=keep-protocol\",\"name\":\"%s\"}\n", os.Getenv("GDL_WORKER_USERNAME"))
		fmt.Fprintln(os.Stderr, "cookie=session-secret")
	case "helper:limit":
		fmt.Print(strings.Repeat("x", 60))
		fmt.Fprint(os.Stderr, strings.Repeat("y", 60))
		time.Sleep(time.Minute)
	case "helper:limit-exit":
		fmt.Print(strings.Repeat("x", 200))
	case "helper:hang":
		if ready := os.Getenv("LDOS_HELPER_READY"); ready != "" {
			touch(ready)
		}
		time.Sleep(time.Minute)
	case "helper:extracting":
		time.Sleep(900 * time.Millisecond) // no started marker: not a transfer stall
	case "helper:stall":
		touch(os.Getenv("GDL_ACTIVITY_STARTED_FILE"))
		touch(os.Getenv("GDL_ACTIVITY_FILE"))
		time.Sleep(time.Minute)
	case "helper:heartbeat":
		touch(os.Getenv("GDL_ACTIVITY_STARTED_FILE"))
		for i := 0; i < 10; i++ {
			touch(os.Getenv("GDL_ACTIVITY_FILE"))
			time.Sleep(100 * time.Millisecond)
		}
	case "helper:child":
		signal.Ignore(syscall.SIGTERM)
		touch(os.Getenv("LDOS_HELPER_CHILD_READY"))
		time.Sleep(time.Minute)
	case "helper:tree", "helper:orphan":
		destination := os.Getenv("LDOS_HELPER_DIRECTORY")
		for i, value := range os.Args {
			if value == "--destination" {
				destination = os.Args[i+1]
			}
		}
		ready := filepath.Join(destination, "child.ready")
		child := exec.Command(os.Args[0], "-m", workerModule, "helper:child")
		child.Env = append(os.Environ(), "LDOS_HELPER_CHILD_READY="+ready)
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			panic(err)
		}
		for {
			if _, err := os.Stat(ready); err == nil {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		if err := os.WriteFile(filepath.Join(destination, "child.pid"), []byte(strconv.Itoa(child.Process.Pid)), 0o600); err != nil {
			panic(err)
		}
		if mode == "helper:tree" {
			time.Sleep(time.Minute)
		}
	case "helper:failure":
		os.Exit(7)
	case "helper:exit":
	default:
		panic("unknown helper mode: " + mode)
	}
}

func TestStreamingLogsDrainAndRedact(t *testing.T) {
	runner, req := newTestRunner(t)
	t.Setenv("GDL_CREDENTIAL_TEST_USERNAME", "credential-user")
	t.Setenv("GDL_CREDENTIAL_TEST_PASSWORD", "credential-pass")
	req.URL, req.CredentialsRef = "helper:logs", "test"
	var lines []string
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := runner.Run(ctx, RunRequest{Request: req, OnLine: func(stream, line string) error {
		lines = append(lines, line)
		if len([]rune(line)) > runner.settings.MaxLogLineChars {
			t.Errorf("line too long: %d", len([]rune(line)))
		}
		return errors.New("ignored logging failure")
	}})
	if err != nil || result.ExitCode != 0 || result.TimedOut {
		t.Fatalf("run = %+v, %v", result, err)
	}
	if len(lines) != 264 || len(strings.Split(result.OutputTail, "\n")) != tailLines {
		t.Fatalf("unexpected line or tail count: %d", len(lines))
	}
	combined := result.OutputTail + strings.Join(lines, "\n")
	for _, secret := range []string{"credential-user", "credential-pass", "log-secret", "diagnostic-secret", "user:pass", "code=hidden", "oversized-secret"} {
		if strings.Contains(combined, secret) {
			t.Errorf("unredacted secret %q", secret)
		}
	}
	if strings.Contains(result.OutputTail, "line-000") || !strings.Contains(result.OutputTail, oversizedLine) || !strings.Contains(result.OutputTail, "last-line") {
		t.Fatal("tail did not preserve post-huge-line output")
	}
	assertReaped(t, result.PID)
}

func TestCaptureProtocolAndCombinedLimit(t *testing.T) {
	runner, req := newTestRunner(t)
	t.Setenv("GDL_CREDENTIAL_TEST_USERNAME", "credential-user")
	req.URL, req.CredentialsRef = "helper:capture", "test"
	req.OutputDir = filepath.Join(req.OutputDir, "created-by-capture")
	result, err := runner.Capture(context.Background(), CaptureRequest{Request: req})
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("capture: %+v, %v", result, err)
	}
	if result.Stdout != "{\"url\":\"https://example.invalid/?token=keep-protocol\",\"name\":\"***\"}\n" || strings.Contains(result.Stderr, "session-secret") {
		t.Fatalf("incorrect capture redaction: %+v", result)
	}
	for _, mode := range []string{"helper:limit", "helper:limit-exit"} {
		req.URL, req.CredentialsRef = mode, ""
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		result, err = runner.Capture(ctx, CaptureRequest{Request: req, MaxOutputBytes: 100})
		cancel()
		if !errors.Is(err, ErrCaptureLimit) || len(result.Stdout)+len(result.Stderr) > 100 {
			t.Fatalf("capture limit: %+v, %v", result, err)
		}
		assertReaped(t, result.PID)
	}
}

func TestTimeoutAndHeartbeat(t *testing.T) {
	for _, tc := range []struct {
		mode        string
		task, stall time.Duration
		timedOut    bool
	}{
		{"helper:hang", 300 * time.Millisecond, 0, true},
		{"helper:stall", 5 * time.Second, 300 * time.Millisecond, true},
		{"helper:extracting", 5 * time.Second, 300 * time.Millisecond, false},
		{"helper:heartbeat", 5 * time.Second, 300 * time.Millisecond, false},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			runner, req := newTestRunner(t)
			req.URL, req.TaskTimeout = tc.mode, tc.task
			ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
			defer cancel()
			start := time.Now()
			result, err := runner.Run(ctx, RunRequest{Request: req, StallTimeout: tc.stall})
			if err != nil || result.TimedOut != tc.timedOut || time.Since(start) > 4*time.Second {
				t.Fatalf("timeout result: %+v, %v", result, err)
			}
			markers, err := filepath.Glob(filepath.Join(req.OutputDir, ".gdl-activity-*"))
			if err != nil || len(markers) != 0 || runner.ActiveCount() != 0 {
				t.Fatalf("cleanup: markers=%v err=%v", markers, err)
			}
			assertReaped(t, result.PID)
		})
	}
}

func TestContextCancellationAndStartedFailure(t *testing.T) {
	for _, capture := range []bool{false, true} {
		for _, failStart := range []bool{false, true} {
			t.Run(fmt.Sprintf("capture=%t/failStart=%t", capture, failStart), func(t *testing.T) {
				runner, req := newTestRunner(t)
				req.URL = "helper:tree"
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				startupErr := errors.New("failed to persist worker PID")
				var child, startedPID int
				req.OnStarted = func(pid int, marker string) error {
					startedPID = pid
					if !strings.HasPrefix(marker, req.ID+"-") || runner.ActiveCount() != 1 {
						t.Error("worker not registered before start callback")
					}
					child = waitChild(t, req.OutputDir)
					if failStart {
						return startupErr
					}
					cancel()
					return nil
				}
				var err error
				if capture {
					_, err = runner.Capture(ctx, CaptureRequest{Request: req})
				} else {
					_, err = runner.Run(ctx, RunRequest{Request: req})
				}
				want := context.Canceled
				if failStart {
					want = startupErr
				}
				if !errors.Is(err, want) || runner.ActiveCount() != 0 {
					t.Fatalf("cleanup error=%v active=%d", err, runner.ActiveCount())
				}
				assertReaped(t, startedPID)
				assertNotRunning(t, child)
			})
		}
	}
}

func TestCancelStopAllAndExitedParentCleanup(t *testing.T) {
	runner, req := newTestRunner(t)
	req.URL = "helper:hang"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	started := make(chan int, 2)
	done := make(chan error, 2)
	req.OnStarted = func(pid int, marker string) error { started <- pid; return nil }
	go func() { _, err := runner.Run(ctx, RunRequest{Request: req}); done <- err }()
	pid := <-started
	if _, err := runner.Run(ctx, RunRequest{Request: req}); err == nil {
		t.Fatal("duplicate active ID accepted")
	}
	if !runner.Cancel(req.ID) || !errors.Is(<-done, context.Canceled) || runner.Cancel(req.ID) {
		t.Fatal("Cancel did not settle active operation")
	}
	assertReaped(t, pid)
	for _, id := range []string{"one", "two"} {
		request := req
		request.ID = id
		go func() { _, err := runner.Capture(ctx, CaptureRequest{Request: request}); done <- err }()
	}
	pids := []int{<-started, <-started}
	runner.StopAll()
	for _, pid := range pids {
		if !errors.Is(<-done, context.Canceled) {
			t.Fatal("StopAll did not cancel capture")
		}
		assertReaped(t, pid)
	}
	req.URL, req.OnStarted = "helper:orphan", nil
	result, err := runner.Run(ctx, RunRequest{Request: req})
	if err != nil || result.ExitCode != 0 || runner.ActiveCount() != 0 {
		t.Fatalf("exited parent: %+v %v", result, err)
	}
	assertNotRunning(t, waitChild(t, req.OutputDir))
	req.URL = "helper:failure"
	result, err = runner.Run(ctx, RunRequest{Request: req})
	if err != nil || result.ExitCode != 7 {
		t.Fatalf("child failure must be result, not error: %+v %v", result, err)
	}
}

func TestStaleWorkerExactIdentity(t *testing.T) {
	valid := []string{"python3", "-m", workerModule, "--marker", "exact-marker", "--gallery-root", "/tmp/source", "--", "url"}
	if !matchesWorker([]byte(strings.Join(valid, "\x00")+"\x00"), "exact-marker") {
		t.Fatal("valid worker rejected")
	}
	legacy := append([]string(nil), valid...)
	legacy[2] = "gdl_backend.worker_entry"
	if !matchesWorker([]byte(strings.Join(legacy, "\x00")+"\x00"), "exact-marker") {
		t.Fatal("legacy orphan worker must remain eligible for exact-identity cleanup")
	}
	for _, flag := range []string{"--resolve", "--resolve-batch", "--danbooru-auth"} {
		resolved := append(append([]string(nil), valid[:7]...), flag, "--", "url")
		if !matchesWorker([]byte(strings.Join(resolved, "\x00")), "exact-marker") {
			t.Fatalf("valid %s worker rejected", flag)
		}
	}
	for _, args := range [][]string{
		{"python3", "-m", "gdl_backend.worker_entry.other", "--marker", "exact-marker", "--"},
		{"python3", "-m", "unrelated.worker_entry", "--marker", "exact-marker", "--"},
		{"python3", "-m", workerModule, "--resolve", "--resolve", "--marker", "exact-marker", "--"},
		{"python3", "-m", workerModule, "--danbooru-auth", "--danbooru-auth", "--marker", "exact-marker", "--"},
		{"python3", "-m", workerModule, "--resolve", "--danbooru-auth", "--marker", "exact-marker", "--"},
		{"python3", "-m", workerModule, "--danbooru-auth-other", "--marker", "exact-marker", "--"},
		{"python3", "-m", workerModule, "--marker", "exact-marker", "--marker", "exact-marker", "--"},
		{"python3", "-c", "code", "-m", workerModule, "--marker", "exact-marker", "--"},
		{"python3", "-m", workerModule + ".other", "--marker", "exact-marker", "--"},
		{"python3", "-m", workerModule, "--marker", "exact-marker-extra", "--"},
		{"python3", "-m", workerModule, "--", "--marker", "exact-marker"},
		{"python3", "-m", workerModule, "--gallery-root", "--marker", "exact-marker", "--"},
	} {
		if matchesWorker([]byte(strings.Join(args, "\x00")), "exact-marker") {
			t.Errorf("unrelated argv accepted: %q", args)
		}
	}
	runner, req := newTestRunner(t)
	req.URL = "helper:hang"
	ready := filepath.Join(req.OutputDir, "worker.ready")
	t.Setenv("LDOS_HELPER_READY", ready)
	command, err := runner.BuildCommand("exact-marker", req)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(command[0], command[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); _ = cmd.Wait() })
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stale helper did not become ready")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if matched, err := TerminateStaleProcess(context.Background(), cmd.Process.Pid, "exact", time.Millisecond); matched || err != nil {
		t.Fatalf("partial marker terminated unrelated PID: %t %v", matched, err)
	}
	if err := cmd.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatal("unrelated PID was terminated")
	}
	if matched, err := TerminateStaleProcess(context.Background(), cmd.Process.Pid, "exact-marker", time.Millisecond); !matched || err != nil {
		t.Fatalf("stale worker not terminated: %t %v", matched, err)
	}
}

func waitChild(t *testing.T, output string) int {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(filepath.Join(output, "child.pid")); err == nil {
			pid, err := strconv.Atoi(string(data))
			if err == nil {
				return pid
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("helper child did not start")
	return 0
}

func assertReaped(t *testing.T, pid int) {
	t.Helper()
	if pid <= 0 {
		t.Fatal("worker was not started")
	}
	if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("worker %d was not reaped: %v", pid, err)
	}
}

func assertNotRunning(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if errors.Is(err, os.ErrNotExist) {
			return
		}
		if err == nil {
			// Orphan grandchildren are reaped by init, not by this runner.
			_, state, _ := strings.Cut(string(data), ") ")
			if strings.HasPrefix(state, "Z ") {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("child %d is still running", pid)
}
