package crawls

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"ldos/backend/internal/redaction"
	"ldos/backend/internal/store"
)

func str(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}
func text(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}
func nullable(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func integer(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	case bool:
		if n {
			return 1
		}
		return 0
	}
	n, _ := strconv.Atoi(str(v))
	return n
}
func number(v any) float64  { n, _ := strconv.ParseFloat(str(v), 64); return n }
func flag(v any) bool       { return integer(v) != 0 }
func jsonText(v any) string { b, _ := json.Marshal(v); return string(b) }
func stringsOf(v any) []string {
	out := []string{}
	switch list := v.(type) {
	case []string:
		return append(out, list...)
	case []any:
		for _, item := range list {
			out = append(out, str(item))
		}
	}
	return out
}
func rowsOf(v any) []map[string]any {
	out := []map[string]any{}
	switch list := v.(type) {
	case []map[string]any:
		return list
	case []any:
		for _, item := range list {
			if row, ok := item.(map[string]any); ok {
				out = append(out, row)
			}
		}
	}
	return out
}
func projectJSON(row map[string]any, fields map[string]any) map[string]any {
	if row == nil {
		return nil
	}
	for key, fallback := range fields {
		var value any
		d := json.NewDecoder(strings.NewReader(str(row[key])))
		d.UseNumber()
		if d.Decode(&value) != nil {
			value = fallback
		}
		row[strings.TrimSuffix(key, "_json")] = value
		delete(row, key)
	}
	return row
}
func projectBatch(row map[string]any) map[string]any {
	if row != nil {
		row["cancel_requested"] = flag(row["cancel_requested"])
	}
	return row
}
func projectAddress(row map[string]any) map[string]any {
	projectJSON(row, map[string]any{"download_options_json": nil, "extra_args_json": []string{}, "discovery_args_json": []string{}})
	if options, ok := row["download_options"].(map[string]any); ok {
		if pages, selected := options["eh_pages"]; selected {
			row["eh_pages"] = pages
		}
	}
	return row
}
func projectTask(row map[string]any) map[string]any {
	projectBatch(row)
	return projectJSON(row, map[string]any{"extra_args_json": []string{}, "policy_json": map[string]any{}, "tried_proxy_ids_json": []string{}})
}

