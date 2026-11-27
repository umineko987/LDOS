// Package collect unifies multi-source online discovery, media preview proxying,
// declarative range selection, and cross-source crawl batch submission.
package collect

import (
	"context"
	"encoding/json"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/scheduler"
	"ldos/backend/internal/search"
	"ldos/backend/internal/store"
)

const (
	DefaultPageLimit = 48
	MaxBrowseLimit   = 1000
	MaxSubmitItems   = 2000
	maxMediaBytes    = 12 << 20
	maxCacheBytes    = 64 << 20
)

type SourceSpec struct {
	ID          string `json:"id"`
	Site        string `json:"site"`
	Kind        string `json:"kind"` // search | timeline | pool | favorite_group | favorites | eh_gallery | single_work
	Label       string `json:"label"`
	Badge       string `json:"badge,omitempty"` // tag | artist | account | gallery | pool | group | favorites | work | search
	URL         string `json:"url,omitempty"`
	Query       string `json:"query,omitempty"`
	Reference   string `json:"reference,omitempty"`
	WorkID      string `json:"work_id,omitempty"`
	Total       *int   `json:"total,omitempty"`
	CoverURL    string `json:"cover_url,omitempty"`
	UnitKind    string `json:"unit_kind"`              // post | work | page
	DefaultMode string `json:"default_mode"`           // all | top_n
	DefaultTopN int    `json:"default_top_n,omitempty"`
	AutoEnable  bool   `json:"auto_enable,omitempty"`
}

type SiteStatus struct {
	Site       string   `json:"site"`
	Authorized bool     `json:"authorized"`
	State      string   `json:"state"`
	Summary    string   `json:"summary"`
	Warnings   []string `json:"warnings,omitempty"`
}

type ResolveRequest struct {
	Input string   `json:"input"`
	Sites []string `json:"sites,omitempty"`
}

type ResolveResponse struct {
	ResolvedMode string       `json:"resolved_mode"` // url | keyword
	Sources      []SourceSpec `json:"sources"`
	SiteStatuses []SiteStatus `json:"site_statuses"`
	Warnings     []string     `json:"warnings"`
}

type BrowseRequest struct {
	Source SourceSpec `json:"source"`
	Cursor string     `json:"cursor,omitempty"`
	Limit  int        `json:"limit,omitempty"`
}

type BrowseItem struct {
	ID                string              `json:"id"`
	Title             string              `json:"title"`
	Author            string              `json:"author,omitempty"`
	PreviewURL        string              `json:"preview_url,omitempty"`
	SampleURL         string              `json:"sample_url,omitempty"`
	Width             int                 `json:"width,omitempty"`
	Height            int                 `json:"height,omitempty"`
	FileExt           string              `json:"file_ext,omitempty"`
	FileSize          int64               `json:"file_size,omitempty"`
	Rating            string              `json:"rating,omitempty"`
	Score             int                 `json:"score,omitempty"`
	MediaCount        int                 `json:"media_count"`
	Page              *int                `json:"page,omitempty"`
	URL               string              `json:"url"`
	SourceURL         string              `json:"source_url,omitempty"`
	Downloadable      bool                `json:"downloadable"`
	UnavailableReason string              `json:"unavailable_reason,omitempty"`
	LocalState        string              `json:"local_state"` // none | in_library | in_dataset
	LocalAssetID      *string             `json:"local_asset_id,omitempty"`
	Tags              map[string][]string `json:"tags,omitempty"`
}

type BrowseResponse struct {
	Source     SourceSpec   `json:"source"`
	Items      []BrowseItem `json:"items"`
	NextCursor string       `json:"next_cursor"`
	Total      *int         `json:"total,omitempty"`
	Warnings   []string     `json:"warnings"`
}

type SubmitItem struct {
	ID           string  `json:"id"`
	URL          string  `json:"url"`
	Title        string  `json:"title,omitempty"`
	SourceURL    string  `json:"source_url,omitempty"`
	FileExt      string  `json:"file_ext,omitempty"`
	MediaCount   int     `json:"media_count,omitempty"`
	Page         *int    `json:"page,omitempty"`
	LocalAssetID *string `json:"local_asset_id,omitempty"`
}

type SubmitRange struct {
	Mode          string       `json:"mode"` // explicit | top_n | all | pages
	TopN          int          `json:"top_n,omitempty"`
	PageStart     int          `json:"page_start,omitempty"`
	PageEnd       int          `json:"page_end,omitempty"`
	Items         []SubmitItem `json:"items,omitempty"`
	ExcludedIDs   []string     `json:"excluded_ids,omitempty"`
	ExcludedPages []int        `json:"excluded_pages,omitempty"`
	ExtraPages    []int        `json:"extra_pages,omitempty"`
}

type SubmitSource struct {
	Source SourceSpec  `json:"source"`
	Range  SubmitRange `json:"range"`
}

type SubmitRequest struct {
	Sources []SubmitSource `json:"sources"`
}

type SubmitResponse struct {
	BatchID       *string `json:"batch_id"`
	QueuedSources int     `json:"queued_sources"`
	QueuedCount   int     `json:"queued_count"`
	ReusedCount   int     `json:"reused_count"`
	SkippedCount  int     `json:"skipped_count"`
}

type Dependencies struct {
	Store          *store.Store
	RequireDataset func(context.Context, string) error
	MemberRows     func(context.Context, string) ([]map[string]any, error)
	AttachAssets   func(context.Context, string, []string) (int, error)
	StartCrawl     func(context.Context, string, json.RawMessage, string) (string, error)
	Search         func(context.Context, search.Request) (map[string]any, error)
	AuthStatus     func(context.Context, string) (map[string]any, error)
	PolicyFor      func(context.Context, string) (scheduler.Policy, error)
	DanbooruReq    func(context.Context) (discovery.Request, error)
	DanbooruBrowse func(context.Context, discovery.Request, discovery.DanbooruBrowseOptions) (*discovery.DanbooruBrowsePage, error)
	BrowseTimeline func(context.Context, string, string, int) ([]map[string]any, bool, error)
	BrowseEHPages  func(context.Context, string, int) ([]map[string]any, int, error)
	Discover       func(context.Context, string, string, int, string) (map[string]any, error)
	Transport      *discovery.Transport
	PoolCapacity   func(proxypool.Request, string) (int, bool)
	FetchMedia     func(context.Context, string, string) ([]byte, error)
}

type Error struct {
	Status        int
	Code, Message string
	Details       any
}

func (e *Error) Error() string { return e.Message }

func problem(status int, code, message string, details ...any) error {
	var d any
	if len(details) > 0 {
		d = details[0]
	}
	return &Error{Status: status, Code: code, Message: message, Details: d}
}
