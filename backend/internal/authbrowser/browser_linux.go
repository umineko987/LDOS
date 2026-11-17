//go:build linux

package authbrowser

import (
	"context"
	"net"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

const startupTimeout = 15 * time.Second

// Browser owns exactly one process group. Ensure's context covers startup, not
// the lifetime of a successfully started shared host. Stop ends that lifetime.
type Browser struct {
	profileDir string
	gate       chan struct{}
	mu         sync.Mutex
	host       *host
}

type host struct {
	cmd      *exec.Cmd
	port     int
	endpoint string // guarded by Browser.mu
	proxy    string
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{} // closed only after Wait and group cleanup
}

func New(profileDir string) *Browser {
	path := ""
	if profileDir != "" && profileDir != "." {
		if absolute, err := filepath.Abs(profileDir); err == nil && absolute != "/" {
			path = absolute
		}
	}
	return &Browser{profileDir: path, gate: make(chan struct{}, 1)}
}

func (b *Browser) acquire(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case b.gate <- struct{}{}:
		if err := ctx.Err(); err != nil {
			b.release()
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (b *Browser) release() { <-b.gate }

func (b *Browser) Running() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.host != nil && b.host.endpoint != "" && b.host.ctx.Err() == nil
}

// Proxy returns the configured proxy for host reuse decisions; callers must not
// expose it directly because the original URL can include credentials.
func (b *Browser) Proxy() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.host == nil || b.host.ctx.Err() != nil {
		return ""
	}
	return b.host.proxy
}

func (b *Browser) cancelHost() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.host != nil {
		b.host.cancel()
	}
}

func (b *Browser) Ensure(ctx context.Context, executable, proxy string) error {
	if err := b.acquire(ctx); err != nil {
		return err
	}
	defer b.release()
	ctx, cancel := context.WithTimeout(ctx, startupTimeout)
	defer cancel()
	proxyArg, err := chromeProxy(proxy)
	if err != nil {
		return err
	}
	b.mu.Lock()
	h := b.host
	b.mu.Unlock()
	if h != nil && h.ctx.Err() == nil && h.proxy == proxy {
		probeCtx, finish := hostContext(ctx, h, time.Second)
		endpoint, probeErr := browserEndpoint(probeCtx, h.port)
		finish()
		if probeErr == nil && ctx.Err() == nil && h.ctx.Err() == nil {
			b.mu.Lock()
			h.endpoint = endpoint
			b.mu.Unlock()
			return nil
		}
	}
	if err := b.stopLocked(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	path, _, err := Discover(executable)
	if err != nil {
		return err
	}
	if err := prepareProfile(b.profileDir); err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return ErrStart
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	args := []string{
		"--user-data-dir=" + b.profileDir, "--profile-directory=Default",
		"--remote-debugging-port=" + strconv.Itoa(port), "--remote-debugging-address=127.0.0.1",
		"--start-maximized", "--no-first-run", "--no-default-browser-check", "--disable-default-apps",
	}
	if proxyArg != "" {
		args = append(args, "--proxy-server="+proxyArg)
	}
	args = append(args, "about:blank")
	cmd := exec.Command(path, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return ErrStart
	}
	life, lifeCancel := context.WithCancel(context.Background())
	h = &host{cmd: cmd, port: port, proxy: proxy, ctx: life, cancel: lifeCancel, done: make(chan struct{})}
	b.mu.Lock()
	b.host = h
	b.mu.Unlock()
	go func() {
		_ = cmd.Wait()
		// A launcher can exit while renderer descendants remain alive.
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		lifeCancel()
		close(h.done)
	}()
	startupCtx, finish := hostContext(ctx, h, startupTimeout)
	defer finish()
	for {
		endpoint, probeErr := browserEndpoint(startupCtx, port)
		if probeErr == nil && startupCtx.Err() == nil {
			b.mu.Lock()
			h.endpoint = endpoint
			b.mu.Unlock()
			return nil
		}
		if err := pause(startupCtx, 100*time.Millisecond); err != nil {
			stopErr := b.stopLocked()
			if stopErr != nil {
				return stopErr
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return ErrStart
		}
	}
}

func (b *Browser) Stop() error {
	// Interrupt startup and active CDP calls before waiting for lifecycle serialization.
	b.cancelHost()
	if err := b.acquire(nil); err != nil {
		return err
	}
	defer b.release()
	return b.stopLocked()
}

func (b *Browser) stopLocked() error {
	b.mu.Lock()
	h := b.host
	b.mu.Unlock()
	if h == nil {
		return nil
	}
	h.cancel()
	gracefulClose(h)
	select {
	case <-h.done:
	default:
		_ = syscall.Kill(-h.cmd.Process.Pid, syscall.SIGTERM)
		timer := time.NewTimer(2 * time.Second)
		select {
		case <-h.done:
		case <-timer.C:
		}
		timer.Stop()
		select {
		case <-h.done:
		default:
			_ = syscall.Kill(-h.cmd.Process.Pid, syscall.SIGKILL)
			timer = time.NewTimer(5 * time.Second)
			defer timer.Stop()
			select {
			case <-h.done:
			case <-timer.C:
				return ErrStop
			}
		}
	}
	b.mu.Lock()
	b.host = nil
	b.mu.Unlock()
	return nil
}

// Give Chromium a chance to flush profile data. Failure never prevents group
// termination, and this private request is independent of cancelled session work.
func gracefulClose(h *host) {
	if h.endpoint == "" {
		return
	}
	select {
	case <-h.done:
		return
	default:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	conn, err := dialCDP(ctx, h.endpoint, h.port, "browser")
	if err != nil {
		return
	}
	defer conn.close()
	_ = conn.command("Browser.close", nil, nil, nil)
	select {
	case <-h.done:
	case <-ctx.Done():
	}
}
func hostContext(ctx context.Context, h *host, timeout time.Duration) (context.Context, context.CancelFunc) {
	child, cancel := context.WithTimeout(ctx, timeout)
	stop := context.AfterFunc(h.ctx, cancel)
	if h.ctx.Err() != nil {
		cancel()
	}
	return child, func() { stop(); cancel() }
}

func (b *Browser) connection(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc, string, int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	h := b.host
	if h == nil || h.endpoint == "" || h.ctx.Err() != nil {
		return nil, nil, "", 0, ErrStopped
	}
	child, cancel := hostContext(ctx, h, timeout)
	return child, cancel, h.endpoint, h.port, nil
}

func pause(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
