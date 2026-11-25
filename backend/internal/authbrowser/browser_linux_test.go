//go:build linux

package authbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

// TestMain reexecutes this test binary as a fake Chromium process. No real
// browser, user profile, graphical session, or external network is used.
func TestMain(m *testing.M) {
	if mode := os.Getenv("LDOS_AUTHBROWSER_TEST_HELPER"); mode != "" {
		fakeBrowserProcess(mode)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func fakeBrowserProcess(mode string) {
	if mode == "child" {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, syscall.SIGTERM)
		os.WriteFile(os.Getenv("LDOS_AUTHBROWSER_TEST_CHILD_READY"), []byte("ready"), 0600)
		<-signals
		return
	}
	profile, port := "", ""
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "--user-data-dir=") {
			profile = strings.TrimPrefix(arg, "--user-data-dir=")
		}
		if strings.HasPrefix(arg, "--remote-debugging-port=") {
			port = strings.TrimPrefix(arg, "--remote-debugging-port=")
		}
	}
	args, _ := json.Marshal(os.Args[1:])
	os.WriteFile(filepath.Join(profile, "helper-args.json"), args, 0600)
	if mode == "stalled" {
		time.Sleep(time.Hour) // Stay alive until signalled, including in pure-Go builds.
		return
	}
	if mode == "stubborn" {
		signal.Ignore(syscall.SIGTERM)
	}
	var child *exec.Cmd
	var signals chan os.Signal
	if mode == "group" {
		signals = make(chan os.Signal, 1)
		signal.Notify(signals, syscall.SIGTERM)
		path, _ := os.Executable()
		child = exec.Command(path)
		child.Env = append(os.Environ(), "LDOS_AUTHBROWSER_TEST_HELPER=child", "LDOS_AUTHBROWSER_TEST_CHILD_READY="+filepath.Join(profile, "child-ready"))
		if child.Start() != nil {
			os.Exit(21)
		}
		os.WriteFile(filepath.Join(profile, "child-pid"), []byte(strconv.Itoa(child.Process.Pid)), 0600)
		for i := 0; i < 500; i++ {
			if _, err := os.Stat(filepath.Join(profile, "child-ready")); err == nil {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:"+port)
	if err != nil {
		os.Exit(22)
	}
	closed := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if mode == "graceful" && strings.HasPrefix(r.URL.Path, "/devtools/") {
			ws := websocket.Server{Handshake: func(*websocket.Config, *http.Request) error { return nil }, Handler: func(conn *websocket.Conn) {
				defer conn.Close()
				var request cdpMessage
				if websocket.JSON.Receive(conn, &request) != nil {
					return
				}
				websocket.JSON.Send(conn, map[string]any{"id": request.ID, "result": map[string]any{"targetId": "target", "success": true}})
				if request.Method == "Browser.close" {
					close(closed)
				}
			}}
			ws.ServeHTTP(w, r)
			return
		}
		fmt.Fprintf(w, `{"webSocketDebuggerUrl":"ws://127.0.0.1:%s/devtools/browser/helper"}`, port)
	})}
	if mode == "graceful" {
		go server.Serve(listener)
		<-closed
		server.Close()
		return
	}
	if child == nil {
		server.Serve(listener)
		return
	}
	go server.Serve(listener)
	<-signals
	// Wait for the child to receive the group's SIGTERM; we never signal it
	// individually, so this test detects parent-only shutdown implementations.
	child.Wait()
}

