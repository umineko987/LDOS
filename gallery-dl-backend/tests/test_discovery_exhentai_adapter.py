from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from gdl_backend.discovery_adapters.exhentai import ExHentaiDiscoveryAdapter
from gdl_backend.discovery_transport import DiscoveryTransport
from gdl_backend.schemas import SitePolicy


class _Gallery:
    async def capture(self, *_args, **_kwargs):
        raise AssertionError("adapter test must use the injected collaborator")


class _Proxy:
    def acquire(self, *_args, **_kwargs):
        return None

    def release(self, *_args, **_kwargs):
        return None


class _Validator:
    def __init__(self):
        self.direct_calls = []

    def validate_direct(self, url):
        self.direct_calls.append(url)
        return ("1.1.1.1",)

    def validate_proxy(self, *_args):
        raise AssertionError("direct adapter test must not validate a proxy")


class _Response:
    status_code = 200
    text = ""

    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class _Session:
    def __init__(self):
        self.headers = {}
        self.calls = []
        self.closed = False

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return _Response(
            {
                "gmetadata": [
                    {
                        "gid": gid,
                        "token": token,
                        "title": f"Gallery &amp; {gid}",
                        "thumb": f"https://ehgt.org/{gid}.webp",
                        "filecount": "7",
                        "uploader": "fixture",
                        "tags": ["artist:fixture"],
                    }
                    for gid, token in kwargs["json"]["gidlist"]
                ]
            }
        )

    def close(self):
        self.closed = True


class ExHentaiAdapterTests(unittest.TestCase):
    def _adapter(self, root, discover):
        self.validator = _Validator()
        self.session = _Session()
        transport = DiscoveryTransport(
            _Gallery(),
            _Proxy(),
            Path(root),
            network_validator=self.validator,
            requests_session_factory=lambda: self.session,
            curl_session_factory=lambda: self.session,
        )
        return ExHentaiDiscoveryAdapter(
            transport,
            gallery_discover=discover,
        )

    def test_gallery_address_forces_single_file_probe_before_generic_transport(self):
        discover = AsyncMock(return_value={"candidate_count": 1})
        with tempfile.TemporaryDirectory() as temporary:
            adapter = self._adapter(temporary, discover)
            result = asyncio.run(
                adapter.discover_url(
                    url="https://e-hentai.org/g/30/aaaaaaaaaa/",
                    keyword=None,
                    limit=20,
                    range_kind=None,
                    policy=SitePolicy(proxy_mode="direct"),
                    proxy_mode="direct",
                    credentials_ref=None,
                    cookies_file=None,
                    config_file=None,
                    extra_args=[],
                    timeout_seconds=30,
                )
            )

        self.assertEqual(result, {"candidate_count": 1})
        self.assertEqual(discover.await_args.kwargs["site"], "exhentai")
        self.assertEqual(discover.await_args.kwargs["range_kind"], "file")
        self.assertEqual(discover.await_args.kwargs["limit"], 1)

    def test_preview_batches_keep_order_aliases_and_one_direct_validation(self):
        discover = AsyncMock()
        candidates = [
            {
                "id": str(gid),
                "url": f"https://e-hentai.org/g/{gid}/token{gid}/",
                "metadata": {"gallery_token": f"token{gid}"},
                "matched_keywords": ["fixture", "別名"],
            }
            for gid in range(1, 31)
        ]
        result = {
            "search_url": "https://e-hentai.org/?f_search=fixture",
            "candidates": candidates,
            "authors": [],
        }
        with tempfile.TemporaryDirectory() as temporary:
            adapter = self._adapter(temporary, discover)
            enriched = asyncio.run(
                adapter.enrich_previews(
                    result,
                    policy=SitePolicy(
                        proxy_mode="direct",
                        retry_limit=0,
                        http_timeout=10,
                    ),
                    proxy_mode="direct",
                    timeout_seconds=30,
                )
            )

        self.assertEqual(len(self.session.calls), 2)
        self.assertEqual(
            [len(call[1]["json"]["gidlist"]) for call in self.session.calls],
            [25, 5],
        )
        self.assertEqual(
            self.validator.direct_calls,
            ["https://api.e-hentai.org/api.php"],
        )
        self.assertEqual(
            [item["id"] for item in enriched["candidates"]],
            [str(gid) for gid in range(1, 31)],
        )
        self.assertEqual(enriched["candidates"][0]["title"], "Gallery & 1")
        self.assertEqual(
            enriched["candidates"][0]["matched_keywords"],
            ["fixture", "別名"],
        )
        self.assertEqual(enriched["preview_count"], 30)
        self.assertEqual(enriched["preview_missing_count"], 0)
        self.assertTrue(self.session.closed)


if __name__ == "__main__":
    unittest.main()
