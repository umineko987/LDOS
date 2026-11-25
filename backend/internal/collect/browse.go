package collect

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"ldos/backend/internal/crawls"
	"ldos/backend/internal/discovery"
	"ldos/backend/internal/discoverydata"
)

func (s *Service) Browse(ctx context.Context, datasetID string, req BrowseRequest) (BrowseResponse, error) {
	if err := s.deps.RequireDataset(ctx, datasetID); err != nil {
		return BrowseResponse{}, err
	}
	limit := req.Limit
	if limit == 0 {
		limit = DefaultPageLimit
	}
	if limit < 1 || limit > 100 {
		return BrowseResponse{}, problem(422, "invalid_collect_limit", "每页数量必须在 1 到 100 之间")
	}

	switch req.Source.Site {
	case "danbooru":
		return s.browseDanbooru(ctx, datasetID, req.Source, req.Cursor, limit)
	case "exhentai":
		return s.browseExhentai(ctx, req.Source, req.Cursor, limit)
	case "pawchive":
		return s.browsePawchive(ctx, req.Source, req.Cursor, limit)
	case "pixiv", "twitter":
		return s.browseTimelineOrWork(ctx, datasetID, req.Source, req.Cursor, limit)
	default:
		return BrowseResponse{}, problem(422, "invalid_collect_site", "不支持的图源站点")
	}
}

func (s *Service) browseDanbooru(ctx context.Context, datasetID string, src SourceSpec, cursor string, limit int) (BrowseResponse, error) {
	if s.deps.DanbooruReq == nil || s.deps.DanbooruBrowse == nil {
		return BrowseResponse{}, problem(503, "danbooru_unavailable", "Danbooru 服务尚未就绪")
	}
	request, err := s.deps.DanbooruReq(ctx)
	if err != nil {
		return BrowseResponse{}, err
	}
	kind := src.Kind
	if kind != "search" && kind != "pool" && kind != "favorite_group" && kind != "favorites" {
		return BrowseResponse{}, problem(422, "invalid_collect_source", "Danbooru 来源类型无效")
	}
	page, err := s.deps.DanbooruBrowse(ctx, request, discovery.DanbooruBrowseOptions{
		Kind:      kind,
		Query:     src.Query,
		Reference: src.Reference,
		Cursor:    cursor,
		Limit:     limit,
		Count:     cursor == "",
	})
	if err != nil {
		return BrowseResponse{}, err
	}

	local, members, err := s.danbooruLocalAssets(ctx, datasetID, page.Items)
	if err != nil {
		return BrowseResponse{}, err
	}
	sourceKeys, err := s.datasetSourceKeys(ctx, datasetID)
	if err != nil {
		return BrowseResponse{}, err
	}

	items := make([]BrowseItem, 0, len(page.Items))
	for _, post := range page.Items {
		item := BrowseItem{
			ID:                post.ID,
			Title:             post.Title,
			Author:            strings.Join(post.Tags["artist"], " · "),
			PreviewURL:        s.signMedia("danbooru", post.PreviewURL, nil),
			SampleURL:         s.signMedia("danbooru", post.SampleURL, nil),
			Width:             post.Width,
			Height:            post.Height,
			FileExt:           post.FileExt,
			FileSize:          post.FileSize,
			Rating:            post.Rating,
			Score:             post.Score,
			MediaCount:        1,
			URL:               post.URL,
			SourceURL:         post.SourceURL,
			Downloadable:      post.Downloadable,
			UnavailableReason: post.UnavailableReason,
			LocalState:        "none",
			Tags:              post.Tags,
		}
		if asset := local[post.ID]; asset != "" {
			assetCopy := asset
			item.LocalAssetID = &assetCopy
			if members[asset] {
				item.LocalState = "in_dataset"
			} else {
				item.LocalState = "in_library"
			}
		} else if key := crawls.SourceKeyFromURL(post.SourceURL); key != nil && sourceKeys[*key] {
			item.LocalState = "in_dataset"
		}
		items = append(items, item)
	}

	updated := src
	if page.Source.Name != "" {
		updated.Label = page.Source.Name
	}
	if page.Source.URL != "" {
		updated.URL = page.Source.URL
	}
	if page.Total != nil {
		updated.Total = page.Total
	}
	warnings := page.Warnings
	if warnings == nil {
		warnings = []string{}
	}
	return BrowseResponse{
		Source:     updated,
		Items:      items,
		NextCursor: page.NextCursor,
		Total:      page.Total,
		Warnings:   warnings,
	}, nil
}

