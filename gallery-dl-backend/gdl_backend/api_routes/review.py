from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse

from ..database import CrawlReviewGroupLimitExceeded, MAX_CRAWL_REVIEW_GROUPS
from ..review import resolve_review_file
from ..schemas import ReviewDecisions
from .dependencies import get_service
from .errors import ApiError


def _empty_review_groups(*, limit: int, offset: int) -> dict[str, Any]:
    return {
        "items": [],
        "total": 0,
        "limit": limit,
        "offset": offset,
    }


def create_review_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get("/crawls/{batch_id}/review")
    async def get_crawl_review(
        batch_id: str,
        kind: str | None = Query(
            default=None,
            pattern="^(duplicate|single|unreadable)$",
        ),
        limit: int = Query(default=12, ge=1, le=50),
        offset: int = Query(default=0, ge=0),
        all_groups: bool = Query(default=False, alias="all"),
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
            return {
                "batch_id": batch_id,
                "status": status,
                "groups": _empty_review_groups(
                    limit=response_limit,
                    offset=response_offset,
                ),
            }
        page = _empty_review_groups(
            limit=response_limit,
            offset=response_offset,
        )
        if review["status"] in {"ready", "applying", "applied", "apply_failed"}:
            try:
                page = container.db.list_crawl_review_groups(
                    batch_id,
                    kind=kind,
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
        return {**review, "groups": page}

    @router.post("/crawls/{batch_id}/review/start", status_code=202)
    async def start_crawl_review(
        batch_id: str,
        container: Any = Depends(get_service),
    ):
        if not container.settings.dedup.enabled:
            raise ApiError(409, "dedup_disabled", "去重功能未启用")
        try:
            return container.reviews.start_analysis(batch_id)
        except KeyError as exc:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在") from exc
        except RuntimeError as exc:
            raise ApiError(409, "review_state_conflict", str(exc)) from exc

    @router.put("/crawls/{batch_id}/review/decisions")
    async def update_crawl_review_decisions(
        batch_id: str,
        body: ReviewDecisions,
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
        return review

    @router.post("/crawls/{batch_id}/review/apply")
    async def apply_crawl_review(
        batch_id: str,
        container: Any = Depends(get_service),
    ):
        if container.db.get_crawl_batch(batch_id) is None:
            raise ApiError(404, "crawl_not_found", "爬取批次不存在")
        try:
            return await asyncio.to_thread(container.reviews.apply, batch_id)
        except KeyError as exc:
            raise ApiError(404, "review_not_found", "审核批次不存在") from exc
        except RuntimeError as exc:
            raise ApiError(409, "review_state_conflict", str(exc)) from exc

    @router.post("/crawls/{batch_id}/review/retry", status_code=202)
    async def retry_crawl_review(
        batch_id: str,
        container: Any = Depends(get_service),
    ):
        try:
            retried = container.reviews.retry_analysis(batch_id)
        except RuntimeError as exc:
            raise ApiError(409, "review_state_conflict", str(exc)) from exc
        if not retried:
            raise ApiError(404, "review_not_found", "审核批次不存在")
        return container.db.get_crawl_review(batch_id)

    @router.get("/crawls/{batch_id}/review/images/{image_id}")
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

    return router
