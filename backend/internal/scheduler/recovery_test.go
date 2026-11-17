package scheduler

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"ldos/backend/internal/store"
)

func TestStartupCleansStaleBeforeRecovering(t *testing.T) {
	s, db := setup(t, runnerFunc(func(context.Context, string, RunRequest) (RunResult, error) {
		code := 0
		return RunResult{ExitCode: &code}, nil
	}), nil, nil)
	createTask(t, db, "task", "danbooru", "direct", 3, map[string]any{})
	ctx := context.Background()
	if _, err := db.ClaimTask(ctx, "task"); err != nil {
		t.Fatal(err)
	}
	attempt, err := db.BeginAttempt(ctx, "task")
	if err != nil {
		t.Fatal(err)
	}
	if err = db.SetProcess(ctx, "task", attempt["id"].(string), 1234, "test-marker"); err != nil {
		t.Fatal(err)
	}
	if err = s.Start(ctx); err == nil {
		t.Fatal("recovered a task without stale-process cleanup")
	}
	row, err := db.GetTask(ctx, "task")
	if err != nil || row["status"] != "running" {
		t.Fatal(row, err)
	}
	var cleaned atomic.Bool
	s.deps.TerminateStale = func(_ context.Context, pid int, marker string) error {
		if pid != 1234 || marker != "test-marker" {
			return errors.New("wrong process identity")
		}
		row, err := db.GetTask(ctx, "task")
		if err != nil {
			return err
		}
		if row["status"] != "running" {
			return errors.New("recovered before terminating worker")
		}
		cleaned.Store(true)
		return nil
	}
	startScheduler(t, s)
	waitTask(t, db, "task", succeeded)
	if !cleaned.Load() {
		t.Fatal("stale cleanup skipped")
	}
}

// Inject cancellation after the scheduler has read the final-state snapshot.
type cancellingStore struct {
	*store.Store
	cancelled atomic.Bool
}

func (s *cancellingStore) CompleteTask(ctx context.Context, id, status string, opts store.CompleteTaskOptions) (map[string]any, error) {
	if status == "succeeded" && s.cancelled.CompareAndSwap(false, true) {
		if _, err := s.Store.RequestCancel(ctx, id); err != nil {
			return nil, err
		}
	}
	return s.Store.CompleteTask(ctx, id, status, opts)
}

func TestCancelBetweenSnapshotAndCompletionWins(t *testing.T) {
	s, db := setup(t, runnerFunc(func(context.Context, string, RunRequest) (RunResult, error) {
		code := 0
		return RunResult{ExitCode: &code}, nil
	}), nil, nil)
	s.db = &cancellingStore{Store: db}
	createTask(t, db, "task", "danbooru", "direct", 1, map[string]any{})
	startScheduler(t, s)
	row := waitTask(t, db, "task", func(r map[string]any) bool { return r["status"] == "cancelled" })
	if row["last_error_class"] != "cancelled" || row["cancel_requested"] != true {
		t.Fatal(row)
	}
}

func TestSchedulerCanRestartAfterStop(t *testing.T) {
	s, db := setup(t, runnerFunc(func(context.Context, string, RunRequest) (RunResult, error) {
		code := 0
		return RunResult{ExitCode: &code}, nil
	}), nil, nil)
	startScheduler(t, s)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := s.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	createTask(t, db, "task", "danbooru", "direct", 1, map[string]any{})
	startScheduler(t, s)
	waitTask(t, db, "task", succeeded)
}
