package danboorurate

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestIndependentCallersShareSlots(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	times := make(chan time.Time, 3)
	errors := make(chan error, 3)
	for range 3 {
		go func() {
			err := Wait(ctx, path)
			times <- time.Now()
			errors <- err
		}()
	}
	var observed []time.Time
	for range 3 {
		observed = append(observed, <-times)
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
	sort.Slice(observed, func(i, j int) bool { return observed[i].Before(observed[j]) })
	for i := 1; i < len(observed); i++ {
		if gap := observed[i].Sub(observed[i-1]); gap < 950*time.Millisecond {
			t.Fatalf("independent requests only %s apart", gap)
		}
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private state: %v %v", info, err)
	}
}

func TestCancellationDuringCooldownAndLockContention(t *testing.T) {
	for _, heldLock := range []bool{false, true} {
		t.Run(strconv.FormatBool(heldLock), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), FileName)
			if err := Cooldown(context.Background(), path, "60"); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(path)
			if heldLock {
				file, err := os.OpenFile(path, os.O_RDWR, 0600)
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
				if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
			defer cancel()
			start := time.Now()
			if err := Wait(ctx, path); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal(err)
			}
			if time.Since(start) > 500*time.Millisecond {
				t.Fatal("cancellation did not interrupt wait")
			}
			after, _ := os.ReadFile(path)
			if string(before) != string(after) {
				t.Fatal("cancelled caller consumed a future slot")
			}
		})
	}
}

func TestRetryAfterAndCooldownNeverShortensDeadline(t *testing.T) {
	now := time.Unix(1800000000, 0)
	for _, test := range []struct {
		value string
		want  time.Duration
	}{{"", time.Second}, {"invalid", time.Second}, {"-1", time.Second}, {"0", time.Second}, {"2", 2 * time.Second}, {now.Add(5 * time.Second).UTC().Format(http.TimeFormat), 5 * time.Second}, {now.Add(-time.Hour).UTC().Format(http.TimeFormat), time.Second}} {
		if got := RetryAfter(test.value, now).Sub(now); got != test.want {
			t.Fatalf("Retry-After %q: got %s, want %s", test.value, got, test.want)
		}
	}
	path := filepath.Join(t.TempDir(), FileName)
	for _, value := range []string{"30", "1", ""} {
		if err := Cooldown(context.Background(), path, value); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	next, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil || time.Until(time.Unix(0, next)) < 29*time.Second {
		t.Fatalf("cooldown was shortened: %s, %v", data, err)
	}
}

func TestLocalStateErrors(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{root, filepath.Join(root, "absent", FileName)} {
		if err := Wait(context.Background(), path); err == nil {
			t.Fatalf("accepted unusable state %s", path)
		}
	}
	path := filepath.Join(root, FileName)
	if err := os.WriteFile(path, []byte("invalid\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := Wait(context.Background(), path); err == nil {
		t.Fatal("accepted corrupt state")
	}
	if err := Cooldown(context.Background(), path, "1"); err == nil {
		t.Fatal("accepted corrupt cooldown state")
	}
}

func pythonCommand(t *testing.T, ctx context.Context, source string, args ...string) *exec.Cmd {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	repo := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	python := filepath.Join(repo, "gallery-dl-backend", ".venv", "bin", "python")
	if _, err := os.Stat(python); err != nil {
		python, err = exec.LookPath("python3")
		if err != nil {
			t.Skip("cross-language test requires Python 3")
		}
	}
	cmd := exec.CommandContext(ctx, python, append([]string{"-c", source}, args...)...)
	cmd.Env = append(os.Environ(), "PYTHONDONTWRITEBYTECODE=1", "PYTHONPATH="+filepath.Join(repo, "backend", "executors"))
	return cmd
}

func TestGoAndMultiplePythonProcessesShareSlots(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	const source = "import sys,time; from ldos_gallery.danbooru_rate import wait; wait(sys.argv[1]); print(time.time_ns())"
	outputs := make(chan []byte, 2)
	errors := make(chan error, 2)
	for range 2 {
		cmd := pythonCommand(t, ctx, source, path)
		go func() {
			output, err := cmd.CombinedOutput()
			outputs <- output
			errors <- err
		}()
	}
	if err := Wait(ctx, path); err != nil {
		t.Fatal(err)
	}
	observed := []int64{time.Now().UnixNano()}
	for range 2 {
		output := <-outputs
		if err := <-errors; err != nil {
			t.Fatalf("Python: %v: %s", err, output)
		}
		stamp, err := strconv.ParseInt(strings.TrimSpace(string(output)), 10, 64)
		if err != nil {
			t.Fatal(err, string(output))
		}
		observed = append(observed, stamp)
	}
	sort.Slice(observed, func(i, j int) bool { return observed[i] < observed[j] })
	for i := 1; i < len(observed); i++ {
		if time.Duration(observed[i]-observed[i-1]) < 950*time.Millisecond {
			t.Fatalf("cross-process requests not spaced: %v", observed)
		}
	}
}

func TestCrossLanguageCooldowns(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	const cooldownSource = "import sys; from ldos_gallery.danbooru_rate import cooldown; cooldown(sys.argv[1], '2')"
	if output, err := pythonCommand(t, ctx, cooldownSource, path).CombinedOutput(); err != nil {
		t.Fatal(err, string(output))
	}
	short, stop := context.WithTimeout(ctx, 60*time.Millisecond)
	defer stop()
	if err := Wait(short, path); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Go ignored Python cooldown: %v", err)
	}
	if err := Cooldown(ctx, path, "3"); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	const waitSource = "import sys; from ldos_gallery.danbooru_rate import wait; wait(sys.argv[1])"
	if output, err := pythonCommand(t, ctx, waitSource, path).CombinedOutput(); err != nil {
		t.Fatal(err, string(output))
	}
	if time.Since(start) < 2900*time.Millisecond {
		t.Fatal("Python ignored Go cooldown")
	}
}
