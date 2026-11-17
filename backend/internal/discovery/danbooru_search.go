package discovery

import (
	"context"
	"errors"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/scheduler"
)

func danKeyword(request Request) string {
	if request.Keyword == nil {
		return ""
	}
	return *request.Keyword
}
func danSearchURL(keyword string) (string, error) {
	spec, err := discoverydata.SearchSite("danbooru")
	if err != nil {
		return "", err
	}
	return spec.SearchURL(keyword)
}
func danArtistURL(keyword string) string {
	return danBaseURL + "/artists?" + url.Values{"search[any_name_matches]": {strings.Join(strings.Fields(keyword), " ")}}.Encode()
}
func danProtocol(message string) error {
	return &Error{Code: "danbooru_api_protocol", Message: message}
}
func danSearchResult(keyword, target string, candidates, authors []map[string]any, proxy map[string]any, attempts int) map[string]any {
	return map[string]any{"site": "danbooru", "keyword": keyword, "search_url": target, "candidate_count": len(candidates), "author_count": len(authors), "candidates": candidates, "authors": authors, "proxy": proxy, "attempts": attempts, "transport": "danbooru_api_honest_ua"}
}

// Match DanbooruTagExtractor.posts, including query terms with their own order.
func danPagePrefix(keyword string) string {
	prefix := "b"
	for _, tag := range strings.Fields(keyword) {
		if strings.HasPrefix(tag, "order:") {
			switch tag {
			case "order:id", "order:id_asc":
				prefix = "a"
			case "order:id_desc":
				prefix = "b"
			default:
				prefix = ""
			}
		} else {
			for _, term := range []string{"id:", "md5:", "ordfav:", "ordfavgroup:", "ordpool:"} {
				if strings.HasPrefix(tag, term) {
					return ""
				}
			}
		}
	}
	return prefix
}
func (a *DanbooruAdapter) SearchPostsAPI(ctx context.Context, request Request) (map[string]any, error) {
	return a.danSearchPostsAPI(ctx, request, true)
}
func (a *DanbooruAdapter) danSearchPostsAPI(ctx context.Context, request Request, secure bool) (map[string]any, error) {
	keyword := danKeyword(request)
	target, err := danSearchURL(keyword)
	if err != nil {
		return nil, err
	}
	ctx, err = a.danAuthContext(ctx, request, target)
	if err != nil {
		return nil, err
	}
	requested := max(1, request.Limit)
	candidates := []map[string]any{}
	authors := []map[string]any{}
	candidateIDs := map[string]bool{}
	authorKeys := map[string]bool{}
	prefix := danPagePrefix(keyword)
	var cursor *int
	page := 1
	seenPostIDs := map[int]bool{}
	proxy := map[string]any{}
	attempts := 0
	for len(candidates) < requested {
		pageLimit := min(200, requested-len(candidates))
		if prefix == "" {
			// Page-number offsets depend on a constant limit, including the last page.
			pageLimit = min(200, requested)
		}
		params := url.Values{"tags": {keyword}, "limit": {strconv.Itoa(pageLimit)}}
		if prefix == "" {
			params.Set("page", strconv.Itoa(page))
		} else if cursor != nil {
			params.Set("page", prefix+strconv.Itoa(*cursor))
		}
		outcome, err := a.APIJSON(ctx, danBaseURL+"/posts.json", params, request.Policy, request.ProxyMode, secure)
		if err != nil {
			return nil, err
		}
		proxy = outcome.Proxy
		attempts += outcome.Attempts
		rows, ok := danRows(outcome.Value)
		if !ok {
			return nil, danProtocol("Danbooru posts API 返回结构无效")
		}
		if len(rows) == 0 {
			break
		}
		// Danbooru's a<ID> pages arrive descending, unlike the first id_asc page.
		if prefix == "a" && page > 1 {
			slices.Reverse(rows)
		}
		previousIDs := len(seenPostIDs)
		pageIDs := []int{}
		for _, raw := range rows {
			row, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if id, ok := integer(row["id"]); ok {
				pageIDs = append(pageIDs, id)
				seenPostIDs[id] = true
			}
			candidate, rowAuthors := discoverydata.DanbooruCandidate(row)
			if candidate != nil {
				id := stringValue(candidate["id"])
				if !candidateIDs[id] {
					candidateIDs[id] = true
					candidates = append(candidates, candidate)
				}
			}
			for _, author := range rowAuthors {
				key := stringValue(author["works_url"])
				if key == "" {
					key = stringValue(author["name"])
				}
				if key != "" && !authorKeys[key] {
					authorKeys[key] = true
					authors = append(authors, author)
				}
			}
			if len(candidates) >= requested {
				break
			}
		}
		if len(pageIDs) == 0 {
			return nil, danProtocol("Danbooru posts API 分页缺少帖子 ID")
		}
		if len(seenPostIDs) == previousIDs {
			return nil, danProtocol("Danbooru posts API 分页没有新帖子")
		}
		if len(rows) < pageLimit || len(candidates) >= requested {
			break
		}
		if prefix != "" {
			next := pageIDs[0]
			for _, id := range pageIDs[1:] {
				if prefix == "a" {
					next = max(next, id)
				} else {
					next = min(next, id)
				}
			}
			if cursor != nil && ((prefix == "a" && next <= *cursor) || (prefix == "b" && next >= *cursor)) {
				return nil, danProtocol("Danbooru posts API 分页游标没有前进")
			}
			cursor = &next
		}
		page++
	}
	return danSearchResult(keyword, target, candidates, authors, proxy, attempts), nil
}

