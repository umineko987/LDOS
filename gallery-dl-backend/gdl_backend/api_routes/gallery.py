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
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from .._database_gallery_repository import (
    GalleryCursorError,
    GallerySourceConflictError,
    GalleryVersionConflict,
)
from ..gallery_catalog import TXT_STATES
from ..gallery_service import (
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
    asset_ids: list[str] = Field(min_length=1, max_length=2000)

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
    "invalid_operation_kind": 500,
}


def _file_operation_api_error(
    error: GalleryFileOperationError,
    *,
    asset_id: str | None = None,
    asset_ids: list[str] | None = None,
    operation_id: str | None = None,
) -> ApiError:
    status = _FILE_OPERATION_ERROR_STATUS.get(error.code, 500)
    details: dict[str, Any] = dict(error.details)
    if asset_id is not None:
        details.setdefault("asset_id", asset_id)
    if asset_ids is not None:
        details.setdefault("asset_ids", asset_ids)
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

    @router.get("/gallery/sources")
    async def list_gallery_sources(
        view: Literal["desktop"] = "desktop",
        container: Any = Depends(get_service),
    ) -> Any:
        catalog: GalleryCatalogService = container.gallery_catalog
        return {"sources": catalog.list_sources()}

    @router.get("/gallery/sources/{source_id}")
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

    @router.post("/gallery/imports", status_code=201)
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

    @router.patch("/gallery/sources/{source_id}")
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

    @router.delete("/gallery/sources/{source_id}")
    async def delete_gallery_source(
        source_id: str,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        catalog: GalleryCatalogService = container.gallery_catalog
        try:
            catalog.unregister_source(source_id)
        except GallerySourceNotFound:
            raise _source_not_found(source_id) from None
        except GalleryScanInProgress:
            raise ApiError(
                409, "source_scan_in_progress", "来源正在扫描，稍后再解除"
            ) from None
        return {"source_id": source_id, "removed": True}

    @router.post("/gallery/sources/{source_id}/relink")
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

    @router.post("/gallery/sources/{source_id}/scan", status_code=202)
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

    @router.get("/gallery/sources/{source_id}/scan")
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
        "/gallery/sources/{source_id}/reconciliation/retry", status_code=202
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

    @router.get("/gallery/directories/{directory_id}/entries")
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
            return container.db.gallery.list_directory_entries(
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

    @router.get("/gallery/search")
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
        return result


    # ---- §7.2 资产、TXT 与缩略图 ----

    @router.get("/gallery/assets/{asset_id}")
    async def get_gallery_asset(
        asset_id: str,
        view: Literal["desktop"] = "desktop",
        container: Any = Depends(get_service),
    ) -> Any:
        asset = container.db.gallery.get_asset(asset_id)
        if asset is None:
            raise _asset_not_found(asset_id)
        return {"asset": asset}

    @router.get("/gallery/assets/{asset_id}/content")
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

    @router.get("/gallery/assets/{asset_id}/thumbnail")
    async def get_gallery_asset_thumbnail(
        asset_id: str,
        size: int = Query(default=256),
        container: Any = Depends(get_service),
    ) -> Any:
        if size not in SUPPORTED_THUMBNAIL_SIZES:
            raise ApiError(422, "invalid_thumbnail_size", "缩略图尺寸只支持 256/512")
        resolved = _resolve_asset_file(container, asset_id)
        try:
            thumbnail = container.gallery_thumbnails.thumbnail_response(
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

    @router.get("/gallery/assets/{asset_id}/annotation")
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
    @router.put("/gallery/assets/{asset_id}/annotation")
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
    @router.post("/gallery/assets/{asset_id}/rename")
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

    @router.post("/gallery/file-operations/trash")
    async def trash_assets(
        request: GalleryTrashRequest,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        engine: GalleryFileOperations = container.gallery_file_operations
        try:
            return engine.trash_assets(request.asset_ids)
        except GalleryFileOperationError as error:
            raise _file_operation_api_error(error, asset_ids=request.asset_ids) from None

    @router.get("/gallery/trash")
    async def list_trash(
        view: Literal["desktop"] = Query(...),
        cursor: str | None = Query(default=None),
        limit: int = Query(default=50, ge=1, le=200),
        container: Any = Depends(get_service),
    ) -> Any:
        engine: GalleryFileOperations = container.gallery_file_operations
        return engine.list_trash(cursor=cursor, limit=limit)

    @router.post("/gallery/trash/{operation_id}/restore")
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

    @router.post("/gallery/file-operations/{operation_id}/undo")
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

    @router.delete("/gallery/trash/{operation_id}")
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


    @router.delete("/gallery/trash")
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

    @router.post("/gallery/directory-exports", status_code=202)
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

    @router.get("/gallery/directory-exports/{operation_id}")
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

    @router.delete("/gallery/directory-exports/{operation_id}")
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
