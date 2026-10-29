"""图库 API 路由（§7.1–§7.2 只读部分 + 来源生命周期）。

- 高容量 GET 全部要求 `view=desktop` 投影（§6.4）；
- 绝对路径只作为 write input 出现在请求体，响应永远剥离；
- 稳定错误码 + request_id 错误封套（§8.2）；
- 二进制端点（原图/缩略图）带 ETag 与私有缓存头。
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from .._database_gallery_repository import (
    GalleryCursorError,
    GallerySourceConflictError,
    GalleryVersionConflict,
)
from ..gallery_catalog import TXT_STATES
from ..gallery_service import (
    GalleryBatchDeleteError,
    GalleryAnnotationError,
    GalleryAssetFileError,
    GalleryAssetNotFound,
    GalleryCatalogService,
    GalleryRootMissing,
    GalleryScanInProgress,
    GallerySourceNotFound,
    GallerySourceOffline,
)
from ..gallery_directory_export import (
    GalleryDirectoryExportError,
    GalleryDirectoryExportService,
    MAX_DIRECTORY_EXPORT_ID_LENGTH,
    MAX_DIRECTORY_EXPORT_SELECTIONS,
)
from ..gallery_file_operations import (
    GalleryFileOperationError,
    GalleryFileOperations,
)
from ..gallery_thumbnails import SUPPORTED_THUMBNAIL_SIZES, ThumbnailUnavailable
from .dependencies import get_service
from .errors import ApiError
from .validation import validate_idempotency_key

_MEDIA_TYPES: dict[str, str] = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}

_PAGE_LIMITS = Query(default=100, ge=1, le=200)


class GalleryImportRequest(BaseModel):
    root_path: str = Field(min_length=1, max_length=4096)
    display_name: str | None = Field(default=None, max_length=200)


class GallerySourcePatchRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=200)


class GalleryRelinkRequest(BaseModel):
    root_path: str = Field(min_length=1, max_length=4096)


class GalleryAnnotationPutRequest(BaseModel):
    content: str = Field(max_length=2 * 1024 * 1024)
    expected_txt_version: int = Field(ge=1)
    expected_disk_version: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")



class GalleryRenameRequest(BaseModel):
    new_stem: str = Field(min_length=1, max_length=255)


class GalleryTrashRequest(BaseModel):
    asset_ids: list[str] = Field(default_factory=list, max_length=2000)
    directory_ids: list[str] = Field(default_factory=list, max_length=200)



class GalleryTransferRequest(BaseModel):
    asset_ids: list[str] = Field(default_factory=list, max_length=2000)
    directory_ids: list[str] = Field(default_factory=list, max_length=200)
    target_directory_id: str = Field(min_length=1, max_length=128)
class GalleryFileOperationResponse(BaseModel):
    operation_id: str = Field(min_length=1, max_length=128)
    kind: Literal["rename", "trash", "restore", "purge", "move", "copy"]
    status: Literal["committed"]
    item_count: int = Field(ge=0)
    has_txt_count: int = Field(ge=0)


class GalleryPurgeAllTrashResponse(BaseModel):
    purged_operations: int = Field(ge=0)
    purged_items: int = Field(ge=0)


class GalleryTrashOperationResponse(BaseModel):
    operation_id: str = Field(min_length=1, max_length=128)
    created_at: int = Field(ge=0)
    item_count: int = Field(ge=0)
    has_txt_count: int = Field(ge=0)
    item_error_count: int = Field(ge=0)
    disk_usage_bytes: int = Field(ge=0)


class GalleryTrashPageResponse(BaseModel):
    operations: list[GalleryTrashOperationResponse] = Field(max_length=200)
    next_cursor: str | None = Field(default=None, max_length=128)


class GallerySourceResponse(BaseModel):
    source_id: str = Field(min_length=1, max_length=128)
    root_directory_id: str | None = Field(default=None, max_length=128)
    kind: Literal["imported", "crawl_batch"]
    batch_id: str | None = Field(default=None, max_length=128)
    display_name: str = Field(max_length=256)
    availability: Literal["available", "offline", "conflict", "scanning", "error"]
    asset_count: int = Field(ge=0)
    candidate_count: int = Field(ge=0)
    kept_count: int = Field(ge=0)
    removed_count: int = Field(ge=0)
    crawl_complete: bool
    dedup_required: bool
    dedup_state: Literal[
        "not_required", "pending_analysis", "review_pending", "applied", "stale"
    ]
    content_version: int = Field(ge=1)
    dedup_applied_version: int = Field(ge=0)
    reconciliation_state: Literal["none", "pending", "failed", "applied"]
    reconciliation_error_code: Literal["", "review_reconciliation_apply_failed"]
    reconciliation_attempt_count: int = Field(ge=0)
    reconciliation_updated_at: float | None = Field(default=None, ge=0)
    annotation_version: int = Field(ge=1)
    indexed_version: int = Field(ge=0)
    last_scanned_at: float | None = Field(default=None, ge=0)
    created_at: float = Field(ge=0)
    updated_at: float = Field(ge=0)


class GallerySourcePageResponse(BaseModel):
    sources: list[GallerySourceResponse]


class GallerySourceRemovedResponse(BaseModel):
    source_id: str = Field(min_length=1, max_length=128)
    removed: Literal[True]


class GalleryScanStatsResponse(BaseModel):
    asset_count: int = Field(ge=0)
    candidate_count: int = Field(ge=0)
    kept_count: int = Field(ge=0)
    removed_count: int = Field(ge=0)
    directory_count: int = Field(ge=0)
    content_changed: bool
    annotation_changed: bool
    indexed_version: int = Field(ge=0)
    offline: bool
    skipped_temporary: int = Field(ge=0)
    skipped_unsupported: int = Field(ge=0)


class GalleryScanOperationResponse(BaseModel):
    operation_id: str | None = Field(default=None, max_length=128)
    source_id: str = Field(min_length=1, max_length=128)
    state: Literal["idle", "running", "succeeded", "failed"]
    started_at: float | None = Field(default=None, ge=0)
    finished_at: float | None = Field(default=None, ge=0)
    error_code: Literal[
        "", "scan_failed", "source_not_found", "source_offline", "io_error",
        "scan_interrupted",
    ]
    stats: GalleryScanStatsResponse | None = None


class GalleryDirectoryEntryResponse(BaseModel):
    directory_id: str = Field(min_length=1, max_length=128)
    source_id: str = Field(min_length=1, max_length=128)
    parent_id: str | None = Field(default=None, max_length=128)
    relative_path: str = Field(max_length=4096)
    name: str = Field(max_length=255)
    direct_directory_count: int = Field(ge=0)
    direct_asset_count: int = Field(ge=0)
    recursive_asset_count: int = Field(ge=0)
    cover_asset_ids: list[str] = Field(max_length=9)
    indexed_version: int = Field(ge=1)


class GalleryAssetEntryResponse(BaseModel):
    asset_id: str = Field(min_length=1, max_length=128)
    source_id: str | None = Field(default=None, max_length=128)
    directory_id: str | None = Field(default=None, max_length=128)
    relative_path: str = Field(min_length=1, max_length=4096)
    name: str = Field(min_length=1, max_length=255)
    extension: str = Field(max_length=16)
    size_bytes: int = Field(ge=0)
    modified_ns: int = Field(ge=0)
    content_sha256: str = Field(max_length=64)
    content_version: int = Field(ge=1)
    format: str = Field(max_length=16)
    width: int = Field(ge=0)
    height: int = Field(ge=0)
    read_state: Literal["pending", "ok", "failed"]
    error_code: str = Field(max_length=128)
    txt_relative_path: str | None = Field(default=None, max_length=4096)
    txt_size_bytes: int = Field(ge=0)
    txt_modified_ns: int = Field(ge=0)
    txt_version: int = Field(ge=1)
    txt_state: Literal[
        "normal", "missing", "blank", "invalid_encoding", "pair_conflict", "io_error"
    ]
    dedup_visibility: Literal["candidate", "kept", "excluded"]
    lifecycle_state: Literal["active", "missing", "trashed"]
    updated_at: float = Field(ge=0)


class GalleryDirectoryPageResponse(BaseModel):
    directory: GalleryDirectoryEntryResponse
    directories: list[GalleryDirectoryEntryResponse]
    assets: list[GalleryAssetEntryResponse]
    directory_cursor: str | None = Field(default=None, max_length=512)
    asset_cursor: str | None = Field(default=None, max_length=512)
    include_descendants: bool
    limit: int = Field(ge=1, le=200)
    source_roots: dict[str, str] = Field(default_factory=dict)


class GallerySearchPageResponse(BaseModel):
    scope: Literal["directory", "source", "library"]
    assets: list[GalleryAssetEntryResponse]
    asset_cursor: str | None = Field(default=None, max_length=512)
    limit: int = Field(ge=1, le=200)
    source_roots: dict[str, str] = Field(default_factory=dict)


class GalleryAssetEnvelopeResponse(BaseModel):
    asset: GalleryAssetEntryResponse
    source_roots: dict[str, str] = Field(default_factory=dict)


class GalleryAnnotationResponse(BaseModel):
    asset_id: str = Field(min_length=1, max_length=128)
    txt_state: Literal[
        "normal", "missing", "blank", "invalid_encoding", "pair_conflict", "io_error"
    ]
    content: str | None = Field(default=None, max_length=2 * 1024 * 1024)
    txt_version: int = Field(ge=0)
    disk_version: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")


class GalleryDirectoryExportResultResponse(BaseModel):
    directory_name: str = Field(max_length=255)
    status: Literal["completed", "failed", "cancelled"]
    copied_file_count: int = Field(ge=0)
    copied_byte_count: int = Field(ge=0)
    error_code: str | None = Field(default=None, max_length=128)


class GalleryDirectoryExportOperationResponse(BaseModel):
    operation_id: str = Field(min_length=1, max_length=MAX_DIRECTORY_EXPORT_ID_LENGTH)
    state: Literal["copying", "completed", "failed", "cancelled"]
    current_directory_name: str | None = Field(default=None, max_length=255)
    directory_count: int = Field(ge=1, le=MAX_DIRECTORY_EXPORT_SELECTIONS)
    completed_directory_count: int = Field(ge=0)
    failed_directory_count: int = Field(ge=0)
    discovered_file_count: int = Field(ge=0)
    copied_file_count: int = Field(ge=0)
    discovered_byte_count: int = Field(ge=0)
    copied_byte_count: int = Field(ge=0)
    error_code: str | None = Field(default=None, max_length=128)
    successful_directory_names: list[str] = Field(
        max_length=MAX_DIRECTORY_EXPORT_SELECTIONS
    )
    results: list[GalleryDirectoryExportResultResponse] = Field(
        max_length=MAX_DIRECTORY_EXPORT_SELECTIONS
    )

GalleryDirectoryExportId = Annotated[
    str,
    Field(min_length=1, max_length=MAX_DIRECTORY_EXPORT_ID_LENGTH),
]


class GalleryDirectoryExportRequest(BaseModel):
    directory_ids: list[GalleryDirectoryExportId] = Field(
        min_length=1, max_length=MAX_DIRECTORY_EXPORT_SELECTIONS
    )
    target_path: str = Field(min_length=1, max_length=4096)


def _source_not_found(source_id: str) -> ApiError:
    return ApiError(404, "source_not_found", "图库来源不存在")


def _asset_not_found(asset_id: str) -> ApiError:
    return ApiError(404, "asset_not_found", "图库图片不存在")

_FILE_OPERATION_ERROR_STATUS: dict[str, int] = {
    "asset_not_found": 404,
    "directory_not_found": 404,
    "directory_root_not_deletable": 409,
    "directory_selection_overlap": 409,
    "directory_selection_invalid": 422,
    "selection_required": 422,
    "directory_missing": 409,
    "trash_directory_missing": 409,
    "directory_rename_not_supported": 409,
    "trash_operation_not_found": 409,
    "asset_not_active": 409,
    "operation_not_found": 404,
    "source_not_found": 404,
    "source_offline": 409,
    "source_missing": 409,
    "source_conflict": 409,
    "unsafe_source_path": 409,
    "operation_in_progress": 409,
    "operation_not_reversible": 409,
    "rename_target_conflict": 409,
    "restore_target_conflict": 409,
    "invalid_rename_target": 422,
    "invalid_asset_ids": 422,
    "rename_noop": 422,
    "invalid_cursor": 422,
    "operation_recovery_required": 500,
    "operation_failed": 500,
    "invalid_operation_kind": 422,
    "asset_selection_invalid": 422,
    "target_directory_not_found": 404,
    "target_inside_source": 409,
    "directory_root_not_movable": 409,
    "source_mismatch": 409,
    "transfer_target_conflict": 409,
    "asset_file_missing": 409,
}


def _file_operation_api_error(
    error: GalleryFileOperationError,
    *,
    asset_id: str | None = None,
    asset_ids: list[str] | None = None,
    directory_ids: list[str] | None = None,
    operation_id: str | None = None,
) -> ApiError:
    status = _FILE_OPERATION_ERROR_STATUS.get(error.code, 500)
    details: dict[str, Any] = dict(error.details)
    if asset_id is not None:
        details.setdefault("asset_id", asset_id)
    if asset_ids is not None:
        details.setdefault("asset_ids", asset_ids)
    if directory_ids is not None:
        details.setdefault("directory_ids", directory_ids)
    if operation_id is not None:
        details.setdefault("operation_id", operation_id)
    return ApiError(status, error.code, "图库文件操作失败", details=details)

_DIRECTORY_EXPORT_ERROR_STATUS: dict[str, int] = {
    "operation_not_found": 404,
    "directory_not_found": 404,
    "source_not_found": 404,
    "invalid_directory_ids": 422,
    "directory_name_invalid": 422,
    "target_path_not_absolute": 422,
    "target_path_invalid": 422,
    "selected_name_conflict": 409,
    "target_name_conflict": 409,
    "target_inside_source": 409,
    "target_busy": 409,
    "operation_capacity_reached": 429,
    "target_not_writable": 409,
    "target_not_directory": 409,
    "target_unavailable": 409,
    "target_path_unsafe": 409,
    "target_path_changed": 409,
    "target_root_changed": 409,
    "temporary_cleanup_failed": 409,
    "source_offline": 409,
    "source_changed": 409,
    "unsafe_source_path": 409,
    "service_stopping": 503,
    "operation_start_failed": 503,
    "no_clobber_unsupported": 500,
}


def _directory_export_api_error(error: GalleryDirectoryExportError) -> ApiError:
    return ApiError(
        _DIRECTORY_EXPORT_ERROR_STATUS.get(error.code, 500),
        error.code,
        "图库目录导出操作失败",
        details=dict(error.details),
    )


def create_gallery_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    # ---- §7.1 来源与目录 ----

    @router.get("/gallery/sources", response_model=GallerySourcePageResponse)
    async def list_gallery_sources(
        view: Literal["desktop"] = "desktop",
        container: Any = Depends(get_service),
    ) -> Any:
        catalog: GalleryCatalogService = container.gallery_catalog
        return {"sources": catalog.list_sources()}

    @router.get(
        "/gallery/sources/{source_id}", response_model=GallerySourceResponse
    )
    async def get_gallery_source(
        source_id: str,
        view: Literal["desktop"] = "desktop",
        container: Any = Depends(get_service),
    ) -> Any:
        catalog: GalleryCatalogService = container.gallery_catalog
        try:
            return catalog.get_source(source_id)
        except GallerySourceNotFound:
            raise _source_not_found(source_id) from None

    @router.post(
        "/gallery/imports", status_code=201, response_model=GallerySourceResponse
    )
    async def import_gallery_source(
        request: GalleryImportRequest,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        catalog: GalleryCatalogService = container.gallery_catalog
        try:
            source = catalog.import_source(
                request.root_path, display_name=request.display_name
            )
        except GalleryRootMissing:
            raise ApiError(
                404, "source_path_not_found", "导入目录不存在或不是普通目录"
            ) from None
        except GallerySourceConflictError as conflict:
            raise ApiError(
                409,
                "source_path_conflict",
                "该目录与现有图库来源重叠",
                details={"relation": conflict.relation},
            ) from None
        catalog.start_scan(source["source_id"])
        return source

    @router.patch(
        "/gallery/sources/{source_id}", response_model=GallerySourceResponse
    )
    async def patch_gallery_source(
        source_id: str,
        request: GallerySourcePatchRequest,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        catalog: GalleryCatalogService = container.gallery_catalog
        try:
            return catalog.update_source(source_id, display_name=request.display_name)
        except GallerySourceNotFound:
            raise _source_not_found(source_id) from None
        except ValueError:
            raise ApiError(422, "invalid_display_name", "显示名不能为空") from None

    @router.delete(
        "/gallery/sources/{source_id}", response_model=GallerySourceRemovedResponse
    )
    async def delete_gallery_source(
        source_id: str,
        delete_files: bool = Query(default=False),
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        catalog: GalleryCatalogService = container.gallery_catalog
        try:
            if delete_files:
                catalog.delete_batch_source(source_id)
            else:
                catalog.unregister_source(source_id)
        except GallerySourceNotFound:
            raise _source_not_found(source_id) from None
        except GalleryBatchDeleteError as error:
            raise ApiError(
                409, error.code, "删除下载批次失败，请检查批次目录是否可访问"
            ) from None
        except ValueError as error:
            if str(error) == "gallery_batch_source_required":
                raise ApiError(
                    409, "gallery_batch_source_required", "只有下载批次可以递归删除文件"
                ) from None
            raise
        except GalleryScanInProgress:
            raise ApiError(
                409, "source_scan_in_progress", "来源正在扫描，稍后再解除"
            ) from None
        return {"source_id": source_id, "removed": True}
    @router.post(
        "/gallery/sources/{source_id}/relink", response_model=GallerySourceResponse
    )
    async def relink_gallery_source(
        source_id: str,
        request: GalleryRelinkRequest,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        catalog: GalleryCatalogService = container.gallery_catalog
        try:
            source = catalog.relink_source(source_id, request.root_path)
        except GallerySourceNotFound:
            raise _source_not_found(source_id) from None
        except GalleryRootMissing:
            raise ApiError(
                404, "source_path_not_found", "目标目录不存在或不是普通目录"
            ) from None
        except GalleryScanInProgress:
            raise ApiError(
                409, "source_scan_in_progress", "来源正在扫描，稍后再重新关联"
            ) from None
        except GallerySourceConflictError as conflict:
            raise ApiError(
                409,
                "source_path_conflict",
                "该目录与现有图库来源重叠",
                details={"relation": conflict.relation},
            ) from None
        try:
            catalog.start_scan(source_id)
        except GalleryScanInProgress:
            pass
        return source

    @router.post(
        "/gallery/sources/{source_id}/scan",
        status_code=202,
        response_model=GalleryScanOperationResponse,
    )
    async def start_gallery_scan(
        source_id: str,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        catalog: GalleryCatalogService = container.gallery_catalog
        try:
            return catalog.start_scan(source_id)
        except GallerySourceNotFound:
            raise _source_not_found(source_id) from None
        except GalleryScanInProgress:
            raise ApiError(
                409, "source_scan_in_progress", "该来源已有扫描正在进行"
            ) from None

    @router.get(
        "/gallery/sources/{source_id}/scan", response_model=GalleryScanOperationResponse
    )
    async def get_gallery_scan(
        source_id: str,
        view: Literal["desktop"] = "desktop",
        container: Any = Depends(get_service),
    ) -> Any:
        catalog: GalleryCatalogService = container.gallery_catalog
        try:
            return catalog.get_scan(source_id)
        except GallerySourceNotFound:
            raise _source_not_found(source_id) from None


    @router.post(
        "/gallery/sources/{source_id}/reconciliation/retry",
        status_code=202,
        response_model=GallerySourceResponse,
    )
    async def retry_gallery_reconciliation(
        source_id: str,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        catalog: GalleryCatalogService = container.gallery_catalog
        try:
            return await asyncio.to_thread(
                catalog.retry_review_reconciliation, source_id
            )
        except GallerySourceNotFound:
            raise _source_not_found(source_id) from None
        except ValueError:
            raise ApiError(
                409,
                "gallery_reconciliation_not_retryable",
                "该来源没有可重试的去重对账",
            ) from None
        except Exception:
            raise ApiError(
                409,
                "gallery_reconciliation_retry_failed",
                "去重对账重试失败，请稍后重试",
            ) from None

    @router.get(
        "/gallery/directories/{directory_id}/entries",
        response_model=GalleryDirectoryPageResponse,
    )
    async def list_gallery_directory_entries(
        directory_id: str,
        view: Literal["desktop"] = "desktop",
        include_descendants: bool = Query(default=False),
        txt_state: str | None = Query(default=None),
        query: str | None = Query(default=None, max_length=256),
        directory_cursor: str | None = Query(default=None, max_length=512),
        asset_cursor: str | None = Query(default=None, max_length=512),
        limit: int = _PAGE_LIMITS,
        container: Any = Depends(get_service),
    ) -> Any:
        if txt_state is not None and txt_state not in TXT_STATES:
            raise ApiError(422, "invalid_txt_state", "未知的 TXT 状态筛选")
        try:
            result = container.db.gallery.list_directory_entries(
                directory_id=directory_id,
                include_descendants=include_descendants,
                txt_state=txt_state,
                query=query,
                directory_cursor=directory_cursor,
                asset_cursor=asset_cursor,
                limit=limit,
            )
        except GalleryCursorError:
            raise ApiError(422, "invalid_gallery_cursor", "分页游标无效") from None
        except ValueError as exc:
            message = str(exc)
            if "gallery_directory_not_found" in message:
                raise ApiError(404, "directory_not_found", "图库目录不存在") from None
            if "invalid_gallery_page_limit" in message:
                raise ApiError(422, "invalid_page_limit", "分页大小超出范围") from None
            raise ApiError(422, "invalid_gallery_request", "请求参数无效") from None
        _attach_source_roots(container, result, result["assets"])
        return result

    @router.get("/gallery/search", response_model=GallerySearchPageResponse)
    async def search_gallery_assets(
        query: str = Query(..., min_length=1, max_length=256),
        scope: Literal["directory", "source", "library"] = Query(...),
        view: Literal["desktop"] = "desktop",
        source_id: str | None = Query(default=None, max_length=128),
        directory_id: str | None = Query(default=None, max_length=128),
        include_descendants: bool = Query(default=False),
        txt_state: str | None = Query(default=None),
        asset_cursor: str | None = Query(default=None, max_length=512),
        limit: int = _PAGE_LIMITS,
        container: Any = Depends(get_service),
    ) -> Any:
        if txt_state is not None and txt_state not in TXT_STATES:
            raise ApiError(422, "invalid_txt_state", "未知的 TXT 状态筛选")
        try:
            result = container.db.gallery.search_assets(
                scope="gallery" if scope == "library" else scope,
                source_id=source_id,
                directory_id=directory_id,
                include_descendants=include_descendants,
                txt_state=txt_state,
                query=query,
                cursor=asset_cursor,
                limit=limit,
            )
        except GalleryCursorError:
            raise ApiError(422, "invalid_gallery_cursor", "分页游标无效") from None
        except ValueError as exc:
            code = str(exc)
            if code == "gallery_search_directory_required":
                raise ApiError(422, code, "当前目录搜索缺少目录") from None
            if code == "gallery_search_source_required":
                raise ApiError(422, code, "当前来源搜索缺少来源") from None
            if code == "gallery_search_query_required":
                raise ApiError(422, code, "搜索词不能为空") from None
            raise ApiError(422, "invalid_gallery_search", "搜索参数无效") from None
        result["scope"] = scope
        _attach_source_roots(container, result, result["assets"])
        return result


    # ---- §7.2 资产、TXT 与缩略图 ----

    @router.get(
        "/gallery/assets/{asset_id}", response_model=GalleryAssetEnvelopeResponse
    )
    async def get_gallery_asset(
        asset_id: str,
        view: Literal["desktop"] = "desktop",
        container: Any = Depends(get_service),
    ) -> Any:
        asset = container.db.gallery.get_asset(asset_id)
        if asset is None:
            raise _asset_not_found(asset_id)
        payload: dict[str, Any] = {"asset": asset}
        _attach_source_roots(container, payload, [asset])
        return payload

    @router.get(
        "/gallery/assets/{asset_id}/content",
        response_class=Response,
        responses={
            200: {
                "content": {
                    "image/jpeg": {},
                    "image/png": {},
                    "image/webp": {},
                    "application/octet-stream": {},
                },
                "description": "图片原文件",
            },
        },
    )
    async def get_gallery_asset_content(
        asset_id: str,
        container: Any = Depends(get_service),
    ) -> Any:
        catalog: GalleryCatalogService = container.gallery_catalog
        try:
            opened = catalog.open_asset_content(asset_id)
        except GalleryAssetNotFound:
            raise _asset_not_found(asset_id) from None
        except GalleryAssetFileError as error:
            status = 404 if error.code == "asset_file_missing" else 409
            raise ApiError(status, error.code, "图片文件当前不可安全读取") from None
        etag_source = (
            f"{asset_id}:{opened['modified_ns']}:{opened['size_bytes']}"
        )
        etag = 'W/"' + hashlib.sha1(etag_source.encode("utf-8")).hexdigest()[:24] + '"'

        def body():
            handle = opened["handle"]
            try:
                while chunk := handle.read(128 * 1024):
                    yield chunk
            finally:
                handle.close()

        return StreamingResponse(
            body(),
            media_type=_MEDIA_TYPES.get(opened["extension"], "application/octet-stream"),
            headers={
                "ETag": etag,
                "Cache-Control": "private, max-age=60",
                "Content-Length": str(opened["size_bytes"]),
            },
        )

    @router.get(
        "/gallery/assets/{asset_id}/thumbnail",
        response_class=Response,
        responses={200: {"content": {"image/jpeg": {}}, "description": "JPEG 缩略图"}},
    )
    async def get_gallery_asset_thumbnail(
        asset_id: str,
        size: int = Query(default=256),
        container: Any = Depends(get_service),
    ) -> Any:
        if size not in SUPPORTED_THUMBNAIL_SIZES:
            raise ApiError(422, "invalid_thumbnail_size", "缩略图尺寸只支持 256/512")
        resolved = _resolve_asset_file(container, asset_id)
        try:
            # Pillow 解码/缩放/编码是重同步操作（冷缓存可达数百毫秒），
            # 必须移出事件循环，否则一张缩略图会阻塞全部并发 API 响应。
            thumbnail = await asyncio.to_thread(
                container.gallery_thumbnails.thumbnail_response,
                source_root=resolved["source_root"],
                relative_path=resolved["relative_path"],
                asset_id=asset_id,
                modified_ns=resolved["modified_ns"],
                size=size,
            )
        except ThumbnailUnavailable as unavailable:
            if unavailable.code == "unsafe_source_path":
                raise ApiError(
                    409, "unsafe_source_path", "图片来源路径已变为链接或越界"
                ) from None
            raise ApiError(
                422,
                "thumbnail_unavailable",
                "缩略图生成失败",
                details={"reason": unavailable.code},
            ) from None
        return FileResponse(
            thumbnail["path"],
            media_type="image/jpeg",
            headers={
                "ETag": thumbnail["etag"],
                "Cache-Control": "private, max-age=3600",
            },
        )

    @router.get(
        "/gallery/assets/{asset_id}/annotation",
        response_model=GalleryAnnotationResponse,
    )
    async def get_gallery_asset_annotation(
        asset_id: str,
        view: Literal["desktop"] = "desktop",
        container: Any = Depends(get_service),
    ) -> Any:
        catalog: GalleryCatalogService = container.gallery_catalog
        try:
            return catalog.get_annotation(asset_id)
        except GalleryAssetNotFound:
            raise _asset_not_found(asset_id) from None
        except GallerySourceOffline:
            raise ApiError(409, "source_offline", "来源当前不可用") from None
        except GalleryAnnotationError as error:
            status = 409 if error.code == "unsafe_source_path" else 422
            raise ApiError(status, error.code, "TXT 文件当前不可安全读取") from None
    @router.put(
        "/gallery/assets/{asset_id}/annotation",
        response_model=GalleryAnnotationResponse,
    )
    async def put_gallery_asset_annotation(
        asset_id: str,
        request: GalleryAnnotationPutRequest,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        catalog: GalleryCatalogService = container.gallery_catalog
        try:
            result = catalog.save_annotation(
                asset_id,
                request.content,
                expected_txt_version=request.expected_txt_version,
                expected_disk_version=request.expected_disk_version,
            )
        except GalleryAssetNotFound:
            raise _asset_not_found(asset_id) from None
        except GalleryVersionConflict as conflict:
            if conflict.code == "asset_not_active":
                raise ApiError(
                    409,
                    "asset_not_active",
                    "资产已不在活跃状态",
                    details={"asset_id": asset_id},
                ) from None
            code = (
                "txt_disk_conflict"
                if conflict.code == "txt_disk_conflict"
                else "txt_version_conflict"
            )
            details = {
                "asset_id": asset_id,
                "expected_txt_version": request.expected_txt_version,
            }
            if code == "txt_disk_conflict":
                details["expected_disk_version"] = request.expected_disk_version
            raise ApiError(
                409,
                code,
                "TXT 已被外部修改，请重新加载后重试",
                details=details,
            ) from None
        except GallerySourceOffline:
            raise ApiError(
                409, "source_offline", "来源当前不可用，无法保存 TXT"
            ) from None
        except GalleryAnnotationError as error:
            if error.code == "unsafe_source_path":
                raise ApiError(409, error.code, "TXT 来源路径已变为链接或越界") from None
            if error.code == "txt_index_inconsistent":
                raise ApiError(500, error.code, "TXT 与索引一致性恢复失败") from None
            raise ApiError(422, error.code, "TXT 保存失败") from None
        return result
    @router.post(
        "/gallery/assets/{asset_id}/rename",
        response_model=GalleryFileOperationResponse,
    )
    async def rename_asset(
        asset_id: str,
        request: GalleryRenameRequest,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        engine: GalleryFileOperations = container.gallery_file_operations
        try:
            return engine.rename_asset(asset_id, request.new_stem)
        except GalleryFileOperationError as error:
            raise _file_operation_api_error(error, asset_id=asset_id) from None

    @router.post(
        "/gallery/file-operations/trash",
        response_model=GalleryFileOperationResponse,
    )
    async def trash_assets(
        request: GalleryTrashRequest,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        engine: GalleryFileOperations = container.gallery_file_operations
        try:
            return engine.trash_assets(
                request.asset_ids, request.directory_ids
            )
        except GalleryFileOperationError as error:
            raise _file_operation_api_error(
                error,
                asset_ids=request.asset_ids,
                directory_ids=request.directory_ids,
            ) from None
    @router.post(
        "/gallery/file-operations/{kind}",
        response_model=GalleryFileOperationResponse,
    )
    async def transfer_gallery_items(
        kind: Literal["move", "copy"],
        request: GalleryTransferRequest,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        engine: GalleryFileOperations = container.gallery_file_operations
        try:
            result = engine.move_or_copy(
                request.asset_ids,
                request.directory_ids,
                request.target_directory_id,
                kind=kind,
            )
            source_ids = result.get("source_ids", [])
            if len(source_ids) == 1:
                await asyncio.to_thread(container.gallery_catalog.scan_source, source_ids[0])
            return result
        except GalleryFileOperationError as error:
            raise _file_operation_api_error(
                error,
                asset_ids=request.asset_ids,
                directory_ids=request.directory_ids,
            ) from None


    @router.get("/gallery/trash", response_model=GalleryTrashPageResponse)
    async def list_trash(
        view: Literal["desktop"] = Query(...),
        cursor: str | None = Query(default=None),
        limit: int = Query(default=50, ge=1, le=200),
        container: Any = Depends(get_service),
    ) -> Any:
        engine: GalleryFileOperations = container.gallery_file_operations
        return engine.list_trash(cursor=cursor, limit=limit)

    @router.post(
        "/gallery/trash/{operation_id}/restore",
        response_model=GalleryFileOperationResponse,
    )
    async def restore_trash(
        operation_id: str,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        engine: GalleryFileOperations = container.gallery_file_operations
        try:
            return engine.restore_trash(operation_id)
        except GalleryFileOperationError as error:
            raise _file_operation_api_error(error, operation_id=operation_id) from None

    @router.post(
        "/gallery/file-operations/{operation_id}/undo",
        response_model=GalleryFileOperationResponse,
    )
    async def undo_trash(
        operation_id: str,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        engine: GalleryFileOperations = container.gallery_file_operations
        try:
            return engine.undo_trash(operation_id)
        except GalleryFileOperationError as error:
            raise _file_operation_api_error(error, operation_id=operation_id) from None

    @router.delete(
        "/gallery/trash/{operation_id}",
        response_model=GalleryFileOperationResponse,
    )
    async def purge_trash(
        operation_id: str,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        engine: GalleryFileOperations = container.gallery_file_operations
        try:
            return engine.purge_trash(operation_id)
        except GalleryFileOperationError as error:
            raise _file_operation_api_error(error, operation_id=operation_id) from None


    @router.delete(
        "/gallery/trash",
        response_model=GalleryPurgeAllTrashResponse,
    )
    async def purge_all_trash(
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        engine: GalleryFileOperations = container.gallery_file_operations
        try:
            return engine.purge_all_trash()
        except GalleryFileOperationError as error:
            raise _file_operation_api_error(error) from None


    # ---- Gallery-owned short-lived directory export ----

    @router.post(
        "/gallery/directory-exports",
        status_code=202,
        response_model=GalleryDirectoryExportOperationResponse,
    )
    async def start_gallery_directory_export(
        request: GalleryDirectoryExportRequest,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        idempotency_key = validate_idempotency_key(idempotency_key)
        service: GalleryDirectoryExportService = container.gallery_directory_exports
        try:
            return service.start(
                directory_ids=request.directory_ids,
                target_path=request.target_path,
                idempotency_key=idempotency_key,
            )
        except GalleryDirectoryExportError as error:
            raise _directory_export_api_error(error) from None

    @router.get(
        "/gallery/directory-exports/{operation_id}",
        response_model=GalleryDirectoryExportOperationResponse,
    )
    async def get_gallery_directory_export(
        operation_id: GalleryDirectoryExportId,
        view: Literal["desktop"] = Query(...),
        container: Any = Depends(get_service),
    ) -> Any:
        service: GalleryDirectoryExportService = container.gallery_directory_exports
        try:
            return service.get(operation_id)
        except GalleryDirectoryExportError as error:
            raise _directory_export_api_error(error) from None

    @router.delete(
        "/gallery/directory-exports/{operation_id}",
        response_model=GalleryDirectoryExportOperationResponse,
    )
    async def cancel_gallery_directory_export(
        operation_id: GalleryDirectoryExportId,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        service: GalleryDirectoryExportService = container.gallery_directory_exports
        try:
            return service.cancel(operation_id)
        except GalleryDirectoryExportError as error:
            raise _directory_export_api_error(error) from None


    return router


def _attach_source_roots(
    container: Any, payload: dict[str, Any], assets: list[dict[str, Any]]
) -> None:
    """为桌面端补充 source_id -> 绝对根目录映射，供 WebView asset 协议直读原图。

    只读路径解析；来源已删除时跳过该来源（前端自动回退到 HTTP content 路由）。
    """
    catalog: GalleryCatalogService = container.gallery_catalog
    roots: dict[str, str] = {}
    for asset in assets:
        source_id = asset.get("source_id")
        if source_id is None or source_id in roots:
            continue
        try:
            roots[source_id] = str(catalog.resolve_source_root(source_id))
        except GallerySourceNotFound:
            continue
    payload["source_roots"] = roots


def _resolve_asset_file(container: Any, asset_id: str) -> dict[str, Any]:
    """Resolve indexed metadata; filesystem access remains in safe domain services."""
    asset = container.db.gallery.get_asset(asset_id)
    if asset is None:
        raise _asset_not_found(asset_id)
    catalog: GalleryCatalogService = container.gallery_catalog
    source_root = catalog.resolve_source_root(asset["source_id"])
    return {
        "source_root": source_root,
        "relative_path": asset["relative_path"],
        "extension": asset["extension"].lower(),
        "modified_ns": asset["modified_ns"],
    }
