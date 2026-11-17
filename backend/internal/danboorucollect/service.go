// Package danboorucollect connects previewed Danbooru posts to dataset collection.
package danboorucollect

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"ldos/backend/internal/crawls"
	"ldos/backend/internal/datasets"
	"ldos/backend/internal/discovery"
	"ldos/backend/internal/store"
)

type Dependencies struct {
	Store       *store.Store
	Datasets    *datasets.Service
	Transport   *discovery.Transport
	Request     func(context.Context) (discovery.Request, error)
	Browse      func(context.Context, discovery.Request, discovery.DanbooruBrowseOptions) (*discovery.DanbooruBrowsePage, error)
	CreateCrawl func(context.Context, string, json.RawMessage, string) (map[string]any, error)
	FetchMedia  func(context.Context, string, discovery.Request) ([]byte, string, error)
}

type Service struct {
	deps       Dependencies
	mu         sync.Mutex
	collectMu  sync.Mutex
	entries    map[string]entry
	media      map[string]cachedMedia
	mediaOrder []string
	mediaBytes int
	mediaSlots chan struct{}
}

type entry struct {
	post      discovery.DanbooruPost
	datasetID string
	expires   time.Time
}

type Post struct {
	discovery.DanbooruPost
	Token        string  `json:"token"`
	LocalAssetID *string `json:"local_asset_id"`
	InDataset    bool    `json:"in_dataset"`
}

type Page struct {
	Items      []Post                   `json:"items"`
	Source     discovery.DanbooruSource `json:"source"`
	NextCursor string                   `json:"next_cursor"`
	Total      *int                     `json:"total"`
	Warnings   []string                 `json:"warnings"`
}

type BrowseRequest struct {
	discovery.DanbooruBrowseOptions
	DatasetID string `json:"dataset_id"`
}

type Result struct {
	BatchID      *string `json:"batch_id"`
	QueuedCount  int     `json:"queued_count"`
	ReusedCount  int     `json:"reused_count"`
	SkippedCount int     `json:"skipped_count"`
}

type collectPlan struct {
	BatchKey string                   `json:"batch_key"`
	Posts    []discovery.DanbooruPost `json:"posts"`
	AssetIDs []string                 `json:"asset_ids"`
	Skipped  int                      `json:"skipped"`
}

type Error struct {
	Status        int
	Code, Message string
}

func (e *Error) Error() string                       { return e.Message }
func problem(status int, code, message string) error { return &Error{status, code, message} }

func New(deps Dependencies) *Service {
	return &Service{deps: deps, entries: map[string]entry{}, media: map[string]cachedMedia{}, mediaSlots: make(chan struct{}, 4)}
}

