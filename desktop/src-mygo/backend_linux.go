package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type BackendState string

const (
	BackendStarting BackendState = "starting"
	BackendReady    BackendState = "ready"
	BackendFailed   BackendState = "failed"
	BackendStopped  BackendState = "stopped"
)

// RuntimeMetadata contains public connection metadata, never configuration paths.
type RuntimeMetadata struct {
	APIOrigin      string  `json:"apiOrigin"`
	BackendVersion *string `json:"backendVersion"`
}

type BackendStatus struct {
	State BackendState `json:"state"`
	Code  *string      `json:"code"`
}

type supervisorTiming struct {
	startup, probe, io, shutdown, terminate time.Duration
}

var defaultTiming = supervisorTiming{startup: 180 * time.Second, probe: 100 * time.Millisecond, io: time.Second, shutdown: 30 * time.Second, terminate: 2 * time.Second}

type backendManager struct {
	mu       sync.RWMutex
	status   BackendStatus
	metadata *RuntimeMetadata
	ctx      context.Context
	cancel   context.CancelFunc
	started  bool
	done     chan struct{}
	timing   supervisorTiming
}

func newBackendManager(timing supervisorTiming) *backendManager {
	ctx, cancel := context.WithCancel(context.Background())
	return &backendManager{status: BackendStatus{State: BackendStarting}, ctx: ctx, cancel: cancel, done: make(chan struct{}), timing: timing}
}

func (m *backendManager) currentStatus() BackendStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

func (m *backendManager) runtimeMetadata() (RuntimeMetadata, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.metadata == nil {
		return RuntimeMetadata{}, errors.New("backend_not_ready")
	}
	return *m.metadata, nil
}

func (m *backendManager) publish(state BackendState, code string, metadata *RuntimeMetadata) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx.Err() != nil {
		return
	}
	m.status = BackendStatus{State: state}
	if code != "" {
		m.status.Code = &code
	}
	m.metadata = metadata
}

func (m *backendManager) start(spec func() (launchSpec, error)) {
	m.mu.Lock()
	if m.started || m.ctx.Err() != nil {
		m.mu.Unlock()
		return
	}
	m.started = true
	m.mu.Unlock()
	go func() { defer close(m.done); m.run(spec) }()
}

func (m *backendManager) shutdown() {
	m.mu.Lock()
	m.cancel()
	started := m.started
	m.mu.Unlock()
	if started {
		<-m.done
	}
	m.mu.Lock()
	m.status, m.metadata = BackendStatus{State: BackendStopped}, nil
	m.mu.Unlock()
}

func (m *backendManager) run(resolve func() (launchSpec, error)) {
	if m.ctx.Err() != nil {
		return
	}
	spec, err := resolve()
	if err != nil {
		m.publish(BackendFailed, "backend_config_invalid", nil)
		return
	}
	if m.ctx.Err() != nil {
		return
	}
	process, err := spawnProcess(spec.command())
	if err != nil {
		m.publish(BackendFailed, "backend_start_failed", nil)
		return
	}
	defer process.shutdown(m.timing.shutdown, m.timing.terminate)
	probeCtx, cancel := context.WithTimeout(m.ctx, m.timing.startup)
	defer cancel()
	client := probeClient(m.timing.io)
	defer client.CloseIdleConnections()
	for {
		if m.ctx.Err() != nil {
			return
		}
		if process.exited() {
			m.publish(BackendFailed, "backend_exited", nil)
			return
		}
		metadata, err := probeBackend(probeCtx, client, spec.endpoint)
		if err == nil && !process.exited() {
			m.publish(BackendReady, "", &metadata)
			break
		}
		if probeCtx.Err() != nil {
			m.publish(BackendFailed, "backend_start_timeout", nil)
			return
		}
		select {
		case <-m.ctx.Done():
			return
		case <-process.done:
			m.publish(BackendFailed, "backend_exited", nil)
			return
		case <-time.After(m.timing.probe):
		}
	}
	select {
	case <-m.ctx.Done():
	case <-process.done:
		m.publish(BackendFailed, "backend_exited", nil)
	}
}

// Never honor HTTP proxies, redirects, or DNS answers outside loopback.
func probeClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: timeout}
	transport := &http.Transport{
		DisableKeepAlives:      true,
		ResponseHeaderTimeout:  timeout,
		MaxResponseHeaderBytes: 64 * 1024,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			var lastErr error
			for _, address := range addresses {
				if !address.IP.IsLoopback() {
					continue
				}
				conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(address.IP.String(), port))
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			if lastErr == nil {
				lastErr = errors.New("no loopback address")
			}
			return nil, lastErr
		},
	}
	return &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func requestJSON(ctx context.Context, client *http.Client, ep endpoint, path string, value any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+ep.authority()+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	response, err := client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("backend response status invalid")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil || len(body) > 64*1024 {
		return errors.New("backend response limit exceeded")
	}
	return json.Unmarshal(body, value)
}

func probeBackend(ctx context.Context, client *http.Client, ep endpoint) (RuntimeMetadata, error) {
	var health struct {
		OK bool `json:"ok"`
	}
	if err := requestJSON(ctx, client, ep, "/healthz", &health); err != nil {
		return RuntimeMetadata{}, err
	}
	if !health.OK {
		return RuntimeMetadata{}, errors.New("backend unhealthy")
	}
	var root struct {
		Version string `json:"version"`
	}
	if err := requestJSON(ctx, client, ep, "/", &root); err != nil {
		return RuntimeMetadata{}, err
	}
	if !validVersion(root.Version) {
		return RuntimeMetadata{}, errors.New("backend version invalid")
	}
	return RuntimeMetadata{ep.apiOrigin(), &root.Version}, nil
}

func validVersion(version string) bool {
	if len(version) == 0 || len(version) > 64 {
		return false
	}
	for i, c := range []byte(version) {
		if c >= '0' && c <= '9' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' {
			continue
		}
		if i > 0 && (c == '.' || c == '+' || c == '_' || c == '-') {
			continue
		}
		return false
	}
	return true
}

func endpointForAddress(address string) (endpoint, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return endpoint{}, err
	}
	n, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		return endpoint{}, err
	}
	return newEndpoint(host, n)
}
