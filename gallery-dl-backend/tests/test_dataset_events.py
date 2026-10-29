"""数据集服务的写操作都发 `dataset.updated`（SSE 领域事件）。"""

from __future__ import annotations

import unittest
from unittest.mock import patch

from gdl_backend._database_gallery_repository import gallery_directory_id
from tests.test_dataset_service import DatasetTestBase, png_bytes


class DatasetUpdatedEventTest(DatasetTestBase):
    def setUp(self) -> None:
        super().setUp()
        self._seen = 0

    def updates(self) -> list[tuple[str, str]]:
        events, _ = self.container.events.events_after(self._seen)
        if events:
            self._seen = events[-1].seq
        return [
            (event.data["dataset_id"], event.data["reason"])
            for event in events
            if event.kind == "dataset.updated"
        ]

    def test_mutations_publish_dataset_updated(self) -> None:
        source_id, _ = self.import_library({"a/1.png": png_bytes(), "a/2.png": png_bytes("#000")})
        self.updates()
        dataset_id = self.new_dataset()
        self.assertEqual(self.updates(), [(dataset_id, "created")])

        self.service.update(dataset_id, {"trigger_word": "sks"})
        self.assertEqual(self.updates(), [(dataset_id, "updated")])

        root, _ = self.service.attach_directory(dataset_id, gallery_directory_id(source_id, "a"))
        self.assertEqual(self.updates(), [(dataset_id, "roots")])
        # 重复挂同一个根不是变化
        self.service.attach_directory(dataset_id, gallery_directory_id(source_id, "a"))
        self.assertEqual(self.updates(), [])

        asset_id = self.db.datasets.member_rows(dataset_id)[0]["asset_id"]
        self.service.decide(dataset_id, stage="clean", asset_ids=[asset_id], decision="exclude")
        self.assertEqual(self.updates(), [(dataset_id, "decisions")])

        run = self.service.start_stage_run(dataset_id, "clean")
        self.service.finish_stage_run(run["run_id"], status="succeeded")
        self.assertEqual(self.updates(), [(dataset_id, "stage_run"), (dataset_id, "stage_run")])

        self.catalog.scan_source(source_id)
        self.assertIn((dataset_id, "members"), self.updates())

        self.service.detach_root(dataset_id, root["root_id"])
        self.assertEqual(self.updates(), [(dataset_id, "roots")])

        self.service.delete(dataset_id)
        self.assertEqual(self.updates(), [(dataset_id, "deleted")])

    def test_http_routes_publish_too(self) -> None:
        self.updates()
        response = self.client.post("/api/v1/datasets", json={"name": "风格", "kind": "style"})
        self.assertEqual(response.status_code, 201, response.text)
        dataset_id = response.json()["dataset_id"]
        response = self.client.patch(f"/api/v1/datasets/{dataset_id}", json={"name": "风格 2"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.updates(), [(dataset_id, "created"), (dataset_id, "updated")])

    def test_failed_validation_publishes_nothing(self) -> None:
        dataset_id = self.new_dataset()
        self.updates()
        response = self.client.post(
            f"/api/v1/datasets/{dataset_id}/decisions",
            json={"stage": "clean", "asset_ids": ["not-a-member"], "decision": "exclude"},
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.updates(), [])

    def test_bus_failure_does_not_break_the_write(self) -> None:
        with (
            patch.object(self.container.events, "publish", side_effect=RuntimeError("bus down")),
            self.assertLogs("gdl_backend.dataset_service", level="ERROR"),
        ):
            dataset_id = self.new_dataset()
        self.assertIsNotNone(self.db.datasets.get_dataset(dataset_id))


if __name__ == "__main__":
    unittest.main()
