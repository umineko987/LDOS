package workbench

import (
	"context"
	"encoding/json"
	"image"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/redaction"
)

const (
	maxTimelineBrowse = 1000
	maxEHBrowse       = 500
	maxSelection      = 500
	snapshotTTL       = 30 * time.Minute
	maxSnapshots      = 128
	maxCollections    = 16
)

type Dependencies struct {
	RequireDataset func(context.Context, string) error
	BrowseTimeline func(context.Context, string, string, int) ([]map[string]any, bool, error)
	BrowseEHPages  func(context.Context, string, int) ([]map[string]any, int, error)
	StartCrawl     func(context.Context, string, json.RawMessage, string) (string, error)
	FetchPreview   func(context.Context, string, string) ([]byte, error)
}

type Service struct {
	deps         Dependencies
	now          func() time.Time
	mu           sync.Mutex
	snapshots    map[string]*snapshot
	previewSlots chan struct{}
}

func New(deps Dependencies) *Service {
	return &Service{deps: deps, now: time.Now, snapshots: make(map[string]*snapshot), previewSlots: make(chan struct{}, 4)}
}

type BrowseRequest struct {
	Site  string `json:"site"`
	URL   string `json:"url"`
	Limit int    `json:"limit"`
}

type Item struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Author     string `json:"author"`
	PreviewURL string `json:"preview_url"`
	MediaCount int    `json:"media_count"`
	Page       int    `json:"page,omitempty"`
}

type BrowseResult struct {
	SnapshotID string `json:"snapshot_id"`
	Items      []Item `json:"items"`
	HasMore    bool   `json:"has_more"`
	Total      *int   `json:"total,omitempty"`
}

type entry struct {
	target  string
	preview string
	crop    image.Rectangle
	page    int
}

type snapshot struct {
	dataset     string
	site        string
	expires     time.Time
	entries     map[string]entry
	collections map[string]*collection
}

type collection struct {
	ids      []string
	crawlKey string
	batchID  string
}

type CollectRequest struct {
	SnapshotID string   `json:"snapshot_id"`
	IDs        []string `json:"ids"`
}

type crawlAddress struct {
	URL         string `json:"url"`
	EHPages     []int  `json:"eh_pages,omitempty"`
	AddressType string `json:"address_type,omitempty"`
}

type crawlSource struct {
	Site      string         `json:"site"`
	Addresses []crawlAddress `json:"addresses"`
}

var ehGallery = regexp.MustCompile(`^/g/[1-9][0-9]{0,19}/[a-fA-F0-9]{10}/?$`)

func exactEHGallery(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawPath != "" {
		return ""
	}
	host := strings.ToLower(u.Host)
	if (host == "e-hentai.org" || host == "exhentai.org") && ehGallery.MatchString(u.Path) {
		return "https://" + host + strings.TrimSuffix(u.Path, "/") + "/"
	}
	return ""
}

func exactWork(site, raw, id string) string {
	target, err := discoverydata.CanonicalWorkAddress(site, raw)
	if err != nil || target[strings.LastIndexByte(target, '/')+1:] != id {
		return ""
	}
	return target
}

