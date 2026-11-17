package reviews

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/store"
)

type Service struct {
	deps             Dependencies
	ctx              context.Context
	cancel           context.CancelFunc
	runtime          string
	mu               sync.Mutex // lifecycle, worker ownership, listeners, and commit gate
	startMu          sync.Mutex
	enabled          atomic.Bool
	op               sync.Mutex // serialized user decisions and file workflows
	runMu            sync.Mutex // exactly one inference/automatic apply at a time
	wg               sync.WaitGroup
	started, stopped bool
	wake             chan struct{}
	current          identity
	currentCancel    context.CancelFunc
	currentDone      chan struct{}
	listeners        []func(string)
}

func New(ctx context.Context, deps Dependencies) (*Service, error) {
	if deps.Store == nil {
		return nil, errors.New("reviews: Store is required")
	}
	if ctx == nil {
		return nil, errors.New("reviews: context is required")
	}
	d := &deps.Dedup
	if *d == (Settings{}) {
		c := deps.Settings.Dedup
		*d = Settings{Enabled: c.Enabled, PythonExecutable: c.PythonExecutable, WorkerScript: c.WorkerScript, CoreScript: c.CoreScript, ModelDir: c.ModelDir, Device: c.Device, Workers: c.Workers, TorchThreads: c.TorchThreads, TorchInteropThreads: c.TorchInteropThreads, DeepBatchSize: c.DeepBatchSize, NeighborBlockSize: c.NeighborBlockSize, NoSSCD: c.NoSSCD, NoDINO: c.NoDINO, PollInterval: time.Duration(c.PollIntervalSeconds * float64(time.Second)), ShutdownGrace: time.Duration(c.ShutdownGraceSeconds * float64(time.Second))}
	}
	if d.Device == "" {
		d.Device = "auto"
	}
	if d.Device != "auto" && d.Device != "cpu" && d.Device != "cuda" {
		return nil, errors.New("reviews: invalid device")
	}
	for _, v := range [][2]int{{d.Workers, 64}, {d.TorchThreads, 128}, {d.TorchInteropThreads, 16}, {d.DeepBatchSize, 128}, {d.NeighborBlockSize, 8192}} {
		if v[0] < 0 || v[0] > v[1] {
			return nil, errors.New("reviews: invalid resource bounds")
		}
	}
	if d.PollInterval == 0 {
		d.PollInterval = time.Second
	}
	if d.ShutdownGrace == 0 {
		d.ShutdownGrace = 5 * time.Second
	}
	if d.PollInterval < 0 || d.ShutdownGrace < 0 {
		return nil, errors.New("reviews: invalid lifecycle interval")
	}
	if deps.Settings.RuntimeDir == "" {
		return nil, errors.New("reviews: runtime directory is required")
	}
	root, e := filepath.Abs(filepath.Join(deps.Settings.RuntimeDir, "reviews"))
	if e != nil {
		return nil, e
	}
	life, cancel := context.WithCancel(ctx)
	s := &Service{deps: deps, ctx: life, cancel: cancel, runtime: root, wake: make(chan struct{}, 1)}
	s.enabled.Store(deps.Dedup.Enabled)
	return s, nil
}

