package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// TaskRepository implements the task lifecycle over Store's single writer.
// All mutation events commit atomically with the corresponding state change.
type TaskRepository struct {
	store      *Store
	clock      func() float64
	uuid       func() string
	maxLogs    int
	sincePrune map[string]int // protected by store.writeMu
}

func (r *TaskRepository) CreateTask(ctx context.Context, values map[string]any, idempotencyKey string) (task map[string]any, created bool, err error) {
	err = r.store.withWrite(ctx, func(tx *sql.Tx) error {
		if idempotencyKey != "" {
			existing, e := queryMap(ctx, tx, "SELECT id FROM tasks WHERE idempotency_key=?", idempotencyKey)
			if e != nil {
				return e
			}
			if existing != nil {
				task, e = getTask(ctx, tx, existing["id"].(string))
				return e
			}
		}
		for _, key := range []string{"url", "site", "output_dir", "proxy_mode"} {
			if _, ok := values[key].(string); !ok {
				return fmt.Errorf("task %s must be a string", key)
			}
		}
		attempts, e := integer(values["max_attempts"])
		if e != nil {
			return fmt.Errorf("task max_attempts: %w", e)
		}
		priority, e := integer(defaultValue(values, "priority", 0))
		if e != nil {
			return fmt.Errorf("task priority: %w", e)
		}
		extra, e := json.Marshal(defaultValue(values, "extra_args", []any{}))
		if e != nil {
			return e
		}
		policy, e := json.Marshal(defaultValue(values, "policy", map[string]any{}))
		if e != nil {
			return e
		}
		id, _ := values["id"].(string)
		if id == "" {
			id = r.uuid()
		}
		now := r.clock()
		_, e = tx.ExecContext(ctx, `INSERT INTO tasks(
			id,idempotency_key,url,site,subcategory,extractor,status,priority,output_dir,
			proxy_mode,max_attempts,attempt_count,next_run_at,created_at,updated_at,
			cookies_file,config_file,credentials_ref,extra_args_json,policy_json,tried_proxy_ids_json)
			VALUES (?,?,?,?,?,?,'queued',?,?,?,?,0,?,?,?,?,?,?,?,?,'[]')`,
			id, nullable(idempotencyKey), values["url"], values["site"], defaultValue(values, "subcategory", ""),
			defaultValue(values, "extractor", ""), priority, values["output_dir"], values["proxy_mode"], attempts,
			now, now, now, values["cookies_file"], values["config_file"], values["credentials_ref"], string(extra), string(policy))
		if e != nil {
			return e
		}
		if e = r.addEvent(ctx, tx, id, "queued", map[string]any{"site": values["site"]}); e != nil {
			return e
		}
		task, e = taskRow(ctx, tx, id)
		created = e == nil
		return e
	})
	if err != nil {
		return nil, false, err
	}
	return task, created, nil
}

func defaultValue(values map[string]any, key string, fallback any) any {
	if value, ok := values[key]; ok {
		return value
	}
	return fallback
}

func integer(value any) (int64, error) {
	switch v := value.(type) {
	case int:
		return int64(v), nil
	case int64:
		return v, nil
	case int32:
		return int64(v), nil
	case float64:
		return int64(v), nil
	case float32:
		return int64(v), nil
	case json.Number:
		return v.Int64()
	case string:
		return strconv.ParseInt(v, 10, 64)
	}
	return 0, fmt.Errorf("expected integer, got %T", value)
}

func taskRow(ctx context.Context, q queryer, id string) (map[string]any, error) {
	row, err := queryMap(ctx, q, "SELECT * FROM tasks WHERE id=?", id)
	return projectTask(row), err
}

