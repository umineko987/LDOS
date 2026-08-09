from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from gdl_backend.discovery_adapters.gallery_dl import (
    GalleryDlDiscoveryAdapter,
    PawchiveDiscoveryAdapter,
    build_gallery_dl_plan,
)
from gdl_backend.discovery_transport import DiscoveryTransport
from gdl_backend.gallery import GalleryCaptureResult
from gdl_backend.proxy import ProxyLease
from gdl_backend.schemas import SitePolicy


class _Gallery:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    async def capture(self, operation_id, **kwargs):
        self.calls.append((operation_id, kwargs))
        return self.results.pop(0)


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


class _Session:
    headers = {}

    def close(self):
        return None


def _capture(stdout, *, exit_code=0, stderr="", timed_out=False):
    return GalleryCaptureResult(
        exit_code,
        stdout,
        stderr,
        timed_out,
        "marker",
        123,
    )


class GalleryDlAdapterTests(unittest.TestCase):
    def _adapter(self, root, results, *, auth_callback=None):
        self.gallery = _Gallery(results)
        self.proxy = _Proxy()
        self.validator = _Validator()
        transport = DiscoveryTransport(
            self.gallery,
            self.proxy,
            Path(root),
            network_validator=self.validator,
            auth_failure_callback=auth_callback,
            requests_session_factory=_Session,
            curl_session_factory=_Session,
        )
        return GalleryDlDiscoveryAdapter(transport)

    def test_plan_owns_managed_protocol_and_pixiv_first_media_filter(self):
        plan = build_gallery_dl_plan(
            site="pixiv",
            range_kind="post",
            limit=5,
            range_limit=None,
            extra_args=["--filter", "rating == 'g'"],
        )
        self.assertEqual(plan.site, "pixiv")
        self.assertEqual(plan.result_limit, 5)
        self.assertEqual(
            list(plan.protocol_args),
            [
                "--dump-json",
                "--post-range",
                "1-5",
                "--filter",
                "(rating == 'g') and (num == 0)",
            ],
        )

    def test_generic_capture_preserves_candidate_order_and_transport_projection(self):
        payload = [
            [2, {"tweet_id": 2, "author": {"id": 8, "name": "second"}}],
            [2, {"tweet_id": 1, "author": {"id": 7, "name": "first"}}],
        ]
        with tempfile.TemporaryDirectory() as temporary:
            adapter = self._adapter(temporary, [_capture(json.dumps(payload))])
            result = asyncio.run(
                adapter.discover_url(
                    site="twitter",
                    url="https://x.com/search?q=fixture&f=live",
                    keyword="fixture",
                    limit=20,
                    range_kind="post",
                    range_limit=None,
                    policy=SitePolicy(proxy_mode="direct", retry_limit=0),
                    proxy_mode="direct",
                    credentials_ref=None,
                    cookies_file=None,
                    config_file=None,
                    extra_args=[],
                    timeout_seconds=30,
                )
            )

        self.assertEqual([item["id"] for item in result["candidates"]], ["2", "1"])
        self.assertEqual(result["attempts"], 1)
        self.assertEqual(result["proxy"]["used"], False)
        self.assertEqual(
            self.gallery.calls[0][1]["extra_args"],
            ["--dump-json", "--post-range", "1-20"],
        )
        self.assertEqual(
            self.validator.direct,
            ["https://x.com/search?q=fixture&f=live"],
        )

    def test_proxy_failure_rotates_before_second_gallery_capture(self):
        failed = _capture(
            json.dumps(
                [[-1, {"message": "SSLError: UNEXPECTED_EOF_WHILE_READING"}]]
            )
        )
        success = _capture(
            json.dumps(
                [
                    [
                        6,
                        "https://e-hentai.org/g/30/aaaaaaaaaa/",
                        {"gallery_id": 30, "gallery_token": "aaaaaaaaaa"},
                    ]
                ]
            )
        )
        with tempfile.TemporaryDirectory() as temporary:
            adapter = self._adapter(temporary, [failed, success])
            result = asyncio.run(
                adapter.discover_url(
                    site="exhentai",
                    url="https://e-hentai.org/?f_search=fixture",
                    keyword="fixture",
                    limit=20,
                    range_kind="child",
                    range_limit=None,
                    policy=SitePolicy(
                        proxy_mode="required",
                        retry_limit=1,
                        backoff_base_seconds=0,
                    ),
                    proxy_mode="required",
                    credentials_ref=None,
                    cookies_file=None,
                    config_file=None,
                    extra_args=[],
                    timeout_seconds=30,
                )
            )

        self.assertEqual(result["attempts"], 2)
        self.assertEqual(result["proxy"]["node_id"], "node-2")
        self.assertEqual(self.proxy.acquired[1][1]["exclude_ids"], {"node-1"})
        self.assertEqual(
            [call[1]["proxy_url"] for call in self.gallery.calls],
            ["http://127.0.0.1:29001", "http://127.0.0.1:29002"],
        )
        self.assertEqual(
            [call[2] for call in self.validator.proxied],
            ["http://127.0.0.1:29001", "http://127.0.0.1:29002"],
        )

    def test_pawchive_collaborator_widens_only_creator_directory_range(self):
        payload = [
            [
                6,
                "https://pawchive.pw/patreon/user/42",
                {
                    "id": "42",
                    "name": "Fixture",
                    "service": "patreon",
                    "ever_imported": True,
                },
            ]
        ]
        with tempfile.TemporaryDirectory() as temporary:
            generic = self._adapter(temporary, [_capture(json.dumps(payload))])
            pawchive = PawchiveDiscoveryAdapter(generic)
            result = asyncio.run(
                pawchive.search(
                    keyword="fixture",
                    limit=2,
                    policy=SitePolicy(proxy_mode="direct", retry_limit=0),
                    proxy_mode="direct",
                    credentials_ref=None,
                    cookies_file=None,
                    config_file=None,
                    extra_args=[],
                    timeout_seconds=30,
                )
            )

        self.assertEqual(result["candidate_count"], 1)
        self.assertEqual(
            self.gallery.calls[0][1]["extra_args"],
            ["--dump-json", "--child-range", "1-20"],
        )


if __name__ == "__main__":
    unittest.main()
