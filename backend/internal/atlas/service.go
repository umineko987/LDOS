// Package atlas owns semantic-map jobs, durable results and dataset projections.
package atlas

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/config"
	"ldos/backend/internal/store"
)

type Record = map[string]any
type DatasetCallbacks struct {
	StageInput func(context.Context, string, string) ([]Record, error)
	HashAsset  func(context.Context, string) (string, error)
	SetAside   func(context.Context, string, string, []string, string) (Record, error)
	PutBack    func(context.Context, string, string, []string, string) (Record, error)
}
type GalleryCallbacks struct {
	OpenImage func(context.Context, string, string) (*os.File, error)
	Thumbnail func(string, int64, int) (string, error)
	Captions  func(context.Context, []string) (map[string]string, error)
}
type Dependencies struct {
	Store            *store.Store
	Settings         config.Settings
	PythonExecutable func() string
	Jobs             *activity.Registry
	Events           *activity.Bus
	Datasets         DatasetCallbacks
	Gallery          GalleryCallbacks
}
type Error struct {
	Status        int
	Code, Message string
}

func (e *Error) Error() string                        { return e.Message }
func failure(status int, code, message string) *Error { return &Error{status, code, message} }

type activeRun struct {
	dataset, id, job, phase string
	options                 Record
	force                   bool
	started                 float64
	done, total             *int
	cancel                  context.CancelFunc
	finished                chan struct{}
}
type loadedRun struct{ meta, payload Record }
type Service struct {
	deps                       Dependencies
	ctx                        context.Context
	cancel                     context.CancelFunc
	root                       string
	mu                         sync.Mutex
	active                     map[string]*activeRun
	failures                   map[string]Record
	enabled, stopping, started bool
	gate                       chan struct{}
	wg                         sync.WaitGroup
	cacheMu                    sync.Mutex
	cache                      map[string]loadedRun
	cacheOrder                 []string
}

var datasetID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var runID = regexp.MustCompile(`^\d{13}-[0-9a-f]{8}$`)
var sheetName = regexp.MustCompile(`^sprites/sheet-\d{4}\.(webp|png)$`)
var phaseLabels = map[string]string{"queued": "排队中", "preparing": "整理输入", "hashing": "计算文件哈希", "read": "读取图片", "embed": "计算嵌入", "pca": "降维", "neighbors": "近邻", "layout": "布局", "cluster": "聚类", "write": "写出结果"}

func New(ctx context.Context, deps Dependencies) (*Service, error) {
	if deps.Store == nil || deps.Datasets.StageInput == nil {
		return nil, errors.New("atlas: Store and Datasets.StageInput are required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithCancel(ctx)
	return &Service{deps: deps, ctx: ctx, cancel: cancel, root: filepath.Join(deps.Settings.RuntimeDir, "atlas"), active: map[string]*activeRun{}, failures: map[string]Record{}, enabled: deps.Settings.Dedup.Enabled, gate: make(chan struct{}, 1), cache: map[string]loadedRun{}}, nil
}
func (s *Service) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping {
		return errors.New("atlas stopped")
	}
	if s.started {
		return nil
	}
	if e := s.cleanupOrphans(s.ctx); e != nil {
		return e
	}
	s.started = true
	return nil
}
func (s *Service) Stop() error {
	s.mu.Lock()
	s.stopping = true
	s.cancel()
	for _, run := range s.active {
		run.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}
func (s *Service) Enable() error { s.mu.Lock(); s.enabled = true; s.mu.Unlock(); return nil }
func (s *Service) Availability() Record {
	s.mu.Lock()
	enabled := s.enabled
	s.mu.Unlock()
	reason := ""
	if !enabled {
		reason = "dedup_disabled"
	} else if !regularFile(s.pythonExecutable()) {
		reason = "python_missing"
	} else if !regularFile(s.deps.Settings.Dedup.AtlasScript) {
		reason = "worker_missing"
	}
	return Record{"available": reason == "", "reason": reason}
}
func regularFile(path string) bool { st, e := os.Stat(path); return e == nil && st.Mode().IsRegular() }
func (s *Service) require(ctx context.Context, id string) (Record, error) {
	if !datasetID.MatchString(id) {
		return nil, failure(404, "dataset_not_found", "数据集不存在")
	}
	r, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM datasets WHERE id=?", id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, failure(404, "dataset_not_found", "数据集不存在")
	}
	return r, nil
}
func (s *Service) members(ctx context.Context, id string) ([]Record, error) {
	return s.deps.Datasets.StageInput(ctx, id, "tag")
}
func (s *Service) runDir(id, run string) string { return filepath.Join(s.root, id, "runs", run) }
func (s *Service) publish(id, status, run string) {
	if s.deps.Events != nil {
		_, _ = s.deps.Events.Publish("atlas.updated", Record{"dataset_id": id, "status": status, "run_id": run})
	}
}
func now() float64 { return float64(time.Now().UnixNano()) / 1e9 }
func clone(v Record) Record {
	out := Record{}
	for k, x := range v {
		out[k] = x
	}
	return out
}
func (s *Service) State(id string) Record {
	s.mu.Lock()
	r := s.active[id]
	var progress, run, err any
	if r != nil {
		progress = Record{"phase": r.phase, "label": label(r.phase), "done": r.done, "total": r.total}
		run = r.id
	}
	if v := s.failures[id]; v != nil {
		err = clone(v)
	}
	s.mu.Unlock()
	return Record{"running": r != nil, "run_id": run, "progress": progress, "error": err, "availability": s.Availability()}
}
func label(phase string) string {
	if v := phaseLabels[phase]; v != "" {
		return v
	}
	return phase
}
func (s *Service) setPhase(r *activeRun, phase string, done, total *int) {
	s.mu.Lock()
	r.phase, r.done, r.total = phase, done, total
	s.mu.Unlock()
	if s.deps.Jobs != nil {
		message := label(phase)
		_, _ = s.deps.Jobs.Update(r.job, activity.UpdateOptions{Status: activity.StatusRunning, Current: done, Total: total, Message: &message})
	}
}
func (s *Service) Remove(ctx context.Context, id string, ids []string) (Record, error) {
	if _, e := s.require(ctx, id); e != nil {
		return nil, e
	}
	if s.deps.Datasets.SetAside == nil {
		return nil, failure(503, "atlas_unavailable", "数据集移除接口未连接")
	}
	return s.deps.Datasets.SetAside(ctx, id, "dedup", ids, "atlas")
}
func (s *Service) Restore(ctx context.Context, id string, ids []string) (Record, error) {
	if _, e := s.require(ctx, id); e != nil {
		return nil, e
	}
	if s.deps.Datasets.PutBack == nil {
		return nil, failure(503, "atlas_unavailable", "数据集恢复接口未连接")
	}
	return s.deps.Datasets.PutBack(ctx, id, "dedup", ids, "atlas")
}
