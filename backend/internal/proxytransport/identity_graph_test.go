package proxytransport

import (
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
	"ldos/backend/internal/proxyparse"
)

// IDs captured from the actual legacy parse_subscription_text ->
// build_transport_config pipeline with PyYAML 6.0.3 (see the optional oracle).
func TestParsedSubscriptionIdentityGoldens(t *testing.T) {
	for _, tc := range []struct{ name, source, id string }{
		{"aliases", aliasSubscriptionFixture, "6f2eb2df0926984420eb"},
		{"merge", mergeSubscriptionFixture, "3aa69c1a7702acb42128"},
		{"explicit-keys", explicitKeySubscriptionFixture(), "bb53bdc9560dd1c0c28d"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			nodes := proxyparse.ParseSubscription(tc.source)
			config, endpoints, err := BuildConfig(nodes, "127.0.0.1", 29100)
			if err != nil || len(endpoints) != 1 {
				t.Fatalf("BuildConfig: %v; endpoints %d", err, len(endpoints))
			}
			if endpoints[0].ID != tc.id {
				t.Fatalf("ID %s, want legacy %s", endpoints[0].ID, tc.id)
			}
			data, err := pythonYAML(config)
			if err != nil {
				t.Fatal(err)
			}
			// The emitted native config must retain sharing, too; decoding and rebuilding
			// it should produce exactly the same node identity as the subscription.
			_, roundtrip, err := BuildConfig(proxyparse.ParseSubscription(data), "127.0.0.1", 29100)
			if err != nil || len(roundtrip) != 1 || roundtrip[0].ID != tc.id {
				t.Fatalf("runtime config lost identity: %v; endpoints %+v", err, roundtrip)
			}
		})
	}
}

func TestCloneConfigPreservesObjectGraph(t *testing.T) {
	headers := map[string]any{"Host": "edge.invalid"}
	list := []any{headers}
	empty := make([]any, 0, 1)
	stringsList := []string{"h2"}
	input := map[string]any{"a": headers, "b": headers, "list": list, "list-again": list, "empty": empty, "empty-again": empty, "strings": stringsList, "strings-again": stringsList}
	input["self"] = input
	clone := cloneConfig(input).(map[string]any)
	clone["a"].(map[string]any)["Host"] = "changed.invalid"
	if clone["b"].(map[string]any)["Host"] != "changed.invalid" || clone["list"].([]any)[0].(map[string]any)["Host"] != "changed.invalid" {
		t.Error("map alias lost")
	}
	if headers["Host"] != "edge.invalid" {
		t.Error("clone modified input map")
	}
	clone["list"].([]any)[0] = "changed"
	if clone["list-again"].([]any)[0] != "changed" || reflect.TypeOf(list[0]).Kind() != reflect.Map {
		t.Error("list alias or isolation lost")
	}
	clone["strings"].([]string)[0] = "changed"
	if clone["strings-again"].([]string)[0] != "changed" || stringsList[0] != "h2" {
		t.Error("typed list alias or isolation lost")
	}
	clone["self"].(map[string]any)["new-key"] = true
	if clone["new-key"] != true || input["new-key"] != nil {
		t.Error("cycle or isolation lost")
	}
	first, ok := configReference(clone["empty"])
	second, _ := configReference(clone["empty-again"])
	original, _ := configReference(empty)
	if !ok || first != second || first == original {
		t.Error("shared empty list did not survive deep copy")
	}
}

func TestPyYAMLAnchorsAndCycles(t *testing.T) {
	inner := map[string]any{"value": "nested"}
	outer := map[string]any{"inner": inner}
	emptyMap := map[string]any{}
	emptyList := make([]any, 0, 1)
	sequence := []any{inner, inner}
	cycle := map[string]any{}
	cycleList := make([]any, 1)
	cycleList[0] = cycleList
	cycle["list"], cycle["self"] = cycleList, cycle
	cases := []struct {
		name  string
		value map[string]any
		want  string
	}{
		{"second-visit-order", map[string]any{"a": outer, "b": inner, "z": outer}, "a: &id002\n  inner: &id001\n    value: nested\nb: *id001\nz: *id002\n"},
		{"empty-and-independent", map[string]any{"a": emptyMap, "b": emptyList, "c": emptyMap, "d": emptyList, "x": map[string]any{}, "y": []any{}, "z": []any{}}, "a: &id001 {}\nb: &id002 []\nc: *id001\nd: *id002\nx: {}\ny: []\nz: []\n"},
		{"sequence-anchors", map[string]any{"a": sequence, "b": sequence}, "a: &id002\n- &id001\n  value: nested\n- *id001\nb: *id002\n"},
		{"independent-equal-values", map[string]any{"a": map[string]any{"value": "same"}, "b": map[string]any{"value": "same"}, "c": []any{1}, "d": []any{1}}, "a:\n  value: same\nb:\n  value: same\nc:\n- 1\nd:\n- 1\n"},
		{"recursive-map-and-list", cycle, "&id002\nlist: &id001\n- *id001\nself: *id002\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, value := range []map[string]any{tc.value, cloneConfig(tc.value).(map[string]any)} {
				got, err := pythonYAML(value)
				if err != nil || got != tc.want {
					t.Fatalf("got %q (%v), want %q", got, err, tc.want)
				}
			}
		})
	}
}

