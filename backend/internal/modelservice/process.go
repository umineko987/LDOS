package modelservice

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Command is the standalone computation boundary. Input never becomes argv.
type Command struct {
	Executable string
	Args, Env  []string
	Dir        string
	Input      io.Reader
	Grace      time.Duration
}

// RunCommand drains stdout and stderr concurrently, reaps the child, bounds
// diagnostics, and terminates its process group on cancellation.
func RunCommand(ctx context.Context, c Command, line func(string)) (string, error) {
	cmd := exec.CommandContext(ctx, c.Executable, c.Args...)
	cmd.Dir = c.Dir
	cmd.Env = c.Env
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	cmd.Stdin = c.Input
	prepareProcess(cmd)
	cmd.Cancel = func() error { return terminateProcess(cmd) }
	cmd.WaitDelay = c.Grace
	if cmd.WaitDelay <= 0 {
		cmd.WaitDelay = time.Second
	}
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		return "", e
	}
	stderr, e := cmd.StderrPipe()
	if e != nil {
		return "", e
	}
	if e = cmd.Start(); e != nil {
		return "", e
	}
	var wg sync.WaitGroup
	var scanErr error
	var tail tailBuffer
	wg.Add(2)
	go func() {
		defer wg.Done()
		scan := bufio.NewScanner(stdout)
		scan.Buffer(make([]byte, 64<<10), 16<<20)
		for scan.Scan() {
			if line != nil {
				line(scan.Text())
			}
		}
		scanErr = scan.Err()
		if scanErr != nil {
			_ = killProcess(cmd)
		}
	}()
	go func() { defer wg.Done(); _, _ = io.Copy(&tail, stderr) }()
	// Waiting drives CommandContext's grace timeout while output is drained by
	// writer goroutines. StdoutPipe readers must finish before Wait closes them.
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = terminateProcess(cmd)
			timer := time.NewTimer(cmd.WaitDelay)
			defer timer.Stop()
			select {
			case <-timer.C:
				_ = killProcess(cmd)
			case <-done:
			}
		case <-done:
		}
	}()
	wg.Wait()
	e = cmd.Wait()
	close(done)
	if ctx.Err() != nil {
		e = ctx.Err()
	}
	if scanErr != nil && !errors.Is(scanErr, os.ErrClosed) {
		e = scanErr
	}
	return strings.TrimSpace(string(tail.data)), e
}

type tailBuffer struct{ data []byte }

func (b *tailBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if n >= 4096 {
		b.data = append(b.data[:0], p[n-4096:]...)
	} else {
		b.data = append(b.data, p...)
		if len(b.data) > 4096 {
			b.data = b.data[len(b.data)-4096:]
		}
	}
	return n, nil
}

// OfflineEnvironment removes inherited download credentials/proxies and forces
// model libraries to consume the already installed bundles.
func OfflineEnvironment() []string {
	env := []string{}
	for _, v := range os.Environ() {
		k, _, _ := strings.Cut(v, "=")
		switch strings.ToUpper(k) {
		case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HF_ENDPOINT", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE":
			continue
		}
		env = append(env, v)
	}
	return append(env, "HF_HUB_OFFLINE=1", "TRANSFORMERS_OFFLINE=1")
}
