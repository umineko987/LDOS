package collect

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"ldos/backend/internal/crawls"
	"ldos/backend/internal/discovery"
	"ldos/backend/internal/discoverydata"
)

type submitPlan struct {
	BatchKey      string                   `json:"batch_key"`
	CrawlBody     json.RawMessage          `json:"crawl_body,omitempty"`
	ReuseAssetIDs []string                 `json:"reuse_asset_ids,omitempty"`
	DanbooruPosts []discovery.DanbooruPost `json:"danbooru_posts,omitempty"`
	QueuedSources int                      `json:"queued_sources"`
	QueuedCount   int                      `json:"queued_count"`
	SkippedCount  int                      `json:"skipped_count"`
}

var sitePriority = map[string]int{
	"danbooru": 0,
	"pixiv":    1,
	"twitter":  2,
	"exhentai": 3,
	"pawchive": 4,
}

func (s *Service) Submit(ctx context.Context, datasetID string, req SubmitRequest, key string) (*SubmitResponse, error) {
	if len(req.Sources) < 1 || len(req.Sources) > 50 {
		return nil, problem(422, "invalid_collect_submit", "请选择 1 到 50 个采集图源")
	}
	key = strings.TrimSpace(key)
	if len(key) < 1 || len(key) > 200 {
		return nil, problem(422, "invalid_idempotency_key", "请提供有效的 Idempotency-Key")
	}
	if err := s.deps.RequireDataset(ctx, datasetID); err != nil {
		return nil, err
	}

	s.submitMu.Lock()
	defer s.submitMu.Unlock()

	dbKey := "collect_v2:" + key
	encodedReq, _ := json.Marshal(req)
	saved, err := s.deps.Store.QueryRow(ctx, `SELECT tokens_json,plan_json,result_json FROM danbooru_collect_requests WHERE dataset_id=? AND request_key=?`, datasetID, dbKey)
	if err != nil {
		return nil, err
	}

	var plan submitPlan
	if saved != nil {
		if saved["tokens_json"] != string(encodedReq) {
			return nil, problem(409, "idempotency_conflict", "此请求标识已用于其他采集范围")
		}
		if raw, _ := saved["result_json"].(string); raw != "" {
			var result SubmitResponse
			if err := json.Unmarshal([]byte(raw), &result); err != nil {
				return nil, err
			}
			return &result, nil
		}
		if err := json.Unmarshal([]byte(fmt.Sprint(saved["plan_json"])), &plan); err != nil {
			return nil, err
		}
	} else {
		plan, err = s.compilePlan(ctx, datasetID, req)
		if err != nil {
			return nil, err
		}
		encodedPlan, _ := json.Marshal(plan)
		err = s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
			_, e := tx.ExecContext(ctx, `INSERT INTO danbooru_collect_requests(dataset_id,request_key,tokens_json,plan_json,result_json) VALUES(?,?,?,?,'')`, datasetID, dbKey, string(encodedReq), string(encodedPlan))
			return e
		})
		if err != nil {
			return nil, err
		}
	}

	result := &SubmitResponse{
		QueuedSources: plan.QueuedSources,
		QueuedCount:   plan.QueuedCount,
		ReusedCount:   len(plan.ReuseAssetIDs),
		SkippedCount:  plan.SkippedCount,
	}

	if len(plan.ReuseAssetIDs) > 0 && s.deps.AttachAssets != nil {
		for start := 0; start < len(plan.ReuseAssetIDs); start += 1000 {
			chunk := plan.ReuseAssetIDs[start:min(start+1000, len(plan.ReuseAssetIDs))]
			if _, err := s.deps.AttachAssets(ctx, datasetID, chunk); err != nil {
				return nil, err
			}
		}
	}

	if len(plan.CrawlBody) > 0 {
		batchID, err := s.deps.StartCrawl(ctx, datasetID, plan.CrawlBody, "collect:"+plan.BatchKey)
		if err != nil {
			return nil, err
		}
		result.BatchID = &batchID
		if len(plan.DanbooruPosts) > 0 {
			err = s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
				for i, post := range plan.DanbooruPosts {
					fileName := fmt.Sprintf("ldos-danbooru-%04d-%s.%s", i+1, post.ID, post.FileExt)
					if _, e := tx.ExecContext(ctx, `INSERT INTO danbooru_import_items(batch_id,post_id,file_name) VALUES(?,?,?) ON CONFLICT(batch_id,post_id) DO NOTHING`, batchID, post.ID, fileName); e != nil {
						return e
					}
				}
				return nil
			})
			if err != nil {
				return nil, err
			}
		}
	}

	encodedResult, _ := json.Marshal(result)
	err = s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		_, e := tx.ExecContext(ctx, `UPDATE danbooru_collect_requests SET result_json=? WHERE dataset_id=? AND request_key=?`, string(encodedResult), datasetID, dbKey)
		return e
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) compilePlan(ctx context.Context, datasetID string, req SubmitRequest) (submitPlan, error) {
	ordered := slices.Clone(req.Sources)
	slices.SortStableFunc(ordered, func(a, b SubmitSource) int {
		pa, okA := sitePriority[a.Source.Site]
		pb, okB := sitePriority[b.Source.Site]
		if !okA {
			pa = 99
		}
		if !okB {
			pb = 99
		}
		return pa - pb
	})

	datasetKeys, err := s.datasetSourceKeys(ctx, datasetID)
	if err != nil {
		return submitPlan{}, err
	}

	plan := submitPlan{BatchKey: uuid.NewString()}
	plannedSourceKeys := map[string]bool{}
	seenReuse := map[string]bool{}
	addrsBySite := map[string][]crawls.Address{}
	siteOrder := []string{}
	danPostIndex := 0
	danbooruPostSeen := map[string]bool{}
	estimatedTasks := 0

	appendAddr := func(site string, addr crawls.Address, est int) error {
		if len(addrsBySite[site]) >= MaxSubmitItems {
			return problem(422, "invalid_collect_submit", fmt.Sprintf("%s 单次提交地址不能超过 %d 条", site, MaxSubmitItems))
		}
		if addr.ExtraArgs == nil {
			addr.ExtraArgs = []string{}
		}
		if _, exists := addrsBySite[site]; !exists {
			siteOrder = append(siteOrder, site)
		}
		addrsBySite[site] = append(addrsBySite[site], addr)
		estimatedTasks += max(1, est)
		return nil
	}

	for _, entry := range ordered {
		src := entry.Source
		rng := entry.Range
		switch src.Site {
		case "danbooru":
			if err := s.compileDanbooruSource(ctx, datasetID, src, rng, datasetKeys, &plan, &danPostIndex, danbooruPostSeen, seenReuse, plannedSourceKeys, appendAddr); err != nil {
				return submitPlan{}, err
			}
		case "pixiv", "twitter", "pawchive":
			if err := s.compileTimelineSource(src, rng, datasetKeys, plannedSourceKeys, &plan, appendAddr); err != nil {
				return submitPlan{}, err
			}
		case "exhentai":
			if err := s.compileEHSource(ctx, src, rng, &plan, appendAddr); err != nil {
				return submitPlan{}, err
			}
		default:
			return submitPlan{}, problem(422, "invalid_collect_site", "不支持的图源站点: "+src.Site)
		}
	}

	if len(siteOrder) > 0 {
		sources := make([]map[string]any, 0, len(siteOrder))
		for _, site := range siteOrder {
			sources = append(sources, map[string]any{
				"site":      site,
				"addresses": addrsBySite[site],
			})
			plan.QueuedSources += len(addrsBySite[site])
		}
		body := map[string]any{
			"sources":     sources,
			"concurrency": 20,
			"max_tasks":   max(10000, estimatedTasks*2),
		}
		raw, err := json.Marshal(body)
		if err != nil {
			return submitPlan{}, err
		}
		plan.CrawlBody = raw
	}
	return plan, nil
}

