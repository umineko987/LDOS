//go:build linux

// Package proxytransport owns native proxy processes and local authenticated transports.
package proxytransport

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"ldos/backend/internal/proxyparse"
)

type CoreSettings struct {
	BinaryPath, ExpectedSHA256, RuntimeDir, ProjectBinDir string
	BasePort                                              int
	StartTimeout                                          time.Duration
}

type Endpoint struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	SourceProtocol string `json:"source_protocol"`
	SourceHost     string `json:"source_host"`
	LocalHTTP      string `json:"local_http"`
}

type coreProcess struct {
	cmd  *exec.Cmd
	done chan struct{}
}

type Core struct {
	settings                           CoreSettings
	lifecycle                          sync.Mutex
	mu                                 sync.Mutex
	cancel                             context.CancelFunc
	process                            *coreProcess
	endpoints                          []Endpoint
	binary, digest, version, lastError string
	basePort                           int
}

func NewCore(settings CoreSettings) *Core {
	if settings.StartTimeout < time.Second {
		settings.StartTimeout = time.Second
	}
	settings.ExpectedSHA256 = strings.ToLower(strings.TrimSpace(settings.ExpectedSHA256))
	return &Core{settings: settings, basePort: settings.BasePort}
}

// Start's context controls startup. A successfully started process is owned by Core
// until Stop or the next Start, independently of the caller's request context.
func (c *Core) Start(ctx context.Context, nodes []proxyparse.Node) (endpoints []Endpoint, err error) {
	c.lifecycle.Lock()
	defer c.lifecycle.Unlock()
	c.stopProcess()
	ctx, cancel := context.WithCancel(ctx)
	c.mu.Lock()
	c.cancel = cancel
	c.mu.Unlock()
	defer func() {
		cancel()
		c.mu.Lock()
		c.cancel = nil
		if err != nil {
			c.lastError = err.Error()
		}
		c.mu.Unlock()
	}()
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	binary, digest, err := resolveBinary(c.settings)
	if err != nil {
		return nil, err
	}
	_, prepared, err := BuildConfig(nodes, "127.0.0.1", 1)
	if err != nil {
		return nil, err
	}
	if len(prepared) == 0 {
		return nil, errors.New("订阅中未发现代理核心可加载的节点")
	}
	basePort, err := findPortBlock(ctx, c.basePort, len(prepared))
	if err != nil {
		return nil, err
	}
	config, endpoints, err := BuildConfig(nodes, "127.0.0.1", basePort)
	if err != nil {
		return nil, err
	}
	data, err := pythonYAML(config)
	if err != nil {
		return nil, errors.New("代理核心配置无法序列化")
	}
	runtimeDir, err := filepath.Abs(c.settings.RuntimeDir)
	if err != nil {
		return nil, err
	}
	dir, err := privateDirectory(runtimeDir)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	configFile, err := privateFile(dir, "config.yaml", false)
	if err != nil {
		return nil, err
	}
	_, err = configFile.WriteString(data)
	closeErr := configFile.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, fmt.Errorf("写入代理核心配置失败: %w", err)
	}
	configPath := filepath.Join(runtimeDir, "config.yaml")
	validationCtx, validationCancel := context.WithTimeout(ctx, 30*time.Second)
	_, err = runCoreCommand(validationCtx, binary, "-t", "-f", configPath, "-d", runtimeDir)
	validationCancel()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// Core diagnostics can echo an entire private node. Keep credentials out of status.
		return nil, fmt.Errorf("代理核心配置校验失败: %w", err)
	}
	logFile, err := privateFile(dir, "core.log", true)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(binary, "-f", configPath, "-d", runtimeDir)
	cmd.Dir, cmd.Stdout, cmd.Stderr = runtimeDir, logFile, logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err = cmd.Start(); err != nil {
		logFile.Close()
		return nil, err
	}
	process := &coreProcess{cmd: cmd, done: make(chan struct{})}
	go func() { _ = cmd.Wait(); _ = logFile.Close(); close(process.done) }()
	started := false
	defer func() {
		if !started {
			terminateCore(process)
		}
	}()
	readyCtx, readyCancel := context.WithTimeout(ctx, c.settings.StartTimeout)
	err = waitReady(readyCtx, process, endpoints)
	readyCancel()
	if err != nil {
		return nil, err
	}
	versionCtx, versionCancel := context.WithTimeout(ctx, 5*time.Second)
	version, _ := runCoreCommand(versionCtx, binary, "-v")
	versionCancel()
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case <-process.done:
		return nil, errors.New("代理核心启动后已退出")
	default:
	}
	c.mu.Lock()
	c.process, c.endpoints = process, endpoints
	c.binary, c.digest = binary, digest
	c.version = truncateRunes(strings.Join(strings.Fields(version), " "), 200)
	c.lastError, c.basePort = "", basePort
	c.mu.Unlock()
	started = true
	return append([]Endpoint(nil), endpoints...), nil
}

