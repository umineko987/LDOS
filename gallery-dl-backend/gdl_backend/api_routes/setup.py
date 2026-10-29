from __future__ import annotations

import asyncio
from fastapi import APIRouter, Depends, status

from ..schemas import ModelInstallRequest
from .dependencies import get_service
from .errors import ApiError


def create_setup_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1/setup")

    @router.get("/models")
    async def model_status(service=Depends(get_service)):
        return await asyncio.to_thread(service.model_setup.status)

    @router.post("/models/install", status_code=status.HTTP_202_ACCEPTED)
    async def install_models(payload: ModelInstallRequest, service=Depends(get_service)):
        try:
            # 旧接口的 proxy_url 语义不变（空=直连）；只套用统一设置里的 HF 镜像。
            mirror = (await asyncio.to_thread(service.download_settings.load)).hf_mirror
            return await service.model_setup.install(payload.proxy_url, payload.models, hf_endpoint=mirror)
        except ValueError as error:
            raise ApiError(422, "invalid_model_proxy", str(error)) from error

    return router
