from __future__ import annotations

import asyncio
import re
import uuid
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import JSONResponse

from ..discovery import (
    canonical_gallery_address,
    search_site,
    validate_discovery_args,
)
from ..redaction import redact_text
from ..schemas import CrawlRerunRequest, CrawlRequest, RetryRequest
from .dependencies import get_service
from .errors import ApiError
from .passthrough_models import (
    CrawlBatchListResponse,
    CrawlBatchOperationResponse,
    CrawlBatchResponse,
    CrawlTaskListResponse,
)
from .request_inputs import allowed_request_files, managed_request_credentials
from .validation import (
    range_argument_present,
    validate_idempotency_key,
    validate_network_target,
    validate_site_match,
)

# These states have a worker actively scanning or moving the batch tree. A
# finished/stale review does not touch files and must not block a crawl rerun.
_REVIEW_IN_FLIGHT = {"pending", "analyzing", "applying", "auto_applying"}
_TASKS_VIEW_FIELDS = (
    "id",
    "site",
    "status",
    "source_order",
    "address_order",
    "sequence_no",
    "attempt_count",
    "max_attempts",
    "crawl_address_id",
    "artifact_count",
    "artifact_bytes",
)
CrawlTaskResponseView = Literal["legacy", "tasks"]
CrawlResponseView = Literal["legacy", "desktop"]

_DESKTOP_BATCH_FIELDS = (
    "id",
    "status",
    "created_at",
    "updated_at",
    "finished_at",
    "cancel_requested",
    "concurrency",
    "max_tasks",
    "task_count",
    "succeeded_task_count",
    "failed_task_count",
    "cancelled_task_count",
    "pre_dedup_skipped_count",
    "resumable",
)
_DESKTOP_ADDRESS_FIELDS = (
    "id",
    "address_order",
    "label",
    "address_type",
    "status",
    "planned_task_count",
    "succeeded_task_count",
    "failed_task_count",
    "cancelled_task_count",
    "pre_dedup_skipped_count",
    "probed_proxy_count",
    "healthy_proxy_count",
)
_DESKTOP_REVIEW_FIELDS = (
    "status",
    "total_image_count",
    "duplicate_group_count",
    "decided_group_count",
    "total_group_count",
)
_DESKTOP_CRAWL_ADDRESS_ROWS = 2_000
_TERMINAL_CRAWL_STATUSES = frozenset(
    {"succeeded", "completed_with_errors", "cancelled"}
)


def _desktop_crawl_visible(batch: dict[str, Any]) -> bool:
    if str(batch.get("status") or "") not in _TERMINAL_CRAWL_STATUSES:
        return True
    output_dir = str(batch.get("output_dir") or "")
    return bool(output_dir) and Path(output_dir).is_dir()


