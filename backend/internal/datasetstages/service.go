// Package datasetstages implements tag, clean and dedup stages on the v18 store.
package datasetstages

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
	"ldos/backend/internal/activity"
	"ldos/backend/internal/captions"
	"ldos/backend/internal/config"
	"ldos/backend/internal/store"
)

type Row = map[string]any
type Error = captions.Error

var fail = captions.Fail
var text = captions.Text
var number = captions.Number

func encode(v any) string { b, _ := json.Marshal(v); return string(b) }
func object(v any) Row {
	if r, ok := v.(map[string]any); ok {
		return r
	}
	out := Row{}
	var raw []byte
	switch x := v.(type) {
	case string:
		raw = []byte(x)
	case []byte:
		raw = x
	default:
		raw, _ = json.Marshal(v)
	}
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		return Row{}
	}
	return out
}
func stringsOfJSON(v any) []string {
	var values []any
	_ = json.Unmarshal([]byte(text(v)), &values)
	return stringsOf(values)
}
func truth(v any) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return number(v) != 0
}
func now() float64 { return float64(time.Now().UnixNano()) / 1e9 }

// Callbacks take domain DTOs/maps so the composition root is the only peer importer.
// Review Create/Adopt/Finish map to reviews.CreateGallery/AdoptGroup/FinishGallery.
type ReviewCallbacks struct {
	Create  func(context.Context, []string, Row) (Row, error)
	Adopt   func(context.Context, string, string, []string, int64, bool) (Row, error)
	Finish  func(context.Context, string) error
	Presets func(context.Context) ([]Row, error)
}

// Tag starts inference with no caption writes. Completion can be synchronous;
// OnFinished is marshalled through registration before stage state is committed.
// Query returns standalone CLI NDJSON records (models and candidates), never a
// Python business service. Callbacks must honor cancellation before cache writes.
type TaggerCallbacks struct {
	Catalog         func(context.Context) ([]Row, error)
	Tag             func(context.Context, []string, []string, int, Row, func(Row)) (string, error)
	Query           func(context.Context, string, []string, []string, []string) ([]Row, error)
	Cancel          func(context.Context, string) error
	CacheGeneration func() uint64
	CurrentJobID    func() string
}
type Dependencies struct {
	Store            *store.Store
	Settings         config.Settings
	DedupEnabled     func() bool
	Jobs             *activity.Registry
	StageInput       func(context.Context, string, string) ([]Row, error)
	StageInputDigest func(context.Context, string, string) (string, error)
	ApplyCaptions    func(context.Context, string, captions.TaggerOptions) (Row, error)
	Reviews          ReviewCallbacks
	Tagger           TaggerCallbacks
	Publish          func(string, Row)
	DatasetUpdated   func(string, string)
}
type Service struct {
	deps          Dependencies
	ctx           context.Context
	cancel        context.CancelFunc
	mu            sync.Mutex
	wg            sync.WaitGroup
	stopped       bool
	triage        sync.Mutex
	starting      map[string]bool
	owners        map[string]Row
	undo          map[string][]*undoBatch
	tags          map[string]*tagJob
	reviewBinding sync.RWMutex
	candidateMu   sync.Mutex
	candidates    []candidateCache
}
type tagJob struct {
	runID, jobID string
	cancel       context.CancelFunc
	done         chan struct{}
}

