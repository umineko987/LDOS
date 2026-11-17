// Package redaction removes credentials before process output reaches logs or APIs.
package redaction

import (
	"regexp"
	"strings"
)

var (
	urlUserinfo    = regexp.MustCompile(`(?i)(\b(?:https?|socks4|socks5h?|ss|ssr|vmess|vless|trojan|hysteria|hysteria2|hy2|tuic|anytls|mieru)://)[^\s/@]+(?::[^\s/@]*)?@`)
	querySecret    = regexp.MustCompile(`(?i)([?&;/](?:token|access_token|api[_-]?key|auth|password|passwd|secret|session|cookie|signature|sig|code|email|username|keystamp|fileindex)=)[^&#\s]+`)
	keyValueSecret = regexp.MustCompile(`(?i)(\b(?:authorization|proxy-authorization|cookie|set-cookie|token|api[_-]?key|password|passwd|secret)\b\s*[:=]\s*)[^\s,;]+`)
	bearerSecret   = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+`)
)

// Text masks explicit secrets before generic credentials. A nonpositive limit
// leaves the output untruncated; positive limits count Unicode code points.
func Text(text string, limit int, secrets ...string) string {
	for _, secret := range secrets {
		if secret != "" {
			text = strings.ReplaceAll(text, secret, "***")
		}
	}
	text = urlUserinfo.ReplaceAllString(text, "${1}***:***@")
	text = querySecret.ReplaceAllString(text, "${1}***")
	// Scheme masking must precede header masking to avoid leaving bearer tokens.
	text = bearerSecret.ReplaceAllString(text, "${1} ***")
	text = keyValueSecret.ReplaceAllString(text, "${1}***")
	if limit > 0 {
		runes := []rune(text)
		if len(runes) > limit {
			text = string(runes[:limit-1]) + "…"
		}
	}
	return text
}
