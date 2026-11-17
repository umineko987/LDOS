package crawls

import (
	"context"
	"database/sql"
	"errors"

	"ldos/backend/internal/store"
)

// Cancel serializes its flag with media insertion, then drains all linked workers.
func (s *Service) Cancel(ctx context.Context, id string) (map[string]any, error) {
	ids := []string{}
	err := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		b, e := store.QueryRowTx(ctx, tx, "SELECT status FROM crawl_batches WHERE id=?", id)
		if e != nil {
			return e
		}
		if b == nil {
			return missing()
		}
		if terminal(str(b["status"])) {
			return nil
		}
		stamp := now()
		if _, e = tx.ExecContext(ctx, "UPDATE crawl_batches SET status='cancelling',cancel_requested=1,updated_at=? WHERE id=?", stamp, id); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `UPDATE crawl_addresses SET status='cancelled',finished_at=?,updated_at=?,last_error='批次已取消' WHERE batch_id=? AND status IN ('pending','planning')`, stamp, stamp, id); e != nil {
			return e
		}
		rows, e := store.QueryRowsTx(ctx, tx, `SELECT t.id FROM crawl_address_tasks cat JOIN crawl_addresses ca ON ca.id=cat.address_id JOIN tasks t ON t.id=cat.task_id WHERE ca.batch_id=? AND t.status NOT IN ('succeeded','failed','cancelled')`, id)
		if e != nil {
			return e
		}
		for _, r := range rows {
			ids = append(ids, str(r["id"]))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = s.cancelTasks(context.WithoutCancel(ctx), ids)
	s.Notify()
	_, finishErr := s.finishBatch(ctx, id)
	if err != nil || finishErr != nil {
		return nil, errors.Join(err, finishErr)
	}
	return s.Get(ctx, id)
}
func (s *Service) cancelTasks(ctx context.Context, ids []string) error {
	var errs []error
	for _, id := range ids {
		if _, e := s.deps.Tasks.Cancel(ctx, id); e != nil {
			errs = append(errs, e)
		}
	}
	return errors.Join(errs...)
}

// Pause is an address-boundary pause: already queued media can drain, while no
// new address or planning chunk is admitted. The paused cursor survives restart.
func (s *Service) Pause(ctx context.Context, id string) (map[string]any, error) {
	err := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		b, e := store.QueryRowTx(ctx, tx, "SELECT status FROM crawl_batches WHERE id=?", id)
		if e != nil {
			return e
		}
		if b == nil {
			return missing()
		}
		if str(b["status"]) == "queued" || str(b["status"]) == "running" {
			_, e = tx.ExecContext(ctx, "UPDATE crawl_batches SET status='paused',updated_at=? WHERE id=?", now(), id)
		}
		return e
	})
	if err != nil {
		return nil, err
	}
	s.Notify()
	return s.Get(ctx, id)
}

// Resume continues a paused cursor. A finished batch uses the legacy retry
// operation to fill failed/cancelled media and incomplete plans.
func (s *Service) Resume(ctx context.Context, id string) (map[string]any, error) {
	b, err := s.tickView(ctx, id)
	if err != nil {
		return nil, err
	}
	if b == nil {
		return nil, missing()
	}
	if terminal(str(b["status"])) {
		result, e := s.Retry(ctx, id, 1)
		if e != nil {
			return nil, e
		}
		return result["batch"].(map[string]any), nil
	}
	if err = s.exec(ctx, "UPDATE crawl_batches SET status='running',updated_at=? WHERE id=? AND status='paused'", now(), id); err != nil {
		return nil, err
	}
	s.Notify()
	return s.Get(ctx, id)
}
func (s *Service) Retry(ctx context.Context, id string, attempts int) (map[string]any, error) {
	return s.reopen(ctx, id, attempts, false, false)
}
func (s *Service) Rerun(ctx context.Context, id string, attempts int, requeueSucceeded bool) (map[string]any, error) {
	return s.reopen(ctx, id, attempts, true, requeueSucceeded)
}

// Later-address retries are kept off the scheduler's runnable queue until their
// cursor is reached. This finite sentinel survives SQLite/JSON round trips.
const heldUntil = 253402300799.0

