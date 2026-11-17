// Package proxysources stores complete, private runtime overrides of proxy sources.
// It does not fetch subscriptions or change the running proxy pool.
package proxysources

import (
	"crypto/sha256"
	"fmt"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	ManagedSourcesVersion      = 1
	MaxSubscriptionURLLength   = 4096
	MaxSubscriptions           = 128
	MaxInlineNodes             = 512
	MaxInlineNodeLength        = 16 * 1024
	MaxInlineNodeTotalChars    = 2 * 1024 * 1024
	MaxSourcePathLength        = 4096
	MaxSourceRequestBytes      = MaxInlineNodeTotalChars + 64*1024
	MaxManagedSourcesFileBytes = 4*(MaxInlineNodeTotalChars+MaxSubscriptions*MaxSubscriptionURLLength+MaxSourcePathLength) + 256*1024
	MaxNodeFileBytes           = 8 * 1024 * 1024
)

// Code preserves the Python API code. Category distinguishes the Python error
// classes even where corrupt, conflict and store_error share the same API code.
// Validation Category is "validation"; its Code identifies the input category.
type Error struct {
	Code     string
	Message  string
	Reason   string
	Category string
	Index    *int
	Details  map[string]any
}

func (e *Error) Error() string { return e.Message }

func storeError(category, reason, message string) *Error {
	code := "proxy_sources_store_error"
	switch category {
	case "not_found":
		code = "proxy_source_not_found"
	case "path_forbidden":
		code = "proxy_source_path_forbidden"
	}
	return &Error{Code: code, Message: message, Reason: reason, Category: category, Details: map[string]any{"reason": reason}}
}

func invalid(category, reason string, index *int) *Error {
	message := map[string]string{"subscription": "订阅地址无效", "inline_node": "内联节点无效", "node_file": "节点文件不可用", "source_id": "代理源标识格式无效"}[category]
	details := map[string]any{"reason": reason}
	if index != nil {
		details["index"] = *index
	}
	return &Error{Code: "invalid_proxy_" + category, Message: message, Reason: reason, Category: "validation", Index: index, Details: details}
}

func corrupt(reason string) *Error {
	return storeError("corrupt", reason, "运行时代理源覆盖无效")
}
func conflict() *Error {
	return storeError("conflict", "external_change", "运行时代理源覆盖已被并发修改，未保存本次变更")
}
func forbidden(reason string) *Error {
	return storeError("path_forbidden", reason, "节点文件路径不在许可范围内")
}
func managedForbidden(reason string) *Error {
	return storeError("path_forbidden", reason, "托管代理源路径不可用")
}

type Settings struct {
	SubscriptionURLs []string
	NodeFile         string
	InlineNodes      []string
	AllowedNodeRoots []string
}

// Snapshot owns its slices. Modifying a returned snapshot cannot change the
// store's frozen configuration baseline or subsequent snapshots.
type Snapshot struct {
	SubscriptionURLs     []string
	NodeFile             string
	InlineNodes          []string
	Source               string
	HasRuntimeOverride   bool
	RuntimeOverrideValid bool
	ConfiguredRevision   string
}

// Formatting snapshots must not disclose URLs, node credentials or file paths.
func (s Snapshot) String() string {
	return fmt.Sprintf("Snapshot{source:%q subscriptions:%d node_file:%t inline_nodes:%d has_runtime_override:%t runtime_override_valid:%t configured_revision:%q}", s.Source, len(s.SubscriptionURLs), s.NodeFile != "", len(s.InlineNodes), s.HasRuntimeOverride, s.RuntimeOverrideValid, s.ConfiguredRevision)
}
func (s Snapshot) GoString() string { return s.String() }

func isSpace(r rune) bool  { return unicode.IsSpace(r) || r >= 0x1c && r <= 0x1f }
func trim(s string) string { return strings.TrimFunc(s, isSpace) }

func uniqueTrimmed(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		value = trim(value)
		if value != "" && !seen[value] {
			result = append(result, value)
			seen[value] = true
		}
	}
	return result
}

