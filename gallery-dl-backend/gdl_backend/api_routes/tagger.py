from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..download_settings import normalize_hf_mirror
from ..gallery_safe_paths import SafeSourceRoot, UnsafeSourcePathError
from ..model_setup import normalize_download_proxy
from ..models_service import ModelsError
from .dependencies import get_service
from .errors import ApiError


TaggerCategory = Literal["general", "character", "copyright", "quality", "meta", "rating", "style"]


class TaggerPrepareRequest(BaseModel):
    models: list[str] = Field(min_length=1, max_length=8)
    token: str | None = Field(default=None, max_length=8192)
    accept_license: bool = False
    proxy_url: str | None = None
    download_proxy: str | None = None

    @field_validator("download_proxy")
    @classmethod
    def validate_download_proxy(cls, value: str | None) -> str | None:
        return normalize_download_proxy(value)

    @field_validator("proxy_url")
    @classmethod
    def validate_mirror(cls, value: str | None) -> str | None:
        return normalize_hf_mirror(value)


class TaggerRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    models: list[str] = Field(min_length=1, max_length=8)
    asset_ids: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(default_factory=list, max_length=200)
    directory_ids: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(default_factory=list, max_length=200)
    thresholds: dict[str, dict[TaggerCategory, Annotated[float, Field(ge=0.01, le=0.99)]]] | None = None
    categories: list[str] | None = None
    write_captions: bool = True
    overwrite_captions: bool = False
    batch_size: int = Field(default=8, ge=1, le=64)


def _resolve_gallery_inputs(service, asset_ids: list[str], directory_ids: list[str]) -> list[str]:
    if not asset_ids and not directory_ids:
        raise ApiError(422, "invalid_tagger_input", "请先选择图库图片或目录")
    repo = service.db.gallery
    selected_ids = list(asset_ids)
    for directory_id in dict.fromkeys(directory_ids):
        directory = repo.get_directory(directory_id)
        if directory is None:
            raise ApiError(404, "gallery_directory_not_found", f"图库目录不存在: {directory_id}")
        source = repo.get_source(directory["source_id"])
        if source is None or source["availability"] != "available":
            raise ApiError(422, "invalid_tagger_input", f"图库来源不可用: {directory_id}")
        try:
            with SafeSourceRoot(source["root_path"]) as root:
                if directory["relative_path"] and not root.exists_directory(directory["relative_path"]):
                    raise UnsafeSourcePathError(directory["relative_path"], "directory_missing")
        except UnsafeSourcePathError as error:
            raise ApiError(422, "invalid_tagger_input", f"图库目录不可用: {directory_id}") from error
        cursor = None
        while True:
            page = repo.list_directory_entries(directory_id=directory_id, include_descendants=True, asset_cursor=cursor, limit=200)
            selected_ids.extend(asset["asset_id"] for asset in page["assets"])
            cursor = page["asset_cursor"]
            if cursor is None:
                break
    if not selected_ids:
        raise ApiError(422, "invalid_tagger_input", "选中的图库目录中没有可打标图片")
    paths = []
    for asset_id in dict.fromkeys(selected_ids):
        asset = repo.get_asset(asset_id)
        if asset is None:
            raise ApiError(404, "gallery_asset_not_found", f"图库资源不存在: {asset_id}")
        if asset["lifecycle_state"] != "active" or asset["dedup_visibility"] == "excluded":
            raise ApiError(422, "invalid_tagger_input", f"图库文件不可用: {asset_id}")
        source = repo.get_source(asset["source_id"])
        if source is None or source["availability"] != "available":
            raise ApiError(422, "invalid_tagger_input", f"图库来源不可用: {asset_id}")
        try:
            with SafeSourceRoot(source["root_path"]) as root:
                root.stat_regular(asset["relative_path"])
                paths.append(str(root.path / asset["relative_path"]))
        except UnsafeSourcePathError as error:
            raise ApiError(422, "invalid_tagger_input", f"图库文件不可用: {asset_id}") from error
    return list(dict.fromkeys(paths))


