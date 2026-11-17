package gallery

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Cancel waits for the active operation's process group and pipe cleanup. The
// corresponding Run or Capture returns context.Canceled. An unknown ID is false.
func (r *Runner) Cancel(id string) bool {
	r.mu.Lock()
	active := r.active[id]
	r.mu.Unlock()
	if active == nil {
		return false
	}
	active.cancel()
	<-active.done
	return true
}

// StopAll cancels the current snapshot concurrently and waits for cleanup. The
// scheduler must stop submitting new work first; the Runner remains reusable.
func (r *Runner) StopAll() {
	r.mu.Lock()
	active := make([]*activeProcess, 0, len(r.active))
	for _, process := range r.active {
		active = append(active, process)
		process.cancel()
	}
	r.mu.Unlock()
	for _, process := range active {
		<-process.done
	}
}

func (r *Runner) ActiveCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.active)
}

type streamReader func(io.Reader, string) error

type executionResult struct {
	process ProcessResult
	err     error
}

func (r *Runner) execute(ctx context.Context, req Request, p *preparedProcess, stall time.Duration, read streamReader) (ProcessResult, error) {
	result := ProcessResult{ExitCode: -1, Marker: p.marker}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	stdout, stdoutWriter, err := os.Pipe()
	if err != nil {
		return result, err
	}
	defer stdout.Close()
	defer stdoutWriter.Close()
	stderr, stderrWriter, err := os.Pipe()
	if err != nil {
		return result, err
	}
	defer stderr.Close()
	defer stderrWriter.Close()
	p.cmd.Stdout, p.cmd.Stderr = stdoutWriter, stderrWriter
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	active := &activeProcess{cancel: cancel, done: make(chan struct{})}
	// Starting and registering under one lock prevents StopAll missing a child
	// between Start and registration, or duplicate IDs hiding a live worker.
	r.mu.Lock()
	if r.active[req.ID] != nil {
		r.mu.Unlock()
		return result, fmt.Errorf("gallery operation already active: %s", req.ID)
	}
	err = runCtx.Err()
	if err == nil {
		err = p.cmd.Start()
	}
	if err != nil {
		r.mu.Unlock()
		return result, err
	}
	r.active[req.ID] = active
	r.mu.Unlock()
	result.PID = p.cmd.Process.Pid
	stdoutWriter.Close()
	stderrWriter.Close()

	readErrors := make(chan error, 2)
	readDone := make(chan struct{})
	var readers sync.WaitGroup
	for name, pipe := range map[string]*os.File{"stdout": stdout, "stderr": stderr} {
		readers.Add(1)
		go func() {
			defer readers.Done()
			if err := read(pipe, name); err != nil {
				readErrors <- err
				// After a capture limit or reader error, continue draining until
				// the supervisor has terminated the group and closed the pipes.
				_, _ = io.Copy(io.Discard, pipe)
			}
		}()
	}
	go func() { readers.Wait(); close(readDone) }()
	wait := make(chan error, 1)
	go func() { wait <- p.cmd.Wait() }()
	finished := make(chan executionResult, 1)
	go func() {
		result, err := r.supervise(runCtx, req, p, result, stall, wait, readErrors, readDone)
		// A child may have inherited a pipe even after the worker exited.
		stdout.Close()
		stderr.Close()
		<-readDone
		for _, path := range []string{p.activity, p.started} {
			if path != "" {
				_ = os.Remove(path)
			}
		}
		r.mu.Lock()
		delete(r.active, req.ID)
		r.mu.Unlock()
		close(active.done)
		finished <- executionResult{result, err}
	}()
	var startedErr error
	if req.OnStarted != nil {
		startedErr = req.OnStarted(result.PID, result.Marker)
		if startedErr != nil {
			cancel()
		}
	}
	out := <-finished
	if startedErr != nil {
		return out.process, startedErr
	}
	return out.process, out.err
}

