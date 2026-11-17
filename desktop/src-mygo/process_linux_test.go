package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

func helperCommand(mode string) *exec.Cmd {
	cmd := exec.Command(os.Args[0], "-test.run=^TestProcessHelper$")
	cmd.Env = append(os.Environ(), "LDOS_TEST_HELPER_MODE="+mode, "GORACE="+os.Getenv("GORACE")+" atexit_sleep_ms=0")
	return cmd
}

// This helper runs only inside explicitly launched, isolated fake processes.
func TestProcessHelper(t *testing.T) {
	mode := os.Getenv("LDOS_TEST_HELPER_MODE")
	if mode == "" {
		return
	}
	marker := os.Getenv("LDOS_TEST_MARKER")
	ready := os.Getenv("LDOS_TEST_READY")
	switch mode {
	case "pipe":
		_ = os.WriteFile(ready, []byte(strconv.Itoa(os.Getpid())), 0600)
		_, _ = io.Copy(io.Discard, os.Stdin)
		_ = os.WriteFile(marker, []byte("eof"), 0600)
	case "stubborn":
		signal.Ignore(syscall.SIGTERM)
		_ = os.WriteFile(ready, []byte(strconv.Itoa(os.Getpid())), 0600)
		for {
			time.Sleep(time.Hour)
		}
	case "group", "orphan":
		child := helperCommand("stubborn")
		if err := child.Start(); err != nil {
			os.Exit(2)
		}
		if mode == "group" {
			signal.Ignore(syscall.SIGTERM)
			for {
				time.Sleep(time.Hour)
			}
		}
		// Wait until the descendant's TERM handler is installed before exiting.
		for !isFile(ready) {
			time.Sleep(time.Millisecond)
		}
	case "host":
		process, err := spawnProcess(helperCommand("pipe"))
		if err != nil {
			os.Exit(2)
		}
		defer process.shutdown(time.Second, time.Second)
		for {
			time.Sleep(time.Hour)
		}
	case "generate":
		main()
	case "single":
		mygo.App.SetName(os.Getenv("LDOS_TEST_APP_NAME"))
		if !mygo.App.RequestSingleInstanceLock() {
			os.Exit(0)
		}
		process, err := spawnProcess(helperCommand("pipe"))
		if err != nil {
			os.Exit(2)
		}
		// Only the lock owner reaches this marker or spawns a fake backend.
		file, err := os.OpenFile(marker+".starts", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			os.Exit(2)
		}
		_, _ = file.WriteString("started\n")
		file.Close()
		_, _ = io.Copy(io.Discard, os.Stdin)
		process.shutdown(time.Second, 100*time.Millisecond)
	default:
		fmt.Fprintln(os.Stderr, "unknown helper mode")
		os.Exit(2)
	}
	os.Exit(0)
}

func waitFile(t *testing.T, path string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil && len(data) > 0 {
			return string(data)
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("waiting for fake-process marker %s", path)
	return ""
}

func helperPaths(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	marker, ready := filepath.Join(root, "exited"), filepath.Join(root, "ready")
	t.Setenv("LDOS_TEST_MARKER", marker)
	t.Setenv("LDOS_TEST_READY", ready)
	return marker, ready
}

func TestParentPipeCooperativeShutdown(t *testing.T) {
	marker, ready := helperPaths(t)
	process, err := spawnProcess(helperCommand("pipe"))
	if err != nil {
		t.Fatal(err)
	}
	defer process.shutdown(50*time.Millisecond, 50*time.Millisecond)
	waitFile(t, ready)
	process.shutdown(time.Second, 50*time.Millisecond)
	if got := waitFile(t, marker); got != "eof" {
		t.Fatal(got)
	}
	if process.waitErr != nil {
		t.Fatalf("cooperative child was killed: %v", process.waitErr)
	}
}

func liveProcess(pid int) bool {
	// A killed, reparented worker may briefly be a zombie until init reaps it.
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return false
	}
	_, after, _ := strings.Cut(string(data), ") ")
	return !strings.HasPrefix(after, "Z ")
}

