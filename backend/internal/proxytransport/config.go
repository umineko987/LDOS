package proxytransport

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"ldos/backend/internal/proxyparse"
)

func BuildConfig(nodes []proxyparse.Node, host string, basePort int) (map[string]any, []Endpoint, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		host = "127.0.0.1"
	}
	proxies := []any{}
	listeners := []any{}
	endpoints := []Endpoint{}
	used := map[string]bool{}
	for index, node := range nodes {
		if node.CoreConfig == nil {
			continue
		}
		source := cloneConfig(node.CoreConfig).(map[string]any)
		protocol := strings.ToLower(strings.TrimSpace(coreText(coreFirst(source["type"], node.Scheme, ""))))
		server := strings.TrimSpace(coreText(coreFirst(source["server"], node.Host, "")))
		port := coreInt(coreFirst(source["port"], node.Port, 0))
		if protocol == "" || server == "" || port < 1 || port > 65535 {
			continue
		}
		name := coreText(coreFirst(source["name"], node.Name, ""))
		name = truncateRunes(strings.Join(strings.Fields(strings.ReplaceAll(name, "\x00", "")), " "), 180)
		if name == "" {
			name = fmt.Sprintf("node-%d", index+1)
		}
		base := name
		for suffix := 2; used[name]; suffix++ {
			name = fmt.Sprintf("%s-%d", truncateRunes(base, 160), suffix)
		}
		used[name] = true
		source["name"], source["type"], source["server"] = name, protocol, server
		if protocol == "mieru" && strings.TrimSpace(coreText(coreFirst(source["port-range"], ""))) != "" {
			delete(source, "port")
		} else {
			source["port"] = port
		}
		identity, err := pythonYAML(source)
		if err != nil {
			return nil, nil, fmt.Errorf("代理节点 %d 无法生成兼容的身份: %w", index+1, err)
		}
		digest := sha256.Sum256([]byte(identity))
		listenPort := basePort + len(endpoints)
		if listenPort < 1 || listenPort > 65535 {
			return nil, nil, fmt.Errorf("代理核心监听端口超出范围")
		}
		proxies = append(proxies, source)
		listeners = append(listeners, map[string]any{"name": fmt.Sprintf("native-http-%d", listenPort), "type": "http", "listen": host, "port": listenPort, "proxy": name, "users": []any{}})
		endpoints = append(endpoints, Endpoint{ID: fmt.Sprintf("%x", digest)[:20], Name: name, SourceProtocol: protocol, SourceHost: server, LocalHTTP: "http://" + net.JoinHostPort(host, strconv.Itoa(listenPort))})
	}
	return map[string]any{"allow-lan": false, "mode": "rule", "log-level": "warning", "proxies": proxies, "listeners": listeners, "rules": []string{"MATCH,DIRECT"}}, endpoints, nil
}

// A slice's backing storage and bounds identify aliases produced by the parser.
// Zero-capacity empty slices have no distinct storage, so treating their common
// runtime address as identity would merge independent lists. The YAML parser
// reserves one element of capacity for empty sequences to preserve their identity.
type collectionReference struct {
	typeOf           reflect.Type
	pointer          uintptr
	length, capacity int
}

func configReference(v any) (collectionReference, bool) {
	switch x := v.(type) {
	case map[string]any:
		if x != nil {
			return collectionReference{typeOf: reflect.TypeOf(x), pointer: reflect.ValueOf(x).Pointer()}, true
		}
	case []any:
		if cap(x) > 0 {
			return collectionReference{reflect.TypeOf(x), reflect.ValueOf(x).Pointer(), len(x), cap(x)}, true
		}
	case []string:
		if cap(x) > 0 {
			return collectionReference{reflect.TypeOf(x), reflect.ValueOf(x).Pointer(), len(x), cap(x)}, true
		}
	}
	return collectionReference{}, false
}

func cloneConfig(v any) any { return cloneConfigGraph(v, make(map[collectionReference]any)) }

func cloneConfigGraph(v any, memo map[collectionReference]any) any {
	reference, identifiable := configReference(v)
	if identifiable {
		if copy, exists := memo[reference]; exists {
			return copy
		}
	}
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		if identifiable {
			memo[reference] = out
		}
		for key, value := range x {
			out[key] = cloneConfigGraph(value, memo)
		}
		return out
	case []any:
		out := make([]any, len(x), max(1, len(x)))
		if identifiable {
			memo[reference] = out
		}
		for i, value := range x {
			out[i] = cloneConfigGraph(value, memo)
		}
		return out
	case []string:
		out := make([]string, len(x), max(1, len(x)))
		if identifiable {
			memo[reference] = out
		}
		copy(out, x)
		return out
	default:
		return v
	}
}

func truncateRunes(s string, limit int) string {
	r := []rune(s)
	if len(r) > limit {
		return string(r[:limit])
	}
	return s
}
func coreFirst(values ...any) any {
	for _, v := range values {
		if v == nil {
			continue
		}
		if number, ok := v.(json.Number); ok {
			f, _ := number.Float64()
			if f == 0 {
				continue
			}
		}
		r := reflect.ValueOf(v)
		switch r.Kind() {
		case reflect.String, reflect.Slice, reflect.Map:
			if r.Len() == 0 {
				continue
			}
		case reflect.Bool:
			if !r.Bool() {
				continue
			}
		case reflect.Int, reflect.Int64:
			if r.Int() == 0 {
				continue
			}
		case reflect.Uint, reflect.Uint64:
			if r.Uint() == 0 {
				continue
			}
		case reflect.Float32, reflect.Float64:
			if r.Float() == 0 {
				continue
			}
		}
		return v
	}
	return values[len(values)-1]
}
func coreText(v any) string {
	if v == nil {
		return "None"
	}
	if b, ok := v.(bool); ok {
		if b {
			return "True"
		}
		return "False"
	}
	return fmt.Sprint(v)
}
func coreInt(v any) int {
	switch x := v.(type) {
	case int:
		return x
	case int64:
		return int(x)
	case uint64:
		if x > math.MaxInt {
			return 0
		}
		return int(x)
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) || x >= float64(math.MaxInt) || x < float64(math.MinInt) {
			return 0
		}
		return int(x)
	case bool:
		if x {
			return 1
		}
		return 0
	case json.Number:
		if strings.ContainsAny(string(x), ".eE") {
			f, err := x.Float64()
			if err != nil {
				return 0
			}
			return coreInt(f)
		}
		i, _ := strconv.Atoi(string(x))
		return i
	default:
		i, _ := strconv.Atoi(strings.TrimSpace(coreText(v)))
		return i
	}
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
