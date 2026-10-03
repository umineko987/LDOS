from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.gallery_review import review_trash_operation_id
from tests.helpers import local_test_client, make_settings


def selected_manifest(claimed: dict, *, automatic: bool = False) -> dict:
    images = [{"id": s["asset_id"], "relative_path": s["source_id"] + "/" + s["relative_path"],
               "readable": True, "recommended": n == 0, "metadata": {"w": 8, "h": 8}}
              for n, s in enumerate(claimed["images"])]
    manual = images[:-1] if automatic else images
    return {"schema_version": 3, "review_id": claimed["review_id"], "counts": {"images": len(images)},
            "groups": [{"id": "cross-source", "kind": "duplicate", "items": manual}],
            "auto_groups": [{"id": "auto-exact", "kind": "exact", "winner": images[0],
                             "rejected_items": [images[-1]]}] if automatic else []}


class GalleryReviewsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        settings = make_settings(self.root)
        settings.dedup.enabled = True
        self.container = ServiceContainer(settings)
        self.manager = self.container.gallery_reviews
        self.sources = []
        for name, files in (("first", ["nested/a.png", "nested/deep/b.png"]), ("second", ["c.png"])):
            root = self.root / name
            for relative in files:
                image = root / relative
                image.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGB", (8, 8), "red").save(image)
                image.with_suffix(".txt").write_text(relative, encoding="utf-8")
            source = self.container.gallery_catalog.import_source(str(root), display_name=name)
            self.container.gallery_catalog.scan_source(source["source_id"])
            self.sources.append(self.container.db.gallery.get_source(source["source_id"]))
        self.directory_ids = [self.container.db.gallery.get_root_directory(s["source_id"])["directory_id"] for s in self.sources]

    def tearDown(self):
        self.container.gallery_catalog.stop()
        self.container.db.close()
        self.tmp.cleanup()

    def create_ready(self, *, automatic=False):
        review = self.manager.create(self.directory_ids)
        async def runner(claimed):
            return selected_manifest(claimed, automatic=automatic), ""
        self.manager.runner = runner
        self.assertTrue(asyncio.run(self.container.reviews.run_once()))
        return self.container.db.gallery_reviews.get_crawl_review(review["review_id"])

    def adopt(self, review_id, selected, group_id="cross-source"):
        repo = self.container.db.gallery_reviews
        review = repo.get_crawl_review(review_id)
        return self.manager.adopt_group(review_id, group_id, selected, version=review["version"])

    def test_recursive_parent_child_overlap_cross_source_and_incremental_files(self):
        repo = self.container.db.gallery
        with repo._read() as conn:
            child = conn.execute("SELECT id FROM gallery_directories WHERE source_id=? AND relative_path='nested'", (self.sources[0]["source_id"],)).fetchone()[0]
        for relative in ("duplicates/no.png", ".ldos/no.png", "outside.png"):
            path = Path(self.sources[0]["root_path"]) / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGB", (8, 8)).save(path)
        external = self.root / "external.png"
        Image.new("RGB", (8, 8)).save(external)
        (Path(self.sources[0]["root_path"]) / "nested/link.png").symlink_to(external)
        new_file = Path(self.sources[0]["root_path"]) / "nested/deep/new.png"
        Image.new("RGB", (8, 8)).save(new_file)
        # Selecting child+parent once, plus a different source, includes all descendants once.
        review = self.manager.create([child, self.directory_ids[0], child, self.directory_ids[1]])
        snapshots = self.container.db.gallery_reviews.snapshot(review["review_id"])
        self.assertEqual(review["total_image_count"], 5)
        self.assertEqual(len({s["asset_id"] for s in snapshots}), 5)
        self.assertEqual({s["source_id"] for s in snapshots}, {s["source_id"] for s in self.sources})
        self.assertFalse(any("no.png" in s["relative_path"] or "link.png" in s["relative_path"] for s in snapshots))
        with self.container.db._read() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM crawl_batches").fetchone()[0], 0)

    def test_explicit_assets_merge_with_directories_and_support_images_only(self):
        repo = self.container.db.gallery
        def asset_id(source_id, relative):
            with repo._read() as conn:
                return conn.execute("SELECT id FROM gallery_assets WHERE source_id=? AND relative_path=?",
                                    (source_id, relative)).fetchone()[0]
        first, second = self.sources
        a_id = asset_id(first["source_id"], "nested/a.png")
        b_id = asset_id(first["source_id"], "nested/deep/b.png")
        c_id = asset_id(second["source_id"], "c.png")
        # 勾选目录与勾选图片合并为一个集合，跨来源去重。
        review = self.manager.create([self.directory_ids[1]], [a_id, b_id])
        snapshots = self.container.db.gallery_reviews.snapshot(review["review_id"])
        self.assertEqual({s["asset_id"] for s in snapshots}, {a_id, b_id, c_id})
        self.assertEqual(review["directories"][0]["directory_id"], self.directory_ids[1])
        self.assertEqual(len(review["directories"]), 1)
        self.assertEqual(review["total_image_count"], 3)
        # 纯图片选区：无目录也能发起。
        images_only = self.manager.create([], [c_id])
        snapshots = self.container.db.gallery_reviews.snapshot(images_only["review_id"])
        self.assertEqual({s["asset_id"] for s in snapshots}, {c_id})
        self.assertEqual(images_only["directories"], [])
        # 图片已包含在勾选目录内时只算一份。
        overlap = self.manager.create([self.directory_ids[0]], [a_id])
        snapshots = self.container.db.gallery_reviews.snapshot(overlap["review_id"])
        self.assertEqual({s["asset_id"] for s in snapshots}, {a_id, b_id})
        # 完全空的选区或未知图片直接拒绝。
        with self.assertRaises(ValueError):
            self.manager.create([], [])
        with self.assertRaises(KeyError):
            self.manager.create([], ["missing-asset"])

    def test_keep_in_place_auto_and_manual_trash_reversible_adopt_and_finish(self):
        review = self.create_ready(automatic=True)
        rid = review["review_id"]
        snapshots = self.container.db.gallery_reviews.snapshot(rid)
        self.assertEqual(review["rejected_image_count"], 1)
        self.assertEqual(review["status"], "ready")
        with mock.patch.object(self.container.gallery_file_operations, "purge_trash", side_effect=AssertionError("no purge")):
            adopted = self.adopt(rid, [snapshots[0]["asset_id"]])
        self.assertEqual(adopted["status"], "ready")
        self.assertEqual((adopted["kept_image_count"], adopted["rejected_image_count"]), (1, 2))
        keeper = Path(snapshots[0]["root_path"]) / snapshots[0]["relative_path"]
        self.assertTrue(keeper.is_file())
        self.assertEqual(keeper.with_suffix(".txt").read_text(), snapshots[0]["relative_path"])
        self.assertEqual(self.container.db.gallery.get_root_directory(snapshots[0]["source_id"])["recursive_asset_count"], 1)
        self.assertEqual(len(self.container.gallery_file_operations.list_trash()["operations"]), 2)
        manual = snapshots[1]
        trashed = Path(manual["root_path"]) / f".ldos/trash/{review_trash_operation_id(rid, manual['asset_id'])}/files/{manual['relative_path']}"
        self.assertTrue(trashed.is_file())
        self.assertEqual(trashed.with_suffix(".txt").read_text(), manual["relative_path"])
        # 重新采纳即可逆：恢复 manual 图片，自动淘汰的 c 保持回收。
        adopted = self.adopt(rid, [snapshots[0]["asset_id"], manual["asset_id"]])
        self.assertEqual((adopted["kept_image_count"], adopted["rejected_image_count"]), (2, 1))
        original = Path(manual["root_path"]) / manual["relative_path"]
        self.assertTrue(original.is_file())
        self.assertEqual(original.with_suffix(".txt").read_text(), manual["relative_path"])
        # 再次改回回收：换新槽位重新落地，历史槽位保持已撤销。
        adopted = self.adopt(rid, [snapshots[0]["asset_id"]])
        self.assertEqual((adopted["kept_image_count"], adopted["rejected_image_count"]), (1, 2))
        retrash = Path(manual["root_path"]) / f".ldos/trash/{review_trash_operation_id(rid, manual['asset_id'], 1)}/files/{manual['relative_path']}"
        self.assertTrue(retrash.is_file())
        self.assertEqual(len(self.container.gallery_file_operations.list_trash()["operations"]), 3)
        # 完成即结束：任务记录删除，物理结果保持。
        self.manager.finish(rid)
        self.assertIsNone(self.container.db.gallery_reviews.get_crawl_review(rid))
        self.assertTrue((Path(snapshots[0]["root_path"]) / snapshots[0]["relative_path"]).is_file())
        self.assertTrue(retrash.is_file())

    def test_committed_trash_crash_restart_recovers_file_and_drops_task(self):
        review = self.create_ready()
        rid = review["review_id"]
        snapshots = self.container.db.gallery_reviews.snapshot(rid)
        repo = self.container.db.gallery_reviews
        original = repo.finish_crawl_review_image
        def crash(review_id, image_id, disposition, **kwargs):
            if disposition == "rejected":
                raise SystemExit("crash after trash commit")
            return original(review_id, image_id, disposition, **kwargs)
        with mock.patch.object(repo, "finish_crawl_review_image", side_effect=crash):
            with self.assertRaises(SystemExit):
                self.adopt(rid, [snapshots[0]["asset_id"]])
        self.assertEqual(len(self.container.gallery_file_operations.list_trash()["operations"]), 1)
        self.container.gallery_catalog.stop()
        self.container.db.close()
        self.container = ServiceContainer(self.container.settings)
        self.manager = self.container.gallery_reviews
        recovered = self.container.gallery_file_operations.recover_unfinished()
        self.assertEqual(recovered, [])
        asyncio.run(self.container.gallery_reviews.start())
        self.container.gallery_reviews._loop_task.cancel()
        # 一次性任务：重启后记录清除，已提交的物理回收保持且可从回收区恢复。
        self.assertIsNone(self.container.db.gallery_reviews.get_crawl_review(rid))
        victim = snapshots[1]
        trashed = Path(victim["root_path"]) / f".ldos/trash/{review_trash_operation_id(rid, victim['asset_id'])}/files/{victim['relative_path']}"
        self.assertTrue(trashed.is_file())
        self.container.gallery_file_operations.restore_trash(review_trash_operation_id(rid, victim["asset_id"]))
        self.assertTrue((Path(victim["root_path"]) / victim["relative_path"]).is_file())

    def test_interrupted_file_operation_recovers_pair_and_drops_task(self):
        review = self.create_ready()
        rid = review["review_id"]
        snapshots = self.container.db.gallery_reviews.snapshot(rid)
        with mock.patch.object(self.container.gallery_file_operations, "_commit_trash_index",
                               side_effect=SystemExit("crash after file moves")):
            with self.assertRaises(SystemExit):
                self.adopt(rid, [snapshots[0]["asset_id"]])
        self.container.gallery_catalog.stop()
        self.container.db.close()
        self.container = ServiceContainer(self.container.settings)
        self.manager = self.container.gallery_reviews
        recovered = self.container.gallery_file_operations.recover_unfinished()
        self.assertEqual(recovered[0]["outcome"], "committed")
        asyncio.run(self.container.gallery_reviews.start())
        self.container.gallery_reviews._loop_task.cancel()
        self.assertIsNone(self.container.db.gallery_reviews.get_crawl_review(rid))
        # 崩溃发生在第一张淘汰图提交之后：物理恢复到位，未处理的图保持原位。
        victim = snapshots[1]
        op = review_trash_operation_id(rid, victim["asset_id"])
        path = Path(victim["root_path"]) / f".ldos/trash/{op}/files/{victim['relative_path']}"
        self.assertTrue(path.is_file())
        self.assertEqual(path.with_suffix(".txt").read_text(), victim["relative_path"])
        pending = snapshots[2]
        self.assertTrue((Path(pending["root_path"]) / pending["relative_path"]).is_file())

    def test_automatic_rejection_committed_before_crash_resumes_to_ready(self):
        review = self.manager.create(self.directory_ids)
        rid = review["review_id"]
        async def runner(claimed):
            return selected_manifest(claimed, automatic=True), ""
        self.manager.runner = runner
        with mock.patch.object(self.container.db.gallery_reviews, "finish_crawl_review_image",
                               side_effect=SystemExit("crash after automatic trash")):
            with self.assertRaises(SystemExit):
                asyncio.run(self.container.reviews.run_once())
        self.assertEqual(self.container.db.gallery_reviews.get_crawl_review(rid)["status"], "auto_applying")
        self.container.gallery_catalog.stop()
        self.container.db.close()
        self.container = ServiceContainer(self.container.settings)
        self.manager = self.container.gallery_reviews
        self.container.db.gallery_reviews.recover_crawl_reviews()
        self.container.gallery_file_operations.recover_unfinished()
        self.assertTrue(asyncio.run(self.container.reviews.run_once()))
        ready = self.container.db.gallery_reviews.get_crawl_review(rid)
        self.assertEqual((ready["status"], ready["rejected_image_count"]), ("ready", 1))
        self.assertEqual(len(self.container.gallery_file_operations.list_trash()["operations"]), 1)

    def test_file_replacement_annotation_change_rename_unmount_and_overlap_fail_closed(self):
        for change in ("replace", "txt", "rename", "root-swap", "symlink", "unmount", "other-review"):
            with self.subTest(change=change):
                review = self.create_ready()
                rid = review["review_id"]
                snapshots = self.container.db.gallery_reviews.snapshot(rid)
                victim = snapshots[-1]
                path = Path(victim["root_path"]) / victim["relative_path"]
                before_trash = len(self.container.gallery_file_operations.list_trash()["operations"])
                if change == "replace":
                    data = path.read_bytes()
                    path.unlink(); path.write_bytes(data)
                elif change == "txt":
                    path.with_suffix(".txt").write_text("changed")
                elif change == "rename":
                    self.container.gallery_file_operations.rename_asset(victim["asset_id"], "renamed")
                elif change == "root-swap":
                    source_root = Path(victim["root_path"])
                    source_root.rename(source_root.with_name("moved-root"))
                    path.parent.mkdir(parents=True)
                    path.write_bytes(b"unrelated replacement source")
                elif change == "symlink":
                    external = self.root / "external.png"
                    external.write_bytes(path.read_bytes())
                    path.unlink(); path.symlink_to(external)
                elif change == "unmount":
                    self.container.gallery_catalog.unregister_source(victim["source_id"])
                else:
                    self.container.gallery_file_operations.trash_assets([victim["asset_id"]])
                    before_trash += 1
                failed = self.adopt(rid, [snapshots[0]["asset_id"]])
                self.assertEqual(failed["status"], "ready")
                self.assertGreater(failed["failed_image_count"], 0)
                with self.container.db._read() as conn:
                    self.assertEqual(conn.execute(
                        "SELECT disposition FROM gallery_review_images WHERE review_id=? AND id=?",
                        (rid, victim["asset_id"])).fetchone()["disposition"], "failed")
                    victim_ops = conn.execute(
                        "SELECT COUNT(*) FROM gallery_file_operation_items i JOIN gallery_file_operations o"
                        " ON o.id=i.operation_id WHERE i.asset_id=? AND o.kind='trash' AND o.status='committed'",
                        (victim["asset_id"],)).fetchone()[0]
                # 被篡改的图片 fail-closed：本任务不移动它（other-review 的外来回收除外）。
                self.assertEqual(victim_ops, 1 if change == "other-review" else 0)
                # Each scenario starts from a fresh library.
                if change != "other-review":
                    self.tearDown(); self.setUp()

    def test_api_contract_version_pagination_image_and_no_absolute_paths(self):
        client = local_test_client(create_app(self.container.settings, container=self.container), self.container.settings)
        response = client.post("/api/v1/gallery/reviews", json={"directory_ids": self.directory_ids})
        self.assertEqual(response.status_code, 202, response.text)
        created = response.json(); rid = created["review_id"]
        self.assertEqual(created["status"], "pending")
        self.assertNotIn("batch_id", created)
        async def runner(claimed):
            return selected_manifest(claimed), ""
        self.manager.runner = runner
        asyncio.run(self.container.reviews.run_once())
        response = client.get(f"/api/v1/gallery/reviews/{rid}?limit=1&offset=0&view=desktop&kind=duplicate")
        self.assertEqual(response.status_code, 200, response.text)
        detail = response.json()
        self.assertEqual(detail["groups"]["total"], 1)
        self.assertNotIn(str(self.root), json.dumps(detail))
        images = detail["groups"]["items"][0]["images"]
        self.assertEqual(len(images), 3)
        self.assertEqual(client.get(images[0]["url"]).status_code, 200)
        body = {"version": detail["version"], "selected_image_ids": [images[0]["id"]]}
        adopted = client.post(f"/api/v1/gallery/reviews/{rid}/groups/cross-source/adopt", json=body)
        self.assertEqual(adopted.status_code, 200, adopted.text)
        self.assertEqual(adopted.json()["status"], "ready")
        self.assertEqual(adopted.json()["keptImageCount"], 1)
        self.assertEqual(client.post(f"/api/v1/gallery/reviews/{rid}/groups/cross-source/adopt", json=body).status_code, 409)
        fresh = client.get(f"/api/v1/gallery/reviews/{rid}").json()
        self.assertEqual(client.post(f"/api/v1/gallery/reviews/{rid}/groups/missing/adopt",
                                     json={"version": fresh["version"], "selected_image_ids": [images[0]["id"]]}).status_code, 404)
        self.assertEqual(client.get(images[-1]["url"]).status_code, 200)
        self.assertEqual(client.get(f"/api/v1/gallery/reviews/{rid}").json()["review_id"], rid)
        self.assertEqual(client.get("/api/v1/gallery/reviews").status_code, 405)
        self.assertEqual(client.post(f"/api/v1/gallery/reviews/{rid}/retry").status_code, 409)
        self.assertEqual(client.post("/api/v1/gallery/reviews", json={"directory_ids": ["/etc"]}).status_code, 404)
        self.assertEqual(client.post("/api/v1/gallery/reviews", json={"directory_ids": self.directory_ids, "root_path": "/etc"}).status_code, 422)
        self.assertEqual(client.get("/api/v1/gallery/reviews/missing").status_code, 404)
        # 完成即结束：任务记录删除，此后所有操作 404。
        self.assertEqual(client.post(f"/api/v1/gallery/reviews/{rid}/finish").status_code, 204)
        self.assertEqual(client.get(f"/api/v1/gallery/reviews/{rid}").status_code, 404)
        self.assertEqual(client.post(f"/api/v1/gallery/reviews/{rid}/finish").status_code, 404)

    def test_service_schedules_only_new_gallery_reviews(self):
        from tests.test_review import create_terminal_batch
        create_terminal_batch(self.container.db, self.root, "unused-legacy")
        self.container.db.start_crawl_review("unused-legacy")
        ready = self.create_ready()
        self.assertEqual(ready["status"], "ready")
        self.assertFalse(asyncio.run(self.container.reviews.run_once()))
        self.assertEqual(self.container.db.get_crawl_review("unused-legacy")["status"], "pending")
        with self.container.db._read() as conn:
            self.assertIsNone(conn.execute("SELECT name FROM sqlite_master WHERE name='legacy_review_bindings'").fetchone())

    def test_new_partial_download_batch_registers_without_legacy_review(self):
        output = self.root / "downloads" / "partial"
        output.mkdir(parents=True)
        Image.new("RGB", (8, 8)).save(output / "success.png")
        self.container.db.create_crawl_batch(
            {"id": "partial", "output_dir": str(output), "concurrency": 1, "max_tasks": 10},
            [{"id": f"partial-{n}", "site": "test", "source_order": 0, "address_order": n,
              "url": f"https://example.com/{n}", "proxy_mode": "direct", "max_attempts": 1}
             for n in range(2)],
        )
        self.container.db.begin_crawl_address_planning("partial-0")
        self.container.db.finish_crawl_address_as_pre_deduplicated("partial-0", 1)
        self.container.db.begin_crawl_address_planning("partial-1")
        self.container.db.fail_crawl_address("partial-1", "download failed")
        self.assertTrue(self.container.db.finish_crawl_batch_if_ready("partial"))
        self.assertEqual(self.container.db.get_crawl_batch("partial")["status"], "completed_with_errors")
        source = self.container.db.gallery.get_source_by_batch_id("partial")
        self.assertIsNotNone(source)
        self.container.gallery_catalog.scan_source(source["source_id"])
        self.assertEqual(self.container.db.gallery.count_source_assets(source["source_id"]), 1)
        self.assertIsNone(self.container.db.get_crawl_review("partial"))
        with self.container.db._read() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM gallery_reviews").fetchone()[0], 0)
        self.container.db.finish_crawl_batch_if_ready("partial")
        self.assertEqual(self.container.db.gallery.get_source_by_batch_id("partial")["source_id"], source["source_id"])

    def test_manifest_out_of_scope_and_changed_input_fail_analysis_retry_same_snapshot(self):
        review = self.manager.create(self.directory_ids)
        rid = review["review_id"]
        async def runner(claimed):
            manifest = selected_manifest(claimed)
            manifest["groups"][0]["items"][0]["relative_path"] = "../../outside.png"
            return manifest, ""
        self.manager.runner = runner
        asyncio.run(self.container.reviews.run_once())
        self.assertEqual(self.container.db.gallery_reviews.get_crawl_review(rid)["status"], "failed")
        self.assertTrue(self.manager.retry_analysis(rid))
        async def good_runner(claimed):
            return selected_manifest(claimed), ""
        self.manager.runner = good_runner
        snapshot = self.container.db.gallery_reviews.snapshot(rid)[0]
        (Path(snapshot["root_path"]) / snapshot["relative_path"]).write_bytes(b"replacement")
        asyncio.run(self.container.reviews.run_once())
        self.assertEqual(self.container.db.gallery_reviews.get_crawl_review(rid)["status"], "failed")
        self.assertEqual(self.container.gallery_file_operations.list_trash()["operations"], [])
