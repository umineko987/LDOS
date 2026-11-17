package diagnostics

import (
	"encoding/json"
	"net"
	"net/url"
	"strings"

	"ldos/backend/internal/config"
)

func fields(value any, names ...string) map[string]any {
	data, _ := json.Marshal(value)
	var raw map[string]any
	_ = json.Unmarshal(data, &raw)
	out := map[string]any{}
	for _, name := range names {
		out[name] = raw[name]
	}
	return out
}
func publicURL(raw string) any {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "[redacted]"
	}
	if u.User != nil {
		u.User = url.UserPassword("***", "***")
	}
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

func Config(settings config.Settings, view string) map[string]any {
	if view == "diagnostics" {
		host := strings.ToLower(strings.TrimSpace(settings.Server.Host))
		ip := net.ParseIP(host)
		loopback := host == "localhost" || (ip != nil && ip.IsLoopback())
		return map[string]any{"response_profile": "diagnostics", "secrets_exposed": false,
			"server":  map[string]any{"loopback_only": loopback, "cors_enabled": len(settings.Server.CORSOrigins) > 0, "private_targets_enabled": settings.Server.AllowPrivateTargets},
			"gallery": map[string]any{"managed_auth_cache": true}, "proxy": fields(settings.Proxy, "enabled", "auto_start", "transport_core_enabled"),
			"scheduler": fields(settings.Scheduler, "max_concurrent_tasks"), "dedup": map[string]any{"enabled": settings.Dedup.Enabled, "configured_device": settings.Dedup.Device, "sscd_enabled": !settings.Dedup.NoSSCD, "dino_enabled": !settings.Dedup.NoDINO}}
	}
	gallery := fields(settings.Gallery, "repo_path", "python_executable", "default_http_timeout", "default_retries")
	gallery["managed_auth_cache"] = true
	auth := map[string]any{"managed_browser": true, "chrome_configured": settings.Auth.ChromeExecutable != "", "browser_login_timeout_seconds": settings.Auth.BrowserLoginTimeoutSeconds, "browser_poll_interval_seconds": settings.Auth.BrowserPollIntervalSeconds, "authorization_proxy": publicURL(settings.Auth.AuthorizationProxy)}
	proxy := fields(settings.Proxy, "enabled", "auto_start", "engine", "node_file", "allowed_node_roots", "allow_socks", "probe_url", "probe_timeout_seconds", "probe_cache_ttl_seconds", "transport_core_enabled", "transport_core_binary", "transport_core_sha256", "transport_core_base_port")
	proxy["subscription_count"], proxy["inline_node_count"] = len(settings.Proxy.SubscriptionURLs), len(settings.Proxy.InlineNodes)
	proxy["probe_url"] = publicURL(settings.Proxy.ProbeURL)
	dns := fields(settings.EncryptedDNS, "enabled", "endpoint", "timeout_seconds", "max_response_bytes")
	dns["endpoint"] = publicURL(settings.EncryptedDNS.Endpoint)
	return map[string]any{"runtime_dir": settings.RuntimeDir, "database_path": settings.DatabasePath, "default_output_root": settings.DefaultOutputRoot, "allowed_output_roots": settings.AllowedOutputRoots, "server": settings.Server, "encrypted_dns": dns, "gallery": gallery, "auth": auth, "proxy": proxy, "scheduler": settings.Scheduler, "dedup": fields(settings.Dedup, "enabled", "python_executable", "worker_script", "core_script", "atlas_script", "model_dir", "device", "workers", "torch_threads", "torch_interop_threads", "deep_batch_size", "neighbor_block_size", "no_sscd", "no_dino"), "default_site_policy": fields(settings.DefaultSitePolicy, "max_concurrency", "retry_limit", "backoff_base_seconds", "proxy_mode")}
}

func Scheduler(tasks, crawls map[string]any) map[string]any {
	order, _ := crawls["execution_order"].(string)
	if order != "source_then_address" {
		order = "unknown"
	}
	parallelism, _ := crawls["address_parallelism"].(string)
	if parallelism != "media_tasks" {
		parallelism = "unknown"
	}
	return map[string]any{"response_profile": "diagnostics", "secrets_exposed": false,
		"tasks":          map[string]any{"running": tasks["running"] == true, "active": count(tasks["active"], 1000000000), "max_concurrent": count(tasks["max_concurrent"], 1000000000), "active_site_count": len(object(tasks["sites"])), "dispatch_loop": Loop(object(tasks["dispatch_loop"]))},
		"ordered_crawls": map[string]any{"running": crawls["running"] == true, "active_batches": count(crawls["active_batches"], 1000000000), "execution_order": order, "address_parallelism": parallelism}}
}