func (c *Core) Stop() error {
	c.mu.Lock()
	if c.cancel != nil {
		c.cancel()
	}
	c.mu.Unlock()
	c.lifecycle.Lock()
	defer c.lifecycle.Unlock()
	c.stopProcess()
	return nil
}

func (c *Core) stopProcess() {
	c.mu.Lock()
	process := c.process
	c.process, c.endpoints = nil, nil
	c.mu.Unlock()
	if process != nil {
		terminateCore(process)
	}
}

func terminateCore(p *coreProcess) {
	select {
	case <-p.done:
		return
	default:
	}
	_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGTERM)
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-p.done:
	case <-timer.C:
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
		<-p.done
	}
}

func (c *Core) Status() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	running := c.process != nil
	if running {
		select {
		case <-c.process.done:
			running = false
		default:
		}
	}
	var pid, port any
	if running {
		pid = c.process.cmd.Process.Pid
	}
	if len(c.endpoints) != 0 {
		port = c.basePort
	}
	binary := ""
	if c.binary != "" {
		binary = filepath.Base(c.binary)
	}
	return map[string]any{"enabled": true, "running": running, "pid": pid, "version": c.version, "binary": binary, "sha256": c.digest, "listeners": len(c.endpoints), "base_port": port, "last_error": c.lastError}
}

// cappedOutput bounds untrusted version/validation output while allowing the child to drain.
type cappedOutput struct{ data []byte }

func (b *cappedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if room := 4096 - len(b.data); room > 0 {
		b.data = append(b.data, p[:min(room, n)]...)
	}
	return n, nil
}

func runCoreCommand(ctx context.Context, binary string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	var stdout, stderr cappedOutput
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		err = ctx.Err()
	}
	if len(stdout.data) != 0 {
		return strings.ToValidUTF8(string(stdout.data), "�"), err
	}
	return strings.ToValidUTF8(string(stderr.data), "�"), err
}

// ResolveCoreBinary checks the same executable and configured digest as Start,
// without starting a proxy process or creating runtime files.
func ResolveCoreBinary(settings CoreSettings) (string, error) {
	path, _, err := resolveBinary(settings)
	return path, err
}

func resolveBinary(s CoreSettings) (string, string, error) {
	names := []string{"proxy-core", "mihomo", "verge-mihomo"}
	var candidates []string
	if s.BinaryPath != "" {
		candidate := s.BinaryPath
		if candidate == "~" || strings.HasPrefix(candidate, "~/") {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", "", err
			}
			candidate = filepath.Join(home, strings.TrimPrefix(candidate, "~/"))
		}
		candidates = append(candidates, candidate)
	} else {
		if s.ProjectBinDir != "" {
			for _, name := range names {
				candidates = append(candidates, filepath.Join(s.ProjectBinDir, name))
			}
		}
		for _, name := range names {
			if p, err := exec.LookPath(name); err == nil {
				candidates = append(candidates, p)
			}
		}
	}
	nonExecutable := ""
	for _, candidate := range candidates {
		path, err := filepath.EvalSymlinks(candidate)
		if err != nil {
			continue
		}
		path, err = filepath.Abs(path)
		if err != nil {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if unix.Access(path, unix.X_OK) != nil {
			nonExecutable = path
			continue
		}
		file, err := os.Open(path)
		if err != nil {
			return "", "", err
		}
		digest := sha256.New()
		_, err = io.Copy(digest, file)
		_ = file.Close()
		if err != nil {
			return "", "", err
		}
		actual := fmt.Sprintf("%x", digest.Sum(nil))
		expected := strings.ToLower(strings.TrimSpace(s.ExpectedSHA256))
		if expected != "" && subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) != 1 {
			return "", "", fmt.Errorf("代理传输核心 SHA-256 校验失败: expected=%s, actual=%s", expected, actual)
		}
		return path, actual, nil
	}
	if nonExecutable != "" {
		return "", "", fmt.Errorf("代理传输核心没有执行权限: %s", nonExecutable)
	}
	if s.BinaryPath != "" {
		return "", "", fmt.Errorf("代理传输核心文件不存在: %s", s.BinaryPath)
	}
	return "", "", errors.New("代理传输核心文件不存在；请安装 mihomo 或设置 proxy.transport_core_binary")
}