def _list_desktop_crawls(
    database: Any, *, limit: int, offset: int
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    cursor = 0
    remaining_offset = offset
    page_limit = min(500, max(30, limit + offset))
    while len(items) < limit:
        page = database.list_crawl_batches(limit=page_limit, offset=cursor)
        if not page:
            break
        cursor += len(page)
        for batch in page:
            if not _desktop_crawl_visible(batch):
                continue
            if remaining_offset:
                remaining_offset -= 1
            else:
                items.append(batch)
                if len(items) == limit:
                    break
        if len(page) < page_limit:
            break
    return items[:limit]


def _desktop_recent_crawl(batch: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(batch.get("id") or "")[:200],
        "status": str(batch.get("status") or "")[:32],
        "created_at": batch.get("created_at"),
    }


def _desktop_batch_crawl(batch: dict[str, Any]) -> dict[str, Any]:
    result = {field: batch.get(field) for field in _DESKTOP_BATCH_FIELDS}
    for key, limit in (("id", 200), ("status", 32)):
        if result.get(key) is not None:
            result[key] = str(result[key])[:limit]
    current = batch.get("current")
    if isinstance(current, dict):
        result["current"] = {
            field: current.get(field)
            for field in ("address_id", "site", "source_order", "address_order", "status")
        }
        for key, limit in (("address_id", 200), ("site", 128), ("status", 32)):
            if result["current"].get(key) is not None:
                result["current"][key] = str(result["current"][key])[:limit]
    else:
        result["current"] = None
    sources: list[dict[str, Any]] = []
    source_values = batch.get("sources")
    source_rows = source_values if isinstance(source_values, list) else []
    projection_truncated = len(source_rows) > 20
    remaining_addresses = _DESKTOP_CRAWL_ADDRESS_ROWS
    for source in source_rows[:20]:
        if not isinstance(source, dict):
            continue
        addresses: list[dict[str, Any]] = []
        address_values = source.get("addresses")
        address_rows = address_values if isinstance(address_values, list) else []
        address_limit = min(500, remaining_addresses)
        if len(address_rows) > address_limit:
            projection_truncated = True
        for address in address_rows[:address_limit]:
            if not isinstance(address, dict):
                continue
            item = {field: address.get(field) for field in _DESKTOP_ADDRESS_FIELDS}
            for key, limit in (
                ("id", 200),
                ("label", 200),
                ("address_type", 100),
                ("status", 32),
            ):
                if item.get(key) is not None:
                    item[key] = str(item[key])[:limit]
            planning_error = address.get("planning_error") or address.get("last_error")
            item["planning_error"] = (
                redact_text(planning_error, limit=500) if planning_error else ""
            )
            addresses.append(item)
        remaining_addresses -= len(addresses)
        sources.append(
            {
                "order": source.get("order"),
                "site": str(source.get("site") or "")[:128],
                "status": str(source.get("status") or "")[:32],
                "pre_dedup_skipped_count": source.get("pre_dedup_skipped_count"),
                "addresses": addresses,
            }
        )
    result["sources"] = sources
    result["address_rows_limit"] = _DESKTOP_CRAWL_ADDRESS_ROWS
    result["address_rows_truncated"] = projection_truncated
    review = batch.get("review")
    result["review"] = (
        {field: review.get(field) for field in _DESKTOP_REVIEW_FIELDS}
        if isinstance(review, dict)
        else None
    )
    result["response_profile"] = "desktop-crawl-v1"
    return result


def _desktop_crawl_operation(batch: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(batch, dict):
        return {"response_profile": "desktop-crawl-operation-v1"}
    return {
        "response_profile": "desktop-crawl-operation-v1",
        "id": str(batch.get("id") or "")[:200],
        "status": str(batch.get("status") or "")[:32],
        "cancel_requested": batch.get("cancel_requested"),
    }


def _tasks_view_item(task: dict[str, Any]) -> dict[str, Any]:
    item = {field: task.get(field) for field in _TASKS_VIEW_FIELDS}
    item["last_error_class"] = str(task.get("last_error_class") or "")[:80]
    return item


def _source_value(body: CrawlRequest, source: Any, name: str) -> Any:
    if name in source.model_fields_set:
        return getattr(source, name)
    return getattr(body, name)


async def _perform_crawl(
    body: CrawlRequest,
    *,
    container: Any,
    idempotency_key: str | None,
) -> tuple[dict[str, Any], bool]:
    base_key = validate_idempotency_key(idempotency_key)
    if base_key is not None:
        existing = container.db.get_crawl_batch_by_idempotency(base_key)
        if existing is not None:
            return existing, False
    try:
        container.gallery.validate_args(body.extra_args)
        validate_discovery_args(body.discovery_extra_args)
        if range_argument_present(body.extra_args):
            raise ValueError("图片范围参数由单地址并发规划器管理")

        canonical_sources: list[tuple[str, Any]] = []
        seen_sites: set[str] = set()
        for source in body.sources:
            site = search_site(source.site).site
            if site in seen_sites:
                raise ValueError(f"sources 重复配置来源: {site}")
            seen_sites.add(site)
            canonical_sources.append((site, source))

        batch_id = str(uuid.uuid4())
        output_dir = container.settings.task_output_dir(
            body.output_dir,
            f"batch-{batch_id}",
        )
        flattened: list[dict[str, Any]] = []
        for source_order, (site, source) in enumerate(canonical_sources):
            policy = container.policy_for(site)
            if source.eh_download is not None and site != "exhentai":
                raise ValueError("eh_download 仅适用于 EH/EHX 来源")
            download_options = (
                {"eh": source.eh_download.model_dump()}
                if source.eh_download is not None
                else {}
            )

            task_args = [*body.extra_args, *source.extra_args]
            discovery_args = [
                *body.discovery_extra_args,
                *source.discovery_extra_args,
            ]
            container.gallery.validate_args(task_args)
            validate_discovery_args(discovery_args)
            if range_argument_present(task_args):
                raise ValueError("图片范围参数由单地址并发规划器管理")
            credentials_ref, cookies_value, config_value = managed_request_credentials(
                container,
                site,
                credentials_ref=_source_value(body, source, "credentials_ref"),
                cookies_file=_source_value(body, source, "cookies_file"),
                config_file=_source_value(body, source, "config_file"),
            )
            cookies, config_file = allowed_request_files(
                container,
                cookies_file=cookies_value,
                config_file=config_value,
            )
            mode = _source_value(body, source, "proxy_mode") or policy.proxy_mode
            max_attempts = _source_value(body, source, "max_attempts") or (
                policy.retry_limit + 1
            )
            priority = (
                source.priority
                if "priority" in source.model_fields_set
                else body.priority
            )
            timeout_seconds = (
                source.timeout_seconds
                if "timeout_seconds" in source.model_fields_set
                else body.timeout_seconds
            )
            for address_order, address in enumerate(source.addresses):
                url = canonical_gallery_address(site, address.url)
                try:
                    await asyncio.to_thread(
                        validate_network_target,
                        url,
                        container.settings.server.allow_private_targets,
                        strict=container.settings.server.strict_target_dns,
                    )
                except ValueError:
                    if mode == "direct":
                        raise
                    try:
                        cache_fallback_allowed = await asyncio.to_thread(
                            container.network_validator.validate_proxy_cache_fallback,
                            url,
                        )
                    except Exception:
                        # Cache is only a temporary allow-list aid. Any internal
                        # error must preserve the original local-DNS 422 path.
                        cache_fallback_allowed = False
                    if not cache_fallback_allowed:
                        raise
                site_info = await asyncio.to_thread(container.resolver.resolve, url)
                if site_info.supported:
                    validate_site_match(site, site_info.site)
                if site == "exhentai" and not re.search(
                    r"https?://(?:e-|ex)hentai\.org/g/\d+/[0-9a-f]{10}/?",
                    url,
                    re.I,
                ):
                    raise ValueError("EH 来源地址必须是具体画廊 /g/GID/TOKEN/")
                address_args = [*task_args, *address.extra_args]
                container.gallery.validate_args(address_args)
                if range_argument_present(address_args):
                    raise ValueError("图片范围参数由单地址并发规划器管理")
                flattened.append(
                    {
                        "id": str(
                            uuid.uuid5(
                                uuid.UUID(batch_id),
                                f"{source_order}:{address_order}:{url}",
                            )
                        ),
                        "site": site,
                        "source_order": source_order,
                        "address_order": address_order,
                        "url": url,
                        "label": address.label or "",
                        "address_type": address.address_type or "",
                        "proxy_mode": mode,
                        "max_attempts": max_attempts,
                        "priority": priority,
                        "credentials_ref": credentials_ref,
                        "cookies_file": str(cookies) if cookies else None,
                        "config_file": str(config_file) if config_file else None,
                        "download_options": download_options,
                        "extra_args": address_args,
                        "discovery_args": discovery_args,
                        "timeout_seconds": timeout_seconds,
                    }
                )
        batch_id, created = container.db.create_crawl_batch(
            {
                "id": batch_id,
                "output_dir": str(output_dir),
                "concurrency": min(
                    body.concurrency,
                    container.settings.scheduler.max_concurrent_tasks,
                ),
                "max_tasks": body.max_tasks,
            },
            flattened,
            idempotency_key=base_key,
        )
        container.ordered_crawls.notify()
        result = container.db.get_crawl_batch(batch_id)
        if result is None:
            raise RuntimeError("顺序爬取批次创建后读取失败")
        result["created"] = created
        result["requested_concurrency"] = body.concurrency
        result["effective_concurrency"] = min(
            body.concurrency,
            container.settings.scheduler.max_concurrent_tasks,
        )
        return result, created
    except ValueError as exc:
        raise ApiError(422, "invalid_crawl", str(exc)) from exc


def create_crawls_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.post(
        "/crawls",
        response_model=CrawlBatchResponse,
        response_model_exclude_unset=True,
    )
    async def create_crawl(
        body: CrawlRequest,
        idempotency_key: str | None = Header(
            default=None,
            alias="Idempotency-Key",
        ),
        view: CrawlResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        result, created = await _perform_crawl(
            body,
            container=container,
            idempotency_key=idempotency_key,
        )
        content = _desktop_crawl_operation(result) if view == "desktop" else result
        return JSONResponse(status_code=202 if created else 200, content=content)

    @router.get(
        "/crawls",
        response_model=CrawlBatchListResponse,
        response_model_exclude_unset=True,
    )
    async def list_crawls(
        limit: int = Query(default=50, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        view: CrawlResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        if view == "desktop":
            items = _list_desktop_crawls(
                container.db, limit=limit, offset=offset
            )
            items = [_desktop_recent_crawl(batch) for batch in items]
        else:
            items = container.db.list_crawl_batches(limit=limit, offset=offset)
        return {
            "items": items,
            "limit": limit,
            "offset": offset,
        }

    @router.get(
        "/crawls/{batch_id}",
        response_model=CrawlBatchResponse,
        response_model_exclude_unset=True,
    )
    async def get_crawl(
        batch_id: str,
        view: CrawlResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        batch = container.db.get_crawl_batch(batch_id)
        if batch is None or (
            view == "desktop" and not _desktop_crawl_visible(batch)
        ):
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        if (
            batch["status"] in {"succeeded", "completed_with_errors", "cancelled"}
            and batch.get("review") is None
        ):
            status = (
                "not_started" if container.settings.dedup.enabled else "disabled"
            )
            batch["review"] = {"batch_id": batch_id, "status": status}
        return _desktop_batch_crawl(batch) if view == "desktop" else batch

    @router.get(
        "/crawls/{batch_id}/tasks",
        response_model=CrawlTaskListResponse,
        response_model_exclude_unset=True,
    )
    async def list_crawl_tasks(
        batch_id: str,
        address_id: str | None = None,
        limit: int = Query(default=100, ge=1, le=1000),
        offset: int = Query(default=0, ge=0),
        view: CrawlTaskResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        if container.db.get_crawl_batch(batch_id) is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        items = container.db.list_crawl_tasks(
            batch_id,
            address_id=address_id,
            limit=limit,
            offset=offset,
        )
        if view == "tasks":
            items = [_tasks_view_item(task) for task in items]
        return {"items": items, "limit": limit, "offset": offset}

    @router.post(
        "/crawls/{batch_id}/cancel",
        response_model=CrawlBatchResponse,
        response_model_exclude_unset=True,
    )
    async def cancel_crawl(
        batch_id: str,
        view: CrawlResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        batch, task_ids = container.db.request_cancel_crawl_batch(batch_id)
        if batch is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        for task_id in task_ids:
            await container.scheduler.cancel(task_id)
        container.ordered_crawls.notify()
        container.db.finish_crawl_batch_if_ready(batch_id)
        result = container.db.get_crawl_batch(batch_id)
        return _desktop_crawl_operation(result) if view == "desktop" else result

    @router.post(
        "/crawls/{batch_id}/retry",
        status_code=202,
        response_model=CrawlBatchOperationResponse,
        response_model_exclude_unset=True,
    )
    async def retry_crawl_failed(
        batch_id: str,
        body: RetryRequest,
        view: CrawlResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        batch = container.db.get_crawl_batch(batch_id)
        if batch is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        if batch["status"] not in {
            "succeeded",
            "completed_with_errors",
            "cancelled",
        }:
            raise ApiError(
                409,
                "crawl_not_finished",
                "批次仍在运行，结束后才能重试失败任务",
            )
        review = batch.get("review")
        if review is not None and review.get("status") in _REVIEW_IN_FLIGHT:
            raise ApiError(
                409,
                "review_in_progress",
                "图片审核进行中，结束后才能重试失败任务",
            )
        result = container.db.retry_failed_crawl_tasks(
            batch_id,
            body.additional_attempts,
        )
        if result is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        if not result["retried_count"] and not result.get(
            "replanned_address_count"
        ):
            raise ApiError(
                409,
                "crawl_no_failed_tasks",
                "批次没有可重新排队的失败任务或待重规划的地址",
            )
        container.scheduler.notify()
        container.ordered_crawls.notify()
        for address_id in result.get("address_ids", []):
            container.db.finish_crawl_address_if_terminal(address_id)
        container.db.finish_crawl_batch_if_ready(batch_id)
        batch = container.db.get_crawl_batch(batch_id)
        if view == "desktop":
            return _desktop_crawl_operation(batch)
        return {
            **result,
            "batch": batch,
        }

    @router.post(
        "/crawls/{batch_id}/rerun",
        status_code=202,
        response_model=CrawlBatchOperationResponse,
        response_model_exclude_unset=True,
    )
    async def rerun_crawl(
        batch_id: str,
        body: CrawlRerunRequest,
        view: CrawlResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        batch = container.db.get_crawl_batch(batch_id)
        if batch is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        if batch["status"] not in {
            "succeeded",
            "completed_with_errors",
            "cancelled",
        }:
            raise ApiError(
                409,
                "crawl_not_finished",
                "批次仍在运行，结束后才能重新爬取",
            )
        review = batch.get("review")
        if review is not None and review.get("status") in _REVIEW_IN_FLIGHT:
            raise ApiError(
                409,
                "review_in_progress",
                "图片审核进行中，结束后才能重新爬取",
            )
        result = container.db.rerun_crawl_batch(
            batch_id,
            body.additional_attempts,
            requeue_succeeded=body.requeue_succeeded,
        )
        if result is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        if result.get("not_terminal"):
            raise ApiError(
                409,
                "crawl_not_finished",
                "批次仍在运行，结束后才能重新爬取",
            )
        container.scheduler.notify()
        container.ordered_crawls.notify()
        rerun_batch = container.db.get_crawl_batch(batch_id)
        if view == "desktop":
            return _desktop_crawl_operation(rerun_batch)
        return {
            **result,
            "batch": rerun_batch,
        }

    return router
