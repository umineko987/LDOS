package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNativeProxyConfiguration(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "config.json")
	load := func(data string) (Settings, error) {
		t.Helper()
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		return Load(path, func(string) string { return "" })
	}
	s, err := load(`{"proxy":{"inline_nodes":["http://localhost:1234"],"node_file":"nodes.txt","allowed_node_roots":["nodes","nodes"],"transport_core_binary":"bin/mihomo","transport_core_sha256":"` + strings.Repeat("AB", 32) + `","probe_cache_ttl_seconds":0}}`)
	if err != nil {
		t.Fatal(err)
	}
	p := s.Proxy
	if !p.Enabled || !p.AutoStart || p.NodeFile != filepath.Join(root, "nodes.txt") || len(p.AllowedNodeRoots) != 1 || p.AllowedNodeRoots[0] != filepath.Join(root, "nodes") || p.TransportCoreBinary != filepath.Join(root, "bin/mihomo") || p.TransportCoreSHA256 != strings.Repeat("ab", 32) {
		t.Fatal(p)
	}
	runtime := p.RuntimeSettings(s.RuntimeDir, s.ProjectDir)
	if runtime.ProbeCacheTTL != 0 || runtime.ProbeTimeout != 10*time.Second || runtime.ProjectBinDir != filepath.Join(root, "bin") || runtime.CoreBasePort != 29000 {
		t.Fatal(runtime)
	}
	if s, err := load(`{"proxy":{"allowed_node_roots":[]}}`); err != nil || s.Proxy.AllowedNodeRoots == nil || len(s.Proxy.AllowedNodeRoots) != 0 {
		t.Fatal(s.Proxy, err)
	}
	for _, fragment := range []string{`"engine":"external"`, `"probe_timeout_seconds":0`, `"probe_workers":65`, `"probe_cache_ttl_seconds":-1`, `"health_interval_seconds":1e100`, `"fail_cooldown_seconds":0`, `"transport_core_base_port":80`, `"transport_core_sha256":"invalid"`, `"allowed_node_roots":[""]`, `"allowed_node_roots":["."]`, `"allowed_node_roots":[".."]`, `"allowed_node_roots":["/"]`} {
		if _, err := load(`{"proxy":{` + fragment + `}}`); err == nil {
			t.Errorf("accepted invalid proxy config: %s", fragment)
		}
	}
}