// Start recovers interrupted work, preserving every gallery decision and snapshot.
// Legacy snapshots remain blocked until explicit, validated retry.
func (s *Service) Start() error {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	s.mu.Lock()
	if s.stopped || s.ctx.Err() != nil {
		s.mu.Unlock()
		return context.Canceled
	}
	if s.started {
		s.mu.Unlock()
		return nil
	}
	s.started = true
	s.wg.Add(1)
	s.mu.Unlock()
	defer s.wg.Done()
	s.op.Lock()
	defer s.op.Unlock()
	ctx := s.ctx
	if s.deps.Gallery.RecoverFiles != nil {
		if e := s.deps.Gallery.RecoverFiles(ctx); e != nil {
			s.resetStart()
			return e
		}
	}
	if e := s.write(ctx, func(tx *sql.Tx) error {
		for _, i := range []identity{{gallery: false}, {gallery: true}} {
			r, _, _, col := i.tables()
			guard := ""
			if i.gallery {
				guard = " AND NOT EXISTS(SELECT 1 FROM meta WHERE key='legacy_gallery_review:'||" + col + ")"
			}
			if _, e := tx.ExecContext(ctx, "UPDATE "+r+" SET status='pending',updated_at=?,error='服务重启，重新执行去重分析' WHERE status='analyzing'"+guard, now()); e != nil {
				return e
			}
			if _, e := tx.ExecContext(ctx, "UPDATE "+r+" SET status='apply_failed',updated_at=?,error='服务重启，需重试应用审核结果' WHERE status='applying'"+guard, now()); e != nil {
				return e
			}
		}
		return nil
	}); e != nil {
		s.resetStart()
		return e
	}
	if e := privateDirectory(s.runtime); e != nil {
		s.resetStart()
		return e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped || s.ctx.Err() != nil {
		return context.Canceled
	}
	s.wg.Add(1)
	go s.loop()
	return nil
}

// Enable activates processing after model setup without restarting the service.
func (s *Service) Enable() error {
	s.mu.Lock()
	if s.stopped || s.ctx.Err() != nil {
		s.mu.Unlock()
		return context.Canceled
	}
	s.enabled.Store(true)
	s.mu.Unlock()
	if e := s.Start(); e != nil {
		return e
	}
	s.Notify()
	return nil
}

// SetActivityDescription may be wired after the dataset stage service is created.
func (s *Service) SetActivityDescription(fn func(context.Context, string) (string, map[string]string)) {
	s.mu.Lock()
	s.deps.DescribeReview = fn
	s.mu.Unlock()
}
func (s *Service) resetStart() { s.mu.Lock(); s.started = false; s.mu.Unlock() }
func (s *Service) Stop() error {
	s.mu.Lock()
	s.stopped = true
	s.cancel()
	if s.currentCancel != nil {
		s.currentCancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}
func (s *Service) Notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
func (s *Service) AddListener(fn func(string)) {
	if fn == nil {
		return
	}
	s.mu.Lock()
	s.listeners = append(s.listeners, fn)
	s.mu.Unlock()
}
func (s *Service) changed(i identity) {
	if !i.gallery {
		return
	}
	s.mu.Lock()
	listeners := append([]func(string){}, s.listeners...)
	live := !s.stopped && s.ctx.Err() == nil
	s.mu.Unlock()
	if live {
		for _, fn := range listeners {
			func() { defer func() { _ = recover() }(); fn(i.id) }()
		}
	}
}
func (s *Service) begin(ctx context.Context) (context.Context, func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped || s.ctx.Err() != nil {
		return nil, nil, context.Canceled
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	owned, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(s.ctx, cancel)
	s.wg.Add(1)
	return owned, func() { stop(); cancel(); s.wg.Done() }, nil
}
func (s *Service) write(ctx context.Context, fn func(*sql.Tx) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped || s.ctx.Err() != nil {
		return context.Canceled
	}
	if e := ctx.Err(); e != nil {
		return e
	}
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
func (s *Service) loop() {
	defer s.wg.Done()
	ticker := time.NewTicker(s.deps.Dedup.PollInterval)
	defer ticker.Stop()
	for {
		if s.ctx.Err() != nil {
			return
		}
		worked, e := s.runOnce(s.ctx)
		if worked && e == nil {
			continue
		}
		select {
		case <-s.ctx.Done():
			return
		case <-s.wake:
		case <-ticker.C:
		}
	}
}

// RunOnce allows an embedding scheduler/test to drive one serialized unit of work.
func (s *Service) RunOnce(ctx context.Context) (bool, error) {
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return false, e
	}
	defer done()
	return s.runOnce(ctx)
}
func (s *Service) runOnce(ctx context.Context) (bool, error) {
	if !s.enabled.Load() {
		return false, nil
	}
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if e := ctx.Err(); e != nil {
		return false, e
	}
	s.op.Lock()
	input, automatic, e := s.claim(ctx)
	if e != nil || input == nil {
		s.op.Unlock()
		return false, e
	}
	i := input.identity()
	owned, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	if s.stopped || ctx.Err() != nil {
		s.mu.Unlock()
		s.op.Unlock()
		cancel()
		return false, context.Canceled
	}
	finished := make(chan struct{})
	s.current = i
	s.currentCancel = cancel
	s.currentDone = finished
	s.mu.Unlock()
	s.op.Unlock()
	defer func() {
		cancel()
		s.mu.Lock()
		s.current = identity{}
		s.currentCancel = nil
		s.currentDone = nil
		close(finished)
		s.mu.Unlock()
		s.changed(i)
	}()
	jobID := "review:" + i.id
	if s.deps.Jobs != nil {
		title := "去重审核"
		ref := map[string]string{"review_id": i.id}
		s.mu.Lock()
		describe := s.deps.DescribeReview
		s.mu.Unlock()
		if describe != nil {
			custom, metadata := describe(owned, i.id)
			if custom != "" {
				title = custom
			}
			for k, v := range metadata {
				ref[k] = v
			}
			ref["review_id"] = i.id
		}
		_, _ = s.deps.Jobs.Start("dedup.review", title, activity.StartOptions{ID: jobID, Ref: ref, Total: optionalCount(len(input.Images))})
	}
	var logPath string
	if automatic {
		s.op.Lock()
		e = s.applyAutomatic(owned, *input)
		s.op.Unlock()
	} else {
		if i.gallery {
			e = s.validateInput(owned, *input)
		}
		var manifest Manifest
		if e == nil {
			if s.deps.Runner != nil {
				manifest, logPath, e = s.deps.Runner(owned, *input)
			} else {
				manifest, logPath, e = s.runWorker(owned, *input)
			}
		}
		if e == nil {
			e = validateManifest(*input, manifest)
		}
		if e == nil && i.gallery {
			e = s.validateInput(owned, *input)
		}
		if e == nil {
			e = s.replaceManifest(owned, i, manifest, logPath)
		}
		if e == nil {
			r, er := s.get(owned, i)
			e = er
			if er == nil && text(r["status"]) == "auto_applying" {
				s.op.Lock()
				e = s.applyAutomatic(owned, *input)
				s.op.Unlock()
			}
		}
	}
	if owned.Err() != nil {
		e = owned.Err()
	} else if e != nil {
		errText := safeError(e)
		_ = s.write(owned, func(tx *sql.Tx) error {
			r, _, _, c := i.tables()
			_, err := tx.ExecContext(owned, "UPDATE "+r+" SET status='failed',error=?,analysis_log_path=?,updated_at=? WHERE "+c+"=? AND status='analyzing'", errText, logPath, now(), i.id)
			return err
		})
	}
	if s.deps.Jobs != nil {
		status := activity.StatusSucceeded
		if e != nil {
			status = activity.StatusFailed
		}
		if owned.Err() != nil {
			status = activity.StatusCancelled
		}
		msg := ""
		if e != nil {
			msg = safeError(e)
		}
		var total *int
		if owned.Err() == nil {
			if review, err := s.get(owned, i); err == nil {
				total = optionalCount(int(number(review["total_image_count"])))
			}
		}
		_, _ = s.deps.Jobs.Finish(jobID, activity.FinishOptions{Status: status, Message: &msg, Total: total})
	}
	return true, e
}
func (s *Service) claim(ctx context.Context) (*WorkerInput, bool, error) {
	var input *WorkerInput
	automatic := false
	e := s.write(ctx, func(tx *sql.Tx) error {
		// Complete interrupted automatic file handoffs before launching any new model.
		for _, state := range []string{"auto_applying", "pending"} {
			for _, gallery := range []bool{true, false} {
				i := identity{gallery: gallery}
				r, _, _, c := i.tables()
				q := "SELECT r.* FROM " + r + " r "
				if gallery {
					q += "WHERE r.status=? AND NOT EXISTS(SELECT 1 FROM meta WHERE key='legacy_gallery_review:'||r.review_id) ORDER BY r.created_at LIMIT 1"
				} else {
					q = "SELECT r.*,b.output_dir FROM " + r + " r JOIN crawl_batches b ON b.id=r.batch_id WHERE r.status=? AND b.status IN ('succeeded','completed_with_errors','cancelled') ORDER BY b.finished_at,b.created_at LIMIT 1"
				}
				row, e := store.QueryRowTx(ctx, tx, q, state)
				if e != nil {
					return e
				}
				if row == nil {
					continue
				}
				i.id = text(row[c])
				automatic = state == "auto_applying"
				if gallery {
					v, e := inputRow(row)
					if e != nil {
						return e
					}
					input = &v
				} else {
					input = &WorkerInput{BatchID: i.id, OutputDir: text(row["output_dir"])}
				}
				if !automatic {
					bump := ""
					if gallery {
						bump = ",version=version+1"
					}
					_, e = tx.ExecContext(ctx, "UPDATE "+r+" SET status='analyzing',started_at=?,updated_at=?,ready_at=NULL,applied_at=NULL,error=''"+bump+" WHERE "+c+"=? AND status='pending'", now(), now(), i.id)
					if e != nil {
						return e
					}
				}
				return nil
			}
		}
		return nil
	})
	return input, automatic, e
}
func optionalCount(n int) *int {
	if n <= 0 {
		return nil
	}
	return &n
}
func inputRow(row Row) (WorkerInput, error) {
	v := WorkerInput{ReviewID: text(row["review_id"])}
	for _, field := range []struct {
		key  string
		dest any
	}{{"snapshot_json", &v.Images}, {"reference_snapshot_json", &v.References}, {"filter_config_json", &v.FilterConfig}} {
		raw := text(row[field.key])
		if raw == "" {
			continue
		}
		if err := decodeJSON(raw, field.dest); err != nil {
			return v, fmt.Errorf("invalid review snapshot: %w", err)
		}
	}
	return v, nil
}
