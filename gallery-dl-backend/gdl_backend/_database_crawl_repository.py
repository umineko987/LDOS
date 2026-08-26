from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from typing import Any

from ._database_repository import (
    Clock,
    ReadFactory,
    TERMINAL_BATCH_STATUSES,
    TransactionFactory,
    UuidFactory,
    project_crawl_address,
    project_crawl_batch,
    project_task,
)
from .redaction import redact_text


EventWriter = Callable[
    [sqlite3.Connection, str, str, dict[str, Any] | None],
    None,
]
ReviewReader = Callable[[str], dict[str, Any] | None]


def refresh_crawl_batch_counts(
    connection: sqlite3.Connection,
    batch_id: str,
    *,
    now: float,
) -> None:
    counts = connection.execute(
        """
        SELECT COUNT(*) AS total,
            SUM(CASE WHEN t.status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
            SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN t.status='cancelled' THEN 1 ELSE 0 END) AS cancelled
        FROM crawl_address_tasks cat
        JOIN crawl_addresses ca ON ca.id=cat.address_id
        JOIN tasks t ON t.id=cat.task_id
        WHERE ca.batch_id=?
        """,
        (batch_id,),
    ).fetchone()
    connection.execute(
        """
        UPDATE crawl_batches SET task_count=?, succeeded_task_count=?,
            failed_task_count=?, cancelled_task_count=?, updated_at=? WHERE id=?
        """,
        (
            int(counts["total"] or 0),
            int(counts["succeeded"] or 0),
            int(counts["failed"] or 0),
            int(counts["cancelled"] or 0),
            now,
            batch_id,
        ),
    )


