from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from gdl_backend.discovery_contracts import DiscoveryError
from gdl_backend.discovery_transport import AttemptFailure, DiscoveryTransport
from gdl_backend.proxy import ProxyLease
from gdl_backend.schemas import SitePolicy


class _Gallery:
    def __init__(self):
        self.calls = []

    async def capture(self, operation_id, **kwargs):
        self.calls.append((operation_id, kwargs))
        return {"operation_id": operation_id, **kwargs}


class _Proxy:
    def __init__(self, count=2):
        self.node_ids = [f"node-{index}" for index in range(1, count + 1)]
        self.acquired = []
        self.released = []

    def acquire(self, operation_id, **kwargs):
        excluded = set(kwargs.get("exclude_ids") or ())
        self.acquired.append((operation_id, {**kwargs, "exclude_ids": excluded}))
        node_id = next((value for value in self.node_ids if value not in excluded), None)
        if node_id is None:
            return None
        index = self.node_ids.index(node_id) + 1
        return ProxyLease(
            task_id=operation_id,
            node_id=node_id,
            endpoint=f"http://user:password@proxy-{index}.example:{29000 + index}",
            name=f"proxy-{index}.example:{29000 + index}",
            protocol="http",
            tags=["fixture"],
            acquired_at=1.0,
        )

    def release(self, operation_id, **kwargs):
        self.released.append((operation_id, kwargs))


class _Validator:
    def __init__(self):
        self.direct = []
        self.proxied = []

    def validate_direct(self, url):
        self.direct.append(url)
        return ("1.1.1.1",)

    def validate_proxy(self, url, lease):
        self.proxied.append((url, lease.node_id, lease.endpoint))
        return ("1.1.1.1",)


class _Response:
    status_code = 200
    text = "fixture"

    def json(self):
        return {"ok": True}


class _Session:
    def __init__(self):
        self.headers = {}
        self.trust_env = True
        self.calls = []
        self.closed = False

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return _Response()

    def close(self):
        self.closed = True


class DiscoveryTransportTests(unittest.TestCase):
    def _transport(self, root, *, proxy=None, validator=None, auth_callback=None):
        self.session = _Session()
        return DiscoveryTransport(
            _Gallery(),
            proxy or _Proxy(),
            Path(root),
            network_validator=validator or _Validator(),
            auth_failure_callback=auth_callback,
            requests_session_factory=lambda: self.session,
            curl_session_factory=lambda: self.session,
        )

    def test_retry_rotates_lease_and_reuses_it_for_doh_and_operation(self):
        proxy = _Proxy()
        validator = _Validator()
        seen = []
        with tempfile.TemporaryDirectory() as temporary:
            transport = self._transport(temporary, proxy=proxy, validator=validator)

            async def operation(attempt):
                seen.append((attempt.attempt, attempt.lease.node_id, attempt.lease.endpoint))
                if attempt.attempt == 1:
                    raise AttemptFailure(
                        "proxy-1.example:29001 TLS failure",
                        retryable=True,
                        proxy_fault=True,
                    )
                return "ok"

            result = asyncio.run(
                transport.execute_with_retries(
                    target_url="https://example.test/search",
                    policy=SitePolicy(
                        proxy_mode="required",
                        retry_limit=1,
                        backoff_base_seconds=0,
                    ),
                    proxy_mode="required",
                    operation_prefix="fixture",
                    secure_target=True,
                    operation=operation,
                    classify_exception=lambda exc, _attempt: AttemptFailure(str(exc)),
                )
            )

        self.assertEqual(result.value, "ok")
        self.assertEqual(result.attempts, 2)
        self.assertEqual([item[1] for item in seen], ["node-1", "node-2"])
        self.assertEqual(
            [item[1] for item in validator.proxied],
            ["node-1", "node-2"],
        )
        self.assertEqual(proxy.acquired[1][1]["exclude_ids"], {"node-1"})
        self.assertTrue(proxy.released[0][1]["proxy_fault"])
        self.assertFalse(proxy.released[1][1]["proxy_fault"])
        self.assertNotIn("proxy-1.example", proxy.released[0][1]["reason"])
        self.assertNotIn("29001", proxy.released[0][1]["reason"])

    def test_secure_proxy_target_never_falls_back_without_a_lease(self):
        proxy = _Proxy(count=0)
        with tempfile.TemporaryDirectory() as temporary:
            transport = self._transport(temporary, proxy=proxy)
            operation_called = False

            async def operation(_attempt):
                nonlocal operation_called
                operation_called = True

            with self.assertRaises(DiscoveryError) as caught:
                asyncio.run(
                    transport.execute_with_retries(
                        target_url="https://example.test/search",
                        policy=SitePolicy(proxy_mode="prefer", retry_limit=0),
                        proxy_mode="prefer",
                        operation_prefix="fixture",
                        secure_target=True,
                        operation=operation,
                        classify_exception=lambda exc, _attempt: AttemptFailure(str(exc)),
                    )
                )

        self.assertEqual(caught.exception.code, "proxy_dns_failed")
        self.assertFalse(operation_called)

    def test_http_session_applies_safe_defaults_and_injected_proxy(self):
        with tempfile.TemporaryDirectory() as temporary:
            transport = self._transport(temporary)
            with transport.http_session(
                backend="requests",
                proxy_url="http://127.0.0.1:29001",
            ) as session:
                response = session.request_json(
                    "post",
                    "https://example.test/api",
                    json_body={"fixture": True},
                    timeout=0.1,
                )

        self.assertEqual(response.payload, {"ok": True})
        self.assertFalse(self.session.trust_env)
        self.assertEqual(self.session.headers["User-Agent"], "gallery-dl-backend/0.3")
        call = self.session.calls[0]
        self.assertEqual(
            call[1]["proxies"],
            {
                "http": "http://127.0.0.1:29001",
                "https": "http://127.0.0.1:29001",
            },
        )
        self.assertEqual(call[1]["timeout"], 1.0)
        self.assertFalse(call[1]["allow_redirects"])
        self.assertTrue(call[1]["verify"])
        self.assertTrue(self.session.closed)

    def test_capture_and_auth_callbacks_stay_on_the_injected_boundary(self):
        auth_calls = []

        async def auth_callback(*args):
            auth_calls.append(args)
            return True

        with tempfile.TemporaryDirectory() as temporary:
            transport = self._transport(temporary, auth_callback=auth_callback)
            captured = asyncio.run(
                transport.capture("capture-fixture", url="https://example.test/item")
            )
            asyncio.run(
                transport.notify_auth_failure(
                    "pixiv",
                    "/private/cookies.txt",
                    "token expired",
                )
            )

        self.assertEqual(captured["operation_id"], "capture-fixture")
        self.assertEqual(transport.gallery.calls[0][1]["url"], "https://example.test/item")
        self.assertEqual(
            auth_calls,
            [("pixiv", "/private/cookies.txt", "token expired")],
        )


if __name__ == "__main__":
    unittest.main()