func helperExecutable(t *testing.T, mode string) string {
	t.Helper()
	t.Setenv("LDOS_AUTHBROWSER_TEST_HELPER", mode)
	// Race instrumentation otherwise adds one second to each helper's exit.
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	path, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func currentHost(b *Browser) *host {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.host
}

func waitHost(t *testing.T, b *Browser) *host {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if h := currentHost(b); h != nil {
			return h
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("helper process did not start")
	return nil
}

func assertReaped(t *testing.T, h *host) {
	t.Helper()
	select {
	case <-h.done:
	default:
		t.Fatal("process Wait not completed")
	}
	if h.cmd.ProcessState == nil || h.cmd.ProcessState.Pid() == 0 {
		t.Fatal("process was not reaped")
	}
	if err := syscall.Kill(h.cmd.Process.Pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("process remains: %v", err)
	}
}

func TestEnsureStopAndProfilePersistence(t *testing.T) {
	executable := helperExecutable(t, "group")
	profile := filepath.Join(t.TempDir(), "profile")
	b := New(profile)
	t.Cleanup(func() { b.Stop() })
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	proxy := "socks5h://username:password@127.0.0.1:1080"
	if err := b.Ensure(ctx, executable, proxy); err != nil {
		t.Fatal(err)
	}
	cancel() // Successful Ensure does not borrow a request's lifetime.
	h := currentHost(b)
	if !b.Running() || b.Proxy() != proxy || !b.ProfilePresent() {
		t.Fatal("host/profile status not retained")
	}
	if pgid, err := syscall.Getpgid(h.cmd.Process.Pid); err != nil || pgid != h.cmd.Process.Pid {
		t.Fatalf("process group = %d, %v", pgid, err)
	}
	args, err := os.ReadFile(filepath.Join(profile, "helper-args.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(args), "password") || strings.Contains(string(args), "username") || !strings.Contains(string(args), "--proxy-server=socks5://127.0.0.1:1080") {
		t.Fatalf("proxy argv = %s", args)
	}
	if err := b.Ensure(context.Background(), executable, proxy); err != nil {
		t.Fatal(err)
	}
	if currentHost(b) != h {
		t.Fatal("healthy matching host was restarted")
	}
	childData, err := os.ReadFile(filepath.Join(profile, "child-pid"))
	if err != nil {
		t.Fatal(err)
	}
	childPID, _ := strconv.Atoi(string(childData))
	started := time.Now()
	if err := b.Stop(); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) > 1800*time.Millisecond {
		t.Fatal("process group did not exit during grace period")
	}
	assertReaped(t, h)
	if err := syscall.Kill(childPID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("child remains after stop: %v", err)
	}
	if b.Running() || b.Proxy() != "" || !b.ProfilePresent() {
		t.Fatal("stop must retain profile but clear host")
	}
	if err := b.ResetProfile(); err != nil {
		t.Fatal(err)
	}
	if b.ProfilePresent() {
		t.Fatal("reset retained profile")
	}
	if err := b.Stop(); err != nil {
		t.Fatal(err)
	}
	if err := b.ResetProfile(); err != nil {
		t.Fatal(err)
	}
}

func TestTargetsAndGracefulBrowserClose(t *testing.T) {
	executable := helperExecutable(t, "graceful")
	b := New(filepath.Join(t.TempDir(), "profile"))
	t.Cleanup(func() { b.Stop() })
	if err := b.Ensure(context.Background(), executable, ""); err != nil {
		t.Fatal(err)
	}
	h := currentHost(b)
	target, err := b.Open(context.Background(), "about:blank")
	if err != nil || target != "target" {
		t.Fatalf("Open = %q, %v", target, err)
	}
	if err := b.CloseTarget(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	if err := b.Stop(); err != nil {
		t.Fatal(err)
	}
	assertReaped(t, h)
	if h.cmd.ProcessState.ExitCode() != 0 {
		t.Fatal("browser was signalled before graceful close completed")
	}
}

func TestEnsureCancellationAndDeadlineCleanup(t *testing.T) {
	executable := helperExecutable(t, "stalled")
	for _, deadline := range []bool{false, true} {
		t.Run(fmt.Sprint(deadline), func(t *testing.T) {
			b := New(filepath.Join(t.TempDir(), "profile"))
			t.Cleanup(func() { b.Stop() })
			ctx, cancel := context.WithCancel(context.Background())
			if deadline {
				ctx, cancel = context.WithTimeout(context.Background(), 150*time.Millisecond)
			}
			defer cancel()
			result := make(chan error, 1)
			go func() { result <- b.Ensure(ctx, executable, "") }()
			h := waitHost(t, b)
			if !deadline {
				cancel()
			}
			select {
			case err := <-result:
				want := context.Canceled
				if deadline {
					want = context.DeadlineExceeded
				}
				if !errors.Is(err, want) {
					t.Fatalf("Ensure = %v, want %v", err, want)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("cancelled startup did not return")
			}
			assertReaped(t, h)
			if b.Running() || currentHost(b) != nil {
				t.Fatal("cancelled startup retained host")
			}
		})
	}
}

func TestStopInterruptsStartupAndKillsStubbornProcess(t *testing.T) {
	for _, mode := range []string{"stalled", "stubborn"} {
		t.Run(mode, func(t *testing.T) {
			executable := helperExecutable(t, mode)
			b := New(filepath.Join(t.TempDir(), "profile"))
			t.Cleanup(func() { b.Stop() })
			result := make(chan error, 1)
			if mode == "stalled" {
				go func() { result <- b.Ensure(context.Background(), executable, "") }()
			} else {
				if err := b.Ensure(context.Background(), executable, ""); err != nil {
					t.Fatal(err)
				}
			}
			h := waitHost(t, b)
			started := time.Now()
			if err := b.Stop(); err != nil {
				t.Fatal(err)
			}
			if time.Since(started) > 4*time.Second {
				t.Fatal("stop exceeded bounded grace")
			}
			assertReaped(t, h)
			if mode == "stalled" {
				select {
				case err := <-result:
					if !errors.Is(err, ErrStart) {
						t.Fatalf("startup = %v", err)
					}
				case <-time.After(time.Second):
					t.Fatal("startup still blocked")
				}
			}
		})
	}
}

func TestProxyChangeRestartsHostAndConcurrentStatus(t *testing.T) {
	executable := helperExecutable(t, "serve")
	b := New(filepath.Join(t.TempDir(), "profile"))
	t.Cleanup(func() { b.Stop() })
	if err := b.Ensure(context.Background(), executable, "http://127.0.0.1:8080"); err != nil {
		t.Fatal(err)
	}
	old := currentHost(b)
	var readers sync.WaitGroup
	for i := 0; i < 5; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for j := 0; j < 100; j++ {
				b.Running()
				b.Proxy()
				b.ProfilePresent()
			}
		}()
	}
	if err := b.Ensure(context.Background(), executable, "http://127.0.0.1:8081"); err != nil {
		t.Fatal(err)
	}
	readers.Wait()
	assertReaped(t, old)
	if currentHost(b) == old || b.Proxy() != "http://127.0.0.1:8081" {
		t.Fatal("proxy change did not replace host")
	}
	if err := b.Ensure(context.Background(), executable, "invalid://credential@host"); !errors.Is(err, ErrProxy) {
		t.Fatalf("invalid proxy = %v", err)
	}
}

func TestEnsureLockWaitCancellable(t *testing.T) {
	b := New(filepath.Join(t.TempDir(), "profile"))
	b.acquire(nil)
	defer b.release()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := b.Ensure(ctx, "/not-used", ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("lock wait = %v", err)
	}
}

func TestProfileRejectsSymlinksAndResetDoesNotTraverse(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "outside")
	if err := os.Mkdir(outside, 0755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(outside, "keep")
	if err := os.WriteFile(marker, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	for _, profile := range []string{link, filepath.Join(link, "nested")} {
		b := New(profile)
		if err := prepareProfile(profile); !errors.Is(err, ErrProfile) {
			t.Fatalf("symlink prepare = %v", err)
		}
		if b.ProfilePresent() {
			t.Fatal("symlink profile reported present")
		}
		if err := b.ResetProfile(); !errors.Is(err, ErrProfile) {
			t.Fatalf("symlink reset = %v", err)
		}
	}
	profile := filepath.Join(root, "profile")
	if err := prepareProfile(profile); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(profile, "linked-data")); err != nil {
		t.Fatal(err)
	}
	if err := New(profile).ResetProfile(); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "keep" {
		t.Fatalf("outside data removed: %v", err)
	}
	for _, path := range []string{root, outside} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0755 {
			t.Fatalf("unrelated parent permissions changed: %s %v", path, err)
		}
	}
}

func TestDiscoverExplicitAndProxyMapping(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "chromium")
	if err := os.WriteFile(path, []byte("helper"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GDL_BACKEND_CHROME", path)
	got, name, err := Discover("")
	if err != nil || got != path || name != "Chromium" {
		t.Fatalf("Discover = %s, %s, %v", got, name, err)
	}
	if _, _, err := Discover(filepath.Join(root, "missing")); !errors.Is(err, ErrNotFound) {
		t.Fatal("explicit discovery fell back")
	}
	for _, test := range []struct{ input, want string }{
		{"socks5h://user:secret@127.0.0.1:1080", "socks5://127.0.0.1:1080"},
		{"socks4a://[::1]:1080", "socks4://[::1]:1080"},
		{"http://user:secret@localhost:8080/path", "http://localhost:8080"},
	} {
		got, err := chromeProxy(test.input)
		if err != nil || got != test.want {
			t.Fatalf("proxy = %q, %v", got, err)
		}
	}
}
