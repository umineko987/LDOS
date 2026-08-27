"""数据集导出 API 路由（§7.4）。

- 任务创建与查询；`view=desktop` 有界投影；
- 状态机操作：start/pause/resume/discard；
- 预检阻断清单只含稳定分类与安全相对路径（§8.2）。
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, Field

from ..dataset_export_manager import DatasetExportError, DatasetExportManager

from .dependencies import get_service
from .errors import ApiError
from .validation import validate_idempotency_key


class ExportSelection(BaseModel):
    source_id: str = Field(min_length=1, max_length=128)
    directory_id: str = Field(min_length=1, max_length=128)
    include_descendants: bool = False
    output_alias: str = Field(min_length=1, max_length=200)


class DatasetExportCreateRequest(BaseModel):
    target_path: str = Field(min_length=1, max_length=4096)
    selections: list[ExportSelection] = Field(min_length=1, max_length=50)


_EXPORT_ERROR_STATUS: dict[str, int] = {
    "export_not_found": 404,
    "export_state_invalid": 409,
    "export_target_conflict": 409,
    "export_disk_space_insufficient": 409,
    "export_snapshot_stale": 409,
    "source_not_found": 404,
    "source_offline": 409,
    "invalid_export_alias": 422,
    "preflight_blocked": 422,
    "txt_missing": 422,
    "txt_empty": 422,
    "txt_invalid_encoding": 422,
}


def _export_api_error(error: DatasetExportError) -> ApiError:
    status = _EXPORT_ERROR_STATUS.get(error.code, 500)
    return ApiError(
        status, error.code, "数据集导出操作失败", details=dict(error.detail)
    )


def _public_job(job: dict[str, Any]) -> dict[str, Any]:
    """desktop 投影：剥离 target_path 绝对路径，只保留任务摘要。"""
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "sample_count": job["sample_count"],
        "image_bytes": job["image_bytes"],
        "txt_bytes": job["txt_bytes"],
        "snapshot_digest": job["snapshot_digest"],
        "error_class": job["error_class"],
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
        "started_at": job["started_at"],
        "finished_at": job["finished_at"],
    }


def create_dataset_exports_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    # ---- §7.4 任务创建与查询 ----

    @router.post("/dataset-exports", status_code=201)
    async def create_dataset_export(
        request: DatasetExportCreateRequest,
        container: Any = Depends(get_service),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> Any:
        validate_idempotency_key(idempotency_key)
        manager: DatasetExportManager = container.dataset_export_manager
        try:
            job = manager.create_export(
                target_path=request.target_path,
                selections=[s.model_dump() for s in request.selections],
                idempotency_key=idempotency_key,
            )
        except DatasetExportError as error:
            raise _export_api_error(error) from None
        except ValueError as error:
            raise ApiError(422, "invalid_export_alias", "输出别名不合法") from None
        # 创建后立即同步预检（draft → preflighting → blocked|ready）。
        try:
            result = manager.preflight(job["job_id"])
        except DatasetExportError as error:
            raise _export_api_error(error) from None
        if result.get("status") == "blocked":
            blocked_job = manager.get_job(job["job_id"]) or {}
            return {"job": _public_job(blocked_job), "blockers": result["blockers"]}
        ready_job = manager.get_job(job["job_id"]) or {}
        return _public_job(ready_job)

    @router.get("/dataset-exports")
    async def list_dataset_exports(
        view: Literal["desktop"] = "desktop",
        status: str | None = Query(default=None, max_length=32),
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        container: Any = Depends(get_service),
    ) -> Any:
        manager: DatasetExportManager = container.dataset_export_manager
        jobs = manager.list_jobs(status=status, limit=limit, offset=offset)
        return {"jobs": [_public_job(j) for j in jobs]}

    @router.get("/dataset-exports/{export_id}")
    async def get_dataset_export(
        export_id: str,
        view: Literal["desktop"] = "desktop",
        container: Any = Depends(get_service),
    ) -> Any:
        manager: DatasetExportManager = container.dataset_export_manager
        job = manager.get_job(export_id)
        if job is None:
            raise ApiError(404, "export_not_found", "导出任务不存在")
        result = _public_job(job)
        result["sources"] = manager.list_sources(export_id)
        return result

    @router.get("/dataset-exports/{export_id}/blockers")
    async def list_dataset_export_blockers(
        export_id: str,
        view: Literal["desktop"] = "desktop",
        container: Any = Depends(get_service),
    ) -> Any:
        manager: DatasetExportManager = container.dataset_export_manager
        try:
            return manager.list_blockers(export_id)
        except DatasetExportError as error:
            raise _export_api_error(error) from None

    # ---- §7.4 状态机操作 ----

    @router.post("/dataset-exports/{export_id}/start")
    async def start_dataset_export(
        export_id: str,
        container: Any = Depends(get_service),
    ) -> Any:
        manager: DatasetExportManager = container.dataset_export_manager
        try:
            return _public_job(manager.start(export_id))
        except DatasetExportError as error:
            raise _export_api_error(error) from None

    @router.post("/dataset-exports/{export_id}/pause")
    async def pause_dataset_export(
        export_id: str,
        container: Any = Depends(get_service),
    ) -> Any:
        manager: DatasetExportManager = container.dataset_export_manager
        try:
            return _public_job(manager.pause(export_id))
        except DatasetExportError as error:
            raise _export_api_error(error) from None

    @router.post("/dataset-exports/{export_id}/resume")
    async def resume_dataset_export(
        export_id: str,
        container: Any = Depends(get_service),
    ) -> Any:
        manager: DatasetExportManager = container.dataset_export_manager
        try:
            return _public_job(manager.resume(export_id))
        except DatasetExportError as error:
            raise _export_api_error(error) from None

    @router.post("/dataset-exports/{export_id}/discard")
    async def discard_dataset_export(
        export_id: str,
        container: Any = Depends(get_service),
    ) -> Any:
        manager: DatasetExportManager = container.dataset_export_manager
        try:
            return _public_job(manager.discard(export_id))
        except DatasetExportError as error:
            raise _export_api_error(error) from None

    return router
