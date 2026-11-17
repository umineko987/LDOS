package discovery

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
)

type DanbooruBrowseOptions struct {
	Kind      string `json:"kind"`
	Query     string `json:"query"`
	Reference string `json:"reference"`
	Cursor    string `json:"cursor"`
	Limit     int    `json:"limit"`
	Count     bool   `json:"count"`
}

type DanbooruPost struct {
	ID                string              `json:"id"`
	URL               string              `json:"url"`
	Title             string              `json:"title"`
	Width             int                 `json:"width"`
	Height            int                 `json:"height"`
	Rating            string              `json:"rating"`
	Score             int                 `json:"score"`
	FileExt           string              `json:"file_ext"`
	FileSize          int64               `json:"file_size"`
	Tags              map[string][]string `json:"tags"`
	SourceURL         string              `json:"source_url"`
	Downloadable      bool                `json:"downloadable"`
	UnavailableReason string              `json:"unavailable_reason"`
	PreviewURL        string              `json:"preview_url"`
	SampleURL         string              `json:"sample_url"`
}

type DanbooruSource struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
}

type DanbooruBrowsePage struct {
	Items      []DanbooruPost `json:"items"`
	Source     DanbooruSource `json:"source"`
	NextCursor string         `json:"next_cursor"`
	Total      *int           `json:"total"`
	Warnings   []string       `json:"warnings"`
}

