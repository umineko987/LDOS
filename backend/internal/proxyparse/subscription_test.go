package proxyparse

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestSubscriptionDocuments(t *testing.T) {
	clash := `proxies:
  - {name: JP-HTTP, type: http, server: 127.0.0.1, port: 18082}
  - name: TUNNEL
    type: trojan
    server: tunnel.example
    port: 443
    password: secret
    ws-opts: {path: /ws, headers: {Host: cdn.example}}
  - {name: HY2-ALIAS, type: hy2, server: hy2.example, port: 443, password: secret}
  - {name: AUTH, type: socks5h, server: proxy.example, port: 1080, username: fixture-user, password: fixture-pass}
  - {name: MIERU, type: mieru, server: mieru.example, port-range: 5000-5010, username: user, password: mieru-secret}
  - {type: unsupported, server: proxy.example, port: 443}
  - invalid
`
	nodes := ParseSubscription(clash)
	if len(nodes) != 5 || !nodes[0].Usable || nodes[1].Usable || nodes[2].Scheme != "hysteria2" || nodes[2].CoreConfig["type"] != "hysteria2" || nodes[3].Scheme != "socks5" || nodes[3].Usable || nodes[4].Port != 5000 {
		t.Fatalf("Clash conversion failed: %v", nodes)
	}
	if nodes[1].CoreConfig["password"] != "secret" || nodes[1].CoreConfig["ws-opts"] == nil {
		t.Fatal("Clash private config lost")
	}
	const singbox = `{"outbounds":[{"type":"vless","tag":"SINGBOX","server":"singbox.example","server_port":443,"uuid":"11111111-1111-1111-1111-111111111111","tls":{"enabled":true,"server_name":"edge.example","utls":{"enabled":true,"fingerprint":"chrome"},"reality":{"public_key":"public-key","short_id":"abcd"}},"transport":{"type":"ws","path":"/ws","headers":{"Host":"cdn.example","User-Agent":"fixture-agent"}}},{"type":"mieru","tag":"SINGBOX-MIERU","server":"mieru.example","server_ports":["5000:5010"],"username":"user","password":"mieru-secret","transport":"tcp","multiplexing":"middle"},{"type":"direct"},{"type":"selector"}]}`
	nodes = ParseSubscription(singbox)
	if len(nodes) != 2 {
		t.Fatalf("sing-box got %d nodes", len(nodes))
	}
	assertConfig(t, &nodes[0], "vless", map[string]any{"name": "SINGBOX", "type": "vless", "server": "singbox.example", "port": 443, "uuid": fixtureUUID, "udp": true, "tls": true, "servername": "edge.example", "client-fingerprint": "chrome", "reality-opts": map[string]any{"public-key": "public-key", "short-id": "abcd"}, "network": "ws", "ws-opts": map[string]any{"path": "/ws", "headers": map[string]any{"Host": "cdn.example", "User-Agent": "fixture-agent"}}})
	assertConfig(t, &nodes[1], "mieru", map[string]any{"name": "SINGBOX-MIERU", "type": "mieru", "server": "mieru.example", "port-range": "5000-5010", "username": "user", "password": "mieru-secret", "transport": "TCP", "multiplexing": "MULTIPLEXING_MIDDLE"})
	for _, payload := range []string{`{"version":1,"servers":[{"id":"SIP008","server":"sip008.example","server_port":8388,"method":"aes-256-gcm","password":"sip-secret"}]}`, `[{"id":"SIP008","server":"sip008.example","server_port":8388,"method":"aes-256-gcm","password":"sip-secret"}]`} {
		nodes = ParseSubscription(payload)
		if len(nodes) != 1 {
			t.Fatal("SIP008 node missing")
		}
		assertConfig(t, &nodes[0], "ss", map[string]any{"name": "SIP008", "type": "ss", "server": "sip008.example", "port": 8388, "cipher": "aes-256-gcm", "password": "sip-secret", "udp": true})
	}
	for _, payload := range []string{`{"proxies":[{"type":"https","server":"proxy.example","port":443}]}`, `[{"type":"http","server":"proxy.example","server_port":8080}]`} {
		nodes = ParseSubscription(payload)
		if len(nodes) != 1 || !nodes[0].Usable {
			t.Fatal("direct JSON node missing")
		}
	}
}

func TestMalformedSubscriptionLinesAreIsolated(t *testing.T) {
	nodes := ParseSubscription("vless://u@[bad:1\nhttp://127.0.0.1:18080#HTTP\nvmess://broken\nsocks5://127.0.0.1:18081#SOCKS")
	if len(nodes) != 2 || nodes[0].Scheme != "http" || nodes[1].Scheme != "socks5" {
		t.Fatal("malformed line discarded valid neighbors")
	}
}

