from __future__ import annotations

import asyncio
import logging
import os
import re
import socket  # Compatibility patch surface for _validate_network_target callers.
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .api_routes import (
    create_auth_router,
    create_crawls_router,
    create_diagnostics_router,
    create_discovery_router,
    create_gallery_router,
    create_jobs_router,
    create_ordered_task_enqueuer,
    create_policies_router,
    create_proxy_router,
    create_review_router,
    create_scheduler_router,
    create_setup_router,
    create_tagger_router,
    create_tasks_router,
)
# Keep these names importable from gdl_backend.app while their implementations
# live outside the composition root.
from .api_routes.atlas import create_atlas_router
from .api_routes.datasets import create_datasets_router
from .api_routes.models import create_models_router
from .api_routes.settings import create_settings_router
from .api_routes.errors import ApiError
from .gallery_service import GalleryCatalogService
from .gallery_directory_export import GalleryDirectoryExportService
from .gallery_file_operations import GalleryFileOperations
from .gallery_safe_paths import GalleryFilesystemLocks
from .gallery_thumbnails import ThumbnailService
from .api_routes.validation import (
    validate_network_target as _validate_network_target,
)
from .atlas_service import AtlasService
from .auth import AuthManager
from .config import AppSettings
from .crawl import CrawlPlanner
from .database import Database
from .dataset_service import DatasetService
from .discovery import DiscoveryService
from .download_settings import DownloadSettingsStore
from .encrypted_dns import EncryptedDNSResolver, NetworkTargetValidator
from .events import EventBus, JobRegistry
from .gallery import GalleryRunner
from .job_sampler import JobSampler, default_job_sources
from .log_writer import TaskLogWriter
from .model_setup import ModelSetupManager
from .models_service import ModelsService
from .tagger_service import TaggerService
from .ordered_crawl import OrderedCrawlManager
from .proxy import ProxyPoolAdapter
from .proxy_source_store import ManagedProxySourceStore
from .redaction import redact_text, safe_exception_category
from .review import DedupReviewManager
from .runtime_config import RuntimeConfigStore
from .scheduler import TaskScheduler
from .schemas import (
    SitePolicy,
    build_runtime_site_policy,
)
from .site_policy import EDITABLE_SITE_POLICY_FIELDS
from .site import SiteResolver

_BACKGROUND_LOOP_WARNING_INTERVAL_SECONDS = 60.0

logger = logging.getLogger(__name__)


