//go:build linux

package proxytransport

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

// This test binary impersonates mihomo; it only reads temporary config and binds loopback.
func TestCoreHelperProcess(t *testing.T) {
	if os.Getenv("LDOS_TEST_PROXY_CORE") != "1" {
		return
	}
	args := os.Args
	for len(args) > 0 && args[0] != "--" {
		args = args[1:]
	}
	if len(args) < 2 {
		os.Exit(91)
	}
	args = args[1:]
	mode := os.Getenv("LDOS_TEST_PROXY_MODE")
	if args[0] == "-v" {
		fmt.Print("mihomo fixture\nversion 1\n")
		os.Exit(0)
	}
	if args[0] == "-t" {
		if mode == "invalid" {
			fmt.Fprint(os.Stderr, "password: fixture-secret")
			os.Exit(1)
		}
		if mode == "hang-validation" {
			writeHelperPID()
			time.Sleep(time.Minute)
			os.Exit(0)
		}
		os.Exit(0)
	}
	writeHelperPID()
	if mode == "exit" {
		os.Exit(2)
	}
	if len(args) < 4 || args[0] != "-f" || args[2] != "-d" {
		os.Exit(92)
	}
	data, err := os.ReadFile(args[1])
	if err != nil {
		os.Exit(93)
	}
	var config struct {
		Listeners []struct {
			Listen string
			Port   int
		}
	}
	if err := yaml.Unmarshal(data, &config); err != nil {
		os.Exit(94)
	}
	var listeners []net.Listener
	if mode != "no-listen" {
		for _, listener := range config.Listeners {
			if listener.Listen != "127.0.0.1" {
				os.Exit(95)
			}
			l, err := net.Listen("tcp4", net.JoinHostPort(listener.Listen, strconv.Itoa(listener.Port)))
			if err != nil {
				os.Exit(96)
			}
			listeners = append(listeners, l)
			go func() {
				for {
					conn, err := l.Accept()
					if err != nil {
						return
					}
					conn.Close()
				}
			}()
		}
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	<-signals
	for _, l := range listeners {
		_ = l.Close()
	}
	os.Exit(0)
}

func writeHelperPID() {
	if path := os.Getenv("LDOS_TEST_PROXY_PID"); path != "" {
		_ = os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())), 0600)
	}
}

func helperCore(t *testing.T, mode string) (*Core, string) {
	t.Helper()
	t.Setenv("LDOS_TEST_PROXY_CORE", "1")
	t.Setenv("LDOS_TEST_PROXY_MODE", mode)
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	root := t.TempDir()
	pidPath := filepath.Join(root, "pid")
	t.Setenv("LDOS_TEST_PROXY_PID", pidPath)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(root, "proxy-core")
	quoted := "'" + strings.ReplaceAll(executable, "'", "'\"'\"'") + "'"
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexec "+quoted+" -test.run=^TestCoreHelperProcess$ -- \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	core := NewCore(CoreSettings{BinaryPath: binary, RuntimeDir: filepath.Join(root, "runtime"), BasePort: 29100, StartTimeout: time.Second})
	t.Cleanup(func() { _ = core.Stop() })
	return core, pidPath
}

func TestCoreNativeLifecycleStatusAndPermissions(t *testing.T) {
	core, _ := helperCore(t, "")
	ctx, cancel := context.WithCancel(context.Background())
	endpoints, err := core.Start(ctx, testNodes())
	if err != nil {
		t.Fatal(err)
	}
	cancel() // request lifetime must not kill a successfully started managed core.
	status := core.Status()
	if status["running"] != true || status["listeners"] != 3 || status["version"] != "mihomo fixture version 1" || status["binary"] != "proxy-core" || len(status["sha256"].(string)) != 64 {
		t.Fatalf("unexpected status: %v", status)
	}
	for _, name := range []string{"", "config.yaml", "core.log"} {
		info, err := os.Stat(filepath.Join(core.settings.RuntimeDir, name))
		if err != nil {
			t.Fatal(err)
		}
		want := os.FileMode(0600)
		if name == "" {
			want = 0700
		}
		if info.Mode().Perm() != want {
			t.Errorf("%s permissions %o", name, info.Mode().Perm())
		}
	}
	firstPID := status["pid"].(int)
	if _, err := core.Start(context.Background(), testNodes()[:1]); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(firstPID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Error("restart leaked previous process")
	}
	if err := core.Stop(); err != nil {
		t.Fatal(err)
	}
	if core.Status()["running"] != false || core.Status()["listeners"] != 0 || core.Status()["pid"] != nil {
		t.Error("stopped status is stale")
	}
	for _, endpoint := range endpoints {
		address := strings.TrimPrefix(endpoint.LocalHTTP, "http://")
		l, err := net.Listen("tcp4", address)
		if err != nil {
			t.Errorf("listener leaked: %v", err)
		} else {
			l.Close()
		}
	}
}

