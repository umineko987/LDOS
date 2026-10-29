"""数据集清洗 / 去重阶段 API：运行、读分组、逐组定夺、撤销。

服务见 dataset_triage；所有请求和响应都声明 pydantic 模型，前端从 OpenAPI 生成类型。
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from ..dataset_service import DatasetError
from .datasets import DatasetStageRunResponse, _api_error
from .dependencies import get_service


TriageStage = Literal["clean", "dedup"]
TriageState = Literal["all", "pending", "decided"]
TriageReviewStatus = Literal["pending", "analyzing", "auto_applying", "ready", "failed", "expired"]
CleanReason = Literal["monochrome", "rough", "filter_character", "unreadable"]
DedupGroupKind = Literal["duplicate", "unreadable", "auto_exact", "auto_compression"]
TriageDisposition = Literal["pending", "kept", "rejected", "failed"]

_Id = Annotated[str, Field(min_length=1, max_length=128)]


# ---- 请求 ----


class StageRunOptions(BaseModel):
    """覆盖预设里的单项；没给的沿用预设。清洗会强制关掉去重和分组，去重会强制关掉过滤器。"""

    model_config = ConfigDict(extra="forbid")
    basic_dedup: StrictBool | None = None
    similarity_groups: StrictBool | None = None
    filter_monochrome: StrictBool | None = None
    filter_sketch: StrictBool | None = None
    filter_character: StrictBool | None = None
    reference_asset_ids: list[_Id] | None = Field(default=None, max_length=200)


class StageRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preset_id: _Id | None = None
    options: StageRunOptions | None = None


class TriageGroupDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    group_id: str = Field(min_length=1, max_length=200)
    keep: list[_Id] = Field(default_factory=list, max_length=500)


class TriageApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: _Id
    groups: list[TriageGroupDecision] = Field(min_length=1, max_length=200)


class TriageUndoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    batch_id: _Id | None = None


# ---- 响应 ----


class StageTriageCountsResponse(BaseModel):
    input: int = Field(ge=0)
    groups: int = Field(ge=0)
    pending_groups: int = Field(ge=0)
    decided_groups: int = Field(ge=0)
    flagged: int = Field(ge=0)
    automatic_excluded: int = Field(ge=0)
    kept: int = Field(ge=0)
    rejected: int = Field(ge=0)
    failed: int = Field(ge=0)


class StageTriageSummaryResponse(BaseModel):
    dataset_id: str
    stage: TriageStage
    run: DatasetStageRunResponse | None
    review_id: str | None
    review_status: TriageReviewStatus | None
    review_error: str
    counts: StageTriageCountsResponse
    undo_depth: int = Field(ge=0)
    last_batch_id: str | None


class TriageQualityResponse(BaseModel):
    sharpness: float | None = None
    blockiness: float | None = None
    noise_sigma: float | None = None
    jpeg_quality: float | None = None


class TriageMemberResponse(BaseModel):
    asset_id: str
    source_id: str
    name: str
    relative_path: str
    thumbnail_url: str
    image_url: str
    width: int = Field(ge=0)
    height: int = Field(ge=0)
    size_bytes: int = Field(ge=0)
    format: str
    readable: bool
    recommended: bool
    selected: bool
    disposition: TriageDisposition
    trashed: bool
    classification: Literal["rough", "monochrome"] | None
    quality: TriageQualityResponse
    review_metrics: dict[str, Any] | None
    decision: Literal["exclude", "approve"] | None
    error: str


class DedupGroupResponse(BaseModel):
    group_id: str
    kind: DedupGroupKind
    automatic: bool
    decided: bool
    match_levels: list[str]
    reason: str
    suggested_keep: list[str]
    winner_asset_id: str | None
    members: list[TriageMemberResponse]


class DedupGroupPageResponse(BaseModel):
    run_id: str
    review_id: str
    total: int = Field(ge=0)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1)
    items: list[DedupGroupResponse]


class CleanItemResponse(TriageMemberResponse):
    group_id: str
    group_kind: str
    automatic: bool
    decided: bool
    reasons: list[CleanReason]


class CleanItemPageResponse(BaseModel):
    run_id: str
    review_id: str
    total: int = Field(ge=0)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1)
    items: list[CleanItemResponse]


class TriageFailedAssetResponse(BaseModel):
    asset_id: str
    error: str


class TriageBatchErrorResponse(BaseModel):
    group_id: str
    code: str
    message: str


class TriageApplyResponse(BaseModel):
    batch_id: str | None
    applied_groups: int = Field(ge=0)
    kept: list[str]
    rejected: list[str]
    failed: list[TriageFailedAssetResponse]
    error: TriageBatchErrorResponse | None
    summary: StageTriageSummaryResponse


class TriageUndoResponse(BaseModel):
    batch_id: str
    undone_groups: int = Field(ge=0)
    error: TriageBatchErrorResponse | None
    summary: StageTriageSummaryResponse


def _service(container: Any) -> Any:
    return container.dataset_triage


async def _call(function, *args, **kwargs):
    try:
        return await asyncio.to_thread(function, *args, **kwargs)
    except DatasetError as error:
        raise _api_error(error) from None


def create_dataset_stages_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.post(
        "/datasets/{dataset_id}/stages/{stage}/run",
        status_code=202,
        response_model=StageTriageSummaryResponse,
    )
    async def run_dataset_stage(
        dataset_id: str,
        stage: TriageStage,
        body: StageRunRequest | None = None,
        container: Any = Depends(get_service),
    ) -> Any:
        """对这一段的全部输入建一次图库审核（清洗：只过滤；去重：基础去重 + 相似分组）。"""
        body = body or StageRunRequest()
        options = body.options.model_dump(exclude_none=True) if body.options is not None else None
        return await _call(
            _service(container).run, dataset_id, stage, preset_id=body.preset_id, options=options
        )

    @router.get(
        "/datasets/{dataset_id}/stages/{stage}/triage",
        response_model=StageTriageSummaryResponse,
    )
    async def get_dataset_stage_triage(
        dataset_id: str, stage: TriageStage, container: Any = Depends(get_service)
    ) -> Any:
        return await _call(_service(container).summary, dataset_id, stage)

    @router.get(
        "/datasets/{dataset_id}/stages/dedup/groups",
        response_model=DedupGroupPageResponse,
    )
    async def list_dataset_dedup_groups(
        dataset_id: str,
        state: TriageState = "all",
        include_automatic: bool = True,
        offset: int = Query(default=0, ge=0),
        limit: int = Query(default=50, ge=1, le=100),
        container: Any = Depends(get_service),
    ) -> Any:
        return await _call(
            _service(container).dedup_groups,
            dataset_id,
            state=state,
            include_automatic=include_automatic,
            offset=offset,
            limit=limit,
        )

    @router.get(
        "/datasets/{dataset_id}/stages/clean/items",
        response_model=CleanItemPageResponse,
    )
    async def list_dataset_clean_items(
        dataset_id: str,
        state: TriageState = "all",
        reason: CleanReason | None = None,
        offset: int = Query(default=0, ge=0),
        limit: int = Query(default=100, ge=1, le=200),
        container: Any = Depends(get_service),
    ) -> Any:
        return await _call(
            _service(container).clean_items,
            dataset_id,
            state=state,
            reason=reason,
            offset=offset,
            limit=limit,
        )

    @router.post(
        "/datasets/{dataset_id}/stages/{stage}/apply",
        response_model=TriageApplyResponse,
    )
    async def apply_dataset_stage_triage(
        dataset_id: str,
        stage: TriageStage,
        body: TriageApplyRequest,
        container: Any = Depends(get_service),
    ) -> Any:
        """逐组定夺：keep 保留并记「通过」，其余移入回收区并记「排除」。"""
        return await _call(
            _service(container).apply,
            dataset_id,
            stage,
            run_id=body.run_id,
            groups=[group.model_dump() for group in body.groups],
        )

    @router.post(
        "/datasets/{dataset_id}/stages/{stage}/undo",
        response_model=TriageUndoResponse,
    )
    async def undo_dataset_stage_triage(
        dataset_id: str,
        stage: TriageStage,
        body: TriageUndoRequest | None = None,
        container: Any = Depends(get_service),
    ) -> Any:
        """撤销最近一批定夺。"""
        body = body or TriageUndoRequest()
        return await _call(_service(container).undo, dataset_id, stage, batch_id=body.batch_id)

    return router


__all__ = ["create_dataset_stages_router"]
