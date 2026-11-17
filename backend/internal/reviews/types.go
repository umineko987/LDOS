// Package reviews owns crawl and gallery review orchestration and persistence.
// The only Python subprocess is the independent model inference executor.
package reviews

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/config"
	"ldos/backend/internal/store"
)

type Row = map[string]any

// Settings is local until config.Dedup is supplied by the composition root.
// Paths must name independent executors, never gdl_backend business modules.
type Settings struct {
	Enabled                                                                      bool
	PythonExecutable, WorkerScript, CoreScript, ModelDir, FilterModelsScript     string
	Device                                                                       string
	Workers, TorchThreads, TorchInteropThreads, DeepBatchSize, NeighborBlockSize int
	NoSSCD, NoDINO                                                               bool
	PollInterval, ShutdownGrace                                                  time.Duration
}

type Dependencies struct {
	Store    *store.Store
	Settings config.Settings
	Dedup    Settings
	// PythonExecutable follows a repaired model environment without restarting.
	PythonExecutable func() string
	Jobs             *activity.Registry
	Gallery          GalleryCallbacks
	// DescribeReview associates a review with dataset/stage activity metadata.
	DescribeReview func(context.Context, string) (string, map[string]string)
	// Runner is an optional inference seam. Production normally uses the process runner.
	Runner func(context.Context, WorkerInput) (Manifest, string, error)
}

// GalleryCallbacks must share locks and file journals with every gallery consumer.
// Callbacks must honor ctx and finish their work before returning. HoldSources must
// permit nested acquisition by ScanSource/TrashAsset/RestoreTrash in the same ctx.
// Callbacks receive no review persistence responsibility.
type GalleryCallbacks struct {
	HoldSources    func(context.Context, []string, func(context.Context) error) error
	ScanSource     func(context.Context, string) error
	TrashAsset     func(ctx context.Context, assetID, operationID string, snapshot Snapshot) error
	RestoreTrash   func(context.Context, string) error
	RecoverFiles   func(context.Context) error
	ReconcileCrawl func(context.Context, string, []Row) error
	// Reference validation may be supplied by a standalone image decoder for formats
	// not handled by Go's standard decoders. It must decode all bytes and, when
	// staticOnly, reject multi-frame images.
	ValidateReference func(ctx context.Context, snapshot Snapshot, staticOnly bool) error
	// CheckFilters runs offline model capability checks. When absent, the service
	// invokes FilterModelsScript, an independent inference/probe executor.
	CheckFilters func(context.Context, []string) (map[string]Capability, error)
}

type Capability struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
}
type FilterOptions struct {
	BasicDedup        bool     `json:"basic_dedup"`
	FilterMonochrome  bool     `json:"filter_monochrome"`
	FilterSketch      bool     `json:"filter_sketch"`
	FilterCharacter   bool     `json:"filter_character"`
	SimilarityGroups  bool     `json:"similarity_groups"`
	ReferenceAssetIDs []string `json:"reference_asset_ids"`
}
type FilterConfig struct {
	PresetName string        `json:"preset_name"`
	Options    FilterOptions `json:"options"`
}
type Preset struct {
	ID      string        `json:"id"`
	Name    string        `json:"name"`
	Builtin bool          `json:"builtin"`
	Options FilterOptions `json:"options"`
}
type Selection struct {
	DirectoryID       string `json:"directory_id"`
	SourceID          string `json:"source_id"`
	SourceDisplayName string `json:"source_display_name"`
	RelativePath      string `json:"relative_path"`
	Name              string `json:"name"`
}
type Snapshot struct {
	AssetID           string   `json:"asset_id"`
	SourceID          string   `json:"source_id"`
	DirectoryID       string   `json:"directory_id"`
	RelativePath      string   `json:"relative_path"`
	ContentVersion    int64    `json:"content_version"`
	TXTVersion        int64    `json:"txt_version"`
	TXTRelativePath   string   `json:"txt_relative_path"`
	TXTState          string   `json:"txt_state"`
	RootPath          string   `json:"root_path"`
	RootIdentity      []uint64 `json:"root_identity"`
	SourceDisplayName string   `json:"source_display_name"`
	DiskVersion       string   `json:"disk_version"`
	TXTDiskVersion    string   `json:"txt_disk_version"`
}
type WorkerInput struct {
	BatchID      string        `json:"batch_id,omitempty"`
	OutputDir    string        `json:"output_dir,omitempty"`
	ReviewID     string        `json:"review_id,omitempty"`
	Images       []Snapshot    `json:"images,omitempty"`
	References   []Snapshot    `json:"references"`
	FilterConfig *FilterConfig `json:"filter_config"`
}