func getTask(ctx context.Context, q queryer, id string) (map[string]any, error) {
	task, err := taskRow(ctx, q, id)
	if err != nil || task == nil {
		return task, err
	}
	attempt, err := queryMap(ctx, q, "SELECT * FROM attempts WHERE task_id=? ORDER BY attempt_no DESC LIMIT 1", id)
	if err != nil {
		return nil, err
	}
	if attempt != nil {
		attempt["retryable"] = attempt["retryable"] != int64(0)
	}
	// Use an untyped nil for JSON null, not a typed nil map in an interface.
	task["latest_attempt"] = nil
	if attempt != nil {
		task["latest_attempt"] = attempt
	}
	lease, err := queryMap(ctx, q, "SELECT * FROM leases WHERE task_id=?", id)
	if err != nil {
		return nil, err
	}
	task["lease"] = nil
	if lease != nil {
		task["lease"] = lease
	}
	return task, nil
}

func (r *TaskRepository) GetTask(ctx context.Context, id string) (map[string]any, error) {
	tx, err := r.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	task, err := getTask(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return task, nil
}

func (r *TaskRepository) GetTaskByIdempotency(ctx context.Context, key string) (map[string]any, error) {
	tx, err := r.store.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, err := queryMap(ctx, tx, "SELECT id FROM tasks WHERE idempotency_key=?", key)
	if err != nil || row == nil {
		return nil, err
	}
	task, err := getTask(ctx, tx, row["id"].(string))
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return task, nil
}

func (r *TaskRepository) ListTasks(ctx context.Context, status, site string, limit, offset int) ([]map[string]any, error) {
	clauses := []string{}
	args := []any{}
	if status != "" {
		clauses = append(clauses, "status=?")
		args = append(args, status)
	}
	if site != "" {
		clauses = append(clauses, "site=?")
		args = append(args, site)
	}
	where := ""
	if len(clauses) != 0 {
		where = " WHERE " + strings.Join(clauses, " AND ")
	}
	args = append(args, clamp(limit, 1, 500), max(0, offset))
	rows, err := queryMaps(ctx, r.store.reader, "SELECT * FROM tasks"+where+" ORDER BY created_at DESC LIMIT ? OFFSET ?", args...)
	for _, row := range rows {
		projectTask(row)
	}
	return rows, err
}

func (r *TaskRepository) QueuedTasks(ctx context.Context, limit int, excludeSites []string) ([]map[string]any, error) {
	excluded := uniqueSorted(excludeSites)
	if len(excluded) > 64 {
		excluded = excluded[:64]
	}
	filter := ""
	args := []any{r.clock()}
	if len(excluded) > 0 {
		filter = " AND site NOT IN (" + placeholders(len(excluded)) + ")"
		for _, site := range excluded {
			args = append(args, site)
		}
	}
	args = append(args, clamp(limit, 1, 1000))
	rows, err := queryMaps(ctx, r.store.reader, `SELECT * FROM tasks WHERE status='queued' AND cancel_requested=0 AND next_run_at<=?`+filter+` ORDER BY priority DESC, created_at ASC LIMIT ?`, args...)
	for _, row := range rows {
		projectTask(row)
	}
	return rows, err
}

func (r *TaskRepository) QueuedTaskIDs(ctx context.Context, ids []string) (map[string]struct{}, error) {
	ids = uniqueSorted(ids)
	result := make(map[string]struct{})
	now := r.clock()
	for start := 0; start < len(ids); start += 63 {
		chunk := ids[start:min(start+63, len(ids))]
		args := []any{now}
		for _, id := range chunk {
			args = append(args, id)
		}
		rows, err := queryMaps(ctx, r.store.reader, `SELECT id FROM tasks WHERE status='queued' AND cancel_requested=0 AND next_run_at<=? AND id IN (`+placeholders(len(chunk))+`)`, args...)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			result[row["id"].(string)] = struct{}{}
		}
	}
	return result, nil
}

func uniqueSorted(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	for _, v := range values {
		seen[v] = struct{}{}
	}
	result := make([]string, 0, len(seen))
	for v := range seen {
		result = append(result, v)
	}
	sort.Strings(result)
	return result
}

func placeholders(n int) string { return strings.TrimSuffix(strings.Repeat("?,", n), ",") }