func (s *Service) compileDanbooruSource(
	ctx context.Context,
	datasetID string,
	src SourceSpec,
	rng SubmitRange,
	datasetKeys map[string]bool,
	plan *submitPlan,
	danPostIndex *int,
	danPostSeen map[string]bool,
	seenReuse map[string]bool,
	plannedSourceKeys map[string]bool,
	appendAddr func(string, crawls.Address, int) error,
) error {
	useExplicitPosts := rng.Mode == "explicit" ||
		src.Kind == "pool" || src.Kind == "favorite_group" ||
		(rng.Mode == "top_n" && rng.TopN > 0 && rng.TopN <= 200)

	var posts []discovery.DanbooruPost
	if useExplicitPosts {
		var err error
		posts, err = s.resolveDanbooruTargetPosts(ctx, src, rng)
		if err != nil {
			return err
		}
	} else {
		// Large search or favorites top_n (>200) / all: compile as source-level address + any extra items.
		targetURL, err := danbooruSourceURL(src)
		if err != nil {
			return err
		}
		var itemLimit *int
		if rng.Mode == "top_n" {
			if rng.TopN < 1 || rng.TopN > 10000 {
				return problem(422, "invalid_collect_range", "top_n 范围无效")
			}
			n := rng.TopN
			itemLimit = &n
		} else if rng.Mode != "all" {
			return problem(422, "invalid_collect_range", "不支持的范围模式: "+rng.Mode)
		}
		excluded := cleanExcludedIDs(rng.ExcludedIDs)
		label := src.Label
		kind := src.Kind
		est := 100
		if itemLimit != nil {
			est = *itemLimit
		}
		if err := appendAddr("danbooru", crawls.Address{
			URL: targetURL, Label: &label, AddressType: &kind, ItemLimit: itemLimit, ExcludedIDs: excluded,
		}, est); err != nil {
			return err
		}
		plan.QueuedCount += est
		if len(rng.Items) > 0 {
			extra, err := s.fetchDanbooruPostsByIDs(ctx, submitItemIDs(rng.Items))
			if err != nil {
				return err
			}
			posts = extra
		}
	}

	if len(posts) == 0 {
		return nil
	}
	local, members, err := s.danbooruLocalAssets(ctx, datasetID, posts)
	if err != nil {
		return err
	}

	toDownload := make([]discovery.DanbooruPost, 0, len(posts))
	for _, post := range posts {
		if danPostSeen[post.ID] {
			continue
		}
		danPostSeen[post.ID] = true
		if asset := local[post.ID]; asset != "" {
			if members[asset] {
				plan.SkippedCount++
			} else if !seenReuse[asset] {
				seenReuse[asset] = true
				plan.ReuseAssetIDs = append(plan.ReuseAssetIDs, asset)
			}
			continue
		}
		if key := crawls.SourceKeyFromURL(post.SourceURL); key != nil && datasetKeys[*key] {
			plan.SkippedCount++
			continue
		}
		if !post.Downloadable || !safeFileExt(post.FileExt) {
			plan.SkippedCount++
			continue
		}
		toDownload = append(toDownload, post)
	}

	if len(toDownload) == 0 {
		return nil
	}
	fresh, skipped, err := s.recheckDanbooruPosts(ctx, toDownload)
	if err != nil {
		return err
	}
	plan.SkippedCount += skipped

	for _, post := range fresh {
		*danPostIndex++
		label := post.Title
		kind := "work"
		addr := crawls.Address{
			URL:         post.URL,
			Label:       &label,
			AddressType: &kind,
			ExtraArgs:   []string{"--filename", fmt.Sprintf("ldos-danbooru-%04d-%s.{extension}", *danPostIndex, post.ID)},
		}
		if err := appendAddr("danbooru", addr, 1); err != nil {
			return err
		}
		plan.DanbooruPosts = append(plan.DanbooruPosts, post)
		plan.QueuedCount++
		if key := crawls.SourceKeyFromURL(post.SourceURL); key != nil {
			plannedSourceKeys[*key] = true
		}
	}
	return nil
}

