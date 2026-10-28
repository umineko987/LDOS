from __future__ import annotations

import asyncio
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from .. import __version__
from ..config import AppSettings
from ..diagnostics import (
    diagnostics_config_snapshot,
    readiness_snapshot,
)
from ..site_policy import ProxyMode
from .dependencies import get_service

DiagnosticsResponseView = Literal["legacy", "diagnostics"]


class ServiceInfoResponse(BaseModel):
    service: str
    version: str
    docs: str


class HealthComponent(BaseModel):
    status: Literal["ok", "error"]


class HealthResponse(BaseModel):
    """/healthz 载荷；数据库不可用时同一结构以 503 返回。"""

    ok: bool
    components: dict[str, HealthComponent]
    time: float


class ReadinessComponent(BaseModel):
    """单个就绪组件；各组件的附加明细（计数、循环状态等）作为额外字段保留。"""

    model_config = ConfigDict(extra="allow")
    status: Literal["ok", "error", "disabled", "optional_missing", "optional_warning"]
    required: bool
    summary: str


class ReadinessResponse(BaseModel):
    """/readyz 载荷；任一必需组件未就绪时同一结构以 503 返回。"""

    ready: bool
    components: dict[str, ReadinessComponent]
    time: float


class PublicServerConfig(BaseModel):
    host: str
    port: int
    cors_origins: list[str]
    allow_private_targets: bool
    strict_target_dns: bool


class PublicEncryptedDnsConfig(BaseModel):
    enabled: bool
    endpoint: str
    timeout_seconds: float
    max_response_bytes: int


class PublicGalleryConfig(BaseModel):
    repo_path: str
    python_executable: str
    default_http_timeout: float
    default_retries: int
    managed_auth_cache: bool


class PublicAuthConfig(BaseModel):
    managed_browser: bool
    chrome_configured: bool
    browser_login_timeout_seconds: float
    browser_poll_interval_seconds: float
    authorization_proxy: str | None


class PublicProxyConfig(BaseModel):
    enabled: bool
    auto_start: bool
    engine: str
    subscription_count: int
    node_file: str | None
    inline_node_count: int
    allowed_node_roots: list[str | None]
    allow_socks: bool
    probe_url: str
    probe_timeout_seconds: float
    probe_cache_ttl_seconds: float
    transport_core_enabled: bool
    transport_core_binary: str | None
    transport_core_sha256: str | None
    transport_core_base_port: int


class PublicSchedulerConfig(BaseModel):
    max_concurrent_tasks: int
    max_concurrent_batches: int
    poll_interval_seconds: float
    shutdown_grace_seconds: float
    max_logs_per_task: int
    retry_jitter_seconds: float
    retry_backoff_cap_seconds: float


class PublicDedupConfig(BaseModel):
    enabled: bool
    python_executable: str
    worker_script: str
    core_script: str
    atlas_script: str
    model_dir: str
    device: str
    workers: int
    torch_threads: int
    torch_interop_threads: int
    deep_batch_size: int
    neighbor_block_size: int
    no_sscd: bool
    no_dino: bool


class PublicSitePolicyConfig(BaseModel):
    max_concurrency: int
    retry_limit: int
    backoff_base_seconds: float
    proxy_mode: ProxyMode


class PublicConfigResponse(BaseModel):
    """legacy 视图：本机工作台使用的完整非秘密配置（含主机路径）。"""

    runtime_dir: str
    database_path: str
    default_output_root: str
    allowed_output_roots: list[str]
    server: PublicServerConfig
    encrypted_dns: PublicEncryptedDnsConfig
    gallery: PublicGalleryConfig
    auth: PublicAuthConfig
    proxy: PublicProxyConfig
    scheduler: PublicSchedulerConfig
    dedup: PublicDedupConfig
    default_site_policy: PublicSitePolicyConfig


class DiagnosticsServerConfig(BaseModel):
    loopback_only: bool
    cors_enabled: bool
    private_targets_enabled: bool


class DiagnosticsGalleryConfig(BaseModel):
    managed_auth_cache: bool


class DiagnosticsProxyConfig(BaseModel):
    enabled: bool
    auto_start: bool
    transport_core_enabled: bool


class DiagnosticsSchedulerConfig(BaseModel):
    max_concurrent_tasks: int


class DiagnosticsDedupConfig(BaseModel):
    enabled: bool
    configured_device: Literal["auto", "cpu", "cuda", "unknown"]
    sscd_enabled: bool
    dino_enabled: bool


class DiagnosticsConfigResponse(BaseModel):
    """diagnostics 视图：不含主机路径与秘密的最小能力投影。"""

    response_profile: Literal["diagnostics"]
    secrets_exposed: Literal[False]
    server: DiagnosticsServerConfig
    gallery: DiagnosticsGalleryConfig
    proxy: DiagnosticsProxyConfig
    scheduler: DiagnosticsSchedulerConfig
    dedup: DiagnosticsDedupConfig


def create_diagnostics_router(settings: AppSettings) -> APIRouter:
    router = APIRouter()

    @router.get("/", response_model=ServiceInfoResponse)
    async def root():
        return {
            "service": "gallery-dl-backend",
            "version": __version__,
            "docs": "/docs",
        }

    @router.get(
        "/healthz",
        response_model=HealthResponse,
        responses={503: {"model": HealthResponse, "description": "数据库不可用"}},
    )
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

    @router.get(
        "/readyz",
        response_model=ReadinessResponse,
        responses={503: {"model": ReadinessResponse, "description": "必需组件未就绪"}},
    )
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

    @router.get(
        "/api/v1/config",
        response_model=PublicConfigResponse | DiagnosticsConfigResponse,
    )
    async def public_config(
        view: DiagnosticsResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        if view == "diagnostics":
            return diagnostics_config_snapshot(container.settings)
        return container.settings.public_dict()

    return router
