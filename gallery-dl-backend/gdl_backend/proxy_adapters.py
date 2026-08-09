from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import ProxySettings
from .proxy_core import TunnelTransportCore
from .proxy_runtime import LocalHTTPForwarder, NativeProxyPool
from .proxy_source_store import (
    ProxySourceProviderLike,
    ProxySourceSnapshot,
)
from .proxy_sources import ParsedProxyNode


@dataclass(frozen=True, slots=True)
class ProxyRuntimeBindings:
    """Late-bound external dependencies; callers can inject per-adapter instances."""

    snapshot_from_settings: Callable[[ProxySettings], ProxySourceSnapshot]
    fetch_subscriptions: Callable[..., tuple[list[ParsedProxyNode], list[str]]]
    read_proxy_node_file: Callable[[Path], tuple[str, list[ParsedProxyNode]]]
    parse_subscription_text: Callable[[str], list[ParsedProxyNode]]
    create_native_pool: Callable[[Iterable[str]], NativeProxyPool]
    create_forwarder: Callable[[str], LocalHTTPForwarder]
    create_transport_core: Callable[..., TunnelTransportCore]
    requests_get: Callable[..., Any]


class ProxyRuntimeAdapter:
    """External boundary for managed sources, transport runtimes and HTTP probes."""

    def __init__(self, bindings: ProxyRuntimeBindings) -> None:
        self._bindings = bindings

    def source_snapshot(
        self,
        settings: ProxySettings,
        provider: ProxySourceProviderLike | None,
    ) -> ProxySourceSnapshot:
        if provider is None:
            return self._bindings.snapshot_from_settings(settings)
        return provider() if callable(provider) else provider.snapshot()

    def load_source_nodes(
        self,
        snapshot: ProxySourceSnapshot,
        *,
        subscription_timeout_seconds: float,
        warning_projector: Callable[[object], str],
    ) -> tuple[list[ParsedProxyNode], list[str]]:
        parsed_nodes: list[ParsedProxyNode] = []
        warnings: list[str] = []
        if snapshot.subscription_urls:
            try:
                remote_nodes, remote_warnings = self._bindings.fetch_subscriptions(
                    snapshot.subscription_urls,
                    timeout=subscription_timeout_seconds,
                    max_workers=min(8, max(1, len(snapshot.subscription_urls))),
                )
            except ValueError as exc:
                # Remote subscriptions are optional only when another explicit
                # source exists; this preserves the facade's all-remote failure.
                if not snapshot.node_file and not snapshot.inline_nodes:
                    raise
                remote_nodes, remote_warnings = [], [warning_projector(exc)]
            parsed_nodes.extend(remote_nodes)
            warnings.extend(remote_warnings)
        if snapshot.node_file:
            _, file_nodes = self._bindings.read_proxy_node_file(snapshot.node_file)
            parsed_nodes.extend(file_nodes)
        if snapshot.inline_nodes:
            parsed_nodes.extend(
                self._bindings.parse_subscription_text(
                    "\n".join(snapshot.inline_nodes)
                )
            )
        return parsed_nodes, warnings

    def create_native_pool(self, endpoints: Iterable[str]) -> NativeProxyPool:
        return self._bindings.create_native_pool(endpoints)

    def create_forwarder(self, endpoint: str) -> LocalHTTPForwarder:
        return self._bindings.create_forwarder(endpoint)

    def create_transport_core(
        self,
        *,
        binary_path: Path | str | None,
        expected_sha256: str,
        runtime_dir: Path,
        base_port: int,
        start_timeout_seconds: float,
    ) -> TunnelTransportCore:
        return self._bindings.create_transport_core(
            binary_path=binary_path,
            expected_sha256=expected_sha256,
            runtime_dir=runtime_dir,
            base_port=base_port,
            start_timeout_seconds=start_timeout_seconds,
        )

    def probe_http_status(
        self,
        target_url: str,
        *,
        endpoint: str,
        timeout_seconds: float,
    ) -> int:
        response = self._bindings.requests_get(
            target_url,
            proxies={"http": endpoint, "https": endpoint},
            headers={"User-Agent": "gallery-dl-backend-probe/1.0"},
            timeout=timeout_seconds,
            allow_redirects=False,
            stream=True,
        )
        status_code = int(response.status_code)
        response.close()
        return status_code
