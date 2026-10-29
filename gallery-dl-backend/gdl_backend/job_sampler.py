"""旧服务 → Job 的 1Hz 采样器。

打标和图库扫描直接向 ``JobRegistry`` 发事件；采集批次、去重审核、目录导出、
去重模型安装这些旧服务没有事件钩子，由这里每秒采样一次映射成 Job。

只有在至少一个 SSE 客户端连着、并且确实有活动（或上次采样还有未收尾的任务）
时才采样；``GET /api/v1/jobs`` 会先 ``refresh()`` 一次，保证没有 SSE 客户端时列表也不陈旧。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Iterable, Mapping
from typing import Any, Protocol

from .events import EventBus, JobRegistry, JobStatus

logger = logging.getLogger(__name__)

SAMPLE_INTERVAL_SECONDS = 1.0


class JobSource(Protocol):
    name: str

    def is_active(self) -> bool:
        """只看内存状态，判断是否值得采样（不得访问数据库或磁盘）。"""

    def sample(self, jobs: JobRegistry) -> None:
        """把当前状态写进 ``jobs``；在工作线程里调用，可以访问数据库。"""


class _TrackedSource:
    """记录本来源登记过、尚未收尾的 Job，下一轮没再出现时据最终状态收尾。"""

    name = "tracked"
    kind = ""

    def __init__(self) -> None:
        self._tracked: set[str] = set()

    def has_tracked(self) -> bool:
        return bool(self._tracked)

    def _report(
        self,
        jobs: JobRegistry,
        job_id: str,
        *,
        title: str,
        status: JobStatus,
        current: int | None = None,
        total: int | None = None,
        message: str = "",
        ref: Mapping[str, Any] | None = None,
    ) -> None:
        existing = jobs.get(job_id)
        if existing is None or (
            existing["status"] in {"succeeded", "failed", "cancelled"} and status not in {"succeeded", "failed", "cancelled"}
        ):
            jobs.start(
                self.kind, title, job_id=job_id, status=status,
                current=current, total=total, message=message, ref=ref,
            )
        else:
            jobs.update(job_id, status=status, current=current, total=total, message=message, title=title, ref=ref)
        if status in {"succeeded", "failed", "cancelled"}:
            self._tracked.discard(job_id)
        else:
            self._tracked.add(job_id)


_BATCH_STATUS: dict[str, JobStatus] = {
    "queued": "queued",
    "running": "running",
    "cancelling": "running",
    "succeeded": "succeeded",
    "completed_with_errors": "failed",
    "cancelled": "cancelled",
    "failed": "failed",
}


class CrawlBatchSource(_TrackedSource):
    name = "crawl_batches"
    kind = "crawl.batch"

    def __init__(self, db: Any, scheduler: Any, ordered_crawls: Any) -> None:
        super().__init__()
        self._db = db
        self._scheduler = scheduler
        self._ordered_crawls = ordered_crawls

    def is_active(self) -> bool:
        running_loops = len(getattr(self._ordered_crawls, "_batch_tasks", {}) or {})
        active_tasks = len(getattr(self._scheduler, "_active", {}) or {})
        return bool(running_loops or active_tasks or self.has_tracked())

    def sample(self, jobs: JobRegistry) -> None:
        active_ids = list(self._db.active_crawl_batch_ids())
        wanted = set(active_ids) | {job_id.partition(":")[2] for job_id in self._tracked}
        if not wanted:
            return
        rows = {
            str(batch["id"]): batch
            for batch in self._db.list_crawl_batches(limit=200)
            if batch is not None and str(batch["id"]) in wanted
        }
        for batch_id in wanted:
            batch = rows.get(batch_id)
            if batch is None:
                batch = self._db.get_crawl_batch(batch_id)
            job_id = f"crawl:{batch_id}"
            if batch is None:
                if job_id in self._tracked:
                    jobs.finish(job_id, "cancelled", message="批次已删除")
                    self._tracked.discard(job_id)
                continue
            status = _BATCH_STATUS.get(str(batch.get("status")), "running")
            total = int(batch.get("task_count") or 0)
            succeeded = int(batch.get("succeeded_task_count") or 0)
            failed = int(batch.get("failed_task_count") or 0)
            cancelled = int(batch.get("cancelled_task_count") or 0)
            message = ""
            if failed:
                message = f"{failed} 个任务失败"
            if status == "failed" and batch.get("last_error"):
                message = str(batch["last_error"])[:200]
            self._report(
                jobs,
                job_id,
                title=f"采集批次 {batch_id[:8]}",
                status=status,
                current=succeeded + failed + cancelled,
                total=total or None,
                message=message,
                ref={"batch_id": batch_id},
            )


_REVIEW_STATUS: dict[str, JobStatus] = {
    "waiting_for_crawl": "queued",
    "pending": "queued",
    "analyzing": "running",
    "auto_applying": "running",
    "applying": "running",
    "ready": "succeeded",
    "applied": "succeeded",
    "failed": "failed",
    "apply_failed": "failed",
}


class ReviewSource(_TrackedSource):
    """去重审核（采集批次审核与图库审核共用一个运行循环）。"""

    name = "reviews"
    kind = "dedup.review"

    def __init__(
        self,
        managers: Iterable[Any],
        fallback_repository: Any,
        describe: Callable[[str], Mapping[str, Any] | None] | None = None,
    ) -> None:
        super().__init__()
        self._managers = [manager for manager in managers if manager is not None]
        self._fallback = fallback_repository
        # 数据集清洗 / 去重建的审核：补上标题和数据集归属（{"title", "ref"}）。
        self._describe = describe

    def _current_ids(self) -> list[tuple[str, Any]]:
        result = []
        for manager in self._managers:
            current = str(getattr(manager, "_current_batch_id", "") or "")
            if current:
                result.append((current, manager))
        return result

    def is_active(self) -> bool:
        return bool(self._current_ids() or self.has_tracked())

    def _lookup(self, review_id: str, manager: Any | None) -> dict[str, Any] | None:
        repositories = [getattr(manager, "repository", None)] if manager is not None else []
        repositories += [getattr(item, "repository", None) for item in self._managers]
        repositories.append(self._fallback)
        for repository in repositories:
            getter = getattr(repository, "get_crawl_review", None)
            if getter is None:
                continue
            try:
                review = getter(review_id)
            except Exception:
                continue
            if review is not None:
                return review
        return None

    def sample(self, jobs: JobRegistry) -> None:
        current = dict(self._current_ids())
        for review_id in set(current) | {job_id.partition(":")[2] for job_id in self._tracked}:
            job_id = f"review:{review_id}"
            review = self._lookup(review_id, current.get(review_id))
            if review_id in current:
                status: JobStatus = "running"
            elif review is None:
                status = "succeeded"
            else:
                status = _REVIEW_STATUS.get(str(review.get("status")), "succeeded")
                if status in {"queued", "running"} and job_id in self._tracked:
                    # 不再是当前项却仍未终态：被重新排队，等下一次认领。
                    status = "queued"
            total = int((review or {}).get("total_image_count") or 0) or None
            message = str((review or {}).get("error") or "")[:200] if status == "failed" else ""
            title, ref = "去重审核", {"review_id": review_id}
            described = self._described(review_id)
            if described is not None:
                title = str(described.get("title") or title)
                ref = {**dict(described.get("ref") or {}), "review_id": review_id}
            self._report(
                jobs,
                job_id,
                title=title,
                status=status,
                total=total,
                message=message,
                ref=ref,
            )

    def _described(self, review_id: str) -> Mapping[str, Any] | None:
        if self._describe is None:
            return None
        try:
            return self._describe(review_id)
        except Exception:
            return None


_EXPORT_STATUS: dict[str, JobStatus] = {
    "copying": "running",
    "completed": "succeeded",
    "failed": "failed",
    "cancelled": "cancelled",
}


class DirectoryExportSource(_TrackedSource):
    name = "directory_exports"
    kind = "gallery.export"

    def __init__(self, exports: Any) -> None:
        super().__init__()
        self._exports = exports

    def is_active(self) -> bool:
        return bool(self._exports.has_active_operations() or self.has_tracked())

    def sample(self, jobs: JobRegistry) -> None:
        for operation in self._exports.list_operations():
            job_id = f"export:{operation['operation_id']}"
            status = _EXPORT_STATUS.get(str(operation.get("state")), "running")
            if status != "running" and job_id not in self._tracked and jobs.get(job_id) is None:
                continue  # 在采样开始之前就已结束的旧操作，不补登记。
            message = str(operation.get("current_directory_name") or "")
            if status == "failed":
                message = str(operation.get("error_code") or "")
            self._report(
                jobs,
                job_id,
                title="导出目录",
                status=status,
                current=int(operation.get("copied_file_count") or 0),
                total=int(operation.get("discovered_file_count") or 0) or None,
                message=message,
                ref={"operation_id": str(operation["operation_id"])},
            )


class ModelInstallSource(_TrackedSource):
    name = "model_setup"
    kind = "models.install"
    job_id = "models:dedup"

    def __init__(self, model_setup: Any) -> None:
        super().__init__()
        self._model_setup = model_setup

    def is_active(self) -> bool:
        return getattr(self._model_setup, "_phase", "") == "installing" or self.has_tracked()

    def sample(self, jobs: JobRegistry) -> None:
        status_payload = self._model_setup.status()
        phase = str(status_payload.get("phase") or "")
        status: JobStatus
        if phase == "installing":
            status = "running"
        elif phase == "failed":
            status = "failed"
        else:
            status = "succeeded"
        self._report(
            jobs,
            self.job_id,
            title="安装去重模型",
            status=status,
            current=int(status_payload.get("downloaded_bytes") or 0),
            total=int(status_payload.get("expected_bytes") or 0) or None,
            message=str(status_payload.get("message") or "")[:200],
            ref={"models": ",".join(status_payload.get("requested_models") or [])},
        )


class JobSampler:
    def __init__(
        self,
        bus: EventBus,
        jobs: JobRegistry,
        sources: Iterable[JobSource],
        *,
        interval: float = SAMPLE_INTERVAL_SECONDS,
    ) -> None:
        self._bus = bus
        self._jobs = jobs
        self._sources = list(sources)
        self._interval = max(0.05, float(interval))
        self._task: asyncio.Task[None] | None = None
        self._refresh_lock = asyncio.Lock()
        self.sample_count = 0

    def should_sample(self) -> bool:
        if self._bus.subscriber_count == 0:
            return False
        return any(source.is_active() for source in self._sources)

    async def refresh(self) -> None:
        """立即采样所有活动来源一次，并补发被节流的进度。"""

        async with self._refresh_lock:
            active = [source for source in self._sources if source.is_active()]
            if active:
                self.sample_count += 1
                await asyncio.to_thread(self._sample_sources, active)
            self._jobs.flush()

    def _sample_sources(self, sources: list[JobSource]) -> None:
        for source in sources:
            try:
                source.sample(self._jobs)
            except Exception as exc:  # 单个来源出错不影响其他来源与下一轮。
                logger.warning("job sampler source %s failed: %s", source.name, type(exc).__name__)

    async def tick(self) -> bool:
        """一轮采样；没有 SSE 客户端或没有活动时直接返回 False。"""

        if self._bus.subscriber_count == 0:
            return False
        if self._jobs.has_pending_publish():
            self._jobs.flush()
        if not any(source.is_active() for source in self._sources):
            return False
        await self.refresh()
        return True

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="job-sampler")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _loop(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("job sampler tick failed: %s", type(exc).__name__)
            await asyncio.sleep(self._interval)


def default_job_sources(container: Any) -> list[JobSource]:
    reviews = getattr(container, "reviews", None)

    def describe_review(review_id: str) -> Mapping[str, Any] | None:
        # 采样器先于数据集服务构造，按需取。
        triage = getattr(container, "dataset_triage", None)
        return None if triage is None else triage.describe_review(review_id)

    return [
        CrawlBatchSource(container.db, container.scheduler, container.ordered_crawls),
        ReviewSource(
            [reviews, getattr(reviews, "gallery_reviews", None)],
            container.db,
            describe=describe_review,
        ),
        DirectoryExportSource(container.gallery_directory_exports),
        ModelInstallSource(container.model_setup),
    ]


__all__ = [
    "CrawlBatchSource",
    "DirectoryExportSource",
    "JobSampler",
    "JobSource",
    "ModelInstallSource",
    "ReviewSource",
    "SAMPLE_INTERVAL_SECONDS",
    "default_job_sources",
]
