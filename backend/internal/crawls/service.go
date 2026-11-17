package crawls

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/redaction"
)

func (s *Service) Notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
func (s *Service) recordError(err error) {
	if err != nil && !errors.Is(err, context.Canceled) {
		s.mu.Lock()
		s.lastError = redaction.Text(err.Error(), 2000)
		s.mu.Unlock()
	}
}

// Start recovers durable cursors before launching independent batch workers.
// Repeated starts/stops are safe; the service never owns the shared DB lifecycle.
func (s *Service) Start() error {
	s.life.Lock()
	defer s.life.Unlock()
	if s.cancel != nil {
		return nil
	}
	if err := s.parent.Err(); err != nil {
		return err
	}
	if err := s.Recover(s.parent); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(s.parent)
	s.cancel = cancel
	s.done = make(chan struct{})
	go s.supervise(ctx, s.done)
	return nil
}
func (s *Service) Stop() error {
	s.life.Lock()
	defer s.life.Unlock()
	if s.cancel == nil {
		return nil
	}
	s.cancel()
	<-s.done
	s.cancel = nil
	return nil
}
func (s *Service) Status() map[string]any {
	s.life.Lock()
	running := s.cancel != nil
	s.life.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := []string{}
	for id := range s.batches {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return map[string]any{"running": running, "active_batch_count": len(ids), "active_batch_ids": ids, "max_concurrent_batches": s.deps.Settings.Scheduler.MaxConcurrentBatches, "last_error": s.lastError}
}
func (s *Service) activeIDs(ctx context.Context) ([]string, error) {
	rows, err := s.deps.Store.QueryRows(ctx, "SELECT id FROM crawl_batches WHERE status IN ('queued','running','cancelling') ORDER BY created_at,id")
	ids := []string{}
	for _, r := range rows {
		ids = append(ids, str(r["id"]))
	}
	return ids, err
}
func (s *Service) supervise(ctx context.Context, done chan struct{}) {
	var workers sync.WaitGroup
	defer func() { workers.Wait(); close(done) }()
	ticker := time.NewTicker(s.deps.PollInterval)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		ids, err := s.activeIDs(ctx)
		if err != nil {
			s.recordError(err)
		} else {
			for _, id := range ids {
				s.mu.Lock()
				_, exists := s.batches[id]
				if !exists && len(s.batches) < s.deps.Settings.Scheduler.MaxConcurrentBatches {
					s.batches[id] = make(chan struct{})
					workers.Add(1)
					go func(id string) {
						defer workers.Done()
						defer func() { s.mu.Lock(); delete(s.batches, id); s.mu.Unlock(); s.Notify() }()
						s.batchLoop(ctx, id)
					}(id)
				}
				s.mu.Unlock()
			}
		}
		// Completion callbacks are retried after failures and replayed after restart.
		// They may use durable idempotency in their own domain; no second DB is opened.
		if s.deps.BatchComplete != nil {
			rows, e := s.deps.Store.QueryRows(ctx, "SELECT id,finished_at FROM crawl_batches WHERE status IN ('succeeded','completed_with_errors','cancelled') ORDER BY finished_at,id")
			if e != nil {
				s.recordError(e)
			} else {
				for _, r := range rows {
					if ctx.Err() != nil {
						return
					}
					s.mu.Lock()
					notified := s.notified[str(r["id"])]
					s.mu.Unlock()
					if notified == number(r["finished_at"]) {
						continue
					}
					if e = s.handoff(ctx, str(r["id"])); e != nil {
						s.recordError(e)
					}
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
		case <-ticker.C:
		}
	}
}
func (s *Service) batchLoop(ctx context.Context, id string) {
	if s.deps.Jobs != nil {
		job, err := s.deps.Jobs.Start("crawl.batch", "顺序爬取", activity.StartOptions{ID: "crawl:" + id, Ref: map[string]string{"batch_id": id}})
		if err == nil {
			defer func() {
				status := activity.StatusSucceeded
				b, e := s.tickView(context.WithoutCancel(ctx), id)
				if e != nil || b != nil && str(b["status"]) == "completed_with_errors" {
					status = activity.StatusFailed
				} else if ctx.Err() != nil || b != nil && (str(b["status"]) == "paused" || str(b["status"]) == "cancelled") {
					status = activity.StatusCancelled
				}
				_, _ = s.deps.Jobs.Finish(job.ID, activity.FinishOptions{Status: status})
			}()
		}
	}
	ticker := time.NewTicker(s.deps.PollInterval)
	defer ticker.Stop()
	for {
		active, err := s.tick(ctx, id)
		if err != nil {
			s.recordError(err)
		}
		if err == nil {
			s.recordError(s.publishProgress(ctx, id))
		}
		if ctx.Err() != nil || err == nil && !active {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (s *Service) tick(ctx context.Context, id string) (bool, error) {
	b, err := s.tickView(ctx, id)
	if err != nil {
		return true, err
	}
	if b == nil || terminal(str(b["status"])) || str(b["status"]) == "paused" {
		return false, nil
	}
	a, err := s.nextAddress(ctx, id)
	if err != nil {
		return true, err
	}
	if flag(b["cancel_requested"]) {
		// This includes links left on addresses made terminal by cancellation of a
		// partially committed plan, so recovery cannot strand their active workers.
		rows, e := s.deps.Store.QueryRows(ctx, `SELECT t.id FROM tasks t JOIN crawl_address_tasks cat ON cat.task_id=t.id JOIN crawl_addresses ca ON ca.id=cat.address_id WHERE ca.batch_id=? AND t.status NOT IN ('succeeded','failed','cancelled')`, id)
		if e != nil {
			return true, e
		}
		ids := []string{}
		for _, r := range rows {
			ids = append(ids, str(r["id"]))
		}
		if e = s.cancelTasks(ctx, ids); e != nil {
			return true, e
		}
		if a != nil && str(a["status"]) == "running" {
			if _, e = s.finishAddress(ctx, str(a["id"])); e != nil {
				return true, e
			}
		}
		done, e := s.finishBatch(ctx, id)
		return !done, e
	}
	if a == nil {
		done, e := s.finishBatch(ctx, id)
		return !done, e
	}
	switch str(a["status"]) {
	case "pending":
		return true, s.activate(ctx, b, a)
	case "running":
		if err = s.releaseHeld(ctx, str(a["id"])); err != nil {
			return true, err
		}
		s.deps.NotifyTasks()
		done, e := s.finishAddress(ctx, str(a["id"]))
		if e != nil {
			return true, e
		}
		if done {
			finished, e := s.finishBatch(ctx, id)
			return !finished, e
		}
	}
	return true, nil
}

// RunOnce is a deterministic, synchronous advancement hook for integrations and
// tests. Production uses the supervisor. It cannot overlap a supervised batch.
func (s *Service) RunOnce(ctx context.Context) error {
	ids, err := s.activeIDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		s.mu.Lock()
		_, busy := s.batches[id]
		if !busy {
			s.batches[id] = make(chan struct{})
		}
		s.mu.Unlock()
		if busy {
			continue
		}
		_, e := s.tick(ctx, id)
		if e == nil {
			e = s.publishProgress(ctx, id)
		}
		s.mu.Lock()
		delete(s.batches, id)
		s.mu.Unlock()
		if e != nil {
			return e
		}
	}
	if s.deps.BatchComplete != nil {
		rows, err := s.deps.Store.QueryRows(ctx, "SELECT id FROM crawl_batches WHERE status IN ('succeeded','completed_with_errors','cancelled')")
		if err != nil {
			return err
		}
		for _, r := range rows {
			if err = s.handoff(ctx, str(r["id"])); err != nil {
				return err
			}
		}
	}
	return nil
}
func (s *Service) handoff(ctx context.Context, id string) error {
	batch, err := s.Get(ctx, id)
	if err != nil || batch == nil || !terminal(str(batch["status"])) {
		return err
	}
	stamp := number(batch["finished_at"])
	s.mu.Lock()
	prior := s.notified[id]
	if prior == stamp || prior < 0 {
		s.mu.Unlock()
		return nil
	}
	s.notified[id] = -stamp
	s.mu.Unlock()
	err = s.deps.BatchComplete(ctx, batch)
	s.mu.Lock()
	if err == nil {
		s.notified[id] = stamp
	} else {
		delete(s.notified, id)
	}
	s.mu.Unlock()
	return err
}
