"""数据集服务：成员推导、漏斗计数、阶段 stale、根目录导入与在线采集挂根。"""

from __future__ import annotations

import io
import os
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image

from gdl_backend._database_gallery_repository import gallery_asset_id, gallery_directory_id
from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.dataset_service import DatasetError, input_digest
from tests.helpers import local_test_client, make_settings


def png_bytes(color: str = "#336699") -> bytes:
    image = Image.new("RGB", (4, 3), color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class DatasetTestBase(unittest.TestCase):
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
        self.catalog = self.container.gallery_catalog
        self.service = self.container.datasets

    def write_files(self, base: Path, files: dict[str, bytes | str]) -> Path:
        base.mkdir(parents=True, exist_ok=True)
        for relative, content in files.items():
            target = base / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, bytes):
                target.write_bytes(content)
            else:
                target.write_text(content, encoding="utf-8")
        return base

    def import_library(self, files: dict[str, bytes | str], name: str = "lib") -> tuple[str, Path]:
        base = self.write_files(self.root / name, files)
        source = self.catalog.import_source(str(base), display_name=name)
        self.catalog.scan_source(source["source_id"])
        return str(source["source_id"]), base

    def wait_scan(self, source_id: str) -> None:
        for _ in range(300):
            if self.catalog.get_scan(source_id)["state"] != "running":
                return
            time.sleep(0.02)
        self.fail("扫描未在限时内完成")

    def new_dataset(self, name: str = "角色A") -> str:
        return self.service.create(name=name, kind="character")["dataset_id"]

    def member_paths(self, dataset_id: str) -> list[str]:
        return [member["relative_path"] for member in self.db.datasets.member_rows(dataset_id)]

    def stage(self, dataset_id: str, stage: str) -> dict:
        for item in self.service.funnel(dataset_id)["stages"]:
            if item["stage"] == stage:
                return item
        raise AssertionError(stage)

    def bump_mtime(self, path: Path) -> None:
        stat = path.stat()
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))


class MembershipTest(DatasetTestBase):
    def test_directory_root_uses_path_boundary(self) -> None:
        source_id, _ = self.import_library(
            {
                "a/b/1.png": png_bytes(),
                "a/b/2.png": png_bytes(),
                "a/b/sub/3.png": png_bytes(),
                "a/bc/x.png": png_bytes(),
                "a/b.png": png_bytes(),
                "a/b/keep/k.png": png_bytes(),
                "a/b/duplicates/d.png": png_bytes(),
            }
        )
        dataset_id = self.new_dataset()
        root, created = self.service.attach_directory(
            dataset_id, gallery_directory_id(source_id, "a/b")
        )
        self.assertTrue(created)
        self.assertEqual(root["origin"], "library")
        self.assertEqual(root["relative_path"], "a/b")
        self.assertTrue(root["available"])
        self.assertEqual(
            self.member_paths(dataset_id), ["a/b/1.png", "a/b/2.png", "a/b/sub/3.png"]
        )

    def test_overlapping_roots_do_not_double_count_and_reattach_is_idempotent(self) -> None:
        source_id, _ = self.import_library({"a/1.png": png_bytes(), "a/b/2.png": png_bytes()})
        dataset_id = self.new_dataset()
        self.service.attach_directory(dataset_id, gallery_directory_id(source_id, "a/b"))
        self.service.attach_source(dataset_id, source_id)
        _root, created = self.service.attach_source(dataset_id, source_id)
        self.assertFalse(created)
        self.assertEqual(len(self.service.list_roots(dataset_id)), 2)
        self.assertEqual(self.service.funnel(dataset_id)["member_count"], 2)

    def test_excluded_directories_cannot_be_roots(self) -> None:
        source_id, _ = self.import_library({"a/keep/k.png": png_bytes()})
        dataset_id = self.new_dataset()
        with self.assertRaises(DatasetError) as caught:
            self.service.attach_directory(dataset_id, gallery_directory_id(source_id, "a/keep"))
        self.assertEqual(caught.exception.code, "dataset_root_path_excluded")
        with self.assertRaises(DatasetError) as caught:
            self.service.attach_directory(dataset_id, "no-such-directory")
        self.assertEqual(caught.exception.code, "gallery_directory_not_found")

    def test_detached_root_and_dedup_excluded_assets_leave_the_dataset(self) -> None:
        source_id, _ = self.import_library({"a/1.png": png_bytes(), "b/2.png": png_bytes()})
        dataset_id = self.new_dataset()
        root_a, _ = self.service.attach_directory(dataset_id, gallery_directory_id(source_id, "a"))
        self.service.attach_directory(dataset_id, gallery_directory_id(source_id, "b"))
        self.assertEqual(self.member_paths(dataset_id), ["a/1.png", "b/2.png"])

        with self.db._transaction() as conn:
            conn.execute(
                "UPDATE gallery_assets SET dedup_visibility='excluded' WHERE id=?",
                (gallery_asset_id(source_id, "b/2.png"),),
            )
        self.assertEqual(self.member_paths(dataset_id), ["a/1.png"])

        self.service.detach_root(dataset_id, root_a["root_id"])
        self.assertEqual(self.member_paths(dataset_id), [])
        with self.assertRaises(DatasetError) as caught:
            self.service.detach_root(dataset_id, root_a["root_id"])
        self.assertEqual(caught.exception.code, "dataset_root_not_found")


