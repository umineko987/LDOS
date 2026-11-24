package crawls

import (
	"html"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	xhtml "golang.org/x/net/html"
)

var ehPageRE = regexp.MustCompile(`(?i)^https?://(?:e-|ex)hentai\.org/s/[0-9a-f]{10}/([0-9]+)-([0-9]+)(?:[?#]|$)`)
var ehLengthRE = regexp.MustCompile(`(?i)>\s*Length:\s*</td>\s*<td[^>]*>\s*([0-9][0-9,]*)\s+(?:pages?|files?)`)
var ehTitleRE = regexp.MustCompile(`(?is)<h1\b[^>]*\bid\s*=\s*["']gn["'][^>]*>(.*?)</h1>`)
var ehTagRE = regexp.MustCompile(`<[^>]+>`)
var ehCSSURL = regexp.MustCompile(`(?i)url\(\s*([^)]+?)\s*\)`)

type ehPage struct {
	url, thumbnail string
	sprite         map[string]int
}

func parseEH(body string, base *url.URL, galleryID string) (string, int, map[int]ehPage) {
	title := ""
	if m := ehTitleRE.FindStringSubmatch(body); m != nil {
		title = strings.TrimSpace(html.UnescapeString(ehTagRE.ReplaceAllString(m[1], "")))
	}
	total := 0
	if m := ehLengthRE.FindStringSubmatch(body); m != nil {
		total, _ = strconv.Atoi(strings.ReplaceAll(m[1], ",", ""))
	}
	pages := map[int]ehPage{}
	tokens := xhtml.NewTokenizer(strings.NewReader(body))
	page := 0
	for {
		kind := tokens.Next()
		switch kind {
		case xhtml.ErrorToken:
			return title, total, pages
		case xhtml.EndTagToken:
			if name, _ := tokens.TagName(); string(name) == "a" {
				page = 0
			}
		case xhtml.StartTagToken, xhtml.SelfClosingTagToken:
			token := tokens.Token()
			if token.Data == "a" {
				page = 0
				target := ehLink(base, ehAttr(token, "href"))
				match := ehPageRE.FindStringSubmatch(target)
				if match == nil || strings.TrimLeft(match[1], "0") != strings.TrimLeft(galleryID, "0") {
					continue
				}
				n, err := strconv.Atoi(match[2])
				if err != nil || n <= 0 {
					continue
				}
				page = n
				entry := pages[n]
				entry.url = target
				pages[n] = entry
			}
			if page > 0 && pages[page].thumbnail == "" {
				entry := pages[page]
				if token.Data == "img" {
					for _, attr := range []string{"data-src", "data-original", "src"} {
						if entry.thumbnail = ehLink(base, ehAttr(token, attr)); entry.thumbnail != "" {
							break
						}
					}
				}
				if entry.thumbnail == "" {
					entry.thumbnail, entry.sprite = ehBackground(base, ehAttr(token, "style"))
				}
				pages[page] = entry
			}
		}
	}
}

func ehAttr(token xhtml.Token, name string) string {
	for _, attr := range token.Attr {
		if attr.Key == name {
			return attr.Val
		}
	}
	return ""
}

func ehLink(base *url.URL, raw string) string {
	if raw == "" {
		return ""
	}
	u, err := base.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil {
		return ""
	}
	return u.String()
}

func ehPixels(raw string) (int, bool) {
	value, px := strings.CutSuffix(raw, "px")
	n, err := strconv.Atoi(value)
	return n, err == nil && (px || n == 0)
}

func ehBackground(base *url.URL, style string) (string, map[string]int) {
	var width, height int
	var thumbnail, position, shorthand string
	for _, decl := range strings.Split(style, ";") {
		name, val, ok := strings.Cut(decl, ":")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "width":
			width, _ = ehPixels(val)
		case "height":
			height, _ = ehPixels(val)
		case "background-position":
			position = val
		case "background", "background-image":
			if at := ehCSSURL.FindStringSubmatchIndex(val); at != nil {
				thumbnail = ehLink(base, strings.Trim(val[at[2]:at[3]], `"'`))
				shorthand = val[at[1]:]
			}
		}
	}
	if thumbnail == "" || width <= 0 || height <= 0 {
		return thumbnail, nil
	}
	if position == "" {
		position = shorthand
	}
	x, y := 0, 0
	if fields := strings.Fields(position); len(fields) >= 2 {
		x, _ = ehPixels(fields[0])
		y, _ = ehPixels(fields[1])
	}
	return thumbnail, map[string]int{"width": width, "height": height, "x": x, "y": y}
}
