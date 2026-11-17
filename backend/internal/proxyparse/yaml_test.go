package proxyparse

import (
	"reflect"
	"testing"
)

func TestClashAliasesShareNestedCollections(t *testing.T) {
	nodes := ParseSubscription(`proxies:
  - &node
    name: TUNNEL
    type: trojan
    server: tunnel.example
    port: 443
    password: secret
    ws-opts:
      headers: &headers {Host: cdn.example}
    http-upgrade-opts:
      headers: *headers
    alpn: &alpn [h2, http/1.1]
    alternate-alpn: *alpn
  - <<: *node
    name: MERGED
  - *node
`)
	if len(nodes) != 3 {
		t.Fatalf("expected original, merged and aliased proxies; got %d", len(nodes))
	}
	config := nodes[0].CoreConfig
	headers := config["ws-opts"].(map[string]any)["headers"].(map[string]any)
	headers["Host"] = "edge.example"
	alpn := config["alpn"].([]any)
	alpn[0] = "fixture-alpn"
	for i, node := range nodes {
		for _, key := range []string{"ws-opts", "http-upgrade-opts"} {
			if node.CoreConfig[key].(map[string]any)["headers"].(map[string]any)["Host"] != "edge.example" {
				t.Fatalf("node %d %s lost the shared headers map", i, key)
			}
		}
		for _, key := range []string{"alpn", "alternate-alpn"} {
			if node.CoreConfig[key].([]any)[0] != "fixture-alpn" {
				t.Fatalf("node %d %s lost the shared ALPN list", i, key)
			}
		}
	}
	// parseClash still copies the top-level map, just as Python dict(item) does.
	config["name"] = "changed"
	if nodes[1].CoreConfig["name"] != "MERGED" || nodes[2].CoreConfig["name"] != "TUNNEL" {
		t.Fatal("top-level core configs unexpectedly share a map")
	}
}

func TestClashEqualCollectionsRemainDistinct(t *testing.T) {
	nodes := ParseSubscription(`proxies:
  - type: trojan
    server: tunnel.example
    port: 443
    password: secret
    first-headers: {Host: cdn.example}
    second-headers: {Host: cdn.example}
    first-alpn: [h2, http/1.1]
    second-alpn: [h2, http/1.1]
    first-empty-map: &empty-map {}
    alias-empty-map: *empty-map
    second-empty-map: {}
    first-empty-list: &empty-list []
    alias-empty-list: *empty-list
    second-empty-list: []
`)
	if len(nodes) != 1 {
		t.Fatal("expected one proxy")
	}
	config := nodes[0].CoreConfig
	config["first-headers"].(map[string]any)["Host"] = "edge.example"
	if config["second-headers"].(map[string]any)["Host"] != "cdn.example" {
		t.Fatal("equal headers maps were incorrectly shared")
	}
	config["first-alpn"].([]any)[0] = "fixture-alpn"
	if config["second-alpn"].([]any)[0] != "h2" {
		t.Fatal("equal ALPN lists were incorrectly shared")
	}
	config["first-empty-map"].(map[string]any)["Host"] = "cdn.example"
	if config["alias-empty-map"].(map[string]any)["Host"] != "cdn.example" || len(config["second-empty-map"].(map[string]any)) != 0 {
		t.Fatal("empty maps lost their original sharing relationships")
	}
	first := reflect.ValueOf(config["first-empty-list"]).Pointer()
	alias := reflect.ValueOf(config["alias-empty-list"]).Pointer()
	second := reflect.ValueOf(config["second-empty-list"]).Pointer()
	if first != alias || first == second {
		t.Fatal("empty lists lost their original sharing relationships")
	}
}

