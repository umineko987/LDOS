package proxypool

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"ldos/backend/internal/proxysources"
	"ldos/backend/internal/redaction"
)

var tagTokens = regexp.MustCompile(`[a-z][a-z0-9_-]{1,20}`)
var regionAliases = [][]string{
	{"jp", "japan", "日本", "东京", "大阪", "🇯🇵"}, {"hk", "hong kong", "香港", "🇭🇰"},
	{"tw", "taiwan", "台湾", "台北", "🇹🇼"}, {"sg", "singapore", "新加坡", "狮城", "🇸🇬"},
	{"us", "usa", "united states", "美国", "洛杉矶", "圣何塞", "🇺🇸"}, {"kr", "korea", "韩国", "首尔", "🇰🇷"},
	{"de", "germany", "德国", "🇩🇪"}, {"gb", "uk", "united kingdom", "英国", "🇬🇧"},
	{"fr", "france", "法国", "🇫🇷"}, {"ca", "canada", "加拿大", "🇨🇦"}, {"au", "australia", "澳大利亚", "澳洲", "🇦🇺"},
}

func nodeTags(name, protocol, host string) []string {
	combined := strings.ToLower(name + " " + protocol + " " + host)
	tags := map[string]bool{strings.ToLower(protocol): true}
	for _, token := range tagTokens.FindAllString(combined, -1) {
		tags[token] = true
	}
	for _, aliases := range regionAliases {
		for _, alias := range aliases {
			if tags[alias] || (tagTokens.FindString(alias) != alias && strings.Contains(combined, alias)) {
				tags[aliases[0]] = true
				break
			}
		}
	}
	result := make([]string, 0, len(tags))
	for tag := range tags {
		result = append(result, tag)
	}
	slices.Sort(result)
	return result
}
func safeName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, name)
	return redaction.Text(strings.Join(strings.Fields(name), " "), 80)
}
func MaskEndpoint(endpoint string) string {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Hostname() == "" {
		return "[REDACTED_PROXY]"
	}
	host := parsed.Hostname()
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if parsed.Port() != "" {
		host += ":" + parsed.Port()
	}
	auth := ""
	if parsed.User != nil {
		auth = "***@"
	}
	return parsed.Scheme + "://" + auth + host
}
func probeTarget(raw string) (key, public string, err error) {
	u, err := url.Parse(raw)
	if err != nil || strings.ToLower(u.Scheme) != "https" || u.Hostname() == "" {
		return "", "", fmt.Errorf("探活地址必须是带主机名的 https:// URL")
	}
	if u.User != nil {
		return "", "", fmt.Errorf("探活地址不接受 URL 凭据")
	}
	port := 443
	if u.Port() != "" {
		port, err = strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return "", "", fmt.Errorf("探活端口超出范围")
		}
	}
	key = "https://" + net.JoinHostPort(strings.ToLower(u.Hostname()), strconv.Itoa(port))
	host := u.Hostname()
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != 443 {
		host += ":" + strconv.Itoa(port)
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	return key, "https://" + host + path, nil
}
func safeWarning(text string, snapshot proxysources.Snapshot) string {
	for i, raw := range snapshot.SubscriptionURLs {
		text = strings.ReplaceAll(text, raw, fmt.Sprintf("SUBSCRIPTION_URL_%d", i+1))
	}
	return redaction.Text(text, 500)
}
func unixSeconds(t time.Time) float64 { return float64(t.UnixNano()) / float64(time.Second) }
func (p *Pool) ActiveRevision() *string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.activeRevision == nil {
		return nil
	}
	value := *p.activeRevision
	return &value
}
func (p *Pool) ActiveLeases() int      { p.mu.Lock(); defer p.mu.Unlock(); return len(p.leases) }
func (p *Pool) Status() map[string]any { return p.status(p.sources.Snapshot()) }
func (p *Pool) status(snapshot proxysources.Snapshot) map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.deps.now()
	nodes := make([]map[string]any, 0, len(p.records))
	healthy, eligible := 0, 0
	for _, r := range p.records {
		h := p.running && r.healthy
		e := h && !r.cooldown.After(now) && r.owner == ""
		if h {
			healthy++
		}
		if e {
			eligible++
		}
		ref := 0
		if r.owner != "" {
			ref = 1
		}
		var latency any
		if r.latency != nil {
			latency = *r.latency
		}
		nodes = append(nodes, map[string]any{"id": r.id, "name": r.name, "protocol": r.protocol, "endpoint": MaskEndpoint(r.endpoint),
			"healthy": h, "retry_eligible": e, "ref_count": ref, "success_count": r.successes, "fail_count": r.failures,
			"last_latency_ms": latency, "cooldown_until": unixSeconds(now) + max(0, r.cooldown.Sub(now).Seconds()),
			"last_error": redaction.Text(r.lastError, 300), "tags": append([]string{}, r.tags...)})
	}
	core := map[string]any{"enabled": p.settings.TransportCoreEnabled, "running": false, "listeners": 0, "last_error": p.coreError}
	if p.core != nil {
		core = p.core.Status()
	}
	summary := map[string]any{}
	for k, v := range p.summary {
		summary[k] = v
	}
	if warnings, ok := summary["warnings"].([]string); ok {
		summary["warnings"] = append([]string{}, warnings...)
	}
	if counts, ok := summary["scheme_counts"].(map[string]int); ok {
		cloned := map[string]int{}
		for k, v := range counts {
			cloned[k] = v
		}
		summary["scheme_counts"] = cloned
	}
	var revision any
	if p.activeRevision != nil {
		revision = *p.activeRevision
	}
	sourceCount := len(snapshot.SubscriptionURLs) + len(snapshot.InlineNodes)
	if snapshot.NodeFile != "" {
		sourceCount++
	}
	return map[string]any{"enabled": p.settings.Enabled, "engine": p.settings.Engine, "managed_by_backend": true, "auto_start": p.settings.AutoStart,
		"executable_required": false, "running": p.running, "configured_revision": snapshot.ConfiguredRevision, "active_revision": revision,
		"reload_required": revision != snapshot.ConfiguredRevision, "total": len(nodes), "healthy": healthy, "retry_eligible": eligible, "leases": len(p.leases),
		"last_error": p.lastError, "transport_core": core, "sources": summary, "source_count": sourceCount,
		"probe_cache": map[string]any{"entries": len(p.cache), "ttl_seconds": p.settings.ProbeCacheTTL.Seconds()}, "nodes": nodes}
}