func New(ctx context.Context, deps Dependencies) (*Service, error) {
	if deps.Store == nil || deps.StageInput == nil || deps.StageInputDigest == nil {
		return nil, errors.New("datasetstages requires Store, StageInput and StageInputDigest")
	}
	ctx, cancel := context.WithCancel(ctx)
	return &Service{deps: deps, ctx: ctx, cancel: cancel, starting: map[string]bool{}, owners: map[string]Row{}, undo: map[string][]*undoBatch{}, tags: map[string]*tagJob{}}, nil
}
func (s *Service) Start() error { _, e := s.Recover(s.ctx); return e }
func (s *Service) Stop() error {
	s.mu.Lock()
	s.stopped = true
	s.cancel()
	jobs := []*tagJob{}
	for _, j := range s.tags {
		j.cancel()
		jobs = append(jobs, j)
	}
	s.mu.Unlock()
	for _, j := range jobs {
		if s.deps.Tagger.Cancel != nil {
			_ = s.deps.Tagger.Cancel(context.Background(), j.jobID)
		}
	}
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
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(s.ctx, cancel)
	return ctx, func() { stop(); cancel(); s.wg.Done() }, nil
}
func (s *Service) require(ctx context.Context, id string) error {
	r, e := s.deps.Store.QueryRow(ctx, "SELECT id FROM datasets WHERE id=?", id)
	if e != nil {
		return e
	}
	if r == nil {
		return fail(404, "dataset_not_found", "数据集不存在")
	}
	return nil
}
func (s *Service) write(ctx context.Context, fn func(*sql.Tx) error) error {
	return s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		if e := fn(tx); e != nil {
			return e
		}
		return ctx.Err()
	})
}
func (s *Service) exec(ctx context.Context, q string, args ...any) error {
	return s.write(ctx, func(tx *sql.Tx) error { _, e := tx.ExecContext(ctx, q, args...); return e })
}
func projectRun(r Row) Row {
	if r == nil {
		return nil
	}
	r["run_id"] = r["id"]
	delete(r, "id")
	r["stats"] = object(r["stats_json"])
	delete(r, "stats_json")
	return r
}
func (s *Service) getRun(ctx context.Context, id string) (Row, error) {
	r, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM dataset_stage_runs WHERE id=?", id)
	return projectRun(r), e
}
func (s *Service) latest(ctx context.Context, id, stage string) (Row, error) {
	r, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM dataset_stage_runs WHERE dataset_id=? AND stage=? ORDER BY created_at DESC,rowid DESC LIMIT 1", id, stage)
	return projectRun(r), e
}
func (s *Service) startRun(ctx context.Context, id, stage, ref string, stats Row) (Row, error) {
	digest, e := s.deps.StageInputDigest(ctx, id, stage)
	if e != nil {
		return nil, e
	}
	rid := uuid.NewString()
	t := now()
	e = s.exec(ctx, "INSERT INTO dataset_stage_runs(id,dataset_id,stage,status,ref_id,input_digest,stats_json,created_at,updated_at) VALUES(?,?,?,'running',?,?,?,?,?)", rid, id, stage, ref, digest, encode(stats), t, t)
	if e != nil {
		return nil, e
	}
	r, e := s.getRun(ctx, rid)
	if e == nil {
		s.publishStage(r)
	}
	return r, e
}
func (s *Service) finishRun(ctx context.Context, id, status, code string, stats Row) (Row, error) {
	t := now()
	e := s.exec(ctx, "UPDATE dataset_stage_runs SET status=?,error_code=?,stats_json=?,updated_at=?,finished_at=? WHERE id=? AND status='running'", status, code, encode(stats), t, t, id)
	if e != nil {
		return nil, e
	}
	r, e := s.getRun(ctx, id)
	if r != nil && e == nil {
		s.publishStage(r)
	}
	return r, e
}
func (s *Service) publishStage(r Row) {
	if s.deps.Publish != nil {
		s.deps.Publish("dataset.stage.updated", Row{"dataset_id": r["dataset_id"], "stage": r["stage"], "run_id": r["run_id"], "status": r["status"], "review_id": r["ref_id"]})
	}
}
func (s *Service) publishDataset(id string) {
	if s.deps.DatasetUpdated != nil {
		s.deps.DatasetUpdated(id, "stages")
	} else if s.deps.Publish != nil {
		s.deps.Publish("dataset.updated", Row{"dataset_id": id})
	}
}
func (s *Service) Recover(ctx context.Context) (int, error) {
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT * FROM dataset_stage_runs WHERE status='running' AND stage IN ('tag','clean','dedup')")
	if e != nil {
		return 0, e
	}
	count := 0
	for _, raw := range rows {
		r := projectRun(raw)
		s.mu.Lock()
		active := s.tags[text(r["run_id"])] != nil
		s.mu.Unlock()
		if active {
			continue
		}
		if text(r["stage"]) == "tag" {
			if s.deps.Tagger.CurrentJobID != nil && text(r["ref_id"]) != "" && text(r["ref_id"]) == s.deps.Tagger.CurrentJobID() {
				continue
			}
			_, e = s.finishRun(ctx, text(r["run_id"]), "failed", "interrupted", r["stats"].(Row))
		} else {
			s.triage.Lock()
			_, e = s.finalize(ctx, r, true)
			s.triage.Unlock()
		}
		if e != nil {
			return count, e
		}
		count++
	}
	return count, nil
}

// OnReviewChanged is safe to call from review listeners, including during Adopt.
// It schedules finalization without reentering the review mutation's locks.
func (s *Service) OnReviewChanged(reviewID string) {
	s.mu.Lock()
	if s.stopped || s.ctx.Err() != nil {
		s.mu.Unlock()
		return
	}
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		s.triage.Lock()
		defer s.triage.Unlock()
		r, e := s.deps.Store.QueryRow(s.ctx, "SELECT * FROM dataset_stage_runs WHERE ref_id=? AND status='running' AND stage IN ('clean','dedup') ORDER BY created_at DESC,rowid DESC LIMIT 1", reviewID)
		if e == nil && r != nil {
			_, _ = s.finalize(s.ctx, projectRun(r), false)
		}
	}()
}
func (s *Service) DescribeReview(ctx context.Context, id string) (string, map[string]string) {
	s.reviewBinding.RLock()
	defer s.reviewBinding.RUnlock()
	s.mu.Lock()
	r := s.owners[id]
	s.mu.Unlock()
	if r == nil {
		if saved, e := s.deps.Store.QueryRow(ctx, "SELECT id AS run_id,dataset_id,stage FROM dataset_stage_runs WHERE ref_id=? AND stage IN ('clean','dedup') ORDER BY created_at DESC,rowid DESC LIMIT 1", id); e == nil {
			r = saved
		}
	}
	if r == nil {
		return "", nil
	}
	title := "去重分析"
	if text(r["stage"]) == "clean" {
		title = "清洗分析"
	}
	return title, map[string]string{"dataset_id": text(r["dataset_id"]), "stage": text(r["stage"]), "run_id": text(r["run_id"])}
}
