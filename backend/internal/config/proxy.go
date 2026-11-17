package config

import (
	"encoding/hex"
	"errors"
	"math"
	"path/filepath"
	"strings"
	"time"

	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/proxysources"
)

type Proxy struct {
	Enabled                          bool     `json:"enabled"`
	AutoStart                        bool     `json:"auto_start"`
	Engine                           string   `json:"engine"`
	SubscriptionURLs                 []string `json:"subscription_urls"`
	NodeFile                         string   `json:"node_file"`
	InlineNodes                      []string `json:"inline_nodes"`
	AllowedNodeRoots                 []string `json:"allowed_node_roots"`
	AllowSocks                       bool     `json:"allow_socks"`
	ProbeURL                         string   `json:"probe_url"`
	ProbeTimeoutSeconds              float64  `json:"probe_timeout_seconds"`
	ProbeWorkers                     int      `json:"probe_workers"`
	ProbeCacheTTLSeconds             float64  `json:"probe_cache_ttl_seconds"`
	HealthIntervalSeconds            float64  `json:"health_interval_seconds"`
	FailCooldownSeconds              float64  `json:"fail_cooldown_seconds"`
	SubscriptionTimeoutSeconds       float64  `json:"subscription_timeout_seconds"`
	TransportCoreEnabled             bool     `json:"transport_core_enabled"`
	TransportCoreBinary              string   `json:"transport_core_binary"`
	TransportCoreSHA256              string   `json:"transport_core_sha256"`
	TransportCoreBasePort            int      `json:"transport_core_base_port"`
	TransportCoreStartTimeoutSeconds float64  `json:"transport_core_start_timeout_seconds"`
}

func defaultProxy() Proxy {
	return Proxy{Enabled: true, AutoStart: true, Engine: "native", AllowSocks: true, ProbeURL: "https://example.com/", ProbeTimeoutSeconds: 10, ProbeWorkers: 32, ProbeCacheTTLSeconds: 600, HealthIntervalSeconds: 60, FailCooldownSeconds: 30, SubscriptionTimeoutSeconds: 20, TransportCoreEnabled: true, TransportCoreBasePort: 29000, TransportCoreStartTimeoutSeconds: 15}
}
func (s *Settings) normalizeProxy() error {
	p := &s.Proxy
	if p.Engine != "native" {
		return errors.New("proxy.engine 当前支持 native")
	}
	maxSeconds := float64(math.MaxInt64) / float64(time.Second)
	for _, seconds := range []float64{p.ProbeTimeoutSeconds, p.SubscriptionTimeoutSeconds, p.HealthIntervalSeconds, p.FailCooldownSeconds, p.TransportCoreStartTimeoutSeconds} {
		if math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds <= 0 || seconds >= maxSeconds {
			return errors.New("代理超时和间隔必须是大于 0 的有限数值")
		}
	}
	if math.IsNaN(p.ProbeCacheTTLSeconds) || math.IsInf(p.ProbeCacheTTLSeconds, 0) || p.ProbeCacheTTLSeconds < 0 || p.ProbeCacheTTLSeconds >= maxSeconds {
		return errors.New("proxy.probe_cache_ttl_seconds 必须大于等于 0")
	}
	if p.ProbeWorkers < 1 || p.ProbeWorkers > 64 {
		return errors.New("proxy.probe_workers 必须位于 1..64")
	}
	if p.TransportCoreBasePort < 1024 || p.TransportCoreBasePort > 65000 {
		return errors.New("proxy.transport_core_base_port 必须位于 1024..65000")
	}
	p.TransportCoreSHA256 = strings.ToLower(strings.TrimSpace(p.TransportCoreSHA256))
	if p.TransportCoreSHA256 != "" {
		digest, err := hex.DecodeString(p.TransportCoreSHA256)
		if err != nil || len(digest) != 32 {
			return errors.New("proxy.transport_core_sha256 必须是 64 位十六进制 SHA-256")
		}
	}
	base := filepath.Dir(s.Path)
	if p.NodeFile != "" {
		p.NodeFile = resolve(base, p.NodeFile, "")
	}
	if p.TransportCoreBinary != "" {
		p.TransportCoreBinary = resolve(base, p.TransportCoreBinary, "")
	}
	if p.AllowedNodeRoots == nil {
		p.AllowedNodeRoots = []string{"../subscriptions"}
	}
	roots := []string{}
	seen := map[string]bool{}
	for _, raw := range p.AllowedNodeRoots {
		if strings.TrimSpace(raw) == "" {
			return errors.New("proxy.allowed_node_roots 不能包含空路径")
		}
		root := resolve(base, raw, "")
		if root == "/" || root == base || root == s.ProjectDir || root == filepath.Dir(s.ProjectDir) {
			return errors.New("proxy.allowed_node_roots 不能指向过宽的项目或文件系统根目录")
		}
		if !seen[root] {
			roots = append(roots, root)
			seen[root] = true
		}
	}
	p.AllowedNodeRoots = roots
	return nil
}
func (p Proxy) SourceSettings() proxysources.Settings {
	return proxysources.Settings{SubscriptionURLs: p.SubscriptionURLs, NodeFile: p.NodeFile, InlineNodes: p.InlineNodes, AllowedNodeRoots: p.AllowedNodeRoots}
}
func (p Proxy) RuntimeSettings(runtimeDir, projectDir string) proxypool.Settings {
	seconds := func(value float64) time.Duration { return time.Duration(value * float64(time.Second)) }
	return proxypool.Settings{Enabled: p.Enabled, AutoStart: p.AutoStart, Engine: p.Engine, AllowSocks: p.AllowSocks, TransportCoreEnabled: p.TransportCoreEnabled,
		ProbeURL: p.ProbeURL, ProbeTimeout: seconds(p.ProbeTimeoutSeconds), ProbeWorkers: p.ProbeWorkers, ProbeCacheTTL: seconds(p.ProbeCacheTTLSeconds),
		HealthInterval: seconds(p.HealthIntervalSeconds), FailCooldown: seconds(p.FailCooldownSeconds), SubscriptionTimeout: seconds(p.SubscriptionTimeoutSeconds),
		CoreBinary: p.TransportCoreBinary, CoreSHA256: p.TransportCoreSHA256, CoreBasePort: p.TransportCoreBasePort, CoreStartTimeout: seconds(p.TransportCoreStartTimeoutSeconds),
		RuntimeDir: filepath.Join(runtimeDir, "proxy", "transport-core"), ProjectBinDir: filepath.Join(projectDir, "bin")}
}
