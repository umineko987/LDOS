"""数据集 caption：全量读取（ETag/304）、批量操作、dry-run、单张编辑、撤销与事件。"""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest.mock import patch

from gdl_backend._database_gallery_repository import gallery_asset_id, gallery_directory_id
from gdl_backend.dataset_service import DatasetError
from tests.test_dataset_service import DatasetTestBase, png_bytes


class CaptionTestBase(DatasetTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.captions = self.container.captions
        self.source_id, self.library = self.import_library(
            {
                "set/a.png": png_bytes("#100"),
                "set/a.txt": "1girl, solo",
                "set/b.png": png_bytes("#200"),
                "set/b.txt": "",
                "set/c.png": png_bytes("#300"),
            }
        )
        self.dataset_id = self.new_dataset()
        self.service.update(self.dataset_id, {"trigger_word": "sks"})
        self.service.attach_directory(self.dataset_id, gallery_directory_id(self.source_id, "set"))
        self.ids = {
            name: gallery_asset_id(self.source_id, f"set/{name}.png") for name in ("a", "b", "c")
        }
        # 挂根会排队补哈希，进度事件由哈希线程异步发出；等它跑完再开始数事件。
        self.assertTrue(self.service.hashing.wait_idle(10))
        self._seen = 0
        self.events()

    def txt(self, name: str) -> Path:
        return self.library / "set" / f"{name}.txt"

    def text(self, name: str) -> str | None:
        path = self.txt(name)
        return path.read_text(encoding="utf-8") if path.exists() else None

    def listing(self) -> dict:
        response = self.client.get(f"/api/v1/datasets/{self.dataset_id}/captions")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def versions(self) -> dict[str, str]:
        return {item["asset_id"]: item["version"] for item in self.listing()["items"]}

    def events(self) -> list[tuple[str, dict]]:
        events, _ = self.container.events.events_after(self._seen)
        if events:
            self._seen = events[-1].seq
        return [
            (event.kind, event.data)
            for event in events
            if event.kind in {"captions.updated", "dataset.updated"}
        ]

    def ops(self, asset_ids: list[str], ops: list[dict], **extra) -> dict:
        response = self.client.post(
            f"/api/v1/datasets/{self.dataset_id}/captions/ops",
            json={"asset_ids": asset_ids, "ops": ops, **extra},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()


class CaptionListingTest(CaptionTestBase):
    def test_listing_reports_every_member_with_tags_and_versions(self) -> None:
        body = self.listing()
        self.assertEqual(body["trigger_word"], "sks")
        items = {item["asset_id"]: item for item in body["items"]}
        self.assertEqual(list(items), [self.ids["a"], self.ids["b"], self.ids["c"]])
        self.assertEqual(items[self.ids["a"]]["state"], "normal")
        self.assertEqual(items[self.ids["a"]]["tags"], ["1girl", "solo"])
        self.assertEqual(items[self.ids["b"]]["state"], "blank")
        self.assertEqual(items[self.ids["c"]]["state"], "missing")
        self.assertEqual(items[self.ids["c"]]["text"], "")
        self.assertTrue(all(item["version"] for item in items.values()))

    def test_etag_round_trip_and_invalidation(self) -> None:
        url = f"/api/v1/datasets/{self.dataset_id}/captions"
        first = self.client.get(url)
        etag = first.headers["ETag"]
        self.assertEqual(first.json()["etag"], etag)
        self.assertRegex(etag, r'^"[0-9a-f]{40}"$')

        cached = self.client.get(url, headers={"If-None-Match": etag})
        self.assertEqual(cached.status_code, 304)
        self.assertEqual(cached.content, b"")
        self.assertEqual(cached.headers["ETag"], etag)
        self.assertEqual(
            self.client.get(url, headers={"If-None-Match": f'"other", W/{etag}'}).status_code, 304
        )

        # 外部改了 TXT（没重新扫描）也要让 ETag 变
        self.txt("a").write_text("1girl, solo, smile", encoding="utf-8")
        stat = self.txt("a").stat()
        os.utime(self.txt("a"), ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        changed = self.client.get(url, headers={"If-None-Match": etag})
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.headers["ETag"], etag)
        tags = {item["asset_id"]: item["tags"] for item in changed.json()["items"]}
        self.assertEqual(tags[self.ids["a"]], ["1girl", "solo", "smile"])

        # 触发词变了也是新 ETag
        etag = changed.headers["ETag"]
        self.service.update(self.dataset_id, {"trigger_word": "ohwx"})
        self.assertNotEqual(self.client.get(url).headers["ETag"], etag)

    def test_unknown_dataset_is_404(self) -> None:
        response = self.client.get("/api/v1/datasets/nope/captions")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "dataset_not_found")


class CaptionOpsTest(CaptionTestBase):
    def test_dry_run_reports_diffs_without_side_effects(self) -> None:
        before = {name: self.text(name) for name in "abc"}
        result = self.ops(
            list(self.ids.values()),
            [{"op": "add", "tags": ["smile"]}, {"op": "remove", "tags": ["solo"]}],
            dry_run=True,
        )
        self.assertTrue(result["dry_run"])
        self.assertIsNone(result["batch_id"])
        self.assertEqual(
            result["stats"],
            {"total": 3, "changed": 1, "new": 2, "unchanged": 0, "skipped": 0,
             "conflicts": 0, "written": 0, "failed": 0},
        )
        sample = result["samples"][0]
        self.assertEqual(sample["asset_id"], self.ids["a"])
        self.assertEqual(sample["before"], ["1girl", "solo"])
        self.assertEqual(sample["after"], ["1girl", "smile"])
        self.assertEqual((sample["added"], sample["removed"]), (["smile"], ["solo"]))
        self.assertEqual({name: self.text(name) for name in "abc"}, before)
        self.assertEqual(self.db.captions.list_batches(self.dataset_id), [])
        self.assertEqual(self.events(), [])

    def test_ops_write_one_batch_and_publish(self) -> None:
        result = self.ops(
            [self.ids["a"], self.ids["b"]],
            [
                {"op": "replace", "from": "1girl", "to": "girl"},
                {"op": "add", "tags": ["sks", "smile"], "position": "front"},
                {"op": "pin", "tags": ["smile"]},
            ],
        )
        self.assertFalse(result["dry_run"])
        self.assertEqual(result["stats"]["written"], 2)
        # 触发词永远在第一位，pin 的标签紧随其后
        self.assertEqual(self.text("a"), "sks, smile, girl, solo")
        self.assertEqual(self.text("b"), "sks, smile")
        self.assertIsNone(self.text("c"))

        history = self.client.get(f"/api/v1/datasets/{self.dataset_id}/caption-batches").json()
        self.assertEqual(len(history["items"]), 1)
        batch = history["items"][0]
        self.assertEqual(batch["batch_id"], result["batch_id"])
        self.assertEqual(batch["kind"], "ops")
        self.assertEqual(batch["changed_count"], 2)
        self.assertTrue(batch["can_undo"])
        self.assertEqual(batch["params"]["ops"][0], {"op": "replace", "from": "1girl", "to": "girl"})

        self.assertEqual(
            self.events(),
            [
                ("captions.updated", {"dataset_id": self.dataset_id, "batch_id": result["batch_id"],
                                      "changed": 2, "reason": "ops"}),
                ("dataset.updated", {"dataset_id": self.dataset_id, "reason": "captions"}),
            ],
        )
        tags = {item["asset_id"]: item["tags"] for item in self.listing()["items"]}
        self.assertEqual(tags[self.ids["a"]], ["sks", "smile", "girl", "solo"])

    def test_merge_and_noop_ops(self) -> None:
        self.txt("a").write_text("cat ears, animal ears, solo", encoding="utf-8")
        self.catalog.scan_source(self.source_id)
        result = self.ops([self.ids["a"]], [{"op": "merge", "tags": ["animal ears", "cat ears"], "into": "kemonomimi"}])
        self.assertEqual(self.text("a"), "kemonomimi, solo")

        # 什么都没变就不写文件，也不记批次
        noop = self.ops([self.ids["a"]], [{"op": "remove", "tags": ["absent"]}])
        self.assertEqual(noop["stats"]["unchanged"], 1)
        self.assertIsNone(noop["batch_id"])
        self.assertEqual(len(self.db.captions.list_batches(self.dataset_id)), 1)
        self.assertIsNotNone(result["batch_id"])

    def test_expected_versions_turn_stale_rows_into_conflicts(self) -> None:
        versions = self.versions()
        self.txt("a").write_text("edited elsewhere", encoding="utf-8")
        result = self.ops(
            [self.ids["a"], self.ids["b"]],
            [{"op": "add", "tags": ["smile"]}],
            expected_versions={self.ids["a"]: versions[self.ids["a"]], self.ids["b"]: versions[self.ids["b"]]},
        )
        self.assertEqual(result["conflicts"], [{"asset_id": self.ids["a"], "reason": "caption_version_conflict"}])
        self.assertEqual(result["stats"]["written"], 1)
        self.assertEqual(self.text("a"), "edited elsewhere")
        self.assertEqual(self.text("b"), "smile")

    def test_unreadable_txt_is_skipped(self) -> None:
        self.txt("a").write_bytes(b"\xff\xfe\xfa broken")
        self.catalog.scan_source(self.source_id)
        result = self.ops([self.ids["a"], self.ids["c"]], [{"op": "add", "tags": ["smile"]}])
        self.assertEqual(result["skipped"], [{"asset_id": self.ids["a"], "reason": "invalid_encoding"}])
        self.assertEqual(self.txt("a").read_bytes(), b"\xff\xfe\xfa broken")
        self.assertEqual(self.text("c"), "smile")

    def test_validation_errors(self) -> None:
        url = f"/api/v1/datasets/{self.dataset_id}/captions/ops"
        bad_tag = self.client.post(url, json={"asset_ids": [self.ids["a"]], "ops": [{"op": "add", "tags": ["a, b"]}]})
        self.assertEqual(bad_tag.status_code, 422)
        bad_op = self.client.post(url, json={"asset_ids": [self.ids["a"]], "ops": [{"op": "explode", "tags": ["x"]}]})
        self.assertEqual(bad_op.status_code, 422)
        outsider = self.client.post(url, json={"asset_ids": ["not-a-member"], "ops": [{"op": "add", "tags": ["x"]}]})
        self.assertEqual(outsider.status_code, 422)
        self.assertEqual(outsider.json()["error"]["code"], "caption_asset_not_in_stage")

    def test_failed_atomic_write_keeps_original_and_records_only_written_files(self) -> None:
        real_replace = os.replace

        def failing_replace(source, target, *args, **kwargs):
            if str(target).endswith("a.txt"):
                raise OSError("disk full")
            return real_replace(source, target, *args, **kwargs)

        with patch("gdl_backend.gallery_safe_paths.os.replace", side_effect=failing_replace):
            result = self.ops([self.ids["a"], self.ids["b"]], [{"op": "add", "tags": ["smile"]}])
        self.assertEqual(result["failed"], [{"asset_id": self.ids["a"], "reason": "txt_write_failed"}])
        self.assertEqual(result["stats"]["written"], 1)
        self.assertEqual(self.text("a"), "1girl, solo")
        self.assertEqual(sorted(p.name for p in (self.library / "set").iterdir() if p.name.startswith(".")), [])
        items = self.db.captions.batch_items(result["batch_id"])
        self.assertEqual([item["asset_id"] for item in items], [self.ids["b"]])
        job = self.container.jobs.get(f"captions:{result['batch_id']}")
        self.assertEqual(job["status"], "failed")


class CaptionEditTest(CaptionTestBase):
    def test_edit_normalises_and_checks_version(self) -> None:
        url = f"/api/v1/datasets/{self.dataset_id}/captions/{self.ids['a']}"
        version = self.versions()[self.ids["a"]]
        response = self.client.put(url, json={"text": " 1girl ,smile\nsolo, smile ", "expected_version": version})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["caption"]["tags"], ["1girl", "smile", "solo"])
        self.assertEqual(self.text("a"), "1girl, smile, solo")
        self.assertNotEqual(body["caption"]["version"], version)
        self.assertEqual(self.db.captions.get_batch(body["batch_id"])["kind"], "edit")

        stale = self.client.put(url, json={"text": "other", "expected_version": version})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["error"]["code"], "caption_version_conflict")
        self.assertEqual(self.text("a"), "1girl, smile, solo")

    def test_edit_of_unreadable_caption_is_rejected(self) -> None:
        self.txt("a").write_bytes(b"\xff\xfe\xfa broken")
        self.catalog.scan_source(self.source_id)
        version = self.versions()[self.ids["a"]]
        response = self.client.put(
            f"/api/v1/datasets/{self.dataset_id}/captions/{self.ids['a']}",
            json={"text": "x", "expected_version": version},
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "caption_not_editable")