func (r *TaskRepository) MarkTaskCredentialsUnavailable(ctx context.Context, id, site string) (updated bool, err error) {
	err = r.store.withWrite(ctx, func(tx *sql.Tx) error {
		res, e := tx.ExecContext(ctx, `UPDATE tasks SET last_error_class='credentials_unavailable', last_error=?, updated_at=?, version=version+1 WHERE id=? AND status='queued' AND cancel_requested=0`, "站点托管授权已失效，等待在授权管理中重新授权", r.clock(), id)
		if e != nil {
			return e
		}
		n, e := res.RowsAffected()
		if e != nil {
			return e
		}
		updated = n != 0
		if updated {
			return r.addEvent(ctx, tx, id, "credentials_unavailable", map[string]any{"site": site})
		}
		return nil
	})
	return updated && err == nil, err
}

func (r *TaskRepository) ClaimTask(ctx context.Context, id string) (claimed bool, err error) {
	err = r.store.withWrite(ctx, func(tx *sql.Tx) error {
		now := r.clock()
		res, e := tx.ExecContext(ctx, `UPDATE tasks SET status='starting',updated_at=?,started_at=COALESCE(started_at,?),version=version+1 WHERE id=? AND status='queued' AND cancel_requested=0`, now, now, id)
		if e != nil {
			return e
		}
		n, e := res.RowsAffected()
		if e != nil {
			return e
		}
		claimed = n != 0
		if claimed {
			return r.addEvent(ctx, tx, id, "starting", nil)
		}
		return nil
	})
	return claimed && err == nil, err
}

func (r *TaskRepository) BeginAttempt(ctx context.Context, id string) (result map[string]any, err error) {
	err = r.store.withWrite(ctx, func(tx *sql.Tx) error {
		row, e := taskRow(ctx, tx, id)
		if e != nil {
			return e
		}
		if row == nil {
			return ErrNotFound
		}
		if row["status"] != "starting" {
			return fmt.Errorf("%w: task is %s, expected starting", ErrInvalidState, row["status"])
		}
		attemptNo := row["attempt_count"].(int64) + 1
		attemptID, now := r.uuid(), r.clock()
		if _, e = tx.ExecContext(ctx, `INSERT INTO attempts(id,task_id,attempt_no,status,started_at) VALUES (?,?,?,'running',?)`, attemptID, id, attemptNo, now); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `UPDATE tasks SET status='running',attempt_count=?,updated_at=?,pid=NULL,process_marker=NULL,version=version+1 WHERE id=?`, attemptNo, now, id); e != nil {
			return e
		}
		if e = r.addEvent(ctx, tx, id, "attempt_started", map[string]any{"attempt": attemptNo, "attempt_id": attemptID}); e != nil {
			return e
		}
		task, e := taskRow(ctx, tx, id)
		result = map[string]any{"id": attemptID, "attempt_no": attemptNo, "task": task}
		return e
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (r *TaskRepository) SetProcess(ctx context.Context, taskID, attemptID string, pid int, marker string) error {
	return r.store.withWrite(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE attempts SET pid=?,process_marker=? WHERE id=? AND task_id=? AND status='running'`, pid, marker, attemptID, taskID)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil || n == 0 {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE tasks SET pid=?,process_marker=?,updated_at=? WHERE id=? AND status='running' AND EXISTS (SELECT 1 FROM attempts WHERE attempts.id=? AND attempts.task_id=tasks.id AND attempts.status='running')`, pid, marker, r.clock(), taskID, attemptID)
		if err != nil {
			return err
		}
		return r.addEvent(ctx, tx, taskID, "process_started", map[string]any{"pid": pid, "attempt_id": attemptID})
	})
}

// FinishAttemptOptions describes an individual execution result, not the task's
// final state. CompleteTask/RequeueTask separately apply the scheduler decision.
type FinishAttemptOptions struct {
	Status        string
	ExitCode      *int
	ErrorClass    string
	ErrorMessage  string
	Retryable     bool
	ProxyNodeID   *string
	ProxyEndpoint *string
}

