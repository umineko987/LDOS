package proxyapi

import (
	"fmt"

	"ldos/backend/internal/proxysources"
	"ldos/backend/internal/redaction"
)

func selectFields(raw map[string]any, fields ...string) map[string]any {
	result := make(map[string]any, len(fields))
	for _, field := range fields {
		result[field] = raw[field]
	}
	return result
}
func text(value any) string {
	if value == nil || value == false {
		return ""
	}
	if v, ok := value.(string); ok {
		return v
	}
	return fmt.Sprint(value)
}
func clip(value any, limit int) string {
	s := []rune(text(value))
	if len(s) > limit {
		s = s[:limit]
	}
	return string(s)
}
func defaultText(value any, fallback string, limit int) string {
	if text(value) == "" {
		return fallback
	}
	return clip(value, limit)
}
func redact(value any, limit int) string { return redaction.Text(text(value), limit) }
func object(value any) map[string]any    { result, _ := value.(map[string]any); return result }
func rows(value any) []any {
	switch values := value.(type) {
	case []any:
		return values
	case []map[string]any:
		result := make([]any, len(values))
		for i, v := range values {
			result[i] = v
		}
		return result
	case []string:
		result := make([]any, len(values))
		for i, v := range values {
			result[i] = v
		}
		return result
	}
	return nil
}
func redactedRows(value any, count, limit int) []string {
	result := []string{}
	values := rows(value)
	for _, v := range values[:min(len(values), count)] {
		result = append(result, redact(v, limit))
	}
	return result
}
func desktopNode(raw map[string]any) map[string]any {
	result := selectFields(raw, "ref_count", "success_count", "fail_count", "last_latency_ms", "cooldown_until")
	result["id"] = clip(raw["id"], 128)
	result["name"] = redact(raw["name"], 80)
	result["protocol"] = clip(raw["protocol"], 24)
	result["endpoint"] = redact(raw["endpoint"], 240)
	result["tags"] = redactedRows(raw["tags"], 16, 32)
	result["healthy"] = raw["healthy"] == true
	result["retry_eligible"] = raw["retry_eligible"] == true
	result["last_error"] = redact(raw["last_error"], 300)
	return result
}
func desktopStatus(raw map[string]any) map[string]any {
	result := selectFields(raw, "enabled", "engine", "managed_by_backend", "auto_start", "running", "total", "healthy", "retry_eligible", "leases", "configured_revision", "active_revision", "reload_required")
	result["last_error"] = redact(raw["last_error"], 500)
	core := map[string]any{}
	if c := object(raw["transport_core"]); c != nil {
		core = selectFields(c, "enabled", "running", "listeners")
		core["last_error"] = redact(c["last_error"], 300)
	}
	result["transport_core"] = core
	sources := map[string]any{}
	s := object(raw["sources"])
	if s != nil {
		sources = selectFields(s, "subscriptions", "source_nodes", "pool_nodes", "core_candidates", "core_nodes", "skipped_nodes")
	}
	sources["warnings"] = redactedRows(s["warnings"], 20, 300)
	result["sources"] = sources
	values := rows(raw["nodes"])
	nodes := []map[string]any{}
	for _, v := range values[:min(len(values), 500)] {
		if n := object(v); n != nil {
			nodes = append(nodes, desktopNode(n))
		}
	}
	result["nodes"] = nodes
	result["node_rows_total"] = len(values)
	result["node_rows_truncated"] = len(values) > 500
	result["response_profile"] = "desktop-proxy-v1"
	return result
}
func desktopSources(raw map[string]any) map[string]any {
	result := map[string]any{"response_profile": "desktop-proxy-sources-v1", "source": defaultText(raw["source"], "none", 32), "has_runtime_override": raw["has_runtime_override"] == true, "runtime_override_valid": raw["runtime_override_valid"] == true, "configured_revision": clip(raw["configured_revision"], 64), "active_revision": nil, "reload_required": raw["reload_required"] == true}
	if raw["active_revision"] != nil {
		result["active_revision"] = clip(raw["active_revision"], 64)
	}
	subscriptions := rows(raw["subscriptions"])
	subscriptionRows := []map[string]any{}
	for _, v := range subscriptions[:min(len(subscriptions), proxysources.MaxSubscriptions)] {
		if item := object(v); item != nil {
			subscriptionRows = append(subscriptionRows, map[string]any{"id": clip(item["id"], 80), "source": defaultText(item["source"], "none", 32), "scheme": defaultText(item["scheme"], "https", 8), "host": clip(item["host"], 253), "port": item["port"], "credentials_redacted": item["credentials_redacted"] == true, "sensitive_parts_redacted": item["sensitive_parts_redacted"] == true})
		}
	}
	result["subscriptions"] = subscriptionRows
	result["subscription_rows_truncated"] = len(subscriptions) > proxysources.MaxSubscriptions
	nodeFile := map[string]any{"configured": false, "source": "none", "display_path": nil}
	if n := object(raw["node_file"]); n != nil {
		nodeFile["configured"] = n["configured"] == true
		nodeFile["source"] = defaultText(n["source"], "none", 32)
		if n["display_path"] != nil {
			nodeFile["display_path"] = clip(n["display_path"], 240)
		}
	}
	result["node_file"] = nodeFile
	nodes := rows(raw["inline_nodes"])
	nodeRows := []map[string]any{}
	for _, v := range nodes[:min(len(nodes), proxysources.MaxInlineNodes)] {
		if item := object(v); item != nil {
			nodeRows = append(nodeRows, map[string]any{"id": clip(item["id"], 80), "source": defaultText(item["source"], "none", 32), "scheme": defaultText(item["scheme"], "unknown", 24), "name": redact(item["name"], 80), "host": clip(item["host"], 253), "port": item["port"], "requires_transport_core": item["requires_transport_core"] == true})
		}
	}
	result["inline_nodes"] = nodeRows
	result["inline_node_rows_truncated"] = len(nodes) > proxysources.MaxInlineNodes
	counts := map[string]any{}
	if c := object(raw["counts"]); c != nil {
		counts = selectFields(c, "subscriptions", "node_file", "inline_nodes", "total")
	}
	result["counts"] = counts
	return result
}
