"""语义地图 API：``/api/v1/datasets/{dataset_id}/atlas``。

运行在后台进行，进度走 job ``atlas:{dataset_id}``（``job.updated``）和领域事件
``atlas.updated {dataset_id, status, run_id}``；前端收到事件后重拉 GET（带 If-None-Match）。
地图上的移除是去重阶段的 exclude（reason=atlas），见 ``atlas_service`` 模块说明。
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, Path, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from ..atlas_service import AtlasError, AtlasService, etag_matches
from ..dataset_service import DatasetError
from .datasets import DatasetDecisionResponse, _api_error
from .dependencies import get_service
from .errors import ApiError


AtlasStatus = Literal["none", "running", "ready", "stale", "failed"]
AtlasUnavailableReason = Literal["", "dedup_disabled", "python_missing", "worker_missing"]
AtlasSkipReason = Literal["missing", "changed", "unreadable"]

_Id = Annotated[str, Field(min_length=1, max_length=128)]
_RUN_PATTERN = r"^\d{13}-[0-9a-f]{8}$"


# ---- 请求 ----


class AtlasRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # 输入摘要没变时默认直接返回已有结果；force 强制重算。
    force: bool = False
    clusters: int | None = Field(default=None, ge=1, le=256)
    perplexity: float | None = Field(default=None, ge=2, le=100)


class AtlasAssetsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_ids: list[_Id] = Field(min_length=1, max_length=5000)


# ---- 响应 ----


class AtlasProgress(BaseModel):
    # queued / preparing / hashing / read / embed / pca / neighbors / layout / cluster / write
    phase: str
    label: str
    done: int | None = None
    total: int | None = None


class AtlasErrorInfo(BaseModel):
    code: str
    message: str
    at: float


class AtlasAvailability(BaseModel):
    available: bool
    reason: AtlasUnavailableReason


class AtlasDelta(BaseModel):
    """当前打标输入相对结果的变化；added/changed 任一大于 0 即 stale。"""

    added: int = Field(ge=0)
    changed: int = Field(ge=0)
    # 结果里有、但已不在输入里的图（被排除或删除）；前端直接隐藏。
    removed_asset_ids: list[str]


class AtlasRunInfo(BaseModel):
    run_id: str
    input_digest: str | None = None
    started_at: float | None = None
    finished_at: float | None = None
    options: dict[str, Any]
    method: str | None = None
    params: dict[str, Any]
    counts: dict[str, int]


class AtlasStateResponse(BaseModel):
    """地图状态（不含点位）。run 为 null 表示还没有结果；失败或运行中仍会带上一次的 run。"""

    dataset_id: str
    status: AtlasStatus
    progress: AtlasProgress | None = None
    error: AtlasErrorInfo | None = None
    availability: AtlasAvailability
    running_run_id: str | None = None
    # POST /run 因输入摘要未变而直接返回已有结果时为 true。
    cached: bool = False
    run: AtlasRunInfo | None = None
    stale: bool
    current_digest: str
    delta: AtlasDelta


class AtlasItem(BaseModel):
    asset_id: str
    sha256: str | None = None
    x: float
    y: float
    cluster: int
    outlier: float
    # [sheet, cell]；cell 位于 ((cell % columns) * cell_size, (cell // columns) * cell_size)
    sprite: list[int] | None = None
    # 文件名；已不在输入里的图（removed_asset_ids）为 null。
    name: str | None = None


class AtlasCluster(BaseModel):
    id: int
    size: int
    share: float
    medoid_asset_id: str
    x: float
    y: float
    # 去掉 removed_asset_ids 之后的大小与占比。
    live_size: int
    live_share: float
    # 簇内出现在最多张图上的 caption 标签（最多 3 个，不含触发词）；没有 caption 时为空。
    top_tags: list[str] = Field(default_factory=list)


class AtlasVectors(BaseModel):
    """PCA-32 int8 量化，data 为行主序 n×dims 字节的 base64，v ≈ q * scales[d]。"""

    dims: int
    dtype: Literal["int8"]
    encoding: Literal["base64"]
    order: Literal["items"]
    scales: list[float]
    data: str


class AtlasSprites(BaseModel):
    format: Literal["webp", "png"]
    sheet_size: int
    cell_size: int
    columns: int
    per_sheet: int
    # 按 sheet 序号排列，带 ?run= 的地址内容不变，可长期缓存。
    urls: list[str]


class AtlasSkipped(BaseModel):
    asset_id: str
    reason: AtlasSkipReason


class AtlasOverRepresented(BaseModel):
    cluster: int
    share: float
    size: int


class AtlasHints(BaseModel):
    share_threshold: float
    outlier_threshold: float
    # live_share 超过 share_threshold 的簇（按簇序号，0 最大）。
    over_represented: list[AtlasOverRepresented]
    # outlier ≥ outlier_threshold 的图，按离群程度从高到低。
    outliers: list[str]


class AtlasResponse(AtlasStateResponse):
    items: list[AtlasItem] = Field(default_factory=list)
    clusters: list[AtlasCluster] = Field(default_factory=list)
    vectors: AtlasVectors | None = None
    sprites: AtlasSprites | None = None
    skipped: list[AtlasSkipped] = Field(default_factory=list)
    hints: AtlasHints | None = None


def _service(container: Any) -> AtlasService:
    return container.atlas


def _map_error(error: Exception) -> ApiError:
    if isinstance(error, DatasetError):
        return _api_error(error)
    assert isinstance(error, AtlasError)
    return ApiError(error.status, error.code, error.message)


async def _await(awaitable):
    try:
        return await awaitable
    except (AtlasError, DatasetError) as error:
        raise _map_error(error) from None


async def _call(function, *args, **kwargs):
    return await _await(asyncio.to_thread(function, *args, **kwargs))


def create_atlas_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1/datasets/{dataset_id}/atlas")

    @router.get(
        "",
        response_model=AtlasResponse,
        responses={304: {"description": "If-None-Match 命中"}},
    )
    async def get_dataset_atlas(
        dataset_id: str,
        if_none_match: str | None = Header(default=None, alias="If-None-Match"),
        container: Any = Depends(get_service),
    ) -> Any:
        payload, etag = await _await(_service(container).payload(dataset_id, if_none_match=if_none_match))
        headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
        if payload is None:
            return Response(status_code=304, headers=headers)
        # 载荷按模型声明给 OpenAPI；上万个点时跳过逐项校验，直接序列化。
        return JSONResponse(payload, headers=headers)

    @router.post("/run", response_model=AtlasStateResponse, status_code=202)
    async def run_dataset_atlas(
        dataset_id: str,
        body: AtlasRunRequest | None = None,
        container: Any = Depends(get_service),
    ) -> Any:
        request = body or AtlasRunRequest()
        options = {"clusters": request.clusters, "perplexity": request.perplexity}
        return await _await(_service(container).run(dataset_id, force=request.force, options=options))

    @router.post("/cancel", response_model=AtlasStateResponse)
    async def cancel_dataset_atlas(
        dataset_id: str,
        container: Any = Depends(get_service),
    ) -> Any:
        return await _await(_service(container).cancel(dataset_id))

    @router.post("/remove", response_model=DatasetDecisionResponse)
    async def remove_dataset_atlas_assets(
        dataset_id: str,
        body: AtlasAssetsRequest,
        container: Any = Depends(get_service),
    ) -> Any:
        return await _call(_service(container).remove, dataset_id, body.asset_ids)

    @router.post("/restore", response_model=DatasetDecisionResponse)
    async def restore_dataset_atlas_assets(
        dataset_id: str,
        body: AtlasAssetsRequest,
        container: Any = Depends(get_service),
    ) -> Any:
        return await _call(_service(container).restore, dataset_id, body.asset_ids)

    @router.get(
        "/sprites/{index}",
        response_class=Response,
        responses={
            200: {"content": {"image/webp": {}, "image/png": {}}, "description": "雪碧图"},
            304: {"description": "If-None-Match 命中"},
        },
    )
    async def get_dataset_atlas_sprite(
        dataset_id: str,
        index: int = Path(ge=0, le=9999),
        run: str | None = Query(default=None, pattern=_RUN_PATTERN),
        if_none_match: str | None = Header(default=None, alias="If-None-Match"),
        container: Any = Depends(get_service),
    ) -> Any:
        sprite = await _call(_service(container).sprite, dataset_id, index, run)
        # 带 run 的地址指向一次完成的运行，内容不再变化；不带时跟着 current 走，每次校验。
        cache_control = "private, max-age=31536000, immutable" if sprite["immutable"] else "private, no-cache"
        headers = {"ETag": sprite["etag"], "Cache-Control": cache_control}
        if etag_matches(if_none_match, sprite["etag"]):
            return Response(status_code=304, headers=headers)
        return FileResponse(sprite["path"], media_type=sprite["media_type"], headers=headers)

    return router


__all__ = ["create_atlas_router"]