func (a *DanbooruAdapter) SearchArtistsAPI(ctx context.Context, request Request) (map[string]any, error) {
	ctx, err := a.danAuthContext(ctx, request, danArtistURL(danKeyword(request)))
	if err != nil {
		return nil, err
	}
	keyword := danKeyword(request)
	params := url.Values{"search[any_name_matches]": {strings.Join(strings.Fields(keyword), " ")}, "limit": {strconv.Itoa(min(max(1, request.Limit), 200))}}
	outcome, err := a.APIJSON(ctx, danBaseURL+"/artists.json", params, request.Policy, request.ProxyMode, true)
	if err != nil {
		return nil, err
	}
	rows, ok := danRows(outcome.Value)
	if !ok {
		return nil, danProtocol("Danbooru artists API 返回结构无效")
	}
	authors := []map[string]any{}
	for _, raw := range rows[:min(max(0, request.Limit), len(rows))] {
		row, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name := strings.TrimSpace(stringValue(row["name"]))
		if name == "" {
			continue
		}
		_, rowAuthors := discoverydata.DanbooruArtistQueue(danBaseURL+"/posts?"+url.Values{"tags": {name}}.Encode(), row)
		authors = append(authors, rowAuthors...)
	}
	return danSearchResult(keyword, danArtistURL(keyword), []map[string]any{}, authors, outcome.Proxy, outcome.Attempts), nil
}

func danBounded(ctx context.Context, seconds float64, message string, operation func(context.Context) (map[string]any, error)) (map[string]any, error) {
	bounded, cancel := context.WithTimeout(ctx, duration(seconds))
	defer cancel()
	result, err := operation(bounded)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if errors.Is(bounded.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return nil, &Error{Code: "discovery_failed", Message: message, Details: map[string]any{"timeout_seconds": seconds}}
	}
	return result, err
}
func (a *DanbooruAdapter) Search(ctx context.Context, request Request) (map[string]any, error) {
	request.Policy = danTargetPolicy(request.Policy)
	request.Site = "danbooru"
	request.RangeKind = "post"
	target, err := danSearchURL(danKeyword(request))
	if err != nil {
		return nil, err
	}
	request.URL = target
	return a.danGalleryFallback(ctx, request, false)
}
func (a *DanbooruAdapter) SearchArtists(ctx context.Context, request Request) (map[string]any, error) {
	request.Policy = danTargetPolicy(request.Policy)
	request.Site = "danbooru"
	request.RangeKind = "child"
	request.URL = danArtistURL(danKeyword(request))
	return a.danGalleryFallback(ctx, request, true)
}
func (a *DanbooruAdapter) danGalleryFallback(ctx context.Context, request Request, artists bool) (map[string]any, error) {
	result, err := a.GalleryDiscover(ctx, request)
	if err != nil {
		var public *Error
		if !errors.As(err, &public) || discoverydata.IsDNSErrorCode(public.Code) {
			return nil, err
		}
	}
	key, message := "candidate_count", "Danbooru 帖子分页发现超时"
	fallback := a.SearchPostsAPI
	if artists {
		key = "author_count"
		message = "Danbooru 画师检索超时"
		fallback = a.SearchArtistsAPI
	}
	if err == nil && danTruthy(result[key]) {
		return result, nil
	}
	return danBounded(ctx, request.TimeoutSeconds, message, func(ctx context.Context) (map[string]any, error) { return fallback(ctx, request) })
}
func (a *DanbooruAdapter) Discover(ctx context.Context, request Request) (map[string]any, error) {
	request.Policy = danTargetPolicy(request.Policy)
	request.Site = "danbooru"
	if request.Keyword == nil && len(request.ExtraArgs) == 0 && request.CredentialsRef == "" && request.CookiesFile == "" && request.ConfigFile == "" {
		parsed, err := url.Parse(request.URL)
		if err == nil {
			tags := strings.TrimSpace(parsed.Query().Get("tags"))
			if strings.TrimRight(parsed.Path, "/") == "/posts" && tags != "" {
				request.Keyword = &tags
				return danBounded(ctx, request.TimeoutSeconds, "Danbooru 帖子分页发现超时", func(ctx context.Context) (map[string]any, error) { return a.danSearchPostsAPI(ctx, request, false) })
			}
		}
	}
	return a.GalleryDiscover(ctx, request)
}

func danText(value any, limit int) any {
	if value == nil {
		return nil
	}
	text := []rune(strings.TrimSpace(stringValue(value)))
	if len(text) == 0 {
		return nil
	}
	return string(text[:min(limit, len(text))])
}
func (a *DanbooruAdapter) Autocomplete(ctx context.Context, query string, limit int, policy scheduler.Policy, mode string) (map[string]any, error) {
	outcome, err := a.APIJSON(ctx, danBaseURL+"/autocomplete.json", url.Values{"search[query]": {query}, "search[type]": {"tag_query"}, "version": {"1"}, "limit": {strconv.Itoa(min(max(1, limit), 20))}}, policy, mode, true)
	if err != nil {
		return nil, err
	}
	rows, ok := danRows(outcome.Value)
	if !ok {
		return nil, danProtocol("Danbooru autocomplete 返回结构无效")
	}
	items := []map[string]any{}
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		value := danText(row["value"], 300)
		if value == nil {
			continue
		}
		label := danText(row["label"], 300)
		if label == nil {
			label = strings.ReplaceAll(value.(string), "_", " ")
		}
		category, _ := integer(row["category"])
		var count any
		if n, ok := integer(row["post_count"]); ok {
			count = n
		}
		items = append(items, map[string]any{"value": value, "label": label, "match_type": danText(row["type"], 50), "antecedent": danText(row["antecedent"], 300), "category": discoverydata.TagCategoryName(category), "post_count": count})
	}
	return map[string]any{"query": query, "items": items, "proxy": outcome.Proxy, "attempts": outcome.Attempts}, nil
}
