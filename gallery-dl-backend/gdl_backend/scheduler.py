from __future__ import annotations

import asyncio
import logging
import random
import time
from collections import Counter
from pathlib import Path
from typing import Any, Awaitable, Callable

from ._scheduler_artifacts import ArtifactCatalog, LocalArtifactCatalog
from ._scheduler_attempt import AttemptExecutor, AttemptResult
from ._scheduler_decisions import (
    decide_task_transition,
    parse_task_policy,
    retry_delay_seconds,
    updated_tried_proxy_ids,
)
from .config import SchedulerSettings
from .database import Database, TERMINAL_STATUSES
from .gallery import GalleryRunner
from .log_writer import TaskLogWriter
from .process_control import terminate_stale_process
from .proxy import ProxyPoolAdapter
from .redaction import redact_text, safe_exception_category
from .schemas import TaskPolicy


_DISPATCH_REFILL_ROUNDS = 2
_LOOP_WARNING_INTERVAL_SECONDS = 60.0

logger = logging.getLogger(__name__)


class TaskScheduler:
    def __init__(
        self,
        database: Database,
        gallery: GalleryRunner,
        proxy: ProxyPoolAdapter,
        settings: SchedulerSettings,
        log_writer: TaskLogWriter,
        *,
        credential_validator: Callable[[str, str | None], bool] | None = None,
        auth_failure_callback: Callable[[str, str | None, str], Awaitable[bool]] | None = None,
        artifact_catalog: ArtifactCatalog | None = None,
        wall_clock: Callable[[], float] | None = None,
        monotonic_clock: Callable[[], float] | None = None,
        jitter: Callable[[float, float], float] | None = None,
    ) -> None:
        self.db = database
        self.gallery = gallery
        self.proxy = proxy
        self.settings = settings
        self.log_writer = log_writer
        self.credential_validator = credential_validator
        self.auth_failure_callback = auth_failure_callback
        self._artifact_catalog = artifact_catalog or LocalArtifactCatalog()
        self._wall_clock = wall_clock or time.time
        self._monotonic_clock = monotonic_clock or time.monotonic
        self._jitter = jitter or random.uniform
        self._loop_task: asyncio.Task | None = None
        self._active: dict[str, tuple[asyncio.Task, str]] = {}
        self._credential_blocked: set[str] = set()
        self._wake = asyncio.Event()
        self._stopping = False
        self._dispatch_consecutive_failures = 0
        self._dispatch_last_error_at: float | None = None
        self._dispatch_last_error_category: str | None = None
        self._dispatch_last_success_at: float | None = None
        self._dispatch_last_recovery_at: float | None = None
        self._dispatch_last_warning_at: float | None = None
        self._attempt_executor = AttemptExecutor(
            database,
            gallery,
            proxy,
            log_writer,
            artifact_catalog=self._artifact_catalog,
            auth_failure_callback=auth_failure_callback,
            is_stopping=lambda: self._stopping,
            monotonic_clock=self._monotonic_clock,
        )

    async def start(self) -> None:
        if self._loop_task is not None:
            return
        await self.log_writer.start()
        self._stopping = False
        stale = self.db.incomplete_processes()
        for item in stale:
            await asyncio.to_thread(
                terminate_stale_process,
                item.get("pid"),
                item.get("process_marker"),
            )
        self.db.recover_incomplete()
        self._loop_task = asyncio.create_task(self._dispatch_loop(), name="gallery-task-dispatcher")
        self._wake.set()

    async def stop(self) -> None:
        self._stopping = True
        self._wake.set()
        if self._loop_task is not None:
            self._loop_task.cancel()
            await asyncio.gather(self._loop_task, return_exceptions=True)
            self._loop_task = None
        await self.gallery.stop_all()
        tasks = [item[0] for item in self._active.values()]
        if tasks:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*tasks, return_exceptions=True),
                    timeout=self.settings.shutdown_grace_seconds,
                )
            except asyncio.TimeoutError:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        self._active.clear()
        await self.log_writer.stop()

    def notify(self) -> None:
        self._wake.set()

    def _policy(self, task: dict[str, Any]) -> TaskPolicy:
        return parse_task_policy(task)

    def _record_dispatch_failure(self, exc: Exception) -> None:
        category = safe_exception_category(exc)
        self._dispatch_consecutive_failures += 1
        self._dispatch_last_error_at = self._wall_clock()
        self._dispatch_last_error_category = category
        now = self._monotonic_clock()
        if (
            self._dispatch_last_warning_at is None
            or now - self._dispatch_last_warning_at >= _LOOP_WARNING_INTERVAL_SECONDS
        ):
            self._dispatch_last_warning_at = now
            logger.warning(
                "scheduler dispatch loop failure; category=%s consecutive_failures=%d",
                category,
                self._dispatch_consecutive_failures,
            )

    def _record_dispatch_success(self) -> None:
        now = self._wall_clock()
        self._dispatch_last_success_at = now
        if self._dispatch_consecutive_failures <= 0:
            return
        failures = self._dispatch_consecutive_failures
        category = self._dispatch_last_error_category or "unexpected_error"
        self._dispatch_consecutive_failures = 0
        self._dispatch_last_recovery_at = now
        self._dispatch_last_warning_at = None
        logger.info(
            "scheduler dispatch loop recovered; category=%s previous_failures=%d",
            redact_text(category, limit=32),
            failures,
        )

    async def _dispatch_loop(self) -> None:
        while not self._stopping:
            try:
                self._wake.clear()
                self._reap_finished()
                if self._credential_blocked:
                    blocked_snapshot = set(self._credential_blocked)
                    queued_blocked = await asyncio.to_thread(
                        self.db.queued_task_ids,
                        blocked_snapshot,
                    )
                    self._credential_blocked.intersection_update(queued_blocked)
                capacity = self.settings.max_concurrent_tasks - len(self._active)
                if capacity > 0:
                    active_sites = Counter(site for _, site in self._active.values())
                    saturated_sites: set[str] = set()
                    for _dispatch_round in range(_DISPATCH_REFILL_ROUNDS + 1):
                        queued = self.db.queued_tasks(
                            limit=200,
                            exclude_sites=saturated_sites or None,
                        )
                        if not queued:
                            break
                        hit_site_limit = False
                        for task in queued:
                            if capacity <= 0:
                                break
                            task_id = task["id"]
                            policy = self._policy(task)
                            site = task["site"]
                            if self.credential_validator and not self.credential_validator(
                                site,
                                task.get("cookies_file"),
                            ):
                                if task_id not in self._credential_blocked:
                                    recorded = await asyncio.to_thread(
                                        self.db.mark_task_credentials_unavailable,
                                        task_id,
                                        site,
                                    )
                                    if recorded:
                                        self._credential_blocked.add(task_id)
                                continue
                            self._credential_blocked.discard(task_id)
                            if active_sites[site] >= policy.max_concurrency:
                                saturated_sites.add(site)
                                hit_site_limit = True
                                continue
                            if not self.db.claim_task(task_id):
                                continue
                            worker = asyncio.create_task(
                                self._execute(task_id),
                                name=f"gallery-task-{task_id}",
                            )
                            self._active[task_id] = (worker, site)
                            active_sites[site] += 1
                            capacity -= 1
                            worker.add_done_callback(
                                lambda _done, task_id=task_id: self._worker_done(task_id)
                            )
                        if capacity <= 0 or not hit_site_limit:
                            break
                self._record_dispatch_success()
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=self.settings.poll_interval_seconds)
                except asyncio.TimeoutError:
                    pass
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self._record_dispatch_failure(exc)
                await asyncio.sleep(self.settings.poll_interval_seconds)

    def _worker_done(self, task_id: str) -> None:
        self._active.pop(task_id, None)
        self._wake.set()

    def _reap_finished(self) -> None:
        for task_id, (worker, _) in list(self._active.items()):
            if worker.done():
                self._active.pop(task_id, None)

    async def cancel(self, task_id: str) -> dict[str, Any] | None:
        task = self.db.request_cancel(task_id)
        if task is None:
            return None
        if task["status"] == "cancelling":
            await self.gallery.cancel(task_id)
        self._wake.set()
        return self.db.get_task(task_id)

    def retry(self, task_id: str, additional_attempts: int) -> dict[str, Any] | None:
        task = self.db.retry_task(task_id, additional_attempts)
        self._wake.set()
        return task

    def _dispatch_loop_summary(self) -> dict[str, Any]:
        task = self._loop_task
        running = task is not None and not task.done()
        unexpected_exit = task is not None and task.done() and not self._stopping
        if unexpected_exit:
            state = "unexpected_exit"
        elif self._stopping:
            state = "stopping" if running else "stopped"
        elif running:
            state = "degraded" if self._dispatch_consecutive_failures else "running"
        else:
            state = "not_started"
        return {
            "state": state,
            "running": running and not self._stopping,
            "operational": not unexpected_exit,
            "consecutive_failures": self._dispatch_consecutive_failures,
            "last_error_category": self._dispatch_last_error_category,
            "last_error_at": self._dispatch_last_error_at,
            "last_success_at": self._dispatch_last_success_at,
            "last_recovery_at": self._dispatch_last_recovery_at,
        }

    def active_summary(self) -> dict[str, Any]:
        active = list(self._active.values())
        sites = Counter(site for _, site in active)
        dispatch_loop = self._dispatch_loop_summary()
        return {
            "running": dispatch_loop["running"],
            "active": len(active),
            "max_concurrent": self.settings.max_concurrent_tasks,
            "sites": dict(sites),
            "dispatch_loop": dispatch_loop,
        }

    # Compatibility facades retained for scheduler fixtures that exercised the
    # pre-split private artifact seams. Production attempts use the injected
    # ArtifactCatalog directly.
    @staticmethod
    def _scan_artifacts(output_dir: str) -> tuple[int, int]:
        return LocalArtifactCatalog().scan(output_dir)

    @staticmethod
    def _artifact_from_output(line: str, output_dir: str) -> Path | None:
        return LocalArtifactCatalog().from_output(line, output_dir)

    @staticmethod
    def _artifact_totals(paths: set[Path]) -> tuple[int, int]:
        return LocalArtifactCatalog().totals(paths)

    @staticmethod
    def _artifact_size(path: Path) -> int | None:
        return LocalArtifactCatalog().size(path)

    async def _execute(self, task_id: str) -> None:
        # Compatibility seam: dispatch tests patch _execute to hold workers.
        # Keep it thin while TaskScheduler remains the final-state owner.
        result = await self._attempt_executor.execute(task_id)
        self._commit_attempt_result(task_id, result)

    def _commit_attempt_result(
        self,
        task_id: str,
        result: AttemptResult,
    ) -> None:
        decision = result.decision
        attempt_id = result.attempt_id
        task = result.task

        if not attempt_id:
            current = self.db.get_task(task_id)
            if current and (
                current.get("cancel_requested")
                or current.get("status") == "cancelling"
            ):
                self.db.complete_task(
                    task_id,
                    "cancelled",
                    error_class="cancelled",
                    error_message="任务已取消",
                )
            elif current and current.get("status") not in TERMINAL_STATUSES:
                self.db.complete_task(
                    task_id,
                    "failed",
                    error_class=decision.error_class,
                    error_message=decision.message,
                )
            return

        latest = self.db.get_task(task_id)
        max_attempts = int((latest or task or {}).get("max_attempts", 1))
        transition = decide_task_transition(
            decision,
            cancel_requested=bool(
                latest and latest.get("cancel_requested")
            ),
            attempt_no=result.attempt_no,
            max_attempts=max_attempts,
        )
        if transition == "cancelled":
            self.db.complete_task(
                task_id,
                "cancelled",
                exit_code=result.exit_code,
                error_class="cancelled",
                error_message="任务已取消",
                expected_attempt_id=attempt_id,
            )
            return
        if transition == "succeeded":
            self.db.complete_task(
                task_id,
                "succeeded",
                exit_code=result.exit_code,
                expected_attempt_id=attempt_id,
            )
            return

        tried = updated_tried_proxy_ids(
            (latest or task or {}).get("tried_proxy_ids") or [],
            proxy_node_id=result.proxy_node_id,
            proxy_fault=decision.proxy_fault,
        )
        if transition == "requeue":
            base = (
                result.policy.backoff_base_seconds
                if result.policy is not None
                else 2.0
            )
            # Manual retry pins the anchor to inherited attempt_count, so the
            # new round restarts at exponent zero. Automatic retries preserve it.
            anchor = int(
                (latest or task or {}).get("backoff_anchor_attempt", 0) or 0
            )
            delay = retry_delay_seconds(
                base_seconds=base,
                attempt_no=result.attempt_no,
                backoff_anchor_attempt=anchor,
                cap_seconds=self.settings.retry_backoff_cap_seconds,
                jitter_seconds=self._jitter(
                    0.0,
                    self.settings.retry_jitter_seconds,
                ),
            )
            self.db.requeue_task(
                task_id,
                next_run_at=self._wall_clock() + delay,
                exit_code=result.exit_code,
                error_class=decision.error_class,
                error_message=decision.message,
                tried_proxy_ids=tried,
                expected_attempt_id=attempt_id,
            )
            self._wake.set()
            return
        self.db.complete_task(
            task_id,
            "failed",
            exit_code=result.exit_code,
            error_class=decision.error_class,
            error_message=decision.message,
            expected_attempt_id=attempt_id,
        )
