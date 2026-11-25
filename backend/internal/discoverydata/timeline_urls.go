package discoverydata

import (
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	pixivTimelinePath = regexp.MustCompile(`^/(?:en/)?users/([1-9][0-9]{0,19})(?:/artworks)?/?$`)
	pixivWorkPath     = regexp.MustCompile(`^/(?:en/)?(?:artworks|i)/([1-9][0-9]{0,19})/?$`)
	twitterHandle     = regexp.MustCompile(`^[a-zA-Z0-9_]{1,15}$`)
	twitterMediaPath  = regexp.MustCompile(`^/([a-zA-Z0-9_]{1,15})(?:/media)?/?$`)
	twitterStatusPath = regexp.MustCompile(`^/([a-zA-Z0-9_]{1,15}|i/web)/status/([1-9][0-9]{0,19})(?:/(?:photo|video)/[1-9][0-9]*)?/?$`)
	timelineWorkID    = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
	twitterQueryToken = regexp.MustCompile(`(?:[^\s\p{Zs}"]|"(?:\\.|[^"\\])*")+|"`)
)

func httpsAddress(raw string) *url.URL {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.User != nil || u.Opaque != "" || u.Host == "" || u.Port() != "" || u.RawPath != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil
	}
	return u
}

func timelineHost(site string, u *url.URL) bool {
	host := strings.ToLower(u.Host)
	switch site {
	case "pixiv":
		return host == "pixiv.net" || host == "www.pixiv.net"
	case "twitter":
		return contains([]string{"x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.x.com", "mobile.twitter.com"}, host)
	}
	return false
}

func timelineHandle(name string) bool {
	return twitterHandle.MatchString(name) && !reserved(name) && !contains([]string{"settings", "login", "logout", "signup", "account", "compose", "messages", "notifications", "bookmarks", "communities", "tos", "privacy", "about", "help", "download", "oauth", "jobs", "premium"}, strings.ToLower(name))
}

// CanonicalTimelineAddress admits Pixiv and X creator feeds and keyword searches.
func CanonicalTimelineAddress(site, raw string) (string, error) {
	spec, err := SearchSite(site)
	if err == nil {
		if u := httpsAddress(raw); u != nil && timelineHost(spec.Site, u) {
			switch spec.Site {
			case "pixiv":
				if m := pixivTimelinePath.FindStringSubmatch(u.Path); m != nil {
					return "https://www.pixiv.net/users/" + m[1] + "/artworks", nil
				}
				if u.Path == "/search.php" {
					if keyword := timelineKeyword(u, "word"); keyword != "" {
						query := url.Values{"word": {keyword}, "s_mode": {"s_tag"}, "order": {"date_d"}}
						return "https://www.pixiv.net/search.php?" + query.Encode(), nil
					}
				}
			case "twitter":
				if m := twitterMediaPath.FindStringSubmatch(u.Path); m != nil && timelineHandle(m[1]) {
					return "https://x.com/" + strings.ToLower(m[1]) + "/media", nil
				}
				if u.Path == "/search" {
					if keyword := timelineKeyword(u, "q"); keyword != "" {
						return "https://x.com/search?q=" + url.QueryEscape(keyword+" "+twitterMediaOperator), nil
					}
				}
			}
		}
	}
	return "", &Error{Code: "invalid_timeline_url", Message: "请输入该站点的 Pixiv 作者作品页、X 媒体时间线或关键词搜索地址"}
}

const (
	maxTimelineKeywordRunes = 500
	twitterMediaOperator    = "filter:media"
)

func timelineKeyword(u *url.URL, key string) string {
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(query[key]) != 1 {
		return ""
	}
	keyword := query.Get(key)
	if !utf8.ValidString(keyword) || strings.ContainsFunc(keyword, unicode.IsControl) {
		return ""
	}
	keyword = strings.TrimSpace(keyword)
	if key == "q" {
		// Re-append one operator outside quoted phrases, including when reusing a canonical URL.
		keyword = strings.TrimSpace(twitterQueryToken.ReplaceAllStringFunc(keyword, func(token string) string {
			if strings.EqualFold(token, twitterMediaOperator) {
				return ""
			}
			return token
		}))
	}
	if utf8.RuneCountInString(keyword) > maxTimelineKeywordRunes {
		return ""
	}
	return keyword
}

// CanonicalWorkAddress admits only individual artworks and statuses. Use this
// for selected works before queueing them as crawl addresses.
func CanonicalWorkAddress(site, raw string) (string, error) {
	canonical, _, err := exactWorkAddress(site, raw)
	return canonical, err
}

func exactWorkAddress(site, raw string) (canonical, id string, err error) {
	spec, err := SearchSite(site)
	if err == nil {
		if u := httpsAddress(raw); u != nil && timelineHost(spec.Site, u) {
			if spec.Site == "pixiv" {
				if m := pixivWorkPath.FindStringSubmatch(u.Path); m != nil {
					return "https://www.pixiv.net/artworks/" + m[1], m[1], nil
				}
			} else if m := twitterStatusPath.FindStringSubmatch(u.Path); m != nil {
				name := strings.ToLower(m[1])
				if name == "i" || name == "i/web" {
					name = "i/web"
				} else if !timelineHandle(name) {
					name = ""
				}
				if name != "" {
					return "https://x.com/" + name + "/status/" + m[2], m[2], nil
				}
			}
		}
	}
	return "", "", &Error{Code: "invalid_work_url", Message: "请选择具体的 Pixiv 作品或 X 帖子地址"}
}

const TwitterOriginalPostFilter = "not (retweet_id or quote_id)"

// ExactWorkPostFilter restricts gallery-dl discovery and download jobs to the
// selected work, even when the gallery-dl config enables related posts.
func ExactWorkPostFilter(site, raw string) (string, error) {
	canonical, id, err := exactWorkAddress(site, raw)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(canonical, "https://x.com/") {
		return "tweet_id == " + id + " and " + TwitterOriginalPostFilter, nil
	}
	return "id == " + id, nil
}
