from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field

from .dependencies import get_service
from .errors import ApiError


class TaggerPrepareRequest(BaseModel):
    models: list[str] = Field(min_length=1)
    token: str | None = None
    accept_license: bool = False


class TaggerRunRequest(BaseModel):
    models: list[str] = Field(min_length=1)
    inputs: list[str] = Field(min_length=1)
    thresholds: dict[str, float] | None = None
    categories: list[str] | None = None
    write_captions: bool = True
    overwrite_captions: bool = False
    batch_size: int = Field(default=8, ge=1, le=64)


def _validate_inputs(inputs: list[str]) -> None:
    from pathlib import Path

    for item in inputs:
        path = Path(item)
        if not path.exists():
            raise ApiError(422, "invalid_tagger_input", f"输入路径不存在: {item}")


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
        try:
            return await service.tagger.prepare(
                payload.models, payload.token, accept_license=payload.accept_license
            )
        except RuntimeError as error:
            raise ApiError(409, "tagger_busy", str(error)) from error

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
        _validate_inputs(payload.inputs)
        try:
            return await service.tagger.tag(
                payload.models,
                payload.inputs,
                thresholds=payload.thresholds,
                categories=payload.categories,
                write_captions=payload.write_captions,
                overwrite_captions=payload.overwrite_captions,
                batch_size=payload.batch_size,
            )
        except RuntimeError as error:
            raise ApiError(409, "tagger_busy", str(error)) from error

    @router.post("/cancel")
    async def cancel(service=Depends(get_service)) -> dict[str, Any]:
        return await service.tagger.cancel()

    return router
