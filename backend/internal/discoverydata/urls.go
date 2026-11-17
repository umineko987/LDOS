package discoverydata

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

var (
	slashPattern        = regexp.MustCompile(`/{2,}`)
	pixivUserPattern    = regexp.MustCompile(`^/users/(\d+)(?:/artworks)?$`)
	pixivProfilePattern = regexp.MustCompile(`^/users/(\d+)`)
	digitsPattern       = regexp.MustCompile(`^\d+$`)
	galleryPathPattern  = regexp.MustCompile(`(?i)^/g/\d+/[0-9a-f]{10}$`)
	pawchivePathPattern = regexp.MustCompile(`^/[^/]+/user/[^/]+(?:/post/[^/]+)?$`)
	schemePattern       = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)
)

// splitAddress retains escaped paths verbatim, like urllib.parse.urlsplit.
// net/url's decoded Path would change the existing canonical IDs.
func splitAddress(raw string) (host, path, query string, err error) {
	raw = strings.TrimLeftFunc(raw, func(r rune) bool { return r <= 32 })
	raw = strings.NewReplacer("\n", "", "\r", "", "\t", "").Replace(raw)
	if scheme := schemePattern.FindString(raw); scheme != "" {
		raw = raw[len(scheme):]
	}
	if strings.HasPrefix(raw, "//") {
		raw = raw[2:]
		end := strings.IndexAny(raw, "/?#")
		if end < 0 {
			end = len(raw)
		}
		authority := raw[:end]
		raw = raw[end:]
		if at := strings.LastIndex(authority, "@"); at >= 0 {
			authority = authority[at+1:]
		}
		if strings.ContainsAny(authority, "[]") {
			if !strings.HasPrefix(authority, "[") {
				return "", "", "", fmt.Errorf("Invalid IPv6 URL")
			}
			end := strings.IndexByte(authority, ']')
			if end < 0 {
				return "", "", "", fmt.Errorf("Invalid IPv6 URL")
			}
			host = authority[1:end]
		} else {
			host, _, _ = strings.Cut(authority, ":")
		}
		host = lower(host)
	}
	raw, _, _ = strings.Cut(raw, "#")
	path, query, _ = strings.Cut(raw, "?")
	return
}
func queryFirst(query, key string) string {
	// urllib.parse accepts semicolons inside values and retains malformed
	// percent escapes; net/url.ParseQuery rejects both cases.
	for _, field := range strings.Split(query, "&") {
		name, value, _ := strings.Cut(field, "=")
		if queryDecode(name) == key && value != "" {
			return queryDecode(value)
		}
	}
	return ""
}
func queryDecode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '+' {
			b.WriteByte(' ')
			continue
		}
		if s[i] == '%' && i+2 < len(s) {
			if decoded, err := url.QueryUnescape(s[i : i+3]); err == nil {
				b.WriteString(decoded)
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	// Iterating runes matches Python's UTF-8 replacement decoding.
	return string([]rune(b.String()))
}
func segments(path string) []string {
	r := []string{}
	for _, s := range strings.Split(path, "/") {
		if s != "" {
			r = append(r, s)
		}
	}
	return r
}
func reserved(s string) bool {
	return contains([]string{"i", "home", "search", "intent", "share", "hashtag", "explore"}, lower(s))
}
func CanonicalAddress(site, raw string) (string, error) {
	spec, err := SearchSite(site)
	if err != nil {
		return "", err
	}
	text := strings.TrimSpace(raw)
	host, path, query, err := splitAddress(text)
	if err != nil {
		return "", err
	}
	if host == "" {
		return text, nil
	}
	path = strings.TrimRight(slashPattern.ReplaceAllString(path, "/"), "/")
	switch {
	case spec.Site == "twitter" && contains([]string{"x.com", "www.x.com", "twitter.com", "www.twitter.com"}, host):
		host = "x.com"
		s := segments(path)
		if len(s) == 1 && !reserved(s[0]) || len(s) == 2 && !reserved(s[0]) && lower(s[1]) == "media" {
			path = "/" + lower(s[0]) + "/media"
		}
		query = ""
	case spec.Site == "pixiv" && (host == "pixiv.net" || host == "www.pixiv.net"):
		host = "www.pixiv.net"
		if m := pixivUserPattern.FindStringSubmatch(path); m != nil {
			path = "/users/" + m[1] + "/artworks"
		}
		query = ""
	case spec.Site == "danbooru" && (host == "danbooru.donmai.us" || host == "www.danbooru.donmai.us"):
		host = "danbooru.donmai.us"
		if tags := queryFirst(query, "tags"); path == "/posts" && tags != "" {
			query = "tags=" + url.QueryEscape(tags)
		}
	case spec.Site == "exhentai" && galleryPathPattern.MatchString(path):
		path += "/"
	case spec.Site == "pawchive" && contains([]string{"pawchive.pw", "www.pawchive.pw", "pawchive.st", "www.pawchive.st"}, host):
		host = "pawchive.pw"
		if pawchivePathPattern.MatchString(path) {
			query = ""
		}
	}
	if path == "" {
		path = "/"
	}
	result := "https://" + host + path
	if query != "" {
		result += "?" + query
	}
	return result, nil
}
func ClassifyExternalProfile(raw string) map[string]any {
	text := strings.TrimSpace(raw)
	host, path, query, _ := splitAddress(text)
	host = strings.TrimPrefix(host, "www.")
	path = strings.TrimRight(path, "/")
	s := segments(path)
	platform := stringOr(first(host, "external"))
	var site, crawl any
	switch {
	case host == "x.com" || host == "twitter.com":
		platform = "twitter"
		if len(s) == 1 && !reserved(s[0]) {
			site = "twitter"
			crawl = "https://x.com/" + lower(s[0]) + "/media"
		}
	case host == "pixiv.net" || host == "www.pixiv.net":
		platform = "pixiv"
		id := ""
		if m := pixivProfilePattern.FindStringSubmatch(path); m != nil {
			id = m[1]
		} else if strings.HasSuffix(path, "/member.php") {
			q := queryFirst(query, "id")
			if digitsPattern.MatchString(q) {
				id = q
			}
		}
		if id != "" {
			site = "pixiv"
			crawl = "https://www.pixiv.net/users/" + id + "/artworks"
		}
	case strings.HasSuffix(host, "fanbox.cc") || strings.Contains(text, "pixiv.net/fanbox"):
		platform = "fanbox"
	case host == "skeb.jp":
		platform = "skeb"
	}
	return object{"url": text, "platform": platform, "crawl_site": site, "crawl_url": crawl}
}