func TestCoreStartupFailuresCleanUp(t *testing.T) {
	for _, mode := range []string{"invalid", "exit", "no-listen"} {
		t.Run(mode, func(t *testing.T) {
			core, pidPath := helperCore(t, mode)
			if _, err := core.Start(context.Background(), testNodes()[:1]); err == nil {
				t.Fatal("failed core started")
			}
			status := core.Status()
			if status["running"] != false || status["listeners"] != 0 || status["last_error"] == "" {
				t.Error(status)
			}
			if strings.Contains(status["last_error"].(string), "fixture-secret") {
				t.Error("private configuration leaked in status")
			}
			if data, err := os.ReadFile(pidPath); err == nil {
				pid, _ := strconv.Atoi(string(data))
				if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
					t.Fatalf("failed startup leaked process %d", pid)
				}
			}
		})
	}
}

func TestCoreStopCancelsStartupAndConcurrentStatus(t *testing.T) {
	for _, mode := range []string{"hang-validation", "no-listen"} {
		t.Run(mode, func(t *testing.T) {
			core, pidPath := helperCore(t, mode)
			core.settings.StartTimeout = 20 * time.Second
			done := make(chan error, 1)
			go func() { _, err := core.Start(context.Background(), testNodes()[:1]); done <- err }()
			waitForHelperPID(t, pidPath)
			var wg sync.WaitGroup
			for i := 0; i < 4; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					for j := 0; j < 100; j++ {
						_ = core.Status()
					}
				}()
			}
			stop := make(chan struct{})
			go func() { _ = core.Stop(); close(stop) }()
			select {
			case <-stop:
			case <-time.After(4 * time.Second):
				t.Fatal("Stop did not cancel startup")
			}
			if err := <-done; !errors.Is(err, context.Canceled) {
				t.Fatalf("startup not cancelled: %v", err)
			}
			wg.Wait()
			data, _ := os.ReadFile(pidPath)
			pid, _ := strconv.Atoi(string(data))
			if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
				t.Error("cancelled child survived")
			}
		})
	}
}

func TestCoreContextCancellation(t *testing.T) {
	core, pidPath := helperCore(t, "no-listen")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := core.Start(ctx, testNodes()[:1]); done <- err }()
	waitForHelperPID(t, pidPath)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Error(err)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("context cancellation did not clean process")
	}
}

func waitForHelperPID(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("fixture subprocess did not start")
}

func TestCorePrivatePathsRejectSymlinks(t *testing.T) {
	for _, kind := range []string{"parent", "directory", "config.yaml", "core.log"} {
		t.Run(kind, func(t *testing.T) {
			core, _ := helperCore(t, "")
			outside := t.TempDir()
			target := filepath.Join(outside, "untouched")
			if err := os.WriteFile(target, []byte("original"), 0644); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "parent":
				link := filepath.Join(filepath.Dir(core.settings.RuntimeDir), "parent")
				if err := os.Symlink(outside, link); err != nil {
					t.Fatal(err)
				}
				core.settings.RuntimeDir = filepath.Join(link, "runtime")
			case "directory":
				if err := os.Symlink(outside, core.settings.RuntimeDir); err != nil {
					t.Fatal(err)
				}
			default:
				if err := os.Mkdir(core.settings.RuntimeDir, 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, filepath.Join(core.settings.RuntimeDir, kind)); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := core.Start(context.Background(), testNodes()[:1]); err == nil {
				t.Fatal("symlink accepted")
			}
			data, _ := os.ReadFile(target)
			info, _ := os.Stat(target)
			if string(data) != "original" || info.Mode().Perm() != 0644 {
				t.Error("symlink target modified")
			}
		})
	}
}

func TestResolveCoreBinaryPriorityHashAndPermissions(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "project")
	pathDir := filepath.Join(root, "path")
	for _, dir := range []string{project, pathDir} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	projectBinary := filepath.Join(project, "proxy-core")
	pathBinary := filepath.Join(pathDir, "mihomo")
	for _, path := range []string{projectBinary, pathBinary} {
		if err := os.WriteFile(path, []byte("fixture-core"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", pathDir)
	digest := sha256.Sum256([]byte("fixture-core"))
	expected := fmt.Sprintf("%x", digest)
	path, actual, err := resolveBinary(CoreSettings{ProjectBinDir: project, ExpectedSHA256: strings.ToUpper(expected)})
	if err != nil || path != projectBinary || actual != expected {
		t.Fatal(path, actual, err)
	}
	path, _, err = resolveBinary(CoreSettings{ProjectBinDir: filepath.Join(root, "missing")})
	if err != nil || path != pathBinary {
		t.Fatal(path, err)
	}
	if _, _, err := resolveBinary(CoreSettings{BinaryPath: filepath.Join(root, "missing")}); err == nil {
		t.Error("explicit missing binary fell back")
	}
	if _, _, err := resolveBinary(CoreSettings{BinaryPath: projectBinary, ExpectedSHA256: strings.Repeat("0", 64)}); err == nil {
		t.Error("wrong SHA accepted")
	}
	if err := os.Chmod(projectBinary, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := resolveBinary(CoreSettings{BinaryPath: projectBinary}); err == nil || !strings.Contains(err.Error(), "执行权限") {
		t.Error("non-executable accepted", err)
	}
}

func TestCorePortBlockSkipsOccupiedPreferred(t *testing.T) {
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	preferred := l.Addr().(*net.TCPAddr).Port
	port, err := findPortBlock(context.Background(), preferred, 2)
	if err != nil || port == preferred {
		t.Fatal(port, err)
	}
}