func (r *TaskRepository) FinishAttempt(ctx context.Context, attemptID string, options FinishAttemptOptions) error {
	return r.store.withWrite(ctx, func(tx *sql.Tx) error {
		row, err := queryMap(ctx, tx, "SELECT task_id,attempt_no FROM attempts WHERE id=?", attemptID)
		if err != nil || row == nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE attempts SET status=?,finished_at=?,exit_code=?,proxy_node_id=?,proxy_endpoint=?,error_class=?,error_message=?,retryable=? WHERE id=? AND status='running'`, options.Status, r.clock(), options.ExitCode, options.ProxyNodeID, options.ProxyEndpoint, options.ErrorClass, redactText(options.ErrorMessage, 2000), options.Retryable, attemptID)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil || n == 0 {
			return err
		}
		return r.addEvent(ctx, tx, row["task_id"].(string), "attempt_finished", map[string]any{"attempt": row["attempt_no"], "status": options.Status, "exit_code": options.ExitCode, "error_class": options.ErrorClass})
	})
}

type CompleteTaskOptions struct {
	ExitCode          *int
	ErrorClass        string
	ErrorMessage      string
	ExpectedAttemptID string
}

const attemptGuard = ` AND status IN ('running','cancelling') AND (SELECT id FROM attempts WHERE task_id=tasks.id ORDER BY attempt_no DESC LIMIT 1)=?`

func (r *TaskRepository) CompleteTask(ctx context.Context, id, status string, options CompleteTaskOptions) (task map[string]any, err error) {
	if !terminal(status) {
		return nil, fmt.Errorf("%w: complete task requires a terminal status", ErrInvalidState)
	}
	err = r.store.withWrite(ctx, func(tx *sql.Tx) error {
		// Go workers run concurrently with cancellation handlers. Recheck inside
		// the commit transaction, not only against the scheduler's earlier snapshot.
		if options.ExpectedAttemptID != "" {
			var cancelled bool
			err := tx.QueryRowContext(ctx, "SELECT cancel_requested FROM tasks WHERE id=?", id).Scan(&cancelled)
			if err != nil && err != sql.ErrNoRows {
				return err
			}
			if cancelled {
				status = "cancelled"
				options.ErrorClass = "cancelled"
				options.ErrorMessage = "任务已取消"
			}
		}
		now := r.clock()
		args := []any{status, now, now, options.ExitCode, options.ErrorClass, redactText(options.ErrorMessage, 2000), status, id}
		guard := ""
		if options.ExpectedAttemptID != "" {
			guard = attemptGuard
			args = append(args, options.ExpectedAttemptID)
		}
		res, e := tx.ExecContext(ctx, `UPDATE tasks SET status=?,finished_at=?,updated_at=?,pid=NULL,process_marker=NULL,exit_code=?,last_error_class=?,last_error=?,cancel_requested=CASE WHEN ?='cancelled' THEN 1 ELSE cancel_requested END,version=version+1 WHERE id=?`+guard, args...)
		if e != nil {
			return e
		}
		n, e := res.RowsAffected()
		if e != nil {
			return e
		}
		if n != 0 {
			if _, e = tx.ExecContext(ctx, "DELETE FROM leases WHERE task_id=?", id); e != nil {
				return e
			}
			if e = r.addEvent(ctx, tx, id, status, map[string]any{"exit_code": options.ExitCode, "error_class": options.ErrorClass}); e != nil {
				return e
			}
		}
		task, e = taskRow(ctx, tx, id)
		return e
	})
	if err != nil {
		return nil, err
	}
	return task, nil
}

type RequeueTaskOptions struct {
	NextRunAt         float64
	ExitCode          *int
	ErrorClass        string
	ErrorMessage      string
	TriedProxyIDs     []string
	ExpectedAttemptID string
}

func (r *TaskRepository) RequeueTask(ctx context.Context, id string, options RequeueTaskOptions) (updated bool, err error) {
	// Deduplicate while preserving proxy selection order.
	seen := map[string]bool{}
	ids := make([]string, 0, len(options.TriedProxyIDs))
	for _, v := range options.TriedProxyIDs {
		if !seen[v] {
			seen[v] = true
			ids = append(ids, v)
		}
	}
	encoded, _ := json.Marshal(ids)
	err = r.store.withWrite(ctx, func(tx *sql.Tx) error {
		args := []any{options.NextRunAt, r.clock(), options.ExitCode, options.ErrorClass, redactText(options.ErrorMessage, 2000), string(encoded), id}
		guard := ""
		if options.ExpectedAttemptID != "" {
			guard = attemptGuard
			args = append(args, options.ExpectedAttemptID)
		}
		res, e := tx.ExecContext(ctx, `UPDATE tasks SET status='queued',next_run_at=?,updated_at=?,pid=NULL,process_marker=NULL,exit_code=?,last_error_class=?,last_error=?,tried_proxy_ids_json=?,version=version+1 WHERE id=? AND cancel_requested=0`+guard, args...)
		if e != nil {
			return e
		}
		n, e := res.RowsAffected()
		if e != nil {
			return e
		}
		updated = n != 0
		if !updated {
			return nil
		}
		if _, e = tx.ExecContext(ctx, "DELETE FROM leases WHERE task_id=?", id); e != nil {
			return e
		}
		return r.addEvent(ctx, tx, id, "retry_scheduled", map[string]any{"next_run_at": options.NextRunAt, "error_class": options.ErrorClass})
	})
	return updated && err == nil, err
}

func (r *TaskRepository) RequestCancel(ctx context.Context, id string) (task map[string]any, err error) {
	err = r.store.withWrite(ctx, func(tx *sql.Tx) error {
		row, e := taskRow(ctx, tx, id)
		if e != nil || row == nil {
			return e
		}
		status := row["status"].(string)
		if terminal(status) {
			task = row
			return nil
		}
		now := r.clock()
		if status == "queued" {
			_, e = tx.ExecContext(ctx, `UPDATE tasks SET status='cancelled',cancel_requested=1,finished_at=?,updated_at=?,version=version+1 WHERE id=?`, now, now, id)
			status = "cancelled"
		} else {
			_, e = tx.ExecContext(ctx, `UPDATE tasks SET status='cancelling',cancel_requested=1,updated_at=?,version=version+1 WHERE id=?`, now, id)
			status = "cancelling"
		}
		if e != nil {
			return e
		}
		if e = r.addEvent(ctx, tx, id, status, nil); e != nil {
			return e
		}
		task, e = taskRow(ctx, tx, id)
		return e
	})
	if err != nil {
		return nil, err
	}
	return task, nil
}

func (r *TaskRepository) RetryTask(ctx context.Context, id string, additionalAttempts int) (task map[string]any, err error) {
	err = r.store.withWrite(ctx, func(tx *sql.Tx) error {
		row, e := taskRow(ctx, tx, id)
		if e != nil || row == nil {
			return e
		}
		if !terminal(row["status"].(string)) {
			return fmt.Errorf("%w: only terminal tasks may be retried", ErrInvalidState)
		}
		prior := row["attempt_count"].(int64)
		budget := prior + int64(max(1, additionalAttempts))
		now := r.clock()
		_, e = tx.ExecContext(ctx, `UPDATE tasks SET status='queued',cancel_requested=0,next_run_at=?,started_at=NULL,finished_at=NULL,updated_at=?,max_attempts=?,pid=NULL,process_marker=NULL,exit_code=NULL,backoff_anchor_attempt=?,tried_proxy_ids_json='[]',version=version+1 WHERE id=?`, now, now, budget, prior, id)
		if e != nil {
			return e
		}
		if e = r.addEvent(ctx, tx, id, "manually_retried", map[string]any{"max_attempts": budget}); e != nil {
			return e
		}
		task, e = taskRow(ctx, tx, id)
		return e
	})
	if err != nil {
		return nil, err
	}
	return task, nil
}

func (r *TaskRepository) SetLease(ctx context.Context, taskID, attemptID, nodeID, endpoint, site string) error {
	return r.store.withWrite(ctx, func(tx *sql.Tx) error {
		now := r.clock()
		_, err := tx.ExecContext(ctx, `INSERT INTO leases(task_id,attempt_id,node_id,endpoint,site,acquired_at,heartbeat_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET attempt_id=excluded.attempt_id,node_id=excluded.node_id,endpoint=excluded.endpoint,site=excluded.site,acquired_at=excluded.acquired_at,heartbeat_at=excluded.heartbeat_at`, taskID, attemptID, nodeID, endpoint, site, now, now)
		if err != nil {
			return err
		}
		return r.addEvent(ctx, tx, taskID, "proxy_acquired", map[string]any{"node_id": nodeID, "endpoint": endpoint})
	})
}

// An empty attemptID clears any lease; otherwise only the matching attempt's lease.
func (r *TaskRepository) ClearLease(ctx context.Context, taskID, attemptID string) error {
	return r.store.withWrite(ctx, func(tx *sql.Tx) error {
		query := "DELETE FROM leases WHERE task_id=?"
		args := []any{taskID}
		if attemptID != "" {
			query += " AND attempt_id=?"
			args = append(args, attemptID)
		}
		_, err := tx.ExecContext(ctx, query, args...)
		return err
	})
}

func (r *TaskRepository) UpdateArtifacts(ctx context.Context, id string, count, totalBytes int64) error {
	return r.store.withWrite(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "UPDATE tasks SET artifact_count=?,artifact_bytes=?,updated_at=? WHERE id=?", max(0, count), max(0, totalBytes), r.clock(), id)
		return err
	})
}

func (r *TaskRepository) IncompleteProcesses(ctx context.Context) ([]map[string]any, error) {
	return queryMaps(ctx, r.store.reader, `SELECT id,pid,process_marker,status,attempt_count,max_attempts FROM tasks WHERE status IN ('starting','running','cancelling')`)
}

// RecoverIncomplete updates database state only. The supervisor must inspect
// IncompleteProcesses and stop matching orphan processes before calling this.
func (r *TaskRepository) RecoverIncomplete(ctx context.Context) (recovered int, err error) {
	err = r.store.withWrite(ctx, func(tx *sql.Tx) error {
		rows, e := queryMaps(ctx, tx, `SELECT * FROM tasks WHERE status IN ('starting','running','cancelling')`)
		if e != nil {
			return e
		}
		now := r.clock()
		for _, row := range rows {
			id := row["id"].(string)
			var event string
			if row["cancel_requested"] != int64(0) {
				_, e = tx.ExecContext(ctx, `UPDATE tasks SET status='cancelled',finished_at=?,updated_at=?,pid=NULL,process_marker=NULL,last_error_class='backend_restart',last_error='后端重启时任务处于取消流程' WHERE id=?`, now, now, id)
				event = "cancelled_after_restart"
			} else if row["attempt_count"].(int64) < row["max_attempts"].(int64) {
				_, e = tx.ExecContext(ctx, `UPDATE tasks SET status='queued',next_run_at=?,updated_at=?,pid=NULL,process_marker=NULL,last_error_class='backend_restart',last_error='后端重启，任务重新排队' WHERE id=?`, now, now, id)
				event = "requeued_after_restart"
			} else {
				_, e = tx.ExecContext(ctx, `UPDATE tasks SET status='failed',finished_at=?,updated_at=?,pid=NULL,process_marker=NULL,last_error_class='backend_restart',last_error='后端重启且重试次数已用尽' WHERE id=?`, now, now, id)
				event = "failed_after_restart"
			}
			if e != nil {
				return e
			}
			if e = r.addEvent(ctx, tx, id, event, nil); e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, `UPDATE attempts SET status='orphaned',finished_at=?,error_class='backend_restart',error_message='后端重启' WHERE task_id=? AND status='running'`, now, id); e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, "DELETE FROM leases WHERE task_id=?", id); e != nil {
				return e
			}
			recovered++
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return recovered, nil
}