// Numeric pages are meaningful only with the same query and limit. Collections
// additionally carry the upstream revision so reordered members cannot be skipped.
// The cursor contains no account headers, keys, or remote media URLs.
type danBrowseCursor struct {
	Version   int    `json:"v"`
	Kind      string `json:"kind"`
	Key       string `json:"key"`
	Limit     int    `json:"limit"`
	Page      string `json:"page,omitempty"`
	Offset    int    `json:"offset,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

func danBrowseInvalid(message string) error {
	return &Error{Code: "invalid_danbooru_browse", Message: message}
}

func danBrowsePositive(value string) (int, bool) {
	if value == "" {
		return 0, false
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(value)
	return n, err == nil && n > 0
}

func danBrowseDecode(value string) (*danBrowseCursor, error) {
	if value == "" {
		return nil, nil
	}
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, danBrowseInvalid("Danbooru 分页游标无效，请重新加载")
	}
	var cursor danBrowseCursor
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cursor); err != nil || cursor.Version != 1 || cursor.Limit < 1 || cursor.Limit > 100 {
		return nil, danBrowseInvalid("Danbooru 分页游标无效，请重新加载")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, danBrowseInvalid("Danbooru 分页游标无效，请重新加载")
	}
	key, err := base64.RawURLEncoding.DecodeString(cursor.Key)
	if err != nil {
		return nil, danBrowseInvalid("Danbooru 分页游标无效，请重新加载")
	}
	cursor.Key = string(key)
	return &cursor, nil
}

func danBrowseEncode(cursor danBrowseCursor) string {
	// Bound worst-case JSON escaping so a 1000-byte query still fits a cursor.
	cursor.Key = base64.RawURLEncoding.EncodeToString([]byte(cursor.Key))
	data, _ := json.Marshal(cursor)
	return base64.RawURLEncoding.EncodeToString(data)
}

func danBrowseURL(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || !strings.EqualFold(u.Host, "danbooru.donmai.us") || u.User != nil || u.Opaque != "" {
		return nil, danBrowseInvalid("只接受 Danbooru 本站对应资源链接")
	}
	return u, nil
}

func danBrowseCollectionID(kind, reference string) (string, error) {
	if n, ok := danBrowsePositive(reference); ok {
		return strconv.Itoa(n), nil
	}
	u, err := danBrowseURL(reference)
	if err != nil {
		return "", err
	}
	path := "/pools/"
	if kind == "favorite_group" {
		path = "/favorite_groups/"
	}
	id, ok := strings.CutPrefix(strings.TrimSuffix(u.Path, "/"), path)
	if n, valid := danBrowsePositive(id); ok && valid && u.RawQuery == "" {
		return strconv.Itoa(n), nil
	}
	return "", danBrowseInvalid("Danbooru 集合链接或 ID 无效")
}

func danBrowseUsername(name string) bool {
	if name == "" || strings.EqualFold(name, "Anonymous") {
		return false
	}
	for _, c := range name {
		if unicode.IsSpace(c) || unicode.IsControl(c) || strings.ContainsRune(":/\\?#&=%@", c) {
			return false
		}
	}
	return true
}

// A bare reference denotes a username; user links resolve the numeric user ID.
func danBrowseFavoriteReference(reference string) (name, id string, err error) {
	if reference == "" {
		return "", "", nil
	}
	if !strings.ContainsAny(reference, ":/\\?#") {
		if !danBrowseUsername(reference) {
			return "", "", danBrowseInvalid("Danbooru 收藏用户名无效")
		}
		return reference, "", nil
	}
	u, err := danBrowseURL(reference)
	if err != nil {
		return "", "", err
	}
	params, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return "", "", danBrowseInvalid("Danbooru 收藏链接无效")
	}
	path := strings.TrimSuffix(u.Path, "/")
	if path == "/posts" && len(params) == 1 && len(params["tags"]) == 1 {
		if name, ok := strings.CutPrefix(params.Get("tags"), "ordfav:"); ok && danBrowseUsername(name) {
			return name, "", nil
		}
	}
	if path == "/favorites" && len(params) == 0 {
		return "", "", nil
	}
	if path == "/favorites" && len(params) == 1 && len(params["user_id"]) == 1 {
		if n, ok := danBrowsePositive(params.Get("user_id")); ok {
			return "", strconv.Itoa(n), nil
		}
	}
	if rest, ok := strings.CutPrefix(path, "/users/"); ok && len(params) == 0 {
		rest = strings.TrimSuffix(rest, "/favorites")
		if n, valid := danBrowsePositive(rest); valid {
			return "", strconv.Itoa(n), nil
		}
	}
	return "", "", danBrowseInvalid("Danbooru 收藏链接无效")
}

func danBrowsePageNumber(cursor *danBrowseCursor, prefix string) (string, error) {
	if cursor == nil {
		if prefix == "" {
			return "1", nil
		}
		return "", nil
	}
	page := cursor.Page
	if cursor.Offset != 0 || cursor.UpdatedAt != "" {
		return "", danBrowseInvalid("Danbooru 搜索分页游标无效")
	}
	if prefix != "" {
		var ok bool
		page, ok = strings.CutPrefix(page, prefix)
		if !ok {
			return "", danBrowseInvalid("Danbooru 搜索分页方向不匹配")
		}
	}
	n, ok := danBrowsePositive(page)
	if !ok || (prefix == "" && n < 2) || n == int(^uint(0)>>1) {
		return "", danBrowseInvalid("Danbooru 搜索分页游标无效")
	}
	return cursor.Page, nil
}

// Browse performs one native API page. Authentication and the timeout cover
// identity resolution, collection metadata, post batches, and optional counts.
func (a *DanbooruAdapter) Browse(ctx context.Context, request Request, opt DanbooruBrowseOptions) (*DanbooruBrowsePage, error) {
	if opt.Limit == 0 {
		opt.Limit = 48
	}
	if opt.Limit < 1 || opt.Limit > 100 || len(opt.Query) > 1000 || len(opt.Reference) > 1000 || len(opt.Cursor) > 2048 {
		return nil, danBrowseInvalid("Danbooru 浏览参数超出允许范围")
	}
	opt.Query, opt.Reference = strings.TrimSpace(opt.Query), strings.TrimSpace(opt.Reference)
	cursor, err := danBrowseDecode(opt.Cursor)
	if err != nil {
		return nil, err
	}
	if cursor != nil && (cursor.Kind != opt.Kind || cursor.Limit != opt.Limit) {
		return nil, danBrowseInvalid("Danbooru 来源或每页数量已改变，请重新加载")
	}
	var key, userID string
	switch opt.Kind {
	case "search":
		key = opt.Query
		if _, err := danBrowsePageNumber(cursor, danPagePrefix(opt.Query)); err != nil {
			return nil, err
		}
	case "pool", "favorite_group":
		key, err = danBrowseCollectionID(opt.Kind, opt.Reference)
		if cursor != nil && (cursor.Offset <= 0 || cursor.UpdatedAt == "" || cursor.Page != "") {
			return nil, danBrowseInvalid("Danbooru 集合分页游标无效")
		}
	case "favorites":
		key, userID, err = danBrowseFavoriteReference(opt.Reference)
		if _, pageErr := danBrowsePageNumber(cursor, ""); pageErr != nil {
			return nil, pageErr
		}
	default:
		return nil, danBrowseInvalid("不支持的 Danbooru 浏览来源类型")
	}
	if err != nil {
		return nil, err
	}
	if cursor != nil && opt.Kind != "favorites" && cursor.Key != key {
		return nil, danBrowseInvalid("Danbooru 来源或查询已改变，请重新加载")
	}
	request.Policy = danTargetPolicy(request.Policy)
	if request.TimeoutSeconds <= 0 {
		request.TimeoutSeconds = 60
	}
	bounded, cancel := context.WithTimeout(ctx, duration(request.TimeoutSeconds))
	defer cancel()
	page, err := a.danBrowse(bounded, request, opt, cursor, key, userID)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if bounded.Err() != nil && page == nil {
		return nil, &Error{Code: "discovery_failed", Message: "Danbooru 浏览超时", Details: map[string]any{"timeout_seconds": request.TimeoutSeconds}}
	}
	return page, err
}

func (a *DanbooruAdapter) danBrowse(ctx context.Context, request Request, opt DanbooruBrowseOptions, cursor *danBrowseCursor, key, userID string) (*DanbooruBrowsePage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	ctx, err := a.danAuthContext(ctx, request, danBaseURL+"/posts?tags="+url.QueryEscape(opt.Query))
	if err != nil {
		return nil, err
	}
	if opt.Kind == "pool" || opt.Kind == "favorite_group" {
		return a.danBrowseCollection(ctx, request, opt, cursor, key)
	}
	source := DanbooruSource{Kind: opt.Kind, Name: opt.Query, URL: danBaseURL + "/posts?" + url.Values{"tags": {opt.Query}}.Encode()}
	query := opt.Query
	if opt.Kind == "favorites" {
		if key == "" {
			target := danBaseURL + "/profile.json"
			if userID != "" {
				target = danBaseURL + "/users/" + userID + ".json"
			}
			outcome, err := a.APIJSON(ctx, target, nil, request.Policy, request.ProxyMode, true)
			if err != nil {
				return nil, err
			}
			user, ok := outcome.Value.(map[string]any)
			id, validID := danBrowsePositive(stringValue(user["id"]))
			key = stringValue(user["name"])
			level, hasLevel := integer(user["level"])
			if !ok || !validID || !danBrowseUsername(key) || danTruthy(user["is_anonymous"]) || (hasLevel && level == 0) {
				return nil, &Error{Code: "danbooru_auth_required", Message: "无法读取 Danbooru 收藏身份，请检查账号授权或用户链接"}
			}
			if userID != "" && strconv.Itoa(id) != userID {
				return nil, danProtocol("Danbooru 用户 API 返回了不匹配的身份")
			}
			userID = strconv.Itoa(id)
		}
		if cursor != nil && cursor.Key != key {
			return nil, danBrowseInvalid("Danbooru 收藏身份已改变，请重新加载")
		}
		query = "ordfav:" + key
		source = DanbooruSource{Kind: opt.Kind, ID: userID, Name: key, URL: danBaseURL + "/posts?" + url.Values{"tags": {query}}.Encode()}
	}
	return a.danBrowsePosts(ctx, request, opt, cursor, key, query, source)
}

func (a *DanbooruAdapter) danBrowsePosts(ctx context.Context, request Request, opt DanbooruBrowseOptions, cursor *danBrowseCursor, key, query string, source DanbooruSource) (*DanbooruBrowsePage, error) {
	prefix := danPagePrefix(query)
	pageNumber, err := danBrowsePageNumber(cursor, prefix)
	if err != nil {
		return nil, err
	}
	params := url.Values{"tags": {query}, "limit": {strconv.Itoa(opt.Limit)}}
	if pageNumber != "" {
		params.Set("page", pageNumber)
	}
	outcome, err := a.APIJSON(ctx, danBaseURL+"/posts.json", params, request.Policy, request.ProxyMode, true)
	if err != nil {
		return nil, err
	}
	rows, ok := danRows(outcome.Value)
	if !ok || len(rows) > opt.Limit {
		return nil, danProtocol("Danbooru posts API 返回结构或数量无效")
	}
	if prefix == "a" && cursor != nil {
		slices.Reverse(rows)
	}
	page := &DanbooruBrowsePage{Items: []DanbooruPost{}, Source: source, Warnings: []string{}}
	boundary := 0
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		id, valid := danBrowsePositive(stringValue(row["id"]))
		if !ok || !valid {
			return nil, danProtocol("Danbooru posts API 缺少有效帖子 ID")
		}
		if prefix != "" && cursor != nil {
			previous, _ := danBrowsePositive(cursor.Page[1:])
			if (prefix == "a" && id <= previous) || (prefix == "b" && id >= previous) {
				return nil, danProtocol("Danbooru posts API 分页游标没有前进")
			}
		}
		if boundary == 0 || (prefix == "a" && id > boundary) || (prefix == "b" && id < boundary) {
			boundary = id
		}
		page.Items = append(page.Items, danBrowsePost(strconv.Itoa(id), row))
	}
	if len(rows) == opt.Limit {
		next := prefix + strconv.Itoa(boundary)
		if prefix == "" {
			n, _ := strconv.Atoi(pageNumber)
			next = strconv.Itoa(n + 1)
		}
		page.NextCursor = danBrowseEncode(danBrowseCursor{Version: 1, Kind: opt.Kind, Key: key, Limit: opt.Limit, Page: next})
	}
	if opt.Count && cursor == nil {
		countCtx, cancelCount := context.WithTimeout(ctx, 3*time.Second)
		count, countErr := a.APIJSON(countCtx, danBaseURL+"/counts/posts.json", url.Values{"tags": {query}}, request.Policy, request.ProxyMode, true)
		cancelCount()
		if countErr == nil {
			root, _ := count.Value.(map[string]any)
			counts, _ := root["counts"].(map[string]any)
			if n, err := strconv.Atoi(stringValue(counts["posts"])); err == nil && n >= 0 {
				page.Total = &n
			}
		}
		if page.Total == nil {
			page.Warnings = append(page.Warnings, "Danbooru 匹配数量暂不可用")
		}
	}
	return page, nil
}

func danBrowsePostIDs(value any) ([]string, bool) {
	var rawIDs []any
	switch ids := value.(type) {
	case []int:
		for _, id := range ids {
			rawIDs = append(rawIDs, id)
		}
	case []string:
		for _, id := range ids {
			rawIDs = append(rawIDs, id)
		}
	default:
		var ok bool
		rawIDs, ok = danRows(value)
		if !ok {
			return nil, false
		}
	}
	ids := make([]string, 0, len(rawIDs))
	for _, raw := range rawIDs {
		n, ok := danBrowsePositive(stringValue(raw))
		if !ok {
			return nil, false
		}
		ids = append(ids, strconv.Itoa(n))
	}
	return ids, true
}

func (a *DanbooruAdapter) danBrowseCollection(ctx context.Context, request Request, opt DanbooruBrowseOptions, cursor *danBrowseCursor, id string) (*DanbooruBrowsePage, error) {
	path := "/pools/"
	if opt.Kind == "favorite_group" {
		path = "/favorite_groups/"
	}
	target := danBaseURL + path + id
	outcome, err := a.APIJSON(ctx, target+".json", nil, request.Policy, request.ProxyMode, true)
	if err != nil {
		return nil, err
	}
	collection, ok := outcome.Value.(map[string]any)
	ids, validIDs := danBrowsePostIDs(collection["post_ids"])
	if !ok || !validIDs {
		return nil, danProtocol("Danbooru 集合 API 缺少有效 post_ids")
	}
	updatedAt := stringValue(collection["updated_at"])
	offset := 0
	if cursor != nil {
		if cursor.UpdatedAt != updatedAt {
			return nil, danBrowseInvalid("Danbooru 集合已变动，请重新加载后继续")
		}
		offset = cursor.Offset
		if offset >= len(ids) {
			return nil, danBrowseInvalid("Danbooru 集合分页位置无效，请重新加载")
		}
	}
	end := offset + min(opt.Limit, len(ids)-offset)
	selected := ids[offset:end]
	posts := map[string]DanbooruPost{}
	// Keep API batches modest while allowing the full collection across pages.
	for start := 0; start < len(selected); start += 50 {
		batch := selected[start:min(start+50, len(selected))]
		params := url.Values{"tags": {"id:" + strings.Join(batch, ",")}, "limit": {strconv.Itoa(len(batch))}}
		outcome, err := a.APIJSON(ctx, danBaseURL+"/posts.json", params, request.Policy, request.ProxyMode, true)
		if err != nil {
			return nil, err
		}
		rows, ok := danRows(outcome.Value)
		if !ok {
			return nil, danProtocol("Danbooru 集合帖子 API 返回结构无效")
		}
		for _, raw := range rows {
			row, ok := raw.(map[string]any)
			n, valid := danBrowsePositive(stringValue(row["id"]))
			if !ok || !valid {
				return nil, danProtocol("Danbooru 集合帖子 API 缺少有效帖子 ID")
			}
			postID := strconv.Itoa(n)
			posts[postID] = danBrowsePost(postID, row)
		}
	}
	total := len(ids)
	page := &DanbooruBrowsePage{Items: []DanbooruPost{}, Source: DanbooruSource{Kind: opt.Kind, ID: id, Name: stringValue(collection["name"]), URL: target}, Total: &total, Warnings: []string{}}
	for _, postID := range selected {
		post, found := posts[postID]
		if !found {
			post = danBrowsePost(postID, nil)
			post.UnavailableReason = "post_unavailable"
		}
		page.Items = append(page.Items, post)
	}
	if end < len(ids) {
		if updatedAt == "" {
			return nil, danProtocol("Danbooru 集合 API 缺少 updated_at，无法安全续页")
		}
		page.NextCursor = danBrowseEncode(danBrowseCursor{Version: 1, Kind: opt.Kind, Key: id, Limit: opt.Limit, Offset: end, UpdatedAt: updatedAt})
	}
	return page, nil
}

// Remote URLs are data for the restricted media endpoint, never auth carriers.
func danBrowseRemoteURL(value any) string {
	u, err := url.Parse(strings.TrimSpace(stringValue(value)))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.Opaque != "" {
		return ""
	}
	params, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return ""
	}
	for key := range params {
		switch strings.ToLower(key) {
		case "login", "api_key", "password", "authorization", "cookie", "access_token":
			return ""
		}
	}
	return u.String()
}

func danBrowseVariant(variants []any, target int) string {
	bestURL, bestSize := "", 0
	for _, raw := range variants {
		variant, ok := raw.(map[string]any)
		if !ok || stringValue(variant["type"]) == "original" {
			continue
		}
		u := danBrowseRemoteURL(variant["url"])
		if u == "" {
			continue
		}
		size, _ := integer(variant["width"])
		// Nominal variant types retain their useful size for portrait previews.
		kind := strings.Split(stringValue(variant["type"]), "x")[0]
		if n, ok := danBrowsePositive(kind); ok {
			size = n
		}
		if size <= 0 {
			continue
		}
		if bestURL == "" || (size >= target && (bestSize < target || size < bestSize)) || (size < target && bestSize < target && size > bestSize) {
			bestURL, bestSize = u, size
		}
	}
	return bestURL
}

func danBrowsePost(id string, row map[string]any) DanbooruPost {
	post := DanbooruPost{ID: id, URL: danBaseURL + "/posts/" + id, Title: "Post " + id, Tags: map[string][]string{}}
	for _, category := range []string{"general", "character", "artist", "copyright", "meta"} {
		post.Tags[category] = append([]string{}, strings.Fields(stringValue(row["tag_string_"+category]))...)
	}
	if copyrights := post.Tags["copyright"]; len(copyrights) > 0 {
		post.Title = strings.Join(copyrights, " / ")
	}
	post.Width, _ = integer(row["image_width"])
	post.Height, _ = integer(row["image_height"])
	post.Rating = stringValue(row["rating"])
	post.Score, _ = integer(row["score"])
	post.FileExt = stringValue(row["file_ext"])
	post.FileSize, _ = strconv.ParseInt(stringValue(row["file_size"]), 10, 64)
	post.SourceURL = danBrowseRemoteURL(row["source"])
	asset, _ := row["media_asset"].(map[string]any)
	variants, _ := danRows(asset["variants"])
	post.PreviewURL, post.SampleURL = danBrowseVariant(variants, 360), danBrowseVariant(variants, 720)
	if post.PreviewURL == "" {
		post.PreviewURL = danBrowseRemoteURL(row["preview_file_url"])
	}
	if post.SampleURL == "" {
		post.SampleURL = danBrowseRemoteURL(row["large_file_url"])
	}
	fileURL := danBrowseRemoteURL(row["file_url"])
	for _, raw := range variants {
		variant, _ := raw.(map[string]any)
		if fileURL == "" && stringValue(variant["type"]) == "original" {
			fileURL = danBrowseRemoteURL(variant["url"])
		}
	}
	post.Downloadable = fileURL != ""
	if !post.Downloadable {
		post.UnavailableReason = "missing_file_url"
	}
	return post
}