func TestClashMergePrecedencePreservesSharedValues(t *testing.T) {
	nodes := ParseSubscription(`proxies:
  - &first
    name: FIRST
    type: trojan
    server: tunnel.example
    port: 443
    password: secret
    udp: yes
    tls: off
    ws-opts: &options {headers: {Host: cdn.example}}
    alpn: &alpn [h2, http/1.1]
  - &second
    name: SECOND
    type: trojan
    server: tunnel.example
    port: 8443
    password: secret
    udp: no
    tls: on
    ws-opts: {headers: {Host: edge.example}}
    alpn: [h2]
    second-only: true
  - <<: [*first, *second]
    name: SEQUENCE
    port: 9443
    port: 10443
  - name: BEFORE
    tls: null
    <<: *first
  - <<: {<<: *first, name: INNER}
    name: NESTED
    options-alias: *options
    "<<": {alpn: *alpn}
`)
	if len(nodes) != 5 {
		t.Fatalf("expected five proxies, got %d", len(nodes))
	}
	sequence := nodes[2].CoreConfig
	if nodes[2].Port != 10443 || sequence["udp"] != true || sequence["tls"] != false || sequence["second-only"] != true {
		t.Fatal("merge sequence precedence, explicit key override or YAML 1.1 booleans changed")
	}
	if nodes[3].Name != "BEFORE" || nodes[3].CoreConfig["tls"] != nil || nodes[4].Name != "NESTED" {
		t.Fatal("explicit keys before merge or nested merge precedence changed")
	}
	options := nodes[0].CoreConfig["ws-opts"].(map[string]any)
	options["headers"].(map[string]any)["Host"] = "merged.example"
	nodes[0].CoreConfig["alpn"].([]any)[0] = "fixture-alpn"
	for i := 2; i < len(nodes); i++ {
		config := nodes[i].CoreConfig
		if config["ws-opts"].(map[string]any)["headers"].(map[string]any)["Host"] != "merged.example" || config["alpn"].([]any)[0] != "fixture-alpn" {
			t.Fatalf("node %d merge copied nested values instead of sharing them", i)
		}
	}
	if nodes[1].CoreConfig["ws-opts"].(map[string]any)["headers"].(map[string]any)["Host"] != "edge.example" {
		t.Fatal("merge changed a distinct source map")
	}
	last := nodes[4].CoreConfig
	if last["options-alias"].(map[string]any)["headers"].(map[string]any)["Host"] != "merged.example" || last["<<"].(map[string]any)["alpn"].([]any)[0] != "fixture-alpn" {
		t.Fatal("nested aliases or quoted merge key lost their meaning")
	}
}

func TestClashAliasRetainsOverwrittenAnchor(t *testing.T) {
	nodes := ParseSubscription(`proxies:
  - type: trojan
    server: tunnel.example
    port: 443
    password: secret
    headers: &old {Host: cdn.example}
    headers: {Host: edge.example}
    old-headers: *old
    old-headers-again: *old
`)
	if len(nodes) != 1 {
		t.Fatal("expected one proxy")
	}
	config := nodes[0].CoreConfig
	config["old-headers"].(map[string]any)["Host"] = "changed.example"
	if config["old-headers-again"].(map[string]any)["Host"] != "changed.example" || config["headers"].(map[string]any)["Host"] != "edge.example" {
		t.Fatal("duplicate-key normalization lost or conflated an aliased anchor")
	}
}

func TestClashCyclicAliasesRejectWholeSubscription(t *testing.T) {
	for _, row := range []struct{ name, cycle string }{
		{"map", "cycle: &cycle {self: *cycle}"},
		{"list", "cycle: &cycle [*cycle]"},
		{"indirect", "cycle: &cycle {items: [&inner {parent: *cycle}]}"},
		{"merge", "cycle: &cycle {<<: *cycle}"},
		{"overwritten", "cycle: &cycle [*cycle]\ncycle: []"},
	} {
		t.Run(row.name, func(t *testing.T) {
			input := "proxies:\n  - {type: http, server: proxy.example, port: 80}\n" + row.cycle + "\nnotes: |\n  http://127.0.0.1:18080\n"
			if _, err := decodeClashYAML(input); err != errCyclicYAML {
				t.Fatalf("expected explicit cycle error, got %v", err)
			}
			if got := ParseSubscription(input); got != nil {
				t.Fatal("cyclic YAML must reject valid nodes and never fall back to lines")
			}
		})
	}
}
