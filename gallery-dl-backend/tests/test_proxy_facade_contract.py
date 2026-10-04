from __future__ import annotations

import json
import tempfile
import time
import unittest
from collections.abc import Collection
from pathlib import Path
from unittest.mock import Mock, patch

from gdl_backend import proxy as proxy_module
from gdl_backend.proxy import ProxyLease, ProxyPoolAdapter
from gdl_backend.proxy_pool import ProxyPoolCoordinator
from gdl_backend.proxy_runtime import NativeProxyPool
from gdl_backend.proxy_source_store import snapshot_from_settings

from tests.helpers import make_settings

def _healthy_probe(adapter: ProxyPoolAdapter) -> dict[str, object]:
    for record in adapter._records:
        record.healthy = True
    return {
        "total": len(adapter._records),
        "healthy": len(adapter._records),
        "results": [],
        "target": "https://example.invalid/",
        "cached": False,
    }


class ProxyFacadeContractTests(unittest.TestCase):
    """Characterize lifecycle, lease, probe and public DTO boundaries."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temporary.name))
        self.settings.proxy.enabled = True
        self.settings.proxy.inline_nodes = [
            "http://127.0.0.1:18080#JP",
            "http://127.0.0.1:18081#HK",
        ]
        self.adapter = ProxyPoolAdapter(self.settings.proxy, self.settings.runtime_dir)

    def tearDown(self) -> None:
        try:
            self.adapter.stop(force=True)
        except Exception:
            pass
        self.temporary.cleanup()

    def test_facade_is_thin_and_runtime_dependencies_are_instance_scoped(self):
        self.assertIs(ProxyPoolAdapter.__mro__[1], ProxyPoolCoordinator)
        public_implementations = {
            name
            for name, value in ProxyPoolAdapter.__dict__.items()
            if not name.startswith("_") and callable(value)
        }
        self.assertEqual(public_implementations, set())
        second = ProxyPoolAdapter(self.settings.proxy, self.settings.runtime_dir)
        try:
            self.assertIsNot(
                self.adapter._runtime_adapter,
                second._runtime_adapter,
            )
            self.assertIsNot(self.adapter._lock, second._lock)
            self.assertIsNot(self.adapter._lifecycle_lock, second._lifecycle_lock)
        finally:
            second.stop(force=True)

    def test_start_and_status_keep_exact_public_allowlists_and_redaction(self):
        self.settings.proxy.inline_nodes = [
            "http://user:password@127.0.0.1:18080#JP-SECRET-NODE"
        ]
        self.adapter = ProxyPoolAdapter(self.settings.proxy, self.settings.runtime_dir)
        self.adapter.probe = lambda **_kwargs: _healthy_probe(self.adapter)
        started = self.adapter.start(force_refresh=True)

        self.assertEqual(set(started), {"start", "probe", "status"})
        self.assertEqual(set(started["start"]), {"engine", "nodes"})
        status = started["status"]
        self.assertEqual(
            set(status),
            {
                "enabled",
                "engine",
                "managed_by_backend",
                "auto_start",
                "executable_required",
                "running",
                "configured_revision",
                "active_revision",
                "reload_required",
                "total",
                "healthy",
                "retry_eligible",
                "leases",
                "last_error",
                "transport_core",
                "sources",
                "probe_cache",
                "nodes",
            },
        )
        self.assertEqual(
            set(status["nodes"][0]),
            {
                "id",
                "name",
                "protocol",
                "endpoint",
                "healthy",
                "retry_eligible",
                "ref_count",
                "success_count",
                "fail_count",
                "last_latency_ms",
                "cooldown_until",
                "last_error",
                "tags",
            },
        )
        self.assertEqual(set(status["probe_cache"]), {"entries", "ttl_seconds"})
        self.assertEqual(
            set(status["sources"]),
            {
                "subscriptions",
                "source_nodes",
                "pool_nodes",
                "core_candidates",
                "core_nodes",
                "skipped_nodes",
                "scheme_counts",
                "warnings",
            },
        )
        rendered = json.dumps(started, ensure_ascii=False)
        self.assertNotIn("user", rendered)
        self.assertNotIn("password", rendered)
        self.assertNotIn("POOL_SECRET", rendered)
        self.assertEqual(status["nodes"][0]["endpoint"], "http://***@127.0.0.1:18080")

    def test_start_reload_and_stop_preserve_snapshot_and_side_effect_order(self):
        events: list[str] = []
        snapshot = snapshot_from_settings(self.settings.proxy)

        class Provider:
            def __init__(self) -> None:
                self.calls = 0

            def snapshot(self):
                self.calls += 1
                events.append("source.snapshot")
                return snapshot

        class ObservedPool:
            def __init__(self, endpoints) -> None:
                self.endpoints = list(endpoints)
                events.append("pool.create")

            def status(self):
                return {endpoint: {"leased": False, "cooldown_left": 0.0} for endpoint in self.endpoints}

            def close(self) -> None:
                events.append("pool.close")

        provider = Provider()
        adapter = ProxyPoolAdapter(
            self.settings.proxy,
            self.settings.runtime_dir,
            source_provider=provider,
        )
        original_collect = adapter._collect_nodes
        original_status = adapter.status

        def collect(*, force_refresh, snapshot=None):
            events.append("source.fetch_parse")
            return original_collect(force_refresh=force_refresh, snapshot=snapshot)

        def probe(**_kwargs):
            events.append("probe")
            return _healthy_probe(adapter)

        def status(*, _configured_snapshot=None):
            events.append("status")
            return original_status(_configured_snapshot=_configured_snapshot)

        with (
            patch.object(adapter, "_collect_nodes", side_effect=collect),
            patch("gdl_backend.proxy.NativeProxyPool", ObservedPool),
            patch.object(adapter, "probe", side_effect=probe),
            patch.object(adapter, "status", side_effect=status),
        ):
            started = adapter.start(force_refresh=True)
            self.assertTrue(started["status"]["running"])
            self.assertEqual(provider.calls, 1)
            self.assertEqual(
                events,
                ["source.snapshot", "source.fetch_parse", "pool.create", "probe", "status"],
            )
            events.clear()
            adapter.stop(_configured_snapshot=snapshot)
            self.assertEqual(events, ["pool.close", "status"])

        reload_events: list[tuple[str, object]] = []
        with (
            patch.object(
                adapter,
                "stop",
                side_effect=lambda *, force=False, _configured_snapshot=None: reload_events.append(
                    ("stop", _configured_snapshot)
                ) or {"running": False},
            ),
            patch.object(
                adapter,
                "start",
                side_effect=lambda *, force_refresh=True, probe_url=None, _source_snapshot=None: reload_events.append(
                    ("start", _source_snapshot)
                ) or {"status": {"running": True}},
            ),
        ):
            before = provider.calls
            adapter.reload(force_refresh=False, probe_url="https://example.com/health")
        self.assertEqual(provider.calls - before, 1)
        self.assertEqual([name for name, _ in reload_events], ["stop", "start"])
        self.assertIs(reload_events[0][1], reload_events[1][1])
        self.assertEqual(reload_events[0][1].configured_revision, snapshot.configured_revision)

    def test_probe_request_result_and_pool_update_order_are_stable(self):
        self.adapter.probe = lambda **_kwargs: _healthy_probe(self.adapter)
        self.adapter.start(force_refresh=True)
        del self.adapter.probe
        events: list[str] = []

        class Response:
            status_code = 204

            def close(self) -> None:
                events.append("response.close")

        original_mark = self.adapter._pool.mark

        def mark(*args, **kwargs) -> None:
            events.append("pool.mark")
            original_mark(*args, **kwargs)

        self.adapter._pool.mark = mark
        with patch(
            "gdl_backend.proxy.requests.get",
            side_effect=lambda *args, **kwargs: events.append("requests.get") or Response(),
        ) as request:
            record = self.adapter._records[0]
            result = self.adapter._probe_endpoint(
                record.id,
                record.endpoint,
                "https://probe.example/private?token=SECRET",
            )

        self.assertEqual(events, ["requests.get", "response.close", "pool.mark"])
        self.assertEqual(
            set(result),
            {"id", "healthy", "latency_ms", "error", "endpoint", "target"},
        )
        self.assertEqual(result["target"], "https://probe.example/private")
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertEqual(
            request.call_args.kwargs["proxies"],
            {"http": record.endpoint, "https": record.endpoint},
        )
        self.assertFalse(request.call_args.kwargs["allow_redirects"])
        self.assertTrue(request.call_args.kwargs["stream"])

    def test_authenticated_acquire_and_release_order_preserves_fault_penalty(self):
        self.settings.proxy.inline_nodes = [
            "http://user:password@127.0.0.1:18082#AUTH"
        ]
        self.adapter = ProxyPoolAdapter(self.settings.proxy, self.settings.runtime_dir)
        self.adapter.probe = lambda **_kwargs: _healthy_probe(self.adapter)
        self.adapter.start(force_refresh=True)
        events: list[str] = []

        class Forwarder:
            def __init__(self, upstream: str) -> None:
                self.upstream = upstream
                events.append("forwarder.create")

            def start(self) -> str:
                events.append("forwarder.start")
                return "http://127.0.0.1:39000"

            def stop(self) -> None:
                events.append("forwarder.stop")

        original_release = self.adapter._pool.release

        def pool_release(*args, **kwargs):
            events.append("pool.release")
            return original_release(*args, **kwargs)

        self.adapter._pool.release = pool_release
        with patch("gdl_backend.proxy.LocalHTTPForwarder", Forwarder):
            lease = self.adapter.acquire("contract-task")
            self.assertIsNotNone(lease)
            self.assertEqual(events, ["forwarder.create", "forwarder.start"])
            self.assertEqual(lease.endpoint, "http://127.0.0.1:39000")
            record = self.adapter._record_by_id[lease.node_id]
            before_failures = record.fail_count
            self.adapter.release(
                "contract-task",
                proxy_fault=True,
                reason="proxy password=SHOULD_NOT_ESCAPE failed",
            )

        self.assertEqual(events[-2:], ["forwarder.stop", "pool.release"])
        self.assertEqual(record.fail_count, before_failures + 1)
        self.assertFalse(record.healthy)
        self.assertGreaterEqual(record.cooldown_until, time.time())
        self.assertNotIn("SHOULD_NOT_ESCAPE", self.adapter.status()["nodes"][0]["last_error"])
        self.assertEqual(self.adapter.active_leases, 0)


if __name__ == "__main__":
    unittest.main()
