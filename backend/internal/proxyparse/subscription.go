package proxyparse

import (
	"fmt"
	"strings"
)

func parseClash(v any) *Node {
	item, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	scheme := strings.ToLower(strings.TrimSpace(str(item["type"])))
	if scheme == "hy2" {
		scheme = "hysteria2"
	}
	host := strings.TrimSpace(str(item["server"]))
	fallbackPort := 0
	if scheme == "mieru" {
		fallbackPort = firstPort(first(item["port-range"], item["port_range"]))
	}
	port, ok := integer(first(item["port"], fallbackPort))
	name := strings.TrimSpace(str(item["name"]))
	if !ok || (!directScheme(scheme) && !tunnelScheme(scheme)) || !validHostPort(host, port) {
		return nil
	}
	if tunnelScheme(scheme) {
		source := cloneMap(item)
		source["type"] = scheme
		return &Node{Raw: fmt.Sprintf("%s://%s:%d#%s", scheme, host, port, name), Scheme: scheme, Host: host, Port: port, Name: name, Note: tunnelNote, CoreConfig: source}
	}
	username, password := str(item["username"]), str(item["password"])
	if (scheme == "socks5" || scheme == "socks5h") && (username != "" || password != "") {
		source := cloneMap(item)
		source["type"] = "socks5"
		return coreNode("socks5", source)
	}
	if scheme == "socks4" && (username != "" || password != "") {
		return &Node{Raw: fmt.Sprintf("socks4://%s:%d#%s", host, port, quote(name)), Scheme: scheme, Host: host, Port: port, Name: name, Note: socks4Note, CoreConfig: map[string]any{}}
	}
	endpoint := proxyURL(scheme, host, port, username, password)
	return &Node{Raw: endpoint, Scheme: scheme, Host: host, Port: port, Name: name, Username: username, Password: password, Endpoint: endpoint, Usable: true, CoreConfig: map[string]any{}}
}

func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func defaultEnabled(m map[string]any) bool {
	if v, exists := m["enabled"]; exists {
		return truth(v)
	}
	return true
}

func applySingboxTLS(c map[string]any, v any) {
	tls, ok := v.(map[string]any)
	if !ok || !defaultEnabled(tls) {
		return
	}
	c["tls"] = true
	if s := strings.TrimSpace(str(first(tls["server_name"], tls["server-name"]))); s != "" {
		key := "sni"
		if c["type"] == "vless" || c["type"] == "vmess" {
			key = "servername"
		}
		c[key] = s
	}
	if truth(tls["insecure"]) {
		c["skip-cert-verify"] = true
	}
	if alpn, ok := tls["alpn"].([]any); ok && len(alpn) > 0 {
		xs := []string{}
		for _, x := range alpn {
			if s := text(x); s != "" {
				xs = append(xs, s)
			}
		}
		c["alpn"] = xs
	}
	if utls, ok := tls["utls"].(map[string]any); ok && defaultEnabled(utls) && truth(utls["fingerprint"]) {
		c["client-fingerprint"] = text(utls["fingerprint"])
	}
	if reality, ok := tls["reality"].(map[string]any); ok && defaultEnabled(reality) {
		o := map[string]any{}
		if v := first(reality["public_key"], reality["public-key"]); truth(v) {
			o["public-key"] = text(v)
		}
		if v := first(reality["short_id"], reality["short-id"]); truth(v) {
			o["short-id"] = text(v)
		}
		if len(o) > 0 {
			c["reality-opts"] = o
		}
	}
}

func applySingboxTransport(c map[string]any, v any) {
	t, ok := v.(map[string]any)
	if !ok {
		return
	}
	q := query{}
	for _, pair := range [][2]string{{"host", "host"}, {"path", "path"}, {"service_name", "servicename"}, {"service-name", "servicename"}} {
		if value := t[pair[0]]; value != nil && text(value) != "" {
			q[pair[1]] = []string{text(value)}
		}
	}
	headers, ok := t["headers"].(map[string]any)
	if ok {
		if h := first(headers["Host"], headers["host"]); truth(h) {
			q["host"] = []string{text(h)}
		}
	}
	applyTransport(c, q, text(first(t["type"], "tcp")))
	if len(headers) == 0 {
		return
	}
	normalized := map[string]any{}
	for k, v := range headers {
		if k != "" {
			if c["network"] == "http" {
				normalized[k] = []string{text(v)}
			} else {
				normalized[k] = text(v)
			}
		}
	}
	if len(normalized) == 0 {
		return
	}
	key := ""
	switch c["network"] {
	case "ws":
		key = "ws-opts"
	case "httpupgrade":
		key = "http-upgrade-opts"
	case "http":
		key = "http-opts"
	}
	if key != "" {
		o, ok := c[key].(map[string]any)
		if !ok {
			o = map[string]any{}
			c[key] = o
		}
		o["headers"] = normalized
	}
}

