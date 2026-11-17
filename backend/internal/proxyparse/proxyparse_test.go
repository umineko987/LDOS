package proxyparse

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// URI/document fixtures are ported from test_proxy_site_gallery.py and
// test_proxy_sources.py; no network or runtime files are used.
const fixtureUUID = "11111111-1111-1111-1111-111111111111"

func encodeFixture(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

func assertConfig(t *testing.T, n *Node, scheme string, want map[string]any) {
	t.Helper()
	if n == nil {
		t.Fatal("expected parsed node")
	}
	if n.Scheme != scheme || n.Usable || n.Endpoint != "" || n.Note != tunnelNote {
		t.Fatalf("incorrect tunnel semantics: %v", n)
	}
	gotJSON, err := json.Marshal(n.CoreConfig)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("core configuration mismatch\ngot: %s\nwant: %s", gotJSON, wantJSON)
	}
}

func TestDirectNodesAndAuthenticatedSOCKS(t *testing.T) {
	for _, row := range []struct {
		line, scheme, host             string
		port                           int
		user, password, endpoint, name string
	}{
		{"127.0.0.1:18080", "http", "127.0.0.1", 18080, "", "", "http://127.0.0.1:18080", ""},
		{"proxy.fixture.invalid:18080:fixture-user:fixture-pass:more", "http", "proxy.fixture.invalid", 18080, "fixture-user", "fixture-pass:more", "http://fixture-user:fixture-pass%3Amore@proxy.fixture.invalid:18080", ""},
		{"http://fixture-user:fixture-pass@127.0.0.1:18080#LOCAL", "http", "127.0.0.1", 18080, "fixture-user", "fixture-pass", "http://fixture-user:fixture-pass@127.0.0.1:18080", "LOCAL"},
		{"HTTPS://PROXY.EXAMPLE#TLS", "https", "proxy.example", 443, "", "", "https://proxy.example:443", "TLS"},
		{"socks4://127.0.0.1:18081#SECOND", "socks4", "127.0.0.1", 18081, "", "", "socks4://127.0.0.1:18081", "SECOND"},
		{"socks5://127.0.0.1:18081", "socks5", "127.0.0.1", 18081, "", "", "socks5://127.0.0.1:18081", ""},
		{"socks5h://127.0.0.1", "socks5h", "127.0.0.1", 80, "", "", "socks5h://127.0.0.1:80", ""},
		{"http://fixture%40user:fixture%2Fpass@[2001:db8::1]:8443#JP%20HTTP", "http", "2001:db8::1", 8443, "fixture@user", "fixture/pass", "http://fixture%40user:fixture%2Fpass@[2001:db8::1]:8443", "JP HTTP"},
	} {
		t.Run(row.scheme+row.name, func(t *testing.T) {
			n := ParseLine(" \ufeff" + row.line + "\ufeff ")
			if n == nil || !n.Usable {
				t.Fatalf("expected usable direct proxy: %v", n)
			}
			if n.Scheme != row.scheme || n.Host != row.host || n.Port != row.port || n.Username != row.user || n.Password != row.password || n.Endpoint != row.endpoint || n.Name != row.name || len(n.CoreConfig) != 0 {
				t.Fatal("direct node fields differ")
			}
		})
	}
	for _, scheme := range []string{"socks5", "socks5h"} {
		n := ParseLine(scheme + "://fixture-user:fixture-pass@proxy.example:1080#AUTH")
		assertConfig(t, n, "socks5", map[string]any{"name": "AUTH", "type": "socks5", "server": "proxy.example", "port": 1080, "username": "fixture-user", "password": "fixture-pass", "udp": true})
		if strings.Contains(n.Raw, "fixture-pass") || n.Username != "" || n.Password != "" {
			t.Fatal("private SOCKS credentials escaped core config")
		}
	}
	n := ParseLine("socks4://fixture-user:fixture-pass@proxy.example:1080#AUTH")
	if n == nil || n.Usable || len(n.CoreConfig) != 0 || n.Note != socks4Note || n.Endpoint != "" {
		t.Fatalf("authenticated SOCKS4 must remain unsupported: %v", n)
	}
}

