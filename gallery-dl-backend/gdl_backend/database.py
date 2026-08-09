from __future__ import annotations

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
from ._database_policy_repository import SitePolicyRepository
from ._database_proxy_repository import ProxyProbeRepository
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
from ._database_review_repository import (
    CrawlReviewGroupLimitExceeded,
    ReviewRepository,
)
from ._database_schema import (
    CURRENT_SCHEMA_VERSION,
    SITE_POLICY_SIMPLIFICATION_SCHEMA_VERSION,
    initialize_schema,
)
from ._database_task_repository import TaskRepository
from .file_security import ensure_private_directory, secure_sqlite_files


MAX_CRAWL_REVIEW_GROUPS = 10_000


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
        self._review_repository = ReviewRepository(
            read=self._read,
            transaction=self._transaction,
            clock=lambda: time.time(),
            max_groups=lambda: MAX_CRAWL_REVIEW_GROUPS,
            get_review=lambda batch_id: self.get_crawl_review(batch_id),
        )
        self._proxy_probe_repository = ProxyProbeRepository(
            read=self._read,
            transaction=self._transaction,
            clock=lambda: time.time(),
            get_probe=lambda address_id: self.get_crawl_address_proxy_probe(address_id),
        )
        self._site_policy_repository = SitePolicyRepository(
            read=self._read,
            transaction=self._transaction,
            clock=lambda: time.time(),
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
        return self._review_repository.get_crawl_review(batch_id)

    # 批次终态校验与审核登记必须通过写事务原子衔接。
    def start_crawl_review(self, batch_id: str) -> dict[str, Any]:
        return self._review_repository.start_crawl_review(batch_id)

    # 重启恢复会更新审核状态，必须保留单一写事务。
    def recover_crawl_reviews(self) -> int:
        return self._review_repository.recover_crawl_reviews()

    # 候选选择与条件领取必须在同一写事务内完成。
    def claim_next_crawl_review(self) -> dict[str, Any] | None:
        return self._review_repository.claim_next_crawl_review()

    def next_crawl_review_automatic(self) -> dict[str, Any] | None:
        return self._review_repository.next_crawl_review_automatic()

    # 审核重新排队会修改状态，必须保留单一写事务。
    def requeue_crawl_review(self, batch_id: str) -> None:
        return self._review_repository.requeue_crawl_review(batch_id)

    # 审核失败状态与脱敏错误必须通过写事务保存。
    def fail_crawl_review(self, batch_id: str, error: str, *, log_path: str = "") -> None:
        return self._review_repository.fail_crawl_review(batch_id, error, log_path=log_path)

    # 状态校验、旧清单删除与审核复位必须在同一写事务内完成。
    def retry_crawl_review(self, batch_id: str) -> bool:
        return self._review_repository.retry_crawl_review(batch_id)

    # 状态校验、清单替换与汇总更新必须在同一写事务内完成。
    def replace_crawl_review_manifest(
        self,
        batch_id: str,
        manifest: dict[str, Any],
        *,
        log_path: str = "",
    ) -> None:
        return self._review_repository.replace_crawl_review_manifest(
            batch_id, manifest, log_path=log_path
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
        return self._review_repository.list_crawl_review_groups(
            batch_id,
            kind=kind,
            limit=limit,
            offset=offset,
            all_groups=all_groups,
        )

    # 审核状态、组和图片归属校验必须与选择更新原子完成。
    def update_crawl_review_decisions(
        self,
        batch_id: str,
        decisions: list[dict[str, Any]],
    ) -> None:
        return self._review_repository.update_crawl_review_decisions(batch_id, decisions)

    def get_crawl_review_image(self, batch_id: str, image_id: str) -> dict[str, Any] | None:
        return self._review_repository.get_crawl_review_image(batch_id, image_id)

    # 审核与批次状态、未决组检查必须和 applying 更新共用写事务。
    def begin_crawl_review_apply(self, batch_id: str) -> bool:
        return self._review_repository.begin_crawl_review_apply(batch_id)

    def crawl_review_apply_images(self, batch_id: str) -> list[dict[str, Any]]:
        return self._review_repository.crawl_review_apply_images(batch_id)

    def crawl_review_automatic_images(self, batch_id: str) -> list[dict[str, Any]]:
        return self._review_repository.crawl_review_automatic_images(batch_id)

    # 自动处置计数与审核状态更新必须在同一写事务内完成。
    def finish_crawl_review_automatic(self, batch_id: str) -> dict[str, Any] | None:
        return self._review_repository.finish_crawl_review_automatic(batch_id)

    # 文件移动阶段状态会被持久化，必须保留单一写事务。
    def stage_crawl_review_image_move(
        self,
        batch_id: str,
        image_id: str,
        final_relative_path: str,
    ) -> None:
        return self._review_repository.stage_crawl_review_image_move(
            batch_id, image_id, final_relative_path
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
        return self._review_repository.finish_crawl_review_image(
            batch_id,
            image_id,
            disposition,
            final_relative_path=final_relative_path,
            error=error,
        )

    # 处置计数与审核终态更新必须在同一写事务内完成。
    def finish_crawl_review_apply(self, batch_id: str) -> dict[str, Any] | None:
        return self._review_repository.finish_crawl_review_apply(batch_id)

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
        return self._proxy_probe_repository.save_crawl_address_proxy_probe(
            address_id,
            target_url=target_url,
            total_count=total_count,
            healthy_node_ids=healthy_node_ids,
            error=error,
        )

    def get_crawl_address_proxy_probe(self, address_id: str) -> dict[str, Any] | None:
        return self._proxy_probe_repository.get_crawl_address_proxy_probe(address_id)

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
        return self._site_policy_repository.put_site_policy(site, policy)

    def get_site_policy(self, site: str) -> dict[str, Any] | None:
        return self._site_policy_repository.get_site_policy(site)

    def list_site_policies(self) -> list[dict[str, Any]]:
        return self._site_policy_repository.list_site_policies()

    # 站点策略删除属于写路径，必须保留单一写事务。
    def delete_site_policy(self, site: str) -> bool:
        return self._site_policy_repository.delete_site_policy(site)

    def incomplete_processes(self) -> list[dict[str, Any]]:
        return self._task_repository.incomplete_processes()

    # 未完成任务读取及任务、attempt、租约与事件更新必须共用写事务。
    def recover_incomplete(self) -> int:
        return self._task_repository.recover_incomplete()
