"""/api/v1/datasets 路由合同：状态码、错误码与响应形状。"""

from __future__ import annotations

import unittest
from unittest import mock

from gdl_backend._database_gallery_repository import gallery_asset_id, gallery_directory_id
from tests.test_dataset_service import DatasetTestBase, png_bytes


FUNNEL_STAGE_KEYS = {
    "stage", "input", "excluded", "approved", "output", "input_digest", "status", "stale", "last_run",
}
SUMMARY_KEYS = {
    "dataset_id", "name", "kind", "trigger_word", "config", "cover_asset_id",
    "cover_thumbnail_url", "member_count", "output_count", "root_count", "stage_outputs",
    "created_at", "updated_at",
}
MEMBER_KEYS = {
    "asset_id", "source_id", "directory_id", "relative_path", "name", "format", "width",
    "height", "size_bytes", "content_sha256", "txt_state", "lifecycle_state",
    "dedup_visibility", "thumbnail_url", "decisions",
}


class DatasetApiTestBase(DatasetTestBase):
    def create(self, **body) -> dict:
        response = self.client.post("/api/v1/datasets", json={"name": "角色A", **body})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def error_code(self, response) -> str:
        return response.json()["error"]["code"]


class DatasetCrudRoutesTest(DatasetApiTestBase):
    def test_create_get_list_patch_delete(self) -> None:
        created = self.create(name="  Alice  ", kind="style", trigger_word=" alice_v1 ")
        self.assertEqual(set(created), SUMMARY_KEYS | {"funnel"})
        self.assertEqual((created["name"], created["trigger_word"]), ("Alice", "alice_v1"))
        self.assertEqual([stage["stage"] for stage in created["funnel"]],
                         ["collect", "clean", "dedup", "tag", "review", "export"])
        self.assertEqual(set(created["funnel"][0]), FUNNEL_STAGE_KEYS)
        dataset_id = created["dataset_id"]

        listed = self.client.get("/api/v1/datasets").json()["items"]
        self.assertEqual([item["dataset_id"] for item in listed], [dataset_id])
        self.assertEqual(set(listed[0]), SUMMARY_KEYS)

        patched = self.client.patch(
            f"/api/v1/datasets/{dataset_id}",
            json={"name": "Bob", "config": {"repeats": 10}, "cover_asset_id": None},
        )
        self.assertEqual(patched.status_code, 200, patched.text)
        self.assertEqual((patched.json()["name"], patched.json()["config"]), ("Bob", {"repeats": 10}))
        self.assertEqual(patched.json()["kind"], "style")

        self.assertEqual(self.client.delete(f"/api/v1/datasets/{dataset_id}").status_code, 204)
        missing = self.client.get(f"/api/v1/datasets/{dataset_id}")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(self.error_code(missing), "dataset_not_found")
        self.assertEqual(self.client.delete(f"/api/v1/datasets/{dataset_id}").status_code, 404)

    def test_request_validation(self) -> None:
        for body in (
            {"name": "   "},
            {"name": "x", "kind": "pose"},
            {"name": "x", "unexpected": 1},
            {},
        ):
            with self.subTest(body=body):
                self.assertEqual(self.client.post("/api/v1/datasets", json=body).status_code, 422)
        dataset_id = self.create()["dataset_id"]
        self.assertEqual(
            self.client.patch(f"/api/v1/datasets/{dataset_id}", json={"name": ""}).status_code, 422
        )

    def test_unknown_dataset_is_404_on_every_subresource(self) -> None:
        for method, path, body in (
            ("get", "/funnel", None),
            ("get", "/roots", None),
            ("post", "/roots", {"source_id": "s"}),
            ("get", "/members", None),
            ("post", "/decisions", {"stage": "clean", "asset_ids": ["a"], "decision": "exclude"}),
            ("get", "/stage-runs", None),
            ("get", "/hashing", None),
            ("post", "/hashing", None),
            ("get", "/crawls", None),
            ("patch", "", {"name": "x"}),
        ):
            with self.subTest(method=method, path=path):
                kwargs = {"json": body} if body is not None else {}
                response = getattr(self.client, method)(f"/api/v1/datasets/missing{path}", **kwargs)
                self.assertEqual(response.status_code, 404, response.text)
                self.assertEqual(self.error_code(response), "dataset_not_found")