func (s *Service) resolveDanbooruTargetPosts(ctx context.Context, src SourceSpec, rng SubmitRange) ([]discovery.DanbooruPost, error) {
	if s.deps.DanbooruReq == nil || s.deps.DanbooruBrowse == nil {
		return nil, problem(503, "danbooru_unavailable", "Danbooru 服务尚未就绪")
	}
	excluded := toStringSet(rng.ExcludedIDs)
	collected := []discovery.DanbooruPost{}
	seen := map[string]bool{}
	appendUniquePost := func(p discovery.DanbooruPost) {
		if !seen[p.ID] {
			seen[p.ID] = true
			collected = append(collected, p)
		}
	}

	switch rng.Mode {
	case "explicit":
		ids := submitItemIDs(rng.Items)
		if len(ids) == 0 {
			return nil, nil
		}
		posts, err := s.fetchDanbooruPostsByIDs(ctx, ids)
		if err != nil {
			return nil, err
		}
		for _, p := range posts {
			appendUniquePost(p)
		}
		return collected, nil

	case "top_n", "all":
		target := MaxSubmitItems
		if rng.Mode == "top_n" {
			if rng.TopN < 1 || rng.TopN > MaxSubmitItems {
				return nil, problem(422, "invalid_collect_range", "Danbooru top_n 范围无效")
			}
			target = rng.TopN
		}
		request, err := s.deps.DanbooruReq(ctx)
		if err != nil {
			return nil, err
		}
		cursor := ""
		for len(collected) < target {
			limit := min(100, target-len(collected))
			if src.Kind == "pool" || src.Kind == "favorite_group" {
				limit = min(100, target)
			}
			page, err := s.deps.DanbooruBrowse(ctx, request, discovery.DanbooruBrowseOptions{
				Kind:      src.Kind,
				Query:     src.Query,
				Reference: src.Reference,
				Cursor:    cursor,
				Limit:     limit,
			})
			if err != nil {
				return nil, err
			}
			for _, p := range page.Items {
				if len(collected) >= target {
					break
				}
				appendUniquePost(p)
			}
			if page.NextCursor == "" || len(page.Items) == 0 {
				break
			}
			cursor = page.NextCursor
		}
		filtered := make([]discovery.DanbooruPost, 0, len(collected))
		for _, p := range collected {
			if excluded[p.ID] {
				continue
			}
			filtered = append(filtered, p)
		}
		if len(rng.Items) > 0 {
			extra, err := s.fetchDanbooruPostsByIDs(ctx, submitItemIDs(rng.Items))
			if err != nil {
				return nil, err
			}
			seenFiltered := map[string]bool{}
			for _, p := range filtered {
				seenFiltered[p.ID] = true
			}
			for _, p := range extra {
				if !seenFiltered[p.ID] {
					seenFiltered[p.ID] = true
					filtered = append(filtered, p)
				}
			}
		}
		return filtered, nil
	default:
		return nil, problem(422, "invalid_collect_range", "Danbooru 不支持范围模式: "+rng.Mode)
	}
}