class ServiceContainer:
    def __init__(self, settings: AppSettings) -> None:
        if os.name != "nt":
            os.umask(0o077)
        self.settings = settings
        # 活动中心：事件总线与统一 Job 表，供各服务发布进度。
        self.events = EventBus()
        self.jobs = JobRegistry(self.events)
        self.runtime_config = RuntimeConfigStore(settings.config_path)
        self.db = Database(
            settings.database_path,
            max_logs_per_task=settings.scheduler.max_logs_per_task,
        )
        self.proxy_sources = ManagedProxySourceStore(
            settings.proxy,
            settings.runtime_dir,
            project_dir=settings.project_dir,
        )
        self.proxy = ProxyPoolAdapter(
            settings.proxy,
            settings.runtime_dir,
            source_provider=self.proxy_sources,
        )
        self.auth = AuthManager(settings)
        self.gallery_filesystem_locks = GalleryFilesystemLocks()
        self.gallery_catalog = GalleryCatalogService(
            self.db.gallery, filesystem_locks=self.gallery_filesystem_locks
        )
        self.gallery_file_operations = GalleryFileOperations(
            self.db.gallery, filesystem_locks=self.gallery_filesystem_locks
        )
        self.gallery_directory_exports = GalleryDirectoryExportService(
            self.db.gallery, filesystem_locks=self.gallery_filesystem_locks
        )
        self.gallery_thumbnails = ThumbnailService(
            settings.runtime_dir / "gallery-cache"
        )
        # 批次终态 → 图库来源自动注册（无冲突时）；异常绝不阻断爬取收尾。
        self.db.gallery_batch_registrar = self._register_gallery_batch_source
        self.gallery_catalog.set_job_registry(self.jobs)
        # 图库来源投影需要审核状态来推导有效去重状态（§3.8）。
        self.gallery_catalog.set_review_status_lookup(
            lambda batch_id: (
                (review := self.db.get_crawl_review(batch_id))
                and review.get("status")
            )
        )
        self.gallery = GalleryRunner(settings.gallery, settings.project_dir)
        self.log_writer = TaskLogWriter(self.db)
        self.scheduler = TaskScheduler(
            self.db,
            self.gallery,
            self.proxy,
            settings.scheduler,
            self.log_writer,
            credential_validator=self.auth.managed_credentials_available,
            auth_failure_callback=self.auth.invalidate_if_managed,
        )
        self.resolver = SiteResolver(settings.gallery.repo_path)
        self.encrypted_dns = EncryptedDNSResolver(
            enabled=settings.encrypted_dns.enabled,
            endpoint=settings.encrypted_dns.endpoint,
            timeout_seconds=settings.encrypted_dns.timeout_seconds,
            max_response_bytes=settings.encrypted_dns.max_response_bytes,
        )
        self.network_validator = NetworkTargetValidator(
            allow_private_targets=settings.server.allow_private_targets,
            strict_target_dns=settings.server.strict_target_dns,
            encrypted_dns=self.encrypted_dns,
        )
        self.discovery = DiscoveryService(
            self.gallery,
            self.proxy,
            settings.runtime_dir,
            network_validator=self.network_validator,
            auth_failure_callback=self.auth.invalidate_if_managed,
        )
        self.crawl_planner = CrawlPlanner(
            self.proxy,
            auth_failure_callback=self.auth.invalidate_if_managed,
        )
        self.ordered_crawls = OrderedCrawlManager(
            self.db,
            self.discovery,
            self.crawl_planner,
            self.scheduler,
            self.proxy,
            self.policy_for,
            poll_interval=settings.scheduler.poll_interval_seconds,
            max_concurrent_batches=settings.scheduler.max_concurrent_batches,
        )
        self.reviews = DedupReviewManager(
            self.db,
            settings.dedup,
            settings.runtime_dir,
            catalog=self.gallery_catalog, file_operations=self.gallery_file_operations,
        )
        self.gallery_reviews = self.reviews.gallery_reviews
        self.model_setup = ModelSetupManager(
            settings, self.runtime_config, self.reviews.start
        )
        self.tagger = TaggerService(settings, jobs=self.jobs)
        # 统一下载设置（镜像/代理/HF token）和模型表，见 models_service。
        self.download_settings = DownloadSettingsStore(settings.runtime_dir, proxy=self.proxy)
        self.models = ModelsService(settings, self.model_setup, self.tagger, self.download_settings)
        self.job_sampler = JobSampler(self.events, self.jobs, default_job_sources(self))
        # 数据集：扫描后补成员哈希、爬取批次结束后自动挂根（见 dataset_service）。
        self.datasets = DatasetService.for_container(self)
        self.atlas = AtlasService.for_container(self)
        self._health_task: asyncio.Task | None = None
        self._started = False
        self._stopping = False
        self._proxy_health_consecutive_failures = 0
        self._proxy_health_last_error_at: float | None = None
        self._proxy_health_last_error_category: str | None = None
        self._proxy_health_last_success_at: float | None = None
        self._proxy_health_last_recovery_at: float | None = None
        self._proxy_health_last_warning_at: float | None = None

    def policy_for(self, site: str) -> SitePolicy:
        stored = self.db.get_site_policy(site)
        raw = stored["policy"] if stored else self.settings.default_site_policy
        return build_runtime_site_policy(raw)

    def _register_gallery_batch_source(self, batch_id: str) -> dict | None:
        batch = self.db.get_crawl_batch(batch_id)
        if batch is None:
            return None
        if batch["status"] not in {"succeeded", "completed_with_errors", "cancelled"}:
            return None
        sites = sorted(
            {
                str(source["site"])
                for source in batch.get("sources", [])
                if source.get("site")
            }
        )
        created = time.strftime(
            "%Y-%m-%d", time.localtime(float(batch["created_at"]))
        )
        base = "、".join(sites) if sites else "爬取批次"
        display_name = f"{base} 批次 {created}"
        dedup_required = self.db.get_crawl_review(batch_id) is not None
        return self.gallery_catalog.auto_register_batch_source(
            batch_id=batch_id,
            root_path=str(batch["output_dir"]),
            display_name=display_name,
            dedup_required=dedup_required,
        )

    def reconcile_gallery_batch_sources(self) -> int:
        """启动对账：为所有终态但未注册的批次补建图库来源。"""
        registered = 0
        offset = 0
        while True:
            page = self.db.list_crawl_batches(limit=50, offset=offset)
            if not page:
                break
            for batch in page:
                if batch["status"] not in {
                    "succeeded",
                    "completed_with_errors",
                    "cancelled",
                }:
                    continue
                if (
                    self.db.gallery.get_source_by_batch_id(str(batch["id"]))
                    is not None
                ):
                    continue
                if self._register_gallery_batch_source(str(batch["id"])) is not None:
                    registered += 1
            if len(page) < 50:
                break
            offset += 50
        return registered

    def reconcile_applied_gallery_reviews(self) -> int:
        """Recover the crash gap between a committed review and its Gallery handoff."""
        recovered = 0
        for source in self.db.gallery.list_sources():
            batch_id = source.get("batch_id")
            if not batch_id:
                continue
            if self.db.gallery.get_review_reconciliation(source["source_id"]) is not None:
                continue
            review = self.db.get_crawl_review(str(batch_id))
            if review is None or review.get("status") != "applied":
                continue
            try:
                images = self.db.crawl_review_apply_images(str(batch_id))
                projected = self.gallery_catalog.reconcile_review_images(
                    str(batch_id), images
                )
            except Exception as exc:
                logger.warning(
                    "gallery review recovery failed; category=%s",
                    safe_exception_category(exc),
                )
                continue
            if projected is not None:
                recovered += 1
        return recovered

    async def start(self, *, background: bool = True) -> None:
        if self._started:
            return
        self._started = True
        self._stopping = False
        self.events.reopen()
        if self.settings.proxy.enabled and self.settings.proxy.auto_start:
            try:
                await asyncio.to_thread(self.proxy.start, force_refresh=True)
            except Exception as exc:
                # Keep the service up so the pool can be fixed and restarted from
                # the WebUI, but never silently. Only a mihomo core startup
                # failure blocks tasks (terminate, no direct fallback); other
                # start failures keep the original prefer/required semantics.
                core_error = ""
                try:
                    core_error = str(
                        (self.proxy.status().get("transport_core") or {}).get("last_error") or ""
                    )
                except Exception:
                    pass
                reminder = (
                    "；mihomo 传输核心启动失败，修复前非 direct 任务将被终止（不会回退直连）"
                    if core_error
                    else ""
                )
                print(
                    f"[gdl-backend] 代理池启动失败：{redact_text(exc, limit=500)}{reminder}；"
                    "详情见 /api/v1/proxy/status",
                    file=sys.stderr,
                    flush=True,
                )
        if background:
            await self.scheduler.start()
            await self.ordered_crawls.start()
            await self.reviews.start()
            await asyncio.to_thread(self.reconcile_gallery_batch_sources)
            await asyncio.to_thread(self.reconcile_applied_gallery_reviews)
            await asyncio.to_thread(
                self.gallery_catalog.retry_pending_review_reconciliations
            )
            await asyncio.to_thread(self.datasets.reconcile)
            self._health_task = asyncio.create_task(self._proxy_health_loop(), name="proxy-health-monitor")
            self.job_sampler.start()

    async def stop(self) -> None:
        self._stopping = True
        # 先结束 SSE 流，再停各服务；采样器随后停止。
        self.events.close()
        await self.job_sampler.stop()
        if self._health_task is not None:
            self._health_task.cancel()
            await asyncio.gather(self._health_task, return_exceptions=True)
            self._health_task = None
        await self.model_setup.close()
        await self.tagger.close()
        await self.atlas.stop()
        await self.models.close()
        await self.reviews.stop()
        await self.ordered_crawls.stop()
        await self.scheduler.stop()
        await self.auth.stop()
        await asyncio.to_thread(self.gallery_directory_exports.stop)
        await asyncio.to_thread(self.gallery_catalog.stop)
        await asyncio.to_thread(self.datasets.stop)
        try:
            await asyncio.to_thread(self.proxy.stop, force=True)
        except Exception as exc:
            logger.warning(
                "proxy shutdown failure; category=%s; continuing service shutdown",
                safe_exception_category(exc),
            )
        self.db.close()
        self._started = False

    def _record_proxy_health_failure(self, exc: Exception) -> None:
        category = safe_exception_category(exc)
        self._proxy_health_consecutive_failures += 1
        self._proxy_health_last_error_at = time.time()
        self._proxy_health_last_error_category = category
        now = time.monotonic()
        if (
            self._proxy_health_last_warning_at is None
            or now - self._proxy_health_last_warning_at
            >= _BACKGROUND_LOOP_WARNING_INTERVAL_SECONDS
        ):
            self._proxy_health_last_warning_at = now
            logger.warning(
                "proxy health loop failure; category=%s consecutive_failures=%d",
                category,
                self._proxy_health_consecutive_failures,
            )

    def _record_proxy_health_success(self) -> None:
        now = time.time()
        self._proxy_health_last_success_at = now
        if self._proxy_health_consecutive_failures <= 0:
            return
        failures = self._proxy_health_consecutive_failures
        category = self._proxy_health_last_error_category or "unexpected_error"
        self._proxy_health_consecutive_failures = 0
        self._proxy_health_last_recovery_at = now
        self._proxy_health_last_warning_at = None
        logger.info(
            "proxy health loop recovered; category=%s previous_failures=%d",
            redact_text(category, limit=32),
            failures,
        )

    def proxy_health_summary(self) -> dict[str, Any]:
        task = self._health_task
        running = task is not None and not task.done()
        unexpected_exit = (
            task is not None and task.done() and self._started and not self._stopping
        )
        if unexpected_exit:
            state = "unexpected_exit"
        elif self._stopping:
            state = "stopping" if running else "stopped"
        elif running:
            state = (
                "degraded" if self._proxy_health_consecutive_failures else "running"
            )
        else:
            state = "not_started"
        return {
            "state": state,
            "running": running and not self._stopping,
            "operational": not unexpected_exit,
            "consecutive_failures": self._proxy_health_consecutive_failures,
            "last_error_category": self._proxy_health_last_error_category,
            "last_error_at": self._proxy_health_last_error_at,
            "last_success_at": self._proxy_health_last_success_at,
            "last_recovery_at": self._proxy_health_last_recovery_at,
        }

    async def _proxy_health_loop(self) -> None:
        interval = max(5.0, self.settings.proxy.health_interval_seconds)
        while True:
            try:
                await asyncio.sleep(interval)
                status = await asyncio.to_thread(self.proxy.status)
                if status.get("running"):
                    await asyncio.to_thread(self.proxy.probe)
                self._record_proxy_health_success()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self._record_proxy_health_failure(exc)
                continue


