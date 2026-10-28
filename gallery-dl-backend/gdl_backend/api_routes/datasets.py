"""数据集 API（schema v15）：数据集、根目录、成员、决定、漏斗、在线采集。

所有请求和响应都声明了 pydantic 模型；新前端从 OpenAPI 生成类型。
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .._database_dataset_repository import (
    MEMBER_PAGE_DEFAULT_LIMIT,
    MEMBER_PAGE_MAX_LIMIT,
    DatasetCursorError,
)
from ..dataset_service import DatasetError, DatasetService
from ..schemas import CrawlRequest
from .crawls import _perform_crawl
from .dependencies import get_service
from .errors import ApiError


DatasetKind = Literal["character", "style", "concept"]
DatasetStage = Literal["collect", "clean", "dedup", "tag", "review", "export"]
DatasetStageRunStatus = Literal["running", "succeeded", "failed", "cancelled"]
DatasetStageStatus = Literal["idle", "running", "succeeded", "failed", "cancelled"]
DatasetRootOrigin = Literal["import", "library", "crawl"]
DatasetDecision = Literal["exclude", "approve"]
DatasetMemberDecisionFilter = Literal["excluded", "approved", "undecided"]
DatasetCrawlState = Literal["pending", "attached", "failed"]

_Id = Annotated[str, Field(min_length=1, max_length=128)]


def _strip_required(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("不能为空")
    return value


# ---- 请求 ----


class DatasetCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    kind: DatasetKind = "character"
    trigger_word: str = Field(default="", max_length=120)
    config: dict[str, Any] = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return _strip_required(value)


class DatasetPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=120)
    kind: DatasetKind | None = None
    trigger_word: str | None = Field(default=None, max_length=120)
    config: dict[str, Any] | None = None
    # 显式传 null 表示恢复成「自动选第一张」。
    cover_asset_id: str | None = Field(default=None, max_length=128)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        return None if value is None else _strip_required(value)

    def changes(self) -> dict[str, Any]:
        provided = self.model_dump(exclude_unset=True)
        return {
            key: value
            for key, value in provided.items()
            if value is not None or key == "cover_asset_id"
        }


class DatasetRootCreateRequest(BaseModel):
    """三选一：已有图库目录、整个图库来源，或者本机文件夹路径（导入）。"""

    model_config = ConfigDict(extra="forbid")
    directory_id: str | None = Field(default=None, min_length=1, max_length=128)
    source_id: str | None = Field(default=None, min_length=1, max_length=128)
    path: str | None = Field(default=None, min_length=1, max_length=4096)
    display_name: str | None = Field(default=None, min_length=1, max_length=255)

    @model_validator(mode="after")
    def _exactly_one(self) -> "DatasetRootCreateRequest":
        chosen = [name for name in ("directory_id", "source_id", "path") if getattr(self, name)]
        if len(chosen) != 1:
            raise ValueError("directory_id、source_id、path 必须且只能提供一个")
        if self.display_name is not None and self.path is None:
            raise ValueError("display_name 只用于从文件夹导入")
        return self


class DatasetDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stage: DatasetStage
    asset_ids: list[_Id] = Field(min_length=1, max_length=5000)
    decision: Literal["exclude", "approve", "clear"]
    reason: str = Field(default="", max_length=500)


# ---- 响应 ----


class DatasetStageRunResponse(BaseModel):
    run_id: str
    dataset_id: str
    stage: DatasetStage
    status: DatasetStageRunStatus
    ref_id: str
    input_digest: str
    stats: dict[str, Any]
    error_code: str
    created_at: float
    updated_at: float
    finished_at: float | None


class DatasetStageRunListResponse(BaseModel):
    items: list[DatasetStageRunResponse]


class DatasetFunnelStageResponse(BaseModel):
    stage: DatasetStage
    input: int = Field(ge=0)
    excluded: int = Field(ge=0)
    approved: int = Field(ge=0)
    output: int = Field(ge=0)
    input_digest: str
    status: DatasetStageStatus
    stale: bool
    last_run: DatasetStageRunResponse | None


class DatasetFunnelResponse(BaseModel):
    dataset_id: str
    member_count: int = Field(ge=0)
    stages: list[DatasetFunnelStageResponse]


class DatasetStageOutputResponse(BaseModel):
    stage: DatasetStage
    output: int = Field(ge=0)
    stale: bool


class DatasetSummaryResponse(BaseModel):
    dataset_id: str
    name: str
    kind: DatasetKind
    trigger_word: str
    config: dict[str, Any]
    cover_asset_id: str | None
    cover_thumbnail_url: str | None
    member_count: int = Field(ge=0)
    output_count: int = Field(ge=0)
    root_count: int = Field(ge=0)
    stage_outputs: list[DatasetStageOutputResponse]
    created_at: float
    updated_at: float


class DatasetDetailResponse(DatasetSummaryResponse):
    funnel: list[DatasetFunnelStageResponse]


class DatasetListResponse(BaseModel):
    items: list[DatasetSummaryResponse]


class DatasetRootResponse(BaseModel):
    root_id: str
    dataset_id: str
    source_id: str
    directory_id: str
    relative_path: str
    origin: DatasetRootOrigin
    name: str
    source_display_name: str
    source_kind: str
    # 来源在线且目录已扫描进索引；导入后扫描完成前为 false。
    available: bool
    recursive_asset_count: int = Field(ge=0)
    created_at: float


class DatasetRootListResponse(BaseModel):
    items: list[DatasetRootResponse]


class DatasetMemberDecisionResponse(BaseModel):
    stage: DatasetStage
    decision: DatasetDecision
    reason: str


class DatasetMemberResponse(BaseModel):
    asset_id: str
    source_id: str
    directory_id: str
    relative_path: str
    name: str
    format: str
    width: int = Field(ge=0)
    height: int = Field(ge=0)
    size_bytes: int = Field(ge=0)
    content_sha256: str
    txt_state: Literal["normal", "missing", "blank", "invalid_encoding", "pair_conflict", "io_error"]
    lifecycle_state: Literal["active", "missing", "trashed"]
    dedup_visibility: Literal["candidate", "kept", "excluded"]
    thumbnail_url: str
    decisions: list[DatasetMemberDecisionResponse]


class DatasetMemberPageResponse(BaseModel):
    items: list[DatasetMemberResponse]
    next_cursor: str | None
    total: int = Field(ge=0)
    limit: int = Field(ge=1)


class DatasetDecisionResponse(BaseModel):
    updated: int = Field(ge=0)
    funnel: DatasetFunnelResponse


class DatasetHashingResponse(BaseModel):
    member_count: int = Field(ge=0)
    hashed_count: int = Field(ge=0)
    # 整个哈希队列里还没算完的张数（不只这个数据集）。
    pending: int = Field(ge=0)


class DatasetCrawlResponse(BaseModel):
    dataset_id: str
    batch_id: str
    state: DatasetCrawlState
    root_id: str | None
    error_code: str
    batch_status: str | None
    created_at: float
    updated_at: float


class DatasetCrawlListResponse(BaseModel):
    items: list[DatasetCrawlResponse]


def _service(container: Any) -> DatasetService:
    return container.datasets


def _api_error(error: DatasetError) -> ApiError:
    return ApiError(error.status, error.code, error.message, details=error.details or None)


async def _call(function, *args, **kwargs):
    try:
        return await asyncio.to_thread(function, *args, **kwargs)
    except DatasetError as error:
        raise _api_error(error) from None
    except DatasetCursorError:
        raise ApiError(422, "invalid_dataset_cursor", "分页游标无效") from None


def create_datasets_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get("/datasets", response_model=DatasetListResponse)
    async def list_datasets(container: Any = Depends(get_service)) -> Any:
        return {"items": await _call(_service(container).list_summaries)}

    @router.post("/datasets", status_code=201, response_model=DatasetDetailResponse)
    async def create_dataset(
        request: DatasetCreateRequest, container: Any = Depends(get_service)
    ) -> Any:
        return await _call(
            _service(container).create,
            name=request.name,
            kind=request.kind,
            trigger_word=request.trigger_word,
            config=request.config,
        )

    @router.get("/datasets/{dataset_id}", response_model=DatasetDetailResponse)
    async def get_dataset(dataset_id: str, container: Any = Depends(get_service)) -> Any:
        return await _call(_service(container).detail, dataset_id)

    @router.patch("/datasets/{dataset_id}", response_model=DatasetDetailResponse)
    async def patch_dataset(
        dataset_id: str,
        request: DatasetPatchRequest,
        container: Any = Depends(get_service),
    ) -> Any:
        return await _call(_service(container).update, dataset_id, request.changes())

    @router.delete("/datasets/{dataset_id}", status_code=204)
    async def delete_dataset(dataset_id: str, container: Any = Depends(get_service)) -> Response:
        await _call(_service(container).delete, dataset_id)
        return Response(status_code=204)

    @router.get("/datasets/{dataset_id}/funnel", response_model=DatasetFunnelResponse)
    async def get_dataset_funnel(dataset_id: str, container: Any = Depends(get_service)) -> Any:
        return await _call(_service(container).funnel, dataset_id)

    @router.get("/datasets/{dataset_id}/roots", response_model=DatasetRootListResponse)
    async def list_dataset_roots(dataset_id: str, container: Any = Depends(get_service)) -> Any:
        return {"items": await _call(_service(container).list_roots, dataset_id)}

    @router.post(
        "/datasets/{dataset_id}/roots", status_code=201, response_model=DatasetRootResponse
    )
    async def add_dataset_root(
        dataset_id: str,
        request: DatasetRootCreateRequest,
        container: Any = Depends(get_service),
    ) -> Any:
        service = _service(container)
        if request.directory_id is not None:
            root, _created = await _call(service.attach_directory, dataset_id, request.directory_id)
        elif request.source_id is not None:
            root, _created = await _call(service.attach_source, dataset_id, request.source_id)
        else:
            assert request.path is not None
            root, _created = await _call(
                service.attach_path, dataset_id, request.path, display_name=request.display_name
            )
        return root

    @router.delete("/datasets/{dataset_id}/roots/{root_id}", status_code=204)
    async def delete_dataset_root(
        dataset_id: str, root_id: str, container: Any = Depends(get_service)
    ) -> Response:
        await _call(_service(container).detach_root, dataset_id, root_id)
        return Response(status_code=204)

    @router.get("/datasets/{dataset_id}/members", response_model=DatasetMemberPageResponse)
    async def list_dataset_members(
        dataset_id: str,
        stage: DatasetStage | None = None,
        decision: DatasetMemberDecisionFilter | None = None,
        query: str | None = Query(default=None, max_length=200),
        cursor: str | None = Query(default=None, max_length=2048),
        limit: int = Query(default=MEMBER_PAGE_DEFAULT_LIMIT, ge=1, le=MEMBER_PAGE_MAX_LIMIT),
        container: Any = Depends(get_service),
    ) -> Any:
        return await _call(
            _service(container).members_page,
            dataset_id,
            stage=stage,
            decision=decision,
            query=query,
            cursor=cursor,
            limit=limit,
        )

    @router.post("/datasets/{dataset_id}/decisions", response_model=DatasetDecisionResponse)
    async def record_dataset_decisions(
        dataset_id: str,
        request: DatasetDecisionRequest,
        container: Any = Depends(get_service),
    ) -> Any:
        return await _call(
            _service(container).decide,
            dataset_id,
            stage=request.stage,
            asset_ids=request.asset_ids,
            decision=request.decision,
            reason=request.reason,
        )

    @router.get("/datasets/{dataset_id}/stage-runs", response_model=DatasetStageRunListResponse)
    async def list_dataset_stage_runs(
        dataset_id: str,
        stage: DatasetStage | None = None,
        limit: int = Query(default=50, ge=1, le=500),
        container: Any = Depends(get_service),
    ) -> Any:
        return {
            "items": await _call(
                _service(container).list_stage_runs, dataset_id, stage=stage, limit=limit
            )
        }

    @router.get("/datasets/{dataset_id}/hashing", response_model=DatasetHashingResponse)
    async def get_dataset_hashing(dataset_id: str, container: Any = Depends(get_service)) -> Any:
        return await _call(_service(container).hashing_status, dataset_id)

    @router.post(
        "/datasets/{dataset_id}/hashing", status_code=202, response_model=DatasetHashingResponse
    )
    async def start_dataset_hashing(dataset_id: str, container: Any = Depends(get_service)) -> Any:
        service = _service(container)
        await _call(service.require, dataset_id)
        return await _call(service.enqueue_hashing, dataset_id)

    @router.get("/datasets/{dataset_id}/crawls", response_model=DatasetCrawlListResponse)
    async def list_dataset_crawls(dataset_id: str, container: Any = Depends(get_service)) -> Any:
        return {"items": await _call(_service(container).list_crawls, dataset_id)}

    @router.post(
        "/datasets/{dataset_id}/crawls", status_code=202, response_model=DatasetCrawlResponse
    )
    async def create_dataset_crawl(
        dataset_id: str,
        body: CrawlRequest,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        container: Any = Depends(get_service),
    ) -> Any:
        """开一个爬取批次；批次结束、图库注册好来源后自动挂成这个数据集的根目录。"""
        service = _service(container)
        await _call(service.require, dataset_id)
        batch, _created = await _perform_crawl(
            body, container=container, idempotency_key=idempotency_key
        )
        return await _call(service.register_crawl, dataset_id, str(batch["id"]))

    return router


__all__ = ["create_datasets_router"]
