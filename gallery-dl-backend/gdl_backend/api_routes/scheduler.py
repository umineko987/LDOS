from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query

from ..diagnostics import diagnostics_scheduler_snapshot
from .dependencies import get_service
from .passthrough_models import Number, PassthroughModel

DiagnosticsResponseView = Literal["legacy", "diagnostics"]


# diagnostics 投影由 diagnostics_scheduler_snapshot 显式构造，字段必填；
# legacy 负载是调度器原始摘要，只作说明。


class DiagnosticsBackgroundLoop(PassthroughModel):
    state: str
    running: bool
    operational: bool
    consecutive_failures: int
    last_error_category: str | None
    last_error_at: Number | None
    last_success_at: Number | None
    last_recovery_at: Number | None


class DiagnosticsSchedulerTasks(PassthroughModel):
    running: bool
    active: int
    max_concurrent: int
    active_site_count: int
    dispatch_loop: DiagnosticsBackgroundLoop


class DiagnosticsOrderedCrawls(PassthroughModel):
    running: bool
    active_batches: int
    execution_order: Literal["source_then_address", "unknown"]
    address_parallelism: Literal["media_tasks", "unknown"]


class DiagnosticsSchedulerStatus(PassthroughModel):
    response_profile: Literal["diagnostics"]
    secrets_exposed: bool
    tasks: DiagnosticsSchedulerTasks
    ordered_crawls: DiagnosticsOrderedCrawls


class LegacySchedulerTasks(PassthroughModel):
    running: bool | None = None
    active: int | None = None
    max_concurrent: int | None = None
    sites: dict[str, int] | None = None
    dispatch_loop: dict[str, Any] | None = None


class LegacyOrderedCrawls(PassthroughModel):
    running: bool | None = None
    active_batches: int | None = None
    running_batch_loops: int | None = None
    max_concurrent_batches: int | None = None
    site_planning_locked: list[str] | None = None
    execution_order: str | None = None
    address_parallelism: str | None = None


class LegacySchedulerStatus(PassthroughModel):
    tasks: LegacySchedulerTasks | None = None
    ordered_crawls: LegacyOrderedCrawls | None = None


def create_scheduler_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get(
        "/scheduler/status",
        response_model=DiagnosticsSchedulerStatus | LegacySchedulerStatus,
        response_model_exclude_unset=True,
    )
    async def scheduler_status(
        view: DiagnosticsResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        tasks = container.scheduler.active_summary()
        ordered_crawls = container.ordered_crawls.status()
        if view == "diagnostics":
            return diagnostics_scheduler_snapshot(tasks, ordered_crawls)
        return {
            "tasks": tasks,
            "ordered_crawls": ordered_crawls,
        }

    return router
