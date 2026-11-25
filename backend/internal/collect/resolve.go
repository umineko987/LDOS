package collect

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/search"
)

var (
	danPoolPathRe     = regexp.MustCompile(`^/pools/([1-9][0-9]{0,19})/?$`)
	danFavGroupPathRe = regexp.MustCompile(`^/favorite_groups/([1-9][0-9]{0,19})/?$`)
	danPostPathRe     = regexp.MustCompile(`^/posts/([1-9][0-9]{0,19})/?$`)
	danUserFavPathRe  = regexp.MustCompile(`^/users/([1-9][0-9]{0,19})/favorites/?$`)
	pixivUserPathRe   = regexp.MustCompile(`^/(?:en/)?users/([1-9][0-9]{0,19})(?:/artworks)?/?$`)
	pixivTagPathRe    = regexp.MustCompile(`^/(?:en/)?tags/([^/]+)(?:/artworks)?/?$`)
	pixivWorkPathRe   = regexp.MustCompile(`^/(?:en/)?(?:artworks|i)/([1-9][0-9]{0,19})/?$`)
	xHandleRe         = regexp.MustCompile(`^@([A-Za-z0-9_]{1,15})$`)
	xMediaPathRe      = regexp.MustCompile(`^/([A-Za-z0-9_]{1,15})(?:/media)?/?$`)
	xStatusPathRe     = regexp.MustCompile(`^/([A-Za-z0-9_]{1,15}|i/web)/status/([1-9][0-9]{0,19})(?:/(?:photo|video)/[1-9][0-9]*)?/?$`)
	ehGalleryPathRe   = regexp.MustCompile(`(?i)^/g/([1-9][0-9]{0,19})/([0-9a-f]{10})/?$`)
	pawUserPathRe     = regexp.MustCompile(`^/([A-Za-z0-9_-]+)/user/([^/]+)/?$`)
	pawPostPathRe     = regexp.MustCompile(`^/([A-Za-z0-9_-]+)/user/([^/]+)/post/([^/]+)/?$`)
	knownHostTokenRe  = regexp.MustCompile(`^(?:[a-zA-Z][a-zA-Z0-9+.-]*://|(?:https?|ftp|file|javascript|data|mailto):|//|(?:www\.|mobile\.)?(?:pixiv\.net|x\.com|twitter\.com|danbooru\.donmai\.us|e-hentai\.org|exhentai\.org|pawchive\.(?:pw|st))(?:[/:?#]|$)|@[A-Za-z0-9_]{1,15}$)`)
)

var xReservedHandles = map[string]bool{
	"i": true, "home": true, "search": true, "intent": true, "share": true,
	"hashtag": true, "explore": true, "settings": true, "login": true, "logout": true,
	"signup": true, "account": true, "compose": true, "messages": true, "notifications": true,
	"bookmarks": true, "communities": true, "tos": true, "privacy": true, "about": true,
	"help": true, "download": true, "oauth": true, "jobs": true, "premium": true,
}

var defaultSiteOrder = []string{"danbooru", "pixiv", "twitter", "exhentai", "pawchive"}

func isXReserved(handle string) bool {
	return xReservedHandles[strings.ToLower(handle)]
}

func normalizeResolveSites(sites []string) ([]string, error) {
	if len(sites) == 0 {
		return []string{"danbooru"}, nil
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(sites))
	for _, raw := range sites {
		spec, err := discoverydata.SearchSite(raw)
		if err != nil {
			return nil, problem(422, "invalid_collect_site", err.Error())
		}
		if !seen[spec.Site] {
			seen[spec.Site] = true
			out = append(out, spec.Site)
		}
	}
	return out, nil
}

func (s *Service) siteStatuses(ctx context.Context, sites []string) []SiteStatus {
	out := make([]SiteStatus, 0, len(sites))
	for _, site := range sites {
		if s.deps.AuthStatus == nil {
			out = append(out, SiteStatus{Site: site, Authorized: true, State: "ready"})
			continue
		}
		raw, err := s.deps.AuthStatus(ctx, site)
		if err != nil || raw == nil {
			out = append(out, SiteStatus{Site: site, Authorized: false, State: "unknown", Summary: "无法确认站点登录状态"})
			continue
		}
		authorized, _ := raw["authorized"].(bool)
		state, _ := raw["state"].(string)
		summary, _ := raw["summary"].(string)
		out = append(out, SiteStatus{Site: site, Authorized: authorized, State: state, Summary: summary})
	}
	return out
}

