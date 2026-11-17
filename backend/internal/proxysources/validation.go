package proxysources

import (
	"net"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/idna"
	"golang.org/x/text/unicode/norm"

	"ldos/backend/internal/proxyparse"
)

// Transitional mapping keeps legacy nameprep behavior such as ß → ss.
// Python accepts non-DNS ASCII labels; preserve those instead of applying
// registration validation or an overall DNS-name length limit.
var hostIDNA = idna.New(idna.MapForLookup(), idna.Transitional(true), idna.StrictDomainName(false), idna.ValidateLabels(false))

// splitSubscription keeps path/query/fragment and userinfo verbatim, as Python's
// urlsplit/urlunsplit do. net/url would reject percent escapes that urlsplit
// intentionally leaves opaque in subscription credentials and paths.
type subscriptionURL struct {
	scheme, userinfo, host, path, query, fragment string
	port                                          *int
	hasCredentials                                bool
}

func splitSubscription(value string) (subscriptionURL, error) {
	var parsed subscriptionURL
	colon := strings.IndexByte(value, ':')
	if colon < 1 {
		return parsed, invalid("subscription", "malformed", nil)
	}
	for i, r := range value[:colon] {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || i > 0 && (r >= '0' && r <= '9' || r == '+' || r == '-' || r == '.')) {
			return parsed, invalid("subscription", "malformed", nil)
		}
	}
	parsed.scheme = strings.ToLower(value[:colon])
	rest := value[colon+1:]
	if !strings.HasPrefix(rest, "//") {
		return parsed, invalid("subscription", "malformed", nil)
	}
	rest = rest[2:]
	end := strings.IndexAny(rest, "/?#")
	if end < 0 {
		end = len(rest)
	}
	authority := rest[:end]
	// urlsplit rejects compatibility characters that introduce URL delimiters.
	checked := strings.NewReplacer("@", "", ":", "", "#", "", "?", "").Replace(authority)
	if normalized := norm.NFKC.String(checked); normalized != checked && strings.ContainsAny(normalized, "/?#@:") {
		return parsed, invalid("subscription", "malformed", nil)
	}
	rest = rest[end:]
	if i := strings.LastIndexByte(authority, '@'); i >= 0 {
		parsed.hasCredentials = true
		parsed.userinfo = authority[:i+1]
		authority = authority[i+1:]
	}
	var host, port string
	if strings.HasPrefix(authority, "[") {
		end := strings.IndexByte(authority, ']')
		if end < 0 {
			return parsed, invalid("subscription", "malformed", nil)
		}
		host = authority[1:end]
		address, _, _ := strings.Cut(host, "%")
		if net.ParseIP(address) == nil || !strings.Contains(address, ":") {
			return parsed, invalid("subscription", "malformed", nil)
		}
		if len(authority) > end+1 {
			if authority[end+1] != ':' {
				return parsed, invalid("subscription", "malformed", nil)
			}
			port = authority[end+2:]
		}
	} else {
		if strings.ContainsAny(authority, "[]") {
			return parsed, invalid("subscription", "malformed", nil)
		}
		host, port, _ = strings.Cut(authority, ":")
	}
	canonical, err := canonicalHost(host)
	if err != nil {
		return parsed, err
	}
	parsed.host = canonical
	if port != "" {
		for _, r := range port {
			if r < '0' || r > '9' {
				return parsed, invalid("subscription", "malformed", nil)
			}
		}
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return parsed, invalid("subscription", "malformed", nil)
		}
		parsed.port = &n
	}
	rest, parsed.fragment, _ = strings.Cut(rest, "#")
	parsed.path, parsed.query, _ = strings.Cut(rest, "?")
	return parsed, nil
}

func canonicalHost(value string) (string, error) {
	host := strings.TrimRight(trim(value), ".")
	if host == "" || strings.ContainsAny(host, "/\\?#@") {
		return "", invalid("subscription", "malformed", nil)
	}
	ascii := true
	for _, r := range host {
		if isSpace(r) {
			return "", invalid("subscription", "malformed", nil)
		}
		if r > 127 {
			ascii = false
		}
	}
	if strings.Contains(host, ":") {
		return strings.ToLower(host), nil
	}
	if !ascii {
		var err error
		host, err = hostIDNA.ToASCII(host)
		if err != nil {
			return "", invalid("subscription", "malformed", nil)
		}
	}
	for _, label := range strings.Split(strings.TrimSuffix(host, "."), ".") {
		if len(label) == 0 || len(label) > 63 {
			return "", invalid("subscription", "malformed", nil)
		}
	}
	return strings.ToLower(host), nil
}

func (u subscriptionURL) authority() string {
	host := u.host
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if u.port != nil {
		host += ":" + strconv.Itoa(*u.port)
	}
	return host
}

func normalizeSubscription(value string) (string, error) {
	value = trim(value)
	if value == "" {
		return "", invalid("subscription", "empty", nil)
	}
	if utf8.RuneCountInString(value) > MaxSubscriptionURLLength {
		return "", invalid("subscription", "too_long", nil)
	}
	if hasControl(value) {
		return "", invalid("subscription", "control_character", nil)
	}
	if !utf8.ValidString(value) {
		return "", invalid("subscription", "malformed", nil)
	}
	u, err := splitSubscription(value)
	if err != nil {
		return "", err
	}
	if u.scheme != "http" && u.scheme != "https" {
		return "", invalid("subscription", "unsupported_scheme", nil)
	}
	result := u.scheme + "://" + u.userinfo + u.authority() + u.path
	if u.query != "" {
		result += "?" + u.query
	}
	if u.fragment != "" {
		result += "#" + u.fragment
	}
	return result, nil
}

func normalizeSubscriptions(values []string) ([]string, error) {
	if len(values) > MaxSubscriptions {
		return nil, invalid("subscription", "too_many", nil)
	}
	result := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		normalized, err := normalizeSubscription(value)
		if err != nil {
			return nil, err
		}
		if !seen[normalized] {
			result = append(result, normalized)
			seen[normalized] = true
		}
	}
	return result, nil
}

func parseOneInlineNode(value string, index *int) (string, *proxyparse.Node, error) {
	text := trim(value)
	if text == "" {
		return "", nil, invalid("inline_node", "empty", index)
	}
	if utf8.RuneCountInString(text) > MaxInlineNodeLength {
		return "", nil, invalid("inline_node", "too_long", index)
	}
	if hasControl(text) {
		return "", nil, invalid("inline_node", "control_character", index)
	}
	if !utf8.ValidString(text) {
		return "", nil, invalid("inline_node", "unsupported_or_empty", index)
	}
	node := proxyparse.ParseLine(text)
	if node == nil {
		parsed := proxyparse.ParseSubscription(text)
		if len(parsed) == 1 {
			node = &parsed[0]
		}
	}
	if node == nil || !(node.Usable || len(node.CoreConfig) != 0) {
		return "", nil, invalid("inline_node", "unsupported_or_empty", index)
	}
	return text, node, nil
}

func normalizeInlineNodes(values []string) ([]string, error) {
	if len(values) > MaxInlineNodes {
		return nil, invalid("inline_node", "too_many", nil)
	}
	total := 0
	for _, value := range values {
		total += utf8.RuneCountInString(value)
	}
	if total > MaxInlineNodeTotalChars {
		return nil, invalid("inline_node", "total_too_large", nil)
	}
	result := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for i, value := range values {
		normalized, _, err := parseOneInlineNode(value, &i)
		if err != nil {
			return nil, err
		}
		if !seen[normalized] {
			result = append(result, normalized)
			seen[normalized] = true
		}
	}
	return result, nil
}
