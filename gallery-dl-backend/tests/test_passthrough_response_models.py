"""crawls / tasks / discovery 的响应模型只进 OpenAPI，不改写负载。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.encoders import jsonable_encoder
from pydantic import TypeAdapter

from gdl_backend.api_routes import passthrough_models as models
from gdl_backend.api_routes.crawls import _desktop_batch_crawl, _desktop_crawl_operation
from gdl_backend.api_routes.discovery import _desktop_search_response
from gdl_backend.app import ServiceContainer, create_app
from tests.helpers import local_test_client, make_settings


def roundtrip(model, payload):
    adapter = TypeAdapter(model)
    return adapter.dump_python(adapter.validate_python(payload), mode="json", exclude_unset=True)


class PassthroughModelTest(unittest.TestCase):
    def test_values_are_not_coerced_and_extras_survive(self) -> None:
        payload = {
            "id": "t1",
            "priority": 3,
            "created_at": 1.0,
            "updated_at": 2,
            "cancel_requested": False,
            "exit_code": None,
            "policy": {"retry_limit": 2, "ratio": 0.5},
            "cookies_file": None,
            "unknown_future_field": {"nested": [1, 2.0, "x"]},
        }
        self.assertEqual(roundtrip(models.TaskResponse, payload), payload)
        # 没出现的字段不会被补成 null。
        self.assertEqual(roundtrip(models.TaskResponse, {"id": "t2"}), {"id": "t2"})

    def test_strict_types_reject_instead_of_rewriting(self) -> None:
        with self.assertRaises(Exception):
            TypeAdapter(models.TaskResponse).validate_python({"priority": "3"})

    def test_search_union_keeps_both_views(self) -> None:
        legacy = {
            "keyword": "fixture",
            "source_count": 1,
            "address_count": 1,
            "weak_evidence_count": 0,
            "sources": [
                {
                    "site": "danbooru",
                    "status": "succeeded",
                    "evidence_count": 1,
                    "addresses": [{"id": "a", "url": "https://x/1", "confidence": 0.9}],
                    "weak_evidence": [],
                    "tag_facets": [],
                }
            ],
            "related_profiles": [],
            "enrichment_errors": [],
            "selection_contract": {"field": "sources[].addresses[]"},
            "tag_filter_contract": {"source": "exhentai"},
        }
        union = models.DesktopSearchResponse | models.SearchResponse
        self.assertEqual(roundtrip(union, legacy), legacy)
        desktop = _desktop_search_response(legacy)
        self.assertEqual(roundtrip(union, desktop), jsonable_encoder(desktop))


class PassthroughRouteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.settings = make_settings(self.root)
        self.container = ServiceContainer(self.settings)
        app = create_app(self.settings, container=self.container, start_background=False)
        context = local_test_client(app, self.settings)
        self.client = context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)
        self.app = app
        self.db = self.container.db
        self.db.create_crawl_batch(
            {"id": "batch-1", "output_dir": str(self.root / "out"), "concurrency": 2, "max_tasks": 5},
            [
                {
                    "id": "address-1",
                    "site": "danbooru",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=fixture",
                    "label": "fixture",
                    "proxy_mode": "direct",
                    "max_attempts": 2,
                }
            ],
        )

    def test_crawl_routes_return_the_same_payload_as_before(self) -> None:
        legacy = self.client.get("/api/v1/crawls/batch-1")
        self.assertEqual(legacy.status_code, 200, legacy.text)
        self.assertEqual(legacy.json(), jsonable_encoder(self.db.get_crawl_batch("batch-1")))

        desktop = self.client.get("/api/v1/crawls/batch-1", params={"view": "desktop"})
        self.assertEqual(desktop.status_code, 200, desktop.text)
        self.assertEqual(
            desktop.json(), jsonable_encoder(_desktop_batch_crawl(self.db.get_crawl_batch("batch-1")))
        )

        listing = self.client.get("/api/v1/crawls").json()
        self.assertEqual(
            listing,
            {"items": jsonable_encoder(self.db.list_crawl_batches(limit=50)), "limit": 50, "offset": 0},
        )
        recent = self.client.get("/api/v1/crawls", params={"view": "desktop"}).json()["items"]
        self.assertEqual(
            set(recent[0]),
            {"id", "status", "created_at", "task_count", "succeeded_task_count", "failed_task_count"},
        )

        cancelled = self.client.post("/api/v1/crawls/batch-1/cancel", params={"view": "desktop"})
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.assertEqual(
            cancelled.json(), _desktop_crawl_operation(self.db.get_crawl_batch("batch-1"))
        )
        tasks = self.client.get("/api/v1/crawls/batch-1/tasks", params={"view": "tasks"})
        self.assertEqual(tasks.json(), {"items": [], "limit": 100, "offset": 0})

    def test_desktop_crawl_list_counts_tasks_live_with_one_query(self) -> None:
        self.db.create_crawl_batch(
            {"id": "batch-empty", "output_dir": str(self.root / "empty"), "concurrency": 1, "max_tasks": 5},
            [{
                "id": "address-empty", "site": "danbooru", "source_order": 0, "address_order": 0,
                "url": "https://danbooru.donmai.us/posts?tags=empty", "proxy_mode": "direct", "max_attempts": 1,
            }],
        )
        self.assertTrue(self.db.begin_crawl_address_planning("address-1"))
        for sequence, (task_id, status) in enumerate(
            (("task-ok", "succeeded"), ("task-bad", "failed"), ("task-wait", None)), start=1
        ):
            self.db.create_task({
                "id": task_id, "url": f"https://danbooru.donmai.us/posts/{sequence}", "site": "danbooru",
                "subcategory": "post", "extractor": "DanbooruPostExtractor",
                "output_dir": str(self.root / "out"), "proxy_mode": "direct", "max_attempts": 1,
                "policy": {"max_concurrency": 1}, "extra_args": [],
            })
            self.db.link_crawl_task("address-1", task_id, sequence)
            if status is not None:
                self.db.complete_task(task_id, status)

        calls = []
        grouped = self.db.crawl_batch_task_counts

        def counting(batch_ids):
            calls.append(list(batch_ids))
            return grouped(batch_ids)

        with patch.object(self.db, "crawl_batch_task_counts", side_effect=counting):
            response = self.client.get("/api/v1/crawls", params={"view": "desktop"})
        self.assertEqual(response.status_code, 200, response.text)
        items = {item["id"]: item for item in response.json()["items"]}
        self.assertEqual(len(calls), 1)
        self.assertEqual(sorted(calls[0]), ["batch-1", "batch-empty"])
        counts = ("task_count", "succeeded_task_count", "failed_task_count")
        self.assertEqual([items["batch-1"][key] for key in counts], [3, 1, 1])
        self.assertEqual([items["batch-empty"][key] for key in counts], [0, 0, 0])

    def test_task_and_search_site_routes_return_the_same_payload_as_before(self) -> None:
        self.assertEqual(self.client.get("/api/v1/tasks").json(), {"items": [], "limit": 50, "offset": 0})
        from gdl_backend.discovery_transforms import search_site_catalog

        self.assertEqual(
            self.client.get("/api/v1/search/sites").json(), {"items": search_site_catalog()}
        )

    def test_openapi_documents_the_models(self) -> None:
        openapi = self.app.openapi()
        schemas = openapi["components"]["schemas"]
        for name in (
            "TaskResponse",
            "TaskListResponse",
            "CrawlBatchResponse",
            "CrawlBatchListResponse",
            "CrawlBatchOperationResponse",
            "CrawlTaskListResponse",
            "DesktopSearchResponse",
            "SearchResponse",
            "SearchSiteListResponse",
        ):
            self.assertIn(name, schemas)
        crawl = openapi["paths"]["/api/v1/crawls/{batch_id}"]["get"]["responses"]["200"]
        self.assertEqual(
            crawl["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/CrawlBatchResponse",
        )
        search = openapi["paths"]["/api/v1/search"]["post"]["responses"]["200"]
        refs = {
            option["$ref"]
            for option in search["content"]["application/json"]["schema"]["anyOf"]
        }
        self.assertEqual(
            refs,
            {"#/components/schemas/DesktopSearchResponse", "#/components/schemas/SearchResponse"},
        )


if __name__ == "__main__":
    unittest.main()
