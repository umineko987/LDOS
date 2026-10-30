"""数据集导出：计划预览、kohya / 平铺布局、重命名、标注变换、续传、取消与目标校验。"""

from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.dataset_export import (
    DatasetExportService,
    safe_folder_name,
    staging_name,
    transform_caption,
)
from tests.helpers import local_test_client, make_settings


class _Crash(BaseException):
    """模拟进程在复制中途被杀：不经过任何收尾。"""


def png_bytes(color: str, size: tuple[int, int] = (6, 4), fmt: str = "PNG") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format=fmt)
    return buffer.getvalue()


class CaptionTransformTest(unittest.TestCase):
    def test_trigger_is_pinned_blacklist_removed_and_duplicates_dropped(self) -> None:
        caption = transform_caption(
            "1girl, solo, hero, smile_face, ^_^, rating_safe, Smile Face",
            trigger="hero", blacklist=["Rating Safe", "solo"], underscore_to_space=True,
        )
        self.assertEqual(caption, "hero, 1girl, smile face, ^_^")

    def test_underscores_are_kept_unless_requested_and_kaomoji_never_change(self) -> None:
        self.assertEqual(transform_caption("long_hair,\nblue_eyes", pin_trigger=False), "long_hair, blue_eyes")
        self.assertEqual(transform_caption("o_o, >_<, long_hair", pin_trigger=False, underscore_to_space=True),
                         "o_o, >_<, long hair")

    def test_empty_caption_gets_only_the_trigger(self) -> None:
        self.assertEqual(transform_caption("", trigger="hero"), "hero")
        self.assertEqual(transform_caption(" , ,", trigger=""), "")
        self.assertEqual(transform_caption("hero, a", trigger="hero", pin_trigger=False), "hero, a")

    def test_folder_names_are_portable(self) -> None:
        self.assertEqual(safe_folder_name('a/b:c*?'), "a_b_c__")
        self.assertEqual(safe_folder_name("  ..hidden.  "), "hidden")
        self.assertEqual(safe_folder_name("CON"), "CON_")
        self.assertEqual(safe_folder_name(""), "dataset")


class DatasetExportTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.settings = make_settings(self.root)
        self.container = ServiceContainer(self.settings)
        self.app = create_app(self.settings, container=self.container, start_background=False)
        client_context = local_test_client(self.app, self.settings)
        self.client = client_context.__enter__()
        self.addCleanup(client_context.__exit__, None, None, None)
        self.db = self.container.db
        # 同步复制，小块：测试里每个导出在请求返回前就跑完。
        self.service = DatasetExportService(
            database=self.db, datasets=self.container.datasets,
            filesystem_locks=self.container.gallery_filesystem_locks,
            jobs=self.container.jobs, events=self.container.events,
            chunk_size=7, threaded=False,
        )
        self.container.dataset_exports = self.service
        self.library = self.root / "lib"
        files: dict[str, bytes | str] = {
            "imgs/a.png": png_bytes("red"),
            "imgs/a.txt": "1girl, solo, hero, smile_face, ^_^, rating_safe",
            "imgs/b.png": png_bytes("green", (9, 5)),
            "imgs/b.txt": "long_hair,  blue_eyes, long_hair",
            "imgs/c.png": png_bytes("blue", (3, 3)),
            "sub/a.jpg": png_bytes("white", fmt="JPEG"),
            "sub/a.txt": "outdoors",
        }
        for relative, content in files.items():
            target = self.library / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, bytes):
                target.write_bytes(content)
            else:
                target.write_text(content, encoding="utf-8")
        catalog = self.container.gallery_catalog
        source = catalog.import_source(str(self.library), display_name="lib")
        catalog.scan_source(source["source_id"])
        self.source_id = str(source["source_id"])
        self.dataset_id = self.container.datasets.create(
            name="角色A", kind="character", trigger_word="hero")["dataset_id"]
        directory = self.db.gallery.get_root_directory(self.source_id)
        self.container.datasets.attach_directory(self.dataset_id, directory["directory_id"])
        with self.db._read() as conn:
            rows = conn.execute("SELECT id, relative_path FROM gallery_assets WHERE source_id=?",
                                (self.source_id,)).fetchall()
        self.assets = {str(row["relative_path"]): str(row["id"]) for row in rows}
        self.out = self.root / "out"
        self.out.mkdir()

    def body(self, **overrides) -> dict:
        return {"target_path": str(self.out), "tag_blacklist": ["rating_safe", "solo"],
                "underscore_to_space": True, **overrides}

    def export(self, **overrides) -> dict:
        response = self.client.post(f"/api/v1/datasets/{self.dataset_id}/exports", json=self.body(**overrides))
        self.assertEqual(response.status_code, 202, response.text)
        return response.json()["job"]

    def error(self, response) -> tuple[int, str]:
        return response.status_code, response.json()["error"]["code"]

    def tree(self, folder: str) -> dict[str, bytes]:
        base = self.out / folder
        return {str(path.relative_to(base)): path.read_bytes() for path in sorted(base.rglob("*")) if path.is_file()}

    def staging_dirs(self) -> list[str]:
        return [name for name in os.listdir(self.out) if name.startswith(".ldos-copy-")]

    def export_runs(self) -> list[dict]:
        return self.db.datasets.list_stage_runs(self.dataset_id, stage="export")


