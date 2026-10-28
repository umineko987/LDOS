from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import FileResponse, JSONResponse

from ..ordered_crawl import EnqueueBatchCancelled
from ..schemas import RetryRequest, TaskCreate, TaskPolicy
from ..site import SiteInfo
from .dependencies import get_service
from .errors import ApiError
from .passthrough_models import (
    TaskEventListResponse,
    TaskFileListResponse,
    TaskListResponse,
    TaskLogListResponse,
    TaskResponse,
)
from .request_inputs import allowed_request_files, managed_request_credentials
from .validation import (
    canonical_site_name,
    validate_idempotency_key,
    validate_network_target,
    validate_site_match,
)

OrderedTaskEnqueuer = Callable[
    [list[TaskCreate], list[str], int],
    Awaitable[list[dict[str, Any]]],
]


def task_files(task: dict[str, Any], limit: int = 2000) -> list[dict[str, Any]]:
    root = Path(task["output_dir"]).resolve()
    if not root.is_dir():
        return []
    files: list[dict[str, Any]] = []
    for path in root.rglob("*"):
        if len(files) >= limit:
            break
        try:
            if path.is_symlink():
                continue
            if path.is_file():
                stat = path.stat()
                files.append(
                    {
                        "path": path.relative_to(root).as_posix(),
                        "size": stat.st_size,
                        "modified_at": stat.st_mtime,
                    }
                )
        except OSError:
            continue
    return files


def build_task_row(
    body: TaskCreate,
    site_info: SiteInfo,
    container: Any,
    *,
    concurrency_override: int | None = None,
) -> dict[str, Any]:
    if body.site:
        site = canonical_site_name(body.site)
        if site_info.supported:
            validate_site_match(site, site_info.site)
    else:
        site = site_info.site
    policy = body._policy_override or container.policy_for(site)
    if body.eh_download is not None:
        if site != "exhentai":
            raise ValueError("eh_download 仅适用于 EH/EHX 任务")
        policy = TaskPolicy.model_validate(
            {
                **policy.model_dump(),
                "eh_download": body.eh_download.model_dump(),
            }
        )
    if concurrency_override is not None:
        effective = min(
            int(concurrency_override),
            container.settings.scheduler.max_concurrent_tasks,
        )
        policy = policy.model_copy(update={"max_concurrency": max(1, effective)})
    task_id = str(uuid.uuid4())
    output_dir = container.settings.task_output_dir(body.output_dir, task_id)
    if body._skip_managed_credentials:
        credentials_ref = body.credentials_ref
        cookies_value = body.cookies_file
        config_value = body.config_file
    else:
        credentials_ref, cookies_value, config_value = managed_request_credentials(
            container,
            site,
            credentials_ref=body.credentials_ref,
            cookies_file=body.cookies_file,
            config_file=body.config_file,
        )
    cookies, config_file = allowed_request_files(
        container,
        cookies_file=cookies_value,
        config_file=config_value,
    )
    container.gallery.validate_args([*policy.extra_args, *body.extra_args])
    return {
        "id": task_id,
        "url": body.url,
        "site": site,
        "subcategory": site_info.subcategory,
        "extractor": site_info.extractor,
        "priority": body.priority,
        "output_dir": str(output_dir),
        "proxy_mode": body.proxy_mode or policy.proxy_mode,
        "max_attempts": body.max_attempts or (policy.retry_limit + 1),
        "cookies_file": str(cookies) if cookies else None,
        "config_file": str(config_file) if config_file else None,
        "credentials_ref": credentials_ref,
        "extra_args": body.extra_args,
        "policy": policy.model_dump(),
    }


