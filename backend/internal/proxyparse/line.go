package proxyparse

import (
	"fmt"
	"strconv"
	"strings"
)

// ParseLine returns nil for malformed or unsupported input. Tunnel nodes and
// authenticated SOCKS nodes are not directly usable: they require a transport core.
func ParseLine(raw string) *Node {
	line := strings.Trim(strings.TrimSpace(raw), "\ufeff")
	if line == "" || strings.HasPrefix(line, "#") {
		return nil
	}
	if !strings.Contains(line, "://") {
		parts := strings.SplitN(line, ":", 4)
		if len(parts) == 4 && !strings.HasPrefix(line, "-") && decimal(parts[1]) {
			p, e := strconv.Atoi(parts[1])
			if e == nil && validHostPort(parts[0], p) {
				return &Node{Raw: line, Scheme: "http", Host: parts[0], Port: p, Username: parts[2], Password: parts[3], Endpoint: proxyURL("http", parts[0], p, parts[2], parts[3]), Usable: true, CoreConfig: map[string]any{}}
			}
		}
		if len(parts) == 2 && decimal(parts[1]) {
			p, e := strconv.Atoi(parts[1])
			if e == nil && validHostPort(parts[0], p) {
				return &Node{Raw: line, Scheme: "http", Host: parts[0], Port: p, Endpoint: proxyURL("http", parts[0], p, "", ""), Usable: true, CoreConfig: map[string]any{}}
			}
		}
	}
	scheme, _, found := strings.Cut(line, ":")
	scheme = strings.ToLower(scheme)
	if !found || (!directScheme(scheme) && !tunnelScheme(scheme)) {
		return nil
	}
	switch scheme {
	case "ss":
		return parseSS(line)
	case "ssr":
		return parseSSR(line)
	case "vmess":
		return parseVMess(line)
	}
	u, ok := splitURI(line)
	if !ok {
		return nil
	}
	if directScheme(scheme) {
		if u.port == 0 {
			if scheme == "https" {
				u.port = 443
			} else {
				u.port = 80
			}
		}
		if !validHostPort(u.host, u.port) {
			return nil
		}
		name := fragmentName(line)
		if (scheme == "socks5" || scheme == "socks5h") && (u.user != "" || u.password != "") {
			return coreNode("socks5", map[string]any{"name": name, "type": "socks5", "server": u.host, "port": u.port, "username": u.user, "password": u.password, "udp": true})
		}
		if scheme == "socks4" && (u.user != "" || u.password != "") {
			return &Node{Raw: fmt.Sprintf("socks4://%s:%d#%s", u.host, u.port, quote(name)), Scheme: scheme, Host: u.host, Port: u.port, Name: name, Note: socks4Note, CoreConfig: map[string]any{}}
		}
		return &Node{Raw: line, Scheme: scheme, Host: u.host, Port: u.port, Username: u.user, Password: u.password, Name: name, Endpoint: proxyURL(scheme, u.host, u.port, u.user, u.password), Usable: true, CoreConfig: map[string]any{}}
	}
	return parseTunnel(line, scheme, u)
}

