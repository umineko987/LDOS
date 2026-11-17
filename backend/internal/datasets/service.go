// Package datasets owns the native dataset pipeline and durable dataset exports.
package datasets

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/config"
	"ldos/backend/internal/store"
)

// Record retains the existing Python/API snake_case projections, including nulls.
type Record = map[string]any

// Catalog performs catalog-owned mutations. ImportSource must enforce source
// overlap policy; datasets resolves already indexed ancestors before calling it.
// StartScan should treat an already running scan as success.
type Catalog interface {
	ImportSource(context.Context, string, string) (string, error)
	StartScan(context.Context, string) error
}

// Images allows main to supply gallery's safe reader and shared filesystem lock.
// OpenImage must return a regular, no-symlink file anchored to the specified source.
// If absent, the package uses its own descriptor-relative safe reader.
type Images interface {
	OpenImage(context.Context, string, string) (*os.File, error)
	LockSource(context.Context, string) (func(), error)
}

// Crawls validates the full crawl request and starts/replays its native batch.
// The callback returns the persisted batch ID; dataset linkage is owned here.
type Crawls interface {
	StartCrawl(context.Context, json.RawMessage, string) (string, error)
}

type Dependencies struct {
	Store    *store.Store
	Settings config.Settings
	Jobs     *activity.Registry
	Events   *activity.Bus
	Catalog  Catalog
	Images   Images
	Crawls   Crawls
}

type Error struct {
	Status        int
	Code, Message string
	Details       any
}

func (e *Error) Error() string { return e.Code }
func failure(status int, code, message string, details ...Record) *Error {
	e := &Error{Status: status, Code: code, Message: message, Details: Record{}}
	if len(details) > 0 {
		e.Details = details[0]
	}
	return e
}
func validation() *Error { return failure(422, "validation_error", "请求参数校验失败") }

var Stages = [...]string{"collect", "clean", "dedup", "tag", "review", "export"}

func StageIndex(stage string) (int, error) {
	for i, s := range Stages {
		if stage == s {
			return i, nil
		}
	}
	return 0, failure(422, "invalid_dataset_stage", "未知阶段: "+stage)
}

type hashPass struct {
	pending     map[string]bool
	total, step int
}
type exportWorker struct {
	cancel      context.CancelFunc
	reservation string
}
type Service struct {
	deps              Dependencies
	ctx               context.Context
	cancel            context.CancelFunc
	mu                sync.Mutex
	started, stopping bool
	workers           map[string]*exportWorker
	hashes            map[string]bool
	hashQueue         []string
	hashPasses        map[string]*hashPass
	hashRunning       bool
	wg                sync.WaitGroup
	// Test hooks are package-private and assigned only before starting workers.
	afterItem   func(string, int) error
	afterCommit func(string) error
}

func New(ctx context.Context, deps Dependencies) (*Service, error) {
	if deps.Store == nil {
		return nil, errors.New("datasets: Store is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithCancel(ctx)
	return &Service{deps: deps, ctx: ctx, cancel: cancel, workers: map[string]*exportWorker{}, hashes: map[string]bool{}, hashPasses: map[string]*hashPass{}}, nil
}

// Start recovers interrupted exports and reconciles existing crawl links/hashes.
// Main must reconcile gallery batch sources before calling Start.
func (s *Service) Start() error {
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return failure(409, "service_stopping", "后端正在关闭")
	}
	if s.started {
		s.mu.Unlock()
		return nil
	}
	s.started = true
	s.mu.Unlock()
	if _, err := s.RecoverExports(s.ctx); err != nil {
		return err
	}
	_, err := s.Reconcile(s.ctx)
	return err
}
func (s *Service) Stop() error {
	s.mu.Lock()
	s.stopping = true
	s.cancel()
	for _, w := range s.workers {
		w.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}
func now() float64 { return float64(time.Now().UnixNano()) / 1e9 }
func str(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	}
	return ""
}
func num(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case float64:
		return int64(x)
	case json.Number:
		n, _ := x.Int64()
		return n
	}
	return 0
}
func object(v any) Record {
	switch x := v.(type) {
	case map[string]any:
		return x
	case string:
		var m Record
		if decodeRecord(x, &m) == nil && m != nil {
			return m
		}
	}
	return Record{}
}
func jsonText(v any) (string, error) { b, e := json.Marshal(v); return string(b), e }
func decodeRecord(text string, value *Record) error {
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	return decoder.Decode(value)
}
func live(m Record) bool {
	return str(m["lifecycle_state"]) == "active" && str(m["dedup_visibility"]) != "excluded"
}
func unique(ids []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}
func ThumbnailURL(id string) string { return "/api/v1/gallery/assets/" + id + "/thumbnail?size=256" }
func (s *Service) PublishUpdated(id, reason string) {
	s.publish("dataset.updated", Record{"dataset_id": id, "reason": reason})
}
func (s *Service) publish(kind string, data Record) {
	if s.deps.Events != nil {
		_, _ = s.deps.Events.Publish(kind, data)
	}
}
func (s *Service) exec(ctx context.Context, q string, args ...any) error {
	return s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error { _, e := tx.ExecContext(ctx, q, args...); return e })
}
func touch(ctx context.Context, tx *sql.Tx, id string) error {
	_, e := tx.ExecContext(ctx, "UPDATE datasets SET updated_at=? WHERE id=?", now(), id)
	return e
}
func requireTx(ctx context.Context, tx *sql.Tx, id string) error {
	var v string
	e := tx.QueryRowContext(ctx, "SELECT id FROM datasets WHERE id=?", id).Scan(&v)
	if errors.Is(e, sql.ErrNoRows) {
		return failure(404, "dataset_not_found", "数据集不存在")
	}
	return e
}
func (s *Service) dataset(ctx context.Context, id string) (Record, error) {
	r, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM datasets WHERE id=?", id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, failure(404, "dataset_not_found", "数据集不存在")
	}
	r["dataset_id"] = r["id"]
	delete(r, "id")
	r["config"] = object(r["config_json"])
	delete(r, "config_json")
	return r, nil
}
func (s *Service) Require(ctx context.Context, id string) error { _, e := s.dataset(ctx, id); return e }
func (s *Service) openSource(ctx context.Context, sourceID, relative string) (*os.File, error) {
	if !safeRelative(relative) {
		return nil, failure(409, "source_changed", "来源路径不安全")
	}
	if s.deps.Images != nil {
		return s.deps.Images.OpenImage(ctx, sourceID, relative)
	}
	r, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_sources WHERE id=?", sourceID)
	if e != nil {
		return nil, e
	}
	if r == nil || str(r["availability"]) != "available" {
		return nil, failure(409, "source_offline", "图库来源离线", Record{"source_id": sourceID})
	}
	root, e := openDirectory(str(r["root_path"]))
	if e != nil {
		return nil, e
	}
	defer root.Close()
	return openRelative(root, relative)
}
func (s *Service) lockSource(ctx context.Context, id string) (func(), error) {
	if s.deps.Images != nil {
		return s.deps.Images.LockSource(ctx, id)
	}
	return func() {}, nil
}
func errorCode(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return fmt.Sprintf("%T", err)
}