async def enqueue_task(
    body: TaskCreate,
    *,
    idempotency_key: str | None,
    container: Any,
    concurrency_override: int | None = None,
    network_validated: bool = False,
    notify: bool = True,
) -> tuple[dict[str, Any], bool]:
    key = validate_idempotency_key(idempotency_key)
    if key is not None:
        existing = container.db.get_task_by_idempotency(key)
        if existing is not None:
            return existing, False
    try:
        if not network_validated:
            await asyncio.to_thread(
                validate_network_target,
                body.url,
                container.settings.server.allow_private_targets,
                strict=container.settings.server.strict_target_dns,
            )
        site_info = await asyncio.to_thread(container.resolver.resolve, body.url)
        task_row = build_task_row(
            body,
            site_info,
            container,
            concurrency_override=concurrency_override,
        )
    except ValueError as exc:
        raise ApiError(422, "invalid_task", str(exc)) from exc
    task, created = container.db.create_task(
        task_row,
        idempotency_key=key,
    )
    if notify:
        container.scheduler.notify()
    return task, created


def create_ordered_task_enqueuer(service: Any) -> OrderedTaskEnqueuer:
    async def enqueue_ordered_tasks(
        bodies: list[TaskCreate],
        idempotency_keys: list[str],
        concurrency: int,
    ) -> list[dict[str, Any]]:
        if len(bodies) != len(idempotency_keys):
            raise RuntimeError("批量任务与幂等键数量不一致")
        if not bodies:
            return []

        keys: list[str] = []
        metadata = []
        for body, raw_key in zip(bodies, idempotency_keys):
            key = validate_idempotency_key(raw_key)
            if key is None:
                raise RuntimeError("顺序爬取任务缺少幂等键")
            link = body._crawl_link
            if link is None:
                raise RuntimeError("顺序爬取任务缺少地址链接元数据")
            keys.append(key)
            metadata.append(link)
        address_id = metadata[0].address_id
        if any(link.address_id != address_id for link in metadata):
            raise RuntimeError("同一入队块包含多个地址")

        def _build_task_rows() -> list[dict[str, Any]]:
            return [
                build_task_row(
                    body,
                    service.resolver.resolve(body.url),
                    service,
                    concurrency_override=concurrency,
                )
                for body in bodies
            ]

        try:
            task_rows = await asyncio.to_thread(_build_task_rows)
        except ValueError as exc:
            raise ApiError(422, "invalid_task", str(exc)) from exc

        items = [
            {
                "task": task_row,
                "idempotency_key": key,
                "sequence_no": link.sequence_no,
                "source_key": link.source_key,
                "source_url": link.source_url,
            }
            for task_row, key, link in zip(task_rows, keys, metadata)
        ]
        # shield only the already-submitted SQLite worker. If cancellation wins
        # the commit race, recover its result so the ordered-crawl cancellation
        # path can drain every task that was linked by the committed write.
        write_task = asyncio.create_task(
            asyncio.to_thread(
                service.db.create_crawl_media_tasks,
                address_id,
                items,
            ),
            name="ordered-crawl-media-write",
        )
        try:
            return await asyncio.shield(write_task)
        except asyncio.CancelledError as cancelled:
            while not write_task.done():
                try:
                    await asyncio.shield(write_task)
                except asyncio.CancelledError:
                    continue
            if write_task.cancelled():
                raise
            try:
                results = write_task.result()
            except Exception as exc:
                raise EnqueueBatchCancelled([]) from exc
            raise EnqueueBatchCancelled(results) from cancelled

    return enqueue_ordered_tasks


