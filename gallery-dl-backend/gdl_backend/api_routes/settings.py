"""统一下载设置：HF 镜像、下载代理、HF token（只写）。"""

from __future__ import annotations

import asyncio
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from ..download_settings import MAX_HF_TOKEN_LENGTH, DownloadSettingsError
from .dependencies import get_service
from .errors import ApiError


class DownloadSettingsView(BaseModel):
    hf_mirror: str | None = Field(description="HF 镜像根地址；null 表示官方 huggingface.co")
    proxy_mode: Literal["none", "pool", "custom"]
    custom_proxy: str | None = Field(description="自定义下载代理，凭据已打码")
    custom_proxy_has_credentials: bool
    token_set: bool = Field(description="是否已保存 HF token；token 本身从不返回")
    token_hint: str | None = Field(description="token 末四位提示，形如 …abcd")


class DownloadSettingsUpdate(BaseModel):
    """只更新请求里出现的字段。"""

    model_config = ConfigDict(extra="forbid")

    hf_mirror: str | None = Field(default=None, max_length=300)
    proxy_mode: Literal["none", "pool", "custom"] | None = None
    custom_proxy: str | None = Field(default=None, max_length=300)
    hf_token: str | None = Field(default=None, max_length=MAX_HF_TOKEN_LENGTH, description="只写；保存后不再返回")
    clear_hf_token: bool = False


def create_settings_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1/settings")

    @router.get("/downloads", response_model=DownloadSettingsView)
    async def get_download_settings(service=Depends(get_service)):
        return await asyncio.to_thread(service.download_settings.view)

    @router.put("/downloads", response_model=DownloadSettingsView)
    async def update_download_settings(payload: DownloadSettingsUpdate, service=Depends(get_service)):
        provided = payload.model_fields_set
        if payload.clear_hf_token and payload.hf_token is not None:
            raise ApiError(422, "invalid_hf_token", "不能同时保存和清除 HF token")
        changes: dict[str, object] = {}
        if "hf_mirror" in provided:
            changes["hf_mirror"] = payload.hf_mirror
        if "proxy_mode" in provided and payload.proxy_mode is not None:
            changes["proxy_mode"] = payload.proxy_mode
        if "custom_proxy" in provided:
            changes["custom_proxy"] = payload.custom_proxy
        if payload.clear_hf_token:
            changes["hf_token"] = None
        elif payload.hf_token is not None:
            changes["hf_token"] = payload.hf_token
        try:
            return await asyncio.to_thread(lambda: service.download_settings.update(**changes))
        except DownloadSettingsError as error:
            raise ApiError(422, error.code, error.message) from error

    return router
