"""数据集清洗 / 去重阶段：在图库审核上运行、读分组、逐组定夺、撤销。"""

from __future__ import annotations

import asyncio
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.gallery_review import review_trash_operation_id
from gdl_backend.job_sampler import default_job_sources
from tests.helpers import local_test_client, make_settings


def png_bytes(index: int) -> bytes:
    image = Image.new("RGB", (8, 6), (index % 256, (index * 7) % 256, (index * 13) % 256))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def entry(snapshot: dict, *, recommended: bool = False, **metadata) -> dict:
    return {
        "id": snapshot["asset_id"],
        "relative_path": snapshot["source_id"] + "/" + snapshot["relative_path"],
        "readable": True,
        "recommended": recommended,
        "metadata": {"w": 8, "h": 6, "size": 123, "format": "png", "sharpness": 0.5, **metadata},
    }


def by_name(claimed: dict) -> dict[str, dict]:
    return {Path(snapshot["relative_path"]).name: snapshot for snapshot in claimed["images"]}


def clean_manifest(claimed: dict, *, monochrome=(), rough=(), filtered=()) -> dict:
    """只过滤不分组：每张图单独成组，角色过滤不匹配的进 filtered_items。"""
    groups, filtered_items = [], []
    for name, snapshot in sorted(by_name(claimed).items()):
        if name in filtered:
            filtered_items.append({**entry(snapshot), "reason": "filter_character"})
            continue
        extra = {"classification": "monochrome"} if name in monochrome else (
            {"classification": "rough"} if name in rough else {})
        groups.append({"id": f"single:{name}", "kind": "single", "items": [entry(snapshot, recommended=True, **extra)]})
    return {"schema_version": 3, "review_id": claimed["review_id"], "counts": {"images": len(claimed["images"])},
            "filter_config": claimed["filter_config"], "groups": groups, "filtered_items": filtered_items,
            "auto_groups": []}


def dedup_manifest(claimed: dict, *, duplicate=("000.png", "001.png", "002.png"), exact=("003.png", "000.png")) -> dict:
    """一个三张的相似组 + 一个完全相同的自动组（003 被淘汰，保留 000）。"""
    images = by_name(claimed)
    rejected, winner = exact
    groups = [{"id": "dup-1", "kind": "duplicate",
               "items": [entry(images[name], recommended=n == 0) for n, name in enumerate(duplicate)]}]
    for name, snapshot in sorted(images.items()):
        if name not in duplicate and name != rejected:
            groups.append({"id": f"single:{name}", "kind": "single", "items": [entry(snapshot, recommended=True)]})
    return {"schema_version": 3, "review_id": claimed["review_id"], "counts": {"images": len(images)},
            "filter_config": claimed["filter_config"], "groups": groups,
            "auto_groups": [{"id": "auto-exact-1", "kind": "exact", "winner": entry(images[winner]),
                             "rejected_items": [entry(images[rejected])]}]}