func decimal(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func applyTLS(c map[string]any, q query, sniKey string, enabled bool) {
	if enabled {
		c["tls"] = true
	}
	if s := q.value("sni", "servername", "server-name", "peer"); s != "" {
		c[sniKey] = s
	}
	if q.boolean(false, "allowinsecure", "insecure", "skip-cert-verify") {
		c["skip-cert-verify"] = true
	}
	if s := q.value("fp", "fingerprint", "client-fingerprint"); s != "" {
		c["client-fingerprint"] = s
	}
	if xs := q.list("alpn"); len(xs) > 0 {
		c["alpn"] = xs
	}
}

func applyTransport(c map[string]any, q query, network string) {
	t := strings.ToLower(strings.TrimSpace(text(first(network, "tcp"))))
	switch t {
	case "httpupgrade", "http-upgrade":
		t = "httpupgrade"
	case "splithttp", "xhttp":
		t = "xhttp"
	}
	c["network"] = t
	host, path := q.value("host"), q.value("path")
	o := map[string]any{}
	key := ""
	switch t {
	case "ws", "httpupgrade":
		key = "ws-opts"
		if t == "httpupgrade" {
			key = "http-upgrade-opts"
		}
		if path != "" {
			o["path"] = path
		}
		if host != "" {
			o["headers"] = map[string]any{"Host": host}
		}
	case "grpc":
		key = "grpc-opts"
		if s := q.value("servicename", "service-name", "grpc-service-name"); s != "" {
			o["grpc-service-name"] = s
		}
	case "xhttp":
		key = "xhttp-opts"
		if path != "" {
			o["path"] = path
		}
		if host != "" {
			o["host"] = host
		}
		if s := q.value("mode"); s != "" {
			o["mode"] = s
		}
	case "http":
		key = "http-opts"
		if path != "" {
			o["path"] = []string{path}
		}
		if host != "" {
			o["headers"] = map[string]any{"Host": []string{host}}
		}
	case "h2":
		key = "h2-opts"
		if path != "" {
			o["path"] = path
		}
		if host != "" {
			o["host"] = []string{host}
		}
	}
	if len(o) > 0 {
		c[key] = o
	}
}

func applyReality(c map[string]any, q query) {
	o := map[string]any{}
	if s := q.value("pbk", "publickey", "public-key"); s != "" {
		o["public-key"] = s
	}
	if s := q.value("sid", "shortid", "short-id"); s != "" {
		o["short-id"] = s
	}
	if len(o) > 0 {
		c["reality-opts"] = o
	}
}

func parseTunnel(line, scheme string, u uri) *Node {
	q := parseQuery(u.rawQuery)
	if scheme == "hy2" {
		scheme = "hysteria2"
	}
	c := map[string]any{"name": fragmentName(line), "type": scheme, "server": u.host, "port": u.port}
	switch scheme {
	case "vless":
		uuid := strings.TrimSpace(u.user)
		if uuid == "" {
			return nil
		}
		c["uuid"], c["udp"] = uuid, q.boolean(true, "udp")
		for _, key := range []string{"encryption", "flow"} {
			if s := q.value(key); s != "" {
				c[key] = s
			}
		}
		security := strings.ToLower(q.value("security"))
		applyTLS(c, q, "servername", security == "tls" || security == "reality")
		applyReality(c, q)
		if s := q.value("packetencoding", "packet-encoding"); s != "" {
			c["packet-encoding"] = s
		}
		applyTransport(c, q, q.value("type", "network"))
	case "trojan", "anytls":
		if u.userinfo == "" {
			return nil
		}
		c["password"] = u.userinfo
		applyTLS(c, q, "sni", false)
		if scheme == "trojan" {
			c["udp"] = true
			applyReality(c, q)
			applyTransport(c, q, q.value("type", "network"))
		} else {
			for _, key := range []string{"idle-session-check-interval", "idle-session-timeout", "min-idle-session"} {
				if s := q.value(key); s != "" {
					if i, ok := integer(s); ok {
						c[key] = i
					} else {
						c[key] = s
					}
				}
			}
		}
	case "hysteria", "hysteria2":
		auth := text(first(u.userinfo, q.value("auth", "password")))
		if scheme == "hysteria2" && auth == "" {
			return nil
		}
		if auth != "" {
			key := "auth-str"
			if scheme == "hysteria2" {
				key = "password"
			}
			c[key] = auth
		}
		if s := q.value("sni", "servername", "peer"); s != "" {
			c["sni"] = s
		}
		if q.boolean(false, "insecure", "allowinsecure", "skip-cert-verify") {
			c["skip-cert-verify"] = true
		}
		if xs := q.list("alpn"); len(xs) > 0 {
			c["alpn"] = xs
		}
		if s := q.value("obfs"); s != "" {
			c["obfs"] = s
		}
		if s := q.value("obfs-password", "obfspassword"); s != "" {
			c["obfs-password"] = s
		}
		for _, pair := range [][2]string{{"upmbps", "up"}, {"downmbps", "down"}, {"protocol", "protocol"}, {"ports", "ports"}} {
			if s := q.value(pair[0], pair[1]); s != "" {
				if pair[1] == "up" || pair[1] == "down" {
					c[pair[1]] = numberOrText(s)
				} else {
					c[pair[1]] = s
				}
			}
		}
	case "tuic", "mieru":
		username, password, found := strings.Cut(u.userinfo, ":")
		if !found || username == "" || password == "" {
			return nil
		}
		c["password"] = password
		if scheme == "tuic" {
			c["uuid"] = username
			if s := q.value("sni", "servername"); s != "" {
				c["sni"] = s
			}
			if q.boolean(false, "insecure", "allowinsecure", "skip-cert-verify") {
				c["skip-cert-verify"] = true
			}
			for _, row := range [][3]string{{"congestion_control", "congestion-controller", "bbr"}, {"congestion-controller", "congestion-controller", "bbr"}, {"udp_relay_mode", "udp-relay-mode", "native"}, {"udp-relay-mode", "udp-relay-mode", "native"}} {
				if s := q.value(row[0]); s != "" {
					c[row[1]] = s
				} else if _, exists := c[row[1]]; !exists {
					c[row[1]] = row[2]
				}
			}
			if xs := q.list("alpn"); len(xs) > 0 {
				c["alpn"] = xs
			}
		} else {
			c["username"] = username
			c["transport"] = mieruTransport(q.value("transport"))
			if s := q.value("multiplexing", "multiplex"); s != "" {
				c["multiplexing"] = mieruMultiplexing(s)
			}
			if s := mieruPortRange(q.value("port-range", "port_range", "portrange")); s != "" {
				c["port-range"] = s
			}
		}
	default:
		return nil
	}
	return coreNode(scheme, c)
}

func parseSSPlugin(c map[string]any, s string) {
	var parts []string
	for _, p := range strings.Split(s, ";") {
		if strings.TrimSpace(p) != "" {
			parts = append(parts, strings.TrimSpace(unquote(p)))
		}
	}
	if len(parts) == 0 {
		return
	}
	plugin := strings.ToLower(parts[0])
	if plugin == "obfs-local" || plugin == "simple-obfs" {
		plugin = "obfs"
	}
	c["plugin"] = plugin
	o := map[string]any{}
	for _, p := range parts[1:] {
		k, v, found := strings.Cut(p, "=")
		k, v = strings.ToLower(strings.TrimSpace(k)), strings.TrimSpace(v)
		if !found {
			o[k] = true
		} else {
			if k == "obfs" {
				k = "mode"
			} else if k == "obfs-host" {
				k = "host"
			}
			o[k] = v
		}
	}
	if len(o) > 0 {
		c["plugin-opts"] = o
	}
}

func parseSS(line string) *Node {
	if len(line) < len("ss://") {
		return nil
	}
	body, fragment, _ := strings.Cut(line[len("ss://"):], "#")
	body, rawQuery, _ := strings.Cut(body, "?")
	q := parseQuery(rawQuery)
	var credentials, address string
	if i := strings.LastIndexByte(body, '@'); i >= 0 {
		credentials, address = unquote(body[:i]), body[i+1:]
		if decoded := decodeBase64(credentials); decoded != "" {
			credentials = decoded
		}
	} else {
		decoded := decodeBase64(body)
		if base, queryString, found := strings.Cut(decoded, "/?"); found {
			decoded = base
			for k, v := range parseQuery(queryString) {
				q[k] = v
			}
		}
		i := strings.LastIndexByte(decoded, '@')
		if i < 0 {
			return nil
		}
		credentials, address = decoded[:i], decoded[i+1:]
	}
	method, password, found := strings.Cut(credentials, ":")
	if !found || method == "" || password == "" {
		return nil
	}
	u, ok := splitURI("//" + strings.TrimLeft(address, "/"))
	if !ok {
		return nil
	}
	c := map[string]any{"name": unquote(fragment), "type": "ss", "server": u.host, "port": u.port, "cipher": method, "password": password, "udp": true}
	if p := q.value("plugin"); p != "" {
		parseSSPlugin(c, p)
	}
	return coreNode("ss", c)
}

func parseSSR(line string) *Node {
	if len(line) < len("ssr://") {
		return nil
	}
	payload, _, _ := strings.Cut(line[len("ssr://"):], "#")
	decoded := decodeBase64(payload)
	if decoded == "" {
		return nil
	}
	base, rawQuery, _ := strings.Cut(decoded, "/?")
	parts := make([]string, 6)
	for i := 5; i > 0; i-- {
		at := strings.LastIndexByte(base, ':')
		if at < 0 {
			return nil
		}
		parts[i], base = base[at+1:], base[:at]
	}
	parts[0] = base
	port, ok := integer(parts[1])
	if !ok {
		return nil
	}
	password := decodeBase64(unquote(parts[5]))
	if password == "" {
		return nil
	}
	q := parseQuery(rawQuery)
	name := text(first(decodeBase64(unquote(q.value("remarks"))), fragmentName(line)))
	c := map[string]any{"name": name, "type": "ssr", "server": parts[0], "port": port, "cipher": parts[3], "password": password, "protocol": parts[2], "obfs": parts[4], "udp": true}
	for _, pair := range [][2]string{{"protoparam", "protocol-param"}, {"obfsparam", "obfs-param"}} {
		if v := decodeBase64(unquote(q.value(pair[0]))); v != "" {
			c[pair[1]] = v
		}
	}
	return coreNode("ssr", c)
}

func parseVMess(line string) *Node {
	if len(line) < len("vmess://") {
		return nil
	}
	payload, _, _ := strings.Cut(line[len("vmess://"):], "#")
	var data map[string]any
	if !decodeJSON(decodeBase64(payload), &data) || data == nil {
		return nil
	}
	port, ok := integer(first(data["port"], 0))
	if !ok {
		return nil
	}
	uuid := strings.TrimSpace(str(first(data["id"], data["uuid"])))
	if uuid == "" {
		return nil
	}
	c := map[string]any{"name": text(first(data["ps"], fragmentName(line))), "type": "vmess", "server": str(first(data["add"], data["server"])), "port": port, "uuid": uuid, "cipher": text(first(data["scy"], data["cipher"], "auto")), "udp": true}
	aid, _ := integer(first(data["aid"], data["alterId"], data["alter-id"], 0))
	c["alterId"] = aid
	q := query{}
	for key, value := range map[string]any{"host": data["host"], "path": data["path"], "servicename": first(data["path"], data["serviceName"]), "sni": first(data["sni"], data["servername"]), "fp": data["fp"], "alpn": data["alpn"]} {
		if value != nil && text(value) != "" {
			q[key] = []string{text(value)}
		}
	}
	tls := strings.ToLower(strings.TrimSpace(str(data["tls"])))
	applyTLS(c, q, "servername", tls == "tls" || tls == "1" || tls == "true")
	insecure := strings.ToLower(strings.TrimSpace(str(data["allowInsecure"])))
	if insecure == "1" || insecure == "true" {
		c["skip-cert-verify"] = true
	}
	applyTransport(c, q, text(first(data["net"], data["network"], "tcp")))
	return coreNode("vmess", c)
}