func (s *Service) browseExhentai(ctx context.Context, src SourceSpec, cursor string, limit int) (BrowseResponse, error) {
	if s.deps.BrowseEHPages == nil {
		return BrowseResponse{}, problem(503, "exhentai_unavailable", "EH 浏览服务尚未就绪")
	}
	offset := 0
	if cursor != "" {
		n, err := strconv.Atoi(cursor)
		if err != nil || n < 0 || n >= MaxBrowseLimit {
			return BrowseResponse{}, problem(422, "invalid_collect_cursor", "EH 浏览游标无效")
		}
		offset = n
	}
	target := normalizeEHGalleryURL(src.URL)
	if target == "" {
		return BrowseResponse{}, problem(422, "invalid_collect_source", "请输入具体的 EH 画廊链接")
	}
	targetCount := min(MaxBrowseLimit, offset+limit)
	rows, total, err := s.deps.BrowseEHPages(ctx, target, targetCount)
	if err != nil {
		return BrowseResponse{}, err
	}
	if offset > len(rows) {
		offset = len(rows)
	}
	slice := rows[offset:min(len(rows), offset+limit)]
	items := make([]BrowseItem, 0, len(slice))
	for _, row := range slice {
		pageNum := toInt(row["page"])
		if pageNum < 1 {
			continue
		}
		id := strconv.Itoa(pageNum)
		title, _ := row["title"].(string)
		if title == "" {
			title = fmt.Sprintf("P%d", pageNum)
		}
		var crop *[4]int
		if sprite, ok := row["thumbnail_sprite"].(map[string]int); ok {
			crop = &[4]int{sprite["x"], sprite["y"], sprite["width"], sprite["height"]}
		}
		thumb, _ := row["thumbnail_url"].(string)
		preview := s.signMedia("exhentai", thumb, crop)
		pageCopy := pageNum
		items = append(items, BrowseItem{
			ID:           id,
			Title:        title,
			PreviewURL:   preview,
			MediaCount:   1,
			Page:         &pageCopy,
			URL:          target,
			Downloadable: true,
			LocalState:   "none",
		})
	}
	nextCursor := ""
	loadedEnd := offset + len(slice)
	if loadedEnd < total && loadedEnd < MaxBrowseLimit {
		nextCursor = strconv.Itoa(loadedEnd)
	}
	updated := src
	updated.URL = target
	var totalPtr *int
	if total > 0 {
		totalPtr = intPtr(total)
		updated.Total = totalPtr
	}
	return BrowseResponse{
		Source:     updated,
		Items:      items,
		NextCursor: nextCursor,
		Total:      totalPtr,
		Warnings:   []string{},
	}, nil
}

func (s *Service) browsePawchive(ctx context.Context, src SourceSpec, cursor string, limit int) (BrowseResponse, error) {
	if s.deps.Discover == nil {
		return BrowseResponse{}, problem(503, "pawchive_unavailable", "Pawchive 服务尚未就绪")
	}
	if src.Kind == "single_work" {
		if !pawPostPathRe.MatchString(urlPath(src.URL)) {
			return BrowseResponse{}, problem(422, "invalid_collect_source", "Pawchive 作品链接无效")
		}
		res, err := s.deps.Discover(ctx, "pawchive", src.URL, 1, "post")
		if err != nil {
			return BrowseResponse{}, err
		}
		items := s.projectPawchiveRows(mapSlice(res["candidates"]))
		return BrowseResponse{Source: src, Items: items, Warnings: []string{}}, nil
	}

	offset := 0
	if cursor != "" {
		n, err := strconv.Atoi(cursor)
		if err != nil || n < 0 || n >= MaxBrowseLimit {
			return BrowseResponse{}, problem(422, "invalid_collect_cursor", "Pawchive 浏览游标无效")
		}
		offset = n
	}
	pageSize := min(50, limit)
	if limit >= DefaultPageLimit {
		pageSize = 50
	}
	u, err := url.Parse(src.URL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return BrowseResponse{}, problem(422, "invalid_collect_source", "Pawchive 来源地址无效")
	}
	host := strings.ToLower(u.Hostname())
	if host != "pawchive.pw" && host != "www.pawchive.pw" && host != "pawchive.st" && host != "www.pawchive.st" {
		return BrowseResponse{}, problem(422, "invalid_collect_source", "Pawchive 来源地址无效")
	}
	q := u.Query()
	q.Set("o", strconv.Itoa(offset))
	u.Host = "pawchive.pw"
	u.Scheme = "https"
	u.RawQuery = q.Encode()

	res, err := s.deps.Discover(ctx, "pawchive", u.String(), pageSize+1, "post")
	if err != nil {
		return BrowseResponse{}, err
	}
	candidates := mapSlice(res["candidates"])
	hasMore := len(candidates) > pageSize
	if hasMore {
		candidates = candidates[:pageSize]
	}
	items := s.projectPawchiveRows(candidates)
	nextCursor := ""
	if hasMore && offset+len(items) < MaxBrowseLimit {
		nextCursor = strconv.Itoa(offset + len(items))
	}
	return BrowseResponse{
		Source:     src,
		Items:      items,
		NextCursor: nextCursor,
		Warnings:   []string{},
	}, nil
}

