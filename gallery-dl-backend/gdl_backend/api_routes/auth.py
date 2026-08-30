from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query

from ..auth import (
    AuthError,
    vault_safe_browser_profile,
    vault_safe_browser_runtime,
    vault_safe_proxy_status,
    vault_safe_session,
    vault_safe_status,
    vault_safe_statuses,
)
from ..schemas import AuthProxyUpdate, BrowserExecutableUpdate
from .body_limits import enforce_auth_proxy_body_limit
from .dependencies import get_service
from .errors import ApiError

AuthResponseView = Literal["legacy", "vault"]

# The vault profile may expose controlled backend codes, but never arbitrary
# error codes, messages, or details from an authorization implementation.
_VAULT_SAFE_AUTH_ERROR_CODES = frozenset(
    {
        "unsupported_auth_site",
        "managed_browser_unsupported",
        "browser_login_session_not_found",
        "browser_login_start_failed",
        "shared_browser_busy",
        "pixiv_oauth_start_failed",
        "pixiv_oauth_start_timeout",
        "pixiv_oauth_session_not_found",
        "pixiv_oauth_session_expired",
        "pixiv_oauth_exchange_active",
        "pixiv_oauth_process_ended",
        "pixiv_oauth_exchange_timeout",
        "pixiv_oauth_exchange_failed",
        "invalid_pixiv_oauth_code",
        "pixiv_oauth_cache_failed",
        "invalid_authorization_proxy",
        "browser_profile_reset_active",
        "browser_profile_busy",
        "invalid_browser_profile_path",
        "invalid_browser_executable",
        "browser_busy",
        "chrome_not_found",
        "auth_cache_clear_failed",
    }
)


def raise_auth_error(exc: AuthError, view: AuthResponseView = "legacy") -> None:
    if exc.code in {
        "unsupported_auth_site",
        "pixiv_oauth_session_not_found",
        "browser_login_session_not_found",
    }:
        status_code = 404
    elif exc.code.startswith("invalid_"):
        status_code = 422
    else:
        status_code = 409
    if view == "vault":
        code = (
            exc.code
            if exc.code in _VAULT_SAFE_AUTH_ERROR_CODES
            else "authorization_operation_failed"
        )
        if status_code == 404:
            message = "授权目标或会话不存在"
        elif status_code == 422:
            message = "授权请求不符合安全约束"
        else:
            message = "授权状态冲突或操作暂时不可用"
        raise ApiError(status_code, code, message) from exc
    raise ApiError(status_code, exc.code, exc.message, exc.details) from exc


def auth_browser_result(
    result: dict[str, Any],
    view: AuthResponseView,
) -> dict[str, Any]:
    if view == "legacy":
        return result
    status = vault_safe_status(result.get("status"))
    return {
        "session": vault_safe_session(result.get("session"), site=status["site"]),
        "status": status,
    }


def create_auth_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get("/auth")
    async def auth_statuses(
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        result = container.auth.statuses()
        return vault_safe_statuses(result) if view == "vault" else result

    # Fixed /auth/proxy and /auth/browser routes must be registered before
    # /auth/{site}, otherwise FastAPI can treat their names as site parameters.
    @router.get("/auth/proxy")
    async def auth_proxy_status(
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        result = container.auth.proxy_status()
        return vault_safe_proxy_status(result) if view == "vault" else result

    @router.put("/auth/proxy")
    async def auth_set_proxy(
        payload: AuthProxyUpdate,
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
        _body_limit: None = Depends(enforce_auth_proxy_body_limit),
    ):
        try:
            result = await container.auth.set_authorization_proxy(payload.proxy_url)
            return vault_safe_proxy_status(result) if view == "vault" else result
        except AuthError as exc:
            raise_auth_error(exc, view)

    @router.delete("/auth/proxy")
    async def auth_reset_proxy(
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            result = await container.auth.clear_authorization_proxy()
            return vault_safe_proxy_status(result) if view == "vault" else result
        except AuthError as exc:
            raise_auth_error(exc, view)

    @router.get("/auth/browser")
    async def auth_browser_runtime(
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        result = container.auth.browser_runtime_status()
        return vault_safe_browser_runtime(result) if view == "vault" else result

    @router.put("/auth/browser")
    async def auth_select_browser(
        payload: BrowserExecutableUpdate,
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            result = await container.auth.select_browser_executable(payload.path)
            return vault_safe_browser_runtime(result) if view == "vault" else result
        except AuthError as exc:
            raise_auth_error(exc, view)

    @router.delete("/auth/browser")
    async def auth_clear_browser(
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            result = await container.auth.clear_browser_executable()
            return vault_safe_browser_runtime(result) if view == "vault" else result
        except AuthError as exc:
            raise_auth_error(exc, view)

    @router.get("/auth/{site}")
    async def auth_status(
        site: str,
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            result = container.auth.status(site)
            return vault_safe_status(result) if view == "vault" else result
        except AuthError as exc:
            raise_auth_error(exc, view)

    @router.post("/auth/{site}/login/start", status_code=202)
    async def auth_start_browser_login(
        site: str,
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            result = await container.auth.start_browser_login(site)
            return auth_browser_result(result, view)
        except AuthError as exc:
            raise_auth_error(exc, view)

    @router.get("/auth/{site}/login/{session_id}")
    async def auth_browser_login_session(
        site: str,
        session_id: str,
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            result = container.auth.browser_login_session(site, session_id)
            return auth_browser_result(result, view)
        except AuthError as exc:
            raise_auth_error(exc, view)

    @router.delete("/auth/{site}/login/{session_id}")
    async def auth_cancel_browser_login(
        site: str,
        session_id: str,
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            result = await container.auth.cancel_browser_login(site, session_id)
            return auth_browser_result(result, view)
        except AuthError as exc:
            raise_auth_error(exc, view)

    @router.post("/auth/pixiv/oauth/start")
    async def auth_start_pixiv(
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            result = await container.auth.start_pixiv_oauth()
            return vault_safe_session(result, site="pixiv") if view == "vault" else result
        except AuthError as exc:
            raise_auth_error(exc, view)

    @router.delete("/auth/pixiv/oauth/session")
    async def auth_cancel_pixiv(
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            result = await container.auth.cancel_pixiv_oauth()
            return vault_safe_status(result) if view == "vault" else result
        except AuthError as exc:
            raise_auth_error(exc, view)

    @router.delete("/auth/browser-profile")
    async def auth_clear_browser_profile(
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            result = await container.auth.clear_browser_profile()
            if view == "legacy":
                return result
            return {
                "browser_profile": vault_safe_browser_profile(result.get("browser_profile")),
                "auth": vault_safe_statuses(result.get("auth")),
            }
        except AuthError as exc:
            raise_auth_error(exc, view)

    @router.delete("/auth/{site}")
    async def auth_clear(
        site: str,
        view: AuthResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        try:
            result = await container.auth.clear(site)
            return vault_safe_status(result) if view == "vault" else result
        except AuthError as exc:
            raise_auth_error(exc, view)

    return router
