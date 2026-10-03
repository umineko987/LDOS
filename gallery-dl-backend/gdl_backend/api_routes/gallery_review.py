from __future__ import annotations

import asyncio
import mimetypes
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..review_filters import FilterConfigurationError
from ..schemas import FilterConfig, FilterPresetWrite
from .dependencies import get_service
from .errors import ApiError
from .review import _desktop_review_operation, _desktop_review_response


class GalleryReviewCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    directory_ids: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(default_factory=list, max_length=200)
    asset_ids: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(default_factory=list, max_length=200)
    filter_config: FilterConfig | None = None


class GalleryReviewAdopt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    selected_image_ids: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(default_factory=list, max_length=200)
    version: int = Field(ge=1)


def gallery_review_response(review: dict[str, Any], page: dict[str, Any] | None = None,
                            snapshots: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    if page is not None:
        bindings = {s["asset_id"]: s for s in snapshots or []}
        for group in page["items"]:
            for image in group["images"]:
                binding = bindings[image["id"]]
                image["gallery"] = {
                    "asset_id": binding["asset_id"], "source_id": binding["source_id"],
                    "directory_id": binding["directory_id"], "relative_path": binding["relative_path"],
                    "source_display_name": binding["source_display_name"],
                    "disposition": image["disposition"], "hasError": bool(image["error"]),
                    "url": f"/api/v1/gallery/reviews/{review['review_id']}/images/{image['id']}",
                }
    result = _desktop_review_response(review, page) if page is not None else _desktop_review_operation(review)
    result.pop("batch_id", None)
    result.update(response_profile="desktop-gallery-review-v1" if page is not None else "desktop-gallery-review-operation-v1",
                  review_id=review["review_id"], version=review["version"], directories=review["directories"],
                  created_at=review["created_at"], updated_at=review["updated_at"], filter_config=review.get("filter_config"),
                  filteredImageCount=review.get("filtered_image_count", 0))
    return result


def review_error(exc: Exception) -> ApiError:
    if isinstance(exc, FilterConfigurationError):
        status = 409 if exc.code == "review_filter_unavailable" else 422
        return ApiError(status, exc.code, str(exc), details=exc.details)
    if isinstance(exc, KeyError):
        return ApiError(404, "review_not_found", "图库审核或目录、图片不存在")
    if isinstance(exc, ValueError):
        return ApiError(409, "review_selection_invalid", "图库审核选择无效或没有可审核图片")
    return ApiError(409, "review_state_conflict", "图库审核状态、版本或文件快照已冲突")

def create_gallery_review_presets_router() -> APIRouter:
    router = APIRouter(prefix="/gallery/review-presets")

    def preset_error(exc: Exception) -> ApiError:
        if isinstance(exc, KeyError):
            return ApiError(404, "review_preset_not_found", "筛选预设不存在")
        return ApiError(409, "review_preset_builtin", "内置预设不可删除")

    @router.get("")
    async def list_presets(container: Any = Depends(get_service)):
        return {"items": await asyncio.to_thread(container.db.gallery_reviews.list_presets)}

    @router.post("", status_code=201)
    async def create_preset(body: FilterPresetWrite, container: Any = Depends(get_service)):
        return await asyncio.to_thread(container.db.gallery_reviews.save_preset, body.name, body.options.model_dump())

    @router.put("/{preset_id}")
    async def update_preset(preset_id: str, body: FilterPresetWrite, container: Any = Depends(get_service)):
        try:
            return await asyncio.to_thread(container.db.gallery_reviews.save_preset, body.name, body.options.model_dump(), preset_id=preset_id)
        except (KeyError, RuntimeError) as exc:
            raise preset_error(exc) from None

    @router.delete("/{preset_id}", status_code=204)
    async def delete_preset(preset_id: str, container: Any = Depends(get_service)):
        try:
            await asyncio.to_thread(container.db.gallery_reviews.delete_preset, preset_id)
        except (KeyError, RuntimeError) as exc:
            raise preset_error(exc) from None
        return Response(status_code=204)

    return router


def create_gallery_review_router() -> APIRouter:
    router = APIRouter(prefix="/gallery/reviews")

    @router.post("", status_code=202)
    async def create_review(body: GalleryReviewCreate, container: Any = Depends(get_service)):
        if not container.settings.dedup.enabled:
            raise ApiError(409, "dedup_disabled", "去重功能未启用")
        try:
            result = await asyncio.to_thread(container.gallery_reviews.create, body.directory_ids, body.asset_ids,
                                             body.filter_config.model_dump() if body.filter_config is not None else None)
        except (KeyError, ValueError, RuntimeError, OSError) as exc:
            raise review_error(exc) from None
        return gallery_review_response(result)

    @router.get("/{review_id}")
    async def get_review(review_id: str, limit: int = Query(12, ge=1, le=50), offset: int = Query(0, ge=0),
                         view: Literal["desktop"] = Query("desktop"),
                         kind: Literal["duplicate", "single", "unreadable"] | None = Query(None),
                         container: Any = Depends(get_service)):
        def read():
            repo = container.db.gallery_reviews
            # One read snapshot for summary, version and groups.
            with container.db._read():
                review = repo.get_crawl_review(review_id)
                if review is None:
                    raise KeyError(review_id)
                page = repo.list_crawl_review_groups(review_id, limit=limit, offset=offset, kind=kind)
                return gallery_review_response(review, page, repo.snapshot(review_id))
        try:
            return await asyncio.to_thread(read)
        except KeyError as exc:
            raise review_error(exc) from None

    @router.post("/{review_id}/groups/{group_id}/adopt")
    async def adopt(review_id: str, group_id: str, body: GalleryReviewAdopt, container: Any = Depends(get_service)):
        try:
            result = await asyncio.to_thread(
                container.gallery_reviews.adopt_group, review_id, group_id, body.selected_image_ids, version=body.version,
            )
            return gallery_review_response(result)
        except (KeyError, ValueError, RuntimeError, OSError) as exc:
            raise review_error(exc) from None

    @router.post("/{review_id}/retry", status_code=202)
    async def retry(review_id: str, container: Any = Depends(get_service)):
        try:
            if not await asyncio.to_thread(container.gallery_reviews.retry_analysis, review_id):
                raise KeyError(review_id)
            return gallery_review_response(container.db.gallery_reviews.get_crawl_review(review_id))
        except (KeyError, RuntimeError) as exc:
            raise review_error(exc) from None

    @router.post("/{review_id}/finish", status_code=204)
    async def finish(review_id: str, container: Any = Depends(get_service)):
        try:
            await asyncio.to_thread(container.gallery_reviews.finish, review_id)
        except KeyError as exc:
            raise review_error(exc) from None
        return Response(status_code=204)

    @router.get("/{review_id}/images/{image_id}")
    async def image_content(review_id: str, image_id: str, container: Any = Depends(get_service)):
        try:
            handle, name = await asyncio.to_thread(container.gallery_reviews.image_content, review_id, image_id)
        except (KeyError, ValueError, RuntimeError, OSError) as exc:
            raise review_error(exc) from None
        def body():
            try:
                while chunk := handle.read(128 * 1024):
                    yield chunk
            finally:
                handle.close()
        return StreamingResponse(body(), media_type=mimetypes.guess_type(name)[0] or "application/octet-stream",
                                 headers={"Cache-Control": "private, no-store"})

    return router