func (s *Service) projectPawchiveRows(rows []map[string]any) []BrowseItem {
	items := make([]BrowseItem, 0, len(rows))
	for _, row := range rows {
		id, _ := row["id"].(string)
		if id == "" {
			continue
		}
		title, _ := row["title"].(string)
		if title == "" {
			title = "Post " + id
		}
		author := ""
		if a, ok := row["author"].(map[string]any); ok {
			author, _ = a["name"].(string)
		}
		workURL, _ := row["download_url"].(string)
		if workURL == "" {
			workURL, _ = row["url"].(string)
		}
		thumb, _ := row["thumbnail_url"].(string)
		count := max(1, toInt(row["media_count"]))
		items = append(items, BrowseItem{
			ID:           id,
			Title:        title,
			Author:       author,
			PreviewURL:   s.signMedia("pawchive", thumb, nil),
			MediaCount:   count,
			URL:          workURL,
			Downloadable: workURL != "",
			LocalState:   "none",
		})
	}
	return items
}

func (s *Service) browseTimelineOrWork(ctx context.Context, datasetID string, src SourceSpec, cursor string, limit int) (BrowseResponse, error) {
	sourceKeys, err := s.datasetSourceKeys(ctx, datasetID)
	if err != nil {
		return BrowseResponse{}, err
	}

	if src.Kind == "single_work" {
		if s.deps.Discover == nil {
			return BrowseResponse{}, problem(503, "discovery_unavailable", "作品浏览服务尚未就绪")
		}
		canonical, err := discoverydata.CanonicalWorkAddress(src.Site, src.URL)
		if err != nil {
			return BrowseResponse{}, problem(422, "invalid_collect_source", err.Error())
		}
		res, err := s.deps.Discover(ctx, src.Site, canonical, 1, "post")
		if err != nil {
			return BrowseResponse{}, err
		}
		rows := mapSlice(res["candidates"])
		items := make([]BrowseItem, 0, len(rows))
		for _, row := range rows {
			items = append(items, s.projectTimelineRow(src.Site, row, sourceKeys))
		}
		return BrowseResponse{Source: src, Items: items, Warnings: []string{}}, nil
	}

	if s.deps.BrowseTimeline == nil {
		return BrowseResponse{}, problem(503, "timeline_unavailable", "时间线浏览服务尚未就绪")
	}
	depth := max(DefaultPageLimit, limit)
	offset := 0
	if cursor != "" {
		// Cursor encodes "offset:depth" where depth is the requested prefix size.
		oStr, dStr, ok := strings.Cut(cursor, ":")
		o, errO := strconv.Atoi(oStr)
		d, errD := strconv.Atoi(dStr)
		if !ok || errO != nil || errD != nil || o < 0 || d < 1 || d > MaxBrowseLimit {
			return BrowseResponse{}, problem(422, "invalid_collect_cursor", "时间线游标无效")
		}
		offset = o
		depth = min(MaxBrowseLimit, max(d, offset+limit))
	}
	rows, hasMore, err := s.deps.BrowseTimeline(ctx, src.Site, src.URL, depth)
	if err != nil {
		return BrowseResponse{}, err
	}
	if offset > len(rows) {
		offset = len(rows)
	}
	slice := rows[offset:]
	items := make([]BrowseItem, 0, len(slice))
	for _, row := range slice {
		items = append(items, s.projectTimelineRow(src.Site, row, sourceKeys))
	}
	nextCursor := ""
	nextOffset := offset + len(slice)
	if hasMore && nextOffset < MaxBrowseLimit {
		nextDepth := min(MaxBrowseLimit, max(depth*2, nextOffset+limit))
		nextCursor = fmt.Sprintf("%d:%d", nextOffset, nextDepth)
	}
	return BrowseResponse{
		Source:     src,
		Items:      items,
		NextCursor: nextCursor,
		Warnings:   []string{},
	}, nil
}