class CaptionUndoTest(CaptionTestBase):
    def undo(self, batch_id: str):
        return self.client.post(f"/api/v1/caption-batches/{batch_id}/undo")

    def test_undo_restores_text_and_removes_created_files(self) -> None:
        result = self.ops(list(self.ids.values()), [{"op": "add", "tags": ["smile"]}])
        self.assertEqual(self.text("c"), "smile")
        self.events()

        response = self.undo(result["batch_id"])
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["stats"], {"total": 3, "restored": 3, "conflicts": 0, "failed": 0})
        self.assertEqual(self.text("a"), "1girl, solo")
        self.assertEqual(self.text("b"), "")
        self.assertIsNone(self.text("c"))
        states = {item["asset_id"]: item["state"] for item in self.listing()["items"]}
        self.assertEqual(states[self.ids["c"]], "missing")
        self.assertEqual(
            [kind for kind, _ in self.events()], ["captions.updated", "dataset.updated"]
        )

        batch = self.client.get(f"/api/v1/datasets/{self.dataset_id}/caption-batches").json()["items"][0]
        self.assertFalse(batch["can_undo"])
        self.assertIsNotNone(batch["undone_at"])
        self.assertEqual(batch["undo_stats"]["restored"], 3)

        again = self.undo(result["batch_id"])
        self.assertEqual(again.status_code, 409)
        self.assertEqual(again.json()["error"]["code"], "caption_batch_already_undone")
        self.assertEqual(self.undo("missing-batch").status_code, 404)

    def test_undo_leaves_files_changed_since_the_batch(self) -> None:
        result = self.ops([self.ids["a"], self.ids["b"]], [{"op": "add", "tags": ["smile"]}])
        # 批次之后又改过 a：撤销不能覆盖这次修改
        version = self.versions()[self.ids["a"]]
        self.client.put(
            f"/api/v1/datasets/{self.dataset_id}/captions/{self.ids['a']}",
            json={"text": "1girl, solo, smile, blush", "expected_version": version},
        )
        body = self.undo(result["batch_id"]).json()
        self.assertEqual(body["stats"], {"total": 2, "restored": 1, "conflicts": 1, "failed": 0})
        self.assertEqual(body["conflicts"], [{"asset_id": self.ids["a"], "reason": "caption_changed_since_batch"}])
        self.assertEqual(self.text("a"), "1girl, solo, smile, blush")
        self.assertEqual(self.text("b"), "")
        # 冲突是终局：批次算撤销完了
        self.assertTrue(body["undone"])
        self.assertFalse(self.batch(result["batch_id"])["can_undo"])

    def batch(self, batch_id: str) -> dict:
        items = self.client.get(f"/api/v1/datasets/{self.dataset_id}/caption-batches").json()["items"]
        return next(item for item in items if item["batch_id"] == batch_id)

    def test_undo_chain_restores_each_earlier_batch(self) -> None:
        a, c = self.ids["a"], self.ids["c"]
        first = self.ops([a, c], [{"op": "add", "tags": ["smile"]}])
        second = self.ops([a, c], [{"op": "add", "tags": ["hat"]}])
        self.assertEqual((self.text("a"), self.text("c")), ("1girl, solo, smile, hat", "smile, hat"))

        body = self.undo(second["batch_id"]).json()
        self.assertEqual(body["stats"], {"total": 2, "restored": 2, "conflicts": 0, "failed": 0})
        self.assertEqual((self.text("a"), self.text("c")), ("1girl, solo, smile", "smile"))
        # 撤销是重写文件，磁盘版本已经不是第一批记下的 after_version；文本没变就照样能撤
        self.assertTrue(self.batch(first["batch_id"])["can_undo"])
        body = self.undo(first["batch_id"]).json()
        self.assertEqual(body["stats"], {"total": 2, "restored": 2, "conflicts": 0, "failed": 0})
        self.assertTrue(body["undone"])
        self.assertEqual(self.text("a"), "1girl, solo")
        self.assertIsNone(self.text("c"))

    def test_transient_failure_keeps_batch_undoable_and_retry_skips_restored(self) -> None:
        a, b = self.ids["a"], self.ids["b"]
        result = self.ops([a, b], [{"op": "add", "tags": ["smile"]}])
        real_replace = os.replace

        def failing_replace(source, target, *args, **kwargs):
            if str(target).endswith("a.txt"):
                raise OSError("disk full")
            return real_replace(source, target, *args, **kwargs)

        with patch("gdl_backend.gallery_safe_paths.os.replace", side_effect=failing_replace):
            body = self.undo(result["batch_id"]).json()
        self.assertFalse(body["undone"])
        self.assertEqual(body["stats"], {"total": 2, "restored": 1, "conflicts": 0, "failed": 1})
        self.assertEqual(body["failed"], [{"asset_id": a, "reason": "txt_write_failed"}])
        self.assertEqual((self.text("a"), self.text("b")), ("1girl, solo, smile", ""))
        batch = self.batch(result["batch_id"])
        self.assertTrue(batch["can_undo"])
        self.assertIsNone(batch["undone_at"])
        self.assertEqual(batch["undo_stats"], body["stats"])

        # 已恢复的 b 之后又被手改：重试只做剩下的 a，不碰 b，也不把它报成冲突
        version = self.versions()[b]
        self.client.put(
            f"/api/v1/datasets/{self.dataset_id}/captions/{b}",
            json={"text": "blush", "expected_version": version},
        )
        retry = self.undo(result["batch_id"]).json()
        self.assertTrue(retry["undone"])
        self.assertEqual(retry["stats"], {"total": 1, "restored": 1, "conflicts": 0, "failed": 0})
        self.assertEqual((self.text("a"), self.text("b")), ("1girl, solo", "blush"))
        batch = self.batch(result["batch_id"])
        self.assertFalse(batch["can_undo"])
        self.assertIsNotNone(batch["undone_at"])

    def test_service_level_undo_errors(self) -> None:
        with self.assertRaises(DatasetError) as caught:
            self.captions.undo("nope")
        self.assertEqual((caught.exception.status, caught.exception.code), (404, "caption_batch_not_found"))


