package proxyparse

import (
	"errors"
	"io"
	"reflect"
	"strings"

	"gopkg.in/yaml.v3"
)

var errCyclicYAML = errors.New("cyclic YAML aliases are not supported")
var errInvalidYAMLGraph = errors.New("invalid YAML mapping or merge")

func decodeClashYAML(raw string) (map[string]any, error) {
	decoder := yaml.NewDecoder(strings.NewReader(raw))
	var document, trailing yaml.Node
	if err := decoder.Decode(&document); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, errInvalidYAMLGraph
	}
	// Check before duplicate-key normalization, including unused anchors. A
	// cyclic document must never reach scalar coercion or the line fallback.
	if !acyclicYAML(&document, make(map[*yaml.Node]uint8)) {
		return nil, errCyclicYAML
	}
	normalizeYAML(&document)
	graph := yamlValueGraph{values: make(map[*yaml.Node]any)}
	value, err := graph.decode(document.Content[0])
	if err != nil {
		return nil, err
	}
	result, ok := value.(map[string]any)
	if !ok {
		return nil, errInvalidYAMLGraph
	}
	return result, nil
}

func acyclicYAML(node *yaml.Node, state map[*yaml.Node]uint8) bool {
	if state[node] != 0 {
		return state[node] == 2
	}
	state[node] = 1
	if node.Kind == yaml.AliasNode && !acyclicYAML(node.Alias, state) {
		return false
	}
	for _, child := range node.Content {
		if !acyclicYAML(child, state) {
			return false
		}
	}
	state[node] = 2
	return true
}

// Each collection node owns one value. Aliases reuse it; merges only copy map
// entries, so nested maps and lists retain the source object's identity.
type yamlValueGraph struct {
	values map[*yaml.Node]any
}

func (g *yamlValueGraph) decode(node *yaml.Node) (any, error) {
	if value, ok := g.values[node]; ok {
		return value, nil
	}
	var value any
	switch node.Kind {
	case yaml.AliasNode:
		return g.decode(node.Alias)
	case yaml.ScalarNode:
		if err := node.Decode(&value); err != nil {
			return nil, err
		}
	case yaml.SequenceNode:
		// A nonzero capacity gives distinct empty YAML lists distinct backing
		// storage too, while an alias returns the same slice header.
		items := make([]any, len(node.Content), max(1, len(node.Content)))
		for i, child := range node.Content {
			item, err := g.decode(child)
			if err != nil {
				return nil, err
			}
			items[i] = item
		}
		value = items
	case yaml.MappingNode:
		mapping, err := g.mapping(node)
		if err != nil {
			return nil, err
		}
		value = mapping
	default:
		return nil, errInvalidYAMLGraph
	}
	g.values[node] = value
	return value, nil
}

func (g *yamlValueGraph) mapping(node *yaml.Node) (any, error) {
	entries := make(map[any]any)
	var merge *yaml.Node
	for i := 0; i < len(node.Content); i += 2 {
		keyNode, valueNode := node.Content[i], node.Content[i+1]
		if keyNode.ShortTag() == "!!merge" {
			merge = valueNode
			continue
		}
		key, err := g.decode(keyNode)
		if err != nil {
			return nil, err
		}
		if key != nil && !reflect.TypeOf(key).Comparable() {
			return nil, errInvalidYAMLGraph
		}
		value, err := g.decode(valueNode)
		if err != nil {
			return nil, err
		}
		entries[key] = value
	}
	if merge != nil {
		if err := g.merge(entries, merge); err != nil {
			return nil, err
		}
	}
	// Match yaml.v3's string maps for ordinary Clash keys, retaining scalar
	// non-string keys in general maps rather than coercing their values.
	for key := range entries {
		if _, ok := key.(string); !ok {
			return entries, nil
		}
	}
	result := make(map[string]any, len(entries))
	for key, value := range entries {
		result[key.(string)] = value
	}
	return result, nil
}

func (g *yamlValueGraph) merge(target map[any]any, node *yaml.Node) error {
	if node.Kind == yaml.AliasNode {
		// A merge alias must name a map, not a sequence of maps.
		if node.Alias.Kind != yaml.MappingNode {
			return errInvalidYAMLGraph
		}
		node = node.Alias
	}
	sources := []*yaml.Node{node}
	if node.Kind == yaml.SequenceNode {
		sources = node.Content
	}
	for _, source := range sources {
		if source.Kind == yaml.AliasNode {
			source = source.Alias
		}
		if source.Kind != yaml.MappingNode {
			return errInvalidYAMLGraph
		}
		value, err := g.decode(source)
		if err != nil {
			return err
		}
		// Explicit keys beat merges; earlier maps beat later maps in a merge
		// sequence. Assignment keeps every nested collection shared.
		switch mapping := value.(type) {
		case map[string]any:
			for key, item := range mapping {
				if _, exists := target[key]; !exists {
					target[key] = item
				}
			}
		case map[any]any:
			for key, item := range mapping {
				if _, exists := target[key]; !exists {
					target[key] = item
				}
			}
		}
	}
	return nil
}

// PyYAML safe_load uses YAML 1.1 booleans and permits repeated mapping keys
// (the last value wins). Normalize nodes before constructing the shared value graph.
func normalizeYAML(node *yaml.Node) {
	if node.Kind == yaml.ScalarNode && node.Tag == "!!str" && node.Style == 0 {
		switch node.Value {
		case "yes", "Yes", "YES", "on", "On", "ON":
			node.Tag, node.Value = "!!bool", "true"
		case "no", "No", "NO", "off", "Off", "OFF":
			node.Tag, node.Value = "!!bool", "false"
		}
	}
	for _, child := range node.Content {
		normalizeYAML(child)
	}
	if node.Kind != yaml.MappingNode {
		return
	}
	last := make(map[string]int)
	for i := 0; i < len(node.Content); i += 2 {
		key := node.Content[i]
		if key.Kind == yaml.ScalarNode && key.Tag != "!!merge" {
			last[key.Tag+":"+key.Value] = i
		}
	}
	content := make([]*yaml.Node, 0, len(node.Content))
	for i := 0; i < len(node.Content); i += 2 {
		key := node.Content[i]
		if key.Kind == yaml.ScalarNode && key.Tag != "!!merge" && last[key.Tag+":"+key.Value] != i {
			continue
		}
		content = append(content, key, node.Content[i+1])
	}
	node.Content = content
}