func (s *Service) Browse(ctx context.Context, body BrowseRequest) (*Page, error) {
	if err := s.deps.Datasets.Require(ctx, body.DatasetID); err != nil {
		return nil, err
	}
	request, err := s.deps.Request(ctx)
	if err != nil {
		return nil, err
	}
	page, err := s.deps.Browse(ctx, request, body.DanbooruBrowseOptions)
	if err != nil {
		return nil, err
	}
	local, members, err := s.localAssets(ctx, body.DatasetID, page.Items)
	if err != nil {
		return nil, err
	}
	result := &Page{Items: []Post{}, Source: page.Source, NextCursor: page.NextCursor, Total: page.Total, Warnings: page.Warnings}
	if result.Warnings == nil {
		result.Warnings = []string{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for token, item := range s.entries {
		if now.After(item.expires) {
			delete(s.entries, token)
		}
	}
	// Bound metadata retained by browsing sessions without evicting live selections.
	if len(s.entries)+len(page.Items) > 10000 {
		return nil, problem(429, "danbooru_preview_limit", "预览缓存已满，请稍后重新打开采集窗口")
	}
	for _, post := range page.Items {
		token := uuid.NewString()
		s.entries[token] = entry{post: post, datasetID: body.DatasetID, expires: now.Add(30 * time.Minute)}
		item := Post{DanbooruPost: post, Token: token}
		if asset := local[post.ID]; asset != "" {
			item.LocalAssetID = &asset
			item.InDataset = members[asset]
		}
		item.PreviewURL, item.SampleURL = "", ""
		if allowedMediaURL(post.PreviewURL) {
			item.PreviewURL = "/api/v1/danbooru/media/" + token + "?size=preview"
		}
		if allowedMediaURL(post.SampleURL) {
			item.SampleURL = "/api/v1/danbooru/media/" + token + "?size=sample"
		}
		result.Items = append(result.Items, item)
	}
	return result, nil
}

// Only filenames controlled by this collector establish provenance. Legacy files
// with guessed names are deliberately not treated as matching a remote post.
func (s *Service) localAssets(ctx context.Context, datasetID string, posts []discovery.DanbooruPost) (map[string]string, map[string]bool, error) {
	local, members := map[string]string{}, map[string]bool{}
	rows, err := s.deps.Datasets.MemberRows(ctx, datasetID)
	if err != nil {
		return nil, nil, err
	}
	for _, row := range rows {
		members[fmt.Sprint(row["asset_id"])] = true
	}
	if len(posts) == 0 {
		return local, members, nil
	}
	args := make([]any, len(posts))
	for i, post := range posts {
		args[i] = post.ID
	}
	query := `SELECT i.post_id,a.id FROM danbooru_import_items i JOIN gallery_sources s ON s.batch_id=i.batch_id JOIN gallery_assets a ON a.source_id=s.id AND a.name=i.file_name WHERE i.post_id IN (` + strings.TrimRight(strings.Repeat("?,", len(posts)), ",") + `) AND a.lifecycle_state='active' AND a.dedup_visibility!='excluded' AND s.availability='available' ORDER BY a.id`
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

func (s *Service) Collect(ctx context.Context, datasetID string, tokens []string, key string) (*Result, error) {
	if len(tokens) < 1 || len(tokens) > 1000 || len(key) < 1 || len(key) > 200 {
		return nil, problem(422, "invalid_danbooru_selection", "请选择 1–1000 张图片并提供有效请求标识")
	}
	if err := s.deps.Datasets.Require(ctx, datasetID); err != nil {
		return nil, err
	}
	s.collectMu.Lock()
	defer s.collectMu.Unlock()
	encodedTokens, _ := json.Marshal(tokens)
	saved, err := s.deps.Store.QueryRow(ctx, `SELECT tokens_json,plan_json,result_json FROM danbooru_collect_requests WHERE dataset_id=? AND request_key=?`, datasetID, key)
	if err != nil {
		return nil, err
	}
	var plan collectPlan
	if saved != nil {
		if saved["tokens_json"] != string(encodedTokens) {
			return nil, problem(409, "idempotency_conflict", "此请求标识已用于另一组图片")
		}
		if raw, _ := saved["result_json"].(string); raw != "" {
			var result Result
			if err := json.Unmarshal([]byte(raw), &result); err != nil {
				return nil, err
			}
			return &result, nil
		}
		if err := json.Unmarshal([]byte(fmt.Sprint(saved["plan_json"])), &plan); err != nil {
			return nil, err
		}
	} else {
		posts := []discovery.DanbooruPost{}
		seen := map[string]bool{}
		s.mu.Lock()
		for _, token := range tokens {
			item, ok := s.entries[token]
			if !ok || item.datasetID != datasetID || time.Now().After(item.expires) {
				s.mu.Unlock()
				return nil, problem(410, "danbooru_selection_expired", "候选已失效，请重新加载后选择")
			}
			if !seen[item.post.ID] {
				seen[item.post.ID] = true
				posts = append(posts, item.post)
			}
		}
		s.mu.Unlock()
		local, members, err := s.localAssets(ctx, datasetID, posts)
		if err != nil {
			return nil, err
		}
		plan = collectPlan{BatchKey: uuid.NewString(), Posts: []discovery.DanbooruPost{}, AssetIDs: []string{}}
		for _, post := range posts {
			if asset := local[post.ID]; asset != "" {
				if members[asset] {
					plan.Skipped++
				} else {
					plan.AssetIDs = append(plan.AssetIDs, asset)
				}
			} else {
				if !post.Downloadable || !safeFileExt(post.FileExt) {
					return nil, problem(422, "danbooru_post_unavailable", "选中图片已不可采集，请重新加载候选")
				}
				plan.Posts = append(plan.Posts, post)
			}
		}
		if len(plan.Posts) > 0 {
			if err := s.recheckPosts(ctx, plan.Posts); err != nil {
				return nil, err
			}
		}
		encodedPlan, _ := json.Marshal(plan)
		err = s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
			_, e := tx.ExecContext(ctx, `INSERT INTO danbooru_collect_requests(dataset_id,request_key,tokens_json,plan_json,result_json) VALUES(?,?,?,?,'')`, datasetID, key, string(encodedTokens), string(encodedPlan))
			return e
		})
		if err != nil {
			return nil, err
		}
	}
	result := &Result{QueuedCount: len(plan.Posts), ReusedCount: len(plan.AssetIDs), SkippedCount: plan.Skipped}
	if len(plan.AssetIDs) > 0 {
		if _, err = s.deps.Datasets.AttachAssets(ctx, datasetID, plan.AssetIDs); err != nil {
			return nil, err
		}
	}
	if len(plan.Posts) > 0 {
		request, err := s.deps.Request(ctx)
		if err != nil {
			return nil, err
		}
		addresses := make([]crawls.Address, 0, len(plan.Posts))
		for i, post := range plan.Posts {
			label, kind := post.Title, "work"
			addresses = append(addresses, crawls.Address{URL: post.URL, Label: &label, AddressType: &kind, ExtraArgs: []string{"--filename", fmt.Sprintf("ldos-danbooru-%04d-%s.{extension}", i+1, post.ID)}})
		}
		body := map[string]any{"sources": []map[string]any{{"site": "danbooru", "addresses": addresses}}, "concurrency": 4, "max_tasks": len(addresses), "proxy_mode": request.ProxyMode}
		if request.ConfigFile != "" {
			body["config_file"] = request.ConfigFile
		}
		if request.CookiesFile != "" {
			body["cookies_file"] = request.CookiesFile
		}
		if request.CredentialsRef != "" {
			body["credentials_ref"] = request.CredentialsRef
		}
		if len(request.ExtraArgs) > 0 {
			body["extra_args"] = request.ExtraArgs
		}
		raw, _ := json.Marshal(body)
		batch, err := s.deps.CreateCrawl(ctx, datasetID, raw, "danbooru:"+plan.BatchKey)
		if err != nil {
			return nil, err
		}
		id := fmt.Sprint(batch["id"])
		result.BatchID = &id
		err = s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
			for i, post := range plan.Posts {
				if _, e := tx.ExecContext(ctx, `INSERT INTO danbooru_import_items(batch_id,post_id,file_name) VALUES(?,?,?) ON CONFLICT(batch_id,post_id) DO NOTHING`, id, post.ID, fmt.Sprintf("ldos-danbooru-%04d-%s.%s", i+1, post.ID, post.FileExt)); e != nil {
					return e
				}
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	encodedResult, _ := json.Marshal(result)
	err = s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		_, e := tx.ExecContext(ctx, `UPDATE danbooru_collect_requests SET result_json=? WHERE dataset_id=? AND request_key=?`, string(encodedResult), datasetID, key)
		return e
	})
	return result, err
}

func safeFileExt(ext string) bool {
	if len(ext) < 1 || len(ext) > 10 {
		return false
	}
	for _, c := range ext {
		if c < 'a' || c > 'z' {
			if c < '0' || c > '9' {
				return false
			}
		}
	}
	return true
}
