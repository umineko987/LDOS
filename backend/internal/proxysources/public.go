package proxysources

import (
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

var (
	uuidPattern      = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)
	longTokenPattern = regexp.MustCompile(`[A-Za-z0-9_~+/=-]{32,}`)
)

func safeText(value string, limit int) string {
	value = norm.NFKC.String(value)
	text := strings.Map(func(r rune) rune {
		if !unicode.IsGraphic(r) {
			return ' '
		}
		return r
	}, value)
	text = strings.Join(strings.FieldsFunc(text, isSpace), " ")
	text = uuidPattern.ReplaceAllString(text, "***")
	text = longTokenPattern.ReplaceAllString(text, "***")
	lower := strings.ToLower(text)
	if strings.Contains(text, "://") || strings.Contains(lower, "password=") || strings.Contains(lower, "token=") || strings.Contains(lower, "secret=") {
		return "已命名节点"
	}
	runes := []rune(text)
	if len(runes) > limit {
		text = string(runes[:limit])
	}
	return text
}

// SafeNodeName is shared by source and runtime status projections.
func SafeNodeName(value string) string { return safeText(value, 80) }

func publicSubscription(value, source string) map[string]any {
	u, err := splitSubscription(value)
	sensitive := true
	if err != nil {
		u = subscriptionURL{scheme: "https"}
	} else {
		if u.scheme != "http" && u.scheme != "https" {
			u.scheme = "https"
		}
		sensitive = u.hasCredentials || u.path != "" && u.path != "/" || u.query != "" || u.fragment != ""
	}
	authority := u.authority()
	display := u.scheme + "://…"
	if authority != "" {
		display = u.scheme + "://" + authority + "/…"
	}
	var port any
	if u.port != nil {
		port = *u.port
	}
	return map[string]any{
		"id": sourceID("sub", value), "source": source, "scheme": u.scheme,
		"host": u.host, "port": port, "display_url": display,
		"credentials_redacted": u.hasCredentials, "sensitive_parts_redacted": sensitive,
	}
}

func publicInlineNode(value, source string) map[string]any {
	scheme, host, name, port, requiresCore := "unknown", "", "", 0, false
	if _, node, err := parseOneInlineNode(value, nil); err == nil {
		scheme = strings.ToLower(node.Scheme)
		if scheme == "" {
			scheme = "unknown"
		}
		if runes := []rune(scheme); len(runes) > 24 {
			scheme = string(runes[:24])
		}
		host, _ = canonicalHost(node.Host)
		port = node.Port
		name = SafeNodeName(node.Name)
		requiresCore = !node.Usable && len(node.CoreConfig) != 0
	}
	authority := host
	if strings.Contains(host, ":") {
		authority = "[" + host + "]"
	}
	if port != 0 {
		authority += ":" + strconv.Itoa(port)
	}
	endpoint := scheme + "://***"
	if authority != "" {
		endpoint += "@" + authority
	}
	if name != "" {
		endpoint += "#" + name
	}
	return map[string]any{
		"id": sourceID("node", value), "source": source, "scheme": scheme,
		"host": host, "port": port, "name": name,
		"requires_transport_core": requiresCore, "display_endpoint": endpoint,
	}
}

func (s *Store) displayNodeFile(path string) any {
	if path == "" {
		return nil
	}
	candidate, err := filepath.Abs(path)
	if err != nil {
		return "外部节点文件"
	}
	for _, root := range []string{s.projectDir, s.workspaceDir} {
		if inside(candidate, root) {
			relative, _ := filepath.Rel(root, candidate)
			return safeText(filepath.ToSlash(relative), 240)
		}
	}
	if name := safeText(filepath.Base(candidate), 160); name != "" {
		return name
	}
	return "外部节点文件"
}

func (s *Store) PublicSnapshot(current *Snapshot, activeRevision *string) (map[string]any, error) {
	if current == nil {
		snapshot := s.Snapshot()
		current = &snapshot
	}
	if _, err := idIndex("sub", current.SubscriptionURLs); err != nil {
		return nil, err
	}
	if _, err := idIndex("node", current.InlineNodes); err != nil {
		return nil, err
	}
	subscriptions := make([]map[string]any, 0, len(current.SubscriptionURLs))
	for _, value := range current.SubscriptionURLs {
		subscriptions = append(subscriptions, publicSubscription(value, current.Source))
	}
	nodes := make([]map[string]any, 0, len(current.InlineNodes))
	for _, value := range current.InlineNodes {
		nodes = append(nodes, publicInlineNode(value, current.Source))
	}
	nodeFileCount := 0
	if current.NodeFile != "" {
		nodeFileCount = 1
	}
	var active any
	reloadRequired := true
	if activeRevision != nil {
		active = *activeRevision
		reloadRequired = current.ConfiguredRevision != *activeRevision
	}
	return map[string]any{
		"source": current.Source, "has_runtime_override": current.HasRuntimeOverride,
		"runtime_override_valid": current.RuntimeOverrideValid,
		"configured_revision":    current.ConfiguredRevision, "active_revision": active,
		"reload_required": reloadRequired, "subscriptions": subscriptions, "inline_nodes": nodes,
		"node_file": map[string]any{"configured": current.NodeFile != "", "source": current.Source, "display_path": s.displayNodeFile(current.NodeFile)},
		"counts":    map[string]any{"subscriptions": len(subscriptions), "node_file": nodeFileCount, "inline_nodes": len(nodes), "total": len(subscriptions) + nodeFileCount + len(nodes)},
	}, nil
}
