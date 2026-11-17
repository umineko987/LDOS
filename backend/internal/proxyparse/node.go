// Package proxyparse parses proxy nodes without starting a transport or fetching subscriptions.
package proxyparse

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	MaxSubscriptionBytes = 8 * 1024 * 1024
	MaxBase64Depth       = 2
	tunnelNote           = "tunnel protocol requires a transport core"
	socks4Note           = "authenticated SOCKS4 is not supported by the transport core"
)

// Node contains private credentials. String and GoString deliberately omit all
// credential-bearing fields; callers control which fields they serialize as JSON.
type Node struct {
	Raw, Scheme, Host                  string
	Port                               int
	Username, Password, Name, Endpoint string
	Usable                             bool
	Note                               string
	CoreConfig                         map[string]any
}

func (n Node) String() string {
	return fmt.Sprintf("Node{Scheme:%q Host:%q Port:%d Usable:%t}", n.Scheme, n.Host, n.Port, n.Usable)
}

func (n Node) GoString() string { return n.String() }

func directScheme(s string) bool {
	switch s {
	case "http", "https", "socks4", "socks5", "socks5h":
		return true
	}
	return false
}

func tunnelScheme(s string) bool {
	switch s {
	case "vless", "vmess", "ss", "ssr", "trojan", "hysteria", "hysteria2", "hy2", "tuic", "anytls", "mieru":
		return true
	}
	return false
}

func truth(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case int:
		return x != 0
	case int64:
		return x != 0
	case uint64:
		return x != 0
	case float64:
		return x != 0
	case json.Number:
		n, _ := x.Float64()
		return n != 0
	case []any:
		return len(x) != 0
	case map[string]any:
		return len(x) != 0
	}
	return true
}

func first(vs ...any) any {
	for _, v := range vs {
		if truth(v) {
			return v
		}
	}
	if len(vs) > 0 {
		return vs[len(vs)-1]
	}
	return nil
}

// text mirrors Python scalar str(), including its boolean spellings.
func text(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case string:
		return x
	case bool:
		if x {
			return "True"
		}
		return "False"
	case json.Number:
		if strings.ContainsAny(string(x), ".eE") {
			n, _ := x.Float64()
			return text(n)
		}
		return string(x)
	case float64:
		s := strconv.FormatFloat(x, 'g', -1, 64)
		if !strings.ContainsAny(s, ".e") && !math.IsInf(x, 0) && !math.IsNaN(x) {
			s += ".0"
		}
		return s
	case []any:
		parts := make([]string, len(x))
		for i, value := range x {
			parts[i] = pythonRepr(value)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	default:
		return fmt.Sprint(v)
	}
}

func pythonRepr(v any) string {
	if s, ok := v.(string); ok {
		quoted := strconv.Quote(s)
		body := quoted[1 : len(quoted)-1]
		if strings.Contains(s, "'") && !strings.Contains(s, "\"") {
			return quoted
		}
		body = strings.ReplaceAll(body, `\"`, `"`)
		return "'" + strings.ReplaceAll(body, "'", `\'`) + "'"
	}
	return text(v)
}

// Decode a whole document, preserving integer precision in private core fields.
func decodeJSON(raw string, target any) bool {
	d := json.NewDecoder(strings.NewReader(raw))
	d.UseNumber()
	if d.Decode(target) != nil {
		return false
	}
	var trailing any
	return d.Decode(&trailing) == io.EOF
}

func str(v any) string { return text(first(v, "")) }

func integer(v any) (int, bool) {
	switch x := v.(type) {
	case int:
		return x, true
	case int64:
		return int(x), int64(int(x)) == x
	case uint64:
		return int(x), x <= uint64(math.MaxInt)
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) || x >= float64(math.MaxInt) || x < float64(math.MinInt) {
			return 0, false
		}
		return int(x), true
	case json.Number:
		if strings.ContainsAny(string(x), ".eE") {
			f, e := x.Float64()
			if e != nil {
				return 0, false
			}
			return integer(f)
		}
		i, e := strconv.Atoi(string(x))
		return i, e == nil
	case string:
		i, e := strconv.Atoi(strings.TrimSpace(x))
		return i, e == nil
	}
	return 0, false
}

