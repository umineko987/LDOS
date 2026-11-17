package gallery

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func authResolverTestRunner(t *testing.T) (*Runner, Request) {
	t.Helper()
	runner, req := newTestRunner(t)
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is required for the isolated resolver protocol fixture")
	}
	runner.settings.PythonExecutable = python
	worker := `import json, os, sys, time
if "--danbooru-auth" not in sys.argv[:sys.argv.index("--")]:
    raise SystemExit("missing resolver control flag")
mode = os.environ.get("LDOS_AUTH_FIXTURE", "ok")
if mode == "hang":
    with open(os.environ["LDOS_AUTH_READY"], "w") as ready:
        ready.write("ready")
    time.sleep(60)
elif mode == "error":
    print(json.dumps({"error": "no_valid_cookies"}))
elif mode == "invalid":
    print("private-protocol-secret")
elif mode == "large":
    print("x" * 70000)
else:
    print(json.dumps({"headers": {"Authorization": "Basic fixture-auth", "Cookie": "session=fixture-cookie"}, "error": ""}))
`
	if err := os.WriteFile(filepath.Join(runner.executorsRoot, "ldos_gallery", "worker_entry.py"), []byte(worker), 0o600); err != nil {
		t.Fatal(err)
	}
	req.URL = "https://danbooru.donmai.us/posts?tags=fixture"
	return runner, req
}

func TestDanbooruAuthResolverPrivateProtocolAndFailures(t *testing.T) {
	runner, req := authResolverTestRunner(t)
	t.Setenv("GDL_CREDENTIAL_AUTH_USERNAME", "private-user")
	t.Setenv("GDL_CREDENTIAL_AUTH_PASSWORD", "private-key")
	req.CredentialsRef = "auth"
	pid := 0
	req.OnStarted = func(gotPID int, _ string) error {
		pid = gotPID
		return nil
	}
	headers, err := runner.ResolveDanbooruAuth(context.Background(), req)
	if err != nil || headers.Get("Authorization") != "Basic fixture-auth" || headers.Get("Cookie") != "session=fixture-cookie" {
		t.Fatalf("auth resolution = %v %v", headers, err)
	}
	assertReaped(t, pid)
	for _, mode := range []string{"error", "invalid", "large"} {
		t.Setenv("LDOS_AUTH_FIXTURE", mode)
		headers, err := runner.ResolveDanbooruAuth(context.Background(), req)
		if err == nil || headers != nil || strings.Contains(err.Error(), "private-") {
			t.Fatalf("%s = %v %v", mode, headers, err)
		}
		if mode == "error" && !strings.Contains(err.Error(), "有效 Cookie") {
			t.Fatal("error-only protocol lost its diagnostic", err)
		}
		assertReaped(t, pid)
	}
	if runner.ActiveCount() != 0 {
		t.Fatal("resolver leaked a registry entry")
	}
	if _, err := os.Stat(runner.settings.CacheFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("offline resolver created an extraction cache", err)
	}
}

func TestDanbooruAuthResolverCancellationAndStopAllReapWorker(t *testing.T) {
	for _, operation := range []string{"context", "cancel", "stop-all"} {
		t.Run(operation, func(t *testing.T) {
			runner, req := authResolverTestRunner(t)
			t.Setenv("LDOS_AUTH_FIXTURE", "hang")
			ready := filepath.Join(t.TempDir(), "ready")
			t.Setenv("LDOS_AUTH_READY", ready)
			t.Setenv("GDL_CREDENTIAL_AUTH_USERNAME", "private-user")
			t.Setenv("GDL_CREDENTIAL_AUTH_PASSWORD", "private-key")
			req.CredentialsRef = "auth"
			started := make(chan struct {
				pid int
				id  string
			}, 1)
			req.OnStarted = func(pid int, marker string) error {
				// Python initializes argv after exec; inspect it once the fixture
				// has entered the blocking operation, not during interpreter startup.
				deadline := time.Now().Add(2 * time.Second)
				for {
					if _, err := os.Stat(ready); err == nil {
						break
					}
					if time.Now().After(deadline) {
						return errors.New("resolver fixture did not become ready")
					}
					time.Sleep(5 * time.Millisecond)
				}
				command, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
				if err != nil {
					return err
				}
				if strings.Contains(string(command), "private-") || !matchesWorker(command, marker) {
					t.Error("resolver command exposes credentials or cannot be recovered")
				}
				started <- struct {
					pid int
					id  string
				}{pid, marker}
				return nil
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				_, err := runner.ResolveDanbooruAuth(ctx, req)
				done <- err
			}()
			var pid int
			select {
			case process := <-started:
				pid = process.pid
				if runner.ActiveCount() != 1 {
					t.Fatal("resolver not tracked by registry")
				}
				switch operation {
				case "context":
					cancel()
				case "cancel":
					if !runner.Cancel(process.id) {
						t.Fatal("Cancel did not find resolver")
					}
				case "stop-all":
					runner.StopAll()
				}
			case <-time.After(3 * time.Second):
				t.Fatal("resolver did not start")
			}
			select {
			case err := <-done:
				if err == nil || (operation == "context" && !errors.Is(err, context.Canceled)) {
					t.Fatal("resolver cancellation result", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("resolver did not stop")
			}
			assertReaped(t, pid)
			if runner.ActiveCount() != 0 {
				t.Fatal("resolver registry was not cleared")
			}
		})
	}
}