func (r *Runner) supervise(ctx context.Context, req Request, p *preparedProcess, result ProcessResult, stall time.Duration, wait <-chan error, readErrors <-chan error, readDone <-chan struct{}) (ProcessResult, error) {
	var timeout <-chan time.Time
	if req.TaskTimeout > 0 {
		timer := time.NewTimer(req.TaskTimeout)
		defer timer.Stop()
		timeout = timer.C
	}
	var heartbeat <-chan time.Time
	if stall > 0 {
		ticker := time.NewTicker(min(time.Second, max(200*time.Millisecond, stall/10)))
		defer ticker.Stop()
		heartbeat = ticker.C
	}
	var lastProgress, lastMtime time.Time
	var runErr, waitErr error
	waited := false
monitor:
	for {
		select {
		case waitErr = <-wait:
			waited = true
			break monitor
		case <-ctx.Done():
			runErr = ctx.Err()
			break monitor
		case runErr = <-readErrors:
			break monitor
		case <-timeout:
			result.TimedOut = true
			break monitor
		case <-heartbeat:
			now := time.Now()
			if lastProgress.IsZero() {
				info, err := os.Stat(p.started)
				if err != nil || !info.Mode().IsRegular() {
					continue // Extraction/login is not a stalled body transfer.
				}
				lastProgress = now
			}
			if info, err := os.Stat(p.activity); err == nil && info.ModTime().After(lastMtime) {
				lastMtime, lastProgress = info.ModTime(), now
			}
			if now.Sub(lastProgress) >= stall {
				result.TimedOut = true
				break monitor
			}
		}
	}
	// Always clean up the group, including when its leader has already exited.
	// Waiting only on the leader would leave TERM-ignoring descendants alive.
	if err := terminateGroup(context.Background(), result.PID, r.settings.TerminateGrace); err != nil && runErr == nil {
		runErr = err
	}
	if !waited {
		waitErr = <-wait
	}
	if waitErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(waitErr, &exitErr) && runErr == nil {
			runErr = waitErr
		}
	}
	result.ExitCode = p.cmd.ProcessState.ExitCode()
	if status, ok := p.cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		result.ExitCode = -int(status.Signal())
	}
	drain := time.NewTimer(max(2*time.Second, r.settings.TerminateGrace))
	defer drain.Stop()
	select {
	case <-readDone:
	case <-drain.C:
	}
	// A short-lived worker can exit before the reader reports a capture limit.
	select {
	case err := <-readErrors:
		if runErr == nil {
			runErr = err
		}
	default:
	}
	return result, runErr
}

func terminateGroup(ctx context.Context, pid int, grace time.Duration) error {
	if err := syscall.Kill(-pid, syscall.SIGTERM); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	timer := time.NewTimer(max(200*time.Millisecond, grace))
	defer timer.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := syscall.Kill(-pid, 0); errors.Is(err, syscall.ESRCH) {
			return nil
		} else if err != nil {
			return err
		}
		select {
		case <-ticker.C:
		case <-timer.C:
			err := syscall.Kill(-pid, syscall.SIGKILL)
			if errors.Is(err, syscall.ESRCH) {
				return nil
			}
			return err
		case <-ctx.Done():
			// Cancellation must not leave an already-identified stale group alive.
			_ = syscall.Kill(-pid, syscall.SIGKILL)
			return ctx.Err()
		}
	}
}

// TerminateStaleProcess acts only on a session/group leader whose NUL-separated
// /proc argv contains the exact Python module and --marker value before the
// gallery argument separator. A nonmatching or vanished PID returns false.
// Stale processes are not our children and therefore cannot be reaped here.
func TerminateStaleProcess(ctx context.Context, pid int, marker string, grace time.Duration) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if pid <= 1 || marker == "" {
		return false, nil
	}
	command, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !matchesWorker(command, marker) {
		return false, nil
	}
	group, err := syscall.Getpgid(pid)
	if errors.Is(err, syscall.ESRCH) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if group != pid {
		return false, nil
	}
	return true, terminateGroup(ctx, pid, grace)
}

func matchesWorker(command []byte, marker string) bool {
	args := strings.Split(string(bytes.TrimRight(command, "\x00")), "\x00")
	// Match only our generated interpreter invocation, not a script's arguments
	// containing the same tokens (for example python -c code -m worker_entry).
	// Recovery may encounter a persisted pre-split worker; never launch that module.
	// Its exact identity is accepted only here to prevent duplicate resumed downloads.
	if len(args) < 4 || args[1] != "-m" || (args[2] != workerModule && args[2] != "gdl_backend.worker_entry") {
		return false
	}
	const module = 2
	matched, resolve := false, false
	for i := module + 1; i < len(args); i++ {
		switch args[i] {
		case "--":
			return matched
		case "--resolve", "--danbooru-auth":
			if resolve {
				return false
			}
			resolve = true
		case "--marker", "--gallery-root":
			if i+1 >= len(args) {
				return false
			}
			if args[i] == "--marker" {
				if matched || args[i+1] != marker {
					return false
				}
				matched = true
			}
			i++
		default:
			return false
		}
	}
	return false
}