def create_tasks_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.post("/tasks", response_model=TaskResponse, response_model_exclude_unset=True)
    async def create_task(
        body: TaskCreate,
        request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        container: Any = Depends(get_service),
    ):
        task, created = await enqueue_task(
            body,
            idempotency_key=idempotency_key,
            container=container,
        )
        return JSONResponse(status_code=202 if created else 200, content=task)

    @router.get("/tasks", response_model=TaskListResponse, response_model_exclude_unset=True)
    async def list_tasks(
        status: str | None = None,
        site: str | None = None,
        limit: int = Query(default=50, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        container: Any = Depends(get_service),
    ):
        items = container.db.list_tasks(
            status=status,
            site=site,
            limit=limit,
            offset=offset,
        )
        return {"items": items, "limit": limit, "offset": offset}

    @router.get("/tasks/{task_id}", response_model=TaskResponse, response_model_exclude_unset=True)
    async def get_task(task_id: str, container: Any = Depends(get_service)):
        task = container.db.get_task(task_id)
        if task is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        return task

    @router.post(
        "/tasks/{task_id}/cancel", response_model=TaskResponse, response_model_exclude_unset=True
    )
    async def cancel_task(task_id: str, container: Any = Depends(get_service)):
        task = await container.scheduler.cancel(task_id)
        if task is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        return task

    @router.post(
        "/tasks/{task_id}/retry",
        status_code=202,
        response_model=TaskResponse,
        response_model_exclude_unset=True,
    )
    async def retry_task(
        task_id: str,
        body: RetryRequest,
        container: Any = Depends(get_service),
    ):
        # Crawl media tasks must be retried through the crawl endpoint so the
        # owning address and batch counters are refreshed atomically.
        crawl_batch_id = container.db.task_crawl_batch_id(task_id)
        if crawl_batch_id is not None:
            raise ApiError(
                409,
                "task_belongs_to_crawl",
                f"该任务属于爬取批次，请通过 /crawls/{crawl_batch_id}/retry 重试以保持批次统计一致",
            )
        try:
            task = container.scheduler.retry(task_id, body.additional_attempts)
        except RuntimeError as exc:
            raise ApiError(409, "task_state_conflict", str(exc)) from exc
        if task is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        return task

    @router.get(
        "/tasks/{task_id}/logs", response_model=TaskLogListResponse, response_model_exclude_unset=True
    )
    async def task_logs(
        task_id: str,
        since: int = Query(default=0, ge=0),
        tail: int | None = Query(default=None, ge=1, le=5000),
        limit: int = Query(default=1000, ge=1, le=5000),
        container: Any = Depends(get_service),
    ):
        if container.db.get_task(task_id) is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        return {
            "items": container.db.get_logs(
                task_id,
                since=since,
                tail=tail,
                limit=limit,
            )
        }

    @router.get(
        "/tasks/{task_id}/events",
        response_model=TaskEventListResponse,
        response_model_exclude_unset=True,
    )
    async def task_events(
        task_id: str,
        since: int = Query(default=0, ge=0),
        limit: int = Query(default=1000, ge=1, le=5000),
        container: Any = Depends(get_service),
    ):
        if container.db.get_task(task_id) is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        return {
            "items": container.db.get_events(
                task_id,
                since=since,
                limit=limit,
            )
        }

    @router.get(
        "/tasks/{task_id}/files", response_model=TaskFileListResponse, response_model_exclude_unset=True
    )
    async def list_task_files(
        task_id: str,
        container: Any = Depends(get_service),
    ):
        task = container.db.get_task(task_id)
        if task is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        return {"items": await asyncio.to_thread(task_files, task)}

    @router.get("/tasks/{task_id}/files/{relative_path:path}")
    async def download_task_file(
        task_id: str,
        relative_path: str,
        container: Any = Depends(get_service),
    ):
        task = container.db.get_task(task_id)
        if task is None:
            raise ApiError(404, "task_not_found", "任务不存在")
        root_dir = Path(task["output_dir"]).resolve()
        unresolved = root_dir / relative_path
        cursor = root_dir
        for part in Path(relative_path).parts:
            cursor = cursor / part
            if cursor.is_symlink():
                raise ApiError(404, "file_not_found", "任务文件不存在")
        target = unresolved.resolve()
        if not (target == root_dir or target.is_relative_to(root_dir)) or not target.is_file():
            raise ApiError(404, "file_not_found", "任务文件不存在")
        return FileResponse(target)

    return router
