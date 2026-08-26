from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from gdl_backend.discovery_adapters.danbooru import (
    DanbooruApiRequestError,
    DanbooruDiscoveryAdapter,
)
from gdl_backend.discovery_transport import DiscoveryTransport
from gdl_backend.proxy import ProxyLease
from gdl_backend.schemas import SitePolicy


class _Gallery:
    async def capture(self, *_args, **_kwargs):
        raise AssertionError("adapter test must use the injected gallery collaborator")


class _Proxy:
    def __init__(self):
        self.acquired = []
        self.released = []

    def acquire(self, operation_id, **kwargs):
        excluded = set(kwargs.get("exclude_ids") or ())
        self.acquired.append((operation_id, {**kwargs, "exclude_ids": excluded}))
        node_id = "node-2" if "node-1" in excluded else "node-1"
        port = 29002 if node_id == "node-2" else 29001
        return ProxyLease(
            task_id=operation_id,
            node_id=node_id,
            endpoint=f"http://127.0.0.1:{port}",
            name=node_id,
            protocol="http",
            tags=["fixture"],
            acquired_at=1.0,
        )

    def release(self, operation_id, **kwargs):
        self.released.append((operation_id, kwargs))

    def status(self):
        return {"nodes": []}


class _Validator:
    def __init__(self):
        self.proxy_calls = []

    def validate_direct(self, _url):
        return ()

    def validate_proxy(self, url, lease):
        self.proxy_calls.append((url, lease.node_id, lease.endpoint))
        return ("1.1.1.1",)


class _Session:
    headers = {}

    def close(self):
        return None


class DanbooruAdapterTests(unittest.TestCase):
    def _adapter(self, root, api_request, *, proxy=None, validator=None, discover=None):
        self.proxy = proxy or _Proxy()
        self.validator = validator or _Validator()
        self.discover = discover or AsyncMock(return_value={"candidate_count": 1})
        transport = DiscoveryTransport(
            _Gallery(),
            self.proxy,
            Path(root),
            network_validator=self.validator,
            requests_session_factory=_Session,
            curl_session_factory=_Session,
        )
        return DanbooruDiscoveryAdapter(
            transport,
            gallery_discover=self.discover,
            api_request=api_request,
        )

    def test_posts_api_preserves_before_cursor_and_result_order(self):
        first_page = [
            {"id": post_id, "tag_string_artist": "fixture"}
            for post_id in range(1000, 800, -1)
        ]
        second_page = [{"id": 800, "tag_string_artist": "fixture"}]
        calls = []

        def api_request(_url, **kwargs):
            calls.append(kwargs)
            return first_page if len(calls) == 1 else second_page

        with tempfile.TemporaryDirectory() as temporary:
            adapter = self._adapter(temporary, api_request)
            result = asyncio.run(
                adapter.search_posts_api(
                    keyword="fixture",
                    limit=201,
                    policy=SitePolicy(proxy_mode="direct", retry_limit=0),
                    proxy_mode="direct",
                )
            )

        self.assertEqual(result["candidate_count"], 201)
        self.assertEqual([item["id"] for item in result["candidates"][:2]], ["1000", "999"])
        self.assertEqual(calls[0]["params"]["limit"], 200)
        self.assertEqual(calls[1]["params"], {"tags": "fixture", "limit": 1, "page": "b801"})
        self.assertEqual(result["attempts"], 2)

    def test_proxy_fault_retries_on_a_new_lease_after_doh_validation(self):
        calls = []

        def api_request(_url, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                raise DanbooruApiRequestError(
                    "Cloudflare fixture",
                    status_code=403,
                    retryable=True,
                    proxy_fault=True,
                )
            return []

        with tempfile.TemporaryDirectory() as temporary:
            adapter = self._adapter(temporary, api_request)
            payload, proxy, attempts = asyncio.run(
                adapter.api_json(
                    "https://danbooru.donmai.us/posts.json",
                    params={"tags": "fixture"},
                    policy=SitePolicy(
                        proxy_mode="required",
                        retry_limit=1,
                        backoff_base_seconds=0,
                    ),
                    proxy_mode="required",
                )
            )

        self.assertEqual(payload, [])
        self.assertEqual(attempts, 2)
        self.assertEqual(proxy["node_id"], "node-2")
        self.assertEqual(self.proxy.acquired[1][1]["exclude_ids"], {"node-1"})
        self.assertEqual(
            [call[2] for call in self.validator.proxy_calls],
            [calls[0]["proxy_url"], calls[1]["proxy_url"]],
        )
        self.assertEqual(
            [kwargs["probe_url"] for _operation_id, kwargs in self.proxy.acquired],
            ["https://danbooru.donmai.us/", "https://danbooru.donmai.us/"],
        )
        self.assertTrue(self.proxy.released[0][1]["proxy_fault"])
        self.assertFalse(self.proxy.released[1][1]["proxy_fault"])

    def test_search_uses_gallery_first_then_native_api_fallback(self):
        discover = AsyncMock(return_value={"candidate_count": 0, "authors": []})

        def api_request(_url, **_kwargs):
            return [{"id": 9, "tag_string_artist": "fixture"}]

        with tempfile.TemporaryDirectory() as temporary:
            adapter = self._adapter(
                temporary,
                api_request,
                discover=discover,
            )
            result = asyncio.run(
                adapter.search(
                    keyword="fixture",
                    limit=20,
                    policy=SitePolicy(proxy_mode="direct", retry_limit=0),
                    proxy_mode="direct",
                    credentials_ref=None,
                    cookies_file=None,
                    config_file=None,
                    extra_args=[],
                    timeout_seconds=30,
                )
            )

        discover.assert_awaited_once()
        self.assertEqual(
            discover.await_args.kwargs["policy"].probe_url,
            "https://danbooru.donmai.us/",
        )
        self.assertEqual(result["transport"], "danbooru_api_honest_ua")
        self.assertEqual([item["id"] for item in result["candidates"]], ["9"])


if __name__ == "__main__":
    unittest.main()
