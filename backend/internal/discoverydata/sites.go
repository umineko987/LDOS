// Package discoverydata implements pure discovery parsing and address projection.
// It performs no I/O and does not invoke gallery-dl or Python.
package discoverydata

import (
	"fmt"
	"net/url"
	"strings"
)

type Error struct {
	Code, Message string
	Details       any
}

func (e *Error) Error() string { return e.Message }

type SiteSpec struct {
	Site                                       string
	Aliases                                    []string
	CandidateKind, SearchRange, Authentication string
}

var siteSpecs = []SiteSpec{
	{"twitter", []string{"twitter", "x"}, "work", "post", "auth_token Cookie"},
	{"pixiv", []string{"pixiv"}, "work", "post", "refresh token 或 PHPSESSID Cookie"},
	{"danbooru", []string{"danbooru"}, "post", "post", "公开搜索可直接使用；账号/API key 可选"},
	{"exhentai", []string{"exhentai", "eh", "e-hentai", "e_hentai"}, "gallery", "child", "E-Hentai 公开搜索可直接使用；ExHentai 使用 Cookie"},
	{"pawchive", []string{"pawchive"}, "account", "child", "公开 API 与文件下载无需登录"},
}

func SearchSite(site string) (SiteSpec, error) {
	key := strings.ToLower(strings.TrimSpace(site))
	for _, s := range siteSpecs {
		for _, a := range s.Aliases {
			if a == key {
				s.Aliases = append([]string{}, s.Aliases...)
				return s, nil
			}
		}
	}
	return SiteSpec{}, fmt.Errorf("site 当前支持 x/twitter、pixiv、danbooru、eh/exhentai、pawchive")
}
func (s SiteSpec) SearchURL(keyword string) (string, error) {
	switch s.Site {
	case "twitter":
		return "https://x.com/search?q=" + url.QueryEscape(keyword) + "&f=live", nil
	case "danbooru":
		return "https://danbooru.donmai.us/posts?tags=" + url.QueryEscape(keyword), nil
	case "exhentai":
		return "https://e-hentai.org/?f_search=" + url.QueryEscape(keyword), nil
	case "pawchive":
		return "https://pawchive.pw/artists?q=" + url.QueryEscape(keyword), nil
	}
	return "", fmt.Errorf("未注册关键词搜索站点: %s", s.Site)
}
func SearchSiteCatalog() []map[string]any {
	result := []map[string]any{}
	for _, s := range siteSpecs {
		item := map[string]any{"site": s.Site, "aliases": append([]string{}, s.Aliases...), "candidate_kind": s.CandidateKind, "authentication": s.Authentication}
		if s.Site == "exhentai" {
			ns := []map[string]any{}
			for _, n := range namespaces {
				ns = append(ns, map[string]any{"namespace": n.name, "label": n.label, "aliases": append([]string{}, n.aliases...)})
			}
			item["tag_namespaces"] = ns
		}
		result = append(result, item)
	}
	return result
}
func ValidateArgs(args []string) ([]string, error) {
	for _, v := range args {
		option, _, _ := strings.Cut(v, "=")
		switch option {
		case "-g", "-G", "-j", "-J", "--get-urls", "--resolve-urls", "--dump-json", "--resolve-json", "--range", "--file-range", "--image-range", "--post-range", "--child-range", "--chapter-range":
			return nil, fmt.Errorf("搜索输出协议参数由后端管理: %s", option)
		}
	}
	return append([]string{}, args...), nil
}
func PixivFirstMediaArgs(args []string) ([]string, error) {
	values := append([]string{}, args...)
	for i := len(values) - 1; i >= 0; i-- {
		if values[i] == "--filter" {
			if i+1 >= len(values) {
				return nil, fmt.Errorf("--filter 缺少表达式")
			}
			values[i+1] = "(" + values[i+1] + ") and (num == 0)"
			return values, nil
		}
		if strings.HasPrefix(values[i], "--filter=") {
			values[i] = "--filter=(" + strings.TrimPrefix(values[i], "--filter=") + ") and (num == 0)"
			return values, nil
		}
	}
	return append(values, "--filter", "num == 0"), nil
}