class CaptionFromTaggerTest(CaptionTestBase):
    def apply(self, tags: dict[str, list[str]], mode: str, **extra) -> dict:
        return self.captions.apply_tagger(
            self.dataset_id,
            tagger_tags=tags,
            unavailable=extra.pop("unavailable", {}),
            asset_ids=extra.pop("asset_ids", list(self.ids.values())),
            mode=mode,
            params={"models": ["fake"]},
            **extra,
        )

    def test_overwrite_and_fill_empty(self) -> None:
        tags = {asset_id: ["1girl", "blue eyes"] for asset_id in self.ids.values()}
        fill = self.apply(tags, "fill_empty")
        self.assertEqual(self.text("a"), "1girl, solo")
        self.assertEqual(self.text("b"), "sks, 1girl, blue eyes")
        self.assertEqual(self.text("c"), "sks, 1girl, blue eyes")
        self.assertEqual(fill["stats"]["unchanged"], 1)
        # a 的 caption 没被这次结果改动，不能成为下次 merge 的打标基线
        baseline = self.db.captions.latest_tagger_tags(self.dataset_id)
        self.assertEqual(sorted(baseline), sorted([self.ids["b"], self.ids["c"]]))

        self.apply({self.ids["a"]: ["long hair"]}, "overwrite", asset_ids=[self.ids["a"]])
        self.assertEqual(self.text("a"), "sks, long hair")

    def test_merge_keeps_manual_edits(self) -> None:
        first = {asset_id: ["1girl", "blue eyes", "smile"] for asset_id in self.ids.values()}
        self.apply(first, "overwrite")
        self.assertEqual(self.text("a"), "sks, 1girl, blue eyes, smile")

        # 手动：a 加了 "red scarf"、删了 "smile"
        version = self.versions()[self.ids["a"]]
        self.captions.edit(self.dataset_id, self.ids["a"], "sks, 1girl, blue eyes, red scarf", expected_version=version)

        second = {asset_id: ["1girl", "green eyes", "smile", "outdoors"] for asset_id in self.ids.values()}
        dry = self.apply(second, "merge", dry_run=True)
        self.assertIsNone(dry["batch_id"])
        self.assertEqual(self.text("a"), "sks, 1girl, blue eyes, red scarf")

        result = self.apply(second, "merge")
        # 手加的保留，手删的不回来，上次打标独有的 blue eyes 换成新结果
        self.assertEqual(self.text("a"), "sks, red scarf, 1girl, green eyes, outdoors")
        self.assertEqual(self.text("b"), "sks, 1girl, green eyes, smile, outdoors")
        self.assertEqual(result["stats"]["changed"], 3)

    def test_missing_results_are_skipped_with_reason(self) -> None:
        result = self.apply(
            {self.ids["c"]: ["1girl"]}, "overwrite",
            unavailable={self.ids["a"]: "missing_scores"},
        )
        self.assertEqual(
            result["skipped"],
            [{"asset_id": self.ids["a"], "reason": "missing_scores"},
             {"asset_id": self.ids["b"], "reason": "no_tagger_result"}],
        )
        self.assertEqual(result["stats"]["total"], 3)
        self.assertEqual(self.text("a"), "1girl, solo")
        self.assertEqual(self.text("c"), "sks, 1girl")


if __name__ == "__main__":
    unittest.main()