// Get returns the legacy authority projection, or nil for an unknown batch.
func (s *Service) Get(ctx context.Context, id string) (map[string]any, error) {
	batch, err := s.deps.Store.QueryRow(ctx, "SELECT * FROM crawl_batches WHERE id=?", id)
	if err != nil || batch == nil {
		return batch, err
	}
	projectBatch(batch)
	addresses, err := s.deps.Store.QueryRows(ctx, `SELECT ca.*,cap.target_url AS proxy_probe_target,cap.total_count AS probed_proxy_count,cap.healthy_count AS healthy_proxy_count,cap.checked_at AS proxy_probed_at,cap.last_error AS proxy_probe_error FROM crawl_addresses ca LEFT JOIN crawl_address_proxy_probes cap ON cap.address_id=ca.id WHERE ca.batch_id=? ORDER BY ca.source_order,ca.address_order`, id)
	if err != nil {
		return nil, err
	}
	sources := []map[string]any{}
	byOrder := map[int]map[string]any{}
	var current any
	skipped := 0
	gap := false
	for _, a := range addresses {
		projectAddress(a)
		order := integer(a["source_order"])
		group := byOrder[order]
		if group == nil {
			group = map[string]any{"order": order, "site": a["site"], "status": "pending", "addresses": []map[string]any{}, "pre_dedup_skipped_count": 0}
			byOrder[order] = group
			sources = append(sources, group)
		}
		group["addresses"] = append(group["addresses"].([]map[string]any), a)
		n := integer(a["pre_dedup_skipped_count"])
		group["pre_dedup_skipped_count"] = integer(group["pre_dedup_skipped_count"]) + n
		skipped += n
		gap = gap || str(a["planning_error"]) != ""
		if current == nil && !taskTerminal(str(a["status"])) {
			current = selectFields(a, "source_order", "address_order", "site", "url", "status")
			current.(map[string]any)["address_id"] = a["id"]
		}
	}
	for _, g := range sources {
		success, active, failed, cancelled, done := true, false, false, true, true
		for _, a := range g["addresses"].([]map[string]any) {
			status := str(a["status"])
			success = success && status == "succeeded"
			active = active || status == "planning" || status == "running"
			failed = failed || status == "failed"
			cancelled = cancelled && status == "cancelled"
			done = done && taskTerminal(status)
		}
		switch {
		case success:
			g["status"] = "succeeded"
		case active:
			g["status"] = "running"
		case failed && done:
			g["status"] = "completed_with_errors"
		case cancelled:
			g["status"] = "cancelled"
		}
	}
	batch["sources"] = sources
	batch["source_count"] = len(sources)
	batch["address_count"] = len(addresses)
	batch["pre_dedup_skipped_count"] = skipped
	batch["current"] = current
	batch["execution_order"] = "source_then_address"
	batch["lease_model"] = "one-media-task-one-node"
	batch["resumable"] = (terminal(str(batch["status"])) && (integer(batch["failed_task_count"])+integer(batch["cancelled_task_count"]) > 0 || gap)) || str(batch["status"]) == "paused"
	review, err := s.review(ctx, id)
	if err != nil {
		return nil, err
	}
	batch["review"] = nil
	if review != nil {
		batch["review"] = review
	}
	return batch, nil
}
func (s *Service) review(ctx context.Context, id string) (map[string]any, error) {
	r, err := s.deps.Store.QueryRow(ctx, "SELECT * FROM crawl_reviews WHERE batch_id=?", id)
	if err != nil || r == nil {
		return r, err
	}
	counts, err := s.deps.Store.QueryRow(ctx, `SELECT SUM(selected=1) AS selected_image_count,SUM(disposition='kept') AS kept_image_count,SUM(disposition='rejected') AS rejected_image_count,SUM(disposition='failed') AS failed_image_count FROM crawl_review_images WHERE batch_id=?`, id)
	if err != nil {
		return nil, err
	}
	for k, v := range counts {
		n := integer(v)
		if k == "selected_image_count" || n != 0 {
			r[k] = n
		}
	}
	decided, err := s.deps.Store.QueryRow(ctx, "SELECT COUNT(*) AS n FROM crawl_review_groups WHERE batch_id=? AND decided=1 AND kind NOT LIKE 'auto_%'", id)
	if err != nil {
		return nil, err
	}
	r["decided_group_count"] = integer(decided["n"])
	return r, nil
}
func (s *Service) List(ctx context.Context, limit, offset int) ([]map[string]any, error) {
	rows, err := s.deps.Store.QueryRows(ctx, "SELECT * FROM crawl_batches ORDER BY created_at DESC LIMIT ? OFFSET ?", max(1, min(limit, 500)), max(0, offset))
	for _, r := range rows {
		projectBatch(r)
	}
	return rows, err
}
func (s *Service) ListTasks(ctx context.Context, id, addressID string, limit, offset int) ([]map[string]any, error) {
	where := "ca.batch_id=?"
	args := []any{id}
	if addressID != "" {
		where += " AND ca.id=?"
		args = append(args, addressID)
	}
	args = append(args, max(1, min(limit, 1000)), max(0, offset))
	rows, err := s.deps.Store.QueryRows(ctx, `SELECT t.*,ca.id AS crawl_address_id,ca.source_order,ca.address_order,cat.sequence_no FROM crawl_address_tasks cat JOIN crawl_addresses ca ON ca.id=cat.address_id JOIN tasks t ON t.id=cat.task_id WHERE `+where+` ORDER BY ca.source_order,ca.address_order,cat.sequence_no LIMIT ? OFFSET ?`, args...)
	for _, r := range rows {
		projectTask(r)
	}
	return rows, err
}
func (s *Service) TaskBatchID(ctx context.Context, taskID string) (string, error) {
	return s.deps.Store.TaskCrawlBatchID(ctx, taskID)
}
func (s *Service) tickView(ctx context.Context, id string) (map[string]any, error) {
	return s.deps.Store.QueryRow(ctx, "SELECT id,status,cancel_requested,max_tasks,concurrency,output_dir FROM crawl_batches WHERE id=?", id)
}
func (s *Service) nextAddress(ctx context.Context, id string) (map[string]any, error) {
	row, err := s.deps.Store.QueryRow(ctx, "SELECT * FROM crawl_addresses WHERE batch_id=? AND status NOT IN ('succeeded','failed','cancelled') ORDER BY source_order,address_order LIMIT 1", id)
	return projectAddress(row), err
}
func (s *Service) addressTasks(ctx context.Context, id string) ([]map[string]any, error) {
	return s.deps.Store.QueryRows(ctx, `SELECT t.id,t.status FROM tasks t JOIN crawl_address_tasks cat ON cat.task_id=t.id WHERE cat.address_id=? ORDER BY cat.sequence_no`, id)
}
func (s *Service) exec(ctx context.Context, query string, args ...any) error {
	return s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error { _, err := tx.ExecContext(ctx, query, args...); return err })
}
func refreshCounts(ctx context.Context, tx *sql.Tx, id string) error {
	_, err := tx.ExecContext(ctx, `UPDATE crawl_batches SET (task_count,succeeded_task_count,failed_task_count,cancelled_task_count)=(SELECT COUNT(*),COALESCE(SUM(t.status='succeeded'),0),COALESCE(SUM(t.status='failed'),0),COALESCE(SUM(t.status='cancelled'),0) FROM crawl_address_tasks cat JOIN crawl_addresses ca ON ca.id=cat.address_id JOIN tasks t ON t.id=cat.task_id WHERE ca.batch_id=?),updated_at=? WHERE id=?`, id, now(), id)
	return err
}
func (s *Service) beginPlanning(ctx context.Context, id string) (bool, error) {
	changed := false
	err := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		stamp := now()
		r, e := tx.ExecContext(ctx, `UPDATE crawl_addresses SET status='planning',started_at=COALESCE(started_at,?),updated_at=?,last_error='' WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM crawl_batches cb WHERE cb.id=crawl_addresses.batch_id AND cb.cancel_requested=0 AND cb.status IN ('queued','running'))`, stamp, stamp, id)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		changed = n > 0
		if !changed {
			return nil
		}
		_, e = tx.ExecContext(ctx, `UPDATE crawl_batches SET status='running',started_at=COALESCE(started_at,?),updated_at=? WHERE id=(SELECT batch_id FROM crawl_addresses WHERE id=?)`, stamp, stamp, id)
		return e
	})
	return changed, err
}
func (s *Service) markRunning(ctx context.Context, id, message string) (bool, error) {
	changed := false
	err := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		r, e := tx.ExecContext(ctx, `UPDATE crawl_addresses SET status='running',planned_task_count=(SELECT COUNT(*) FROM crawl_address_tasks WHERE address_id=?),updated_at=?,last_error=?,planning_error=? WHERE id=? AND status='planning' AND EXISTS(SELECT 1 FROM crawl_address_tasks WHERE address_id=?)`, id, now(), redaction.Text(message, 2000), redaction.Text(message, 2000), id, id)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		changed = n > 0
		if changed {
			b, e := store.QueryRowTx(ctx, tx, "SELECT batch_id FROM crawl_addresses WHERE id=?", id)
			if e != nil {
				return e
			}
			return refreshCounts(ctx, tx, str(b["batch_id"]))
		}
		return nil
	})
	return changed, err
}
func (s *Service) failAddress(ctx context.Context, id, message string) error {
	return s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		a, e := store.QueryRowTx(ctx, tx, "SELECT batch_id FROM crawl_addresses WHERE id=?", id)
		if e != nil || a == nil {
			return e
		}
		stamp := now()
		message = redaction.Text(message, 2000)
		r, e := tx.ExecContext(ctx, `UPDATE crawl_addresses SET status='failed',finished_at=?,updated_at=?,last_error=?,planning_error=? WHERE id=? AND status NOT IN ('succeeded','failed','cancelled')`, stamp, stamp, message, message, id)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return nil
		}
		if _, e = tx.ExecContext(ctx, "UPDATE crawl_batches SET last_error=?,updated_at=? WHERE id=?", message, stamp, a["batch_id"]); e != nil {
			return e
		}
		return refreshCounts(ctx, tx, str(a["batch_id"]))
	})
}
func (s *Service) finishAddress(ctx context.Context, id string) (bool, error) {
	done := false
	err := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		a, e := store.QueryRowTx(ctx, tx, `SELECT ca.*,cb.cancel_requested FROM crawl_addresses ca JOIN crawl_batches cb ON cb.id=ca.batch_id WHERE ca.id=?`, id)
		if e != nil || a == nil || str(a["status"]) != "running" {
			return e
		}
		c, e := store.QueryRowTx(ctx, tx, `SELECT COUNT(*) AS n,COALESCE(SUM(t.status='succeeded'),0) AS succeeded,COALESCE(SUM(t.status='failed'),0) AS failed,COALESCE(SUM(t.status='cancelled'),0) AS cancelled,COALESCE(SUM(t.status NOT IN ('succeeded','failed','cancelled')),0) AS active FROM crawl_address_tasks cat JOIN tasks t ON t.id=cat.task_id WHERE cat.address_id=?`, id)
		if e != nil {
			return e
		}
		if integer(c["n"]) == 0 {
			return nil
		}
		if integer(c["active"]) > 0 {
			if integer(a["succeeded_task_count"]) == integer(c["succeeded"]) && integer(a["failed_task_count"]) == integer(c["failed"]) && integer(a["cancelled_task_count"]) == integer(c["cancelled"]) {
				return nil
			}
			_, e = tx.ExecContext(ctx, `UPDATE crawl_addresses SET succeeded_task_count=?,failed_task_count=?,cancelled_task_count=?,updated_at=? WHERE id=?`, c["succeeded"], c["failed"], c["cancelled"], now(), id)
			if e != nil {
				return e
			}
			return refreshCounts(ctx, tx, str(a["batch_id"]))
		}
		status := "succeeded"
		if flag(a["cancel_requested"]) {
			status = "cancelled"
		} else if integer(c["failed"])+integer(c["cancelled"]) > 0 || str(a["planning_error"]) != "" {
			status = "failed"
		}
		message := ""
		if status != "succeeded" {
			message = str(a["planning_error"])
			if message == "" {
				message = fmt.Sprintf("媒体任务失败=%d, 取消=%d", integer(c["failed"]), integer(c["cancelled"]))
			}
		}
		stamp := now()
		_, e = tx.ExecContext(ctx, `UPDATE crawl_addresses SET status=?,succeeded_task_count=?,failed_task_count=?,cancelled_task_count=?,finished_at=?,updated_at=?,last_error=? WHERE id=?`, status, c["succeeded"], c["failed"], c["cancelled"], stamp, stamp, message, id)
		if e != nil {
			return e
		}
		done = true
		return refreshCounts(ctx, tx, str(a["batch_id"]))
	})
	return done, err
}
func (s *Service) finishBatch(ctx context.Context, id string) (bool, error) {
	done := false
	err := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		b, e := store.QueryRowTx(ctx, tx, "SELECT status,cancel_requested FROM crawl_batches WHERE id=?", id)
		if e != nil || b == nil {
			return e
		}
		if terminal(str(b["status"])) {
			done = true
			return nil
		}
		c, e := store.QueryRowTx(ctx, tx, `SELECT COUNT(*) AS n,COALESCE(SUM(status NOT IN ('succeeded','failed','cancelled')),0) AS active,COALESCE(SUM(status IN ('failed','cancelled')),0) AS errors FROM crawl_addresses WHERE batch_id=?`, id)
		if e != nil {
			return e
		}
		active, e := store.QueryRowTx(ctx, tx, `SELECT 1 FROM crawl_address_tasks cat JOIN crawl_addresses ca ON ca.id=cat.address_id JOIN tasks t ON t.id=cat.task_id WHERE ca.batch_id=? AND t.status NOT IN ('succeeded','failed','cancelled') LIMIT 1`, id)
		if e != nil {
			return e
		}
		if e = refreshCounts(ctx, tx, id); e != nil {
			return e
		}
		if integer(c["n"]) == 0 || integer(c["active"]) > 0 || active != nil {
			status := "running"
			if flag(b["cancel_requested"]) {
				status = "cancelling"
			} else if str(b["status"]) == "paused" {
				status = "paused"
			}
			_, e = tx.ExecContext(ctx, "UPDATE crawl_batches SET status=?,updated_at=? WHERE id=?", status, now(), id)
			return e
		}
		status := "succeeded"
		if flag(b["cancel_requested"]) {
			status = "cancelled"
		} else if integer(c["errors"]) > 0 {
			status = "completed_with_errors"
		}
		stamp := now()
		_, e = tx.ExecContext(ctx, "UPDATE crawl_batches SET status=?,finished_at=?,updated_at=? WHERE id=?", status, stamp, stamp, id)
		done = e == nil
		return e
	})
	return done, err
}