func parseSingbox(v any) *Node {
	item, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	scheme := strings.ToLower(strings.TrimSpace(str(item["type"])))
	switch scheme {
	case "shadowsocks":
		scheme = "ss"
	case "socks":
		scheme = "socks5"
	case "http", "vmess", "vless", "trojan", "hysteria", "hysteria2", "tuic", "anytls", "mieru":
	default:
		return nil
	}
	host := strings.TrimSpace(str(item["server"]))
	portRange := mieruPortRange(first(item["port_range"], item["port-range"], item["server_ports"]))
	fallback := 0
	if scheme == "mieru" {
		fallback = firstPort(portRange)
	}
	port, ok := integer(first(item["server_port"], item["port"], fallback))
	if !ok || !validHostPort(host, port) {
		return nil
	}
	name := strings.TrimSpace(text(first(item["tag"], item["name"], scheme+"-"+host)))
	if scheme == "http" || scheme == "socks5" {
		return parseClash(map[string]any{"name": name, "type": scheme, "server": host, "port": port, "username": str(item["username"]), "password": str(item["password"])})
	}
	c := map[string]any{"name": name, "type": scheme, "server": host, "port": port}
	if (scheme == "vless" || scheme == "vmess" || scheme == "tuic") && truth(item["uuid"]) {
		c["uuid"] = text(item["uuid"])
	}
	switch scheme {
	case "vmess":
		aid, _ := integer(first(item["alter_id"], item["alterId"], item["alter-id"], 0))
		c["alterId"], c["cipher"], c["udp"] = aid, text(first(item["security"], "auto")), true
	case "vless":
		c["udp"] = true
		if truth(item["flow"]) {
			c["flow"] = text(item["flow"])
		}
		if truth(item["packet_encoding"]) {
			c["packet-encoding"] = text(item["packet_encoding"])
		}
	case "trojan", "hysteria2", "anytls":
		if truth(item["password"]) {
			c["password"] = text(item["password"])
		}
		if scheme == "trojan" {
			c["udp"] = true
		}
	case "hysteria":
		if a := first(item["auth_str"], item["auth"]); truth(a) {
			c["auth-str"] = text(a)
		}
	case "tuic":
		if truth(item["password"]) {
			c["password"] = text(item["password"])
		}
		c["congestion-controller"] = text(first(item["congestion_control"], "bbr"))
		c["udp-relay-mode"] = text(first(item["udp_relay_mode"], "native"))
	case "ss":
		c["cipher"], c["password"], c["udp"] = str(item["method"]), str(item["password"]), true
		applyDocumentPlugin(c, item)
	case "mieru":
		c["username"], c["password"], c["transport"] = str(item["username"]), str(item["password"]), mieruTransport(item["transport"])
		if truth(item["multiplexing"]) {
			c["multiplexing"] = mieruMultiplexing(item["multiplexing"])
		}
		if portRange != "" {
			c["port-range"] = portRange
			delete(c, "port")
		}
	}
	if scheme == "hysteria" || scheme == "hysteria2" {
		for _, pair := range [][2]string{{"up_mbps", "up"}, {"down_mbps", "down"}} {
			if v := item[pair[0]]; v != nil {
				c[pair[1]] = numberOrText(v)
			}
		}
		if o, ok := item["obfs"].(map[string]any); ok {
			if truth(o["type"]) {
				c["obfs"] = text(o["type"])
			}
			if truth(o["password"]) {
				c["obfs-password"] = text(o["password"])
			}
		} else if truth(item["obfs"]) {
			c["obfs"] = text(item["obfs"])
		}
		if truth(item["obfs_password"]) {
			c["obfs-password"] = text(item["obfs_password"])
		}
	}
	applySingboxTLS(c, item["tls"])
	if scheme != "mieru" {
		applySingboxTransport(c, item["transport"])
	}
	return coreNode(scheme, c)
}