// MakeSnapshot retains invalid legacy config values for the startup validation
// path, matching Python. Runtime mutations validate all values before writing.
func MakeSnapshot(settings Settings) Snapshot {
	subscriptions, nodes := uniqueTrimmed(settings.SubscriptionURLs), uniqueTrimmed(settings.InlineNodes)
	if normalized, err := normalizeSubscriptions(subscriptions); err == nil {
		subscriptions = normalized
	}
	if normalized, err := normalizeInlineNodes(nodes); err == nil {
		nodes = normalized
	}
	nodeFile := settings.NodeFile
	if nodeFile != "" {
		if absolute, err := filepath.Abs(nodeFile); err == nil {
			nodeFile = absolute
		}
	}
	source := "none"
	if len(subscriptions) != 0 || nodeFile != "" || len(nodes) != 0 {
		source = "config"
	}
	return snapshot(subscriptions, nodeFile, nodes, source, false, true)
}

func snapshot(subscriptions []string, nodeFile string, nodes []string, source string, present, valid bool) Snapshot {
	return Snapshot{SubscriptionURLs: append([]string{}, subscriptions...), NodeFile: nodeFile, InlineNodes: append([]string{}, nodes...), Source: source, HasRuntimeOverride: present, RuntimeOverrideValid: valid, ConfiguredRevision: configuredRevision(subscriptions, nodeFile, nodes)}
}

// Python json.dumps(ensure_ascii=False, sort_keys=True, separators=(",", ":"))
// differs from encoding/json for HTML and U+2028/U+2029. This small encoder is
// confined to the fixed string/list/null payloads in revisions and v1 documents.
func appendJSONString(dst []byte, value string) []byte {
	dst = append(dst, '"')
	for _, r := range value {
		switch r {
		case '"', '\\':
			dst = append(dst, '\\', byte(r))
		case '\b':
			dst = append(dst, '\\', 'b')
		case '\f':
			dst = append(dst, '\\', 'f')
		case '\n':
			dst = append(dst, '\\', 'n')
		case '\r':
			dst = append(dst, '\\', 'r')
		case '\t':
			dst = append(dst, '\\', 't')
		default:
			if r < 32 {
				dst = append(dst, fmt.Sprintf("\\u%04x", r)...)
			} else {
				dst = utf8.AppendRune(dst, r)
			}
		}
	}
	return append(dst, '"')
}

func appendStringList(dst []byte, values []string) []byte {
	dst = append(dst, '[')
	for i, value := range values {
		if i > 0 {
			dst = append(dst, ',')
		}
		dst = appendJSONString(dst, value)
	}
	return append(dst, ']')
}

func configuredRevision(subscriptions []string, nodeFile string, nodes []string) string {
	data := []byte("ldos-managed-proxy-sources-revision-v1\x00{\"inline_nodes\":")
	data = appendStringList(data, nodes)
	data = append(data, `,"node_file":`...)
	if nodeFile == "" {
		data = append(data, "null"...)
	} else {
		data = appendJSONString(data, nodeFile)
	}
	data = append(data, `,"subscription_urls":`...)
	data = appendStringList(data, subscriptions)
	data = append(data, '}')
	return fmt.Sprintf("%x", sha256.Sum256(data))
}

func sourceID(prefix, value string) string {
	return prefix + "_" + fmt.Sprintf("%x", sha256.Sum256([]byte("ldos-proxy-source-id-v1:"+prefix+"\x00"+value)))
}

func validateSourceID(id, prefix string) error {
	if len(id) != len(prefix)+65 || !strings.HasPrefix(id, prefix+"_") {
		return invalid("source_id", "invalid_source_id", nil)
	}
	for _, c := range id[len(prefix)+1:] {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return invalid("source_id", "invalid_source_id", nil)
		}
	}
	return nil
}

func idIndex(prefix string, values []string) (map[string]int, error) {
	result := make(map[string]int, len(values))
	for i, value := range values {
		id := sourceID(prefix, value)
		if previous, exists := result[id]; exists && values[previous] != value {
			return nil, storeError("conflict", "opaque_id_collision", "代理源标识发生冲突，未执行操作")
		}
		result[id] = i
	}
	return result, nil
}

func findID(prefix, id string, values []string) (int, error) {
	index, err := idIndex(prefix, values)
	if err != nil {
		return 0, err
	}
	i, exists := index[id]
	if !exists {
		return 0, storeError("not_found", "not_found", "代理源不存在")
	}
	return i, nil
}

func hasControl(value string) bool {
	for _, r := range value {
		if r < 32 || r == 127 {
			return true
		}
	}
	return false
}