class DatasetRootRoutesTest(DatasetApiTestBase):
    def test_root_body_needs_exactly_one_target(self) -> None:
        dataset_id = self.create()["dataset_id"]
        for body in (
            {},
            {"source_id": "a", "directory_id": "b"},
            {"source_id": "a", "display_name": "x"},
            {"path": "/tmp", "extra": True},
        ):
            with self.subTest(body=body):
                response = self.client.post(f"/api/v1/datasets/{dataset_id}/roots", json=body)
                self.assertEqual(response.status_code, 422, response.text)

    def test_attach_list_and_detach(self) -> None:
        source_id, library = self.import_library({"a/1.png": png_bytes(), "b/2.png": png_bytes()})
        dataset_id = self.create()["dataset_id"]
        base = f"/api/v1/datasets/{dataset_id}/roots"

        by_directory = self.client.post(base, json={"directory_id": gallery_directory_id(source_id, "a")})
        self.assertEqual(by_directory.status_code, 201, by_directory.text)
        self.assertEqual(by_directory.json()["origin"], "library")
        self.assertEqual(by_directory.json()["recursive_asset_count"], 1)
        by_path = self.client.post(base, json={"path": str(library / "b")})
        self.assertEqual(by_path.status_code, 201, by_path.text)
        self.assertEqual((by_path.json()["origin"], by_path.json()["relative_path"]), ("import", "b"))
        self.assertNotIn("root_path", by_path.json())

        roots = self.client.get(base).json()["items"]
        self.assertEqual(len(roots), 2)
        self.assertEqual(self.client.get(f"/api/v1/datasets/{dataset_id}").json()["root_count"], 2)

        missing = self.client.post(base, json={"directory_id": "nope"})
        self.assertEqual((missing.status_code, self.error_code(missing)), (404, "gallery_directory_not_found"))
        missing = self.client.post(base, json={"source_id": "nope"})
        self.assertEqual((missing.status_code, self.error_code(missing)), (404, "gallery_source_not_found"))

        root_id = by_directory.json()["root_id"]
        self.assertEqual(self.client.delete(f"{base}/{root_id}").status_code, 204)
        again = self.client.delete(f"{base}/{root_id}")
        self.assertEqual((again.status_code, self.error_code(again)), (404, "dataset_root_not_found"))

    def test_conflicting_import_path_is_409(self) -> None:
        self.import_library({"1.png": png_bytes()}, name="outer/inner")
        dataset_id = self.create()["dataset_id"]
        response = self.client.post(
            f"/api/v1/datasets/{dataset_id}/roots", json={"path": str(self.root / "outer")}
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.error_code(response), "source_path_conflict")


