from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query

from ..diagnostics import diagnostics_scheduler_snapshot
from .dependencies import get_service

DiagnosticsResponseView = Literal["legacy", "diagnostics"]


def create_scheduler_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get("/scheduler/status")
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