func looksLikeURLOrHandle(token string) bool {
	return knownHostTokenRe.MatchString(strings.TrimSpace(token))
}

func (s *Service) Resolve(ctx context.Context, datasetID string, req ResolveRequest) (ResolveResponse, error) {
	if err := s.deps.RequireDataset(ctx, datasetID); err != nil {
		return ResolveResponse{}, err
	}
	trimmed := strings.TrimSpace(req.Input)
	if trimmed == "" || len(trimmed) > 32768 {
		return ResolveResponse{}, problem(422, "invalid_collect_input", "请输入搜索关键词或图站链接")
	}

	tokens := strings.Fields(trimmed)
	allURLs := len(tokens) > 0
	for _, tok := range tokens {
		if !looksLikeURLOrHandle(tok) {
			allURLs = false
			break
		}
	}
	if allURLs {
		return s.resolveURLTokens(ctx, tokens)
	}
	if len(trimmed) > 500 {
		return ResolveResponse{}, problem(422, "invalid_collect_keyword", "搜索关键词长度不能超过 500 个字符")
	}
	sites, err := normalizeResolveSites(req.Sites)
	if err != nil {
		return ResolveResponse{}, err
	}
	return s.resolveKeyword(ctx, trimmed, sites)
}

func parseInputURL(token string) (*url.URL, error) {
	if m := xHandleRe.FindStringSubmatch(token); m != nil {
		if isXReserved(m[1]) {
			return nil, problem(422, "invalid_collect_url", "不支持该 X 保留用户名: "+token)
		}
		return url.Parse("https://x.com/" + strings.ToLower(m[1]) + "/media")
	}
	raw := token
	if !strings.Contains(raw, "://") && !strings.Contains(raw, ":") && !strings.HasPrefix(raw, "//") {
		raw = "https://" + raw
	}
	authorityCheck := strings.TrimPrefix(strings.TrimPrefix(raw, "https://"), "http://")
	if idx := strings.IndexAny(authorityCheck, "/?#"); idx >= 0 {
		authorityCheck = authorityCheck[:idx]
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.Port() != "" || u.Host == "" {
		return nil, problem(422, "invalid_collect_url", "链接格式无效: "+token)
	}
	if !strings.EqualFold(authorityCheck, u.Hostname()) {
		return nil, problem(422, "invalid_collect_url", "链接包含不支持的主机名或端口: "+token)
	}
	return u, nil
}

func (s *Service) resolveURLTokens(ctx context.Context, tokens []string) (ResolveResponse, error) {
	var sources []SourceSpec
	var danPostIDs []string
	seenIDs := map[string]bool{}
	seenSites := map[string]bool{}
	siteOrder := []string{}

	addSite := func(site string) {
		if !seenSites[site] {
			seenSites[site] = true
			siteOrder = append(siteOrder, site)
		}
	}
	addSource := func(spec SourceSpec) {
		if seenIDs[spec.ID] {
			return
		}
		seenIDs[spec.ID] = true
		addSite(spec.Site)
		sources = append(sources, spec)
	}

	for _, tok := range tokens {
		u, err := parseInputURL(tok)
		if err != nil {
			return ResolveResponse{}, err
		}
		host := strings.ToLower(u.Hostname())
		switch {
		case host == "danbooru.donmai.us" || host == "www.danbooru.donmai.us":
			if m := danPoolPathRe.FindStringSubmatch(u.Path); m != nil {
				addSource(SourceSpec{
					ID: "danbooru:pool:" + m[1], Site: "danbooru", Kind: "pool",
					Label: "Pool #" + m[1], Badge: "pool", Reference: m[1],
					URL: "https://danbooru.donmai.us/pools/" + m[1],
					UnitKind: "post", DefaultMode: "all", AutoEnable: true,
				})
				continue
			}
			if m := danFavGroupPathRe.FindStringSubmatch(u.Path); m != nil {
				addSource(SourceSpec{
					ID: "danbooru:favorite_group:" + m[1], Site: "danbooru", Kind: "favorite_group",
					Label: "收藏分组 #" + m[1], Badge: "group", Reference: m[1],
					URL: "https://danbooru.donmai.us/favorite_groups/" + m[1],
					UnitKind: "post", DefaultMode: "all", AutoEnable: true,
				})
				continue
			}
			if m := danPostPathRe.FindStringSubmatch(u.Path); m != nil {
				danPostIDs = append(danPostIDs, m[1])
				addSite("danbooru")
				continue
			}
			if m := danUserFavPathRe.FindStringSubmatch(u.Path); m != nil {
				addSource(SourceSpec{
					ID: "danbooru:favorites:uid:" + m[1], Site: "danbooru", Kind: "favorites",
					Label: "Danbooru 用户 #" + m[1] + " 收藏", Badge: "favorites",
					Reference: "https://danbooru.donmai.us/users/" + m[1] + "/favorites",
					URL:       "https://danbooru.donmai.us/users/" + m[1] + "/favorites",
					UnitKind: "post", DefaultMode: "top_n", DefaultTopN: 50, AutoEnable: true,
				})
				continue
			}
			pathTrimmed := strings.TrimSuffix(u.Path, "/")
			if pathTrimmed == "/favorites" {
				uid := strings.TrimSpace(u.Query().Get("user_id"))
				ref := ""
				label := "Danbooru 我的收藏"
				id := "danbooru:favorites:self"
				if uid != "" {
					if _, err := strconv.Atoi(uid); err != nil {
						return ResolveResponse{}, problem(422, "invalid_collect_url", "Danbooru 用户收藏链接无效: "+tok)
					}
					ref = "https://danbooru.donmai.us/favorites?user_id=" + uid
					label = "Danbooru 用户 #" + uid + " 收藏"
					id = "danbooru:favorites:uid:" + uid
				}
				addSource(SourceSpec{
					ID: id, Site: "danbooru", Kind: "favorites", Label: label, Badge: "favorites",
					Reference: ref, URL: "https://danbooru.donmai.us/favorites",
					UnitKind: "post", DefaultMode: "top_n", DefaultTopN: 50, AutoEnable: true,
				})
				continue
			}
			if pathTrimmed == "/posts" {
				tags := strings.TrimSpace(u.Query().Get("tags"))
				if name, ok := strings.CutPrefix(tags, "ordfav:"); ok && name != "" {
					addSource(SourceSpec{
						ID: "danbooru:favorites:" + name, Site: "danbooru", Kind: "favorites",
						Label: name + " 的收藏", Badge: "favorites", Reference: name,
						URL: "https://danbooru.donmai.us/posts?tags=" + url.QueryEscape(tags),
						UnitKind: "post", DefaultMode: "top_n", DefaultTopN: 50, AutoEnable: true,
					})
					continue
				}
				if tags == "" {
					return ResolveResponse{}, problem(422, "invalid_collect_url", "Danbooru 帖子链接缺少 tags 参数: "+tok)
				}
				addSource(SourceSpec{
					ID: "danbooru:search:" + tags, Site: "danbooru", Kind: "search",
					Label: tags, Badge: "tag", Query: tags,
					URL: "https://danbooru.donmai.us/posts?tags=" + url.QueryEscape(tags),
					UnitKind: "post", DefaultMode: "top_n", DefaultTopN: 50, AutoEnable: true,
				})
				continue
			}
			return ResolveResponse{}, problem(422, "invalid_collect_url", "不支持该 Danbooru 链接路径: "+tok)

		case host == "pixiv.net" || host == "www.pixiv.net":
			if m := pixivWorkPathRe.FindStringSubmatch(u.Path); m != nil {
				target := "https://www.pixiv.net/artworks/" + m[1]
				addSource(SourceSpec{
					ID: "pixiv:work:" + m[1], Site: "pixiv", Kind: "single_work",
					Label: "Pixiv 作品 #" + m[1], Badge: "work", WorkID: m[1], URL: target,
					Total: intPtr(1), UnitKind: "work", DefaultMode: "all", AutoEnable: true,
				})
				continue
			}
			if m := pixivUserPathRe.FindStringSubmatch(u.Path); m != nil {
				target := "https://www.pixiv.net/users/" + m[1] + "/artworks"
				addSource(SourceSpec{
					ID: "pixiv:timeline:" + m[1], Site: "pixiv", Kind: "timeline",
					Label: "Pixiv 画师 #" + m[1], Badge: "artist", URL: target,
					UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50, AutoEnable: true,
				})
				continue
			}
			if strings.HasSuffix(strings.TrimSuffix(u.Path, "/"), "/member.php") {
				uid := strings.TrimSpace(u.Query().Get("id"))
				if _, err := strconv.ParseUint(uid, 10, 64); err != nil || uid == "0" {
					return ResolveResponse{}, problem(422, "invalid_collect_url", "Pixiv 画师链接无效: "+tok)
				}
				target := "https://www.pixiv.net/users/" + uid + "/artworks"
				addSource(SourceSpec{
					ID: "pixiv:timeline:" + uid, Site: "pixiv", Kind: "timeline",
					Label: "Pixiv 画师 #" + uid, Badge: "artist", URL: target,
					UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50, AutoEnable: true,
				})
				continue
			}
			if u.Path == "/search.php" {
				word := strings.TrimSpace(u.Query().Get("word"))
				if word == "" {
					return ResolveResponse{}, problem(422, "invalid_collect_url", "Pixiv 搜索链接缺少 word 参数: "+tok)
				}
				target := "https://www.pixiv.net/search.php?word=" + url.QueryEscape(word)
				addSource(SourceSpec{
					ID: "pixiv:search:" + word, Site: "pixiv", Kind: "search",
					Label: "标签: " + word, Badge: "tag", Query: word, URL: target,
					UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50, AutoEnable: true,
				})
				continue
			}
			if m := pixivTagPathRe.FindStringSubmatch(u.Path); m != nil {
				word, _ := url.PathUnescape(m[1])
				word = strings.TrimSpace(word)
				if word == "" {
					return ResolveResponse{}, problem(422, "invalid_collect_url", "Pixiv 标签链接无效: "+tok)
				}
				target := "https://www.pixiv.net/search.php?word=" + url.QueryEscape(word)
				addSource(SourceSpec{
					ID: "pixiv:search:" + word, Site: "pixiv", Kind: "search",
					Label: "标签: " + word, Badge: "tag", Query: word, URL: target,
					UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50, AutoEnable: true,
				})
				continue
			}
			return ResolveResponse{}, problem(422, "invalid_collect_url", "不支持该 Pixiv 链接: "+tok)

		case host == "x.com" || host == "www.x.com" || host == "mobile.x.com" || host == "twitter.com" || host == "www.twitter.com" || host == "mobile.twitter.com":
			if m := xStatusPathRe.FindStringSubmatch(u.Path); m != nil {
				who := strings.ToLower(m[1])
				if who == "i" || who == "i/web" {
					who = "i/web"
				} else if isXReserved(who) {
					return ResolveResponse{}, problem(422, "invalid_collect_url", "不支持该 X 帖子链接: "+tok)
				}
				target := "https://x.com/" + who + "/status/" + m[2]
				addSource(SourceSpec{
					ID: "twitter:work:" + m[2], Site: "twitter", Kind: "single_work",
					Label: "X 帖子 #" + m[2], Badge: "work", WorkID: m[2], URL: target,
					Total: intPtr(1), UnitKind: "work", DefaultMode: "all", AutoEnable: true,
				})
				continue
			}
			if strings.TrimSuffix(u.Path, "/") == "/search" {
				q := strings.TrimSpace(u.Query().Get("q"))
				if q == "" {
					return ResolveResponse{}, problem(422, "invalid_collect_url", "X 搜索链接缺少 q 参数: "+tok)
				}
				target := "https://x.com/search?q=" + url.QueryEscape(q)
				addSource(SourceSpec{
					ID: "twitter:search:" + q, Site: "twitter", Kind: "search",
					Label: "搜索: " + q, Badge: "search", Query: q, URL: target,
					UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50, AutoEnable: true,
				})
				continue
			}
			if m := xMediaPathRe.FindStringSubmatch(u.Path); m != nil && !isXReserved(m[1]) {
				handle := strings.ToLower(m[1])
				target := "https://x.com/" + handle + "/media"
				addSource(SourceSpec{
					ID: "twitter:timeline:" + handle, Site: "twitter", Kind: "timeline",
					Label: "@" + handle, Badge: "account", URL: target,
					UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50, AutoEnable: true,
				})
				continue
			}
			return ResolveResponse{}, problem(422, "invalid_collect_url", "不支持该 X / Twitter 链接: "+tok)

		case host == "e-hentai.org" || host == "exhentai.org":
			if m := ehGalleryPathRe.FindStringSubmatch(u.Path); m != nil {
				target := "https://" + host + "/g/" + m[1] + "/" + strings.ToLower(m[2]) + "/"
				addSource(SourceSpec{
					ID: "exhentai:gallery:" + m[1], Site: "exhentai", Kind: "eh_gallery",
					Label: "EH 画廊 #" + m[1], Badge: "gallery", URL: target,
					UnitKind: "page", DefaultMode: "all", AutoEnable: true,
				})
				continue
			}
			return ResolveResponse{}, problem(422, "invalid_collect_url", "请输入具体的 EH 画廊链接 (/g/ID/TOKEN/): "+tok)

		case host == "pawchive.pw" || host == "www.pawchive.pw" || host == "pawchive.st" || host == "www.pawchive.st":
			if m := pawPostPathRe.FindStringSubmatch(u.Path); m != nil {
				svc, uid, pid := strings.ToLower(m[1]), m[2], m[3]
				target := fmt.Sprintf("https://pawchive.pw/%s/user/%s/post/%s", svc, uid, pid)
				addSource(SourceSpec{
					ID: "pawchive:work:" + svc + ":" + uid + ":" + pid, Site: "pawchive", Kind: "single_work",
					Label: fmt.Sprintf("%s/%s #%s", svc, uid, pid), Badge: "work", WorkID: pid, URL: target,
					Total: intPtr(1), UnitKind: "work", DefaultMode: "all", AutoEnable: true,
				})
				continue
			}
			if m := pawUserPathRe.FindStringSubmatch(u.Path); m != nil {
				svc, uid := strings.ToLower(m[1]), m[2]
				target := fmt.Sprintf("https://pawchive.pw/%s/user/%s", svc, uid)
				addSource(SourceSpec{
					ID: "pawchive:timeline:" + svc + ":" + uid, Site: "pawchive", Kind: "timeline",
					Label: fmt.Sprintf("%s / %s", svc, uid), Badge: "account", URL: target,
					UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50, AutoEnable: true,
				})
				continue
			}
			if strings.TrimSuffix(u.Path, "/") == "/posts" {
				q := strings.TrimSpace(u.Query().Get("q"))
				tag := strings.TrimSpace(u.Query().Get("tag"))
				if q == "" && tag == "" {
					return ResolveResponse{}, problem(422, "invalid_collect_url", "Pawchive 帖子搜索链接缺少 q 或 tag 参数: "+tok)
				}
				values := url.Values{}
				if q != "" {
					values.Set("q", q)
				}
				if tag != "" {
					values.Set("tag", tag)
				}
				target := "https://pawchive.pw/posts?" + values.Encode()
				label := q
				if label == "" {
					label = tag
				}
				addSource(SourceSpec{
					ID: "pawchive:search:" + target, Site: "pawchive", Kind: "search",
					Label: "帖子搜索: " + label, Badge: "search", Query: label, URL: target,
					UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50, AutoEnable: true,
				})
				continue
			}
			return ResolveResponse{}, problem(422, "invalid_collect_url", "不支持该 Pawchive 链接: "+tok)

		default:
			return ResolveResponse{}, problem(422, "invalid_collect_url", "暂不支持该图站链接: "+tok)
		}
	}

	if len(danPostIDs) > 0 {
		if len(danPostIDs) > 200 {
			return ResolveResponse{}, problem(422, "invalid_collect_url", "单次粘贴的 Danbooru 单帖链接不能超过 200 条")
		}
		uniq := uniqueStrings(danPostIDs)
		query := "id:" + strings.Join(uniq, ",")
		label := "Danbooru #" + uniq[0]
		if len(uniq) > 1 {
			label = fmt.Sprintf("Danbooru %d 张帖子", len(uniq))
		}
		addSource(SourceSpec{
			ID: "danbooru:posts:" + strings.Join(uniq, ","), Site: "danbooru", Kind: "search",
			Label: label, Badge: "work", Query: query,
			URL:      "https://danbooru.donmai.us/posts?tags=" + url.QueryEscape(query),
			Total:    intPtr(len(uniq)),
			UnitKind: "post", DefaultMode: "all", AutoEnable: true,
		})
	}

	return ResolveResponse{
		ResolvedMode: "url",
		Sources:      sources,
		SiteStatuses: s.siteStatuses(ctx, siteOrder),
		Warnings:     []string{},
	}, nil
}

func (s *Service) resolveKeyword(ctx context.Context, keyword string, sites []string) (ResolveResponse, error) {
	// Fast path: when only Danbooru is selected, skip multi-site subprocess search
	// and let the caller immediately browse the query results.
	if len(sites) == 1 && sites[0] == "danbooru" {
		return ResolveResponse{
			ResolvedMode: "keyword",
			Sources: []SourceSpec{{
				ID:          "danbooru:search:" + keyword,
				Site:        "danbooru",
				Kind:        "search",
				Label:       keyword,
				Badge:       "tag",
				Query:       keyword,
				URL:         "https://danbooru.donmai.us/posts?tags=" + url.QueryEscape(keyword),
				UnitKind:    "post",
				DefaultMode: "top_n",
				DefaultTopN: 50,
			}},
			SiteStatuses: s.siteStatuses(ctx, sites),
			Warnings:     []string{},
		}, nil
	}

	if s.deps.Search == nil {
		return ResolveResponse{}, problem(503, "search_unavailable", "多源发现服务尚未连接")
	}
	raw, err := s.deps.Search(ctx, search.Request{
		Keyword:       keyword,
		Sites:         sites,
		Limit:         20,
		SourceOptions: search.SourceOptions{TimeoutSeconds: 45},
	})
	if err != nil {
		return ResolveResponse{}, err
	}

	sources := make([]SourceSpec, 0, 8)
	statuses := make([]SiteStatus, 0, len(sites))
	warnings := []string{}
	seenIDs := map[string]bool{}
	wantSite := map[string]bool{}
	for _, site := range sites {
		wantSite[site] = true
	}

	appendSource := func(spec SourceSpec) {
		if seenIDs[spec.ID] {
			return
		}
		seenIDs[spec.ID] = true
		sources = append(sources, spec)
	}

	if wantSite["danbooru"] {
		appendSource(SourceSpec{
			ID: "danbooru:search:" + keyword, Site: "danbooru", Kind: "search",
			Label: keyword, Badge: "tag", Query: keyword,
			URL:      "https://danbooru.donmai.us/posts?tags=" + url.QueryEscape(keyword),
			UnitKind: "post", DefaultMode: "top_n", DefaultTopN: 50,
		})
	}

	bySite := map[string]map[string]any{}
	for _, entry := range mapSlice(raw["sources"]) {
		site, _ := entry["site"].(string)
		if site != "" {
			bySite[site] = entry
		}
	}

	for _, site := range sites {
		entry := bySite[site]
		st := SiteStatus{Site: site, Authorized: true, State: "ready"}
		if auth, ok := entry["auth"].(map[string]any); ok {
			st.Authorized, _ = auth["authorized"].(bool)
			st.State, _ = auth["state"].(string)
			st.Summary, _ = auth["summary"].(string)
		} else if list := s.siteStatuses(ctx, []string{site}); len(list) == 1 {
			st = list[0]
		}
		if detail, ok := entry["error"].(map[string]any); ok {
			if msg, _ := detail["message"].(string); msg != "" {
				st.Warnings = append(st.Warnings, msg)
			}
		}
		statuses = append(statuses, st)

		addresses := mapSlice(entry["addresses"])
		switch site {
		case "danbooru":
			for _, addr := range addresses {
				tag, _ := addr["tag"].(string)
				if tag == "" {
					continue
				}
				label, _ := addr["label"].(string)
				if label == "" {
					label = strings.ReplaceAll(tag, "_", " ")
				}
				badge := "tag"
				if at, _ := addr["address_type"].(string); at == "artist_tag" {
					badge = "artist"
				}
				appendSource(SourceSpec{
					ID: "danbooru:search:" + tag, Site: "danbooru", Kind: "search",
					Label: label, Badge: badge, Query: tag,
					URL:      "https://danbooru.donmai.us/posts?tags=" + url.QueryEscape(tag),
					UnitKind: "post", DefaultMode: "top_n", DefaultTopN: 50,
				})
			}
		case "pixiv":
			for _, addr := range addresses {
				u, _ := addr["url"].(string)
				if u == "" {
					continue
				}
				label, _ := addr["label"].(string)
				if label == "" {
					label = u
				}
				appendSource(SourceSpec{
					ID: "pixiv:timeline:" + u, Site: "pixiv", Kind: "timeline",
					Label: label, Badge: "artist", URL: u,
					UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50,
				})
			}
			appendSource(SourceSpec{
				ID: "pixiv:search:" + keyword, Site: "pixiv", Kind: "search",
				Label: "标签: " + keyword, Badge: "tag", Query: keyword,
				URL:      "https://www.pixiv.net/search.php?word=" + url.QueryEscape(keyword),
				UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50,
			})
		case "twitter":
			for _, addr := range addresses {
				u, _ := addr["url"].(string)
				if u == "" {
					continue
				}
				label, _ := addr["label"].(string)
				if label == "" {
					label = u
				}
				appendSource(SourceSpec{
					ID: "twitter:timeline:" + u, Site: "twitter", Kind: "timeline",
					Label: label, Badge: "account", URL: u,
					UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50,
				})
			}
			appendSource(SourceSpec{
				ID: "twitter:search:" + keyword, Site: "twitter", Kind: "search",
				Label: "搜索: " + keyword, Badge: "search", Query: keyword,
				URL:      "https://x.com/search?q=" + url.QueryEscape(keyword),
				UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50,
			})
		case "exhentai":
			for _, addr := range addresses {
				u, _ := addr["url"].(string)
				if u == "" {
					continue
				}
				label, _ := addr["label"].(string)
				if label == "" {
					label = u
				}
				var total *int
				if n := toInt(addr["media_count"]); n > 0 {
					total = intPtr(n)
				}
				thumb, _ := addr["thumbnail_url"].(string)
				appendSource(SourceSpec{
					ID: "exhentai:gallery:" + u, Site: "exhentai", Kind: "eh_gallery",
					Label: label, Badge: "gallery", URL: u, Total: total,
					CoverURL: s.signMedia("exhentai", thumb, nil),
					UnitKind: "page", DefaultMode: "all",
				})
			}
		case "pawchive":
			count := 0
			for _, addr := range addresses {
				u, _ := addr["url"].(string)
				if u == "" {
					continue
				}
				label, _ := addr["label"].(string)
				if label == "" {
					label = u
				}
				thumb, _ := addr["thumbnail_url"].(string)
				appendSource(SourceSpec{
					ID: "pawchive:timeline:" + u, Site: "pawchive", Kind: "timeline",
					Label: label, Badge: "account", URL: u,
					CoverURL: s.signMedia("pawchive", thumb, nil),
					UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50,
				})
				count++
			}
			if count == 0 {
				searchURL := "https://pawchive.pw/posts?q=" + url.QueryEscape(keyword)
				appendSource(SourceSpec{
					ID: "pawchive:search:" + keyword, Site: "pawchive", Kind: "search",
					Label: "帖子搜索: " + keyword, Badge: "search", Query: keyword, URL: searchURL,
					UnitKind: "work", DefaultMode: "top_n", DefaultTopN: 50,
				})
			}
		}
	}

	return ResolveResponse{
		ResolvedMode: "keyword",
		Sources:      sources,
		SiteStatuses: statuses,
		Warnings:     warnings,
	}, nil
}

func intPtr(v int) *int { return &v }

func toInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	default:
		return 0
	}
}

func mapSlice(v any) []map[string]any {
	if rows, ok := v.([]map[string]any); ok {
		return rows
	}
	if list, ok := v.([]any); ok {
		out := make([]map[string]any, 0, len(list))
		for _, item := range list {
			if m, ok := item.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}

func uniqueStrings(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}
