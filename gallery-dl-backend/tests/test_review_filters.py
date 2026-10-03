from __future__ import annotations

import asyncio
import copy
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from gdl_backend.app import create_app
from gdl_backend.database import Database
from gdl_backend.review import DedupReviewManager
from tests import test_gallery_reviews as fixtures
from tests.helpers import local_test_client


def options(**changes):
    return {"basic_dedup": True, "filter_monochrome": False, "filter_sketch": False,
            "filter_character": False, "similarity_groups": True, "reference_asset_ids": [], **changes}


class PresetPersistenceTests(unittest.TestCase):
    def test_schema_13_upgrade_retains_legacy_review_with_null_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "legacy.db"
            db = Database(path)
            review = db.gallery_reviews.create([], [])
            with db._transaction() as conn:
                conn.execute("DROP TABLE gallery_review_presets")
                conn.execute("ALTER TABLE gallery_reviews DROP COLUMN filter_config_json")
                conn.execute("ALTER TABLE gallery_reviews DROP COLUMN reference_snapshot_json")
                conn.execute("UPDATE meta SET value='13' WHERE key='schema_version'")
            db.close()
            db = Database(path)
            result = db.gallery_reviews.get_crawl_review(review["review_id"])
            self.assertEqual(result["status"], "pending")
            self.assertIsNone(result["filter_config"])
            self.assertEqual(db.gallery_reviews.worker_input(review["review_id"])["references"], [])
            self.assertEqual(len(db.gallery_reviews.list_presets()), 2)
            db.close()

    def test_sqlite_persistence_and_builtin_values_cannot_be_mutated(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "presets.db"
            db = Database(path)
            builtins = db.gallery_reviews.list_presets()
            self.assertEqual([item["id"] for item in builtins], ["builtin-style", "builtin-character"])
            self.assertEqual(builtins[0]["options"], options(filter_monochrome=True, filter_sketch=True))
            self.assertEqual(builtins[1]["options"], options(filter_character=True))
            builtins[0]["options"]["basic_dedup"] = False
            self.assertTrue(db.gallery_reviews.list_presets()[0]["options"]["basic_dedup"])
            saved = db.gallery_reviews.save_preset("自定义", options(basic_dedup=False))
            db.gallery_reviews.delete_all_reviews()
            db.close()
            db = Database(path)
            self.assertEqual(db.gallery_reviews.list_presets()[-1], saved)
            changed = db.gallery_reviews.save_preset("修改", options(similarity_groups=False), preset_id=saved["id"])
            self.assertEqual(changed["id"], saved["id"])
            for builtin in ("builtin-style", "builtin-character"):
                with self.assertRaisesRegex(RuntimeError, "review_preset_builtin"):
                    db.gallery_reviews.save_preset("覆盖", options(), preset_id=builtin)
                with self.assertRaisesRegex(RuntimeError, "review_preset_builtin"):
                    db.gallery_reviews.delete_preset(builtin)
            db.gallery_reviews.delete_preset(saved["id"])
            self.assertEqual(len(db.gallery_reviews.list_presets()), 2)
            db.close()


class FilterReviewsTests(unittest.TestCase):
    setUp = fixtures.GalleryReviewsTests.setUp
    tearDown = fixtures.GalleryReviewsTests.tearDown

    def client(self):
        return local_test_client(create_app(self.container.settings, container=self.container, start_background=False),
                                 self.container.settings)

    def asset_ids(self):
        with self.container.db._read() as conn:
            return [row[0] for row in conn.execute("SELECT id FROM gallery_assets ORDER BY source_id,relative_path")]

    def test_preset_crud_validation_and_local_origin_guard(self):
        with self.client() as client:
            route = "/api/v1/gallery/review-presets"
            self.assertEqual(len(client.get(route).json()["items"]), 2)
            body = {"name": "  我的预设  ", "options": options()}
            response = client.post(route, json=body)
            self.assertEqual(response.status_code, 201, response.text)
            preset = response.json()
            self.assertEqual(preset["name"], "我的预设")
            self.assertFalse(preset["builtin"])
            body["name"] = "更新"
            self.assertEqual(client.put(f"{route}/{preset['id']}", json=body).json()["name"], "更新")
            for builtin in ("builtin-style", "builtin-character"):
                for response in (client.put(f"{route}/{builtin}", json=body), client.delete(f"{route}/{builtin}")):
                    self.assertEqual(response.status_code, 409)
                    self.assertEqual(response.json()["error"]["code"], "review_preset_builtin")
            self.assertEqual(client.put(f"{route}/missing", json=body).status_code, 404)
            self.assertEqual(client.delete(f"{route}/missing").status_code, 404)
            for bad in ({"name": " ", "options": options()},
                        {"name": "x", "options": options(basic_dedup=1)},
                        {"name": "x", "options": options(unknown=True)},
                        {"name": "x", "options": {"basic_dedup": True}},
                        {"name": "x", "options": options(), "builtin": True}):
                self.assertEqual(client.post(route, json=bad).status_code, 422)
            self.assertEqual(client.post(route, json=body, headers={"Origin": "https://evil.invalid"}).status_code, 403)
            response = client.delete(f"{route}/{preset['id']}")
            self.assertEqual((response.status_code, response.content), (204, b""))

    def test_config_freeze_reference_selection_and_worker_input(self):
        ids = self.asset_ids()
        preset = self.container.db.gallery_reviews.save_preset("冻结", options(reference_asset_ids=[ids[-1]]))
        config = {"preset_name": preset["name"], "options": preset["options"]}
        expected = copy.deepcopy(config)
        review = self.manager.create([], [ids[0]], config)
        rid = review["review_id"]
        config["options"]["basic_dedup"] = False
        self.container.db.gallery_reviews.save_preset("已修改", options(), preset_id=preset["id"])
        claimed = self.container.db.gallery_reviews.claim_next_crawl_review()
        self.assertEqual(claimed["filter_config"], expected)
        self.assertEqual([s["asset_id"] for s in claimed["images"]], [ids[0]])
        self.assertEqual([s["asset_id"] for s in claimed["references"]], [ids[-1]])
        self.assertEqual(self.container.db.gallery_reviews.get_crawl_review(rid)["filter_config"], expected)
        with self.client() as client:
            detail = client.get(f"/api/v1/gallery/reviews/{rid}").json()
            self.assertEqual(detail["filter_config"], expected)
            self.assertNotIn("references", detail)
            legacy = client.post("/api/v1/gallery/reviews", json={"asset_ids": [ids[0]]})
            self.assertEqual(legacy.status_code, 202)
            self.assertIsNone(legacy.json()["filter_config"])

    def test_references_missing_invalid_changed_or_linked_fail_closed(self):
        ids = self.asset_ids()
        with self.client() as client:
            def submit(refs):
                return client.post("/api/v1/gallery/reviews", json={"asset_ids": [ids[0]], "filter_config": {
                    "preset_name": "角色", "options": options(filter_character=True, reference_asset_ids=refs)}})
            response = submit([])
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json()["error"]["code"], "filter_reference_required")
            for refs in (["missing"], ["/etc/passwd"]):
                response = submit(refs)
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json()["error"]["code"], "filter_reference_invalid")
            response = submit([ids[-1]])
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["error"]["details"]["filters"][0]["option"], "filter_character")
            from PIL import Image
            with mock.patch("PIL.Image.open", side_effect=Image.DecompressionBombError("oversized")):
                self.assertEqual(submit([ids[-1]]).json()["error"]["code"], "filter_reference_invalid")
            with mock.patch("PIL.Image.open") as open_image:
                open_image.return_value.__enter__.return_value.n_frames = 2
                response = submit([ids[-1]])
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json()["error"]["code"], "filter_reference_invalid")
            ref = self.container.db.gallery.get_asset(ids[-1])
            source = self.container.db.gallery.get_source(ref["source_id"])
            path = Path(source["root_path"]) / ref["relative_path"]
            path.unlink()
            path.symlink_to(Path(self.sources[0]["root_path"]) / "nested/a.png")
            self.assertEqual(submit([ids[-1]]).json()["error"]["code"], "filter_reference_invalid")

    def test_unavailable_filters_are_explicit_and_do_not_create_tasks(self):
        ids = self.asset_ids()
        with self.client() as client:
            capabilities = client.get("/api/v1/setup/models").json()["review_filters"]
            for flag in ("filter_monochrome", "filter_sketch", "filter_character"):
                self.assertFalse(capabilities[flag]["available"])
                config = {"preset_name": flag, "options": options(**{flag: True}, reference_asset_ids=[ids[-1]])}
                response = client.post("/api/v1/gallery/reviews", json={"asset_ids": [ids[0]], "filter_config": config})
                self.assertEqual(response.status_code, 409, response.text)
                self.assertEqual(response.json()["error"]["code"], "review_filter_unavailable")
                self.assertTrue(response.json()["error"]["details"]["filters"][0]["reason"])
            with self.container.db._read() as conn:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM gallery_reviews").fetchone()[0], 0)
            self.assertEqual(self.container.gallery_file_operations.list_trash()["operations"], [])

    def test_filtered_winner_and_all_filtered_recycle_once_with_txt_and_restore(self):
        config = {"preset_name": "stub", "options": options(filter_monochrome=True, similarity_groups=False)}
        with mock.patch("gdl_backend.gallery_review.require_filter_capabilities"):
            review = self.manager.create(self.directory_ids, filter_config=config)
        rid = review["review_id"]
        async def runner(claimed):
            result = fixtures.selected_manifest(claimed)
            images = result["groups"][0]["items"]
            result.update(filter_config=claimed["filter_config"], groups=[],
                          auto_groups=[{"id": "dedup", "kind": "exact", "winner": images[0], "rejected_items": [images[1]]}],
                          filtered_items=[{**images[n], "reason": "filter_monochrome"} for n in (0, 2)])
            return result, ""
        self.manager.runner = runner
        with mock.patch.object(self.container.gallery_file_operations, "purge_trash", side_effect=AssertionError("no purge")):
            self.assertTrue(asyncio.run(self.manager.run_once()))
        repo = self.container.db.gallery_reviews
        result = repo.get_crawl_review(rid)
        self.assertEqual(result["status"], "ready")
        self.assertEqual((result["total_image_count"], result["automatic_rejected_image_count"], result["filtered_image_count"],
                          result["rejected_image_count"]), (3, 3, 2, 3))
        self.assertEqual(repo.list_crawl_review_groups(rid)["total"], 0)
        automatic = repo.crawl_review_automatic_images(rid)
        self.assertEqual(len({image["id"] for image in automatic}), 3)
        with self.assertRaises(ValueError):
            repo.update_crawl_review_decisions(rid, [{"group_id": automatic[-1]["group_id"], "selected_image_ids": []}])
        snapshots = {s["asset_id"]: s for s in repo.snapshot(rid)}
        for image in automatic:
            snapshot = snapshots[image["id"]]
            handle, _ = self.manager.image_content(rid, image["id"])
            handle.close()
            path = Path(snapshot["root_path"]) / image["final_relative_path"]
            self.assertTrue(path.is_file())
            self.assertEqual(path.with_suffix(".txt").read_text(), snapshot["relative_path"])
            operation_id = image["final_relative_path"].split("/")[2]
            self.container.gallery_file_operations.restore_trash(operation_id)
            self.assertTrue((Path(snapshot["root_path"]) / snapshot["relative_path"]).is_file())
        self.assertEqual(self.container.gallery_file_operations.list_trash()["operations"], [])

    def test_manifest_coverage_duplicates_configuration_and_winner_validation(self):
        claimed = {"review_id": "test", "filter_config": {"preset_name": "stub", "options": options(filter_monochrome=True)},
                   "images": [{"asset_id": str(n), "source_id": "source", "relative_path": f"{n}.png"} for n in range(3)]}
        manifest = fixtures.selected_manifest(claimed)
        images = manifest["groups"][0]["items"]
        manifest.update(filter_config=copy.deepcopy(claimed["filter_config"]),
                        groups=[{"id": "single", "kind": "single", "items": [images[2]]}],
                        auto_groups=[{"id": "dedup", "kind": "exact", "winner": images[0], "rejected_items": [images[1]]}],
                        filtered_items=[{**images[0], "reason": "filter_monochrome"}])
        DedupReviewManager._validate_manifest(claimed, manifest)
        for change in ("missing", "double", "unknown", "fake_manual", "outside", "winner", "unenabled", "config", "basic", "similarity"):
            bad = copy.deepcopy(manifest)
            request = copy.deepcopy(claimed)
            if change == "missing": bad["groups"] = []
            elif change == "double": bad["filtered_items"].append({**images[1], "reason": "filter_monochrome"})
            elif change == "unknown": bad["auto_groups"][0]["kind"] = "filter_monochrome"
            elif change == "fake_manual": bad["groups"][0]["kind"] = "auto_filtered"
            elif change == "outside": bad["filtered_items"][0]["relative_path"] = "/etc/passwd"
            elif change == "winner": bad["auto_groups"][0]["winner"] = images[1]
            elif change == "unenabled": bad["filtered_items"][0]["reason"] = "filter_sketch"
            elif change == "config": bad["filter_config"]["preset_name"] = "changed"
            elif change == "basic":
                request["filter_config"]["options"]["basic_dedup"] = False
                bad["filter_config"] = copy.deepcopy(request["filter_config"])
            elif change == "similarity":
                request["filter_config"]["options"]["similarity_groups"] = False
                bad["filter_config"] = copy.deepcopy(request["filter_config"])
                bad["groups"][0]["items"].append(images[0])
            with self.subTest(change=change), self.assertRaises(ValueError):
                DedupReviewManager._validate_manifest(request, bad)

    def test_frozen_reference_snapshot_revalidated_before_worker(self):
        ids = self.asset_ids()
        review = self.manager.create([], [ids[0]], {"preset_name": "refs", "options": options(reference_asset_ids=[ids[-1]])})
        claimed = self.container.db.gallery_reviews.worker_input(review["review_id"])
        reference = claimed["references"][0]
        (Path(reference["root_path"]) / reference["relative_path"]).write_bytes(b"changed")
        with self.assertRaises(RuntimeError):
            self.manager._validate_input(claimed)
