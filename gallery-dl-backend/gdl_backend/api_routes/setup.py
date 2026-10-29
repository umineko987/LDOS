from __future__ import annotations

import asyncio
from fastapi import APIRouter, Depends, status

from ..schemas import ModelInstallRequest
from .dependencies import get_service
from .errors import ApiError
from .passthrough_models import PassthroughModel


# 旧的去重模型安装接口（新前端走 /api/v1/models）。负载是 ModelSetupManager.status，
# 模型只把字段写进 OpenAPI，字段都可选。


class ReviewFilterCapability(PassthroughModel):
    available: bool | None = None
    reason: str | None = None


class ModelInstallState(PassthroughModel):
    installed: bool | None = None
    # 只有过滤模型（completeness / ccip）带下载进度。
    downloaded_bytes: int | None = None
    expected_bytes: int | None = None


class ModelSetupStatus(PassthroughModel):
    phase: str | None = None
    enabled: bool | None = None
    installed: bool | None = None
    using_proxy: bool | None = None
    downloaded_bytes: int | None = None
    expected_bytes: int | None = None
    message: str | None = None
    requested_models: list[str] | None = None
    review_filters: dict[str, ReviewFilterCapability] | None = None
    models: dict[str, ModelInstallState] | None = None


def create_setup_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1/setup")

    @router.get("/models", response_model=ModelSetupStatus, response_model_exclude_unset=True)
    async def model_status(service=Depends(get_service)):
        return await asyncio.to_thread(service.model_setup.status)

    @router.post(
        "/models/install",
        status_code=status.HTTP_202_ACCEPTED,
        response_model=ModelSetupStatus,
        response_model_exclude_unset=True,
    )
    async def install_models(payload: ModelInstallRequest, service=Depends(get_service)):
        try:
            # 旧接口的 proxy_url 语义不变（空=直连）；只套用统一设置里的 HF 镜像。
            mirror = (await asyncio.to_thread(service.download_settings.load)).hf_mirror
            return await service.model_setup.install(payload.proxy_url, payload.models, hf_endpoint=mirror)
        except ValueError as error:
            raise ApiError(422, "invalid_model_proxy", str(error)) from error

    return router