func TestPyYAMLExplicitStringKeys(t *testing.T) {
	cases := []struct {
		value map[string]any
		want  string
	}{
		{map[string]any{"": 1}, "? ''\n: 1\n"},
		{map[string]any{"a\nb": 1}, "? 'a\n\n  b'\n: 1\n"},
		{map[string]any{strings.Repeat("a", 122): 1}, strings.Repeat("a", 122) + ": 1\n"},
		{map[string]any{strings.Repeat("a", 123): 1}, "? " + strings.Repeat("a", 123) + "\n: 1\n"},
		{map[string]any{strings.Repeat("a", 128): []any{1, 2}}, "? " + strings.Repeat("a", 128) + "\n: - 1\n  - 2\n"},
		{map[string]any{"a\nb": map[string]any{"c": "d"}}, "? 'a\n\n  b'\n: c: d\n"},
		{map[string]any{"list": []any{map[string]any{"a\nb": []any{1, 2}}}}, "list:\n- ? 'a\n\n    b'\n  : - 1\n    - 2\n"},
	}
	for _, tc := range cases {
		got, err := pythonYAML(tc.value)
		if err != nil || got != tc.want {
			t.Errorf("got %q (%v), want %q", got, err, tc.want)
		}
	}
}

func TestBuildConfigAndRuntimeSerializationAcceptCycles(t *testing.T) {
	source := map[string]any{"type": "trojan", "server": "example.invalid", "port": 443, "name": "cycle"}
	source["self"] = source
	config, endpoints, err := BuildConfig([]proxyparse.Node{{CoreConfig: source}}, "127.0.0.1", 29100)
	if err != nil || len(endpoints) != 1 {
		t.Fatalf("cyclic config failed: %v", err)
	}
	data, err := pythonYAML(config) // The same serialization used before writing config.yaml.
	if err != nil {
		t.Fatal(err)
	}
	var syntax yaml.Node
	if err := yaml.Unmarshal([]byte(data), &syntax); err != nil {
		t.Fatalf("invalid native YAML: %v", err)
	}
	if !strings.Contains(data, "&id001") || !strings.Contains(data, "self: *id001") {
		t.Fatalf("cycle was not emitted as an alias: %s", data)
	}
	if source["self"].(map[string]any)["name"] != "cycle" {
		t.Error("source graph mutated")
	}
}

const aliasSubscriptionFixture = `proxies:
  - name: ALIAS
    type: vmess
    server: fixture.invalid
    port: 443
    uuid: fixture
    alpn: &alpn [h2, http/1.1]
    http-opts:
      headers: &headers
        Host: edge.invalid
        X-Empty: &empty-map {}
        X-List: &empty-list []
    ws-opts:
      headers: *headers
    tls-opts:
      alpn: *alpn
    extensions:
      empty-map: *empty-map
      empty-list: *empty-list
      distinct-map: {}
      distinct-list: []
`

func explicitKeySubscriptionFixture() string {
	return "proxies:\n  - name: KEYS\n    type: trojan\n    server: fixture.invalid\n    port: 443\n    password: fixture\n    ? \"two\\nlines\"\n    : {key: value}\n    ? ''\n    : [one, two]\n    ? " + strings.Repeat("long ", 35) + "end\n    : [1, 2]\n"
}

const mergeSubscriptionFixture = `proxies:
  - name: MERGE
    type: trojan
    server: fixture.invalid
    port: 443
    password: fixture
    extensions: &defaults
      headers: &headers {Host: edge.invalid}
      alpn: &alpn [h2, http/1.1]
    http-opts:
      <<: *defaults
    ws-opts:
      headers: *headers
    another: *defaults
`