func applyDocumentPlugin(c, item map[string]any) {
	plugin := strings.TrimSpace(str(item["plugin"]))
	options := strings.TrimSpace(str(first(item["plugin_opts"], item["plugin-opts"])))
	if plugin != "" {
		if options != "" {
			plugin += ";" + options
		}
		parseSSPlugin(c, plugin)
	}
}

func parseSIP008(v any) *Node {
	item, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	c := map[string]any{"name": str(first(item["remarks"], item["id"])), "type": "ss", "server": str(item["server"]), "port": first(item["server_port"], item["port"], 0), "cipher": str(first(item["method"], item["cipher"])), "password": str(item["password"]), "udp": true}
	applyDocumentPlugin(c, item)
	return coreNode("ss", c)
}

func parseItems(items []any, parse func(any) *Node) []Node {
	nodes := make([]Node, 0, len(items))
	for _, item := range items {
		if n := parse(item); n != nil {
			nodes = append(nodes, *n)
		}
	}
	return nodes
}

func parseJSONDocument(raw string) ([]Node, bool) {
	var document any
	if !decodeJSON(raw, &document) {
		return nil, false
	}
	if m, ok := document.(map[string]any); ok {
		for _, row := range []struct {
			key   string
			parse func(any) *Node
		}{{"proxies", parseClash}, {"outbounds", parseSingbox}, {"servers", parseSIP008}} {
			if items, ok := m[row.key].([]any); ok {
				return parseItems(items, row.parse), true
			}
		}
	}
	if items, ok := document.([]any); ok {
		parse := parseSingbox
		for _, item := range items {
			if m, ok := item.(map[string]any); ok {
				_, hasPort := m["server_port"]
				_, hasMethod := m["method"]
				if hasPort && hasMethod {
					parse = parseSIP008
					break
				}
			}
		}
		return parseItems(items, parse), true
	}
	return nil, false
}

func decodeSubscription(text string) string {
	compact := strings.Join(strings.Fields(text), "")
	if len(compact) < 16 {
		return ""
	}
	for _, r := range compact {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || strings.ContainsRune("_+/=-", r)) {
			return ""
		}
	}
	decoded := strings.TrimSpace(decodeBase64(compact))
	if strings.Contains(decoded, "://") || strings.Contains(decoded, "\n") || strings.HasPrefix(decoded, "proxies:") || strings.HasPrefix(decoded, "{") || strings.HasPrefix(decoded, "[") {
		return decoded
	}
	return ""
}

// ParseSubscription accepts lines, Clash YAML/JSON, sing-box JSON, SIP008 JSON,
// and the source parser's bounded base64 envelopes. Inputs over 8 MiB are rejected
// with nil because this API has no error result; callers needing an error should
// check MaxSubscriptionBytes before calling. Unsupported entries are skipped.
// YAML aliases preserve shared collections; cyclic aliases reject the entire
// subscription with nil, including otherwise valid nodes in the document.
func ParseSubscription(text string) []Node { return parseSubscription(text, 0) }

func parseSubscription(text string, depth int) []Node {
	raw := strings.TrimSpace(text)
	if raw == "" {
		return []Node{}
	}
	if len(raw) > MaxSubscriptionBytes {
		return nil
	}
	if depth < MaxBase64Depth {
		if decoded := decodeSubscription(raw); decoded != "" {
			return parseSubscription(decoded, depth+1)
		}
	}
	if nodes, ok := parseJSONDocument(raw); ok {
		return nodes
	}
	prefix := raw
	if len(prefix) > 4000 {
		prefix = prefix[:4000]
	}
	if strings.HasPrefix(raw, "proxies:") || strings.Contains(prefix, "\nproxies:") {
		document, err := decodeClashYAML(raw)
		if err == errCyclicYAML {
			return nil
		}
		if items, ok := document["proxies"].([]any); ok {
			return parseItems(items, parseClash)
		}
	}
	nodes := []Node{}
	// Python splitlines also recognizes these Unicode and ASCII line separators.
	for _, line := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == '\n' || r == '\r' || r == '\v' || r == '\f' || r >= 0x1c && r <= 0x1e || r == 0x85 || r == 0x2028 || r == 0x2029
	}) {
		if n := ParseLine(line); n != nil {
			nodes = append(nodes, *n)
		}
	}
	return nodes
}
