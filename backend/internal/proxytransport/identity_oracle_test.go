package proxytransport

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"ldos/backend/internal/proxyparse"
)

// Optional, offline migration oracle. Production never executes Python; normal Go
// tests use the fixed PyYAML goldens in config_test.go. Point this environment
// variable at an existing interpreter with PyYAML to audit identity compatibility.
func TestIdentityPyYAMLOracle(t *testing.T) {
	python := os.Getenv("LDOS_TEST_PYYAML_ORACLE")
	if python == "" {
		t.Skip("optional offline PyYAML identity oracle")
	}
	const script = `
import json, yaml, random
values = [None, True, False, 0, -1, 1.0, -0.0, 1e-6, 1e-4, 1e15, 1e16,
    '', 'yes', 'YES', 'Yes', 'yEs', 'no', 'off', '08', '0o17', '0xabc', '1e10',
    '1.0e+10', '2001-01-01', '2001-1-1 01:01:01', '10:20', 'http://x',
    'a: b', '#a', '-x', '- x', '? x', 'a#b', 'a #b', "it's", ' a ',
    'line1\nline2', '\nline\n', 'x\n\ny', 'x\n y', 'x \ny', 'a\tb',
    'a\rb', '\x00', '\x85', '\u2028', '\u2029', '\ufeff', '香港 🐱',
    'x'*90+' y', 'x '*100, 'quote: '+'x '*60, '\t'+'🐱 x '*60,
    {}, [], {'key': [True, 'yes', {'nested': 'value'}]}, [[1,2], [3,4]]]
random.seed(42)
for _ in range(120):
    values.append(''.join(random.choice('abc: #\n\t\r\u0085\u00a0\u2028\u2029\ufeff🐱\"\'') for _ in range(random.randint(1,110))))
cases = [{'value': value} for value in values]
print(json.dumps([{'input': value, 'yaml': yaml.safe_dump(value, allow_unicode=True, sort_keys=True)} for value in cases], ensure_ascii=True))
`
	output, err := exec.Command(python, "-c", script).Output()
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Input map[string]any `json:"input"`
		YAML  string         `json:"yaml"`
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	decoder.UseNumber()
	if err := decoder.Decode(&cases); err != nil {
		t.Fatal(err)
	}
	for i, fixture := range cases {
		got, err := pythonYAML(fixture.Input)
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if got != fixture.YAML {
			t.Errorf("case %d (%s):\ngot  %q\nwant %q", i, strings.TrimSpace(fixture.YAML), got, fixture.YAML)
		}
	}
	t.Logf("matched %d offline PyYAML cases", len(cases))
}

func TestSubscriptionIdentityMatchesLegacyCore(t *testing.T) {
	python := os.Getenv("LDOS_TEST_PYYAML_ORACLE")
	if python == "" {
		t.Skip("optional offline legacy core oracle")
	}
	legacyDir, err := filepath.Abs("../../../gallery-dl-backend")
	if err != nil {
		t.Fatal(err)
	}
	const script = `
import json, sys, yaml
sys.path.insert(0, sys.argv[1])
from gdl_backend.proxy_sources import parse_subscription_text
from gdl_backend.proxy_core import build_transport_config
config, endpoints = build_transport_config(parse_subscription_text(sys.stdin.read()), listen_host="127.0.0.1", base_port=29100)
print(json.dumps([{"id": endpoint.id, "yaml": yaml.safe_dump(proxy, allow_unicode=True, sort_keys=True)} for proxy, endpoint in zip(config["proxies"], endpoints)]))
`
	for name, source := range map[string]string{"aliases": aliasSubscriptionFixture, "explicit-keys": explicitKeySubscriptionFixture(), "merge": mergeSubscriptionFixture} {
		t.Run(name, func(t *testing.T) {
			command := exec.Command(python, "-c", script, legacyDir)
			command.Stdin = strings.NewReader(source)
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("legacy core oracle: %v\n%s", err, output)
			}
			var expected []struct {
				ID   string `json:"id"`
				YAML string `json:"yaml"`
			}
			if err := json.Unmarshal(output, &expected); err != nil {
				t.Fatal(err)
			}
			config, endpoints, err := BuildConfig(proxyparse.ParseSubscription(source), "127.0.0.1", 29100)
			if err != nil {
				t.Fatal(err)
			}
			if len(expected) == 0 || len(expected) != len(endpoints) {
				t.Fatalf("node count: Go %d, Python %d", len(endpoints), len(expected))
			}
			for i, endpoint := range endpoints {
				serialized, err := pythonYAML(config["proxies"].([]any)[i].(map[string]any))
				if err != nil {
					t.Fatal(err)
				}
				if serialized != expected[i].YAML {
					t.Errorf("identity YAML mismatch\ngot:\n%s\nwant:\n%s", serialized, expected[i].YAML)
				}
				if endpoint.ID != expected[i].ID {
					t.Errorf("ID mismatch: Go %s, Python %s", endpoint.ID, expected[i].ID)
				}
				t.Logf("legacy ID %s; serialized identity:\n%s", expected[i].ID, expected[i].YAML)
			}
		})
	}
}

