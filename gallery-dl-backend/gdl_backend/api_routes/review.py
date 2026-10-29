from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse, Response

from ..database import CrawlReviewGroupLimitExceeded, MAX_CRAWL_REVIEW_GROUPS
from ..redaction import safe_exception_category
from ..review import resolve_review_file
from ..schemas import ReviewDecisions
from .dependencies import get_service
from .errors import ApiError
from .review_models import CrawlReviewOperationResponse, CrawlReviewResponse

logger = logging.getLogger(__name__)

ReviewResponseView = Literal["legacy", "desktop"]
REVIEW_RESPONSE_PROFILE = "desktop-review-v1"
_DESKTOP_REVIEW_PAGE_BYTES = 768 * 1024
_DESKTOP_REVIEW_GROUP_IMAGE_LIMIT = 1_000


def _count(value: Any, *, maximum: int = 1_000_000_000) -> int:
    if isinstance(value, bool):
        return 0
    try:
        number = int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0
    return min(maximum, max(0, number))


def _desktop_review_image(image: dict[str, Any]) -> dict[str, Any]:
    metadata = image.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    return {
        "id": str(image.get("id") or "")[:128],
        "ordinal": _count(image.get("ordinal"), maximum=100_000),
        "readable": bool(image.get("readable")),
        "recommended": bool(image.get("recommended")),
        "selected": bool(image.get("selected")),
        **(image.get("gallery") or {}),
        "metadata": {
            "w": _count(metadata.get("w", metadata.get("width")), maximum=1_000_000),
            "h": _count(metadata.get("h", metadata.get("height")), maximum=1_000_000),
            **({"classification": metadata["classification"]}
               if metadata.get("classification") in {"rough", "monochrome"} else {}),
        },
    }


def _desktop_review_group(group: dict[str, Any]) -> dict[str, Any]:
    images = group.get("images")
    if not isinstance(images, list):
        images = []
    if len(images) > _DESKTOP_REVIEW_GROUP_IMAGE_LIMIT:
        raise ApiError(
            413,
            "review_group_too_large",
            f"单个审核组超过 {_DESKTOP_REVIEW_GROUP_IMAGE_LIMIT} 张图片上限",
        )
    return {
        "id": str(group.get("id") or "")[:128],
        "ordinal": _count(group.get("ordinal"), maximum=100_000),
        "kind": str(group.get("kind") or "single")[:32],
        "decided": bool(group.get("decided")),
        "images": [
            _desktop_review_image(image)
            for image in images
            if isinstance(image, dict)
        ],
    }


def _desktop_review_response(
    review: dict[str, Any],
    page: dict[str, Any],
) -> dict[str, Any]:
    raw_groups = page.get("items")
    group_rows = (
        [group for group in raw_groups if isinstance(group, dict)]
        if isinstance(raw_groups, list)
        else []
    )
    projected_groups: list[dict[str, Any]] = []
    used_bytes = 0
    for group in group_rows:
        projected = _desktop_review_group(group)
        projected_bytes = len(
            json.dumps(
                projected,
                ensure_ascii=True,
                separators=(",", ":"),
            ).encode("ascii")
        ) + 1
        if used_bytes + projected_bytes > _DESKTOP_REVIEW_PAGE_BYTES:
            if not projected_groups:
                raise ApiError(
                    413,
                    "review_group_response_too_large",
                    "单个审核组超过桌面响应预算",
                )
            break
        projected_groups.append(projected)
        used_bytes += projected_bytes
    return {
        "response_profile": REVIEW_RESPONSE_PROFILE,
        "batch_id": str(review.get("batch_id") or "")[:128],
        "status": str(review.get("status") or "failed")[:32],
        "totalImageCount": _count(review.get("total_image_count")),
        "totalGroupCount": _count(review.get("total_group_count")),
        "duplicateGroupCount": _count(review.get("duplicate_group_count")),
        "unreadableImageCount": _count(review.get("unreadable_image_count")),
        "automaticGroupCount": _count(review.get("automatic_group_count")),
        "automaticRejectedImageCount": _count(
            review.get("automatic_rejected_image_count")
        ),
        "selectedImageCount": _count(review.get("selected_image_count")),
        "decidedGroupCount": _count(review.get("decided_group_count")),
        "keptImageCount": _count(review.get("kept_image_count")),
        "rejectedImageCount": _count(review.get("rejected_image_count")),
        "failedImageCount": _count(review.get("failed_image_count")),
        "hasError": bool(review.get("error")),
        "groups": {
            "items": projected_groups,
            "byte_truncated": len(projected_groups) < len(group_rows),
            "total": _count(page.get("total"), maximum=MAX_CRAWL_REVIEW_GROUPS),
            "limit": _count(page.get("limit"), maximum=MAX_CRAWL_REVIEW_GROUPS),
            "offset": _count(page.get("offset"), maximum=MAX_CRAWL_REVIEW_GROUPS),
        },
    }