class PlanTest(DatasetExportTestBase):
    def test_dry_run_previews_targets_counts_collisions_and_bytes(self) -> None:
        response = self.client.post(f"/api/v1/datasets/{self.dataset_id}/exports",
                                    json=self.body(dry_run=True))
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertTrue(payload["dry_run"])
        self.assertIsNone(payload["job"])
        plan = payload["plan"]
        self.assertEqual(plan["folder_name"], "10_hero")
        self.assertEqual(plan["output_path"], str(self.out / "10_hero"))
        self.assertFalse(plan["target_exists"])
        self.assertEqual((plan["image_count"], plan["caption_count"]), (4, 4))
        # 自然排序（a.jpg 在 a.png 前）；同主干名的第二张加 _2。
        self.assertEqual([item["output_relative_path"] for item in plan["items"]],
                         ["a.jpg", "a_2.png", "b.png", "c.png"])
        self.assertEqual(plan["collisions"], [{"asset_id": self.assets["imgs/a.png"], "name": "a.png",
                                               "output_name": "a_2.png"}])
        self.assertEqual([item["caption_preview"] for item in plan["items"]],
                         ["hero, outdoors", "hero, 1girl, smile face, ^_^", "hero, long hair, blue eyes", "hero"])
        self.assertEqual(plan["items"][3]["caption_output_relative_path"], "c.txt")
        image_bytes = sum((self.library / path).stat().st_size
                          for path in ("imgs/a.png", "imgs/b.png", "imgs/c.png", "sub/a.jpg"))
        self.assertEqual(plan["image_bytes"], image_bytes)
        self.assertEqual(plan["total_bytes"], image_bytes + plan["txt_bytes"])
        self.assertEqual(plan["blockers"], [])
        # 预览不写任何东西。
        self.assertEqual(os.listdir(self.out), [])
        self.assertEqual(self.export_runs(), [])

    def test_target_and_option_validation(self) -> None:
        url = f"/api/v1/datasets/{self.dataset_id}/exports"
        (self.out / "10_hero").mkdir()
        conflict = self.client.post(url, json=self.body(dry_run=True)).json()["plan"]
        self.assertTrue(conflict["target_exists"])
        self.assertEqual(self.error(self.client.post(url, json=self.body())), (409, "export_target_exists"))
        cases = [
            (self.body(target_path="relative/out"), (422, "target_path_not_absolute")),
            (self.body(target_path=str(self.root / "missing")), (409, "target_unavailable")),
            (self.body(target_path=str(self.library / "imgs")), (409, "target_inside_source")),
            (self.body(folder_name="bad/name"), (422, "export_folder_name_invalid")),
            (self.body(trigger_word=""), (422, "export_trigger_required")),
            (self.body(layout="nested"), (422, "validation_error")),
        ]
        for body, expected in cases:
            self.assertEqual(self.error(self.client.post(url, json=body)), expected, body)
        missing = self.client.post("/api/v1/datasets/nope/exports", json=self.body())
        self.assertEqual(self.error(missing), (404, "dataset_not_found"))

    def test_only_the_export_stage_output_is_exported(self) -> None:
        self.db.datasets.set_decisions(self.dataset_id, "dedup", [self.assets["imgs/c.png"]], "exclude")
        self.db.datasets.set_decisions(self.dataset_id, "export", [self.assets["imgs/b.png"]], "exclude")
        plan = self.service.preview(self.dataset_id, self.body())
        self.assertEqual([item["output_relative_path"] for item in plan["items"]], ["a.jpg", "a_2.png"])
        for asset in self.assets.values():
            self.db.datasets.set_decisions(self.dataset_id, "export", [asset], "exclude")
        response = self.client.post(f"/api/v1/datasets/{self.dataset_id}/exports", json=self.body())
        self.assertEqual(self.error(response), (409, "export_empty"))

    def test_unreadable_caption_blocks_export_unless_captions_are_off(self) -> None:
        (self.library / "imgs/c.txt").write_bytes(b"\xff\xfe broken")
        self.container.gallery_catalog.scan_source(self.source_id)
        plan = self.service.preview(self.dataset_id, self.body())
        self.assertEqual(plan["blockers"], [{"code": "caption_unreadable", "count": 1,
                                             "ids": [self.assets["imgs/c.png"]]}])
        response = self.client.post(f"/api/v1/datasets/{self.dataset_id}/exports", json=self.body())
        self.assertEqual(self.error(response), (409, "export_caption_unreadable"))
        job = self.export(include_captions=False)
        self.assertEqual(job["status"], "succeeded")


