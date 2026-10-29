"""统一模型表：去重/过滤模型与打标模型的状态和安装。"""

from __future__ import annotations

import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, ConfigDict, Field

from ..models_service import ModelsError
from .dependencies import get_service
from .errors import ApiError


class ModelProgress(BaseModel):
    current: int
    total: int


class ModelItem(BaseModel):
    key: str
    family: Literal["dedup", "tagger"]
    display_name: str
    status: Literal["installed", "missing", "installing", "failed", "needs_license", "disabled"]
    size_bytes: int | None = Field(description="下载大小；打标模型未登记大小时为 null")
    installed_bytes: int
    license: str | None
    gated: bool = Field(description="需要同意自定义许可（安装时 accept_license=true）")
    source_url: str
    used_by: list[Literal["dedup", "atlas", "clean", "tag"]]
    installs_with: list[str] = Field(description="会一起安装的其他模型 key（SSCD 与 DINOv2 同包）")
    message: str
    progress: ModelProgress | None
    job_id: str | None = Field(description="安装中时对应的 Job id，进度也走 SSE job.updated")


class ModelList(BaseModel):
    items: list[ModelItem]


class ModelInstallStarted(BaseModel):
    family: Literal["dedup", "tagger"]
    keys: list[str]
    job_id: str | None
    proxy_source: Literal["none", "pool", "custom"]


class ModelInstallResponse(ModelList):
    started: list[ModelInstallStarted]


class ModelInstallBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keys: list[Annotated[str, Field(min_length=1, max_length=64)]] = Field(min_length=1, max_length=16)
    accept_license: bool = False


def create_models_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1/models")

    @router.get("", response_model=ModelList)
    async def list_models(service=Depends(get_service)):
        return await asyncio.to_thread(service.models.list_models)

    @router.post("/install", status_code=status.HTTP_202_ACCEPTED, response_model=ModelInstallResponse)
    async def install_models(payload: ModelInstallBody, service=Depends(get_service)):
        try:
            return await service.models.install(payload.keys, accept_license=payload.accept_license)
        except ModelsError as error:
            raise ApiError(error.status_code, error.code, error.message) from error

    return router
