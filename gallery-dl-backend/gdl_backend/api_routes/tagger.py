from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from .dependencies import get_service
from .errors import ApiError


def create_tagger_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1/tagger")

    @router.get("/models")
    async def models(service=Depends(get_service)) -> list[dict[str, Any]]:
        if not service.settings.tagger.enabled:
            raise ApiError(409, "tagger_disabled", "打标功能未启用")
        return service.tagger.model_catalog()

    @router.post("/cancel")
    async def cancel(service=Depends(get_service)) -> dict[str, Any]:
        return await service.tagger.cancel()

    return router
