from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from typing import Any, Iterable

from ._database_repository import (
    Clock,
    ReadFactory,
    TERMINAL_STATUSES,
    TransactionFactory,
    UuidFactory,
    project_attempt,
    project_task,
)
from .redaction import redact_data, redact_text


class TaskRepository:
    """Task persistence over the Database-owned reader and write transaction."""

    def __init__(
        self,
        *,
        read: ReadFactory,
        transaction: TransactionFactory,
        write_lock: Any,
        since_prune: dict[str, int],
        max_logs_per_task: Callable[[], int],
        clock: Clock,
        uuid4: UuidFactory,
    ) -> None:
        self._read = read
        self._transaction = transaction
        self._lock = write_lock
        self._since_prune = since_prune
        self._max_logs_per_task = max_logs_per_task
        self._clock = clock
        self._uuid4 = uuid4

    _task = staticmethod(project_task)
    _attempt = staticmethod(project_attempt)

    def add_event(self, conn: sqlite3.Connection, task_id: str, event_type: str, payload: dict[str, Any] | None = None) -> None:
        conn.execute(
            "INSERT INTO task_events(task_id, ts, event_type, payload_json) VALUES (?, ?, ?, ?)",
            (task_id, self._clock(), event_type, json.dumps(redact_data(payload or {}), ensure_ascii=False)),
        )

    def create_task(self, values: dict[str, Any], *, idempotency_key: str | None = None) -> tuple[dict[str, Any], bool]:
        now = self._clock()
        with self._transaction() as conn:
            if idempotency_key:
                existing = conn.execute(
                    "SELECT * FROM tasks WHERE idempotency_key=?", (idempotency_key,)
                ).fetchone()
                if existing is not None:
                    # 幂等命中只可能读取本事务开始前已提交的行，因此在这里调用基于
                    # `_read()` 的 `get_task()` 是安全的；它还能补齐
                    # `latest_attempt` 与 `lease`，保持和普通查询一致的返回形状。
                    return self.get_task(str(existing["id"])), False  # type: ignore[return-value]
            task_id = str(values.get("id") or self._uuid4())
            conn.execute(
                """
                INSERT INTO tasks(
                    id, idempotency_key, url, site, subcategory, extractor, status,
                    priority, output_dir, proxy_mode, max_attempts, attempt_count,
                    next_run_at, created_at, updated_at, cookies_file, config_file,
                    credentials_ref, extra_args_json, policy_json, tried_proxy_ids_json
                ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, '[]')
                """,
                (
                    task_id,
                    idempotency_key,
                    values["url"],
                    values["site"],
                    values.get("subcategory", ""),
                    values.get("extractor", ""),
                    int(values.get("priority", 0)),
                    values["output_dir"],
                    values["proxy_mode"],
                    int(values["max_attempts"]),
                    now,
                    now,
                    now,
                    values.get("cookies_file"),
                    values.get("config_file"),
                    values.get("credentials_ref"),
                    json.dumps(values.get("extra_args", []), ensure_ascii=False),
                    json.dumps(values.get("policy", {}), ensure_ascii=False),
                ),
            )
            self.add_event(conn, task_id, "queued", {"site": values["site"]})
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            return self._task(row), True

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            task = self._task(row)
            if task is None:
                return None
            attempt = conn.execute(
                "SELECT * FROM attempts WHERE task_id=? ORDER BY attempt_no DESC LIMIT 1", (task_id,)
            ).fetchone()
            task["latest_attempt"] = self._attempt(attempt)
            lease = conn.execute("SELECT * FROM leases WHERE task_id=?", (task_id,)).fetchone()
            task["lease"] = dict(lease) if lease else None
            return task

    def get_task_by_idempotency(self, key: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute("SELECT id FROM tasks WHERE idempotency_key=?", (key,)).fetchone()
        return self.get_task(row["id"]) if row else None

    def list_tasks(
        self,
        *,
        status: str | None = None,
        site: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if status:
            clauses.append("status=?")
            params.append(status)
        if site:
            clauses.append("site=?")
            params.append(site)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        params.extend([max(1, min(int(limit), 500)), max(0, int(offset))])
        with self._read() as conn:
            rows = conn.execute(
                f"SELECT * FROM tasks{where} ORDER BY created_at DESC LIMIT ? OFFSET ?", params
            ).fetchall()
            return [self._task(row) for row in rows]

    def queued_tasks(
        self,
        limit: int = 100,
        exclude_sites: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        excluded = sorted(exclude_sites or ())[:64]
        site_filter = ""
        params: list[Any] = [self._clock()]
        if excluded:
            placeholders = ",".join("?" for _ in excluded)
            site_filter = f" AND site NOT IN ({placeholders})"
            params.extend(excluded)
        params.append(max(1, min(int(limit), 1000)))
        with self._read() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM tasks
                WHERE status='queued' AND cancel_requested=0 AND next_run_at<=?
                {site_filter}
                ORDER BY priority DESC, created_at ASC LIMIT ?
                """,
                params,
            ).fetchall()
            return [self._task(row) for row in rows]

    def queued_task_ids(self, task_ids: set[str]) -> set[str]:
        ids = sorted(task_ids)
        if not ids:
            return set()
        queued: set[str] = set()
        now = self._clock()
        with self._read() as conn:
            for offset in range(0, len(ids), 63):
                chunk = ids[offset : offset + 63]
                placeholders = ",".join("?" for _ in chunk)
                rows = conn.execute(
                    f"""
                    SELECT id FROM tasks
                    WHERE status='queued' AND cancel_requested=0
                      AND next_run_at<=? AND id IN ({placeholders})
                    """,
                    (now, *chunk),
                ).fetchall()
                queued.update(str(row["id"]) for row in rows)
        return queued

    def mark_task_credentials_unavailable(self, task_id: str, site: str) -> bool:
        message = "站点托管授权已失效，等待在授权管理中重新授权"
        now = self._clock()
        with self._transaction() as conn:
            updated = conn.execute(
                """
                UPDATE tasks SET last_error_class='credentials_unavailable',
                    last_error=?, updated_at=?, version=version+1
                WHERE id=? AND status='queued' AND cancel_requested=0
                """,
                (redact_text(message, limit=2000), now, task_id),
            )
            if not updated.rowcount:
                return False
            self.add_event(
                conn,
                task_id,
                "credentials_unavailable",
                {"site": site},
            )
            return True

    def claim_task(self, task_id: str) -> bool:
        now = self._clock()
        with self._transaction() as conn:
            cur = conn.execute(
                """
                UPDATE tasks SET status='starting', updated_at=?,
                    started_at=COALESCE(started_at, ?), version=version+1
                WHERE id=? AND status='queued' AND cancel_requested=0
                """,
                (now, now, task_id),
            )
            if cur.rowcount:
                self.add_event(conn, task_id, "starting")
                return True
            return False

    def begin_attempt(self, task_id: str) -> dict[str, Any]:
        now = self._clock()
        with self._transaction() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise KeyError(task_id)
            if row["status"] != "starting":
                raise RuntimeError(f"任务状态不是 starting: {row['status']}")
            attempt_no = int(row["attempt_count"]) + 1
            attempt_id = str(self._uuid4())
            conn.execute(
                """
                INSERT INTO attempts(id, task_id, attempt_no, status, started_at)
                VALUES (?, ?, ?, 'running', ?)
                """,
                (attempt_id, task_id, attempt_no, now),
            )
            conn.execute(
                """
                UPDATE tasks SET status='running', attempt_count=?, updated_at=?,
                    pid=NULL, process_marker=NULL, version=version+1 WHERE id=?
                """,
                (attempt_no, now, task_id),
            )
            self.add_event(conn, task_id, "attempt_started", {"attempt": attempt_no, "attempt_id": attempt_id})
            task = self._task(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
            return {"id": attempt_id, "attempt_no": attempt_no, "task": task}

    def set_process(self, task_id: str, attempt_id: str, pid: int, marker: str) -> None:
        now = self._clock()
        with self._transaction() as conn:
            cur = conn.execute(
                "UPDATE attempts SET pid=?, process_marker=? WHERE id=? AND task_id=? AND status='running'",
                (int(pid), marker, attempt_id, task_id),
            )
            if cur.rowcount:
                conn.execute(
                    """
                    UPDATE tasks SET pid=?, process_marker=?, updated_at=?
                    WHERE id=? AND status='running' AND EXISTS (
                        SELECT 1 FROM attempts
                        WHERE attempts.id=? AND attempts.task_id=tasks.id AND attempts.status='running'
                    )
                    """,
                    (int(pid), marker, now, task_id, attempt_id),
                )
                self.add_event(conn, task_id, "process_started", {"pid": int(pid), "attempt_id": attempt_id})

    def finish_attempt(
        self,
        attempt_id: str,
        *,
        exit_code: int | None,
        status: str,
        error_class: str = "",
        error_message: str = "",
        retryable: bool = False,
        proxy_node_id: str | None = None,
        proxy_endpoint: str | None = None,
    ) -> None:
        with self._transaction() as conn:
            row = conn.execute("SELECT task_id, attempt_no FROM attempts WHERE id=?", (attempt_id,)).fetchone()
            if row is None:
                return
            cur = conn.execute(
                """
                UPDATE attempts SET status=?, finished_at=?, exit_code=?, proxy_node_id=?,
                    proxy_endpoint=?, error_class=?, error_message=?, retryable=?
                WHERE id=? AND status='running'
                """,
                (
                    status,
                    self._clock(),
                    exit_code,
                    proxy_node_id,
                    proxy_endpoint,
                    error_class,
                    redact_text(error_message, limit=2000),
                    int(bool(retryable)),
                    attempt_id,
                ),
            )
            if cur.rowcount:
                self.add_event(
                    conn,
                    row["task_id"],
                    "attempt_finished",
                    {"attempt": row["attempt_no"], "status": status, "exit_code": exit_code, "error_class": error_class},
                )

    def complete_task(
        self,
        task_id: str,
        status: str,
        *,
        exit_code: int | None = None,
        error_class: str = "",
        error_message: str = "",
        expected_attempt_id: str | None = None,
    ) -> dict[str, Any] | None:
        if status not in TERMINAL_STATUSES:
            raise ValueError(status)
        now = self._clock()
        with self._transaction() as conn:
            attempt_guard = ""
            params: list[Any] = [
                status,
                now,
                now,
                exit_code,
                error_class,
                redact_text(error_message, limit=2000),
                status,
                task_id,
            ]
            if expected_attempt_id:
                attempt_guard = """
                    AND status IN ('running','cancelling')
                    AND (SELECT id FROM attempts WHERE task_id=tasks.id ORDER BY attempt_no DESC LIMIT 1)=?
                """
                params.append(expected_attempt_id)
            cur = conn.execute(
                f"""
                UPDATE tasks SET status=?, finished_at=?, updated_at=?, pid=NULL,
                    process_marker=NULL, exit_code=?, last_error_class=?, last_error=?,
                    cancel_requested=CASE WHEN ?='cancelled' THEN 1 ELSE cancel_requested END,
                    version=version+1 WHERE id=? {attempt_guard}
                """,
                params,
            )
            if cur.rowcount:
                conn.execute("DELETE FROM leases WHERE task_id=?", (task_id,))
                self.add_event(conn, task_id, status, {"exit_code": exit_code, "error_class": error_class})
            return self._task(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())

    def requeue_task(
        self,
        task_id: str,
        *,
        next_run_at: float,
        exit_code: int | None,
        error_class: str,
        error_message: str,
        tried_proxy_ids: list[str],
        expected_attempt_id: str | None = None,
    ) -> bool:
        now = self._clock()
        with self._transaction() as conn:
            attempt_guard = ""
            params: list[Any] = [
                float(next_run_at),
                now,
                exit_code,
                error_class,
                redact_text(error_message, limit=2000),
                json.dumps(list(dict.fromkeys(tried_proxy_ids))),
                task_id,
            ]
            if expected_attempt_id:
                attempt_guard = """
                    AND status IN ('running','cancelling')
                    AND (SELECT id FROM attempts WHERE task_id=tasks.id ORDER BY attempt_no DESC LIMIT 1)=?
                """
                params.append(expected_attempt_id)
            cur = conn.execute(
                f"""
                UPDATE tasks SET status='queued', next_run_at=?, updated_at=?, pid=NULL,
                    process_marker=NULL, exit_code=?, last_error_class=?, last_error=?,
                    tried_proxy_ids_json=?, version=version+1
                WHERE id=? AND cancel_requested=0 {attempt_guard}
                """,
                params,
            )
            if cur.rowcount:
                conn.execute("DELETE FROM leases WHERE task_id=?", (task_id,))
                self.add_event(conn, task_id, "retry_scheduled", {"next_run_at": next_run_at, "error_class": error_class})
            return bool(cur.rowcount)

    def request_cancel(self, task_id: str) -> dict[str, Any] | None:
        now = self._clock()
        with self._transaction() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                return None
            status = row["status"]
            if status in TERMINAL_STATUSES:
                return self._task(row)
            if status == "queued":
                conn.execute(
                    """
                    UPDATE tasks SET status='cancelled', cancel_requested=1,
                        finished_at=?, updated_at=?, version=version+1 WHERE id=?
                    """,
                    (now, now, task_id),
                )
                self.add_event(conn, task_id, "cancelled")
            else:
                conn.execute(
                    """
                    UPDATE tasks SET status='cancelling', cancel_requested=1,
                        updated_at=?, version=version+1 WHERE id=?
                    """,
                    (now, task_id),
                )
                self.add_event(conn, task_id, "cancelling")
            return self._task(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())

    def retry_task(self, task_id: str, additional_attempts: int) -> dict[str, Any] | None:
        now = self._clock()
        with self._transaction() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                return None
            if row["status"] not in TERMINAL_STATUSES:
                raise RuntimeError("仅终态任务支持重新排队")
            prior_attempts = int(row["attempt_count"])
            max_attempts = prior_attempts + max(1, int(additional_attempts))
            conn.execute(
                """
                UPDATE tasks SET status='queued', cancel_requested=0, next_run_at=?,
                    started_at=NULL, finished_at=NULL, updated_at=?, max_attempts=?,
                    pid=NULL, process_marker=NULL, exit_code=NULL, backoff_anchor_attempt=?,
                    tried_proxy_ids_json='[]', version=version+1 WHERE id=?
                """,
                (now, now, max_attempts, prior_attempts, task_id),
            )
            self.add_event(conn, task_id, "manually_retried", {"max_attempts": max_attempts})
            return self._task(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())

    def set_lease(self, task_id: str, attempt_id: str, node_id: str, endpoint: str, site: str) -> None:
        now = self._clock()
        with self._transaction() as conn:
            conn.execute(
                """
                INSERT INTO leases(task_id, attempt_id, node_id, endpoint, site, acquired_at, heartbeat_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(task_id) DO UPDATE SET attempt_id=excluded.attempt_id,
                    node_id=excluded.node_id, endpoint=excluded.endpoint, site=excluded.site,
                    acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at
                """,
                (task_id, attempt_id, node_id, endpoint, site, now, now),
            )
            self.add_event(conn, task_id, "proxy_acquired", {"node_id": node_id, "endpoint": endpoint})

    def clear_lease(self, task_id: str, attempt_id: str | None = None) -> None:
        with self._transaction() as conn:
            if attempt_id is None:
                conn.execute("DELETE FROM leases WHERE task_id=?", (task_id,))
            else:
                conn.execute(
                    "DELETE FROM leases WHERE task_id=? AND attempt_id=?",
                    (task_id, attempt_id),
                )

    def append_logs_bulk(
        self,
        rows: Iterable[tuple[str, str | None, float, str, str]],
    ) -> int | None:
        prepared = [
            (task_id, attempt_id, ts, stream, redact_text(line, limit=8000))
            for task_id, attempt_id, ts, stream, line in rows
        ]
        if not prepared:
            return None

        increments: dict[str, int] = {}
        for task_id, _attempt_id, _ts, _stream, _line in prepared:
            increments[task_id] = increments.get(task_id, 0) + 1
        max_logs_per_task = self._max_logs_per_task()
        prune_threshold = max_logs_per_task // 4

        # 计数与事务共用数据库锁；只有提交成功后才发布新计数。
        with self._lock:
            next_counts = {
                task_id: self._since_prune.get(task_id, 0) + count
                for task_id, count in increments.items()
            }
            prune_task_ids = [
                task_id
                for task_id, count in next_counts.items()
                if count > prune_threshold
            ]
            with self._transaction() as conn:
                conn.executemany(
                    "INSERT INTO task_logs(task_id, attempt_id, ts, stream, line) "
                    "VALUES (?, ?, ?, ?, ?)",
                    prepared,
                )
                last_row = conn.execute("SELECT last_insert_rowid()").fetchone()
                for task_id in prune_task_ids:
                    conn.execute(
                        """
                        DELETE FROM task_logs WHERE task_id=? AND id NOT IN (
                            SELECT id FROM task_logs WHERE task_id=? ORDER BY id DESC LIMIT ?
                        )
                        """,
                        (task_id, task_id, max_logs_per_task),
                    )
            for task_id, count in next_counts.items():
                self._since_prune[task_id] = 0 if task_id in prune_task_ids else count
        return int(last_row[0]) if last_row is not None else None

    def append_log(self, task_id: str, attempt_id: str | None, stream: str, line: str) -> int:
        log_id = self.append_logs_bulk(
            [(task_id, attempt_id, self._clock(), stream, line)]
        )
        return int(log_id or 0)

    def get_logs(self, task_id: str, *, since: int = 0, tail: int | None = None, limit: int = 1000) -> list[dict[str, Any]]:
        with self._read() as conn:
            if tail is not None:
                rows = conn.execute(
                    "SELECT * FROM task_logs WHERE task_id=? ORDER BY id DESC LIMIT ?",
                    (task_id, max(1, min(int(tail), 5000))),
                ).fetchall()
                return [dict(row) for row in reversed(rows)]
            rows = conn.execute(
                "SELECT * FROM task_logs WHERE task_id=? AND id>? ORDER BY id ASC LIMIT ?",
                (task_id, max(0, int(since)), max(1, min(int(limit), 5000))),
            ).fetchall()
            return [dict(row) for row in rows]

    def get_events(self, task_id: str, *, since: int = 0, limit: int = 1000) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                "SELECT * FROM task_events WHERE task_id=? AND id>? ORDER BY id ASC LIMIT ?",
                (task_id, max(0, int(since)), max(1, min(int(limit), 5000))),
            ).fetchall()
            result: list[dict[str, Any]] = []
            for row in rows:
                data = dict(row)
                try:
                    data["payload"] = json.loads(data.pop("payload_json") or "{}")
                except Exception:
                    data["payload"] = {}
                result.append(data)
            return result

    def update_artifacts(self, task_id: str, count: int, total_bytes: int) -> None:
        with self._transaction() as conn:
            conn.execute(
                "UPDATE tasks SET artifact_count=?, artifact_bytes=?, updated_at=? WHERE id=?",
                (max(0, int(count)), max(0, int(total_bytes)), self._clock(), task_id),
            )

    def incomplete_processes(self) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                "SELECT id, pid, process_marker, status, attempt_count, max_attempts FROM tasks WHERE status IN ('starting','running','cancelling')"
            ).fetchall()
            return [dict(row) for row in rows]

    def recover_incomplete(self) -> int:
        now = self._clock()
        recovered = 0
        with self._transaction() as conn:
            rows = conn.execute(
                "SELECT * FROM tasks WHERE status IN ('starting','running','cancelling')"
            ).fetchall()
            for row in rows:
                task_id = row["id"]
                if row["cancel_requested"]:
                    conn.execute(
                        """
                        UPDATE tasks SET status='cancelled', finished_at=?, updated_at=?,
                            pid=NULL, process_marker=NULL, last_error_class='backend_restart',
                            last_error='后端重启时任务处于取消流程' WHERE id=?
                        """,
                        (now, now, task_id),
                    )
                    self.add_event(conn, task_id, "cancelled_after_restart")
                elif int(row["attempt_count"]) < int(row["max_attempts"]):
                    conn.execute(
                        """
                        UPDATE tasks SET status='queued', next_run_at=?, updated_at=?,
                            pid=NULL, process_marker=NULL, last_error_class='backend_restart',
                            last_error='后端重启，任务重新排队' WHERE id=?
                        """,
                        (now, now, task_id),
                    )
                    self.add_event(conn, task_id, "requeued_after_restart")
                else:
                    conn.execute(
                        """
                        UPDATE tasks SET status='failed', finished_at=?, updated_at=?,
                            pid=NULL, process_marker=NULL, last_error_class='backend_restart',
                            last_error='后端重启且重试次数已用尽' WHERE id=?
                        """,
                        (now, now, task_id),
                    )
                    self.add_event(conn, task_id, "failed_after_restart")
                conn.execute(
                    """
                    UPDATE attempts SET status='orphaned', finished_at=?,
                        error_class='backend_restart', error_message='后端重启'
                    WHERE task_id=? AND status='running'
                    """,
                    (now, task_id),
                )
                conn.execute("DELETE FROM leases WHERE task_id=?", (task_id,))
                recovered += 1
        return recovered
