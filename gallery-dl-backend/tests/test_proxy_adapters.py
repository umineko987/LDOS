from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from gdl_backend.proxy_adapters import ProxyRuntimeAdapter, ProxyRuntimeBindings
from gdl_backend.proxy_runtime import NativeProxyPool
from gdl_backend.proxy_source_store import make_proxy_source_snapshot
from gdl_backend.proxy_sources import parse_subscription_text

from tests.helpers import make_settings


class ProxyRuntimeAdapterTests(unittest.TestCase):
    def _bindings(self, **overrides) -> ProxyRuntimeBindings:
        defaults = {
            "snapshot_from_settings": lambda settings: make_proxy_source_snapshot(
                settings.subscription_urls,
                settings.node_file,
                settings.inline_nodes,
            ),
            "fetch_subscriptions": lambda *_args, **_kwargs: ([], []),
            "read_proxy_node_file": lambda _path: ("", []),
            "parse_subscription_text": parse_subscription_text,
            "create_native_pool": NativeProxyPool,
            "create_forwarder": Mock(),
            "create_transport_core": Mock(),
            "requests_get": Mock(),
        }
        defaults.update(overrides)
        return ProxyRuntimeBindings(**defaults)

    def test_source_provider_and_fetch_parse_are_explicit_and_ordered(self):
        events: list[str] = []
        snapshot = make_proxy_source_snapshot(
            ["https://subscription.example/path/SECRET"],
            None,
            ["http://127.0.0.1:18081#INLINE"],
            source="runtime",
        )

        class Provider:
            def snapshot(self):
                events.append("provider.snapshot")
                return snapshot

        remote = parse_subscription_text("http://127.0.0.1:18080#REMOTE")

        def fetch(urls, **kwargs):
            events.append("subscriptions.fetch")
            self.assertEqual(tuple(urls), snapshot.subscription_urls)
            self.assertEqual(kwargs["max_workers"], 1)
            return remote, ["safe warning"]

        def parse(text):
            events.append("inline.parse")
            return parse_subscription_text(text)

        with tempfile.TemporaryDirectory() as temporary:
            settings = make_settings(Path(temporary)).proxy
            adapter = ProxyRuntimeAdapter(
                self._bindings(
                    fetch_subscriptions=fetch,
                    parse_subscription_text=parse,
                )
            )
            selected = adapter.source_snapshot(settings, Provider())
            nodes, warnings = adapter.load_source_nodes(
                selected,
                subscription_timeout_seconds=5,
                warning_projector=lambda _warning: "redacted warning",
            )

        self.assertEqual(
            events,
            ["provider.snapshot", "subscriptions.fetch", "inline.parse"],
        )
        self.assertEqual([node.name for node in nodes], ["REMOTE", "INLINE"])
        self.assertEqual(warnings, ["safe warning"])

    def test_remote_failure_falls_back_only_with_another_source(self):
        failing = Mock(side_effect=ValueError("https://secret.invalid/TOKEN"))
        adapter = ProxyRuntimeAdapter(self._bindings(fetch_subscriptions=failing))
        remote_only = make_proxy_source_snapshot(
            ["https://subscription.example/SECRET"],
            None,
            [],
        )
        with self.assertRaises(ValueError):
            adapter.load_source_nodes(
                remote_only,
                subscription_timeout_seconds=1,
                warning_projector=lambda _warning: "redacted",
            )
        fallback = make_proxy_source_snapshot(
            ["https://subscription.example/SECRET"],
            None,
            ["http://127.0.0.1:18080#LOCAL"],
        )
        nodes, warnings = adapter.load_source_nodes(
            fallback,
            subscription_timeout_seconds=1,
            warning_projector=lambda _warning: "redacted",
        )
        self.assertEqual(len(nodes), 1)
        self.assertEqual(warnings, ["redacted"])

    def test_requests_probe_is_single_explicit_network_implementation(self):
        events: list[str] = []

        class Response:
            status_code = 204

            def close(self) -> None:
                events.append("response.close")

        request = Mock(side_effect=lambda *_args, **_kwargs: events.append("requests.get") or Response())
        adapter = ProxyRuntimeAdapter(self._bindings(requests_get=request))
        status = adapter.probe_http_status(
            "https://probe.example/private?token=SECRET",
            endpoint="http://user:password@127.0.0.1:18080",
            timeout_seconds=3,
        )
        self.assertEqual(status, 204)
        self.assertEqual(events, ["requests.get", "response.close"])
        self.assertEqual(
            request.call_args.kwargs["proxies"],
            {
                "http": "http://user:password@127.0.0.1:18080",
                "https": "http://user:password@127.0.0.1:18080",
            },
        )
        self.assertFalse(request.call_args.kwargs["allow_redirects"])
        self.assertTrue(request.call_args.kwargs["stream"])

    def test_runtime_instances_do_not_share_pool_state(self):
        adapter = ProxyRuntimeAdapter(self._bindings())
        first = adapter.create_native_pool(["http://127.0.0.1:18080"])
        second = adapter.create_native_pool(["http://127.0.0.1:18080"])
        first_lease = first.acquire(owner="first")
        second_lease = second.acquire(owner="second")
        self.assertIsNotNone(first_lease)
        self.assertIsNotNone(second_lease)
        self.assertNotEqual(first_lease.token, second_lease.token)
        first.close()
        second.close()


if __name__ == "__main__":
    unittest.main()
