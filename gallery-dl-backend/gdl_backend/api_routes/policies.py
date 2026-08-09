from __future__ import annotations

import sqlite3
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query

from ..policy_view import (
    POLICY_RESPONSE_PROFILE,
    PolicyViewValidationError,
    is_policy_site,
    policy_view_item,
    policy_view_snapshot,
    safe_policy_dict,
)
from ..site_policy import EditableSitePolicy
from .body_limits import enforce_policy_body_limit
from .dependencies import get_service
from .errors import ApiError
from .validation import validate_site_name

PolicyResponseView = Literal["legacy", "policy"]


def _require_policy_site(name: str) -> None:
    if not is_policy_site(name):
        raise ApiError(
            422,
            "unsupported_policy_site",
            "该站点不能在此处设置",
        )


def _raise_policy_store_error(exc: Exception) -> None:
    raise ApiError(
        503,
        "policy_store_error",
        "站点设置暂时无法保存或读取",
    ) from exc


def _legacy_policy_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    projected: list[dict[str, Any]] = []
    for item in items:
        site = item.get("site")
        if not isinstance(site, str) or not is_policy_site(site):
            continue
        projected.append(
            {
                "site": site,
                "policy": safe_policy_dict(item.get("policy")),
                "updated_at": item.get("updated_at"),
            }
        )
    return projected


def create_policies_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get("/sites/policies")
    async def site_policies(
        view: PolicyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            stored = container.db.list_site_policies()
            if view == "legacy":
                return {
                    "default": safe_policy_dict(
                        container.settings.default_site_policy
                    ),
                    "items": _legacy_policy_items(stored),
                }
            return policy_view_snapshot(
                container.settings.default_site_policy,
                stored,
            )
        except (sqlite3.Error, TypeError, ValueError) as exc:
            _raise_policy_store_error(exc)

    @router.get("/sites/policies/{site}")
    async def get_site_policy(
        site: str,
        view: PolicyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        name = validate_site_name(site)
        _require_policy_site(name)
        try:
            stored = container.db.get_site_policy(name)
            if view == "legacy":
                if stored is not None:
                    return {
                        "site": name,
                        "policy": safe_policy_dict(stored.get("policy")),
                        "updated_at": stored.get("updated_at"),
                    }
                return {
                    "site": name,
                    "policy": safe_policy_dict(
                        container.settings.default_site_policy
                    ),
                    "inherited": True,
                }
            if stored is None:
                return policy_view_item(
                    name,
                    container.settings.default_site_policy,
                    inherited=True,
                )
            return policy_view_item(
                name,
                stored.get("policy"),
                inherited=False,
                updated_at=stored.get("updated_at"),
            )
        except (sqlite3.Error, TypeError, ValueError) as exc:
            _raise_policy_store_error(exc)

    @router.put("/sites/policies/{site}")
    async def put_site_policy(
        site: str,
        body: EditableSitePolicy,
        view: PolicyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
        _body_limit: None = Depends(enforce_policy_body_limit),
    ):
        name = validate_site_name(site)
        _require_policy_site(name)
        try:
            policy = safe_policy_dict(body, require_complete=True)
        except PolicyViewValidationError as exc:
            raise ApiError(
                422,
                "invalid_policy",
                "站点设置中有不支持或不正确的字段",
                exc.safe_details(),
            ) from exc
        try:
            stored = container.db.put_site_policy(name, policy)
        except (sqlite3.Error, TypeError, ValueError) as exc:
            _raise_policy_store_error(exc)
        if view == "legacy":
            return stored
        return policy_view_item(
            name,
            stored["policy"],
            inherited=False,
            updated_at=stored.get("updated_at"),
        )

    @router.delete("/sites/policies/{site}")
    async def delete_site_policy(
        site: str,
        view: PolicyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        name = validate_site_name(site)
        _require_policy_site(name)
        try:
            deleted = container.db.delete_site_policy(name)
        except (sqlite3.Error, TypeError, ValueError) as exc:
            _raise_policy_store_error(exc)
        if not deleted:
            raise ApiError(
                404,
                "site_policy_not_found",
                "该站点没有单独保存的设置",
            )
        if view == "policy":
            return {
                "response_profile": POLICY_RESPONSE_PROFILE,
                "deleted": True,
                "site": name,
            }
        return {"deleted": True, "site": name}

    return router