func TestTunnelURICoreConfigurations(t *testing.T) {
	vmess := `{"v":"2","ps":"VMESS","add":"vmess.example","port":"443","id":"` + fixtureUUID + `","aid":"1","scy":"auto","net":"ws","host":"cdn.example","path":"/ws","tls":"tls","sni":"edge.example"}`
	ssr := encodeFixture("ssr.example:443:auth_sha1_v4:aes-256-cfb:tls1.2_ticket_auth:" + encodeFixture("ssr-secret") + "/?remarks=" + encodeFixture("SSR") + "&protoparam=" + encodeFixture("fixture-user") + "&obfsparam=" + encodeFixture("cdn.example"))
	rows := []struct {
		scheme, line string
		want         map[string]any
	}{
		{"vless", "vless://" + fixtureUUID + "@vless.example:443?security=reality&type=tcp&sni=www.example.com&fp=chrome&pbk=public-key&sid=abcd&flow=xtls-rprx-vision#VLESS", map[string]any{"uuid": fixtureUUID, "udp": true, "tls": true, "servername": "www.example.com", "client-fingerprint": "chrome", "reality-opts": map[string]any{"public-key": "public-key", "short-id": "abcd"}, "flow": "xtls-rprx-vision", "network": "tcp"}},
		{"trojan", "trojan://trojan-secret@trojan.example:443?type=ws&host=cdn.example&path=%2Fws&sni=edge.example#TROJAN", map[string]any{"password": "trojan-secret", "udp": true, "sni": "edge.example", "network": "ws", "ws-opts": map[string]any{"path": "/ws", "headers": map[string]any{"Host": "cdn.example"}}}},
		{"ss", "ss://" + encodeFixture("aes-256-gcm:ss-secret") + "@ss.example:8388?plugin=v2ray-plugin%3Bmode%3Dwebsocket%3Bhost%3Dcdn.example#SS", map[string]any{"cipher": "aes-256-gcm", "password": "ss-secret", "udp": true, "plugin": "v2ray-plugin", "plugin-opts": map[string]any{"mode": "websocket", "host": "cdn.example"}}},
		{"ssr", "ssr://" + ssr, map[string]any{"cipher": "aes-256-cfb", "password": "ssr-secret", "protocol": "auth_sha1_v4", "obfs": "tls1.2_ticket_auth", "udp": true, "protocol-param": "fixture-user", "obfs-param": "cdn.example"}},
		{"vmess", "vmess://" + encodeFixture(vmess), map[string]any{"uuid": fixtureUUID, "alterId": 1, "cipher": "auto", "udp": true, "tls": true, "servername": "edge.example", "network": "ws", "ws-opts": map[string]any{"path": "/ws", "headers": map[string]any{"Host": "cdn.example"}}}},
		{"hysteria", "hysteria://hysteria.example:443?protocol=udp&upmbps=50&downmbps=100#HYSTERIA", map[string]any{"protocol": "udp", "up": 50, "down": 100}},
		{"hysteria2", "hy2://hy2-secret@hy2.example:443?sni=edge.example&obfs=salamander&obfs-password=mask#HY2", map[string]any{"password": "hy2-secret", "sni": "edge.example", "obfs": "salamander", "obfs-password": "mask"}},
		{"tuic", "tuic://" + fixtureUUID + ":tuic-secret@tuic.example:443?sni=edge.example#TUIC", map[string]any{"uuid": fixtureUUID, "password": "tuic-secret", "sni": "edge.example", "congestion-controller": "bbr", "udp-relay-mode": "native"}},
		{"anytls", "anytls://any-secret@anytls.example:443?sni=edge.example&insecure=1&idle-session-timeout=30&min-idle-session=auto#ANYTLS", map[string]any{"password": "any-secret", "sni": "edge.example", "skip-cert-verify": true, "idle-session-timeout": 30, "min-idle-session": "auto"}},
		{"mieru", "mieru://user:mieru-secret@mieru.example:8443?transport=tcp&multiplexing=low&port-range=8443-8450#MIERU", map[string]any{"username": "user", "password": "mieru-secret", "transport": "TCP", "multiplexing": "MULTIPLEXING_LOW", "port-range": "8443-8450"}},
	}
	for _, row := range rows {
		t.Run(row.scheme, func(t *testing.T) {
			n := ParseLine(row.line)
			if n == nil {
				t.Fatal("node missing")
			}
			row.want["name"], row.want["type"], row.want["server"] = strings.ToUpper(row.scheme), row.scheme, row.scheme+".example"
			row.want["port"] = 443
			if row.scheme == "ss" {
				row.want["port"] = 8388
			}
			if row.scheme == "hysteria2" {
				row.want["name"], row.want["server"] = "HY2", "hy2.example"
			}
			if row.scheme == "mieru" {
				delete(row.want, "port")
				if n.Port != 8443 {
					t.Fatal("mieru node port changed")
				}
			}
			assertConfig(t, n, row.scheme, row.want)
		})
	}
	ss := ParseLine("ss://" + encodeFixture("aes-256-gcm:ss-secret@ss.example:8388/?plugin=obfs-local;obfs=http;obfs-host=cdn.example;tls") + "#SS")
	if ss == nil || ss.CoreConfig["plugin"] != "obfs" {
		t.Fatal("legacy SS/plugin parsing failed")
	}
	if !reflect.DeepEqual(ss.CoreConfig["plugin-opts"], map[string]any{"mode": "http", "host": "cdn.example", "tls": true}) {
		t.Fatal("plugin options differ")
	}
}