class CrawlRepository:
    """Ordered crawl and batch persistence over Database-owned boundaries."""

    def __init__(
        self,
        *,
        read: ReadFactory,
        transaction: TransactionFactory,
        clock: Clock,
        uuid4: UuidFactory,
        add_event: EventWriter,
        get_review: ReviewReader,
    ) -> None:
        self._read = read
        self._transaction = transaction
        self._clock = clock
        self._uuid4 = uuid4
        self._add_event = add_event
        self._get_review = get_review

    _task = staticmethod(project_task)
    _crawl_batch = staticmethod(project_crawl_batch)
    _crawl_address = staticmethod(project_crawl_address)

    def _refresh_crawl_batch_counts(
        self,
        connection: sqlite3.Connection,
        batch_id: str,
    ) -> None:
        refresh_crawl_batch_counts(connection, batch_id, now=self._clock())

    def create_crawl_media_tasks(
        self,
        address_id: str,
        items: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        with self._transaction() as conn:
            address_row = conn.execute(
                """
                SELECT ca.batch_id, ca.status AS address_status, cb.cancel_requested
                FROM crawl_addresses ca
                JOIN crawl_batches cb ON cb.id=ca.batch_id
                WHERE ca.id=?
                """,
                (address_id,),
            ).fetchone()
            if address_row is None:
                raise ValueError("爬取地址不存在")
            batch_id = str(address_row["batch_id"])
            batch_cancelled = bool(address_row["cancel_requested"]) or str(
                address_row["address_status"]
            ) == "cancelled"
            # Do not create a late chunk after cancellation has committed. The
            # cancellation endpoint may finalize the batch as soon as all currently
            # linked tasks are terminal; returning before any INSERT keeps a planner
            # that lost the race from appending new tasks after that authority read.
            if batch_cancelled:
                return []
            for item in items:
                values = item["task"]
                idempotency_key = item["idempotency_key"]
                if not isinstance(idempotency_key, str) or not idempotency_key:
                    raise ValueError("爬取媒体任务缺少有效幂等键")

                now = self._clock()
                proposed_task_id = str(values.get("id") or self._uuid4())
                inserted = conn.execute(
                    """
                    INSERT INTO tasks(
                        id, idempotency_key, url, site, subcategory, extractor, status,
                        priority, output_dir, proxy_mode, max_attempts, attempt_count,
                        next_run_at, created_at, updated_at, cookies_file, config_file,
                        credentials_ref, extra_args_json, policy_json, tried_proxy_ids_json
                    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, '[]')
                    ON CONFLICT(idempotency_key) DO NOTHING
                    """,
                    (
                        proposed_task_id,
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
                created = bool(inserted.rowcount)
                task_row = conn.execute(
                    "SELECT id FROM tasks WHERE idempotency_key=?",
                    (idempotency_key,),
                ).fetchone()
                if task_row is None:
                    raise RuntimeError("爬取媒体任务写入后无法回读")
                task_id = str(task_row["id"])
                if created:
                    self._add_event(conn, task_id, "queued", {"site": values["site"]})

                link_now = self._clock()
                already_linked = conn.execute(
                    "SELECT 1 FROM crawl_address_tasks WHERE address_id=? AND task_id=?",
                    (address_id, task_id),
                ).fetchone()
                if already_linked is None:
                    requested_sequence = int(item["sequence_no"])
                    slot_taken = conn.execute(
                        "SELECT 1 FROM crawl_address_tasks WHERE address_id=? AND sequence_no=?",
                        (address_id, requested_sequence),
                    ).fetchone()
                    if slot_taken is None:
                        effective_sequence = requested_sequence
                    else:
                        effective_sequence = int(
                            conn.execute(
                                "SELECT COALESCE(MAX(sequence_no), 0) + 1 "
                                "FROM crawl_address_tasks WHERE address_id=?",
                                (address_id,),
                            ).fetchone()[0]
                        )
                    conn.execute(
                        """
                        INSERT INTO crawl_address_tasks(
                            address_id, task_id, sequence_no, created_at
                        ) VALUES (?, ?, ?, ?)
                        """,
                        (address_id, task_id, effective_sequence, link_now),
                    )

                normalized_key = str(item.get("source_key") or "").strip()
                if normalized_key:
                    conn.execute(
                        """
                        INSERT INTO crawl_task_source_keys(
                            task_id, source_key, source_url, created_at
                        ) VALUES (?, ?, ?, ?)
                        ON CONFLICT(task_id, source_key) DO UPDATE SET
                            source_url=excluded.source_url
                        """,
                        (
                            task_id,
                            normalized_key[:500],
                            str(item.get("source_url") or "").strip()[:8192],
                            link_now,
                        ),
                    )

                if already_linked is None:
                    conn.execute(
                        "UPDATE crawl_batches SET task_count=task_count+1, updated_at=? WHERE id=?",
                        (link_now, batch_id),
                    )
                results.append({"task_id": task_id, "created": created})
        return results

    def _requeue_crawl_batch_tasks(
        self,
        conn: sqlite3.Connection,
        batch_id: str,
        *,
        statuses: tuple[str, ...],
        extra: int,
        now: float,
        event_payload: dict[str, Any],
    ) -> list[str]:
        """Requeue every media task of a batch whose status is in ``statuses``.

        Shared by retry (failed/cancelled only) and rerun (also succeeded when asked).
        Anchors the backoff exponent to the prior attempt_count and grows the budget by
        ``extra``, without blanking last_error. Returns the requeued task ids in order.
        """
        placeholders = ",".join("?" for _ in statuses)
        rows = conn.execute(
            f"""
            SELECT t.id, t.attempt_count
            FROM crawl_address_tasks cat
            JOIN crawl_addresses ca ON ca.id=cat.address_id
            JOIN tasks t ON t.id=cat.task_id
            WHERE ca.batch_id=? AND t.status IN ({placeholders})
            ORDER BY ca.source_order, ca.address_order, cat.sequence_no
            """,
            (batch_id, *statuses),
        ).fetchall()
        task_ids = [str(row["id"]) for row in rows]
        for row in rows:
            task_id = str(row["id"])
            prior_attempts = int(row["attempt_count"])
            max_attempts = prior_attempts + extra
            conn.execute(
                f"""
                UPDATE tasks SET status='queued', cancel_requested=0, next_run_at=?,
                    started_at=NULL, finished_at=NULL, updated_at=?, max_attempts=?,
                    pid=NULL, process_marker=NULL, exit_code=NULL,
                    backoff_anchor_attempt=?, tried_proxy_ids_json='[]',
                    version=version+1 WHERE id=? AND status IN ({placeholders})
                """,
                (now, now, max_attempts, prior_attempts, task_id, *statuses),
            )
            conn.execute("DELETE FROM leases WHERE task_id=?", (task_id,))
            self._add_event(
                conn,
                task_id,
                "manually_retried",
                {**event_payload, "max_attempts": max_attempts},
            )
        return task_ids

    def retry_failed_crawl_tasks(
        self,
        batch_id: str,
        additional_attempts: int = 1,
    ) -> dict[str, Any] | None:
        """Requeue only failed media tasks in a finished crawl batch."""
        now = self._clock()
        extra = max(1, int(additional_attempts))
        with self._transaction() as conn:
            batch = conn.execute(
                "SELECT id FROM crawl_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            if batch is None:
                return None
            task_ids = self._requeue_crawl_batch_tasks(
                conn,
                batch_id,
                statuses=("failed", "cancelled"),
                extra=extra,
                now=now,
                event_payload={"batch_id": batch_id},
            )
            address_rows = conn.execute(
                """
                SELECT DISTINCT ca.id
                FROM crawl_address_tasks cat
                JOIN crawl_addresses ca ON ca.id=cat.address_id
                JOIN tasks t ON t.id=cat.task_id
                WHERE ca.batch_id=? AND t.status='queued'
                """,
                (batch_id,),
            ).fetchall()
            address_ids = [str(row["id"]) for row in address_rows]
            for address_id in address_ids:
                conn.execute(
                    """
                    UPDATE crawl_addresses SET status='running', finished_at=NULL,
                        updated_at=?, last_error='' WHERE id=? AND status IN ('failed','cancelled')
                    """,
                    (now, address_id),
                )
            replanned_rows = conn.execute(
                """
                SELECT id FROM crawl_addresses
                WHERE batch_id=? AND planning_error != ''
                ORDER BY source_order, address_order
                """,
                (batch_id,),
            ).fetchall()
            replanned_address_ids = [str(row["id"]) for row in replanned_rows]
            for address_id in replanned_address_ids:
                # Reset to a clean pending state so the OrderedCrawlManager re-plans the
                # whole address. Existing crawl_address_tasks stay linked: re-planning is
                # idempotent (same enqueue key) and gallery-dl skips downloaded files, so
                # succeeded units are not re-fetched, only missing units are added.
                conn.execute(
                    """
                    UPDATE crawl_addresses SET status='pending', planning_error='',
                        last_error='', started_at=NULL, finished_at=NULL, updated_at=?
                    WHERE id=?
                    """,
                    (now, address_id),
                )
            if task_ids or replanned_address_ids:
                conn.execute(
                    """
                    UPDATE crawl_batches SET status='running', cancel_requested=0,
                        finished_at=NULL, updated_at=?, last_error='' WHERE id=?
                    """,
                    (now, batch_id),
                )
            self._refresh_crawl_batch_counts(conn, batch_id)
        return {
            "batch_id": batch_id,
            "retried_count": len(task_ids),
            "task_ids": task_ids,
            "address_ids": address_ids,
            "replanned_address_count": len(replanned_address_ids),
            "replanned_address_ids": replanned_address_ids,
        }

    def rerun_crawl_batch(
        self,
        batch_id: str,
        additional_attempts: int = 1,
        requeue_succeeded: bool = False,
    ) -> dict[str, Any] | None:
        """Re-open a finished crawl batch in place.

        Resets every address back to 'pending' so the OrderedCrawlManager re-plans them
        against the SAME position-based output dirs, requeues failed and cancelled media
        tasks (also succeeded when ``requeue_succeeded``), and reactivates the batch.
        Succeeded tasks are kept as-is by default, so idempotent re-enqueue returns them
        with zero re-execution and only new / failed units are downloaded. Existing task
        links and proxy-probe rows are preserved. Returns None for an unknown batch and
        ``{"batch_id":..., "not_terminal": True}`` when the batch is not yet finished.
        """
        now = self._clock()
        extra = max(1, int(additional_attempts))
        terminal_batch = {"succeeded", "completed_with_errors", "cancelled"}
        # finish_crawl_address_as_pre_deduplicated marks addresses 'succeeded', so the
        # resettable set is exactly the terminal address statuses (nothing distinct).
        terminal_address = ("succeeded", "failed", "cancelled")
        statuses = (
            ("failed", "cancelled", "succeeded")
            if requeue_succeeded
            else ("failed", "cancelled")
        )
        with self._transaction() as conn:
            batch = conn.execute(
                "SELECT status FROM crawl_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            if batch is None:
                return None
            if str(batch["status"]) not in terminal_batch:
                return {"batch_id": batch_id, "not_terminal": True}
            task_ids = self._requeue_crawl_batch_tasks(
                conn,
                batch_id,
                statuses=statuses,
                extra=extra,
                now=now,
                event_payload={"batch_id": batch_id, "rerun": True},
            )
            address_placeholders = ",".join("?" for _ in terminal_address)
            address_rows = conn.execute(
                f"""
                SELECT id FROM crawl_addresses
                WHERE batch_id=? AND status IN ({address_placeholders})
                ORDER BY source_order, address_order
                """,
                (batch_id, *terminal_address),
            ).fetchall()
            replanned_address_ids = [str(row["id"]) for row in address_rows]
            conn.execute(
                f"""
                UPDATE crawl_addresses SET status='pending', planning_error='',
                    last_error='', started_at=NULL, finished_at=NULL, updated_at=?
                WHERE batch_id=? AND status IN ({address_placeholders})
                """,
                (now, batch_id, *terminal_address),
            )
            conn.execute(
                """
                UPDATE crawl_batches SET status='running', cancel_requested=0,
                    finished_at=NULL, last_error='', updated_at=? WHERE id=?
                """,
                (now, batch_id),
            )
            # A rerun changes the batch's file set, so any existing review manifest is
            # stale — and there is otherwise no path to re-analyze it (retry only accepts
            # 'failed', start only a not_started batch). Drop the review entirely so the
            # re-finished batch can be analyzed fresh. In-flight reviews are blocked from
            # rerun at the API layer (_REVIEW_IN_FLIGHT).
            conn.execute("DELETE FROM crawl_review_images WHERE batch_id=?", (batch_id,))
            conn.execute("DELETE FROM crawl_review_groups WHERE batch_id=?", (batch_id,))
            conn.execute("DELETE FROM crawl_reviews WHERE batch_id=?", (batch_id,))
            self._refresh_crawl_batch_counts(conn, batch_id)
        return {
            "batch_id": batch_id,
            "requeued_task_count": len(task_ids),
            "task_ids": task_ids,
            "replanned_address_count": len(replanned_address_ids),
            "replanned_address_ids": replanned_address_ids,
            "requeue_succeeded": bool(requeue_succeeded),
        }

    def create_crawl_batch(
        self,
        values: dict[str, Any],
        addresses: list[dict[str, Any]],
        *,
        idempotency_key: str | None = None,
    ) -> tuple[str, bool]:
        now = self._clock()
        with self._transaction() as conn:
            if idempotency_key:
                existing = conn.execute(
                    "SELECT id FROM crawl_batches WHERE idempotency_key=?",
                    (idempotency_key,),
                ).fetchone()
                if existing is not None:
                    return str(existing["id"]), False
            batch_id = str(values.get("id") or self._uuid4())
            conn.execute(
                """
                INSERT INTO crawl_batches(
                    id, idempotency_key, status, output_dir, concurrency, max_tasks,
                    created_at, updated_at
                ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)
                """,
                (
                    batch_id,
                    idempotency_key,
                    values["output_dir"],
                    int(values["concurrency"]),
                    int(values["max_tasks"]),
                    now,
                    now,
                ),
            )
            for address in addresses:
                conn.execute(
                    """
                    INSERT INTO crawl_addresses(
                        id, batch_id, site, source_order, address_order, url, label,
                        address_type, status, proxy_mode, max_attempts, priority,
                        credentials_ref, cookies_file, config_file, download_options_json,
                        extra_args_json, discovery_args_json, timeout_seconds, created_at,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        address["id"],
                        batch_id,
                        address["site"],
                        int(address["source_order"]),
                        int(address["address_order"]),
                        address["url"],
                        address.get("label", ""),
                        address.get("address_type", ""),
                        address["proxy_mode"],
                        int(address["max_attempts"]),
                        int(address.get("priority", 0)),
                        address.get("credentials_ref"),
                        address.get("cookies_file"),
                        address.get("config_file"),
                        json.dumps(address.get("download_options", {}), ensure_ascii=False),
                        json.dumps(address.get("extra_args", []), ensure_ascii=False),
                        json.dumps(address.get("discovery_args", []), ensure_ascii=False),
                        float(address.get("timeout_seconds", 180.0)),
                        now,
                        now,
                    ),
                )
            return batch_id, True

    def get_crawl_batch_by_idempotency(self, key: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT id FROM crawl_batches WHERE idempotency_key=?",
                (key,),
            ).fetchone()
        return self.get_crawl_batch(str(row["id"])) if row else None

    def crawl_batch_tick_view(self, batch_id: str) -> dict[str, Any] | None:
        """返回顺序批次轮询所需的最小状态，不加载地址、探活或审核聚合。"""
        with self._read() as conn:
            row = conn.execute(
                """
                SELECT id, status, cancel_requested, max_tasks, concurrency, output_dir
                FROM crawl_batches WHERE id=?
                """,
                (batch_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "id": str(row["id"]),
            "status": str(row["status"]),
            "cancel_requested": bool(row["cancel_requested"]),
            "max_tasks": int(row["max_tasks"]),
            "concurrency": int(row["concurrency"]),
            "output_dir": str(row["output_dir"]),
        }

    def get_crawl_batch(self, batch_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM crawl_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            batch = self._crawl_batch(row)
            if batch is None:
                return None
            rows = conn.execute(
                """
                SELECT ca.*, cap.target_url AS proxy_probe_target,
                    cap.total_count AS probed_proxy_count,
                    cap.healthy_count AS healthy_proxy_count,
                    cap.checked_at AS proxy_probed_at,
                    cap.last_error AS proxy_probe_error
                FROM crawl_addresses ca
                LEFT JOIN crawl_address_proxy_probes cap ON cap.address_id=ca.id
                WHERE ca.batch_id=? ORDER BY ca.source_order, ca.address_order
                """,
                (batch_id,),
            ).fetchall()
            addresses = [self._crawl_address(item) for item in rows]

        sources: list[dict[str, Any]] = []
        source_index: dict[int, dict[str, Any]] = {}
        current: dict[str, Any] | None = None
        terminal = {"succeeded", "failed", "cancelled"}
        for address in addresses:
            if address is None:
                continue
            order = int(address["source_order"])
            group = source_index.get(order)
            if group is None:
                group = {
                    "order": order,
                    "site": address["site"],
                    "status": "pending",
                    "addresses": [],
                }
                source_index[order] = group
                sources.append(group)
            group["addresses"].append(address)
            group["pre_dedup_skipped_count"] = int(
                group.get("pre_dedup_skipped_count") or 0
            ) + int(address.get("pre_dedup_skipped_count") or 0)
            if current is None and address["status"] not in terminal:
                current = {
                    "source_order": order,
                    "address_order": address["address_order"],
                    "address_id": address["id"],
                    "site": address["site"],
                    "url": address["url"],
                    "status": address["status"],
                }
        for group in sources:
            statuses = [item["status"] for item in group["addresses"]]
            if all(status == "succeeded" for status in statuses):
                group["status"] = "succeeded"
            elif any(status in {"planning", "running"} for status in statuses):
                group["status"] = "running"
            elif any(status == "failed" for status in statuses) and all(status in terminal for status in statuses):
                group["status"] = "completed_with_errors"
            elif all(status == "cancelled" for status in statuses):
                group["status"] = "cancelled"
        batch["sources"] = sources
        batch["source_count"] = len(sources)
        batch["address_count"] = sum(len(item["addresses"]) for item in sources)
        batch["pre_dedup_skipped_count"] = sum(
            int(item.get("pre_dedup_skipped_count") or 0) for item in sources
        )
        batch["current"] = current
        batch["execution_order"] = "source_then_address"
        batch["lease_model"] = "one-media-task-one-node"
        # A terminal batch can be resumed when there is failed/cancelled media work to
        # requeue, or an address whose planning never completed (planning_error set) and
        # so needs re-planning. Computed from already-loaded rows — no extra query.
        terminal_batch = {"succeeded", "completed_with_errors", "cancelled"}
        has_planning_gap = any(
            str((address or {}).get("planning_error") or "") for address in addresses
        )
        batch["resumable"] = bool(
            batch["status"] in terminal_batch
            and (
                int(batch.get("failed_task_count") or 0) > 0
                or int(batch.get("cancelled_task_count") or 0) > 0
                or has_planning_gap
            )
        )
        batch["review"] = self._get_review(batch_id)
        return batch

    def list_crawl_batches(self, *, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT * FROM crawl_batches
                ORDER BY created_at DESC LIMIT ? OFFSET ?
                """,
                (max(1, min(int(limit), 500)), max(0, int(offset))),
            ).fetchall()
            return [self._crawl_batch(row) for row in rows]

    def active_crawl_batch_ids(self) -> list[str]:
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT id FROM crawl_batches
                WHERE status IN ('queued','running','cancelling')
                ORDER BY created_at
                """
            ).fetchall()
            return [str(row["id"]) for row in rows]

    def next_crawl_address(self, batch_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                """
                SELECT * FROM crawl_addresses
                WHERE batch_id=? AND status NOT IN ('succeeded','failed','cancelled')
                ORDER BY source_order, address_order LIMIT 1
                """,
                (batch_id,),
            ).fetchone()
            return self._crawl_address(row)

    def begin_crawl_address_planning(self, address_id: str) -> bool:
        now = self._clock()
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT batch_id FROM crawl_addresses WHERE id=?",
                (address_id,),
            ).fetchone()
            if row is None:
                return False
            cur = conn.execute(
                """
                UPDATE crawl_addresses SET status='planning', started_at=COALESCE(started_at, ?),
                    updated_at=?, last_error=''
                WHERE id=? AND status='pending'
                """,
                (now, now, address_id),
            )
            if cur.rowcount:
                conn.execute(
                    """
                    UPDATE crawl_batches SET status='running', started_at=COALESCE(started_at, ?),
                        updated_at=? WHERE id=? AND cancel_requested=0
                    """,
                    (now, now, row["batch_id"]),
                )
            return bool(cur.rowcount)

    def task_crawl_batch_id(self, task_id: str) -> str | None:
        """Return the crawl batch a task belongs to, or None for a standalone task.
        Used to route task-level retries of crawl media tasks back through the batch
        endpoint so address/batch counters stay consistent."""
        with self._read() as conn:
            row = conn.execute(
                """
                SELECT ca.batch_id FROM crawl_address_tasks cat
                JOIN crawl_addresses ca ON ca.id=cat.address_id
                WHERE cat.task_id=? LIMIT 1
                """,
                (task_id,),
            ).fetchone()
        return str(row["batch_id"]) if row else None

    def crawl_batch_cancel_requested(self, batch_id: str) -> bool | None:
        """Cheap cancel-flag read for hot planning loops, avoiding get_crawl_batch's
        full address + review load. None means the batch no longer exists."""
        with self._read() as conn:
            row = conn.execute(
                "SELECT cancel_requested FROM crawl_batches WHERE id=?", (batch_id,)
            ).fetchone()
        if row is None:
            return None
        return bool(row["cancel_requested"])

    def link_crawl_task(
        self,
        address_id: str,
        task_id: str,
        sequence_no: int,
        *,
        source_key: str | None = None,
        source_url: str | None = None,
    ) -> None:
        now = self._clock()
        with self._transaction() as conn:
            # Re-planning re-links this address's tasks. Discovery for artist feeds often
            # returns new works first, shifting positional sequence numbers, so a fresh
            # task can request a sequence_no already owned by an older task. INSERT OR
            # IGNORE would silently drop that link (UNIQUE(address_id, sequence_no)),
            # leaving the new task invisible to counts / 补齐 / completion tracking.
            # Instead: keep an existing (address, task) link untouched, take the requested
            # slot when free, else append at MAX+1.
            already_linked = conn.execute(
                "SELECT 1 FROM crawl_address_tasks WHERE address_id=? AND task_id=?",
                (address_id, task_id),
            ).fetchone()
            if already_linked is None:
                slot_taken = conn.execute(
                    "SELECT 1 FROM crawl_address_tasks WHERE address_id=? AND sequence_no=?",
                    (address_id, int(sequence_no)),
                ).fetchone()
                if slot_taken is None:
                    effective_sequence = int(sequence_no)
                else:
                    effective_sequence = int(
                        conn.execute(
                            "SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM crawl_address_tasks WHERE address_id=?",
                            (address_id,),
                        ).fetchone()[0]
                    )
                conn.execute(
                    """
                    INSERT INTO crawl_address_tasks(address_id, task_id, sequence_no, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (address_id, task_id, effective_sequence, now),
                )
            normalized_key = str(source_key or "").strip()
            if normalized_key:
                conn.execute(
                    """
                    INSERT INTO crawl_task_source_keys(
                        task_id, source_key, source_url, created_at
                    ) VALUES (?, ?, ?, ?)
                    ON CONFLICT(task_id, source_key) DO UPDATE SET
                        source_url=excluded.source_url
                    """,
                    (
                        task_id,
                        normalized_key[:500],
                        str(source_url or "").strip()[:8192],
                        now,
                    ),
                )
            if already_linked is None:
                # Only a genuinely new link changes the batch total. Increment by one
                # instead of re-running a full-batch COUNT subquery on every unit — that
                # made planning an N-unit address O(N²). mark_crawl_address_running
                # reconciles the exact value once the address is fully planned.
                row = conn.execute(
                    "SELECT batch_id FROM crawl_addresses WHERE id=?",
                    (address_id,),
                ).fetchone()
                if row:
                    conn.execute(
                        "UPDATE crawl_batches SET task_count=task_count+1, updated_at=? WHERE id=?",
                        (now, row["batch_id"]),
                    )

    def succeeded_danbooru_source_keys(
        self,
        batch_id: str,
        source_keys: list[str] | set[str] | tuple[str, ...],
    ) -> set[str]:
        keys = list(
            dict.fromkeys(
                str(value).strip() for value in source_keys if str(value).strip()
            )
        )
        if not keys:
            return set()
        matched: set[str] = set()
        with self._read() as conn:
            for offset in range(0, len(keys), 500):
                chunk = keys[offset : offset + 500]
                placeholders = ",".join("?" for _ in chunk)
                rows = conn.execute(
                    f"""
                    SELECT DISTINCT ctsk.source_key
                    FROM crawl_task_source_keys ctsk
                    JOIN tasks t ON t.id=ctsk.task_id
                    JOIN crawl_address_tasks cat ON cat.task_id=t.id
                    JOIN crawl_addresses ca ON ca.id=cat.address_id
                    WHERE ca.batch_id=? AND ca.site='danbooru'
                        AND t.status='succeeded'
                        AND ctsk.source_key IN ({placeholders})
                    """,
                    [batch_id, *chunk],
                ).fetchall()
                matched.update(str(row["source_key"]) for row in rows)
        return matched

    def succeeded_danbooru_source_key_count(
        self,
        batch_id: str,
        target_site: str,
    ) -> int:
        prefix = str(target_site).strip().lower()
        if prefix == "x":
            prefix = "twitter"
        if prefix not in {"pixiv", "twitter"}:
            return 0
        with self._read() as conn:
            row = conn.execute(
                """
                SELECT COUNT(DISTINCT ctsk.source_key)
                FROM crawl_task_source_keys ctsk
                JOIN tasks t ON t.id=ctsk.task_id
                JOIN crawl_address_tasks cat ON cat.task_id=t.id
                JOIN crawl_addresses ca ON ca.id=cat.address_id
                WHERE ca.batch_id=? AND ca.site='danbooru'
                    AND t.status='succeeded' AND ctsk.source_key LIKE ?
                """,
                (batch_id, f"{prefix}:%"),
            ).fetchone()
        return int(row[0] or 0)

    def set_crawl_address_pre_dedup_skipped_count(
        self,
        address_id: str,
        skipped_count: int,
    ) -> bool:
        with self._transaction() as conn:
            cur = conn.execute(
                """
                UPDATE crawl_addresses SET pre_dedup_skipped_count=?, updated_at=?
                WHERE id=? AND status='planning'
                """,
                (max(0, int(skipped_count)), self._clock(), address_id),
            )
            return bool(cur.rowcount)

    def finish_crawl_address_as_pre_deduplicated(
        self,
        address_id: str,
        skipped_count: int,
    ) -> bool:
        now = self._clock()
        with self._transaction() as conn:
            row = conn.execute(
                """
                SELECT ca.batch_id FROM crawl_addresses ca
                JOIN crawl_batches cb ON cb.id=ca.batch_id
                WHERE ca.id=? AND ca.status='planning' AND cb.cancel_requested=0
                """,
                (address_id,),
            ).fetchone()
            if row is None:
                return False
            cur = conn.execute(
                """
                UPDATE crawl_addresses SET status='succeeded', planned_task_count=0,
                    pre_dedup_skipped_count=?, finished_at=?, updated_at=?, last_error=''
                WHERE id=? AND status='planning'
                """,
                (max(0, int(skipped_count)), now, now, address_id),
            )
            if not cur.rowcount:
                return False
            self._refresh_crawl_batch_counts(conn, str(row["batch_id"]))
            return True

    def mark_crawl_address_running(
        self, address_id: str, *, last_error: str = "", planning_error: str = ""
    ) -> bool:
        now = self._clock()
        with self._transaction() as conn:
            count = int(
                conn.execute(
                    "SELECT COUNT(*) FROM crawl_address_tasks WHERE address_id=?",
                    (address_id,),
                ).fetchone()[0]
            )
            if count <= 0:
                return False
            cur = conn.execute(
                """
                UPDATE crawl_addresses SET status='running', planned_task_count=?, updated_at=?,
                    last_error=?, planning_error=?
                WHERE id=? AND status='planning'
                """,
                (
                    count,
                    now,
                    redact_text(last_error, limit=2000),
                    redact_text(planning_error, limit=2000),
                    address_id,
                ),
            )
            if cur.rowcount:
                # Reconcile the batch counters once per address, now that link_crawl_task
                # only increments task_count incrementally during planning.
                batch_row = conn.execute(
                    "SELECT batch_id FROM crawl_addresses WHERE id=?", (address_id,)
                ).fetchone()
                if batch_row:
                    self._refresh_crawl_batch_counts(conn, str(batch_row["batch_id"]))
            return bool(cur.rowcount)

    def reset_crawl_address_planning(self, address_id: str, error: str = "") -> bool:
        with self._transaction() as conn:
            cur = conn.execute(
                """
                UPDATE crawl_addresses SET status='pending', updated_at=?, last_error=?
                WHERE id=? AND status='planning'
                """,
                (self._clock(), redact_text(error, limit=2000), address_id),
            )
            return bool(cur.rowcount)

    def crawl_address_tasks(self, address_id: str) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT t.*, cat.sequence_no FROM crawl_address_tasks cat
                JOIN tasks t ON t.id=cat.task_id
                WHERE cat.address_id=? ORDER BY cat.sequence_no
                """,
                (address_id,),
            ).fetchall()
            return [self._task(row) | {"sequence_no": row["sequence_no"]} for row in rows]

    def list_crawl_tasks(
        self,
        batch_id: str,
        *,
        address_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        where = "ca.batch_id=?"
        params: list[Any] = [batch_id]
        if address_id:
            where += " AND ca.id=?"
            params.append(address_id)
        params.extend([max(1, min(int(limit), 1000)), max(0, int(offset))])
        with self._read() as conn:
            rows = conn.execute(
                f"""
                SELECT t.*, ca.id AS crawl_address_id, ca.source_order, ca.address_order,
                    cat.sequence_no
                FROM crawl_address_tasks cat
                JOIN crawl_addresses ca ON ca.id=cat.address_id
                JOIN tasks t ON t.id=cat.task_id
                WHERE {where}
                ORDER BY ca.source_order, ca.address_order, cat.sequence_no
                LIMIT ? OFFSET ?
                """,
                params,
            ).fetchall()
            result: list[dict[str, Any]] = []
            for row in rows:
                task = self._task(row)
                if task is not None:
                    task["crawl_address_id"] = row["crawl_address_id"]
                    task["source_order"] = row["source_order"]
                    task["address_order"] = row["address_order"]
                    task["sequence_no"] = row["sequence_no"]
                    result.append(task)
            return result

    def crawl_batch_task_count(self, batch_id: str) -> int:
        with self._read() as conn:
            return int(
                conn.execute(
                    """
                    SELECT COUNT(*) FROM crawl_address_tasks cat
                    JOIN crawl_addresses ca ON ca.id=cat.address_id
                    WHERE ca.batch_id=?
                    """,
                    (batch_id,),
                ).fetchone()[0]
            )

    def crawl_address_task_count(self, address_id: str) -> int:
        with self._read() as conn:
            return int(
                conn.execute(
                    "SELECT COUNT(*) FROM crawl_address_tasks WHERE address_id=?",
                    (address_id,),
                ).fetchone()[0]
            )

    def finish_crawl_address_if_terminal(self, address_id: str) -> bool:
        terminal = {"succeeded", "failed", "cancelled"}
        now = self._clock()
        with self._transaction() as conn:
            address = conn.execute(
                "SELECT * FROM crawl_addresses WHERE id=?",
                (address_id,),
            ).fetchone()
            if address is None or address["status"] != "running":
                return False
            rows = conn.execute(
                """
                SELECT t.status FROM crawl_address_tasks cat
                JOIN tasks t ON t.id=cat.task_id WHERE cat.address_id=?
                """,
                (address_id,),
            ).fetchall()
            statuses = [str(row["status"]) for row in rows]
            if not statuses or any(status not in terminal for status in statuses):
                return False
            batch = conn.execute(
                "SELECT cancel_requested FROM crawl_batches WHERE id=?",
                (address["batch_id"],),
            ).fetchone()
            succeeded = statuses.count("succeeded")
            failed = statuses.count("failed")
            cancelled = statuses.count("cancelled")
            planning_error = str(address["planning_error"] or "")
            status = "cancelled" if batch and batch["cancel_requested"] else "succeeded"
            if status != "cancelled" and (failed or cancelled or planning_error):
                status = "failed"
            error = (
                ""
                if status == "succeeded"
                else planning_error or f"媒体任务失败={failed}, 取消={cancelled}"
            )
            conn.execute(
                """
                UPDATE crawl_addresses SET status=?, succeeded_task_count=?,
                    failed_task_count=?, cancelled_task_count=?, finished_at=?,
                    updated_at=?, last_error=? WHERE id=?
                """,
                (status, succeeded, failed, cancelled, now, now, error, address_id),
            )
            self._refresh_crawl_batch_counts(conn, str(address["batch_id"]))
            return True

    def fail_crawl_address(self, address_id: str, error: str) -> None:
        now = self._clock()
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT batch_id FROM crawl_addresses WHERE id=?",
                (address_id,),
            ).fetchone()
            if row is None:
                return
            conn.execute(
                """
                UPDATE crawl_addresses SET status='failed', finished_at=?, updated_at=?,
                    last_error=?, planning_error=? WHERE id=? AND status NOT IN ('succeeded','failed','cancelled')
                """,
                (
                    now,
                    now,
                    redact_text(error, limit=2000),
                    redact_text(error, limit=2000),
                    address_id,
                ),
            )
            conn.execute(
                "UPDATE crawl_batches SET last_error=?, updated_at=? WHERE id=?",
                (redact_text(error, limit=2000), now, row["batch_id"]),
            )
            self._refresh_crawl_batch_counts(conn, str(row["batch_id"]))

    def finish_crawl_batch_if_ready(self, batch_id: str) -> bool:
        now = self._clock()
        with self._transaction() as conn:
            batch = conn.execute(
                "SELECT * FROM crawl_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            if batch is None:
                return False
            if batch["status"] in TERMINAL_BATCH_STATUSES:
                # Already finalized. Re-running the finish UPDATE would rewrite
                # finished_at (which also reshuffles the pending-review claim order)
                # every time a repeat cancel/retry call lands on a done batch.
                return True
            rows = conn.execute(
                "SELECT status FROM crawl_addresses WHERE batch_id=?",
                (batch_id,),
            ).fetchall()
            statuses = [str(row["status"]) for row in rows]
            terminal = {"succeeded", "failed", "cancelled"}
            has_active_tasks = conn.execute(
                """
                SELECT 1
                FROM crawl_address_tasks cat
                JOIN crawl_addresses ca ON ca.id=cat.address_id
                JOIN tasks t ON t.id=cat.task_id
                WHERE ca.batch_id=? AND t.status NOT IN ('succeeded','failed','cancelled')
                LIMIT 1
                """,
                (batch_id,),
            ).fetchone() is not None
            self._refresh_crawl_batch_counts(conn, batch_id)
            if (
                not statuses
                or any(status not in terminal for status in statuses)
                or has_active_tasks
            ):
                next_status = "cancelling" if batch["cancel_requested"] else "running"
                conn.execute(
                    "UPDATE crawl_batches SET status=?, updated_at=? WHERE id=?",
                    (next_status, now, batch_id),
                )
                return False
            if batch["cancel_requested"]:
                status = "cancelled"
            elif any(status in {"failed", "cancelled"} for status in statuses):
                status = "completed_with_errors"
            else:
                status = "succeeded"
            conn.execute(
                """
                UPDATE crawl_batches SET status=?, finished_at=?, updated_at=? WHERE id=?
                """,
                (status, now, now, batch_id),
            )
            return True

    def request_cancel_crawl_batch(self, batch_id: str) -> tuple[dict[str, Any] | None, list[str]]:
        now = self._clock()
        with self._transaction() as conn:
            batch = conn.execute(
                "SELECT * FROM crawl_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            if batch is None:
                return None, []
            if batch["status"] in {"succeeded", "completed_with_errors", "cancelled"}:
                return self._crawl_batch(batch), []  # type: ignore[return-value]
            conn.execute(
                """
                UPDATE crawl_batches SET status='cancelling', cancel_requested=1,
                    updated_at=? WHERE id=?
                """,
                (now, batch_id),
            )
            conn.execute(
                """
                UPDATE crawl_addresses SET status='cancelled', finished_at=?, updated_at=?,
                    last_error='批次已取消'
                WHERE batch_id=? AND status IN ('pending','planning')
                """,
                (now, now, batch_id),
            )
            task_rows = conn.execute(
                """
                SELECT t.id FROM crawl_address_tasks cat
                JOIN crawl_addresses ca ON ca.id=cat.address_id
                JOIN tasks t ON t.id=cat.task_id
                WHERE ca.batch_id=? AND t.status NOT IN ('succeeded','failed','cancelled')
                """,
                (batch_id,),
            ).fetchall()
            return self._crawl_batch(
                conn.execute("SELECT * FROM crawl_batches WHERE id=?", (batch_id,)).fetchone()
            ), [str(row["id"]) for row in task_rows]

    def recover_ordered_crawls(self) -> int:
        now = self._clock()
        with self._transaction() as conn:
            linked = conn.execute(
                """
                UPDATE crawl_addresses SET status='running', updated_at=?,
                    planned_task_count=(
                        SELECT COUNT(*) FROM crawl_address_tasks cat
                        WHERE cat.address_id=crawl_addresses.id
                    ),
                    last_error='后端重启时地址只完成了部分规划，等待已创建任务结束',
                    planning_error='后端重启时地址只完成了部分规划，等待已创建任务结束'
                WHERE status='planning' AND EXISTS (
                    SELECT 1 FROM crawl_address_tasks cat
                    WHERE cat.address_id=crawl_addresses.id
                )
                """,
                (now,),
            )
            pending = conn.execute(
                """
                UPDATE crawl_addresses SET status='pending', updated_at=?, last_error='后端重启后重新规划'
                WHERE status='planning' AND NOT EXISTS (
                    SELECT 1 FROM crawl_address_tasks cat
                    WHERE cat.address_id=crawl_addresses.id
                )
                """,
                (now,),
            )
            conn.execute(
                """
                UPDATE crawl_batches SET status=CASE WHEN cancel_requested=1 THEN 'cancelling' ELSE 'running' END,
                    updated_at=? WHERE status IN ('queued','running','cancelling')
                """,
                (now,),
            )
            return int(linked.rowcount) + int(pending.rowcount)