class DatasetTriageTestBase(unittest.TestCase):
    image_count = 6

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.settings = make_settings(self.root)
        self.settings.dedup.enabled = True
        # 模型目录放进临时目录：结果不受本机是否装了过滤模型影响。
        self.settings.dedup.model_dir = self.root / "models"
        # 过滤模型不在测试环境里：能力探测放行（worker 由假 runner 代替）。
        self.capabilities = mock.patch("gdl_backend.gallery_review.require_filter_capabilities")
        self.capabilities.start()
        self.addCleanup(self.capabilities.stop)
        self.container = ServiceContainer(self.settings)
        self.app = create_app(self.settings, container=self.container, start_background=False)
        client_context = local_test_client(self.app, self.settings)
        self.client = client_context.__enter__()
        self.addCleanup(client_context.__exit__, None, None, None)
        self.db = self.container.db
        self.triage = self.container.dataset_triage
        base = self.root / "lib"
        (base / "imgs").mkdir(parents=True)
        for index in range(self.image_count):
            (base / "imgs" / f"{index:03d}.png").write_bytes(png_bytes(index))
        self.base = base
        catalog = self.container.gallery_catalog
        source = catalog.import_source(str(base), display_name="lib")
        catalog.scan_source(source["source_id"])
        self.source_id = str(source["source_id"])
        self.dataset_id = self.container.datasets.create(name="角色A", kind="character")["dataset_id"]
        directory = self.db.gallery.get_root_directory(self.source_id)
        self.container.datasets.attach_directory(self.dataset_id, directory["directory_id"])
        with self.db._read() as conn:
            rows = conn.execute("SELECT id, name FROM gallery_assets WHERE source_id=?", (self.source_id,)).fetchall()
        self.assets = {str(row["name"]): str(row["id"]) for row in rows}

    def url(self, suffix: str) -> str:
        return f"/api/v1/datasets/{self.dataset_id}/stages/{suffix}"

    def run_worker(self, build) -> None:
        async def runner(claimed):
            return build(claimed), ""

        self.container.gallery_reviews.runner = runner
        self.assertTrue(asyncio.run(self.container.reviews.run_once()))

    def start(self, stage: str, body: dict | None = None) -> dict:
        response = self.client.post(self.url(f"{stage}/run"), json=body or {})
        self.assertEqual(response.status_code, 202, response.text)
        return response.json()

    def decisions(self, stage: str) -> dict[str, tuple[str, str]]:
        return {row["asset_id"]: (row["decision"], row["reason"])
                for row in self.db.datasets.list_decisions(self.dataset_id) if row["stage"] == stage}

    def events(self, kind: str) -> list[dict]:
        events, _ = self.container.events.events_after(0)
        return [dict(event.data) for event in events if event.kind == kind]

    def trashed(self, name: str) -> bool:
        return self.db.gallery.get_asset(self.assets[name])["lifecycle_state"] == "trashed"


