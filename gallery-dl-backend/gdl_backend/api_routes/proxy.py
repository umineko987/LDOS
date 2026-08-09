from __future__ import annotations

import asyncio
from typing import Any, Callable

from fastapi import APIRouter, Depends

from ..diagnostics import diagnostics_proxy_health_snapshot
from ..proxy import ProxyPoolConflict, ProxyPoolError
from ..proxy_source_store import (
    ProxySourceNotFound,
    ProxySourcePathForbidden,
    ProxySourceSnapshot,
    ProxySourceStoreConflict,
    ProxySourceStoreCorrupt,
    ProxySourceStoreError,
    ProxySourceValidationError,
)
from ..redaction import redact_text
from ..schemas import (
    ProxyInlineNodesCreate,
    ProxyInlineNodeUpdate,
    ProxyNodeFileUpdate,
    ProxyProbeRequest,
    ProxyStartRequest,
    ProxyStopRequest,
    ProxySubscriptionUpdate,
)
from .body_limits import enforce_proxy_source_body_limit
from .dependencies import get_service
from .errors import ApiError
from .validation import validate_network_target, validate_site_name


def raise_proxy_source_error(exc: ProxySourceStoreError) -> None:
    if isinstance(exc, ProxySourceNotFound):
        raise ApiError(404, "proxy_source_not_found", exc.message) from exc
    if isinstance(exc, ProxySourcePathForbidden):
        raise ApiError(
            422,
            "proxy_source_path_forbidden",
            exc.message,
            exc.details,
        ) from exc
    if isinstance(exc, ProxySourceValidationError):
        code = {
            "subscription": "invalid_proxy_subscription",
            "inline_node": "invalid_proxy_inline_node",
            "node_file": "invalid_proxy_node_file",
            "source_id": "invalid_proxy_source_id",
        }[exc.category]
        raise ApiError(422, code, exc.message, exc.details) from exc
    if isinstance(exc, (ProxySourceStoreCorrupt, ProxySourceStoreConflict)):
        raise ApiError(
            409,
            "proxy_sources_store_error",
            exc.message,
            {"reason": exc.reason},
        ) from exc
    raise ApiError(
        503,
        "proxy_sources_store_error",
        exc.message,
        {"reason": exc.reason},
    ) from exc


async def proxy_sources_response(
    container: Any,
    snapshot: ProxySourceSnapshot | None = None,
) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(
            container.proxy_sources.public_snapshot,
            snapshot,
            active_revision=container.proxy.active_revision,
        )
    except ProxySourceStoreError as exc:
        raise_proxy_source_error(exc)
        raise AssertionError("unreachable")


async def proxy_source_change(
    container: Any,
    call: Callable[[], ProxySourceSnapshot],
) -> dict[str, Any]:
    try:
        snapshot = await asyncio.to_thread(call)
    except ProxySourceStoreError as exc:
        raise_proxy_source_error(exc)
        raise AssertionError("unreachable")
    return await proxy_sources_response(container, snapshot)


async def proxy_action(call: Callable[[], Any]) -> Any:
    try:
        return await asyncio.to_thread(call)
    except ProxyPoolConflict as exc:
        raise ApiError(409, "proxy_conflict", str(exc)) from exc
    except (ProxyPoolError, FileNotFoundError, ValueError, RuntimeError) as exc:
        raise ApiError(503, "proxy_error", redact_text(exc, limit=500)) from exc


def create_proxy_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get("/proxy/sources")
    async def proxy_sources(container: Any = Depends(get_service)):
        return await proxy_sources_response(container)

    @router.post("/proxy/sources/subscriptions")
    async def add_proxy_subscription(
        body: ProxySubscriptionUpdate,
        container: Any = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.add_subscription(body.url),
        )

    @router.put("/proxy/sources/subscriptions/{source_id}")
    async def replace_proxy_subscription(
        source_id: str,
        body: ProxySubscriptionUpdate,
        container: Any = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.replace_subscription(source_id, body.url),
        )

    @router.delete("/proxy/sources/subscriptions/{source_id}")
    async def delete_proxy_subscription(
        source_id: str,
        container: Any = Depends(get_service),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.delete_subscription(source_id),
        )

    @router.put("/proxy/sources/node-file")
    async def set_proxy_node_file(
        body: ProxyNodeFileUpdate,
        container: Any = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.set_node_file(body.path),
        )

    @router.delete("/proxy/sources/node-file")
    async def clear_proxy_node_file(container: Any = Depends(get_service)):
        return await proxy_source_change(
            container,
            container.proxy_sources.clear_node_file,
        )

    @router.post("/proxy/sources/inline-nodes")
    async def add_proxy_inline_nodes(
        body: ProxyInlineNodesCreate,
        container: Any = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.add_inline_nodes(body.nodes),
        )

    @router.put("/proxy/sources/inline-nodes/{source_id}")
    async def replace_proxy_inline_node(
        source_id: str,
        body: ProxyInlineNodeUpdate,
        container: Any = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.replace_inline_node(source_id, body.node),
        )

    @router.delete("/proxy/sources/inline-nodes/{source_id}")
    async def delete_proxy_inline_node(
        source_id: str,
        container: Any = Depends(get_service),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.delete_inline_node(source_id),
        )

    @router.delete("/proxy/sources/override")
    async def reset_proxy_sources_override(container: Any = Depends(get_service)):
        return await proxy_source_change(
            container,
            container.proxy_sources.reset_override,
        )

    @router.get("/proxy/status")
    async def proxy_status(container: Any = Depends(get_service)):
        health_loop = diagnostics_proxy_health_snapshot(
            container.proxy_health_summary()
        )
        status = await asyncio.to_thread(container.proxy.status)
        return {**status, "health_loop": health_loop}

    @router.post("/proxy/start")
    async def proxy_start(
        body: ProxyStartRequest,
        container: Any = Depends(get_service),
    ):
        return await proxy_action(
            lambda: container.proxy.start(
                force_refresh=body.force_refresh,
                probe_url=body.probe_url,
            )
        )

    @router.post("/proxy/reload")
    async def proxy_reload(
        body: ProxyStartRequest,
        container: Any = Depends(get_service),
    ):
        return await proxy_action(
            lambda: container.proxy.reload(
                force_refresh=body.force_refresh,
                probe_url=body.probe_url,
            )
        )

    @router.post("/proxy/stop")
    async def proxy_stop(
        body: ProxyStopRequest,
        container: Any = Depends(get_service),
    ):
        return await proxy_action(lambda: container.proxy.stop(force=body.force))

    @router.post("/proxy/probe")
    async def proxy_probe(
        body: ProxyProbeRequest,
        container: Any = Depends(get_service),
    ):
        target = body.target_url
        if body.site and not target:
            target = container.policy_for(validate_site_name(body.site)).probe_url
        if target:
            try:
                await asyncio.to_thread(
                    validate_network_target,
                    target,
                    container.settings.server.allow_private_targets,
                    strict=container.settings.server.strict_target_dns,
                )
            except ValueError as exc:
                raise ApiError(422, "invalid_probe_target", str(exc)) from exc
        return await proxy_action(
            lambda: container.proxy.probe(target_url=target, node_id=body.node_id)
        )

    return router
