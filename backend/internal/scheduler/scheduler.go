// Package scheduler owns task dispatch and final-state transitions in Go.
package scheduler

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"
)

type activeTask struct {
	site   string
	cancel context.CancelFunc
}

type Scheduler struct {
	db                                   Repository
	deps                                 Dependencies
	settings                             Settings
	lifecycle                            sync.Mutex
	mu                                   sync.Mutex
	active                               map[string]activeTask
	blocked                              map[string]struct{}
	wake                                 chan struct{}
	done                                 chan struct{}
	cancel                               context.CancelFunc
	running, stopping                    bool
	failures                             int
	lastErrorCategory                    string
	lastError, lastSuccess, lastRecovery float64
	workers                              sync.WaitGroup
	logs                                 *logWriter
}

func New(db Repository, deps Dependencies, settings Settings) (*Scheduler, error) {
	if db == nil || deps.Runner == nil || deps.Proxy == nil || deps.ValidateCredentials == nil {
		return nil, errors.New("scheduler requires native storage, runner, proxy and credential services")
	}
	if settings.MaxConcurrent < 1 || settings.PollInterval <= 0 || settings.ShutdownGrace <= 0 || settings.RetryJitter < 0 || settings.RetryBackoffCap < 0 || math.IsNaN(settings.RetryJitter) || math.IsInf(settings.RetryJitter, 0) || math.IsNaN(settings.RetryBackoffCap) || math.IsInf(settings.RetryBackoffCap, 0) {
		return nil, errors.New("invalid scheduler settings")
	}
	return &Scheduler{db: db, deps: deps, settings: settings, active: map[string]activeTask{}, blocked: map[string]struct{}{}, wake: make(chan struct{}, 1)}, nil
}

func (s *Scheduler) Start(ctx context.Context) error {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	s.mu.Lock()
	running := s.running
	s.mu.Unlock()
	if running {
		return nil
	}
	stale, err := s.db.IncompleteProcesses(ctx)
	if err != nil {
		return err
	}
	for _, row := range stale {
		pid := intField(row, "pid")
		if pid <= 0 {
			continue
		}
		if s.deps.TerminateStale == nil {
			return errors.New("stale process cleanup is required before recovering tasks")
		}
		if err := s.deps.TerminateStale(ctx, pid, stringField(row, "process_marker")); err != nil {
			return err
		}
	}
	if _, err = s.db.RecoverIncomplete(ctx); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	loopCtx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	s.cancel = cancel
	s.done = make(chan struct{})
	s.running = true
	s.stopping = false
	s.failures = 0
	s.lastErrorCategory = ""
	s.lastError = 0
	s.lastSuccess = 0
	s.lastRecovery = 0
	s.blocked = map[string]struct{}{}
	s.mu.Unlock()
	s.logs = newLogWriter(s.db)
	s.logs.start()
	go s.loop(loopCtx)
	s.Notify()
	return nil
}

func (s *Scheduler) Stop(ctx context.Context) error {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	s.mu.Lock()
	if s.done == nil {
		s.mu.Unlock()
		return nil
	}
	s.stopping = true
	s.cancel()
	done := s.done
	s.mu.Unlock()
	s.Notify()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Scheduler) Notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Scheduler) loop(ctx context.Context) {
	defer func() {
		s.workers.Wait()
		s.logs.close()
		s.mu.Lock()
		s.running = false
		s.stopping = true
		close(s.done)
		s.mu.Unlock()
	}()
	ticker := time.NewTicker(s.settings.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
		case <-ticker.C:
		}
		if ctx.Err() != nil {
			return
		}
		if err := s.dispatch(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			s.recordFailure("dispatch_error")
		} else {
			s.recordSuccess()
		}
	}
}