func numberOrText(v any) any {
	s := strings.TrimSpace(str(v))
	n, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return s
	}
	if math.Trunc(n) == n {
		if i, ok := integer(n); ok {
			return i
		}
	}
	return n
}

func validHostPort(host string, port int) bool {
	return host != "" && strings.IndexFunc(host, unicode.IsSpace) < 0 && port >= 1 && port <= 65535
}

func quote(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~", rune(c)) {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		}
	}
	return b.String()
}

func unquote(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
				b.WriteByte(byte(v))
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return strings.ToValidUTF8(b.String(), "�")
}

func fragmentName(s string) string {
	if i := strings.LastIndexByte(s, '#'); i >= 0 {
		return strings.TrimSpace(unquote(s[i+1:]))
	}
	return ""
}

func proxyURL(scheme, host string, port int, username, password string) string {
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	auth := ""
	if username != "" || password != "" {
		auth = quote(username) + ":" + quote(password) + "@"
	}
	return scheme + "://" + auth + host + ":" + strconv.Itoa(port)
}

func decodeBase64(s string) string {
	s = strings.Join(strings.Fields(s), "")
	if s == "" {
		return ""
	}
	s += strings.Repeat("=", (4-len(s)%4)%4)
	s = strings.NewReplacer("-", "+", "_", "/").Replace(s)
	// Python ignores non-alphabet characters and accepts surplus padding.
	var encoded strings.Builder
	padding, terminated := 0, false
	for _, r := range s {
		if r == '=' {
			padding++
			if rem := encoded.Len() % 4; rem >= 2 && rem+padding >= 4 {
				terminated = true
				break
			}
		} else if r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '+' || r == '/' {
			encoded.WriteRune(r)
			padding = 0
		}
	}
	if encoded.Len()%4 != 0 && !terminated {
		return ""
	}
	b, err := base64.RawStdEncoding.DecodeString(encoded.String())
	if err != nil {
		return ""
	}
	if !utf8.Valid(b) {
		return ""
	}
	return strings.TrimPrefix(string(b), "\ufeff")
}

type query map[string][]string

func parseQuery(s string) query {
	q := query{}
	for _, part := range strings.Split(s, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		k = unquote(strings.ReplaceAll(k, "+", " "))
		v = unquote(strings.ReplaceAll(v, "+", " "))
		q[k] = append(q[k], v)
	}
	result := query{}
	// Preserve insertion order for differently cased keys, as parse_qs does.
	for _, part := range strings.Split(s, "&") {
		k, _, _ := strings.Cut(part, "=")
		k = unquote(strings.ReplaceAll(k, "+", " "))
		if vals, ok := q[k]; ok {
			result[strings.ToLower(k)] = vals
			delete(q, k)
		}
	}
	return result
}

func (q query) value(names ...string) string {
	for _, k := range names {
		if vs := q[strings.ToLower(k)]; len(vs) > 0 {
			return vs[0]
		}
	}
	return ""
}

func (q query) boolean(defaultValue bool, names ...string) bool {
	s := q.value(names...)
	if s == "" {
		return defaultValue
	}
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on", "enable", "enabled":
		return true
	}
	return false
}

