package proxytransport

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	"gopkg.in/yaml.v3"
	"ldos/backend/internal/proxyparse"
)

func TestJSONCoreNumbersRemainNativeNumbers(t *testing.T) {
	nodes := proxyparse.ParseSubscription(`{"proxies":[{"name":"json","type":"vmess","server":"example.invalid","port":443.0,"alterId":0,"smux":{"max-streams":16},"test-float":1.5}]}`)
	if len(nodes) != 1 {
		t.Fatalf("parser returned %d nodes", len(nodes))
	}
	config, endpoints, err := BuildConfig(nodes, "127.0.0.1", 29100)
	if err != nil || len(endpoints) != 1 {
		t.Fatalf("numeric port was dropped: %v", err)
	}
	data, err := pythonYAML(config)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := yaml.Unmarshal([]byte(data), &decoded); err != nil {
		t.Fatal(err)
	}
	proxy := decoded["proxies"].([]any)[0].(map[string]any)
	if proxy["alterId"] != 0 || proxy["port"] != 443 || proxy["test-float"] != 1.5 || proxy["smux"].(map[string]any)["max-streams"] != 16 {
		t.Fatalf("JSON numeric fields changed type: %s", data)
	}
	if got, err := pythonYAML(map[string]any{"value": json.Number("-0")}); err != nil || got != "value: 0\n" {
		t.Fatalf("negative integer zero changed identity: %q %v", got, err)
	}
}

func TestPyYAMLUnicodeNELRegression(t *testing.T) {
	got, err := pythonYAML(map[string]any{"value": "\u0085"})
	if err != nil || got != "value: '\u0085  '\n" {
		t.Fatalf("NEL identity: %q %v", got, err)
	}
}
func testNodes() []proxyparse.Node {
	return []proxyparse.Node{
		{CoreConfig: map[string]any{"name": "JP-TROJAN", "type": "trojan", "server": "jp.example", "port": 443, "password": "fixture-secret", "sni": "edge.example"}},
		{CoreConfig: map[string]any{"name": "US-VLESS", "type": "vless", "server": "us.example", "port": 443, "uuid": "11111111-1111-1111-1111-111111111111", "tls": true}},
		{Port: 5000, CoreConfig: map[string]any{"name": "RANGE", "type": "mieru", "server": "range.example", "port-range": "5000-5010", "username": "user", "password": "secret", "transport": "TCP", "multiplexing": "MULTIPLEXING_LOW"}},
	}
}

func TestBuildConfigPyYAMLIdentities(t *testing.T) {
	nodes := testNodes()
	original := cloneConfig(nodes[2].CoreConfig)
	config, endpoints, err := BuildConfig(nodes, "127.0.0.1", 29100)
	if err != nil {
		t.Fatal(err)
	}
	// Generated offline with PyYAML 6.0.3 safe_dump(allow_unicode=True, sort_keys=True).
	ids := []string{"efb27e09294087688b06", "9d9c584b6194242649a2", "cac9053996327816317f"}
	proxies, listeners := config["proxies"].([]any), config["listeners"].([]any)
	if len(endpoints) != 3 || len(proxies) != 3 || len(listeners) != 3 {
		t.Fatalf("wrong listener count: %d", len(endpoints))
	}
	for i, ep := range endpoints {
		if ep.ID != ids[i] {
			t.Errorf("node %d identity %s, want %s", i, ep.ID, ids[i])
		}
		if ep.LocalHTTP != fmt.Sprintf("http://127.0.0.1:%d", 29100+i) {
			t.Error(ep.LocalHTTP)
		}
		listener := listeners[i].(map[string]any)
		if listener["proxy"] != proxies[i].(map[string]any)["name"] || listener["port"] != 29100+i {
			t.Error("listener mapping changed")
		}
	}
	if _, ok := proxies[2].(map[string]any)["port"]; ok {
		t.Error("mieru port-range regained port")
	}
	if !reflect.DeepEqual(nodes[2].CoreConfig, original) {
		t.Error("BuildConfig mutated input")
	}
	if config["allow-lan"] != false || config["mode"] != "rule" || !reflect.DeepEqual(config["rules"], []string{"MATCH,DIRECT"}) {
		t.Error("routing config changed")
	}
	if _, _, err := BuildConfig(nodes, "", 65534); err == nil {
		t.Error("port overflow accepted")
	}
}

func TestBuildConfigNamesAndSkippedNodes(t *testing.T) {
	node := proxyparse.Node{Scheme: "trojan", Host: "example.invalid", Port: 443, Name: "  same\x00\n name  ", CoreConfig: map[string]any{}}
	nodes := []proxyparse.Node{{}, node, node, {CoreConfig: map[string]any{"type": "trojan", "server": "x", "port": "bad"}}}
	_, endpoints, err := BuildConfig(nodes, "::1", 12345)
	if err != nil {
		t.Fatal(err)
	}
	if len(endpoints) != 2 || endpoints[0].Name != "same name" || endpoints[1].Name != "same name-2" {
		t.Fatalf("unexpected endpoints: %+v", endpoints)
	}
	if endpoints[0].LocalHTTP != "http://[::1]:12345" {
		t.Error(endpoints[0].LocalHTTP)
	}
}

func TestPyYAMLNestedIdentity(t *testing.T) {
	value := map[string]any{
		"name": "香港 🐱", "type": "vless", "server": "example.invalid", "port": 443, "tls": true, "uuid": "0000",
		"ws-opts": map[string]any{"path": "/hello", "headers": map[string]any{"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "Host": "example.invalid"}},
		"alpn":    []string{"h2", "http/1.1"},
		"values":  []any{"yes", "08", "1e+5", "10:20", nil, true, 1e-6, 1000000.0, map[string]any{}, []any{}, "line1\nline2", "first \nsecond", "a\tb", "quote: it's"},
	}
	const expected = "alpn:\n- h2\n- http/1.1\nname: 香港 🐱\nport: 443\nserver: example.invalid\ntls: true\ntype: vless\nuuid: '0000'\nvalues:\n- 'yes'\n- 08\n- 1e+5\n- '10:20'\n- null\n- true\n- 1.0e-06\n- 1000000.0\n- {}\n- []\n- 'line1\n\n  line2'\n- \"first \\nsecond\"\n- \"a\\tb\"\n- 'quote: it''s'\nws-opts:\n  headers:\n    Host: example.invalid\n    User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)\n      Chrome/130.0.0.0 Safari/537.36\n  path: /hello\n"
	got, err := pythonYAML(value)
	if err != nil {
		t.Fatal(err)
	}
	if got != expected {
		t.Fatalf("PyYAML output mismatch\ngot:\n%s\nwant:\n%s", got, expected)
	}
	digest := sha256.Sum256([]byte(got))
	if fmt.Sprintf("%x", digest)[:20] != "67d33b069b28e67afea3" {
		t.Error("nested identity changed")
	}
}

func TestIdentityUnsupportedValuesAreExplicit(t *testing.T) {
	if _, err := pythonYAML(map[string]any{"key": make(chan int)}); err == nil {
		t.Error("unsupported identity silently accepted")
	}
}
