from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

from ._database_crawl_repository import (
    CrawlRepository,
    refresh_crawl_batch_counts,
)
from ._database_repository import (
    ACTIVE_STATUSES,
    TERMINAL_BATCH_STATUSES,
    TERMINAL_STATUSES,
    project_attempt,
    project_crawl_address,
    project_crawl_batch,
    project_crawl_review,
    project_crawl_review_group,
    project_crawl_review_image,
    project_task,
)
from ._database_schema import (
    CURRENT_SCHEMA_VERSION,
    SITE_POLICY_SIMPLIFICATION_SCHEMA_VERSION,
    initialize_schema,
)
from ._database_task_repository import TaskRepository
from .file_security import ensure_private_directory, secure_sqlite_files
from .redaction import redact_data, redact_text
from .site_policy import EditableSitePolicy


MAX_CRAWL_REVIEW_GROUPS = 10_000


class CrawlReviewGroupLimitExceeded(RuntimeError):
    pass


class Database:
    def __init__(self, path: Path, *, max_logs_per_task: int = 5000) -> None:
        # 不先 resolve 叶节点，否则 SQLite 文件符号链接会被静默解引用。
        self.path = Path(os.path.abspath(os.fspath(path)))
        # 已存在的自定义外部父目录保持用户权限；新目录仍以 0700 创建。
        ensure_private_directory(self.path.parent, repair_existing=False)
        secure_sqlite_files(self.path)
        self.max_logs_per_task = max(100, int(max_logs_per_task))
        self._since_prune: dict[str, int] = {}
        self._lock = threading.RLock()
        self._reader_local = threading.local()
        self._reader_registry: list[sqlite3.Connection] = []
        self._reader_registry_lock = threading.Lock()
        # `_conn` 始终是唯一写连接；所有写事务继续由 `_transaction()` 串行化。
        self._conn = sqlite3.connect(
            str(self.path),
            timeout=30.0,
            isolation_level=None,
            check_same_thread=False,
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA busy_timeout=10000")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._initialize()
        self._task_repository = TaskRepository(
            read=self._read,
            transaction=self._transaction,
            write_lock=self._lock,
            since_prune=self._since_prune,
            max_logs_per_task=lambda: self.max_logs_per_task,
            clock=lambda: time.time(),
            uuid4=lambda: uuid.uuid4(),
        )
        self._crawl_repository = CrawlRepository(
            read=self._read,
            transaction=self._transaction,
            clock=lambda: time.time(),
            uuid4=lambda: uuid.uuid4(),
            add_event=self._task_repository.add_event,
            get_review=lambda batch_id: self.get_crawl_review(batch_id),
        )
        secure_sqlite_files(self.path)

    def _initialize(self) -> None:
        initialize_schema(self._conn, self._transaction)

    def _reader(self) -> sqlite3.Connection:
        conn = getattr(self._reader_local, "connection", None)
        if conn is not None:
            return conn
        conn = sqlite3.connect(
            str(self.path),
            timeout=30.0,
            isolation_level=None,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA busy_timeout=10000")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA query_only=ON")
        except Exception:
            conn.close()
            raise
        with self._reader_registry_lock:
            self._reader_registry.append(conn)
        self._reader_local.connection = conn
        return conn

    # 可见性铁律：任何需要观察“当前未提交事务写入”的读，必须使用
    # `_transaction()` 产出的 `conn`，绝不能调用基于 `_read()` 的公开方法。
    # WAL 下读连接只能看到已提交快照。
    @contextmanager
    def _read(self) -> Iterator[sqlite3.Connection]:
        yield self._reader()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except Exception:
                # Never let a rollback error (e.g. SQLite already auto-rolled-back,
                # "no transaction is active") replace the original exception the
                # caller is trying to classify.
                if self._conn.in_transaction:
                    try:
                        self._conn.execute("ROLLBACK")
                    except sqlite3.Error:
                        pass
                raise
            else:
                try:
                    self._conn.execute("COMMIT")
                except sqlite3.Error:
                    # A failed COMMIT (disk full, I/O error) otherwise leaves the
                    # shared connection stuck inside the transaction, so every later
                    # BEGIN IMMEDIATE fails with "cannot start a transaction within a
                    # transaction" until the process restarts. Roll back and re-raise.
                    if self._conn.in_transaction:
                        try:
                            self._conn.execute("ROLLBACK")
                        except sqlite3.Error:
                            pass
                    raise

    @staticmethod
    def _task(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return project_task(row)

    @staticmethod
    def _attempt(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return project_attempt(row)

    @staticmethod
    def _crawl_batch(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return project_crawl_batch(row)

    @staticmethod
    def _crawl_address(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return project_crawl_address(row)

    @staticmethod
    def _crawl_review(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return project_crawl_review(row)

    @staticmethod
    def _crawl_review_group(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return project_crawl_review_group(row)

    @staticmethod
    def _crawl_review_image(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return project_crawl_review_image(row)

    # 该方法负责连接生命周期，必须在锁保护下关闭写连接并清理全部读连接。
    def close(self) -> None:
        with self._lock:
            self._conn.close()
        with self._reader_registry_lock:
            for conn in self._reader_registry:
                conn.close()
            self._reader_registry.clear()
        secure_sqlite_files(self.path)

    def ping(self) -> bool:
        with self._read() as conn:
            return conn.execute("SELECT 1").fetchone()[0] == 1

    def _event(self, conn: sqlite3.Connection, task_id: str, event_type: str, payload: dict[str, Any] | None = None) -> None:
        self._task_repository.add_event(conn, task_id, event_type, payload)

    # 创建与幂等检查必须共用写事务，不能迁移到只读连接。
    def create_task(self, values: dict[str, Any], *, idempotency_key: str | None = None) -> tuple[dict[str, Any], bool]:
        return self._task_repository.create_task(values, idempotency_key=idempotency_key)

    # 块内任务创建、地址链接、来源键和排队事件必须保留在单一写事务中。
    def create_crawl_media_tasks(
        self,
        address_id: str,
        items: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        return self._crawl_repository.create_crawl_media_tasks(address_id, items)

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        return self._task_repository.get_task(task_id)

    def get_task_by_idempotency(self, key: str) -> dict[str, Any] | None:
        return self._task_repository.get_task_by_idempotency(key)

    def list_tasks(
        self,
        *,
        status: str | None = None,
        site: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        return self._task_repository.list_tasks(
            status=status, site=site, limit=limit, offset=offset
        )

    def queued_tasks(
        self,
        limit: int = 100,
        exclude_sites: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        return self._task_repository.queued_tasks(limit, exclude_sites)

    def queued_task_ids(self, task_ids: set[str]) -> set[str]:
        return self._task_repository.queued_task_ids(task_ids)

    # 凭证状态与事件必须在同一写事务内原子提交。
    def mark_task_credentials_unavailable(self, task_id: str, site: str) -> bool:
        return self._task_repository.mark_task_credentials_unavailable(task_id, site)

    # 条件领取与事件记录必须在同一写事务内完成。
    def claim_task(self, task_id: str) -> bool:
        return self._task_repository.claim_task(task_id)

    # 任务状态读取与 attempt、事件写入必须在同一写事务内完成。
    def begin_attempt(self, task_id: str) -> dict[str, Any]:
        return self._task_repository.begin_attempt(task_id)

    # attempt 进程字段与事件必须在同一写事务内更新。
    def set_process(self, task_id: str, attempt_id: str, pid: int, marker: str) -> None:
        return self._task_repository.set_process(task_id, attempt_id, pid, marker)

    # attempt 归属读取及完成状态与事件写入必须共用写事务。
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
        return self._task_repository.finish_attempt(
            attempt_id,
            exit_code=exit_code,
            status=status,
            error_class=error_class,
            error_message=error_message,
            retryable=retryable,
            proxy_node_id=proxy_node_id,
            proxy_endpoint=proxy_endpoint,
        )

    # 终态更新、租约清理、事件和返回行必须共用同一写事务连接。
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
        return self._task_repository.complete_task(
            task_id,
            status,
            exit_code=exit_code,
            error_class=error_class,
            error_message=error_message,
            expected_attempt_id=expected_attempt_id,
        )

    # 重新排队、租约清理与事件写入必须在同一写事务内完成。
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
        return self._task_repository.requeue_task(
            task_id,
            next_run_at=next_run_at,
            exit_code=exit_code,
            error_class=error_class,
            error_message=error_message,
            tried_proxy_ids=tried_proxy_ids,
            expected_attempt_id=expected_attempt_id,
        )

    # 状态判定、取消更新、事件和返回行必须共用同一写事务连接。
    def request_cancel(self, task_id: str) -> dict[str, Any] | None:
        return self._task_repository.request_cancel(task_id)

    # 终态与尝试次数读取、预算更新及返回行必须共用写事务。
    def retry_task(self, task_id: str, additional_attempts: int) -> dict[str, Any] | None:
        return self._task_repository.retry_task(task_id, additional_attempts)

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
        return self._crawl_repository._requeue_crawl_batch_tasks(
            conn,
            batch_id,
            statuses=statuses,
            extra=extra,
            now=now,
            event_payload=event_payload,
        )

    # 批次、地址和任务的读取、重排与计数刷新必须保持原子写事务。
    def retry_failed_crawl_tasks(
        self,
        batch_id: str,
        additional_attempts: int = 1,
    ) -> dict[str, Any] | None:
        return self._crawl_repository.retry_failed_crawl_tasks(batch_id, additional_attempts)

    # 终态校验、任务重排、地址复位、审核清理与计数刷新必须原子完成。
    def rerun_crawl_batch(
        self,
        batch_id: str,
        additional_attempts: int = 1,
        requeue_succeeded: bool = False,
    ) -> dict[str, Any] | None:
        return self._crawl_repository.rerun_crawl_batch(
            batch_id, additional_attempts, requeue_succeeded
        )

    # 租约与事件必须在同一写事务内写入。
    def set_lease(self, task_id: str, attempt_id: str, node_id: str, endpoint: str, site: str) -> None:
        return self._task_repository.set_lease(task_id, attempt_id, node_id, endpoint, site)

    # 租约删除必须保留单一写连接事务。
    def clear_lease(self, task_id: str, attempt_id: str | None = None) -> None:
        return self._task_repository.clear_lease(task_id, attempt_id)

    # 批量日志插入、裁剪与计数维护必须保留 T4 的单一写事务。
    def append_logs_bulk(
        self,
        rows: Iterable[tuple[str, str | None, float, str, str]],
    ) -> int | None:
        return self._task_repository.append_logs_bulk(rows)

    # 单行日志委托批量写入路径，必须沿用其单一写事务。
    def append_log(self, task_id: str, attempt_id: str | None, stream: str, line: str) -> int:
        return self._task_repository.append_log(task_id, attempt_id, stream, line)

    def get_logs(self, task_id: str, *, since: int = 0, tail: int | None = None, limit: int = 1000) -> list[dict[str, Any]]:
        return self._task_repository.get_logs(
            task_id, since=since, tail=tail, limit=limit
        )

    def get_events(self, task_id: str, *, since: int = 0, limit: int = 1000) -> list[dict[str, Any]]:
        return self._task_repository.get_events(task_id, since=since, limit=limit)

    # 产物计数更新属于写路径，必须保留单一写事务。
    def update_artifacts(self, task_id: str, count: int, total_bytes: int) -> None:
        return self._task_repository.update_artifacts(task_id, count, total_bytes)

    # 幂等检查与批次、地址创建必须在同一写事务内完成。
    def create_crawl_batch(
        self,
        values: dict[str, Any],
        addresses: list[dict[str, Any]],
        *,
        idempotency_key: str | None = None,
    ) -> tuple[str, bool]:
        return self._crawl_repository.create_crawl_batch(
            values, addresses, idempotency_key=idempotency_key
        )

    def get_crawl_batch_by_idempotency(self, key: str) -> dict[str, Any] | None:
        return self._crawl_repository.get_crawl_batch_by_idempotency(key)

    def crawl_batch_tick_view(self, batch_id: str) -> dict[str, Any] | None:
        return self._crawl_repository.crawl_batch_tick_view(batch_id)

    def get_crawl_batch(self, batch_id: str) -> dict[str, Any] | None:
        return self._crawl_repository.get_crawl_batch(batch_id)

    def list_crawl_batches(self, *, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        return self._crawl_repository.list_crawl_batches(limit=limit, offset=offset)

    def get_crawl_review(self, batch_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM crawl_reviews WHERE batch_id=?",
                (batch_id,),
            ).fetchone()
            review = self._crawl_review(row)
            if review is None:
                return None
            image_counts = conn.execute(
                """
                SELECT
                    SUM(CASE WHEN selected=1 THEN 1 ELSE 0 END) AS selected_count,
                    SUM(CASE WHEN disposition='kept' THEN 1 ELSE 0 END) AS kept_count,
                    SUM(CASE WHEN disposition='rejected' THEN 1 ELSE 0 END) AS rejected_count,
                    SUM(CASE WHEN disposition='failed' THEN 1 ELSE 0 END) AS failed_count
                FROM crawl_review_images WHERE batch_id=?
                """,
                (batch_id,),
            ).fetchone()
            decided = conn.execute(
                """
                SELECT COUNT(*) FROM crawl_review_groups
                WHERE batch_id=? AND decided=1 AND kind NOT LIKE 'auto_%'
                """,
                (batch_id,),
            ).fetchone()[0]
        review["selected_image_count"] = int(image_counts["selected_count"] or 0)
        review["kept_image_count"] = int(image_counts["kept_count"] or review["kept_image_count"] or 0)
        review["rejected_image_count"] = int(
            image_counts["rejected_count"] or review["rejected_image_count"] or 0
        )
        review["failed_image_count"] = int(
            image_counts["failed_count"] or review["failed_image_count"] or 0
        )
        review["decided_group_count"] = int(decided or 0)
        return review

    # 批次终态校验与审核登记必须通过写事务原子衔接。
    def start_crawl_review(self, batch_id: str) -> dict[str, Any]:
        now = time.time()
        with self._transaction() as conn:
            batch = conn.execute(
                "SELECT status FROM crawl_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            if batch is None:
                raise KeyError(batch_id)
            if batch["status"] not in {"succeeded", "completed_with_errors", "cancelled"}:
                raise RuntimeError("爬取批次结束后才能启动去重分析")
            conn.execute(
                """
                INSERT INTO crawl_reviews(batch_id, status, created_at, updated_at)
                VALUES (?, 'pending', ?, ?)
                ON CONFLICT(batch_id) DO UPDATE SET status='pending', updated_at=?, error=''
                WHERE crawl_reviews.status='waiting_for_crawl'
                """,
                (batch_id, now, now, now),
            )
        review = self.get_crawl_review(batch_id)
        if review is None:
            raise RuntimeError("去重分析任务建立后读取失败")
        return review

    # 重启恢复会更新审核状态，必须保留单一写事务。
    def recover_crawl_reviews(self) -> int:
        now = time.time()
        with self._transaction() as conn:
            analyzing = conn.execute(
                """
                UPDATE crawl_reviews SET status='pending', updated_at=?,
                    error='服务重启，重新执行去重分析'
                WHERE status='analyzing'
                """,
                (now,),
            ).rowcount
            applying = conn.execute(
                """
                UPDATE crawl_reviews SET status='apply_failed', updated_at=?,
                    error='服务重启，需重试应用审核结果'
                WHERE status='applying'
                """,
                (now,),
            ).rowcount
            return int(analyzing + applying)

    # 候选选择与条件领取必须在同一写事务内完成。
    def claim_next_crawl_review(self) -> dict[str, Any] | None:
        now = time.time()
        with self._transaction() as conn:
            row = conn.execute(
                """
                SELECT cr.batch_id, cb.output_dir FROM crawl_reviews cr
                JOIN crawl_batches cb ON cb.id=cr.batch_id
                WHERE cr.status='pending'
                  AND cb.status IN ('succeeded','completed_with_errors','cancelled')
                ORDER BY cb.finished_at, cb.created_at LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            updated = conn.execute(
                """
                UPDATE crawl_reviews SET status='analyzing', started_at=?, updated_at=?,
                    ready_at=NULL, applied_at=NULL, error=''
                WHERE batch_id=? AND status='pending'
                """,
                (now, now, row["batch_id"]),
            )
            if not updated.rowcount:
                return None
            return {"batch_id": str(row["batch_id"]), "output_dir": str(row["output_dir"])}

    def next_crawl_review_automatic(self) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                """
                SELECT cr.batch_id, cb.output_dir FROM crawl_reviews cr
                JOIN crawl_batches cb ON cb.id=cr.batch_id
                WHERE cr.status='auto_applying'
                ORDER BY cr.updated_at, cr.created_at LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            return {
                "batch_id": str(row["batch_id"]),
                "output_dir": str(row["output_dir"]),
            }

    # 审核重新排队会修改状态，必须保留单一写事务。
    def requeue_crawl_review(self, batch_id: str) -> None:
        with self._transaction() as conn:
            conn.execute(
                """
                UPDATE crawl_reviews SET status='pending', updated_at=?, error=''
                WHERE batch_id=? AND status='analyzing'
                """,
                (time.time(), batch_id),
            )

    # 审核失败状态与脱敏错误必须通过写事务保存。
    def fail_crawl_review(self, batch_id: str, error: str, *, log_path: str = "") -> None:
        with self._transaction() as conn:
            conn.execute(
                """
                UPDATE crawl_reviews SET status='failed', error=?, analysis_log_path=?,
                    updated_at=? WHERE batch_id=? AND status='analyzing'
                """,
                (redact_text(error, limit=4000), log_path, time.time(), batch_id),
            )

    # 状态校验、旧清单删除与审核复位必须在同一写事务内完成。
    def retry_crawl_review(self, batch_id: str) -> bool:
        now = time.time()
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT status FROM crawl_reviews WHERE batch_id=?",
                (batch_id,),
            ).fetchone()
            if row is None:
                return False
            if row["status"] != "failed":
                raise RuntimeError("当前审核分析状态不允许重试")
            conn.execute("DELETE FROM crawl_review_groups WHERE batch_id=?", (batch_id,))
            conn.execute(
                """
                UPDATE crawl_reviews SET status='pending', total_image_count=0,
                    total_group_count=0, duplicate_group_count=0, unreadable_image_count=0,
                    automatic_group_count=0, automatic_rejected_image_count=0,
                    kept_image_count=0, rejected_image_count=0, failed_image_count=0,
                    error='', updated_at=?, started_at=NULL, ready_at=NULL, applied_at=NULL
                WHERE batch_id=?
                """,
                (now, batch_id),
            )
            return True

    # 状态校验、清单替换与汇总更新必须在同一写事务内完成。
    def replace_crawl_review_manifest(
        self,
        batch_id: str,
        manifest: dict[str, Any],
        *,
        log_path: str = "",
    ) -> None:
        groups = list(manifest.get("groups") or [])
        automatic_groups = list(manifest.get("auto_groups") or [])
        now = time.time()
        with self._transaction() as conn:
            review = conn.execute(
                "SELECT status FROM crawl_reviews WHERE batch_id=?",
                (batch_id,),
            ).fetchone()
            if review is None or review["status"] != "analyzing":
                raise RuntimeError("审核任务未处于分析状态")
            conn.execute("DELETE FROM crawl_review_groups WHERE batch_id=?", (batch_id,))
            image_count = 0
            duplicate_count = 0
            unreadable_count = 0
            automatic_rejected_count = 0
            seen_group_ids: set[str] = set()
            seen_image_ids: set[str] = set()
            seen_paths: set[str] = set()

            def insert_group(
                group_id: str,
                ordinal: int,
                kind: str,
                match_levels: list[Any],
                reason: str,
                *,
                decided: bool,
            ) -> None:
                if not group_id or group_id in seen_group_ids:
                    raise ValueError("审核清单包含空或重复的组 ID")
                seen_group_ids.add(group_id)
                conn.execute(
                    """
                    INSERT INTO crawl_review_groups(
                        batch_id, id, ordinal, kind, match_levels_json, reason,
                        decided, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        batch_id,
                        group_id,
                        ordinal,
                        kind,
                        json.dumps(match_levels, ensure_ascii=False),
                        redact_text(reason, limit=1000),
                        int(decided),
                        now,
                        now,
                    ),
                )

            def insert_image(
                group_id: str,
                image: dict[str, Any],
                fallback_ordinal: int,
                *,
                selected: bool,
                metadata_extra: dict[str, Any] | None = None,
            ) -> None:
                nonlocal image_count, unreadable_count
                image_id = str(image.get("id") or "").strip()
                relative_path = str(image.get("relative_path") or "").strip()
                if not image_id or image_id in seen_image_ids:
                    raise ValueError("审核清单包含空或重复的图片 ID")
                if not relative_path or relative_path in seen_paths:
                    raise ValueError("审核清单包含空或重复的图片路径")
                seen_image_ids.add(image_id)
                seen_paths.add(relative_path)
                metadata = dict(image.get("metadata") or {})
                if metadata_extra:
                    metadata.update(metadata_extra)
                # The worker emits per-image SSCD/DINO similarity as a top-level
                # review_metrics key; fold it into metadata_json so it survives to the
                # API (the UI reads image.metadata.review_metrics). Without this the
                # review cards never showed the similarity scores.
                if image.get("review_metrics") is not None:
                    metadata["review_metrics"] = image["review_metrics"]
                readable = bool(image.get("readable", True))
                if not readable:
                    unreadable_count += 1
                conn.execute(
                    """
                    INSERT INTO crawl_review_images(
                        batch_id, id, group_id, ordinal, relative_path, file_hash,
                        metadata_json, readable, recommended, selected, disposition,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                    """,
                    (
                        batch_id,
                        image_id,
                        group_id,
                        int(image.get("ordinal") or fallback_ordinal),
                        relative_path,
                        str(metadata.get("file_hash") or ""),
                        json.dumps(metadata, ensure_ascii=False, allow_nan=False),
                        int(readable),
                        int(bool(image.get("recommended"))),
                        int(selected),
                        now,
                        now,
                    ),
                )
                image_count += 1

            for fallback_ordinal, group in enumerate(groups, 1):
                group_id = str(group.get("id") or "").strip()
                kind = str(group.get("kind") or "single")
                if kind == "duplicate":
                    duplicate_count += 1
                items = list(group.get("items") or [])
                insert_group(
                    group_id,
                    int(group.get("ordinal") or fallback_ordinal),
                    kind,
                    list(group.get("match_levels") or []),
                    str(group.get("reason") or ""),
                    decided=False,
                )
                for fallback_image_ordinal, image in enumerate(items, 1):
                    insert_image(
                        group_id,
                        image,
                        fallback_image_ordinal,
                        selected=True,
                    )

            manual_ordinals = [
                int(group.get("ordinal") or fallback)
                for fallback, group in enumerate(groups, 1)
            ]
            automatic_ordinal = max(manual_ordinals, default=0)
            for fallback_ordinal, group in enumerate(automatic_groups, 1):
                group_id = str(group.get("id") or "").strip()
                automatic_kind = str(group.get("kind") or "")
                if automatic_kind not in {"exact", "compression"}:
                    raise ValueError("自动去重组类型无效")
                winner = dict(group.get("winner") or {})
                winner_path = str(winner.get("relative_path") or "").strip()
                rejected_items = list(group.get("rejected_items") or [])
                if not winner_path or not rejected_items:
                    raise ValueError("自动去重组缺少保留图或淘汰图")
                insert_group(
                    group_id,
                    automatic_ordinal + fallback_ordinal,
                    f"auto_{automatic_kind}",
                    list(group.get("match_levels") or []),
                    str(group.get("reason") or ""),
                    decided=True,
                )
                for fallback_image_ordinal, image in enumerate(rejected_items, 1):
                    insert_image(
                        group_id,
                        image,
                        fallback_image_ordinal,
                        selected=False,
                        metadata_extra={
                            "automatic_dedup": {
                                "kind": automatic_kind,
                                "winner_relative_path": winner_path,
                                "reason": str(group.get("reason") or ""),
                            }
                        },
                    )
                    automatic_rejected_count += 1

            expected_images = int((manifest.get("counts") or {}).get("images") or 0)
            if expected_images != image_count:
                raise ValueError("审核清单的总图片计数不一致")
            next_status = "auto_applying" if automatic_rejected_count else "ready"
            conn.execute(
                """
                UPDATE crawl_reviews SET status=?, total_image_count=?,
                    total_group_count=?, duplicate_group_count=?, unreadable_image_count=?,
                    automatic_group_count=?, automatic_rejected_image_count=?,
                    kept_image_count=0, rejected_image_count=0, failed_image_count=0,
                    error='', analysis_log_path=?, ready_at=?, updated_at=?
                WHERE batch_id=?
                """,
                (
                    next_status,
                    image_count,
                    len(groups),
                    duplicate_count,
                    unreadable_count,
                    len(automatic_groups),
                    automatic_rejected_count,
                    log_path,
                    now if next_status == "ready" else None,
                    now,
                    batch_id,
                ),
            )

    def list_crawl_review_groups(
        self,
        batch_id: str,
        *,
        kind: str | None = None,
        limit: int = 12,
        offset: int = 0,
        all_groups: bool = False,
    ) -> dict[str, Any]:
        where = "batch_id=? AND kind NOT LIKE 'auto_%'"
        params: list[Any] = [batch_id]
        if kind:
            where += " AND kind=?"
            params.append(kind)
        page_limit = (
            MAX_CRAWL_REVIEW_GROUPS
            if all_groups
            else max(1, min(int(limit), 50))
        )
        page_offset = 0 if all_groups else max(0, int(offset))
        with self._read() as conn:
            total = int(
                conn.execute(
                    f"SELECT COUNT(*) FROM crawl_review_groups WHERE {where}",
                    params,
                ).fetchone()[0]
            )
            if all_groups and total > MAX_CRAWL_REVIEW_GROUPS:
                raise CrawlReviewGroupLimitExceeded(
                    f"审核组数量超过全量读取上限 {MAX_CRAWL_REVIEW_GROUPS}"
                )
            rows = conn.execute(
                f"""
                SELECT * FROM crawl_review_groups WHERE {where}
                ORDER BY ordinal LIMIT ? OFFSET ?
                """,
                [*params, page_limit, page_offset],
            ).fetchall()
            groups: list[dict[str, Any]] = []
            for row in rows:
                group = self._crawl_review_group(row)
                if group is None:
                    continue
                image_rows = conn.execute(
                    """
                    SELECT * FROM crawl_review_images
                    WHERE batch_id=? AND group_id=? ORDER BY ordinal
                    """,
                    (batch_id, group["id"]),
                ).fetchall()
                group["images"] = [
                    self._crawl_review_image(image_row) for image_row in image_rows
                ]
                group["image_count"] = len(group["images"])
                group["selected_image_count"] = sum(
                    bool(image and image.get("selected")) for image in group["images"]
                )
                groups.append(group)
        return {
            "items": groups,
            "total": total,
            "limit": len(groups) if all_groups else page_limit,
            "offset": page_offset,
        }

    # 审核状态、组和图片归属校验必须与选择更新原子完成。
    def update_crawl_review_decisions(
        self,
        batch_id: str,
        decisions: list[dict[str, Any]],
    ) -> None:
        now = time.time()
        with self._transaction() as conn:
            review = conn.execute(
                "SELECT status FROM crawl_reviews WHERE batch_id=?",
                (batch_id,),
            ).fetchone()
            if review is None:
                raise KeyError(batch_id)
            if review["status"] != "ready":
                raise RuntimeError("当前审核状态不允许修改选择")
            seen_groups: set[str] = set()
            for decision in decisions:
                group_id = str(decision.get("group_id") or "")
                if not group_id or group_id in seen_groups:
                    raise ValueError("审核决策包含空或重复的组 ID")
                seen_groups.add(group_id)
                group_row = conn.execute(
                    "SELECT kind FROM crawl_review_groups WHERE batch_id=? AND id=?",
                    (batch_id, group_id),
                ).fetchone()
                if group_row is None:
                    raise KeyError(group_id)
                if str(group_row["kind"] or "").startswith("auto_"):
                    # Auto-dedup groups are applied by the worker, not the user. Flipping a
                    # rejected auto-image back to selected would make apply look for a file
                    # the worker already moved away -> apply_failed + skewed auto counts.
                    raise ValueError("不能修改自动去重组的选择")
                rows = conn.execute(
                    """
                    SELECT id FROM crawl_review_images WHERE batch_id=? AND group_id=?
                    """,
                    (batch_id, group_id),
                ).fetchall()
                if not rows:
                    raise KeyError(group_id)
                available = {str(row["id"]) for row in rows}
                selected = {str(value) for value in decision.get("selected_image_ids") or []}
                if not selected.issubset(available):
                    raise ValueError("审核决策包含不属于当前组的图片 ID")
                conn.execute(
                    """
                    UPDATE crawl_review_images SET selected=0, updated_at=?
                    WHERE batch_id=? AND group_id=?
                    """,
                    (now, batch_id, group_id),
                )
                if selected:
                    conn.executemany(
                        """
                        UPDATE crawl_review_images SET selected=1, updated_at=?
                        WHERE batch_id=? AND group_id=? AND id=?
                        """,
                        [(now, batch_id, group_id, image_id) for image_id in selected],
                    )
                conn.execute(
                    """
                    UPDATE crawl_review_groups SET decided=1, updated_at=?
                    WHERE batch_id=? AND id=?
                    """,
                    (now, batch_id, group_id),
                )
            conn.execute(
                "UPDATE crawl_reviews SET updated_at=? WHERE batch_id=?",
                (now, batch_id),
            )

    def get_crawl_review_image(self, batch_id: str, image_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                """
                SELECT cri.*, cb.output_dir FROM crawl_review_images cri
                JOIN crawl_batches cb ON cb.id=cri.batch_id
                WHERE cri.batch_id=? AND cri.id=?
                """,
                (batch_id, image_id),
            ).fetchone()
            return self._crawl_review_image(row)

    # 审核与批次状态、未决组检查必须和 applying 更新共用写事务。
    def begin_crawl_review_apply(self, batch_id: str) -> bool:
        with self._transaction() as conn:
            review = conn.execute(
                """
                SELECT cr.status AS status, cb.status AS batch_status
                FROM crawl_reviews cr JOIN crawl_batches cb ON cb.id=cr.batch_id
                WHERE cr.batch_id=?
                """,
                (batch_id,),
            ).fetchone()
            if review is None or review["status"] not in {"ready", "apply_failed"}:
                return False
            # A rerun/retry can pull the batch back to running after the review turned
            # ready; applying an old manifest then would move files while gallery-dl is
            # writing the same tree (and re-download whatever we "rejected"). Refuse
            # unless the batch is terminal again.
            if review["batch_status"] not in TERMINAL_BATCH_STATUSES:
                return False
            undecided = int(
                conn.execute(
                    """
                    SELECT COUNT(*) FROM crawl_review_groups
                    WHERE batch_id=? AND decided=0
                    """,
                    (batch_id,),
                ).fetchone()[0]
            )
            if undecided:
                raise RuntimeError(f"还有 {undecided} 个图片组尚未确认")
            updated = conn.execute(
                """
                UPDATE crawl_reviews SET status='applying', error='', updated_at=?
                WHERE batch_id=? AND status IN ('ready','apply_failed')
                """,
                (time.time(), batch_id),
            )
            return bool(updated.rowcount)

    def crawl_review_apply_images(self, batch_id: str) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT * FROM crawl_review_images WHERE batch_id=?
                ORDER BY group_id, ordinal
                """,
                (batch_id,),
            ).fetchall()
            return [self._crawl_review_image(row) for row in rows]  # type: ignore[misc]

    def crawl_review_automatic_images(self, batch_id: str) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT cri.* FROM crawl_review_images cri
                JOIN crawl_review_groups crg
                    ON crg.batch_id=cri.batch_id AND crg.id=cri.group_id
                WHERE cri.batch_id=? AND crg.kind LIKE 'auto_%' AND cri.selected=0
                ORDER BY crg.ordinal, cri.ordinal
                """,
                (batch_id,),
            ).fetchall()
            return [self._crawl_review_image(row) for row in rows]  # type: ignore[misc]

    # 自动处置计数与审核状态更新必须在同一写事务内完成。
    def finish_crawl_review_automatic(self, batch_id: str) -> dict[str, Any] | None:
        now = time.time()
        with self._transaction() as conn:
            counts = conn.execute(
                """
                SELECT
                    SUM(CASE WHEN cri.disposition='rejected' THEN 1 ELSE 0 END) AS rejected,
                    SUM(CASE WHEN cri.disposition='failed' THEN 1 ELSE 0 END) AS failed
                FROM crawl_review_images cri
                JOIN crawl_review_groups crg
                    ON crg.batch_id=cri.batch_id AND crg.id=cri.group_id
                WHERE cri.batch_id=? AND crg.kind LIKE 'auto_%'
                """,
                (batch_id,),
            ).fetchone()
            rejected = int(counts["rejected"] or 0)
            failed = int(counts["failed"] or 0)
            error = f"{failed} 张严格自动淘汰图片处理失败" if failed else ""
            updated = conn.execute(
                """
                UPDATE crawl_reviews SET status='ready', rejected_image_count=?,
                    failed_image_count=?, error=?, ready_at=?, updated_at=?
                WHERE batch_id=? AND status='auto_applying'
                """,
                (rejected, failed, error, now, now, batch_id),
            )
            if not updated.rowcount:
                return None
        return self.get_crawl_review(batch_id)

    # 文件移动阶段状态会被持久化，必须保留单一写事务。
    def stage_crawl_review_image_move(
        self,
        batch_id: str,
        image_id: str,
        final_relative_path: str,
    ) -> None:
        with self._transaction() as conn:
            conn.execute(
                """
                UPDATE crawl_review_images SET disposition='moving', final_relative_path=?,
                    error='', updated_at=? WHERE batch_id=? AND id=?
                """,
                (final_relative_path, time.time(), batch_id, image_id),
            )

    # 图片处置结果与脱敏错误必须通过写事务保存。
    def finish_crawl_review_image(
        self,
        batch_id: str,
        image_id: str,
        disposition: str,
        *,
        final_relative_path: str,
        error: str = "",
    ) -> None:
        if disposition not in {"kept", "rejected", "failed"}:
            raise ValueError("审核图片结果状态无效")
        with self._transaction() as conn:
            conn.execute(
                """
                UPDATE crawl_review_images SET disposition=?, final_relative_path=?,
                    error=?, updated_at=? WHERE batch_id=? AND id=?
                """,
                (
                    disposition,
                    final_relative_path,
                    redact_text(error, limit=2000),
                    time.time(),
                    batch_id,
                    image_id,
                ),
            )

    # 处置计数与审核终态更新必须在同一写事务内完成。
    def finish_crawl_review_apply(self, batch_id: str) -> dict[str, Any] | None:
        now = time.time()
        with self._transaction() as conn:
            counts = conn.execute(
                """
                SELECT
                    SUM(CASE WHEN disposition='kept' THEN 1 ELSE 0 END) AS kept,
                    SUM(CASE WHEN disposition='rejected' THEN 1 ELSE 0 END) AS rejected,
                    SUM(CASE WHEN disposition NOT IN ('kept','rejected') THEN 1 ELSE 0 END) AS failed
                FROM crawl_review_images WHERE batch_id=?
                """,
                (batch_id,),
            ).fetchone()
            kept = int(counts["kept"] or 0)
            rejected = int(counts["rejected"] or 0)
            failed = int(counts["failed"] or 0)
            status = "apply_failed" if failed else "applied"
            error = f"{failed} 张图片处理失败" if failed else ""
            conn.execute(
                """
                UPDATE crawl_reviews SET status=?, kept_image_count=?, rejected_image_count=?,
                    failed_image_count=?, error=?, updated_at=?, applied_at=? WHERE batch_id=?
                """,
                (status, kept, rejected, failed, error, now, now if not failed else None, batch_id),
            )
        return self.get_crawl_review(batch_id)

    def active_crawl_batch_ids(self) -> list[str]:
        return self._crawl_repository.active_crawl_batch_ids()

    def next_crawl_address(self, batch_id: str) -> dict[str, Any] | None:
        return self._crawl_repository.next_crawl_address(batch_id)

    # 探测汇总与节点集合替换必须在同一写事务内原子完成。
    def save_crawl_address_proxy_probe(
        self,
        address_id: str,
        *,
        target_url: str,
        total_count: int,
        healthy_node_ids: list[str],
        error: str = "",
    ) -> dict[str, Any]:
        checked_at = time.time()
        node_ids = list(dict.fromkeys(str(value) for value in healthy_node_ids if str(value)))
        with self._transaction() as conn:
            address = conn.execute(
                "SELECT id FROM crawl_addresses WHERE id=?",
                (address_id,),
            ).fetchone()
            if address is None:
                raise KeyError(address_id)
            conn.execute(
                """
                INSERT INTO crawl_address_proxy_probes(
                    address_id, target_url, total_count, healthy_count, checked_at, last_error
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(address_id) DO UPDATE SET
                    target_url=excluded.target_url,
                    total_count=excluded.total_count,
                    healthy_count=excluded.healthy_count,
                    checked_at=excluded.checked_at,
                    last_error=excluded.last_error
                """,
                (
                    address_id,
                    target_url,
                    max(0, int(total_count)),
                    len(node_ids),
                    checked_at,
                    redact_text(error, limit=2000),
                ),
            )
            conn.execute(
                "DELETE FROM crawl_address_proxy_nodes WHERE address_id=?",
                (address_id,),
            )
            conn.executemany(
                "INSERT INTO crawl_address_proxy_nodes(address_id, node_id) VALUES (?, ?)",
                ((address_id, node_id) for node_id in node_ids),
            )
        return self.get_crawl_address_proxy_probe(address_id)  # type: ignore[return-value]

    def get_crawl_address_proxy_probe(self, address_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM crawl_address_proxy_probes WHERE address_id=?",
                (address_id,),
            ).fetchone()
            if row is None:
                return None
            node_rows = conn.execute(
                """
                SELECT node_id FROM crawl_address_proxy_nodes
                WHERE address_id=? ORDER BY node_id
                """,
                (address_id,),
            ).fetchall()
        result = dict(row)
        result["node_ids"] = [str(item["node_id"]) for item in node_rows]
        return result

    # 地址存在性读取、条件状态更新与批次激活必须共用写事务。
    def begin_crawl_address_planning(self, address_id: str) -> bool:
        return self._crawl_repository.begin_crawl_address_planning(address_id)

    def task_crawl_batch_id(self, task_id: str) -> str | None:
        return self._crawl_repository.task_crawl_batch_id(task_id)

    def crawl_batch_cancel_requested(self, batch_id: str) -> bool | None:
        return self._crawl_repository.crawl_batch_cancel_requested(batch_id)

    # 链接冲突读取、来源键写入与批次计数更新必须共用写事务。
    def link_crawl_task(
        self,
        address_id: str,
        task_id: str,
        sequence_no: int,
        *,
        source_key: str | None = None,
        source_url: str | None = None,
    ) -> None:
        return self._crawl_repository.link_crawl_task(
            address_id,
            task_id,
            sequence_no,
            source_key=source_key,
            source_url=source_url,
        )

    def succeeded_danbooru_source_keys(
        self,
        batch_id: str,
        source_keys: list[str] | set[str] | tuple[str, ...],
    ) -> set[str]:
        return self._crawl_repository.succeeded_danbooru_source_keys(batch_id, source_keys)

    def succeeded_danbooru_source_key_count(
        self,
        batch_id: str,
        target_site: str,
    ) -> int:
        return self._crawl_repository.succeeded_danbooru_source_key_count(batch_id, target_site)

    # 地址预去重计数更新属于写路径，必须保留单一写事务。
    def set_crawl_address_pre_dedup_skipped_count(
        self,
        address_id: str,
        skipped_count: int,
    ) -> bool:
        return self._crawl_repository.set_crawl_address_pre_dedup_skipped_count(address_id, skipped_count)

    # 地址与批次状态校验、终态及计数刷新必须共用写事务。
    def finish_crawl_address_as_pre_deduplicated(
        self,
        address_id: str,
        skipped_count: int,
    ) -> bool:
        return self._crawl_repository.finish_crawl_address_as_pre_deduplicated(address_id, skipped_count)

    # 已链接任务计数、地址状态与批次计数校准必须共用写事务。
    def mark_crawl_address_running(
        self, address_id: str, *, last_error: str = "", planning_error: str = ""
    ) -> bool:
        return self._crawl_repository.mark_crawl_address_running(
            address_id, last_error=last_error, planning_error=planning_error
        )

    # 地址规划状态复位属于写路径，必须保留单一写事务。
    def reset_crawl_address_planning(self, address_id: str, error: str = "") -> bool:
        return self._crawl_repository.reset_crawl_address_planning(address_id, error)

    def crawl_address_tasks(self, address_id: str) -> list[dict[str, Any]]:
        return self._crawl_repository.crawl_address_tasks(address_id)

    def list_crawl_tasks(
        self,
        batch_id: str,
        *,
        address_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        return self._crawl_repository.list_crawl_tasks(
            batch_id, address_id=address_id, limit=limit, offset=offset
        )

    def crawl_batch_task_count(self, batch_id: str) -> int:
        return self._crawl_repository.crawl_batch_task_count(batch_id)

    def crawl_address_task_count(self, address_id: str) -> int:
        return self._crawl_repository.crawl_address_task_count(address_id)

    @staticmethod
    def _refresh_crawl_batch_counts(conn: sqlite3.Connection, batch_id: str) -> None:
        refresh_crawl_batch_counts(conn, batch_id, now=time.time())

    # 地址、任务与批次状态读取及终态计数更新必须共用写事务。
    def finish_crawl_address_if_terminal(self, address_id: str) -> bool:
        return self._crawl_repository.finish_crawl_address_if_terminal(address_id)

    # 地址归属读取、失败状态与批次计数更新必须共用写事务。
    def fail_crawl_address(self, address_id: str, error: str) -> None:
        return self._crawl_repository.fail_crawl_address(address_id, error)

    # 批次与地址状态读取、计数刷新及终态更新必须共用写事务。
    def finish_crawl_batch_if_ready(self, batch_id: str) -> bool:
        return self._crawl_repository.finish_crawl_batch_if_ready(batch_id)

    # 批次状态读取、地址取消与待取消任务读取必须共用写事务。
    def request_cancel_crawl_batch(self, batch_id: str) -> tuple[dict[str, Any] | None, list[str]]:
        return self._crawl_repository.request_cancel_crawl_batch(batch_id)

    # 恢复地址和批次状态需要多条原子更新，必须保留单一写事务。
    def recover_ordered_crawls(self) -> int:
        return self._crawl_repository.recover_ordered_crawls()

    # 站点策略 upsert 属于写路径，必须保留单一写事务。
    def put_site_policy(self, site: str, policy: dict[str, Any]) -> dict[str, Any]:
        normalized = EditableSitePolicy.model_validate(policy).model_dump()
        now = time.time()
        with self._transaction() as conn:
            conn.execute(
                """
                INSERT INTO site_policies(site, policy_json, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(site) DO UPDATE SET policy_json=excluded.policy_json, updated_at=excluded.updated_at
                """,
                (site, json.dumps(normalized, ensure_ascii=False), now),
            )
        return {"site": site, "policy": normalized, "updated_at": now}

    def get_site_policy(self, site: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute("SELECT * FROM site_policies WHERE site=?", (site,)).fetchone()
            if row is None:
                return None
            return {"site": row["site"], "policy": json.loads(row["policy_json"]), "updated_at": row["updated_at"]}

    def list_site_policies(self) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute("SELECT * FROM site_policies ORDER BY site").fetchall()
            return [
                {"site": row["site"], "policy": json.loads(row["policy_json"]), "updated_at": row["updated_at"]}
                for row in rows
            ]

    # 站点策略删除属于写路径，必须保留单一写事务。
    def delete_site_policy(self, site: str) -> bool:
        with self._transaction() as conn:
            return bool(conn.execute("DELETE FROM site_policies WHERE site=?", (site,)).rowcount)

    def incomplete_processes(self) -> list[dict[str, Any]]:
        return self._task_repository.incomplete_processes()

    # 未完成任务读取及任务、attempt、租约与事件更新必须共用写事务。
    def recover_incomplete(self) -> int:
        return self._task_repository.recover_incomplete()