class FunnelTest(DatasetTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.source_id, self.library = self.import_library(
            {f"set/{index}.png": png_bytes() for index in range(1, 6)}
        )
        self.dataset_id = self.new_dataset()
        self.service.attach_source(self.dataset_id, self.source_id)
        self.ids = {
            index: gallery_asset_id(self.source_id, f"set/{index}.png") for index in range(1, 6)
        }

    def counts(self) -> list[tuple[str, int, int, int, int]]:
        return [
            (item["stage"], item["input"], item["excluded"], item["approved"], item["output"])
            for item in self.service.funnel(self.dataset_id)["stages"]
        ]

    def test_decisions_at_several_stages_flow_downstream(self) -> None:
        decide = self.service.decide
        decide(self.dataset_id, stage="clean", asset_ids=[self.ids[1]], decision="exclude")
        decide(self.dataset_id, stage="dedup", asset_ids=[self.ids[2]], decision="exclude")
        # 已在 clean 段排除的图，后面的决定不再计数。
        decide(self.dataset_id, stage="dedup", asset_ids=[self.ids[1]], decision="exclude")
        decide(self.dataset_id, stage="tag", asset_ids=[self.ids[3]], decision="approve")
        result = decide(
            self.dataset_id, stage="review", asset_ids=[self.ids[4]], decision="exclude",
            reason="手部崩坏",
        )
        self.assertEqual(result["updated"], 1)
        self.assertEqual(
            self.counts(),
            [
                ("collect", 5, 0, 0, 5),
                ("clean", 5, 1, 0, 4),
                ("dedup", 4, 1, 0, 3),
                ("tag", 3, 0, 1, 3),
                ("review", 3, 1, 0, 2),
                ("export", 2, 0, 0, 2),
            ],
        )
        export_ids = {m["asset_id"] for m in self.service.stage_input(self.dataset_id, "export")}
        self.assertEqual(export_ids, {self.ids[3], self.ids[5]})

        summary = self.service.list_summaries()[0]
        self.assertEqual(summary["member_count"], 5)
        self.assertEqual(summary["output_count"], 2)
        self.assertEqual([item["output"] for item in summary["stage_outputs"]], [5, 4, 3, 3, 2, 2])

        cleared = decide(self.dataset_id, stage="clean", asset_ids=[self.ids[1]], decision="clear")
        self.assertEqual(cleared["updated"], 1)
        # 撤销 clean 的排除后，它在 dedup 段的排除重新生效。
        self.assertEqual(self.counts()[1:3], [("clean", 5, 0, 0, 5), ("dedup", 5, 2, 0, 3)])

    def test_member_page_filters_follow_stage_inputs(self) -> None:
        self.service.decide(self.dataset_id, stage="clean", asset_ids=[self.ids[1]], decision="exclude")
        self.service.decide(
            self.dataset_id, stage="dedup", asset_ids=[self.ids[2]], decision="approve", reason="ok"
        )
        page = self.service.members_page(self.dataset_id, stage="dedup")
        self.assertEqual(page["total"], 4)
        self.assertNotIn(self.ids[1], [item["asset_id"] for item in page["items"]])

        approved = self.service.members_page(self.dataset_id, stage="dedup", decision="approved")
        self.assertEqual([item["asset_id"] for item in approved["items"]], [self.ids[2]])
        self.assertEqual(
            approved["items"][0]["decisions"],
            [{"stage": "dedup", "decision": "approve", "reason": "ok"}],
        )
        undecided = self.service.members_page(self.dataset_id, stage="dedup", decision="undecided")
        self.assertEqual(undecided["total"], 3)
        excluded = self.service.members_page(self.dataset_id, stage="clean", decision="excluded")
        self.assertEqual([item["asset_id"] for item in excluded["items"]], [self.ids[1]])

        everything = self.service.members_page(self.dataset_id)
        self.assertEqual(everything["total"], 5)
        self.assertTrue(everything["items"][0]["thumbnail_url"].startswith("/api/v1/gallery/assets/"))

        with self.assertRaises(DatasetError) as caught:
            self.service.members_page(self.dataset_id, decision="excluded")
        self.assertEqual(caught.exception.code, "invalid_dataset_member_filter")

    def test_member_pages_are_cursor_stable(self) -> None:
        first = self.service.members_page(self.dataset_id, limit=2)
        self.assertEqual(len(first["items"]), 2)
        self.assertIsNotNone(first["next_cursor"])
        second = self.service.members_page(self.dataset_id, limit=2, cursor=first["next_cursor"])
        third = self.service.members_page(self.dataset_id, limit=2, cursor=second["next_cursor"])
        self.assertIsNone(third["next_cursor"])
        seen = [item["relative_path"] for page in (first, second, third) for item in page["items"]]
        self.assertEqual(seen, [f"set/{index}.png" for index in range(1, 6)])

        searched = self.service.members_page(self.dataset_id, query="3.PNG")
        self.assertEqual([item["relative_path"] for item in searched["items"]], ["set/3.png"])
        self.assertEqual(self.service.members_page(self.dataset_id, query="%")["total"], 0)

    def test_decisions_only_accept_members(self) -> None:
        with self.assertRaises(DatasetError) as caught:
            self.service.decide(self.dataset_id, stage="clean", asset_ids=["stranger"], decision="exclude")
        self.assertEqual(caught.exception.code, "dataset_asset_not_member")
        self.assertEqual(caught.exception.details, {"asset_ids": ["stranger"]})
        with self.assertRaises(DatasetError) as caught:
            self.service.decide(self.dataset_id, stage="train", asset_ids=[self.ids[1]], decision="exclude")
        self.assertEqual(caught.exception.code, "invalid_dataset_stage")

    def test_trashed_asset_keeps_its_exclusion_visible(self) -> None:
        self.service.decide(self.dataset_id, stage="clean", asset_ids=[self.ids[1]], decision="exclude")
        with self.db._transaction() as conn:
            conn.execute(
                "UPDATE gallery_assets SET lifecycle_state='trashed' WHERE id IN (?, ?)",
                (self.ids[1], self.ids[2]),
            )
        # 1 号在 clean 段被排除后进了回收区：还留在漏斗里算作排除；
        # 2 号没有决定，直接移出数据集。
        self.assertEqual(self.counts()[:2], [("collect", 4, 0, 0, 4), ("clean", 4, 1, 0, 3)])
        clean_input = self.service.stage_input(self.dataset_id, "clean")
        self.assertNotIn(self.ids[1], {member["asset_id"] for member in clean_input})
        self.assertEqual(len(self.service.stage_input(self.dataset_id, "clean", live_only=False)), 4)
        self.assertEqual(self.service.hashing_status(self.dataset_id)["member_count"], 3)

    def test_cover_falls_back_to_first_live_member(self) -> None:
        detail = self.service.detail(self.dataset_id)
        self.assertEqual(detail["cover_asset_id"], self.ids[1])
        self.assertTrue(detail["cover_thumbnail_url"].endswith("/thumbnail?size=256"))
        updated = self.service.update(self.dataset_id, {"cover_asset_id": self.ids[3]})
        self.assertEqual(updated["cover_asset_id"], self.ids[3])
        with self.db._transaction() as conn:
            conn.execute("UPDATE gallery_assets SET lifecycle_state='trashed' WHERE id=?", (self.ids[3],))
        self.assertEqual(self.service.detail(self.dataset_id)["cover_asset_id"], self.ids[1])


class StaleDetectionTest(DatasetTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.source_id, self.library = self.import_library(
            {"set/1.png": png_bytes(), "set/2.png": png_bytes(), "set/3.png": png_bytes()}
        )
        self.dataset_id = self.new_dataset()
        self.service.attach_source(self.dataset_id, self.source_id)
        self.first = gallery_asset_id(self.source_id, "set/1.png")

    def run_stage(self, stage: str, status: str = "succeeded") -> dict:
        run = self.service.start_stage_run(self.dataset_id, stage, ref_id="job-1", stats={"n": 3})
        self.assertEqual(self.stage(self.dataset_id, stage)["status"], "running")
        return self.service.finish_stage_run(run["run_id"], status=status, stats={"done": 3})

    def test_fresh_run_is_not_stale(self) -> None:
        self.assertEqual(self.stage(self.dataset_id, "tag")["status"], "idle")
        run = self.run_stage("tag")
        self.assertEqual(run["status"], "succeeded")
        self.assertIsNotNone(run["finished_at"])
        self.assertEqual(run["stats"], {"done": 3})
        tag = self.stage(self.dataset_id, "tag")
        self.assertEqual(tag["status"], "succeeded")
        self.assertFalse(tag["stale"])
        self.assertEqual(tag["last_run"]["run_id"], run["run_id"])
        self.assertEqual(tag["input_digest"], run["input_digest"])

    def test_upstream_exclusion_makes_downstream_run_stale(self) -> None:
        self.run_stage("tag")
        # 本段自己的决定不改变本段输入。
        self.service.decide(self.dataset_id, stage="tag", asset_ids=[self.first], decision="exclude")
        self.assertFalse(self.stage(self.dataset_id, "tag")["stale"])
        self.service.decide(self.dataset_id, stage="clean", asset_ids=[self.first], decision="exclude")
        self.assertTrue(self.stage(self.dataset_id, "tag")["stale"])
        self.assertTrue(
            {"stage": "tag", "output": 2, "stale": True}
            in self.service.list_summaries()[0]["stage_outputs"]
        )

    def test_changed_file_after_rescan_makes_run_stale(self) -> None:
        self.run_stage("dedup")
        self.bump_mtime(self.library / "set/2.png")
        self.catalog.scan_source(self.source_id)
        self.assertTrue(self.stage(self.dataset_id, "dedup")["stale"])

    def test_caption_change_only_affects_export(self) -> None:
        self.run_stage("tag")
        self.run_stage("export")
        (self.library / "set/1.txt").write_text("1girl, solo", encoding="utf-8")
        self.catalog.scan_source(self.source_id)
        self.assertFalse(self.stage(self.dataset_id, "tag")["stale"])
        self.assertTrue(self.stage(self.dataset_id, "export")["stale"])

    def test_new_root_makes_run_stale_and_failed_runs_never_are(self) -> None:
        self.run_stage("clean", status="failed")
        self.run_stage("collect")
        _, other = self.import_library({"x/9.png": png_bytes()}, name="other")
        self.service.attach_path(self.dataset_id, str(other))
        self.assertTrue(self.stage(self.dataset_id, "collect")["stale"])
        clean = self.stage(self.dataset_id, "clean")
        self.assertEqual(clean["status"], "failed")
        self.assertFalse(clean["stale"])

    def test_finish_requires_terminal_status_and_lists_runs(self) -> None:
        run = self.service.start_stage_run(self.dataset_id, "clean")
        with self.assertRaises(ValueError):
            self.service.finish_stage_run(run["run_id"], status="running")
        self.service.finish_stage_run(run["run_id"], status="cancelled")
        self.run_stage("tag")
        runs = self.service.list_stage_runs(self.dataset_id)
        self.assertEqual({item["stage"] for item in runs}, {"clean", "tag"})
        self.assertEqual(
            [item["stage"] for item in self.service.list_stage_runs(self.dataset_id, stage="clean")],
            ["clean"],
        )

    def test_input_digest_is_order_independent_and_stage_scoped(self) -> None:
        members = [
            {"asset_id": "a", "size_bytes": 1, "modified_ns": 2,
             "txt_state": "missing", "txt_size_bytes": 0, "txt_modified_ns": 0},
            {"asset_id": "b", "size_bytes": 3, "modified_ns": 4,
             "txt_state": "missing", "txt_size_bytes": 0, "txt_modified_ns": 0},
        ]
        self.assertEqual(input_digest("tag", members), input_digest("tag", members[::-1]))
        self.assertNotEqual(input_digest("tag", members), input_digest("review", members))
        captioned = [dict(members[0], txt_state="normal", txt_size_bytes=5, txt_modified_ns=9), members[1]]
        self.assertEqual(input_digest("tag", members), input_digest("tag", captioned))
        self.assertNotEqual(input_digest("export", members), input_digest("export", captioned))


class AttachPathTest(DatasetTestBase):
    def test_import_new_folder_scans_and_attaches(self) -> None:
        folder = self.write_files(self.root / "new", {"1.png": png_bytes(), "s/2.png": png_bytes()})
        dataset_id = self.new_dataset()
        root, created = self.service.attach_path(dataset_id, str(folder), display_name="新文件夹")
        self.assertTrue(created)
        self.assertEqual((root["origin"], root["relative_path"]), ("import", ""))
        self.assertEqual(root["source_display_name"], "新文件夹")
        self.wait_scan(root["source_id"])
        self.assertEqual(self.member_paths(dataset_id), ["1.png", "s/2.png"])
        self.assertTrue(self.service.list_roots(dataset_id)[0]["available"])

    def test_existing_source_and_descendant_paths_are_reused(self) -> None:
        source_id, library = self.import_library({"a/1.png": png_bytes(), "b/2.png": png_bytes()})
        dataset_id = self.new_dataset()
        same, _ = self.service.attach_path(dataset_id, str(library))
        self.assertEqual((same["source_id"], same["relative_path"]), (source_id, ""))
        child, _ = self.service.attach_path(dataset_id, str(library / "b"))
        self.assertEqual((child["source_id"], child["relative_path"]), (source_id, "b"))
        self.assertEqual(len(self.db.gallery.list_sources()), 1)

    def test_ancestor_relative_and_missing_paths_are_rejected(self) -> None:
        self.import_library({"1.png": png_bytes()}, name="outer/inner")
        dataset_id = self.new_dataset()
        cases = [
            (str(self.root / "outer"), "source_path_conflict", 409),
            ("relative/dir", "dataset_root_path_invalid", 422),
            (str(self.root / "missing"), "source_path_not_found", 404),
        ]
        for path, code, status in cases:
            with self.subTest(path=path):
                with self.assertRaises(DatasetError) as caught:
                    self.service.attach_path(dataset_id, path)
                self.assertEqual((caught.exception.code, caught.exception.status), (code, status))
        self.assertEqual(self.service.list_roots(dataset_id), [])

    def test_attach_queues_member_hashing(self) -> None:
        source_id, _ = self.import_library({"1.png": png_bytes(), "2.png": png_bytes("#ff0000")})
        dataset_id = self.new_dataset()
        self.service.attach_source(dataset_id, source_id)
        self.assertTrue(self.service.hashing.wait_idle(10))
        status = self.service.hashing_status(dataset_id)
        self.assertEqual((status["member_count"], status["hashed_count"]), (2, 2))
        self.assertEqual(status["pending"], 0)


class CrawlAttachTest(DatasetTestBase):
    def create_batch(self, batch_id: str, output_dir: Path) -> None:
        self.db.create_crawl_batch(
            {"id": batch_id, "output_dir": str(output_dir), "concurrency": 1, "max_tasks": 10},
            [
                {
                    "id": f"{batch_id}-address",
                    "site": "danbooru",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=fixture",
                    "proxy_mode": "direct",
                    "max_attempts": 1,
                }
            ],
        )

    def complete_addresses(self, batch_id: str) -> None:
        with self.db._transaction() as conn:
            conn.execute(
                "UPDATE crawl_addresses SET status='succeeded' WHERE batch_id=?", (batch_id,)
            )

    def crawl(self, dataset_id: str, batch_id: str) -> dict:
        return next(c for c in self.service.list_crawls(dataset_id) if c["batch_id"] == batch_id)

    def test_finished_batch_is_attached_as_crawl_root(self) -> None:
        output = self.write_files(self.root / "out/batch-1", {"danbooru/1.png": png_bytes()})
        self.create_batch("batch-1", output)
        dataset_id = self.new_dataset()
        crawl = self.service.register_crawl(dataset_id, "batch-1")
        self.assertEqual((crawl["state"], crawl["batch_status"]), ("pending", "queued"))

        self.complete_addresses("batch-1")
        self.assertTrue(self.db.finish_crawl_batch_if_ready("batch-1"))

        crawl = self.crawl(dataset_id, "batch-1")
        self.assertEqual(crawl["state"], "attached")
        self.assertEqual(crawl["batch_status"], "succeeded")
        roots = self.service.list_roots(dataset_id)
        self.assertEqual([(r["root_id"], r["origin"]) for r in roots], [(crawl["root_id"], "crawl")])
        source = self.db.gallery.get_source_by_batch_id("batch-1")
        self.assertEqual(roots[0]["source_id"], source["source_id"])
        self.wait_scan(source["source_id"])
        self.assertEqual(self.member_paths(dataset_id), ["danbooru/1.png"])

    def test_pending_crawl_is_attached_by_startup_reconcile(self) -> None:
        output = self.write_files(self.root / "out/batch-2", {"1.png": png_bytes()})
        self.create_batch("batch-2", output)
        dataset_id = self.new_dataset()
        self.service.register_crawl(dataset_id, "batch-2")
        # 模拟进程在批次收尾钩子前退出：批次已终态，但没人注册来源、挂根。
        with self.db._transaction() as conn:
            conn.execute("UPDATE crawl_batches SET status='completed_with_errors' WHERE id='batch-2'")
        self.assertEqual(self.crawl(dataset_id, "batch-2")["state"], "pending")

        # 启动顺序与 ServiceContainer.start 一致：先补图库来源，再做数据集对账。
        self.assertEqual(self.container.reconcile_gallery_batch_sources(), 1)
        self.assertEqual(self.service.reconcile()["attached_crawls"], 1)
        crawl = self.crawl(dataset_id, "batch-2")
        self.assertEqual(crawl["state"], "attached")
        root = self.service.list_roots(dataset_id)[0]
        self.assertEqual((root["root_id"], root["origin"]), (crawl["root_id"], "crawl"))
        self.assertEqual(self.service.reconcile()["attached_crawls"], 0)

    def test_registering_an_already_finished_batch_attaches_immediately(self) -> None:
        output = self.write_files(self.root / "out/batch-3", {"1.png": png_bytes()})
        self.create_batch("batch-3", output)
        self.complete_addresses("batch-3")
        self.db.finish_crawl_batch_if_ready("batch-3")
        dataset_id = self.new_dataset()
        self.assertEqual(self.service.register_crawl(dataset_id, "batch-3")["state"], "attached")
        # 幂等：再登记一次不会多挂一个根。
        self.service.register_crawl(dataset_id, "batch-3")
        self.assertEqual(len(self.service.list_roots(dataset_id)), 1)

    def test_batch_inside_an_imported_source_attaches_a_subdirectory(self) -> None:
        source_id, library = self.import_library({"old/0.png": png_bytes()})
        output = self.write_files(library / "crawl-4", {"1.png": png_bytes()})
        self.create_batch("batch-4", output)
        dataset_id = self.new_dataset()
        self.service.register_crawl(dataset_id, "batch-4")
        self.complete_addresses("batch-4")
        self.db.finish_crawl_batch_if_ready("batch-4")

        self.assertIsNone(self.db.gallery.get_source_by_batch_id("batch-4"))
        self.assertEqual(self.crawl(dataset_id, "batch-4")["state"], "attached")
        root = self.service.list_roots(dataset_id)[0]
        self.assertEqual((root["source_id"], root["relative_path"]), (source_id, "crawl-4"))
        self.wait_scan(source_id)
        self.assertEqual(self.member_paths(dataset_id), ["crawl-4/1.png"])

    def test_missing_output_or_conflicting_batch_is_marked_failed(self) -> None:
        self.create_batch("batch-5", self.root / "out/never-created")
        dataset_id = self.new_dataset()
        self.service.register_crawl(dataset_id, "batch-5")
        self.complete_addresses("batch-5")
        self.db.finish_crawl_batch_if_ready("batch-5")
        crawl = self.crawl(dataset_id, "batch-5")
        self.assertEqual((crawl["state"], crawl["error_code"]), ("failed", "crawl_output_missing"))

        # 批次目录包含一个已导入的来源：图库拒绝注册，数据集记为失败。
        outer = self.root / "out/batch-6"
        self.write_files(outer / "inner", {"1.png": png_bytes()})
        self.catalog.import_source(str(outer / "inner"))
        self.create_batch("batch-6", outer)
        self.service.register_crawl(dataset_id, "batch-6")
        self.complete_addresses("batch-6")
        self.db.finish_crawl_batch_if_ready("batch-6")
        crawl = self.crawl(dataset_id, "batch-6")
        self.assertEqual((crawl["state"], crawl["error_code"]), ("failed", "crawl_source_conflict"))
        self.assertEqual(self.service.list_roots(dataset_id), [])


if __name__ == "__main__":
    unittest.main()
