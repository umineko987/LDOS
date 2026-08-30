from __future__ import annotations

from fastapi import APIRouter, Depends, status

from ..schemas import ModelInstallRequest
from .dependencies import get_service
from .errors import ApiError


def create_setup_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1/setup")

    @router.get("/models")
    async def model_status(service=Depends(get_service)):
        return service.model_setup.status()

    @router.post("/models/install", status_code=status.HTTP_202_ACCEPTED)
    async def install_models(payload: ModelInstallRequest, service=Depends(get_service)):
        try:
            return await service.model_setup.install(payload.proxy_url)
        except ValueError as error:
            raise ApiError(422, "invalid_model_proxy", str(error)) from error

    return router