func (s *Service) fetchDanbooruPostsByIDs(ctx context.Context, ids []string) ([]discovery.DanbooruPost, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	request, err := s.deps.DanbooruReq(ctx)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]discovery.DanbooruPost, len(ids))
	for start := 0; start < len(ids); start += 100 {
		chunk := ids[start:min(start+100, len(ids))]
		page, err := s.deps.DanbooruBrowse(ctx, request, discovery.DanbooruBrowseOptions{
			Kind:  "search",
			Query: "id:" + strings.Join(chunk, ","),
			Limit: len(chunk),
		})
		if err != nil {
			return nil, err
		}
		for _, p := range page.Items {
			byID[p.ID] = p
		}
	}
	out := make([]discovery.DanbooruPost, 0, len(ids))
	for _, id := range ids {
		if p, ok := byID[id]; ok {
			out = append(out, p)
		}
	}
	return out, nil
}

// recheckDanbooruPosts validates downloadability right before enqueueing,
// gracefully skipping individual unavailable posts instead of aborting the whole batch.
func (s *Service) recheckDanbooruPosts(ctx context.Context, posts []discovery.DanbooruPost) ([]discovery.DanbooruPost, int, error) {
	request, err := s.deps.DanbooruReq(ctx)
	if err != nil {
		return nil, 0, err
	}
	valid := make([]discovery.DanbooruPost, 0, len(posts))
	skipped := 0
	for start := 0; start < len(posts); start += 100 {
		chunk := posts[start:min(start+100, len(posts))]
		ids := make([]string, len(chunk))
		for i, p := range chunk {
			ids[i] = p.ID
		}
		page, err := s.deps.DanbooruBrowse(ctx, request, discovery.DanbooruBrowseOptions{
			Kind:  "search",
			Query: "id:" + strings.Join(ids, ","),
			Limit: len(ids),
		})
		if err != nil {
			return nil, 0, err
		}
		byID := make(map[string]discovery.DanbooruPost, len(page.Items))
		for _, p := range page.Items {
			byID[p.ID] = p
		}
		for _, orig := range chunk {
			fresh, ok := byID[orig.ID]
			if !ok || !fresh.Downloadable || !safeFileExt(fresh.FileExt) {
				skipped++
				continue
			}
			valid = append(valid, fresh)
		}
	}
	return valid, skipped, nil
}