func findPortBlock(ctx context.Context, preferred, count int) (int, error) {
	if count <= 0 {
		return 0, errors.New("代理核心节点列表为空")
	}
	starts := []int{preferred}
	for start := max(20000, preferred+100); start < 65000-count; start += max(100, count+8) {
		starts = append(starts, start)
	}
	for _, start := range starts {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		if start < 1024 || start > 65535-count+1 {
			continue
		}
		free := true
		for offset := 0; offset < count; offset++ {
			l, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(start+offset)))
			if err != nil {
				free = false
				break
			}
			_ = l.Close()
		}
		if free {
			return start, nil
		}
	}
	return 0, errors.New("未找到可用的连续本地代理端口")
}

func waitReady(ctx context.Context, p *coreProcess, endpoints []Endpoint) error {
	pending := make(map[string]bool, len(endpoints))
	for _, ep := range endpoints {
		u, _ := url.Parse(ep.LocalHTTP)
		pending[u.Host] = true
	}
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for len(pending) > 0 {
		select {
		case <-ctx.Done():
			return fmt.Errorf("代理核心启动失败，%d 个监听端口尚未就绪: %w", len(pending), ctx.Err())
		case <-p.done:
			return fmt.Errorf("代理核心启动失败，%d 个监听端口尚未就绪", len(pending))
		default:
		}
		for address := range pending {
			conn, err := (&net.Dialer{Timeout: 150 * time.Millisecond}).DialContext(ctx, "tcp", address)
			if err == nil {
				_ = conn.Close()
				delete(pending, address)
			}
		}
		if len(pending) > 0 {
			select {
			case <-ctx.Done():
			case <-p.done:
			case <-ticker.C:
			}
		}
	}
	return nil
}

// Walk with directory descriptors so neither existing path components nor files
// can be followed through a symlink while permissions are tightened.
func privateDirectory(path string) (*os.File, error) {
	if path == string(filepath.Separator) {
		return nil, errors.New("代理运行目录不能是根目录")
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range strings.Split(strings.TrimPrefix(filepath.Clean(path), "/"), "/") {
		next, openErr := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		if errors.Is(openErr, unix.ENOENT) {
			if e := unix.Mkdirat(fd, part, 0700); e != nil && !errors.Is(e, unix.EEXIST) {
				unix.Close(fd)
				return nil, e
			}
			next, openErr = unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		}
		unix.Close(fd)
		if openErr != nil {
			return nil, fmt.Errorf("无法安全打开代理运行目录（禁止符号链接）: %w", openErr)
		}
		fd = next
	}
	if err := unix.Fchmod(fd, 0700); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

func privateFile(dir *os.File, name string, appendMode bool) (*os.File, error) {
	flags := unix.O_WRONLY | unix.O_CREAT | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
	if appendMode {
		flags |= unix.O_APPEND
	}
	fd, err := unix.Openat(int(dir.Fd()), name, flags, 0600)
	if err != nil {
		return nil, fmt.Errorf("无法安全打开代理私有文件 %s: %w", name, err)
	}
	f := os.NewFile(uintptr(fd), filepath.Join(dir.Name(), name))
	info, err := f.Stat()
	if err == nil && !info.Mode().IsRegular() {
		err = errors.New("代理私有文件不是普通文件")
	}
	if err == nil {
		err = f.Chmod(0600)
	}
	if err == nil && !appendMode {
		err = f.Truncate(0)
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