class ExportRunTest(DatasetExportTestBase):
    def test_kohya_export_copies_images_and_writes_transformed_captions(self) -> None:
        job = self.export()
        self.assertEqual(job["status"], "succeeded", job)
        self.assertEqual(job["output_path"], str(self.out / "10_hero"))
        self.assertEqual((job["staged_items"], job["total_items"]), (4, 4))
        self.assertEqual(job["copied_bytes"], job["total_bytes"])
        tree = self.tree("10_hero")
        self.assertEqual(set(tree), {"a.jpg", "a.txt", "a_2.png", "a_2.txt", "b.png", "b.txt", "c.png", "c.txt"})
        self.assertEqual(tree["a.jpg"], (self.library / "sub/a.jpg").read_bytes())
        self.assertEqual(tree["a_2.png"], (self.library / "imgs/a.png").read_bytes())
        self.assertEqual(tree["a.txt"].decode(), "hero, outdoors")
        self.assertEqual(tree["a_2.txt"].decode(), "hero, 1girl, smile face, ^_^")
        self.assertEqual(tree["b.txt"].decode(), "hero, long hair, blue eyes")
        self.assertEqual(tree["c.txt"].decode(), "hero")
        self.assertEqual(self.staging_dirs(), [])
        # 源文件原样不动。
        self.assertEqual((self.library / "imgs/a.txt").read_text(encoding="utf-8"),
                         "1girl, solo, hero, smile_face, ^_^, rating_safe")

        runs = self.export_runs()
        self.assertEqual([(run["status"], run["ref_id"]) for run in runs], [("succeeded", job["export_id"])])
        self.assertEqual(runs[0]["stats"]["exported"], 4)
        published = self.container.events.events_after(0)[0]
        statuses = [event.data["status"] for event in published if event.kind == "dataset.export.updated"]
        self.assertEqual(statuses[0], "queued")
        self.assertEqual(statuses[-1], "succeeded")
        self.assertIn("running", statuses)
        self.assertIn({"dataset_id": self.dataset_id, "stage": "export", "export_id": job["export_id"],
                       "status": "succeeded"},
                      [event.data for event in published if event.kind == "dataset.stage.updated"])
        registry = self.container.jobs.get(job["job_id"])
        self.assertEqual((registry["status"], registry["ref"]["dataset_id"]), ("succeeded", self.dataset_id))

        listed = self.client.get(f"/api/v1/datasets/{self.dataset_id}/exports").json()["items"]
        self.assertEqual([item["export_id"] for item in listed], [job["export_id"]])
        fetched = self.client.get(f"/api/v1/exports/{job['export_id']}").json()
        self.assertEqual(fetched["status"], "succeeded")
        self.assertEqual(self.error(self.client.get("/api/v1/exports/nope")), (404, "export_not_found"))
        self.assertEqual(self.error(self.client.post(f"/api/v1/exports/{job['export_id']}/cancel")),
                         (409, "export_not_cancellable"))
        self.assertEqual(self.error(self.client.post(f"/api/v1/exports/{job['export_id']}/resume")),
                         (409, "export_not_resumable"))
        stored = self.db._conn.execute("SELECT dataset_id, options_json FROM dataset_export_jobs").fetchone()
        self.assertEqual(stored["dataset_id"], self.dataset_id)
        self.assertEqual(json.loads(stored["options_json"])["folder_name"], "10_hero")

    def test_flat_layout_with_sequential_rename_and_no_captions(self) -> None:
        job = self.export(layout="flat", rename="sequential", include_captions=False)
        self.assertEqual((job["status"], job["folder_name"]), ("succeeded", "角色A"))
        tree = self.tree("角色A")
        self.assertEqual(sorted(tree), ["0001.jpg", "0002.png", "0003.png", "0004.png"])
        self.assertEqual(tree["0003.png"], (self.library / "imgs/b.png").read_bytes())

    def test_sequential_rename_keeps_captions_paired(self) -> None:
        job = self.export(layout="flat", folder_name="set", rename="sequential", pin_trigger=False)
        tree = self.tree("set")
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual(tree["0001.txt"].decode(), "outdoors")
        self.assertEqual(tree["0002.txt"].decode(), "1girl, hero, smile face, ^_^")
        self.assertEqual(tree["0003.txt"].decode(), "long hair, blue eyes")
        self.assertNotIn("0004.txt", tree)  # c 没有标注，也不加触发词

    def test_resume_after_crash_copies_only_unfinished_items(self) -> None:
        def crash(export_id: str, index: int) -> None:
            if index == 2:
                raise _Crash()

        self.service.after_item = crash
        with self.assertRaises(_Crash):
            self.service.start(self.dataset_id, self.body())
        export_id = self.db._conn.execute("SELECT id FROM dataset_export_jobs").fetchone()["id"]
        staging = self.out / staging_name(export_id)
        self.assertEqual(self.service.get(export_id)["status"], "running")
        self.assertEqual(self.service.get(export_id)["staged_items"], 2)
        # 第三个文件写到一半时崩溃。
        (staging / "b.png").write_bytes(b"partial")

        self.assertEqual(self.service.recover(), 1)
        interrupted = self.service.get(export_id)
        self.assertEqual((interrupted["status"], interrupted["error_code"], interrupted["resumable"]),
                         ("interrupted", "export_interrupted", True))
        self.assertEqual(self.export_runs()[0]["error_code"], "export_interrupted")

        copied: list[int] = []
        self.service.after_item = lambda export_id, index: copied.append(index)
        resumed = self.client.post(f"/api/v1/exports/{export_id}/resume")
        self.assertEqual(resumed.status_code, 202, resumed.text)
        self.assertEqual(resumed.json()["status"], "succeeded")
        self.assertEqual(copied, [3, 4])
        tree = self.tree("10_hero")
        self.assertEqual(tree["b.png"], (self.library / "imgs/b.png").read_bytes())
        self.assertEqual(len(tree), 8)
        self.assertEqual(self.staging_dirs(), [])
        self.assertEqual([run["status"] for run in self.export_runs()], ["succeeded", "failed"])

    def test_crash_after_commit_is_recognised_on_resume(self) -> None:
        original = self.service._event

        def event(export_id, event_type, detail):
            original(export_id, event_type, detail)
            if event_type == "committed" and not detail.get("recovered"):
                raise _Crash()

        self.service._event = event
        with self.assertRaises(_Crash):
            self.service.start(self.dataset_id, self.body())
        self.service._event = original
        export_id = self.db._conn.execute("SELECT id FROM dataset_export_jobs").fetchone()["id"]
        self.assertTrue((self.out / "10_hero").is_dir())
        self.service.recover()
        copied: list[int] = []
        self.service.after_item = lambda export_id, index: copied.append(index)
        job = self.service.resume(export_id)
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual(copied, [])
        self.assertEqual(len(self.tree("10_hero")), 8)

    def test_cancel_mid_copy_removes_staging(self) -> None:
        def cancel(export_id: str, index: int) -> None:
            if index == 1:
                self.assertEqual(self.service.cancel(export_id)["status"], "running")

        self.service.after_item = cancel
        job = self.export()
        self.assertEqual(job["status"], "cancelled")
        self.assertEqual(os.listdir(self.out), [])
        self.assertEqual(self.export_runs()[0]["status"], "cancelled")
        self.assertFalse(job["resumable"])

    def test_cancel_racing_completion_keeps_succeeded(self) -> None:
        # 取消请求读到 running 之后、拿到锁之前，复制线程写完 succeeded 并释放了取消事件。
        job = self.export()
        self.assertEqual(job["status"], "succeeded")
        export_id = job["export_id"]
        real = self.service._require_row
        stale = {**dict(real(export_id)), "status": "running", "finished_at": None}
        calls = iter([stale])
        self.service._require_row = lambda value: next(calls, None) or real(value)
        try:
            response = self.client.post(f"/api/v1/exports/{export_id}/cancel")
        finally:
            self.service._require_row = real
        self.assertEqual(self.error(response), (409, "export_not_cancellable"))
        self.assertEqual(self.service.get(export_id)["status"], "succeeded")
        self.assertEqual(len(self.tree("10_hero")), 8)
        self.assertEqual(self.export_runs()[0]["status"], "succeeded")

    def test_resume_after_cancel_won_the_lock_is_rejected(self) -> None:
        def occupy(export_id: str, index: int) -> None:
            if index == 4:
                (self.out / "10_hero").mkdir()

        self.service.after_item = occupy
        job = self.export()
        self.assertTrue(job["resumable"])
        (self.out / "10_hero").rmdir()
        self.service.after_item = None
        export_id = job["export_id"]
        # 续传读到可续传之后、占位之前，另一个请求把它取消了。
        real_reserve = self.service._reserve

        def reserve_after_cancel(value: str, reservation: tuple[str, str]) -> None:
            self.service._reserve = real_reserve
            self.assertEqual(self.service.cancel(value)["status"], "cancelled")
            real_reserve(value, reservation)

        self.service._reserve = reserve_after_cancel
        response = self.client.post(f"/api/v1/exports/{export_id}/resume")
        self.assertEqual(self.error(response), (409, "export_not_resumable"))
        self.assertEqual(self.service.get(export_id)["status"], "cancelled")
        self.assertEqual(os.listdir(self.out), [])

    def test_name_taken_at_commit_keeps_staging_for_resume(self) -> None:
        def occupy(export_id: str, index: int) -> None:
            if index == 4:
                (self.out / "10_hero").mkdir()

        self.service.after_item = occupy
        job = self.export()
        self.assertEqual((job["status"], job["error_code"], job["resumable"]),
                         ("failed", "export_target_exists", True))
        self.assertEqual(job["error_details"], {"output_path": str(self.out / "10_hero")})
        self.assertEqual(len(self.staging_dirs()), 1)
        (self.out / "10_hero").rmdir()
        self.service.after_item = None
        resumed = self.client.post(f"/api/v1/exports/{job['export_id']}/resume").json()
        self.assertEqual(resumed["status"], "succeeded")
        self.assertEqual(len(self.tree("10_hero")), 8)

    def test_source_change_during_export_fails_and_cleans_up(self) -> None:
        def mutate(export_id: str, index: int) -> None:
            if index == 1:
                (self.library / "imgs/b.png").write_bytes(png_bytes("black", (20, 20)))

        self.service.after_item = mutate
        job = self.export()
        self.assertEqual((job["status"], job["error_code"]), ("failed", "source_changed"))
        self.assertEqual(job["error_details"], {"asset_id": self.assets["imgs/b.png"]})
        self.assertFalse(job["resumable"])
        self.assertEqual(os.listdir(self.out), [])


if __name__ == "__main__":
    unittest.main()