func (s *Service) Browse(ctx context.Context, dataset string, req BrowseRequest) (BrowseResult, error) {
	spec, err := discoverydata.SearchSite(req.Site)
	if err != nil || (spec.Site != "pixiv" && spec.Site != "twitter" && spec.Site != "exhentai") {
		return BrowseResult{}, problem(422, "invalid_workbench_site", "工作台仅支持 Pixiv、X 和 EH 预览")
	}
	limit := maxTimelineBrowse
	if spec.Site == "exhentai" {
		limit = maxEHBrowse
	}
	if req.Limit < 1 || req.Limit > limit {
		return BrowseResult{}, problem(422, "invalid_workbench_limit", "预览数量必须在 1 到 "+strconv.Itoa(limit)+" 之间")
	}
	target := strings.TrimSpace(req.URL)
	if target == "" || len(target) > 8192 {
		return BrowseResult{}, problem(422, "invalid_workbench_url", "预览 URL 无效")
	}
	if err := s.deps.RequireDataset(ctx, dataset); err != nil {
		return BrowseResult{}, err
	}

	result := BrowseResult{SnapshotID: uuid.NewString(), Items: make([]Item, 0, req.Limit)}
	snap := &snapshot{dataset: dataset, site: spec.Site, entries: make(map[string]entry), collections: make(map[string]*collection)}
	var rows []map[string]any
	if spec.Site == "exhentai" {
		target = exactEHGallery(target)
		if target == "" {
			return BrowseResult{}, problem(422, "invalid_workbench_url", "请输入具体的 EH 画廊 URL")
		}
		var total int
		rows, total, err = s.deps.BrowseEHPages(ctx, target, req.Limit)
		if total > 0 {
			result.Total = &total
		}
	} else {
		rows, result.HasMore, err = s.deps.BrowseTimeline(ctx, spec.Site, target, req.Limit)
	}
	if err != nil {
		return BrowseResult{}, err
	}
	if len(rows) > req.Limit {
		rows = rows[:req.Limit]
		result.HasMore = true
	}
	for _, row := range rows {
		id := stringValue(row["id"])
		if _, exists := snap.entries[id]; exists {
			continue
		}
		item := Item{ID: id, Title: redaction.Text(stringValue(row["title"]), 500), Author: redaction.Text(stringValue(row["author"]), 200), MediaCount: intValue(row["media_count"])}
		record := entry{preview: previewTarget(spec.Site, stringValue(row["thumbnail_url"]))}
		if spec.Site == "exhentai" {
			item.Page = intValue(row["page"])
			if item.Page < 1 || id != strconv.Itoa(item.Page) {
				continue
			}
			record.target, record.page = target, item.Page
			if sprite, ok := row["thumbnail_sprite"].(map[string]int); ok {
				record.crop = spriteCrop(sprite)
				if record.crop.Empty() {
					record.preview = ""
				}
			}
		} else {
			record.target = exactWork(spec.Site, stringValue(row["download_url"]), id)
			if record.target == "" {
				continue
			}
		}
		if record.preview != "" {
			item.PreviewURL = previewPath(dataset, result.SnapshotID, id)
		}
		snap.entries[id] = record
		result.Items = append(result.Items, item)
	}
	if result.Total != nil && len(result.Items) < *result.Total {
		result.HasMore = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for key, saved := range s.snapshots {
		if !now.Before(saved.expires) {
			delete(s.snapshots, key)
		}
	}
	if len(s.snapshots) >= maxSnapshots {
		return BrowseResult{}, problem(429, "workbench_snapshot_capacity", "预览数量已达上限，请稍后重试")
	}
	snap.expires = now.Add(snapshotTTL)
	s.snapshots[result.SnapshotID] = snap
	return result, nil
}

func (s *Service) lookupLocked(dataset, id string) (*snapshot, error) {
	snap := s.snapshots[id]
	if snap == nil || snap.dataset != dataset {
		return nil, expiredSnapshot()
	}
	if !s.now().Before(snap.expires) {
		delete(s.snapshots, id)
		return nil, expiredSnapshot()
	}
	return snap, nil
}

func expiredSnapshot() error {
	return problem(http.StatusGone, "workbench_snapshot_expired", "预览已过期，请重新加载")
}

func (s *Service) Collect(ctx context.Context, dataset string, req CollectRequest, key string) (string, error) {
	if utf8.RuneCountInString(key) > 200 || strings.TrimSpace(key) == "" {
		return "", problem(422, "invalid_idempotency_key", "请提供有效的 Idempotency-Key")
	}
	if len(req.IDs) < 1 || len(req.IDs) > maxSelection {
		return "", problem(422, "invalid_workbench_selection", "请选择 1 到 500 项进行采集")
	}
	if err := s.deps.RequireDataset(ctx, dataset); err != nil {
		return "", err
	}
	key = strings.TrimSpace(key)
	ids := slices.Clone(req.IDs)
	slices.Sort(ids)

	s.mu.Lock()
	snap, err := s.lookupLocked(dataset, req.SnapshotID)
	if err != nil {
		s.mu.Unlock()
		return "", err
	}
	addresses := make([]crawlAddress, 0, len(ids))
	pages := make([]int, 0, len(ids))
	gallery := ""
	for i, id := range ids {
		record, ok := snap.entries[id]
		if !ok || (i > 0 && id == ids[i-1]) {
			s.mu.Unlock()
			return "", problem(422, "invalid_workbench_selection", "选择包含重复或不在当前预览中的项目")
		}
		if snap.site == "exhentai" {
			gallery = record.target
			pages = append(pages, record.page)
		} else {
			addresses = append(addresses, crawlAddress{URL: record.target, AddressType: "workbench_work"})
		}
	}
	if snap.site == "exhentai" {
		slices.Sort(pages)
		addresses = append(addresses, crawlAddress{URL: gallery, EHPages: pages})
	}
	attempt := snap.collections[key]
	if attempt == nil {
		if len(snap.collections) >= maxCollections {
			s.mu.Unlock()
			return "", problem(429, "workbench_collection_capacity", "当前预览的采集请求已达上限，请重新加载")
		}
		// Use a server-generated key in the global crawl namespace. Keep it even
		// after a failed response, since a batch might already have been created.
		attempt = &collection{ids: ids, crawlKey: "workbench-" + uuid.NewString()}
		snap.collections[key] = attempt
	} else if !slices.Equal(attempt.ids, ids) {
		s.mu.Unlock()
		return "", problem(409, "workbench_idempotency_conflict", "此 Idempotency-Key 已用于其他选择")
	}
	batchID := attempt.batchID
	s.mu.Unlock()
	if batchID != "" {
		return batchID, nil
	}
	body, err := json.Marshal(struct {
		Sources []crawlSource `json:"sources"`
	}{Sources: []crawlSource{{Site: snap.site, Addresses: addresses}}})
	if err != nil {
		return "", err
	}
	batchID, err = s.deps.StartCrawl(ctx, dataset, body, attempt.crawlKey)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	attempt.batchID = batchID
	s.mu.Unlock()
	return batchID, nil
}

func stringValue(v any) string {
	value, _ := v.(string)
	return value
}

func intValue(v any) int {
	value, _ := v.(int)
	return value
}
