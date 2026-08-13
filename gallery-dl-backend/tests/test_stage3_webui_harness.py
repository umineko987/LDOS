from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from tests.stage3_webui_harness import build_harness


class Stage3WebUiHarnessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.app = build_harness(self.root, 18789)
        self.client_context = TestClient(
            self.app,
            base_url="http://127.0.0.1:18789",
        )
        self.client = self.client_context.__enter__()

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.temporary.cleanup()

    def test_real_ui_routes_and_synthetic_discovery_boundary(self):
        ui = self.client.get("/ui/")
        self.assertEqual(ui.status_code, 200)
        self.assertIn("text/html", ui.headers["content-type"])

        autocomplete = self.client.get(
            "/api/v1/search/autocomplete",
            params={"q": "stage 3"},
        )
        self.assertEqual(autocomplete.status_code, 200)
        self.assertEqual(autocomplete.json()["source"], "danbooru")

        response = self.client.post(
            "/api/v1/search",
            json={
                "keyword": "partial",
                "sites": [
                    "danbooru", "twitter", "pixiv", "exhentai", "pawchive"
                ],
                "limit": 20,
                "proxy_mode": "direct",
                "source_options": {"pixiv": {"proxy_mode": "required"}},
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(
            [item["site"] for item in payload["sources"]],
            ["danbooru", "twitter", "pixiv", "exhentai", "pawchive"],
        )
        self.assertEqual(
            [len(item["addresses"]) for item in payload["sources"]],
            [0, 1, 1, 1, 2],
        )
        self.assertEqual(len(payload["sources"][0]["weak_evidence"]), 1)
        self.assertEqual(payload["sources"][3]["status"], "partial")
        self.assertEqual(
            payload["sources"][3]["tag_facets"][0]["namespace"],
            "artist",
        )

        injected = self.client.post(
            "/api/v1/search",
            json={
                "keyword": "server-422",
                "sites": ["danbooru"],
                "limit": 20,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(injected.status_code, 422, injected.text)
        self.assertEqual(injected.json()["error"]["code"], "invalid_search_fault")
        facts = self.client.get("/__stage3__/facts").json()
        self.assertEqual(facts["search_requests"][-1]["keyword"], "server-422")
        self.assertNotIn(
            "server-422",
            [item["keyword"] for item in facts["search_calls"]],
        )

    def test_real_crawl_schema_idempotency_and_database_write(self):
        body = {
            "sources": [
                {
                    "site": "danbooru",
                    "addresses": [
                        {
                            "url": "https://danbooru.donmai.us/posts?tags=partial",
                            "id": "danbooru:artist_tag:partial",
                            "label": "partial",
                            "address_type": "artist_tag",
                        }
                    ],
                },
                {
                    "site": "exhentai",
                    "addresses": [
                        {
                            "url": "https://e-hentai.org/g/5001/a000000001/",
                            "id": "exhentai:gallery:1",
                            "label": "EH",
                            "address_type": "gallery",
                        }
                    ],
                    "eh_download": {
                        "image_mode": "original",
                        "gp_policy": "stop",
                    },
                },
            ],
            "concurrency": 7,
            "max_tasks": 321,
            "proxy_mode": "direct",
            "output_dir": "stage3-harness",
        }
        headers = {"Idempotency-Key": "stage3-harness-idempotency"}
        first = self.client.post("/api/v1/crawls", headers=headers, json=body)
        self.assertEqual(first.status_code, 202, first.text)
        second = self.client.post("/api/v1/crawls", headers=headers, json=body)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(first.json()["id"], second.json()["id"])

        facts = self.client.get("/__stage3__/facts")
        self.assertEqual(facts.status_code, 200)
        self.assertFalse(facts.json()["background_started"])
        batches = facts.json()["batches"]
        self.assertEqual(len(batches), 1)
        batch = batches[0]
        self.assertEqual([item["site"] for item in batch["sources"]], ["danbooru", "exhentai"])
        self.assertEqual(batch["concurrency"], 7)
        self.assertEqual(batch["max_tasks"], 321)
        self.assertEqual(batch["sources"][0]["addresses"][0]["address_order"], 0)
        self.assertEqual(batch["sources"][1]["addresses"][0]["address_order"], 0)


if __name__ == "__main__":
    unittest.main()