def create_app(
    settings: AppSettings | None = None,
    *,
    container: ServiceContainer | None = None,
    start_background: bool = True,
) -> FastAPI:
    settings = settings or AppSettings.load()
    settings.validate()
    port = settings.server.port
    allowed_hosts = frozenset(
        {
            f"127.0.0.1:{port}",
            f"localhost:{port}",
            f"[::1]:{port}",
        }
    )
    allowed_origins = frozenset(settings.server.cors_origins)
    service = container or ServiceContainer(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.container = service
        await service.start(background=start_background)
        try:
            yield
        finally:
            await service.stop()

    app = FastAPI(
        title="gallery-dl Backend",
        version=__version__,
        description="gallery-dl 子进程调度与内置订阅代理池后端",
        lifespan=lifespan,
    )
    app.state.container = service
    if settings.server.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.server.cors_origins,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=[
                "Accept",
                "Content-Type",
                "Idempotency-Key",
                "X-Request-ID",
            ],
            expose_headers=["X-Request-ID"],
        )

    @app.middleware("http")
    async def media_response_headers(request: Request, call_next):
        response = await call_next(request)
        media_type = (
            response.headers.get("Content-Type", "").partition(";")[0].lower()
        )
        if media_type.startswith(("image/", "audio/", "video/")):
            response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
        return response

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response

    @app.middleware("http")
    async def local_origin_guard(request: Request, call_next):
        host = request.headers.get("host", "").strip().lower()
        hostname, separator, port_suffix = host.rpartition(":")
        if separator and hostname.endswith("."):
            host = f"{hostname[:-1]}:{port_suffix}"
        elif host.endswith("."):
            host = host[:-1]

        fetch_site = request.headers.get("sec-fetch-site", "").strip().lower()
        origin = request.headers.get("origin", "").strip()
        same_origin = f"{request.url.scheme}://{host}"
        configured_origin = origin in allowed_origins
        if host not in allowed_hosts:
            error_code = "forbidden_host"
            error_message = "仅允许从本机回环地址访问"
        elif fetch_site in {"cross-site", "same-site"} and not configured_origin:
            error_code = "forbidden_cross_site"
            error_message = "仅允许同源访问"
        elif origin and origin != same_origin and not configured_origin:
            error_code = "forbidden_cross_site"
            error_message = "仅允许同源访问"
        else:
            return await call_next(request)

        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
        response = JSONResponse(
            status_code=403,
            content={
                "error": {
                    "code": error_code,
                    "message": error_message,
                    "details": None,
                    "request_id": request_id,
                }
            },
        )
        response.headers["X-Request-ID"] = request_id
        return response

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "details": exc.details,
                    "request_id": getattr(request.state, "request_id", ""),
                }
            },
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        source_path = request.url.path
        policy_request = source_path.startswith("/api/v1/sites/policies/")
        sensitive_request = (
            source_path.startswith("/api/v1/proxy/sources")
            or source_path == "/api/v1/auth/proxy"
            or source_path == "/api/v1/settings/downloads"
            or source_path == "/api/v1/tagger/models/prepare"
            or policy_request
        )
        if sensitive_request:
            # Pydantic 默认错误包含 input；敏感写接口不得回显刚提交的原文。
            if policy_request:
                allowed_fields = frozenset(EDITABLE_SITE_POLICY_FIELDS)
                details = []
                for item in exc.errors():
                    location = list(item.get("loc") or ())
                    field = next(
                        (
                            part for part in location
                            if isinstance(part, str) and part in allowed_fields
                        ),
                        "policy",
                    )
                    index = next(
                        (part for part in location if isinstance(part, int) and part >= 0),
                        None,
                    )
                    reason = str(item.get("type") or "validation_error")
                    if not re.fullmatch(r"[a-z0-9_.:-]{1,64}", reason, re.I):
                        reason = "validation_error"
                    detail = {"field": field, "reason": reason}
                    if index is not None:
                        detail["index"] = index
                    details.append(detail)
            else:
                details = [
                    {
                        "type": item.get("type", "validation_error"),
                        "loc": list(item.get("loc") or ()),
                        "msg": item.get("msg", "请求字段无效"),
                    }
                    for item in exc.errors()
                ]
            if policy_request:
                error_code = "invalid_policy"
            elif source_path == "/api/v1/auth/proxy":
                error_code = "invalid_authorization_proxy"
            elif "/subscriptions" in source_path:
                error_code = "invalid_proxy_subscription"
            elif "/node-file" in source_path:
                error_code = "invalid_proxy_node_file"
            elif "/inline-nodes" in source_path:
                error_code = "invalid_proxy_inline_node"
            else:
                error_code = "validation_error"
        else:
            details = jsonable_encoder(exc.errors())
            error_code = "validation_error"
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": error_code,
                    "message": "请求参数校验失败",
                    "details": details,
                    "request_id": getattr(request.state, "request_id", ""),
                }
            },
        )

    app.include_router(create_diagnostics_router(settings))
    app.include_router(create_auth_router())
    service.ordered_crawls.set_enqueue(create_ordered_task_enqueuer(service))
    app.include_router(create_tasks_router())
    app.include_router(create_discovery_router())
    app.include_router(create_crawls_router())
    app.include_router(create_review_router())
    app.include_router(create_setup_router())
    app.include_router(create_tagger_router())
    app.include_router(create_policies_router())
    app.include_router(create_gallery_router())
    app.include_router(create_datasets_router())
    app.include_router(create_atlas_router())
    app.include_router(create_settings_router())
    app.include_router(create_models_router())
    app.include_router(create_proxy_router())
    app.include_router(create_scheduler_router())
    app.include_router(create_jobs_router())

    return app
