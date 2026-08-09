from __future__ import annotations

import time
from pathlib import Path

import requests

from .config import ProxySettings
from .proxy_adapters import ProxyRuntimeAdapter, ProxyRuntimeBindings
from .proxy_core import TunnelTransportCore
from .proxy_errors import ProxyPoolConflict, ProxyPoolError, ProxyPoolUnavailable
from .proxy_policy import ProxyLease, ProxyNodeRecord as _NodeRecord, mask_proxy
from .proxy_pool import ProxyPoolCoordinator
from .proxy_runtime import LocalHTTPForwarder, NativeProxyPool
from .proxy_source_store import (
    ProxySourceProviderLike,
    read_proxy_node_file,
    snapshot_from_settings,
)
from .proxy_sources import fetch_subscriptions, parse_subscription_text


class ProxyPoolAdapter(ProxyPoolCoordinator):
    """Compatibility facade with instance-scoped, explicit runtime dependencies."""

    def __init__(
        self,
        settings: ProxySettings,
        runtime_dir: Path,
        source_provider: ProxySourceProviderLike | None = None,
    ) -> None:
        runtime_adapter = ProxyRuntimeAdapter(
            ProxyRuntimeBindings(
                # Late-bound wrappers retain the historical gdl_backend.proxy patch
                # surface. They are intentionally assembled per facade instance:
                # no process-global pool, source provider or requests session exists.
                snapshot_from_settings=lambda current: snapshot_from_settings(current),
                fetch_subscriptions=lambda urls, **kwargs: fetch_subscriptions(
                    urls,
                    **kwargs,
                ),
                read_proxy_node_file=lambda path: read_proxy_node_file(path),
                parse_subscription_text=lambda text: parse_subscription_text(text),
                create_native_pool=lambda endpoints: NativeProxyPool(endpoints),
                create_forwarder=lambda endpoint: LocalHTTPForwarder(endpoint),
                create_transport_core=lambda **kwargs: TunnelTransportCore(**kwargs),
                requests_get=lambda *args, **kwargs: requests.get(*args, **kwargs),
            )
        )
        super().__init__(
            settings,
            runtime_dir,
            source_provider,
            runtime_adapter=runtime_adapter,
            wall_time=lambda: time.time(),
            monotonic_time=lambda: time.monotonic(),
        )


__all__ = [
    "ProxyLease",
    "ProxyPoolAdapter",
    "ProxyPoolConflict",
    "ProxyPoolError",
    "ProxyPoolUnavailable",
]
