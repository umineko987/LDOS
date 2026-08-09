from __future__ import annotations

from fastapi import Request

from ..auth import MAX_AUTH_PROXY_REQUEST_BYTES
from ..policy_view import MAX_POLICY_REQUEST_BYTES
from ..proxy_source_store import MAX_PROXY_SOURCE_REQUEST_BYTES
from .errors import ApiError


def content_length(request: Request) -> int | None:
    raw_length = request.headers.get("content-length")
    if raw_length is None:
        return None
    try:
        length = int(raw_length)
    except ValueError as exc:
        raise ApiError(400, "invalid_content_length", "Content-Length 无效") from exc
    if length < 0:
        raise ApiError(400, "invalid_content_length", "Content-Length 无效")
    return length


async def enforce_proxy_source_body_limit(request: Request) -> None:
    length = content_length(request)
    if length is not None and length > MAX_PROXY_SOURCE_REQUEST_BYTES:
        raise ApiError(
            413,
            "proxy_sources_request_too_large",
            "代理源请求体超过大小上限",
        )


async def enforce_auth_proxy_body_limit(request: Request) -> None:
    length = content_length(request)
    if length is not None and length > MAX_AUTH_PROXY_REQUEST_BYTES:
        raise ApiError(
            413,
            "auth_request_too_large",
            "授权代理请求体超过大小上限",
        )


async def enforce_policy_body_limit(request: Request) -> None:
    length = content_length(request)
    if length is not None and length > MAX_POLICY_REQUEST_BYTES:
        raise ApiError(
            413,
            "policy_request_too_large",
            "站点策略请求体超过大小上限",
        )
    # Do not trust the declared length. FastAPI caches the body, so checking the
    # actual bytes here does not consume it before model validation.
    if len(await request.body()) > MAX_POLICY_REQUEST_BYTES:
        raise ApiError(
            413,
            "policy_request_too_large",
            "站点策略请求体超过大小上限",
        )