class DatasetMemberRoutesTest(DatasetApiTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.source_id, _ = self.import_library({f"{index}.png": png_bytes() for index in range(1, 4)})
        self.dataset_id = self.create()["dataset_id"]
        self.client.post(f"/api/v1/datasets/{self.dataset_id}/roots", json={"source_id": self.source_id})
        self.base = f"/api/v1/datasets/{self.dataset_id}"

    def test_member_pagination_and_filters(self) -> None:
        first = self.client.get(f"{self.base}/members", params={"limit": 2})
        self.assertEqual(first.status_code, 200, first.text)
        page = first.json()
        self.assertEqual((page["total"], page["limit"], len(page["items"])), (3, 2, 2))
        self.assertEqual(set(page["items"][0]), MEMBER_KEYS)
        second = self.client.get(
            f"{self.base}/members", params={"limit": 2, "cursor": page["next_cursor"]}
        ).json()
        self.assertEqual([item["name"] for item in second["items"]], ["3.png"])
        self.assertIsNone(second["next_cursor"])

        bad = self.client.get(f"{self.base}/members", params={"cursor": "not-a-cursor"})
        self.assertEqual((bad.status_code, self.error_code(bad)), (422, "invalid_dataset_cursor"))
        bad = self.client.get(f"{self.base}/members", params={"decision": "excluded"})
        self.assertEqual((bad.status_code, self.error_code(bad)), (422, "invalid_dataset_member_filter"))
        for params in ({"stage": "train"}, {"stage": "clean", "decision": "maybe"}, {"limit": 0}, {"limit": 501}):
            with self.subTest(params=params):
                self.assertEqual(self.client.get(f"{self.base}/members", params=params).status_code, 422)

    def test_decisions_update_funnel_and_member_decisions(self) -> None:
        target = gallery_asset_id(self.source_id, "2.png")
        response = self.client.post(
            f"{self.base}/decisions",
            json={"stage": "clean", "asset_ids": [target], "decision": "exclude", "reason": "模糊"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["updated"], 1)
        clean = body["funnel"]["stages"][1]
        self.assertEqual((clean["stage"], clean["input"], clean["excluded"], clean["output"]), ("clean", 3, 1, 2))
        self.assertEqual(self.client.get(f"{self.base}/funnel").json(), body["funnel"])

        excluded = self.client.get(
            f"{self.base}/members", params={"stage": "clean", "decision": "excluded"}
        ).json()
        self.assertEqual(
            excluded["items"][0]["decisions"],
            [{"stage": "clean", "decision": "exclude", "reason": "模糊"}],
        )
        self.assertEqual(self.client.get(f"{self.base}/members", params={"stage": "tag"}).json()["total"], 2)

        stranger = self.client.post(
            f"{self.base}/decisions",
            json={"stage": "clean", "asset_ids": ["stranger"], "decision": "exclude"},
        )
        self.assertEqual((stranger.status_code, self.error_code(stranger)), (422, "dataset_asset_not_member"))
        empty = self.client.post(
            f"{self.base}/decisions", json={"stage": "clean", "asset_ids": [], "decision": "exclude"}
        )
        self.assertEqual(empty.status_code, 422)

    def test_kept_filter_is_undecided_plus_approved(self) -> None:
        names = {index: gallery_asset_id(self.source_id, f"{index}.png") for index in range(1, 4)}
        for asset_id, decision in ((names[1], "exclude"), (names[2], "approve")):
            response = self.client.post(
                f"{self.base}/decisions",
                json={"stage": "clean", "asset_ids": [asset_id], "decision": decision},
            )
            self.assertEqual(response.status_code, 200, response.text)
        # 别的阶段的排除不影响 clean 阶段的 kept。
        self.service.decide(self.dataset_id, stage="dedup", asset_ids=[names[3]], decision="exclude")

        def member_names(decision: str) -> list[str]:
            response = self.client.get(f"{self.base}/members", params={"stage": "clean", "decision": decision})
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual(body["total"], len(body["items"]))
            return [item["name"] for item in body["items"]]

        self.assertEqual(member_names("kept"), ["2.png", "3.png"])
        self.assertEqual(member_names("excluded"), ["1.png"])
        self.assertEqual(sorted(member_names("approved") + member_names("undecided")), member_names("kept"))
        bad = self.client.get(f"{self.base}/members", params={"decision": "kept"})
        self.assertEqual((bad.status_code, self.error_code(bad)), (422, "invalid_dataset_member_filter"))

    def test_stage_runs_and_hashing(self) -> None:
        run = self.service.start_stage_run(self.dataset_id, "tag", ref_id="tagger-job")
        self.service.finish_stage_run(run["run_id"], status="succeeded", stats={"tagged": 3})
        runs = self.client.get(f"{self.base}/stage-runs", params={"stage": "tag"}).json()["items"]
        self.assertEqual([(r["run_id"], r["status"], r["ref_id"]) for r in runs],
                         [(run["run_id"], "succeeded", "tagger-job")])
        self.assertEqual(self.client.get(f"{self.base}/stage-runs", params={"stage": "x"}).status_code, 422)

        started = self.client.post(f"{self.base}/hashing")
        self.assertEqual(started.status_code, 202, started.text)
        self.assertEqual(set(started.json()), {"member_count", "hashed_count", "pending"})
        self.assertTrue(self.service.hashing.wait_idle(10))
        status = self.client.get(f"{self.base}/hashing").json()
        self.assertEqual((status["member_count"], status["hashed_count"]), (3, 3))


class DatasetCrawlRoutesTest(DatasetApiTestBase):
    CRAWL_BODY = {
        "sources": [{"site": "danbooru", "addresses": [{"url": "https://danbooru.donmai.us/posts?tags=x"}]}]
    }

    def test_crawl_registers_batch_for_auto_attach(self) -> None:
        dataset_id = self.create()["dataset_id"]
        self.db.create_crawl_batch(
            {"id": "batch-api", "output_dir": str(self.root / "out"), "concurrency": 1, "max_tasks": 1},
            [],
        )
        batch = self.db.get_crawl_batch("batch-api")
        with mock.patch(
            "gdl_backend.api_routes.datasets._perform_crawl",
            new=mock.AsyncMock(return_value=(batch, True)),
        ) as perform:
            response = self.client.post(
                f"/api/v1/datasets/{dataset_id}/crawls",
                json=self.CRAWL_BODY,
                headers={"Idempotency-Key": "dataset-crawl-1"},
            )
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(perform.await_args.kwargs["idempotency_key"], "dataset-crawl-1")
        body = response.json()
        self.assertEqual(
            (body["dataset_id"], body["batch_id"], body["state"], body["batch_status"]),
            (dataset_id, "batch-api", "pending", "queued"),
        )
        listed = self.client.get(f"/api/v1/datasets/{dataset_id}/crawls").json()["items"]
        self.assertEqual([item["batch_id"] for item in listed], ["batch-api"])

    def test_crawl_for_missing_dataset_does_not_start_a_batch(self) -> None:
        with mock.patch(
            "gdl_backend.api_routes.datasets._perform_crawl", new=mock.AsyncMock()
        ) as perform:
            response = self.client.post("/api/v1/datasets/missing/crawls", json=self.CRAWL_BODY)
        self.assertEqual((response.status_code, self.error_code(response)), (404, "dataset_not_found"))
        perform.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