def _desktop_review_operation(review: dict[str, Any] | None) -> dict[str, Any]:
    projected = _desktop_review_response(
        review if isinstance(review, dict) else {},
        _empty_review_groups(limit=0, offset=0),
    )
    projected.pop("groups")
    projected["response_profile"] = "desktop-review-operation-v1"
    return projected


def _empty_review_groups(*, limit: int, offset: int) -> dict[str, Any]:
    return {
        "items": [],
        "total": 0,
        "limit": limit,
        "offset": offset,
    }


def _sync_gallery_after_apply(container: Any, batch_id: str) -> None:
    """Persist and apply the completed review result to Gallery visibility."""
    gallery = getattr(container, "gallery_catalog", None)
    if gallery is None:
        return
    images = container.db.crawl_review_apply_images(batch_id)
    gallery.reconcile_review_images(batch_id, images)


def create_review_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get(
        "/crawls/{batch_id}/review",
        response_model=CrawlReviewResponse,
        response_model_exclude_unset=True,
    )
    async def get_crawl_review(
        batch_id: str,
        kind: str | None = Query(
            default=None,
            pattern="^(duplicate|single|unreadable)$",
        ),
        classification: Literal["rough", "monochrome"] | None = Query(None),
        limit: int = Query(default=12, ge=1, le=50),
        offset: int = Query(default=0, ge=0),
        all_groups: bool = Query(default=False, alias="all"),
        view: ReviewResponseView = Query("legacy"),
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
                "爬取批次结束后才会进入图片审核",
            )
        response_offset = 0 if all_groups else offset
        response_limit = 0 if all_groups else limit
        review = container.db.get_crawl_review(batch_id)
        if review is None:
            status = (
                "not_started" if container.settings.dedup.enabled else "disabled"
            )
            empty_page = _empty_review_groups(
                limit=response_limit,
                offset=response_offset,
            )
            empty_review = {"batch_id": batch_id, "status": status}
            if view == "desktop":
                return _desktop_review_response(empty_review, empty_page)
            return {**empty_review, "groups": empty_page}
        page = _empty_review_groups(
            limit=response_limit,
            offset=response_offset,
        )
        if review["status"] in {"ready", "applying", "applied", "apply_failed"}:
            try:
                page = container.db.list_crawl_review_groups(
                    batch_id,
                    kind=kind,
                    classification=classification,
                    limit=limit,
                    offset=offset,
                    all_groups=all_groups,
                )
            except CrawlReviewGroupLimitExceeded as exc:
                raise ApiError(
                    413,
                    "review_groups_too_large",
                    f"全量审核组超过 {MAX_CRAWL_REVIEW_GROUPS} 组上限",
                ) from exc
            for group in page["items"]:
                for image in group["images"]:
                    image["url"] = (
                        f"/api/v1/crawls/{batch_id}/review/images/{image['id']}"
                    )
        if view == "desktop":
            return _desktop_review_response(review, page)
        return {**review, "groups": page}

    @router.post(
        "/crawls/{batch_id}/review/start",
        status_code=202,
        response_model=CrawlReviewOperationResponse,
        response_model_exclude_unset=True,
    )
    async def start_crawl_review(
        batch_id: str,
        view: ReviewResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        if not container.settings.dedup.enabled:
            raise ApiError(409, "dedup_disabled", "去重功能未启用")
        try:
            result = container.reviews.start_analysis(batch_id)
            return _desktop_review_operation(result) if view == "desktop" else result
        except KeyError as exc:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在") from exc
        except RuntimeError as exc:
            raise ApiError(409, "review_state_conflict", str(exc)) from exc

    @router.put(
        "/crawls/{batch_id}/review/decisions",
        response_model=CrawlReviewOperationResponse,
        response_model_exclude_unset=True,
    )
    async def update_crawl_review_decisions(
        batch_id: str,
        body: ReviewDecisions,
        view: ReviewResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            container.db.update_crawl_review_decisions(
                batch_id,
                [group.model_dump() for group in body.groups],
            )
        except KeyError as exc:
            raise ApiError(
                404,
                "review_not_found",
                "审核批次或分组不存在",
            ) from exc
        except (RuntimeError, ValueError) as exc:
            raise ApiError(409, "review_state_conflict", str(exc)) from exc
        review = container.db.get_crawl_review(batch_id)
        if review is None:
            raise ApiError(404, "review_not_found", "审核批次不存在")
        return _desktop_review_operation(review) if view == "desktop" else review

    @router.post(
        "/crawls/{batch_id}/review/apply",
        response_model=CrawlReviewOperationResponse,
        response_model_exclude_unset=True,
    )
    async def apply_crawl_review(
        batch_id: str,
        view: ReviewResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        if container.db.get_crawl_batch(batch_id) is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        try:
            result = await asyncio.to_thread(container.reviews.apply, batch_id)
            # 图库侧同步（§3.8）：被淘汰资产立即从列表/搜索/计数剔除，
            # 来源进入 applied 状态；失败不影响已成功的审核结果。
            try:
                await asyncio.to_thread(
                    _sync_gallery_after_apply, container, batch_id
                )
            except Exception as exc:  # noqa: BLE001 - 审核结果已落库，记录安全类别。
                logger.warning(
                    "gallery review reconciliation failed; category=%s",
                    safe_exception_category(exc),
                )
            return _desktop_review_operation(result) if view == "desktop" else result
        except KeyError as exc:
            raise ApiError(404, "review_not_found", "审核批次不存在") from exc
        except RuntimeError as exc:
            raise ApiError(409, "review_state_conflict", str(exc)) from exc

    @router.post(
        "/crawls/{batch_id}/review/retry",
        status_code=202,
        response_model=CrawlReviewOperationResponse,
        response_model_exclude_unset=True,
    )
    async def retry_crawl_review(
        batch_id: str,
        view: ReviewResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            retried = container.reviews.retry_analysis(batch_id)
        except RuntimeError as exc:
            raise ApiError(409, "review_state_conflict", str(exc)) from exc
        if not retried:
            raise ApiError(404, "review_not_found", "审核批次不存在")
        review = container.db.get_crawl_review(batch_id)
        return _desktop_review_operation(review) if view == "desktop" else review

    @router.get(
        "/crawls/{batch_id}/review/images/{image_id}",
        response_class=Response,
        responses={200: {"content": {"image/*": {}}, "description": "审核图片原文件"}},
    )
    async def get_crawl_review_image(
        batch_id: str,
        image_id: str,
        container: Any = Depends(get_service),
    ):
        image = container.db.get_crawl_review_image(batch_id, image_id)
        if image is None:
            raise ApiError(404, "review_image_not_found", "审核图片不存在")
        root = Path(image["output_dir"]).resolve()
        candidates = []
        if image.get("final_relative_path"):
            candidates.append(str(image["final_relative_path"]))
        candidates.append(str(image["relative_path"]))
        for relative_path in candidates:
            try:
                target = resolve_review_file(root, relative_path)
            except ValueError:
                continue
            if target.is_file():
                return FileResponse(target)
        raise ApiError(404, "review_image_not_found", "审核图片文件不存在")

    from .gallery_review import create_gallery_review_router, create_gallery_review_presets_router
    router.include_router(create_gallery_review_router())
    router.include_router(create_gallery_review_presets_router())
    return router