func (s *Service) projectTimelineRow(site string, row map[string]any, sourceKeys map[string]bool) BrowseItem {
	id, _ := row["id"].(string)
	title, _ := row["title"].(string)
	if title == "" {
		title = id
	}
	author := ""
	switch a := row["author"].(type) {
	case string:
		author = a
	case map[string]any:
		author, _ = a["display_name"].(string)
		if author == "" {
			author, _ = a["name"].(string)
		}
	}
	workURL, _ := row["download_url"].(string)
	if workURL == "" {
		workURL, _ = row["url"].(string)
	}
	thumb, _ := row["thumbnail_url"].(string)
	count := max(1, toInt(row["media_count"]))
	localState := "none"
	if key := crawls.CandidateSourceKey(site, id, workURL); key != nil && sourceKeys[*key] {
		localState = "in_dataset"
	}
	return BrowseItem{
		ID:           id,
		Title:        title,
		Author:       author,
		PreviewURL:   s.signMedia(site, thumb, nil),
		MediaCount:   count,
		URL:          workURL,
		Downloadable: workURL != "",
		LocalState:   localState,
	}
}

func (s *Service) danbooruLocalAssets(ctx context.Context, datasetID string, posts []discovery.DanbooruPost) (map[string]string, map[string]bool, error) {
	local, members := map[string]string{}, map[string]bool{}
	if s.deps.MemberRows != nil {
		rows, err := s.deps.MemberRows(ctx, datasetID)
		if err != nil {
			return nil, nil, err
		}
		for _, row := range rows {
			members[fmt.Sprint(row["asset_id"])] = true
		}
	}
	if len(posts) == 0 || s.deps.Store == nil {
		return local, members, nil
	}
	args := make([]any, len(posts))
	for i, post := range posts {
		args[i] = post.ID
	}
	query := `SELECT i.post_id,a.id
		FROM danbooru_import_items i
		JOIN gallery_sources s ON s.batch_id=i.batch_id
		JOIN gallery_assets a ON a.source_id=s.id AND a.name=i.file_name
		WHERE i.post_id IN (` + strings.TrimRight(strings.Repeat("?,", len(posts)), ",") + `)
		AND a.lifecycle_state='active' AND a.dedup_visibility!='excluded' AND s.availability='available'
		ORDER BY a.id`
	found, err := s.deps.Store.QueryRows(ctx, query, args...)
	if err != nil {
		return nil, nil, err
	}
	for _, row := range found {
		postID, assetID := fmt.Sprint(row["post_id"]), fmt.Sprint(row["id"])
		if local[postID] == "" || members[assetID] {
			local[postID] = assetID
		}
	}
	return local, members, nil
}

func (s *Service) datasetSourceKeys(ctx context.Context, datasetID string) (map[string]bool, error) {
	keys := map[string]bool{}
	if s.deps.Store == nil {
		return keys, nil
	}
	rows, err := s.deps.Store.QueryRows(ctx, `SELECT DISTINCT ctsk.source_key
		FROM dataset_crawls dc
		JOIN gallery_sources gs ON gs.batch_id=dc.batch_id AND gs.availability='available'
		JOIN dataset_roots dr ON dr.dataset_id=dc.dataset_id AND dr.source_id=gs.id
		JOIN crawl_addresses ca ON ca.batch_id=dc.batch_id
		JOIN crawl_address_tasks cat ON cat.address_id=ca.id
		JOIN tasks t ON t.id=cat.task_id AND t.status='succeeded' AND t.artifact_count>0
		JOIN crawl_task_source_keys ctsk ON ctsk.task_id=t.id
		WHERE dc.dataset_id=?`, datasetID)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		if k, _ := r["source_key"].(string); k != "" {
			keys[k] = true
		}
	}
	return keys, nil
}

func normalizeEHGalleryURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawPath != "" {
		return ""
	}
	host := strings.ToLower(u.Host)
	if (host == "e-hentai.org" || host == "exhentai.org") && ehGalleryPathRe.MatchString(u.Path) {
		return "https://" + host + strings.TrimSuffix(u.Path, "/") + "/"
	}
	return ""
}

func urlPath(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return u.Path
}