// Recover preserves partially linked addresses and drains them before advancing.
func (s *Service) Recover(ctx context.Context) error {
	return s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		stamp := now()
		for _, q := range []string{
			`UPDATE crawl_addresses SET status='running',updated_at=?,planned_task_count=(SELECT COUNT(*) FROM crawl_address_tasks cat WHERE cat.address_id=crawl_addresses.id),last_error='后端重启时地址只完成了部分规划，等待已创建任务结束',planning_error='后端重启时地址只完成了部分规划，等待已创建任务结束' WHERE status='planning' AND EXISTS(SELECT 1 FROM crawl_address_tasks cat WHERE cat.address_id=crawl_addresses.id)`,
			`UPDATE crawl_addresses SET status='pending',updated_at=?,last_error='后端重启后重新规划' WHERE status='planning' AND NOT EXISTS(SELECT 1 FROM crawl_address_tasks cat WHERE cat.address_id=crawl_addresses.id)`,
			`UPDATE crawl_batches SET status=CASE WHEN cancel_requested=1 THEN 'cancelling' ELSE 'running' END,updated_at=? WHERE status IN ('queued','running','cancelling')`,
		} {
			if _, e := tx.ExecContext(ctx, q, stamp); e != nil {
				return e
			}
		}
		return nil
	})
}