class CleanStageTest(DatasetTriageTestBase):
    def test_clean_is_a_filter_only_review_that_flags_classified_images(self) -> None:
        started = self.start("clean")
        self.assertEqual(started["run"]["status"], "running")
        self.assertEqual(started["review_status"], "pending")
        snapshot = self.db.gallery_reviews.worker_input(started["review_id"])
        options = snapshot["filter_config"]["options"]
        # 清洗只开过滤器：基础去重和相似分组都关。
        self.assertFalse(options["basic_dedup"])
        self.assertFalse(options["similarity_groups"])
        self.assertTrue(options["filter_monochrome"] and options["filter_sketch"])
        self.assertEqual(len(snapshot["images"]), self.image_count)

        self.run_worker(lambda claimed: clean_manifest(claimed, monochrome={"001.png"}, rough={"002.png"}))
        summary = self.client.get(self.url("clean/triage")).json()
        self.assertEqual(summary["run"]["status"], "succeeded")
        self.assertEqual(summary["review_status"], "ready")
        self.assertEqual(summary["counts"]["flagged"], 2)
        self.assertEqual(summary["counts"]["pending_groups"], 2)
        self.assertEqual(summary["run"]["stats"]["input_count"], self.image_count)

        items = self.client.get(self.url("clean/items")).json()
        self.assertEqual(items["total"], 2)
        self.assertEqual({item["name"]: item["reasons"] for item in items["items"]},
                         {"001.png": ["monochrome"], "002.png": ["rough"]})
        member = items["items"][0]
        self.assertEqual((member["width"], member["height"], member["size_bytes"]), (8, 6, 123))
        self.assertTrue(member["thumbnail_url"].startswith("/api/v1/gallery/assets/"))
        self.assertIn(f"/api/v1/gallery/reviews/{items['review_id']}/images/", member["image_url"])
        rough = self.client.get(self.url("clean/items"), params={"reason": "rough"}).json()
        self.assertEqual([item["name"] for item in rough["items"]], ["002.png"])

        stage_events = self.events("dataset.stage.updated")
        self.assertEqual([event["status"] for event in stage_events], ["running", "succeeded"])
        self.assertEqual(stage_events[-1]["dataset_id"], self.dataset_id)

    def test_missing_filter_models_are_reported(self) -> None:
        self.capabilities.stop()
        response = self.client.post(self.url("clean/run"), json={})
        self.capabilities.start()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "review_filter_unavailable")
        self.assertIn("filters", response.json()["error"]["details"])
        self.assertIsNone(self.client.get(self.url("clean/triage")).json()["run"])

    def test_clean_needs_at_least_one_filter(self) -> None:
        response = self.client.post(self.url("clean/run"), json={"options": {
            "filter_monochrome": False, "filter_sketch": False, "filter_character": False}})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "clean_stage_no_filters")
        invalid = self.client.post(f"/api/v1/datasets/{self.dataset_id}/stages/tag/run", json={})
        self.assertEqual(invalid.status_code, 422)

    def test_character_filter_auto_trashes_and_records_exclusions(self) -> None:
        reference = self.assets["005.png"]
        started = self.start("clean", {"options": {
            "filter_monochrome": False, "filter_sketch": False,
            "filter_character": True, "reference_asset_ids": [reference]}})
        self.run_worker(lambda claimed: clean_manifest(claimed, filtered={"003.png", "004.png"}))
        self.assertTrue(self.trashed("003.png") and self.trashed("004.png"))
        self.assertEqual(self.decisions("clean"), {
            self.assets["003.png"]: ("exclude", "filter_character"),
            self.assets["004.png"]: ("exclude", "filter_character"),
        })
        # 被自动回收的图仍在数据集里（显示为已排除），但下一段不再拿到它。
        dedup_input = {member["name"] for member in self.container.datasets.stage_input(self.dataset_id, "dedup")}
        self.assertNotIn("003.png", dedup_input)
        items = self.client.get(self.url("clean/items"), params={"reason": "filter_character"}).json()
        self.assertEqual(sorted(item["name"] for item in items["items"]), ["003.png", "004.png"])
        self.assertTrue(all(item["automatic"] and item["trashed"] for item in items["items"]))
        self.assertEqual(self.client.get(self.url("clean/triage")).json()["counts"]["automatic_excluded"], 2)

        # 定夺自动组：把误伤的 003 找回来，撤销后又回到回收区并恢复自动原因。
        group_id = next(item["group_id"] for item in items["items"] if item["name"] == "003.png")
        applied = self.client.post(self.url("clean/apply"), json={
            "run_id": started["run"]["run_id"], "groups": [{"group_id": group_id, "keep": [self.assets["003.png"]]}]})
        self.assertEqual(applied.status_code, 200, applied.text)
        self.assertEqual(applied.json()["kept"], [self.assets["003.png"]])
        self.assertFalse(self.trashed("003.png"))
        self.assertEqual(self.decisions("clean")[self.assets["003.png"]], ("approve", "triage"))
        undone = self.client.post(self.url("clean/undo"), json={})
        self.assertEqual(undone.status_code, 200, undone.text)
        self.assertTrue(self.trashed("003.png"))
        self.assertEqual(self.decisions("clean")[self.assets["003.png"]], ("exclude", "filter_character"))


