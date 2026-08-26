from __future__ import annotations

import asyncio
from typing import Any, Callable, Literal

from fastapi import APIRouter, Depends, Query

from ..diagnostics import diagnostics_proxy_health_snapshot
from ..proxy import ProxyPoolConflict, ProxyPoolError
from ..proxy_source_store import (
    MAX_INLINE_NODES,
    MAX_SUBSCRIPTIONS,
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


ProxyResponseView = Literal["legacy", "desktop"]
_DESKTOP_PROXY_NODE_ROWS = 500


def _desktop_proxy_node(node: dict[str, Any]) -> dict[str, Any]:
    tags = node.get("tags")
    return {
        "id": str(node.get("id") or "")[:128],
        "name": redact_text(node.get("name") or "", limit=80),
        "protocol": str(node.get("protocol") or "")[:24],
        "endpoint": redact_text(node.get("endpoint") or "", limit=240),
        "tags": [redact_text(tag, limit=32) for tag in tags[:16]]
        if isinstance(tags, list)
        else [],
        "healthy": node.get("healthy") is True,
        "retry_eligible": node.get("retry_eligible") is True,
        "ref_count": node.get("ref_count"),
        "success_count": node.get("success_count"),
        "fail_count": node.get("fail_count"),
        "last_latency_ms": node.get("last_latency_ms"),
        "cooldown_until": node.get("cooldown_until"),
        "last_error": redact_text(node.get("last_error") or "", limit=300),
    }


def _desktop_proxy_status(status: dict[str, Any]) -> dict[str, Any]:
    result = {
        field: status.get(field)
        for field in (
            "enabled",
            "engine",
            "managed_by_backend",
            "auto_start",
            "running",
            "total",
            "healthy",
            "retry_eligible",
            "leases",
            "configured_revision",
            "active_revision",
            "reload_required",
        )
    }
    result["last_error"] = redact_text(status.get("last_error") or "", limit=500)
    core = status.get("transport_core")
    result["transport_core"] = (
        {
            "enabled": core.get("enabled"),
            "running": core.get("running"),
            "listeners": core.get("listeners"),
            "last_error": redact_text(core.get("last_error") or "", limit=300),
        }
        if isinstance(core, dict)
        else {}
    )
    sources = status.get("sources")
    warnings = sources.get("warnings") if isinstance(sources, dict) else None
    result["sources"] = (
        {
            field: sources.get(field)
            for field in (
                "subscriptions",
                "source_nodes",
                "pool_nodes",
                "core_candidates",
                "core_nodes",
                "skipped_nodes",
            )
        }
        if isinstance(sources, dict)
        else {}
    )
    result["sources"]["warnings"] = (
        [redact_text(warning, limit=300) for warning in warnings[:20]]
        if isinstance(warnings, list)
        else []
    )
    nodes = status.get("nodes")
    result["nodes"] = [
        _desktop_proxy_node(node)
        for node in (nodes[:_DESKTOP_PROXY_NODE_ROWS] if isinstance(nodes, list) else [])
        if isinstance(node, dict)
    ]
    result["node_rows_total"] = len(nodes) if isinstance(nodes, list) else 0
    result["node_rows_truncated"] = (
        isinstance(nodes, list) and len(nodes) > _DESKTOP_PROXY_NODE_ROWS
    )
    result["response_profile"] = "desktop-proxy-v1"
    return result

def _desktop_proxy_sources(snapshot: dict[str, Any]) -> dict[str, Any]:
    subscriptions = snapshot.get("subscriptions")
    subscription_rows = subscriptions if isinstance(subscriptions, list) else []
    inline_nodes = snapshot.get("inline_nodes")
    inline_rows = inline_nodes if isinstance(inline_nodes, list) else []
    node_file = snapshot.get("node_file")
    counts = snapshot.get("counts")
    return {
        "response_profile": "desktop-proxy-sources-v1",
        "source": str(snapshot.get("source") or "none")[:32],
        "has_runtime_override": snapshot.get("has_runtime_override") is True,
        "runtime_override_valid": snapshot.get("runtime_override_valid") is True,
        "configured_revision": str(snapshot.get("configured_revision") or "")[:64],
        "active_revision": (
            str(snapshot.get("active_revision"))[:64]
            if snapshot.get("active_revision") is not None
            else None
        ),
        "reload_required": snapshot.get("reload_required") is True,
        "subscriptions": [
            {
                "id": str(item.get("id") or "")[:80],
                "source": str(item.get("source") or "none")[:32],
                "scheme": str(item.get("scheme") or "https")[:8],
                "host": str(item.get("host") or "")[:253],
                "port": item.get("port"),
                "credentials_redacted": item.get("credentials_redacted") is True,
                "sensitive_parts_redacted": (
                    item.get("sensitive_parts_redacted") is True
                ),
            }
            for item in subscription_rows[:MAX_SUBSCRIPTIONS]
            if isinstance(item, dict)
        ],
        "node_file": {
            "configured": node_file.get("configured") is True,
            "source": str(node_file.get("source") or "none")[:32],
            "display_path": (
                str(node_file.get("display_path"))[:240]
                if node_file.get("display_path") is not None
                else None
            ),
        }
        if isinstance(node_file, dict)
        else {"configured": False, "source": "none", "display_path": None},
        "inline_nodes": [
            {
                "id": str(item.get("id") or "")[:80],
                "source": str(item.get("source") or "none")[:32],
                "scheme": str(item.get("scheme") or "unknown")[:24],
                "name": redact_text(item.get("name") or "", limit=80),
                "host": str(item.get("host") or "")[:253],
                "port": item.get("port"),
                "requires_transport_core": (
                    item.get("requires_transport_core") is True
                ),
            }
            for item in inline_rows[:MAX_INLINE_NODES]
            if isinstance(item, dict)
        ],
        "counts": {
            key: counts.get(key)
            for key in ("subscriptions", "node_file", "inline_nodes", "total")
        }
        if isinstance(counts, dict)
        else {},
        "subscription_rows_truncated": len(subscription_rows) > MAX_SUBSCRIPTIONS,
        "inline_node_rows_truncated": len(inline_rows) > MAX_INLINE_NODES,
    }


def _desktop_proxy_operation() -> dict[str, str]:
    return {"response_profile": "desktop-proxy-operation-v1"}


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
    *,
    view: ProxyResponseView = "legacy",
) -> dict[str, Any]:
    try:
        snapshot = await asyncio.to_thread(call)
    except ProxySourceStoreError as exc:
        raise_proxy_source_error(exc)
        raise AssertionError("unreachable")
    if view == "desktop":
        return _desktop_proxy_operation()
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
    async def proxy_sources(
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        snapshot = await proxy_sources_response(container)
        return _desktop_proxy_sources(snapshot) if view == "desktop" else snapshot

    @router.post("/proxy/sources/subscriptions")
    async def add_proxy_subscription(
        body: ProxySubscriptionUpdate,
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.add_subscription(body.url),
            view=view,
        )

    @router.put("/proxy/sources/subscriptions/{source_id}")
    async def replace_proxy_subscription(
        source_id: str,
        body: ProxySubscriptionUpdate,
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.replace_subscription(source_id, body.url),
            view=view,
        )

    @router.delete("/proxy/sources/subscriptions/{source_id}")
    async def delete_proxy_subscription(
        source_id: str,
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.delete_subscription(source_id),
            view=view,
        )

    @router.put("/proxy/sources/node-file")
    async def set_proxy_node_file(
        body: ProxyNodeFileUpdate,
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.set_node_file(body.path),
            view=view,
        )

    @router.delete("/proxy/sources/node-file")
    async def clear_proxy_node_file(
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        return await proxy_source_change(
            container,
            container.proxy_sources.clear_node_file,
            view=view,
        )

    @router.post("/proxy/sources/inline-nodes")
    async def add_proxy_inline_nodes(
        body: ProxyInlineNodesCreate,
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.add_inline_nodes(body.nodes),
            view=view,
        )

    @router.put("/proxy/sources/inline-nodes/{source_id}")
    async def replace_proxy_inline_node(
        source_id: str,
        body: ProxyInlineNodeUpdate,
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
        _body_limit: None = Depends(enforce_proxy_source_body_limit),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.replace_inline_node(source_id, body.node),
            view=view,
        )

    @router.delete("/proxy/sources/inline-nodes/{source_id}")
    async def delete_proxy_inline_node(
        source_id: str,
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        return await proxy_source_change(
            container,
            lambda: container.proxy_sources.delete_inline_node(source_id),
            view=view,
        )

    @router.delete("/proxy/sources/override")
    async def reset_proxy_sources_override(
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        return await proxy_source_change(
            container,
            container.proxy_sources.reset_override,
            view=view,
        )

    @router.get("/proxy/status")
    async def proxy_status(
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        health_loop = diagnostics_proxy_health_snapshot(
            container.proxy_health_summary()
        )
        status = await asyncio.to_thread(container.proxy.status)
        response = {**status, "health_loop": health_loop}
        return _desktop_proxy_status(response) if view == "desktop" else response

    @router.post("/proxy/start")
    async def proxy_start(
        body: ProxyStartRequest,
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        response = await proxy_action(
            lambda: container.proxy.start(
                force_refresh=body.force_refresh,
                probe_url=body.probe_url,
            )
        )
        return _desktop_proxy_operation() if view == "desktop" else response

    @router.post("/proxy/reload")
    async def proxy_reload(
        body: ProxyStartRequest,
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        response = await proxy_action(
            lambda: container.proxy.reload(
                force_refresh=body.force_refresh,
                probe_url=body.probe_url,
            )
        )
        return _desktop_proxy_operation() if view == "desktop" else response

    @router.post("/proxy/stop")
    async def proxy_stop(
        body: ProxyStopRequest,
        view: ProxyResponseView = Query("legacy"),
        container: Any = Depends(get_service),
    ):
        response = await proxy_action(lambda: container.proxy.stop(force=body.force))
        return _desktop_proxy_operation() if view == "desktop" else response

    @router.post("/proxy/probe")
    async def proxy_probe(
        body: ProxyProbeRequest,
        view: ProxyResponseView = Query("legacy"),
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
        response = await proxy_action(
            lambda: container.proxy.probe(target_url=target, node_id=body.node_id)
        )
        return _desktop_proxy_operation() if view == "desktop" else response

    return router