func (q query) list(names ...string) []string {
	var out []string
	for _, s := range strings.Split(q.value(names...), ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

var digits = regexp.MustCompile(`[0-9]+`)
var portRangePattern = regexp.MustCompile(`^\s*([0-9]+)\s*[-:]\s*([0-9]+)\s*$`)

func listValues(v any) []any {
	if xs, ok := v.([]any); ok {
		return xs
	}
	return []any{v}
}

func firstPort(v any) int {
	for _, x := range listValues(v) {
		i, _ := strconv.Atoi(digits.FindString(str(x)))
		if i >= 1 && i <= 65535 {
			return i
		}
	}
	return 0
}

func mieruPortRange(v any) string {
	for _, x := range listValues(v) {
		m := portRangePattern.FindStringSubmatch(str(x))
		if m == nil {
			continue
		}
		a, _ := strconv.Atoi(m[1])
		b, _ := strconv.Atoi(m[2])
		if 1 <= a && a <= b && b <= 65535 {
			return fmt.Sprintf("%d-%d", a, b)
		}
	}
	return ""
}

func mieruTransport(v any) string {
	if m, ok := v.(map[string]any); ok {
		v = m["type"]
	}
	s := strings.ToUpper(strings.TrimSpace(text(first(v, "TCP"))))
	if s == "" {
		return "TCP"
	}
	return s
}

func mieruMultiplexing(v any) string {
	s := strings.ReplaceAll(strings.ToUpper(strings.TrimSpace(str(v))), "-", "_")
	switch s {
	case "NONE", "OFF", "DISABLED":
		return "MULTIPLEXING_OFF"
	case "LOW":
		return "MULTIPLEXING_LOW"
	case "MIDDLE", "MEDIUM":
		return "MULTIPLEXING_MIDDLE"
	case "HIGH":
		return "MULTIPLEXING_HIGH"
	}
	return s
}

func coreNode(scheme string, c map[string]any) *Node {
	host := strings.TrimSpace(str(c["server"]))
	canonical := strings.ToLower(strings.TrimSpace(text(first(c["type"], scheme))))
	portRange := ""
	if canonical == "mieru" {
		portRange = mieruPortRange(first(c["port-range"], c["port_range"]))
	}
	port, ok := integer(first(c["port"], firstPort(portRange)))
	if !ok || !validHostPort(host, port) {
		return nil
	}
	name := strings.TrimSpace(text(first(c["name"], scheme+"-"+host)))
	c["name"], c["type"], c["server"] = name, canonical, host
	if portRange != "" {
		c["port-range"] = portRange
		delete(c, "port_range")
		delete(c, "port")
	} else {
		c["port"] = port
	}
	return &Node{Raw: fmt.Sprintf("%s://%s:%d#%s", scheme, host, port, quote(name)), Scheme: scheme, Host: host, Port: port, Name: name, Note: tunnelNote, CoreConfig: c}
}

type uri struct {
	host, user, password, userinfo, rawQuery string
	port                                     int
}

// splitURI follows urlsplit's authority semantics. In particular, percent
// escapes are decoded only in userinfo, never in the host or the whole URI.
func splitURI(s string) (uri, bool) {
	s = strings.TrimLeftFunc(s, func(r rune) bool { return r <= 0x20 })
	s = strings.NewReplacer("\r", "", "\n", "", "\t", "").Replace(s)
	if !strings.HasPrefix(s, "//") {
		_, rest, found := strings.Cut(s, ":")
		if !found {
			return uri{}, false
		}
		s = rest
	}
	if !strings.HasPrefix(s, "//") {
		return uri{}, true
	}
	s = s[2:]
	authority, rest := s, ""
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		authority, rest = s[:i], s[i:]
	}
	beforeFragment, _, _ := strings.Cut(rest, "#")
	_, rawQuery, _ := strings.Cut(beforeFragment, "?")
	x := uri{rawQuery: rawQuery}
	if i := strings.LastIndexByte(authority, '@'); i >= 0 {
		info := authority[:i]
		authority = authority[i+1:]
		user, password, _ := strings.Cut(info, ":")
		x.user, x.password, x.userinfo = unquote(user), unquote(password), unquote(info)
	}
	host, port := authority, ""
	if strings.ContainsAny(authority, "[]") {
		if !strings.HasPrefix(authority, "[") {
			return uri{}, false
		}
		close := strings.IndexByte(authority, ']')
		if close < 0 {
			return uri{}, false
		}
		host = authority[1:close]
		suffix := authority[close+1:]
		if suffix != "" {
			if !strings.HasPrefix(suffix, ":") {
				return uri{}, false
			}
			port = suffix[1:]
		}
		ip, _, _ := strings.Cut(host, "%")
		if !ipvFuture.MatchString(host) && (net.ParseIP(ip) == nil || !strings.Contains(ip, ":")) {
			return uri{}, false
		}
	} else {
		host, port, _ = strings.Cut(authority, ":")
	}
	// Python preserves the case of IPv6 zone identifiers.
	base, zone, hasZone := strings.Cut(host, "%")
	x.host = strings.ToLower(base)
	if hasZone {
		x.host += "%" + zone
	}
	if port != "" {
		if !decimal(port) {
			return uri{}, false
		}
		n, err := strconv.Atoi(port)
		if err != nil || n > 65535 {
			return uri{}, false
		}
		x.port = n
	}
	return x, true
}

var ipvFuture = regexp.MustCompile(`^v[0-9a-fA-F]+\..+$`)