class DedupStageTest(DatasetTriageTestBase):
    def test_dedup_groups_expose_members_keeper_and_automatic_winner(self) -> None:
        started = self.start("dedup")
        options = self.db.gallery_reviews.worker_input(started["review_id"])["filter_config"]["options"]
        self.assertTrue(options["basic_dedup"] and options["similarity_groups"])
        self.assertFalse(any(options[key] for key in ("filter_monochrome", "filter_sketch", "filter_character")))
        self.run_worker(dedup_manifest)

        self.assertTrue(self.trashed("003.png"))
        self.assertEqual(self.decisions("dedup"), {self.assets["003.png"]: ("exclude", "auto_exact")})
        page = self.client.get(self.url("dedup/groups")).json()
        groups = {group["kind"]: group for group in page["items"]}
        self.assertEqual(set(groups), {"duplicate", "auto_exact"})
        duplicate = groups["duplicate"]
        self.assertEqual(duplicate["suggested_keep"], [self.assets["000.png"]])
        self.assertEqual([member["name"] for member in duplicate["members"]], ["000.png", "001.png", "002.png"])
        self.assertEqual(groups["auto_exact"]["winner_asset_id"], self.assets["000.png"])
        self.assertTrue(groups["auto_exact"]["members"][0]["trashed"])
        manual = self.client.get(self.url("dedup/groups"), params={"include_automatic": "false", "state": "pending"}).json()
        self.assertEqual([group["kind"] for group in manual["items"]], ["duplicate"])
        summary = self.client.get(self.url("dedup/triage")).json()
        self.assertEqual((summary["counts"]["groups"], summary["counts"]["pending_groups"]), (1, 1))
        self.assertEqual(summary["counts"]["automatic_excluded"], 1)

    def test_apply_trashes_rejects_records_decisions_and_undo_restores(self) -> None:
        started = self.start("dedup")
        self.run_worker(dedup_manifest)
        keep = self.assets["001.png"]
        response = self.client.post(self.url("dedup/apply"), json={
            "run_id": started["run"]["run_id"], "groups": [{"group_id": "dup-1", "keep": [keep]}]})
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["kept"], [keep])
        self.assertEqual(sorted(result["rejected"]), sorted([self.assets["000.png"], self.assets["002.png"]]))
        self.assertIsNone(result["error"])
        self.assertEqual(result["summary"]["undo_depth"], 1)
        self.assertTrue(self.trashed("000.png") and self.trashed("002.png"))
        operation = review_trash_operation_id(started["review_id"], self.assets["000.png"])
        self.assertTrue((self.base / f".ldos/trash/{operation}/files/imgs/000.png").is_file())
        decisions = self.decisions("dedup")
        self.assertEqual(decisions[keep], ("approve", "triage"))
        self.assertEqual(decisions[self.assets["000.png"]], ("exclude", "triage"))
        tag_input = {member["name"] for member in self.container.datasets.stage_input(self.dataset_id, "tag")}
        self.assertEqual(tag_input, {"001.png", "004.png", "005.png"})
        decided = self.client.get(self.url("dedup/groups"), params={"state": "decided", "include_automatic": "false"}).json()
        self.assertEqual(decided["total"], 1)
        self.assertGreaterEqual(len(self.events("dataset.updated")), 2)

        undone = self.client.post(self.url("dedup/undo"), json={"batch_id": result["batch_id"]})
        self.assertEqual(undone.status_code, 200, undone.text)
        self.assertEqual(undone.json()["undone_groups"], 1)
        self.assertFalse(self.trashed("000.png") or self.trashed("002.png"))
        self.assertTrue((self.base / "imgs/000.png").is_file())
        self.assertEqual(self.decisions("dedup"), {self.assets["003.png"]: ("exclude", "auto_exact")})
        pending = self.client.get(self.url("dedup/groups"), params={"state": "pending", "include_automatic": "false"}).json()
        self.assertEqual(pending["total"], 1)
        again = self.client.post(self.url("dedup/undo"), json={})
        self.assertEqual(again.status_code, 409)
        self.assertEqual(again.json()["error"]["code"], "triage_nothing_to_undo")

    def test_apply_validates_run_group_and_members_before_touching_files(self) -> None:
        started = self.start("dedup")
        run_id = started["run"]["run_id"]
        busy = self.client.post(self.url("dedup/apply"), json={"run_id": run_id, "groups": [{"group_id": "dup-1"}]})
        self.assertEqual(busy.json()["error"]["code"], "stage_run_active")
        self.run_worker(dedup_manifest)
        cases = [
            ({"run_id": "other", "groups": [{"group_id": "dup-1"}]}, 409, "stage_run_superseded"),
            ({"run_id": run_id, "groups": [{"group_id": "nope"}]}, 404, "triage_group_not_found"),
            ({"run_id": run_id, "groups": [{"group_id": "dup-1", "keep": [self.assets["005.png"]]}]},
             422, "triage_asset_not_in_group"),
            ({"run_id": run_id, "groups": [{"group_id": "dup-1"}, {"group_id": "dup-1"}]},
             422, "triage_group_duplicate"),
        ]
        for body, status, code in cases:
            response = self.client.post(self.url("dedup/apply"), json=body)
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (status, code), body)
        self.assertFalse(self.trashed("000.png"))
        self.assertEqual(self.decisions("dedup"), {self.assets["003.png"]: ("exclude", "auto_exact")})

    def test_active_run_conflicts_and_rerun_retires_previous_review(self) -> None:
        first = self.start("dedup")
        busy = self.client.post(self.url("dedup/run"), json={})
        self.assertEqual((busy.status_code, busy.json()["error"]["code"]), (409, "stage_run_active"))
        self.run_worker(dedup_manifest)
        second = self.start("dedup")
        self.assertNotEqual(second["run"]["run_id"], first["run"]["run_id"])
        self.assertIsNone(self.db.gallery_reviews.get_crawl_review(first["review_id"]))
        # 自动回收的 003 已被排除，不在第二次的输入里。
        self.assertEqual(second["run"]["stats"]["input_count"], self.image_count - 1)

    def test_failed_review_fails_the_run(self) -> None:
        self.start("dedup")

        async def runner(claimed):
            raise RuntimeError("worker crashed")

        self.container.gallery_reviews.runner = runner
        asyncio.run(self.container.reviews.run_once())
        summary = self.client.get(self.url("dedup/triage")).json()
        self.assertEqual((summary["run"]["status"], summary["run"]["error_code"]), ("failed", "review_failed"))
        groups = self.client.get(self.url("dedup/groups"))
        self.assertEqual(groups.json()["error"]["code"], "stage_run_failed")

    def test_restart_expires_triage_and_interrupts_running_runs(self) -> None:
        self.start("dedup")
        self.run_worker(dedup_manifest)
        self.start("clean")
        # 后端重启：图库审核全部清空。
        self.db.gallery_reviews.delete_all_reviews()
        self.assertEqual(self.triage.recover(), 1)
        clean = self.client.get(self.url("clean/triage")).json()
        self.assertEqual((clean["run"]["status"], clean["run"]["error_code"]), ("failed", "interrupted"))
        expired = self.client.get(self.url("dedup/groups"))
        self.assertEqual((expired.status_code, expired.json()["error"]["code"]), (409, "stage_triage_expired"))
        self.assertEqual(self.client.get(self.url("dedup/triage")).json()["review_status"], "expired")
        # 已记下的决定保留。
        self.assertEqual(self.decisions("dedup"), {self.assets["003.png"]: ("exclude", "auto_exact")})

    def test_review_job_carries_dataset_ref(self) -> None:
        started = self.start("dedup")
        source = next(item for item in default_job_sources(self.container) if item.name == "reviews")
        self.container.gallery_reviews._current_batch_id = started["review_id"]
        source.sample(self.container.jobs)
        job = self.container.jobs.get(f"review:{started['review_id']}")
        self.assertEqual(job["title"], "去重分析")
        self.assertEqual(job["ref"]["dataset_id"], self.dataset_id)
        self.assertEqual(job["ref"]["run_id"], started["run"]["run_id"])
        self.container.gallery_reviews._current_batch_id = ""


class LargeDedupStageTest(DatasetTriageTestBase):
    image_count = 205

    def test_stage_run_covers_more_than_the_review_api_limit(self) -> None:
        started = self.start("dedup")
        self.assertEqual(len(self.db.gallery_reviews.worker_input(started["review_id"])["images"]), 205)
        self.run_worker(dedup_manifest)
        summary = self.client.get(self.url("dedup/triage")).json()
        self.assertEqual(summary["run"]["status"], "succeeded")
        self.assertEqual(summary["counts"]["input"], 205)
        self.assertEqual(len(self.container.datasets.stage_input(self.dataset_id, "tag")), 204)


if __name__ == "__main__":
    unittest.main()