func TestWholeGroupCleanupIncludingExitedLeader(t *testing.T) {
	for _, mode := range []string{"group", "orphan"} {
		t.Run(mode, func(t *testing.T) {
			_, ready := helperPaths(t)
			process, err := spawnProcess(helperCommand(mode))
			if err != nil {
				t.Fatal(err)
			}
			defer process.shutdown(10*time.Millisecond, 50*time.Millisecond)
			pid, err := strconv.Atoi(waitFile(t, ready))
			if err != nil {
				t.Fatal(err)
			}
			if mode == "orphan" && !waitDone(process.done, time.Second) {
				t.Fatal("fake parent did not exit")
			}
			process.shutdown(10*time.Millisecond, 50*time.Millisecond)
			deadline := time.Now().Add(time.Second)
			for liveProcess(pid) && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			if liveProcess(pid) {
				t.Fatalf("descendant %d survived process-group shutdown", pid)
			}
		})
	}
}

func TestParentDeathClosesBackendPipe(t *testing.T) {
	marker, ready := helperPaths(t)
	host := helperCommand("host")
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = host.Process.Kill(); _ = host.Wait() }()
	pid, err := strconv.Atoi(waitFile(t, ready))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Kill(pid, syscall.SIGKILL)
	if err := host.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = host.Wait()
	if got := waitFile(t, marker); got != "eof" {
		t.Fatal(got)
	}
}

func TestSingleInstanceDoesNotLaunchSecondBackend(t *testing.T) {
	marker, ready := helperPaths(t)
	t.Setenv("TMPDIR", t.TempDir())
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	t.Setenv("LDOS_TEST_APP_NAME", "LDOS-host-test-"+strconv.Itoa(os.Getpid()))
	first := helperCommand("single")
	stdin, err := first.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { stdin.Close(); _ = first.Process.Kill(); _ = first.Wait() }()
	waitFile(t, ready)
	second := helperCommand("single")
	if output, err := second.CombinedOutput(); err != nil {
		t.Fatalf("second instance: %v %s", err, output)
	}
	if got := waitFile(t, marker+".starts"); got != "started\n" {
		t.Fatal("duplicate backend starts:", got)
	}
	stdin.Close()
	if err := first.Wait(); err != nil {
		t.Fatal(err)
	}
	if got := waitFile(t, marker); got != "eof" {
		t.Fatal(got)
	}
}

func TestBindingGenerationHasNoBusinessSideEffects(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(root, "data"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(root, "cache"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "runtime"))
	t.Setenv("TMPDIR", root)
	t.Setenv("LDOS_DESKTOP_SOURCE", "1")
	python := filepath.Join(root, "forbidden-python")
	marker := filepath.Join(root, "python-started")
	fixtureFile(t, python, "#!/bin/sh\ntouch \"$LDOS_TEST_FORBIDDEN_MARKER\"\nexit 91\n", 0700)
	t.Setenv("LDOS_TEST_FORBIDDEN_MARKER", marker)
	t.Setenv("PYTHON", python)
	t.Setenv("GDL_BACKEND_CONFIG", filepath.Join(root, "missing-user-config.json"))
	bindings := filepath.Join(root, "host.generated.ts")
	t.Setenv("MYGO_GENERATE", bindings)
	cmd := helperCommand("generate")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate: %v %s", err, output)
	}
	data, err := os.ReadFile(bindings)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, name := range []string{"runtimeMetadata", "backendStatus", "selectDirectory", "selectBrowserExecutable", "revealInFileManager"} {
		if !strings.Contains(text, name) {
			t.Error("missing binding", name)
		}
	}
	for _, path := range []string{marker, filepath.Join(root, "config"), filepath.Join(root, "data"), filepath.Join(root, "cache"), filepath.Join(root, "runtime")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("binding generation touched %s: %v", path, err)
		}
	}
}
