//go:build linux

// Package authbrowser owns the shared Linux authorization browser and its CDP connection.
package authbrowser

import (
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Errors are deliberately controlled: CDP errors can contain credentials and visited URLs.
var (
	ErrNotFound = errors.New("supported browser executable was not found")
	ErrStart    = errors.New("authorization browser could not start")
	ErrStopped  = errors.New("authorization browser is not running")
	ErrCDP      = errors.New("authorization browser request failed")
	ErrEndpoint = errors.New("authorization browser endpoint is invalid")
	ErrProfile  = errors.New("authorization browser profile is unavailable or unsafe")
	ErrProxy    = errors.New("authorization browser proxy is invalid")
	ErrSite     = errors.New("unsupported browser authorization site")
	ErrLoginURL = errors.New("Pixiv authorization URL is invalid")
	ErrStop     = errors.New("authorization browser could not stop")
)

type Cookie struct {
	Domain  string  `json:"domain"`
	Path    string  `json:"path"`
	Name    string  `json:"name"`
	Value   string  `json:"value"`
	Expires float64 `json:"expires"`
	Secure  bool    `json:"secure"`
}

type Spec struct {
	Site, Label, LoginURL          string
	Domains, Required, Recommended []string
}

// Sites contains cookie-based authorization sites; Pixiv uses CapturePixiv instead.
var Sites = map[string]Spec{
	"twitter":  {Site: "twitter", Label: "X / Twitter", LoginURL: "https://x.com/i/flow/login", Domains: []string{"x.com", "twitter.com"}, Required: []string{"auth_token", "ct0"}, Recommended: []string{}},
	"exhentai": {Site: "exhentai", Label: "EH", LoginURL: "https://forums.e-hentai.org/index.php?act=Login&CODE=00", Domains: []string{"e-hentai.org", "exhentai.org"}, Required: []string{"ipb_member_id", "ipb_pass_hash"}, Recommended: []string{"igneous"}},
}

func domainMatches(domain string, roots []string) bool {
	domain = strings.ToLower(strings.TrimPrefix(domain, "."))
	for _, root := range roots {
		if domain == root || strings.HasSuffix(domain, "."+root) {
			return true
		}
	}
	return false
}

func safeCookie(c Cookie) bool {
	if c.Domain == "" || c.Name == "" || strings.HasPrefix(c.Domain, "#") || math.IsNaN(c.Expires) || math.IsInf(c.Expires, 0) || c.Expires >= float64(math.MaxInt64) {
		return false
	}
	for _, field := range []string{c.Domain, c.Path, c.Name, c.Value} {
		for _, r := range field {
			if r < 0x20 || r == 0x7f {
				return false
			}
		}
	}
	return true
}

func filterCookies(cookies []Cookie, roots []string, now time.Time) []Cookie {
	selected := make(map[[3]string]Cookie)
	for _, c := range cookies {
		if c.Path == "" {
			c.Path = "/"
		}
		if !safeCookie(c) || !domainMatches(c.Domain, roots) || (c.Expires > 0 && c.Expires <= float64(now.UnixNano())/1e9) {
			continue
		}
		selected[[3]string{c.Domain, c.Path, c.Name}] = c
	}
	result := make([]Cookie, 0, len(selected))
	for _, c := range selected {
		result = append(result, c)
	}
	sortCookies(result)
	return result
}

func sortCookies(cookies []Cookie) {
	sort.Slice(cookies, func(i, j int) bool {
		a, b := cookies[i], cookies[j]
		if a.Domain != b.Domain {
			return a.Domain < b.Domain
		}
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		if a.Value != b.Value {
			return a.Value < b.Value
		}
		if a.Expires != b.Expires {
			return a.Expires < b.Expires
		}
		return !a.Secure && b.Secure
	})
}

// Netscape returns a stable export without mutating its input or permitting line injection.
func Netscape(cookies []Cookie) []byte {
	selected := make([]Cookie, 0, len(cookies))
	for _, c := range cookies {
		if c.Path == "" {
			c.Path = "/"
		}
		if safeCookie(c) {
			selected = append(selected, c)
		}
	}
	sortCookies(selected)
	var out strings.Builder
	out.WriteString("# Netscape HTTP Cookie File\n\n")
	for _, c := range selected {
		subdomains, secure := "FALSE", "FALSE"
		if strings.HasPrefix(c.Domain, ".") {
			subdomains = "TRUE"
		}
		if c.Secure {
			secure = "TRUE"
		}
		expires := int64(0)
		if c.Expires > 0 {
			expires = int64(c.Expires)
		}
		out.WriteString(strings.Join([]string{c.Domain, subdomains, c.Path, secure, strconv.FormatInt(expires, 10), c.Name, c.Value}, "\t"))
		out.WriteByte('\n')
	}
	return []byte(out.String())
}
