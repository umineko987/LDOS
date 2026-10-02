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

    def decide(self, review_id, selected):
        repo = self.container.db.gallery_reviews
        review = repo.get_crawl_review(review_id)
        repo.update_crawl_review_decisions(review_id, [{"group_id": "cross-source", "selected_image_ids": selected}], version=review["version"])
        return repo.get_crawl_review(review_id)

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

    def test_keep_in_place_auto_and_manual_trash_restore_txt_and_counts(self):
        review = self.create_ready(automatic=True)
        rid = review["review_id"]
        snapshots = self.container.db.gallery_reviews.snapshot(rid)
        self.assertEqual(review["rejected_image_count"], 1)
        self.assertEqual(review["status"], "ready")
        review = self.decide(rid, [snapshots[0]["asset_id"]])
        with mock.patch.object(self.container.gallery_file_operations, "purge_trash", side_effect=AssertionError("no purge")):
            applied = self.manager.apply(rid, version=review["version"])
        self.assertEqual(applied["status"], "applied")
        self.assertEqual((applied["kept_image_count"], applied["rejected_image_count"]), (1, 2))
        keeper = Path(snapshots[0]["root_path"]) / snapshots[0]["relative_path"]
        self.assertTrue(keeper.is_file())
        self.assertEqual(keeper.with_suffix(".txt").read_text(), snapshots[0]["relative_path"])
        self.assertEqual(self.container.db.gallery.get_root_directory(snapshots[0]["source_id"])["recursive_asset_count"], 1)
        trash = self.container.gallery_file_operations.list_trash()
        self.assertEqual(len(trash["operations"]), 2)
        for s in snapshots[1:]:
            op = review_trash_operation_id(rid, s["asset_id"])
            trashed = Path(s["root_path"]) / f".ldos/trash/{op}/files/{s['relative_path']}"
            self.assertTrue(trashed.is_file())
            self.assertEqual(trashed.with_suffix(".txt").read_text(), s["relative_path"])
            self.container.gallery_file_operations.restore_trash(op)
            original = Path(s["root_path"]) / s["relative_path"]
            self.assertTrue(original.is_file())
            self.assertEqual(original.with_suffix(".txt").read_text(), s["relative_path"])
        # Repeated apply acknowledges completion, never re-trashes restored files.
        self.assertEqual(self.manager.apply(rid, version=applied["version"])["status"], "applied")
        for s in snapshots:
            self.assertTrue((Path(s["root_path"]) / s["relative_path"]).is_file())

    def test_committed_trash_crash_gap_restart_retry_is_idempotent(self):
        review = self.create_ready()
        rid = review["review_id"]
        snapshots = self.container.db.gallery_reviews.snapshot(rid)
        review = self.decide(rid, [snapshots[0]["asset_id"]])
        repo = self.container.db.gallery_reviews
        original = repo.finish_crawl_review_image
        def crash(review_id, image_id, disposition, **kwargs):
            if disposition == "rejected":
                raise SystemExit("crash after trash commit")
            return original(review_id, image_id, disposition, **kwargs)
        with mock.patch.object(repo, "finish_crawl_review_image", side_effect=crash):
            with self.assertRaises(SystemExit):
                self.manager.apply(rid, version=review["version"])
        self.assertEqual(len(self.container.gallery_file_operations.list_trash()["operations"]), 1)
        self.container.gallery_catalog.stop()
        self.container.db.close()
        self.container = ServiceContainer(self.container.settings)
        self.manager = self.container.gallery_reviews
        self.container.db.gallery_reviews.recover_crawl_reviews()
        self.container.gallery_file_operations.recover_unfinished()
        review = self.container.db.gallery_reviews.get_crawl_review(rid)
        self.assertEqual(review["status"], "apply_failed")
        applied = self.manager.apply(rid, version=review["version"])
        self.assertEqual(applied["status"], "applied")
        self.assertEqual(len(self.container.gallery_file_operations.list_trash()["operations"]), 2)

    def test_interrupted_file_operation_resumes_image_txt_pair(self):
        review = self.create_ready()
        rid = review["review_id"]
        snapshots = self.container.db.gallery_reviews.snapshot(rid)
        review = self.decide(rid, [snapshots[0]["asset_id"]])
        with mock.patch.object(self.container.gallery_file_operations, "_commit_trash_index",
                               side_effect=SystemExit("crash after file moves")):
            with self.assertRaises(SystemExit):
                self.manager.apply(rid, version=review["version"])
        self.container.gallery_catalog.stop()
        self.container.db.close()
        self.container = ServiceContainer(self.container.settings)
        self.manager = self.container.gallery_reviews
        self.container.db.gallery_reviews.recover_crawl_reviews()
        recovered = self.container.gallery_file_operations.recover_unfinished()
        self.assertEqual(recovered[0]["outcome"], "committed")
        review = self.container.db.gallery_reviews.get_crawl_review(rid)
        self.assertEqual(self.manager.apply(rid, version=review["version"])["status"], "applied")
        for s in snapshots[1:]:
            op = review_trash_operation_id(rid, s["asset_id"])
            path = Path(s["root_path"]) / f".ldos/trash/{op}/files/{s['relative_path']}"
            self.assertTrue(path.is_file())
            self.assertEqual(path.with_suffix(".txt").read_text(), s["relative_path"])

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
                review = self.decide(rid, [snapshots[0]["asset_id"]])
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
                failed = self.manager.apply(rid, version=review["version"])
                self.assertEqual(failed["status"], "apply_failed")
                self.assertGreater(failed["failed_image_count"], 0)
                self.assertEqual(len(self.container.gallery_file_operations.list_trash()["operations"]), before_trash)
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
        body = {"version": detail["version"], "groups": [{"group_id": "cross-source", "selected_image_ids": [images[0]["id"]]}]}
        decided = client.put(f"/api/v1/gallery/reviews/{rid}/decisions", json=body)
        self.assertEqual(decided.status_code, 200, decided.text)
        self.assertEqual(client.put(f"/api/v1/gallery/reviews/{rid}/decisions", json=body).status_code, 409)
        applied = client.post(f"/api/v1/gallery/reviews/{rid}/apply", json={"version": decided.json()["version"]})
        self.assertEqual(applied.status_code, 200, applied.text)
        self.assertEqual(applied.json()["status"], "applied")
        self.assertEqual(client.get(images[-1]["url"]).status_code, 200)
        self.assertEqual(client.get("/api/v1/gallery/reviews").json()["items"][0]["review_id"], rid)
        self.assertEqual(client.post(f"/api/v1/gallery/reviews/{rid}/retry").status_code, 409)
        self.assertEqual(client.post("/api/v1/gallery/reviews", json={"directory_ids": ["/etc"]}).status_code, 404)
        self.assertEqual(client.post("/api/v1/gallery/reviews", json={"directory_ids": self.directory_ids, "root_path": "/etc"}).status_code, 422)
        self.assertEqual(client.get("/api/v1/gallery/reviews/missing").status_code, 404)

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
        self.assertEqual(self.container.db.gallery_reviews.list()["total"], 0)
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