func (s *Scheduler) dispatch(ctx context.Context) error {
	ids := make([]string, 0, len(s.blocked))
	for id := range s.blocked {
		ids = append(ids, id)
	}
	if len(ids) > 0 {
		queued, err := s.db.QueuedTaskIDs(ctx, ids)
		if err != nil {
			return err
		}
		for id := range s.blocked {
			if _, ok := queued[id]; !ok {
				delete(s.blocked, id)
			}
		}
	}
	s.mu.Lock()
	capacity := s.settings.MaxConcurrent - len(s.active)
	sites := map[string]int{}
	for _, entry := range s.active {
		sites[entry.site]++
	}
	s.mu.Unlock()
	saturated := []string{}
	seen := map[string]bool{}
	for round := 0; round < 3 && capacity > 0; round++ {
		queued, err := s.db.QueuedTasks(ctx, 200, saturated)
		if err != nil {
			return err
		}
		if len(queued) == 0 {
			break
		}
		hitLimit := false
		for _, task := range queued {
			if capacity <= 0 {
				break
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			id, site := stringField(task, "id"), stringField(task, "site")
			p, err := ParsePolicy(task["policy"])
			if err != nil {
				return err
			}
			valid, err := s.deps.ValidateCredentials(ctx, site, stringField(task, "cookies_file"))
			if err != nil {
				return err
			}
			if !valid {
				if _, recorded := s.blocked[id]; !recorded {
					updated, err := s.db.MarkTaskCredentialsUnavailable(ctx, id, site)
					if err != nil {
						return err
					}
					if updated {
						s.blocked[id] = struct{}{}
					}
				}
				continue
			}
			delete(s.blocked, id)
			if sites[site] >= p.MaxConcurrency {
				if !seen[site] {
					seen[site] = true
					saturated = append(saturated, site)
				}
				hitLimit = true
				continue
			}
			claimed, err := s.db.ClaimTask(ctx, id)
			if err != nil {
				return err
			}
			if !claimed {
				continue
			}
			workerCtx, cancel := context.WithCancel(ctx)
			s.mu.Lock()
			s.active[id] = activeTask{site: site, cancel: cancel}
			s.mu.Unlock()
			s.workers.Add(1)
			go func() {
				defer s.workers.Done()
				defer func() { cancel(); s.mu.Lock(); delete(s.active, id); s.mu.Unlock(); s.Notify() }()
				if err := s.execute(workerCtx, ctx, id); err != nil {
					s.recordFailure("attempt_persistence_error")
				}
			}()
			sites[site]++
			capacity--
		}
		if !hitLimit {
			break
		}
	}
	return nil
}

func (s *Scheduler) Cancel(ctx context.Context, id string) (map[string]any, error) {
	task, err := s.db.RequestCancel(ctx, id)
	if err != nil || task == nil {
		return task, err
	}
	s.mu.Lock()
	entry, ok := s.active[id]
	s.mu.Unlock()
	if ok {
		entry.cancel()
	}
	s.Notify()
	return s.db.GetTask(ctx, id)
}

func (s *Scheduler) Retry(ctx context.Context, id string, attempts int) (map[string]any, error) {
	batch, err := s.db.TaskCrawlBatchID(ctx, id)
	if err != nil {
		return nil, err
	}
	if batch != "" {
		return nil, fmt.Errorf("%w: %s", ErrCrawlOwned, batch)
	}
	task, err := s.db.RetryTask(ctx, id, attempts)
	if err == nil {
		s.Notify()
	}
	return task, err
}

func (s *Scheduler) recordFailure(category string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failures++
	s.lastErrorCategory = category
	s.lastError = unixNow()
}
func (s *Scheduler) recordSuccess() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastSuccess = unixNow()
	if s.failures > 0 {
		s.lastRecovery = s.lastSuccess
		s.failures = 0
	}
}
func unixNow() float64 { return float64(time.Now().UnixNano()) / 1e9 }
func timestamp(value float64) any {
	if value == 0 {
		return nil
	}
	return value
}

func (s *Scheduler) Summary() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := "not_started"
	if s.stopping {
		state = "stopped"
		if s.running {
			state = "stopping"
		}
	} else if s.running {
		state = "running"
		if s.failures > 0 {
			state = "degraded"
		}
	}
	sites := map[string]int{}
	for _, entry := range s.active {
		sites[entry.site]++
	}
	var category any
	if s.lastErrorCategory != "" {
		category = s.lastErrorCategory
	}
	return map[string]any{"running": s.running && !s.stopping, "active": len(s.active), "max_concurrent": s.settings.MaxConcurrent, "sites": sites, "dispatch_loop": map[string]any{
		"state": state, "running": s.running && !s.stopping, "operational": true, "consecutive_failures": s.failures, "last_error_category": category, "last_error_at": timestamp(s.lastError), "last_success_at": timestamp(s.lastSuccess), "last_recovery_at": timestamp(s.lastRecovery),
	}}
}