func TestTransportAndTLSOptions(t *testing.T) {
	for _, row := range []struct {
		network, key string
		options      map[string]any
	}{
		{"ws", "ws-opts", map[string]any{"path": "/ws", "headers": map[string]any{"Host": "cdn.example"}}},
		{"grpc", "grpc-opts", map[string]any{"grpc-service-name": "fixture"}},
		{"http-upgrade", "http-upgrade-opts", map[string]any{"path": "/ws", "headers": map[string]any{"Host": "cdn.example"}}},
		{"splithttp", "xhttp-opts", map[string]any{"path": "/ws", "host": "cdn.example", "mode": "auto"}},
		{"http", "http-opts", map[string]any{"path": []string{"/ws"}, "headers": map[string]any{"Host": []string{"cdn.example"}}}},
		{"h2", "h2-opts", map[string]any{"path": "/ws", "host": []string{"cdn.example"}}},
	} {
		t.Run(row.network, func(t *testing.T) {
			n := ParseLine("vless://" + fixtureUUID + "@vless.example:443?type=" + row.network + "&host=cdn.example&path=%2Fws&servicename=fixture&mode=auto&security=tls&udp=false&allowinsecure=yes&alpn=h2,http%2F1.1&packetencoding=xudp&encryption=none")
			if n == nil || !reflect.DeepEqual(n.CoreConfig[row.key], row.options) {
				t.Fatal("transport conversion mismatch")
			}
			if n.CoreConfig["tls"] != true || n.CoreConfig["skip-cert-verify"] != true || n.CoreConfig["udp"] != false || n.CoreConfig["packet-encoding"] != "xudp" || n.CoreConfig["encryption"] != "none" {
				t.Fatal("TLS/query conversion mismatch")
			}
			if !reflect.DeepEqual(n.CoreConfig["alpn"], []string{"h2", "http/1.1"}) {
				t.Fatal("ALPN conversion mismatch")
			}
		})
	}
}

func TestMalformedNodesAreIsolatedAndSecretsAreNotFormatted(t *testing.T) {
	for _, line := range []string{"", "# comment", "unsupported://fixture", "127.0.0.1:65536", "proxy.example:0", "http://proxy.example:bad", "https://", "http://[127.0.0.1]:80", "http://[bad:1", "vless://u@[bad:1", "vless://proxy.example:443", "trojan://proxy.example:443", "hy2://proxy.example:443", "tuic://user@proxy.example:443", "mieru://user:@proxy.example:8443", "ss://broken", "ssr://broken", "vmess://" + encodeFixture(`[]`), "vmess://" + encodeFixture(`{"add":"vmess.example","port":443}`), "vmess://" + encodeFixture(`{"id":"fixture","port":{},"add":"vmess.example"}`)} {
		if ParseLine(line) != nil {
			t.Fatalf("malformed fixture unexpectedly accepted: %q", line)
		}
	}
	for _, line := range []string{"http://fixture-user:fixture-pass@127.0.0.1:18080#LOCAL", "vless://" + fixtureUUID + "@proxy.fixture.invalid:443?security=tls#JP-01", "trojan://trojan-secret@trojan.example:443#TROJAN"} {
		n := ParseLine(line)
		for _, format := range []string{"%v", "%+v", "%#v", "%s"} {
			for _, value := range []any{*n, n, []Node{*n}} {
				output := fmt.Sprintf(format, value)
				for _, secret := range []string{"fixture-user", "fixture-pass", fixtureUUID, "trojan-secret"} {
					if strings.Contains(output, secret) {
						t.Fatal("node formatting exposes credentials")
					}
				}
			}
		}
	}
}

func TestURICompatibilityEdges(t *testing.T) {
	n := ParseLine("http://fixture%zz:fixture%20%25@[2001:db8::1]:80#100%")
	if n == nil || n.Username != "fixture%zz" || n.Password != "fixture %" || n.Name != "100%" || n.Endpoint != "http://fixture%25zz:fixture%20%25@[2001:db8::1]:80" {
		t.Fatal("userinfo/name percent decoding differs from Python")
	}
	n = ParseLine("http://[fe80::1%25Zone]:80")
	if n == nil || n.Host != "fe80::1%25Zone" {
		t.Fatal("IPv6 zone spelling changed")
	}
	payload := `{"id":"fixture","add":"vmess.example","port":443,"alpn":["h2","http/1.1"]}`
	n = ParseLine("vmess://" + encodeFixture(payload) + "====")
	if n == nil || !reflect.DeepEqual(n.CoreConfig["alpn"], []string{"['h2'", "'http/1.1']"}) {
		t.Fatal("VMess must preserve the source parser's list-to-text query behavior")
	}
	if ParseLine("vmess://"+encodeFixture(payload+" {}")) != nil {
		t.Fatal("VMess accepted trailing JSON")
	}
}

func FuzzParseLine(f *testing.F) {
	for _, seed := range []string{"http://fixture-user:fixture-pass@127.0.0.1:18080", "vless://u@[bad:1", "ss://broken", "vmess://" + encodeFixture(`{"id":"fixture","add":"vmess.example","port":443}`), "mieru://user:mieru-secret@mieru.example:8443?port-range=8443-8450"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		n := ParseLine(raw)
		if n != nil && (!validHostPort(n.Host, n.Port) || n.Usable && n.Endpoint == "") {
			t.Fatal("invalid parsed node")
		}
	})
}
