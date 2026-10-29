"""数据集导出 API：预览计划、开始导出、查进度、取消与续传。

服务见 dataset_export；所有请求和响应都声明 pydantic 模型，前端从 OpenAPI 生成类型。
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, ConfigDict, Field

from ..dataset_service import DatasetError
from .datasets import _api_error
from .dependencies import get_service


ExportLayout = Literal["kohya", "flat"]
ExportRename = Literal["none", "sequential"]
ExportStatus = Literal["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]

_Tag = Annotated[str, Field(min_length=1, max_length=200)]


# ---- 请求 ----


class DatasetExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_path: str = Field(min_length=1, max_length=4096)
    layout: ExportLayout = "kohya"
    repeats: int = Field(default=10, ge=1, le=10000)
    trigger_word: str | None = Field(default=None, max_length=120)
    folder_name: str | None = Field(default=None, max_length=120)
    rename: ExportRename = "none"
    include_captions: bool = True
    pin_trigger: bool = True
    tag_blacklist: list[_Tag] = Field(default_factory=list, max_length=500)
    underscore_to_space: bool = False
    dry_run: bool = False


# ---- 响应 ----


class DatasetExportOptionsResponse(BaseModel):
    target_path: str
    layout: ExportLayout
    repeats: int
    trigger_word: str
    folder_name: str
    rename: ExportRename
    include_captions: bool
    pin_trigger: bool
    tag_blacklist: list[str]
    underscore_to_space: bool


class DatasetExportCollisionResponse(BaseModel):
    asset_id: str
    name: str
    output_name: str


class DatasetExportBlockerResponse(BaseModel):
    code: Literal["source_offline", "caption_unreadable"]
    count: int = Field(ge=0)
    ids: list[str]


class DatasetExportPlanItemResponse(BaseModel):
    asset_id: str
    name: str
    source_relative_path: str
    output_relative_path: str
    caption_output_relative_path: str | None
    caption_preview: str
    size_bytes: int = Field(ge=0)


class DatasetExportPlanResponse(BaseModel):
    dataset_id: str
    layout: ExportLayout
    folder_name: str
    target_path: str
    output_path: str
    target_exists: bool
    options: DatasetExportOptionsResponse
    image_count: int = Field(ge=0)
    caption_count: int = Field(ge=0)
    image_bytes: int = Field(ge=0)
    txt_bytes: int = Field(ge=0)
    total_bytes: int = Field(ge=0)
    collision_count: int = Field(ge=0)
    collisions: list[DatasetExportCollisionResponse]
    blockers: list[DatasetExportBlockerResponse]
    items: list[DatasetExportPlanItemResponse]


class DatasetExportJobResponse(BaseModel):
    export_id: str
    dataset_id: str
    status: ExportStatus
    target_path: str
    folder_name: str
    output_path: str
    options: DatasetExportOptionsResponse
    total_items: int = Field(ge=0)
    staged_items: int = Field(ge=0)
    image_bytes: int = Field(ge=0)
    txt_bytes: int = Field(ge=0)
    total_bytes: int = Field(ge=0)
    copied_bytes: int = Field(ge=0)
    error_code: str | None
    error_details: dict[str, Any] | None
    resumable: bool
    job_id: str
    created_at: float
    updated_at: float
    started_at: float | None
    finished_at: float | None


class DatasetExportStartResponse(BaseModel):
    dry_run: bool
    plan: DatasetExportPlanResponse | None
    job: DatasetExportJobResponse | None


class DatasetExportListResponse(BaseModel):
    items: list[DatasetExportJobResponse]


def _service(container: Any) -> Any:
    return container.dataset_exports


async def _call(function, *args, **kwargs):
    try:
        return await asyncio.to_thread(function, *args, **kwargs)
    except DatasetError as error:
        raise _api_error(error) from None


def create_dataset_exports_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.post(
        "/datasets/{dataset_id}/exports",
        status_code=202,
        response_model=DatasetExportStartResponse,
        responses={200: {"model": DatasetExportStartResponse, "description": "dry_run：只返回计划预览"}},
    )
    async def create_dataset_export(
        dataset_id: str,
        body: DatasetExportRequest,
        container: Any = Depends(get_service),
    ) -> Any:
        """导出 export 阶段的输出。dry_run=true 时只算计划（目标路径、数量、冲突、总字节）。"""
        options = body.model_dump(exclude={"dry_run"})
        if body.dry_run:
            plan = await _call(_service(container).preview, dataset_id, options)
            content = DatasetExportStartResponse(dry_run=True, plan=plan, job=None)
            return JSONResponse(status_code=200, content=jsonable_encoder(content))
        job = await _call(_service(container).start, dataset_id, options)
        return {"dry_run": False, "plan": None, "job": job}

    @router.get("/datasets/{dataset_id}/exports", response_model=DatasetExportListResponse)
    async def list_dataset_exports(
        dataset_id: str,
        limit: int = Query(default=50, ge=1, le=200),
        container: Any = Depends(get_service),
    ) -> Any:
        return {"items": await _call(_service(container).list_exports, dataset_id, limit=limit)}

    @router.get("/exports/{export_id}", response_model=DatasetExportJobResponse)
    async def get_dataset_export(export_id: str, container: Any = Depends(get_service)) -> Any:
        return await _call(_service(container).get, export_id)

    @router.post("/exports/{export_id}/cancel", response_model=DatasetExportJobResponse)
    async def cancel_dataset_export(export_id: str, container: Any = Depends(get_service)) -> Any:
        return await _call(_service(container).cancel, export_id)

    @router.post("/exports/{export_id}/resume", status_code=202, response_model=DatasetExportJobResponse)
    async def resume_dataset_export(export_id: str, container: Any = Depends(get_service)) -> Any:
        """续传中断的导出（或目标名字被占用而失败、腾出名字后的导出）。"""
        return await _call(_service(container).resume, export_id)

    return router


__all__ = ["create_dataset_exports_router"]
