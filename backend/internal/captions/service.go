// Package captions implements gallery and dataset captions with recoverable write journals.
package captions

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/config"
	"ldos/backend/internal/store"
)

type Row = map[string]any

// Gallery callbacks must use the catalog's source locks, safe paths, optimistic
// disk + indexed versions, atomic writes, rollback and search-index updates.
// Content nil means a missing sidecar. BOM records the original UTF-8 BOM.
type Annotation struct {
	AssetID     string
	State       string
	Content     *string
	DiskVersion string
	TXTVersion  int64
	BOM         bool
	Error       string
}
type AnnotationWrite struct {
	TXTVersion  int64
	DiskVersion string
	BOM         bool
}
type Dependencies struct {
	Store           *store.Store
	Settings        config.Settings
	Jobs            *activity.Registry
	GetDataset      func(context.Context, string) (Row, error)
	StageInput      func(context.Context, string, string) ([]Row, error)
	ReadAnnotations func(context.Context, []string) (map[string]Annotation, error)
	WriteAnnotation func(context.Context, string, *string, AnnotationWrite) (Annotation, error)
	WithSources     func(context.Context, []string, func(context.Context) error) error
	Publish         func(string, Row)
	DatasetUpdated  func(string, string)
}
type Error struct {
	Status        int
	Code, Message string
	Details       any
}

func (e *Error) Error() string { return e.Message }
func Fail(status int, code, message string) error {
	return &Error{Status: status, Code: code, Message: message}
}
func Text(v any) string {
	if v == nil {
		return ""
	}
	if b, ok := v.([]byte); ok {
		return string(b)
	}
	return fmt.Sprint(v)
}
func Number(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		i, _ := n.Int64()
		return i
	}
	return 0
}
func object(v any) Row {
	r := Row{}
	_ = json.Unmarshal([]byte(Text(v)), &r)
	if r == nil {
		return Row{}
	}
	return r
}
func encode(v any) string { b, _ := json.Marshal(v); return string(b) }
func now() float64        { return float64(time.Now().UnixNano()) / 1e9 }

type Service struct {
	deps    Dependencies
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	locks   map[string]*sync.Mutex
	wg      sync.WaitGroup
	stopped bool
}

func New(ctx context.Context, deps Dependencies) (*Service, error) {
	if deps.Store == nil || deps.StageInput == nil || deps.ReadAnnotations == nil || deps.WriteAnnotation == nil || deps.WithSources == nil {
		return nil, errors.New("captions requires Store, StageInput, ReadAnnotations, WriteAnnotation and WithSources")
	}
	ctx, cancel := context.WithCancel(ctx)
	return &Service{deps: deps, ctx: ctx, cancel: cancel, locks: map[string]*sync.Mutex{}}, nil
}
func (s *Service) Start() error { _, e := s.Recover(s.ctx); return e }
func (s *Service) Stop() error {
	s.mu.Lock()
	s.stopped = true
	s.cancel()
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}
func (s *Service) begin(ctx context.Context) (context.Context, func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped || s.ctx.Err() != nil {
		return nil, nil, context.Canceled
	}
	s.wg.Add(1)
	child, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(s.ctx, cancel)
	return child, func() { stop(); cancel(); s.wg.Done() }, nil
}
func (s *Service) lock(id string) func() {
	s.mu.Lock()
	l := s.locks[id]
	if l == nil {
		l = &sync.Mutex{}
		s.locks[id] = l
	}
	s.mu.Unlock()
	l.Lock()
	return l.Unlock
}
func (s *Service) dataset(ctx context.Context, id string) (Row, error) {
	if s.deps.GetDataset != nil {
		return s.deps.GetDataset(ctx, id)
	}
	r, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM datasets WHERE id=?", id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, Fail(404, "dataset_not_found", "数据集不存在")
	}
	return r, nil
}
func (s *Service) read(ctx context.Context, ids []string) (map[string]Annotation, error) {
	all := map[string]Annotation{}
	for start := 0; start < len(ids); start += 2000 {
		end := min(start+2000, len(ids))
		rows, e := s.deps.ReadAnnotations(ctx, ids[start:end])
		if e != nil {
			return nil, e
		}
		for _, id := range ids[start:end] {
			a, ok := rows[id]
			if !ok {
				return nil, fmt.Errorf("annotation callback omitted %s", id)
			}
			a.AssetID = id
			if a.Error != "" {
				a.State = "unavailable"
			}
			all[id] = a
		}
	}
	return all, nil
}
func (s *Service) selectDatasetIDs(ctx context.Context, id string, ids []string) ([]string, error) {
	rows, e := s.deps.StageInput(ctx, id, "export")
	if e != nil {
		return nil, e
	}
	known := map[string]bool{}
	all := []string{}
	for _, r := range rows {
		aid := Text(r["asset_id"])
		known[aid] = true
		all = append(all, aid)
	}
	if ids == nil {
		return all, nil
	}
	ids = Dedupe(ids)
	unknown := []string{}
	for _, aid := range ids {
		if !known[aid] {
			unknown = append(unknown, aid)
		}
	}
	if len(unknown) > 0 {
		return nil, &Error{422, "caption_asset_not_in_stage", "有图片不在这一阶段的输入里", Row{"stage": "export", "asset_ids": unknown[:min(20, len(unknown))]}}
	}
	return ids, nil
}
func (s *Service) write(ctx context.Context, q string, args ...any) error {
	return s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, q, args...)
		return e
	})
}
func (s *Service) publish(owner captionOwner, batch, reason string, n int) {
	if s.deps.Publish != nil {
		s.deps.Publish("captions.updated", owner.project(Row{"batch_id": batch, "reason": reason, "changed": n}))
	}
	if !owner.source && s.deps.DatasetUpdated != nil {
		s.deps.DatasetUpdated(owner.id, "captions")
	}
}
func failureReason(e error) (string, string) {
	var d *Error
	if errors.As(e, &d) {
		if d.Code == "txt_version_conflict" || d.Code == "txt_disk_conflict" || d.Code == "caption_version_conflict" {
			return "conflicts", d.Code
		}
		return "failed", d.Code
	}
	if errors.Is(e, context.Canceled) {
		return "failed", "cancelled"
	}
	return "failed", "caption_write_failed"
}
func (s *Service) job(kind, id string, owner captionOwner, total int) {
	if s.deps.Jobs != nil {
		s.deps.Jobs.Start(kind, "Caption", activity.StartOptions{ID: id, Total: &total, Ref: map[string]string{owner.field(): owner.id}})
	}
}
func (s *Service) progress(id string, n, total int) {
	if s.deps.Jobs != nil {
		s.deps.Jobs.Update(id, activity.UpdateOptions{Current: &n, Total: &total})
	}
}
func (s *Service) finishJob(id string, failed bool) {
	if s.deps.Jobs != nil {
		status := activity.StatusSucceeded
		if failed {
			status = activity.StatusFailed
		}
		s.deps.Jobs.Finish(id, activity.FinishOptions{Status: status})
	}
}