func (i WorkerInput) identity() identity {
	if i.ReviewID != "" {
		return identity{i.ReviewID, true}
	}
	return identity{i.BatchID, false}
}

type Manifest struct {
	SchemaVersion int             `json:"schema_version"`
	Root          string          `json:"root,omitempty"`
	ReviewID      string          `json:"review_id,omitempty"`
	FilterConfig  *FilterConfig   `json:"filter_config"`
	Counts        map[string]int  `json:"counts"`
	Groups        []ManifestGroup `json:"groups"`
	AutoGroups    []ManifestGroup `json:"auto_groups"`
	FilteredItems []ManifestImage `json:"filtered_items"`
}
type ManifestGroup struct {
	ID            string          `json:"id"`
	Ordinal       int             `json:"ordinal"`
	Kind          string          `json:"kind"`
	MatchLevels   []any           `json:"match_levels"`
	Reason        string          `json:"reason"`
	Items         []ManifestImage `json:"items"`
	Winner        ManifestImage   `json:"winner"`
	RejectedItems []ManifestImage `json:"rejected_items"`
}
type ManifestImage struct {
	ID            string         `json:"id"`
	Ordinal       int            `json:"ordinal"`
	RelativePath  string         `json:"relative_path"`
	Readable      *bool          `json:"readable,omitempty"`
	Recommended   bool           `json:"recommended"`
	Metadata      map[string]any `json:"metadata"`
	ReviewMetrics any            `json:"review_metrics,omitempty"`
	Reason        string         `json:"reason,omitempty"`
}
type Decision struct {
	GroupID          string   `json:"group_id"`
	SelectedImageIDs []string `json:"selected_image_ids"`
}
type GroupQuery struct {
	Kind, Classification  string
	Limit, Offset         int
	All, IncludeAutomatic bool
}
type Page struct {
	Items  []Row `json:"items"`
	Total  int   `json:"total"`
	Limit  int   `json:"limit"`
	Offset int   `json:"offset"`
}
type ImageContent struct {
	io.ReadSeekCloser
	Name     string
	Modified time.Time
}

type Error struct {
	Status        int
	Code, Message string
	Details       any
}

func (e *Error) Error() string { return e.Message }
func failure(status int, code, message string) error {
	return &Error{Status: status, Code: code, Message: message}
}
func conflict(message string) error { return failure(409, "review_state_conflict", message) }
func missing() error {
	return failure(404, "review_not_found", "审核批次、目录或图片不存在")
}
func invalid(message string) error { return failure(422, "validation_error", message) }

type identity struct {
	id      string
	gallery bool
}

func (i identity) tables() (string, string, string, string) {
	if i.gallery {
		return "gallery_reviews", "gallery_review_groups", "gallery_review_images", "review_id"
	}
	return "crawl_reviews", "crawl_review_groups", "crawl_review_images", "batch_id"
}
func (i identity) key() string {
	if i.gallery {
		return "gallery:" + i.id
	}
	return "crawl:" + i.id
}
func text(v any) string {
	if v == nil {
		return ""
	}
	if b, ok := v.([]byte); ok {
		return string(b)
	}
	return fmt.Sprint(v)
}
func number(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case json.Number:
		i, _ := n.Int64()
		return i
	}
	return 0
}
func truth(v any) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return number(v) != 0
}
func encode(v any) string { b, _ := json.Marshal(v); return string(b) }
func now() float64        { return float64(time.Now().UnixNano()) / 1e9 }
func clip(v string, n int) string {
	r := []rune(v)
	if len(r) > n {
		return string(r[:n])
	}
	return v
}
func terminal(status string) bool {
	return status == "succeeded" || status == "completed_with_errors" || status == "cancelled"
}

const MaxGroups = 10000
