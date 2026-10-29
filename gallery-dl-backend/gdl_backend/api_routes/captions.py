"""数据集 caption API（schema v16）：全量读取、批量操作、单张编辑、批次历史与撤销。

caption 的 version 是不透明的磁盘版本字符串；写入时带上它做乐观并发检查。
大载荷（全量 caption）直接返回缓存的 JSON 字节，带 ETag，支持 If-None-Match → 304。
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal, Union

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import Response
from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from ..caption_service import CaptionService
from ..dataset_service import DatasetError
from .dependencies import get_service
from .errors import ApiError


CaptionState = Literal[
    "normal", "blank", "missing", "invalid_encoding", "io_error", "pair_conflict", "unavailable"
]
CaptionBatchKind = Literal["from_tagger", "ops", "edit"]

_Id = Annotated[str, Field(min_length=1, max_length=128)]
_Version = Annotated[str, Field(min_length=1, max_length=128)]


def _tag(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("标签不能为空")
    if any(separator in value for separator in (",", "\n", "\r")):
        raise ValueError("标签不能包含逗号或换行")
    return value


TagText = Annotated[str, Field(min_length=1, max_length=512), AfterValidator(_tag)]
_TagList = Annotated[list[TagText], Field(min_length=1, max_length=200)]


# ---- 请求 ----


class _Op(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class CaptionAddOp(_Op):
    op: Literal["add"]
    tags: _TagList
    # front：插到最前（触发词仍在第一位）；back：追加到末尾。
    position: Literal["front", "back"] = "back"


class CaptionRemoveOp(_Op):
    op: Literal["remove"]
    tags: _TagList


class CaptionReplaceOp(_Op):
    op: Literal["replace"]
    from_: TagText = Field(alias="from")
    to: TagText


class CaptionMergeOp(_Op):
    op: Literal["merge"]
    tags: _TagList
    into: TagText


class CaptionPinOp(_Op):
    op: Literal["pin"]
    tags: _TagList


CaptionOp = Annotated[
    Union[CaptionAddOp, CaptionRemoveOp, CaptionReplaceOp, CaptionMergeOp, CaptionPinOp],
    Field(discriminator="op"),
]


class CaptionOpsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_ids: list[_Id] = Field(min_length=1, max_length=50_000)
    ops: list[CaptionOp] = Field(min_length=1, max_length=50)
    dry_run: bool = False
    # asset_id → 读取时拿到的 version；给出的图版本不符时报告为冲突、不写。
    expected_versions: dict[str, _Version] | None = None
    sample_limit: int = Field(default=20, ge=0, le=200)


class CaptionEditRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=1_000_000)
    expected_version: _Version


# ---- 响应 ----


class CaptionItem(BaseModel):
    asset_id: str
    name: str
    state: CaptionState
    text: str
    tags: list[str]
    version: str


class CaptionListResponse(BaseModel):
    dataset_id: str
    trigger_word: str
    etag: str
    items: list[CaptionItem]


class CaptionReportItem(BaseModel):
    asset_id: str
    reason: str


class CaptionDiffSample(BaseModel):
    asset_id: str
    change: Literal["changed", "new"]
    before: list[str]
    after: list[str]
    added: list[str]
    removed: list[str]


class CaptionWriteStats(BaseModel):
    total: int
    changed: int
    new: int
    unchanged: int
    skipped: int
    conflicts: int
    written: int
    failed: int


class CaptionBatchResult(BaseModel):
    """批量写入（或 dry-run）的结果；batch_id 为 null 表示没有写任何文件。"""

    dataset_id: str
    dry_run: bool
    batch_id: str | None
    stats: CaptionWriteStats
    samples: list[CaptionDiffSample]
    skipped: list[CaptionReportItem]
    conflicts: list[CaptionReportItem]
    failed: list[CaptionReportItem]


class CaptionEntry(BaseModel):
    asset_id: str
    state: CaptionState
    text: str
    tags: list[str]
    version: str


class CaptionEditResponse(BaseModel):
    batch_id: str | None
    caption: CaptionEntry


class CaptionBatchSummary(BaseModel):
    batch_id: str
    dataset_id: str
    kind: CaptionBatchKind
    params: dict[str, Any]
    stats: dict[str, Any]
    changed_count: int
    created_at: float
    undone_at: float | None
    undo_stats: dict[str, Any]
    can_undo: bool


class CaptionBatchListResponse(BaseModel):
    items: list[CaptionBatchSummary]


class CaptionUndoStats(BaseModel):
    total: int
    restored: int
    conflicts: int
    failed: int


class CaptionUndoResponse(BaseModel):
    batch_id: str
    dataset_id: str
    stats: CaptionUndoStats
    conflicts: list[CaptionReportItem]
    failed: list[CaptionReportItem]


# ---- 工具 ----


def _captions(container: Any) -> CaptionService:
    return container.captions


async def _call(function, *args, **kwargs):
    try:
        return await asyncio.to_thread(function, *args, **kwargs)
    except DatasetError as error:
        raise ApiError(error.status, error.code, error.message, details=error.details or None) from None


def etag_matches(header: str | None, etag: str) -> bool:
    """If-None-Match 的弱比较：`*` 或列表里任一项（去掉 W/）等于当前 ETag。"""
    if not header:
        return False
    if header.strip() == "*":
        return True
    return any(part.strip().removeprefix("W/") == etag for part in header.split(","))


def cached_json(body: bytes, etag: str, if_none_match: str | None) -> Response:
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if etag_matches(if_none_match, etag):
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)


NOT_MODIFIED = {304: {"description": "If-None-Match 与当前 ETag 相同，没有响应体"}}


def create_captions_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get(
        "/datasets/{dataset_id}/captions",
        response_model=CaptionListResponse,
        responses=NOT_MODIFIED,
    )
    async def list_dataset_captions(
        dataset_id: str,
        if_none_match: str | None = Header(default=None),
        container: Any = Depends(get_service),
    ) -> Any:
        etag, body = await _call(_captions(container).listing, dataset_id)
        return cached_json(body, etag, if_none_match)

    @router.put(
        "/datasets/{dataset_id}/captions/{asset_id}",
        response_model=CaptionEditResponse,
    )
    async def edit_dataset_caption(
        dataset_id: str,
        asset_id: str,
        payload: CaptionEditRequest,
        container: Any = Depends(get_service),
    ) -> Any:
        return await _call(
            _captions(container).edit, dataset_id, asset_id, payload.text,
            expected_version=payload.expected_version,
        )

    @router.post(
        "/datasets/{dataset_id}/captions/ops",
        response_model=CaptionBatchResult,
    )
    async def run_dataset_caption_ops(
        dataset_id: str,
        payload: CaptionOpsRequest,
        container: Any = Depends(get_service),
    ) -> Any:
        return await _call(
            _captions(container).run_ops,
            dataset_id,
            asset_ids=payload.asset_ids,
            ops=[op.model_dump(by_alias=True) for op in payload.ops],
            dry_run=payload.dry_run,
            expected_versions=payload.expected_versions,
            sample_limit=payload.sample_limit,
        )

    @router.get(
        "/datasets/{dataset_id}/caption-batches",
        response_model=CaptionBatchListResponse,
    )
    async def list_dataset_caption_batches(
        dataset_id: str,
        limit: int = Query(default=50, ge=1, le=500),
        container: Any = Depends(get_service),
    ) -> Any:
        return {"items": await _call(_captions(container).history, dataset_id, limit=limit)}

    @router.post(
        "/caption-batches/{batch_id}/undo",
        response_model=CaptionUndoResponse,
    )
    async def undo_caption_batch(
        batch_id: str,
        container: Any = Depends(get_service),
    ) -> Any:
        return await _call(_captions(container).undo, batch_id)

    return router