func TestIdentityGraphPyYAMLOracle(t *testing.T) {
	python := os.Getenv("LDOS_TEST_PYYAML_ORACLE")
	if python == "" {
		t.Skip("optional offline PyYAML graph oracle")
	}
	const script = `
import json, random, yaml
random.seed(92)
keys = ['', 'ordinary', 'a'*122, 'b'*123, 'c'*128, '香港'*70, 'long '*40,
        'a\nb', '\nkey\n', 'a\x85b', 'a\u2028b', 'a\u2029b', 'a\rb', 'a\tb', 'quote: key', 'yes']
cases = []
for case in range(100):
    graph = [{'kind':'map', 'entries':{}}]
    for i in range(1, 10):
        graph.append({'kind':random.choice(['map','list'])})
    for i, node in enumerate(graph):
        values = []
        for j in range(random.randrange(0, 5)):
            value = {'ref':random.randrange(len(graph))} if random.randrange(4) else random.choice(['plain', 'yes', 'two\nlines', None, True, 7])
            values.append(value)
        if node['kind'] == 'map':
            node['entries'] = {random.choice(keys): value for value in values}
        else:
            node['items'] = values
    graph[0]['entries'].update({'shared-a':{'ref':1}, 'shared-b':{'ref':1}})
    objects = [{} if node['kind']=='map' else [] for node in graph]
    def value(v):
        return objects[v['ref']] if isinstance(v, dict) else v
    for i, node in enumerate(graph):
        if node['kind']=='map':
            objects[i].update({key:value(v) for key,v in node['entries'].items()})
        else:
            objects[i].extend(value(v) for v in node['items'])
    cases.append({'graph':graph, 'yaml':yaml.safe_dump(objects[0], sort_keys=True, allow_unicode=True)})
print(json.dumps(cases))
`
	output, err := exec.Command(python, "-c", script).Output()
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Graph []struct {
			Kind    string         `json:"kind"`
			Entries map[string]any `json:"entries"`
			Items   []any          `json:"items"`
		} `json:"graph"`
		YAML string `json:"yaml"`
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	decoder.UseNumber()
	if err := decoder.Decode(&cases); err != nil {
		t.Fatal(err)
	}
	for i, fixture := range cases {
		objects := make([]any, len(fixture.Graph))
		for j, node := range fixture.Graph {
			if node.Kind == "map" {
				objects[j] = make(map[string]any)
			} else {
				objects[j] = make([]any, len(node.Items), max(1, len(node.Items)))
			}
		}
		value := func(v any) any {
			if reference, ok := v.(map[string]any); ok {
				index, err := reference["ref"].(json.Number).Int64()
				if err != nil {
					t.Fatal(err)
				}
				return objects[index]
			}
			return v
		}
		for j, node := range fixture.Graph {
			if node.Kind == "map" {
				for key, v := range node.Entries {
					objects[j].(map[string]any)[key] = value(v)
				}
			} else {
				for k, v := range node.Items {
					objects[j].([]any)[k] = value(v)
				}
			}
		}
		for _, graph := range []map[string]any{objects[0].(map[string]any), cloneConfig(objects[0]).(map[string]any)} {
			got, err := pythonYAML(graph)
			if err != nil {
				t.Fatalf("case %d: %v", i, err)
			}
			if got != fixture.YAML {
				t.Errorf("case %d\ngot  %q\nwant %q", i, got, fixture.YAML)
			}
		}
	}
	t.Logf("matched %d offline PyYAML object graphs before and after cloning", len(cases))
}