func (s *Service) compileTimelineSource(
	src SourceSpec,
	rng SubmitRange,
	datasetKeys map[string]bool,
	plannedSourceKeys map[string]bool,
	plan *submitPlan,
	appendAddr func(string, crawls.Address, int) error,
) error {
	if src.Kind == "single_work" || rng.Mode == "explicit" {
		items := rng.Items
		if src.Kind == "single_work" && len(items) == 0 {
			items = []SubmitItem{{ID: src.WorkID, URL: src.URL, Title: src.Label, MediaCount: 1}}
		}
		seen := map[string]bool{}
		for _, item := range items {
			target, err := canonicalWorkTarget(src.Site, item.URL)
			if err != nil {
				return err
			}
			if seen[target] {
				continue
			}
			seen[target] = true
			if key := crawls.CandidateSourceKey(src.Site, item.ID, target); key != nil {
				if datasetKeys[*key] || plannedSourceKeys[*key] {
					plan.SkippedCount++
					continue
				}
			}
			label := item.Title
			if label == "" {
				label = src.Label
			}
			var addrType *string
			if src.Site == "pixiv" || src.Site == "twitter" {
				t := "workbench_work"
				addrType = &t
			}
			est := max(1, item.MediaCount)
			if err := appendAddr(src.Site, crawls.Address{
				URL: target, Label: &label, AddressType: addrType,
			}, est); err != nil {
				return err
			}
			plan.QueuedCount++
		}
		return nil
	}

	target, err := canonicalSourceTarget(src.Site, src.URL)
	if err != nil {
		return err
	}
	var itemLimit *int
	switch rng.Mode {
	case "top_n":
		if rng.TopN < 1 || rng.TopN > 10000 {
			return problem(422, "invalid_collect_range", "top_n 范围无效")
		}
		n := rng.TopN
		itemLimit = &n
	case "all":
	default:
		return problem(422, "invalid_collect_range", "不支持的范围模式: "+rng.Mode)
	}
	excluded := cleanExcludedIDs(rng.ExcludedIDs)
	label := src.Label
	kind := src.Kind
	est := 100
	if itemLimit != nil {
		est = *itemLimit
	}
	if err := appendAddr(src.Site, crawls.Address{
		URL: target, Label: &label, AddressType: &kind, ItemLimit: itemLimit, ExcludedIDs: excluded,
	}, est); err != nil {
		return err
	}
	plan.QueuedCount += est

	// Any extra items explicitly included outside the base range are added as individual works.
	for _, item := range rng.Items {
		workURL, err := canonicalWorkTarget(src.Site, item.URL)
		if err != nil {
			return err
		}
		if key := crawls.CandidateSourceKey(src.Site, item.ID, workURL); key != nil {
			if datasetKeys[*key] || plannedSourceKeys[*key] {
				plan.SkippedCount++
				continue
			}
		}
		itemLabel := item.Title
		var addrType *string
		if src.Site == "pixiv" || src.Site == "twitter" {
			t := "workbench_work"
			addrType = &t
		}
		if err := appendAddr(src.Site, crawls.Address{
			URL: workURL, Label: &itemLabel, AddressType: addrType,
		}, max(1, item.MediaCount)); err != nil {
			return err
		}
		plan.QueuedCount++
	}
	return nil
}