func (s *Service) reopen(ctx context.Context, id string, attempts int, rerun, success bool) (map[string]any, error) {
	if attempts < 1 || attempts > 20 {
		return nil, &Error{Status: 422, Code: "validation_error", Message: "additional_attempts 必须介于 1 和 20"}
	}
	taskIDs, addressIDs, replanned := []string{}, []string{}, []string{}
	err := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		b, e := store.QueryRowTx(ctx, tx, "SELECT status FROM crawl_batches WHERE id=?", id)
		if e != nil {
			return e
		}
		if b == nil {
			return missing()
		}
		operation := "重试失败任务"
		if rerun {
			operation = "重新爬取"
		}
		if !terminal(str(b["status"])) {
			return &Error{Status: 409, Code: "crawl_not_finished", Message: "批次仍在运行，结束后才能" + operation}
		}
		review, e := store.QueryRowTx(ctx, tx, "SELECT status FROM crawl_reviews WHERE batch_id=?", id)
		if e != nil {
			return e
		}
		if review != nil {
			switch str(review["status"]) {
			case "pending", "analyzing", "applying", "auto_applying":
				return &Error{Status: 409, Code: "review_in_progress", Message: "图片审核进行中，结束后才能" + operation}
			}
		}
		statuses := "('failed','cancelled')"
		if rerun && success {
			statuses = "('failed','cancelled','succeeded')"
		}
		rows, e := store.QueryRowsTx(ctx, tx, `SELECT t.id,t.attempt_count,ca.id AS address_id FROM crawl_address_tasks cat JOIN crawl_addresses ca ON ca.id=cat.address_id JOIN tasks t ON t.id=cat.task_id WHERE ca.batch_id=? AND t.status IN `+statuses+` ORDER BY ca.source_order,ca.address_order,cat.sequence_no`, id)
		if e != nil {
			return e
		}
		stamp := now()
		seen := map[string]bool{}
		for _, r := range rows {
			taskID := str(r["id"])
			prior := integer(r["attempt_count"])
			_, e = tx.ExecContext(ctx, `UPDATE tasks SET status='queued',cancel_requested=0,next_run_at=?,started_at=NULL,finished_at=NULL,updated_at=?,max_attempts=?,pid=NULL,process_marker=NULL,exit_code=NULL,backoff_anchor_attempt=?,tried_proxy_ids_json='[]',version=version+1 WHERE id=?`, heldUntil, stamp, prior+attempts, prior, taskID)
			if e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, "DELETE FROM leases WHERE task_id=?", taskID); e != nil {
				return e
			}
			payload := map[string]any{"batch_id": id, "max_attempts": prior + attempts}
			if rerun {
				payload["rerun"] = true
			}
			if _, e = tx.ExecContext(ctx, "INSERT INTO task_events(task_id,ts,event_type,payload_json) VALUES(?,?,'manually_retried',?)", taskID, stamp, jsonText(payload)); e != nil {
				return e
			}
			taskIDs = append(taskIDs, taskID)
			addressID := str(r["address_id"])
			if !seen[addressID] {
				addressIDs = append(addressIDs, addressID)
				seen[addressID] = true
			}
		}
		if !rerun {
			for _, aid := range addressIDs {
				if _, e = tx.ExecContext(ctx, "UPDATE crawl_addresses SET status='running',finished_at=NULL,updated_at=?,last_error='' WHERE id=? AND status IN ('failed','cancelled')", stamp, aid); e != nil {
					return e
				}
			}
		}
		filter := "planning_error != ''"
		if rerun {
			filter = "status IN ('succeeded','failed','cancelled')"
		}
		addresses, e := store.QueryRowsTx(ctx, tx, "SELECT id FROM crawl_addresses WHERE batch_id=? AND "+filter+" ORDER BY source_order,address_order", id)
		if e != nil {
			return e
		}
		for _, a := range addresses {
			aid := str(a["id"])
			replanned = append(replanned, aid)
			if _, e = tx.ExecContext(ctx, "UPDATE crawl_addresses SET status='pending',planning_error='',last_error='',started_at=NULL,finished_at=NULL,updated_at=? WHERE id=?", stamp, aid); e != nil {
				return e
			}
		}
		if !rerun && len(taskIDs) == 0 && len(replanned) == 0 {
			return &Error{Status: 409, Code: "crawl_no_failed_tasks", Message: "批次没有可重新排队的失败任务或待重规划的地址"}
		}
		if _, e = tx.ExecContext(ctx, "UPDATE crawl_batches SET status='running',cancel_requested=0,finished_at=NULL,updated_at=?,last_error='' WHERE id=?", stamp, id); e != nil {
			return e
		}
		if rerun {
			for _, table := range []string{"crawl_review_images", "crawl_review_groups", "crawl_reviews"} {
				if _, e = tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE batch_id=?", id); e != nil {
					return e
				}
			}
		}
		return refreshCounts(ctx, tx, id)
	})
	if err != nil {
		return nil, err
	}
	s.deps.NotifyTasks()
	s.Notify()
	for _, aid := range addressIDs {
		if _, err = s.finishAddress(ctx, aid); err != nil {
			return nil, err
		}
	}
	if _, err = s.finishBatch(ctx, id); err != nil {
		return nil, err
	}
	batch, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"batch_id": id, "task_ids": taskIDs, "replanned_address_count": len(replanned), "replanned_address_ids": replanned, "batch": batch}
	if rerun {
		result["requeued_task_count"] = len(taskIDs)
		result["requeue_succeeded"] = success
	} else {
		result["retried_count"] = len(taskIDs)
		result["address_ids"] = addressIDs
	}
	return result, nil
}
func (s *Service) releaseHeld(ctx context.Context, addressID string) error {
	return s.exec(ctx, `UPDATE tasks SET next_run_at=? WHERE status='queued' AND next_run_at=? AND id IN(SELECT task_id FROM crawl_address_tasks WHERE address_id=?)`, now(), heldUntil, addressID)
}