def create_tagger_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1/tagger")

    @router.get("/models")
    async def models(service=Depends(get_service)) -> list[dict[str, Any]]:
        if not service.settings.tagger.enabled:
            raise ApiError(409, "tagger_disabled", "打标功能未启用")
        return service.tagger.model_catalog()

    @router.get("/status")
    async def status_endpoint(service=Depends(get_service)) -> dict[str, Any]:
        return service.tagger.status()

    @router.post("/models/prepare", status_code=status.HTTP_202_ACCEPTED)
    async def prepare(payload: TaggerPrepareRequest, service=Depends(get_service)) -> dict[str, Any]:
        if not service.settings.tagger.enabled:
            raise ApiError(409, "tagger_disabled", "打标功能未启用")
        catalog = service.tagger.model_catalog()
        known = {entry["key"] for entry in catalog}
        unknown = [key for key in payload.models if key not in known]
        if unknown:
            raise ApiError(422, "unknown_tagger_model", f"未登记的模型: {', '.join(unknown)}")
        gated = {entry["key"] for entry in catalog if entry["gated"]}
        wanted_gated = [key for key in payload.models if key in gated]
        if wanted_gated and not payload.accept_license:
            raise ApiError(
                422, "tagger_license_required",
                f"模型受自定义许可约束，需 accept_license=true：{', '.join(wanted_gated)}",
            )
        # 请求里显式给出的字段原样使用；没给的取统一下载设置（/settings/downloads）。
        provided = payload.model_fields_set
        overrides = {
            target: getattr(payload, field)
            for field, target in (("token", "token"), ("proxy_url", "hf_mirror"), ("download_proxy", "proxy"))
            if field in provided
        }
        try:
            return await service.models.prepare_tagger(
                payload.models, accept_license=payload.accept_license, overrides=overrides,
            )
        except ModelsError as error:
            raise ApiError(error.status_code, error.code, error.message) from error

    @router.post("/run", status_code=status.HTTP_202_ACCEPTED)
    async def run(payload: TaggerRunRequest, service=Depends(get_service)) -> dict[str, Any]:
        if not service.settings.tagger.enabled:
            raise ApiError(409, "tagger_disabled", "打标功能未启用")
        catalog = service.tagger.model_catalog()
        known = {entry["key"] for entry in catalog}
        unknown = [key for key in payload.models if key not in known]
        if unknown:
            raise ApiError(422, "unknown_tagger_model", f"未登记的模型: {', '.join(unknown)}")
        missing = [key for key in payload.models if key in known and not next(
            entry["installed"] for entry in catalog if entry["key"] == key)]
        if missing:
            raise ApiError(409, "tagger_model_missing", f"模型未安装: {', '.join(missing)}")
        for model, thresholds in (payload.thresholds or {}).items():
            if model not in payload.models:
                raise ApiError(422, "invalid_tagger_thresholds", f"阈值对应的模型未选中: {model}")
            defaults = next(entry["default_thresholds"] for entry in catalog if entry["key"] == model)
            unsupported = thresholds.keys() - defaults.keys()
            if unsupported:
                raise ApiError(422, "invalid_tagger_thresholds", f"{model} 不支持这些阈值类别: {', '.join(sorted(unsupported))}")
        inputs = await asyncio.to_thread(_resolve_gallery_inputs, service, payload.asset_ids, payload.directory_ids)
        try:
            return await service.tagger.tag(
                payload.models,
                inputs,
                thresholds=payload.thresholds,
                categories=payload.categories,
                write_captions=payload.write_captions,
                overwrite_captions=payload.overwrite_captions,
                batch_size=payload.batch_size,
            )
        except OSError as error:
            raise ApiError(503, "tagger_start_failed", str(error)) from error
        except RuntimeError as error:
            raise ApiError(409, "tagger_busy", str(error)) from error

    @router.post("/cancel")
    async def cancel(service=Depends(get_service)) -> dict[str, Any]:
        return await service.tagger.cancel()

    return router