func TestBase64EnvelopeAndLimits(t *testing.T) {
	plain := "http://127.0.0.1:18080#HTTP\nsocks5://127.0.0.1:18081#SOCKS"
	for _, input := range []string{plain, encodeFixture(plain), base64.StdEncoding.EncodeToString([]byte("\ufeff" + plain)), encodeFixture("proxies:\n  - {type: http, server: 127.0.0.1, port: 18080}\n  - {type: socks5, server: 127.0.0.1, port: 18081}")} {
		if got := ParseSubscription(input); len(got) != 2 {
			t.Fatalf("base64 fixture produced %d nodes", len(got))
		}
	}
	// The Python decoder only unwraps content that already looks like a document
	// or has a newline; preserve that heuristic, including its plain double-wrap rejection.
	if got := ParseSubscription(encodeFixture(encodeFixture(plain))); len(got) != 0 {
		t.Fatal("unexpected plain nested envelope acceptance")
	}
	inner := encodeFixture(plain)
	nested := encodeFixture(inner[:8] + "\n" + inner[8:])
	if got := ParseSubscription(nested); len(got) != 2 {
		t.Fatal("two supported base64 envelopes were not decoded")
	}
	if got := ParseSubscription(encodeFixture(nested[:8] + "\n" + nested[8:])); len(got) != 0 {
		t.Fatal("base64 nesting limit was exceeded")
	}
	if got := ParseSubscription("http://127.0.0.1:18080#" + strings.Repeat("x", MaxSubscriptionBytes)); got != nil {
		t.Fatal("oversized subscription was not rejected")
	}
	if got := ParseSubscription(`{"outbounds":[{"type":"unsupported","server":"proxy.example","server_port":443}]}`); len(got) != 0 {
		t.Fatal("unsupported outbound reported as usable")
	}
}

func TestClashYAMLCompatibility(t *testing.T) {
	nodes := ParseSubscription(`proxies:
  - &node {type: trojan, server: tunnel.example, port: 443, port: 8443, password: secret, udp: yes, tls: off, quoted: "yes"}
  - {<<: *node, name: TUNNEL}
`)
	if len(nodes) != 2 {
		t.Fatal("YAML repeated keys or aliases discarded nodes")
	}
	for _, n := range nodes {
		if n.Port != 8443 || n.CoreConfig["udp"] != true || n.CoreConfig["tls"] != false || n.CoreConfig["quoted"] != "yes" {
			t.Fatal("PyYAML scalar or merge semantics changed")
		}
	}
	if nodes[1].Name != "TUNNEL" {
		t.Fatal("merged mapping override was lost")
	}
	if nodes := ParseSubscription("proxies:\n - {type: http, server: proxy.example, port: 80}\n---\nproxies:\n - {type: http, server: proxy.example, port: 443}"); len(nodes) != 0 {
		t.Fatal("multi-document YAML must be rejected like safe_load")
	}
}

func TestJSONPreservesPrivateIntegerPrecision(t *testing.T) {
	nodes := ParseSubscription(`{"proxies":[{"type":"vmess","server":"vmess.example","port":443,"uuid":"fixture","private-id":9007199254740993}]}`)
	if len(nodes) != 1 || text(nodes[0].CoreConfig["private-id"]) != "9007199254740993" {
		t.Fatal("private core field lost integer precision")
	}
}

func TestSingboxProtocolKeyConversion(t *testing.T) {
	for _, row := range []struct{ scheme, fields, expected string }{
		{"vmess", `"uuid":"fixture","alter_id":"1","security":"auto"`, `"uuid":"fixture","alterId":1,"cipher":"auto","udp":true`},
		{"trojan", `"password":"trojan-secret"`, `"password":"trojan-secret","udp":true`},
		{"hysteria", `"auth_str":"fixture-secret","up_mbps":50,"down_mbps":100`, `"auth-str":"fixture-secret","up":50,"down":100`},
		{"hysteria2", `"password":"hy2-secret","obfs":{"type":"salamander","password":"mask"}`, `"password":"hy2-secret","obfs":"salamander","obfs-password":"mask"`},
		{"tuic", `"uuid":"fixture","password":"tuic-secret","congestion_control":"cubic","udp_relay_mode":"quic"`, `"uuid":"fixture","password":"tuic-secret","congestion-controller":"cubic","udp-relay-mode":"quic"`},
		{"anytls", `"password":"any-secret"`, `"password":"any-secret"`},
		{"shadowsocks", `"method":"aes-256-gcm","password":"ss-secret","plugin":"simple-obfs","plugin_opts":"obfs=http;obfs-host=cdn.example"`, `"cipher":"aes-256-gcm","password":"ss-secret","udp":true,"plugin":"obfs","plugin-opts":{"mode":"http","host":"cdn.example"}`},
	} {
		t.Run(row.scheme, func(t *testing.T) {
			nodes := ParseSubscription(`{"outbounds":[{"type":"` + row.scheme + `","server":"proxy.example","server_port":443,` + row.fields + `}]}`)
			if len(nodes) != 1 {
				t.Fatal("sing-box node missing")
			}
			scheme := row.scheme
			if scheme == "shadowsocks" {
				scheme = "ss"
			}
			var want map[string]any
			if !decodeJSON("{"+row.expected+"}", &want) {
				t.Fatal("invalid expected fixture")
			}
			want["name"], want["type"], want["server"], want["port"] = scheme+"-proxy.example", scheme, "proxy.example", 443
			assertConfig(t, &nodes[0], scheme, want)
		})
	}
}
