from __future__ import annotations

import asyncio
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from .. import __version__
from ..config import AppSettings
from ..diagnostics import (
    diagnostics_config_snapshot,
    readiness_snapshot,
)
from .dependencies import get_service

DiagnosticsResponseView = Literal["legacy", "diagnostics"]


def create_diagnostics_router(settings: AppSettings) -> APIRouter:
    router = APIRouter()

    @router.get("/")
    async def root():
        return {
            "service": "gallery-dl-backend",
            "version": __version__,
            "ui": "/ui/",
            "docs": "/docs",
        }

    @router.get("/healthz")
    async def healthz(container: Any = Depends(get_service)):
        database_ok = container.db.ping()
        payload = {
            "ok": database_ok,
            "components": {
                "process": {"status": "ok"},
                "database": {"status": "ok" if database_ok else "error"},
            },
            "time": time.time(),
        }
        return JSONResponse(status_code=200 if database_ok else 503, content=payload)

    @router.get("/readyz")
    async def readyz(container: Any = Depends(get_service)):
        # Event-loop-owned mutable state must be snapshotted before entering a
        # worker thread.
        scheduler_summary = container.scheduler.active_summary()
        ordered_summary = container.ordered_crawls.status()
        proxy_health = container.proxy_health_summary()

        def snapshot() -> dict[str, Any]:
            return readiness_snapshot(
                settings,
                database_ok=container.db.ping(),
                live_proxy_status=container.proxy.status(),
                proxy_health=proxy_health,
                scheduler=scheduler_summary,
                ordered_crawls=ordered_summary,
            )

        payload = await asyncio.to_thread(snapshot)
        return JSONResponse(status_code=200 if payload["ready"] else 503, content=payload)

    @router.get("/api/v1/config")
    async def public_config(
        view: DiagnosticsResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        if view == "diagnostics":
            return diagnostics_config_snapshot(container.settings)
        return container.settings.public_dict()

    return router