func (s *Service) compileEHSource(
	ctx context.Context,
	src SourceSpec,
	rng SubmitRange,
	plan *submitPlan,
	appendAddr func(string, crawls.Address, int) error,
) error {
	target := normalizeEHGalleryURL(src.URL)
	if target == "" {
		return problem(422, "invalid_collect_source", "请输入具体的 EH 画廊链接")
	}
	label := src.Label
	kind := "eh_gallery"
	excluded := map[int]bool{}
	for _, p := range rng.ExcludedPages {
		if p > 0 {
			excluded[p] = true
		}
	}
	for _, raw := range rng.ExcludedIDs {
		if n, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && n > 0 {
			excluded[n] = true
		}
	}

	var pages []int
	switch rng.Mode {
	case "all":
		if len(excluded) == 0 {
			if err := appendAddr("exhentai", crawls.Address{URL: target, Label: &label, AddressType: &kind}, 50); err != nil {
				return err
			}
			plan.QueuedCount += 50
			return nil
		}
		total := 0
		if src.Total != nil && *src.Total > 0 {
			total = *src.Total
		} else if s.deps.BrowseEHPages != nil {
			_, fetchedTotal, err := s.deps.BrowseEHPages(ctx, target, 1)
			if err != nil {
				return err
			}
			total = fetchedTotal
		}
		if total < 1 {
			return problem(422, "invalid_collect_range", "无法确定 EH 画廊总页数")
		}
		for p := 1; p <= total; p++ {
			if !excluded[p] {
				pages = append(pages, p)
			}
		}
	case "pages":
		if rng.PageStart < 1 || rng.PageEnd < rng.PageStart || rng.PageEnd > 20000 {
			return problem(422, "invalid_collect_range", "EH 页码范围无效")
		}
		for p := rng.PageStart; p <= rng.PageEnd; p++ {
			if !excluded[p] {
				pages = append(pages, p)
			}
		}
	case "explicit":
	default:
		return problem(422, "invalid_collect_range", "EH 不支持范围模式: "+rng.Mode)
	}

	pageSet := map[int]bool{}
	for _, p := range pages {
		pageSet[p] = true
	}
	for _, p := range rng.ExtraPages {
		if p > 0 {
			pageSet[p] = true
		}
	}
	for _, item := range rng.Items {
		if item.Page != nil && *item.Page > 0 {
			pageSet[*item.Page] = true
		} else if n, err := strconv.Atoi(strings.TrimSpace(item.ID)); err == nil && n > 0 {
			pageSet[n] = true
		}
	}
	if len(pageSet) == 0 {
		return nil
	}
	finalPages := make([]int, 0, len(pageSet))
	for p := range pageSet {
		finalPages = append(finalPages, p)
	}
	slices.Sort(finalPages)
	if err := appendAddr("exhentai", crawls.Address{
		URL: target, Label: &label, AddressType: &kind, EHPages: finalPages,
	}, len(finalPages)); err != nil {
		return err
	}
	plan.QueuedCount += len(finalPages)
	return nil
}

func danbooruSourceURL(src SourceSpec) (string, error) {
	switch src.Kind {
	case "search":
		return "https://danbooru.donmai.us/posts?tags=" + url.QueryEscape(strings.TrimSpace(src.Query)), nil
	case "favorites":
		ref := strings.TrimSpace(src.Reference)
		if ref == "" {
			return "", problem(422, "invalid_collect_range", "未指定用户名的个人收藏仅支持按已选/前 200 项提交")
		}
		if strings.Contains(ref, "://") {
			return ref, nil
		}
		return "https://danbooru.donmai.us/posts?tags=" + url.QueryEscape("ordfav:"+ref), nil
	default:
		return "", problem(422, "invalid_collect_source", "Danbooru 来源地址无效")
	}
}

func canonicalSourceTarget(site, raw string) (string, error) {
	if site == "pawchive" {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
			return "", problem(422, "invalid_collect_source", "Pawchive 地址无效")
		}
		host := strings.ToLower(u.Hostname())
		if host != "pawchive.pw" && host != "www.pawchive.pw" && host != "pawchive.st" && host != "www.pawchive.st" {
			return "", problem(422, "invalid_collect_source", "Pawchive 地址无效")
		}
		return discoverydata.CanonicalAddress("pawchive", raw)
	}
	canonical, err := discoverydata.CanonicalTimelineAddress(site, raw)
	if err != nil {
		return "", problem(422, "invalid_collect_source", err.Error())
	}
	return canonical, nil
}

func canonicalWorkTarget(site, raw string) (string, error) {
	if site == "pawchive" {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || !pawPostPathRe.MatchString(u.Path) {
			return "", problem(422, "invalid_collect_work", "Pawchive 作品地址无效")
		}
		return "https://pawchive.pw" + strings.TrimSuffix(u.Path, "/"), nil
	}
	canonical, err := discoverydata.CanonicalWorkAddress(site, raw)
	if err != nil {
		return "", problem(422, "invalid_collect_work", err.Error())
	}
	return canonical, nil
}

func submitItemIDs(items []SubmitItem) []string {
	out := make([]string, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		id := strings.TrimSpace(item.ID)
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func cleanExcludedIDs(ids []string) []string {
	out := make([]string, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func toStringSet(ids []string) map[string]bool {
	set := make(map[string]bool, len(ids))
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" {
			set[id] = true
		}
	}
	return set
}

func safeFileExt(ext string) bool {
	if len(ext) < 1 || len(ext) > 10 {
		return false
	}
	for _, c := range ext {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') {
			return false
		}
	}
	return true
}
