"""GalleryCatalogService 扫描与来源生命周期合同测试（G1-2）。"""

from __future__ import annotations

import io
import os
import threading
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path

from PIL import Image

from gdl_backend._database_gallery_repository import (
    GalleryRepository,
    GallerySourceConflictError,
)
from gdl_backend.database import Database
from gdl_backend.gallery_service import (
    GalleryCatalogService,
    GalleryFilesystemLocks,
    GalleryRootMissing,
    GalleryScanInProgress,
    GallerySourceNotFound,
)


def _png_bytes(width: int = 4, height: int = 3, color: str = "#336699") -> bytes:
    image = Image.new("RGB", (width, height), color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class GalleryServiceTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = Database(self.root / "db.sqlite3")
        self.addCleanup(self.db.close)
        self.repo: GalleryRepository = self.db.gallery
        self.service = GalleryCatalogService(self.repo)
        # LIFO：先等扫描线程结束，再关闭数据库，避免线程写已关闭的库。
        self.addCleanup(self.service.stop)

    def make_source(
        self, files: dict[str, bytes | str | None] | None = None, name: str = "图库A"
    ) -> dict:
        source_root = self.root / "src-a"
        source_root.mkdir(exist_ok=True)
        for relative, content in (files or {}).items():
            target = source_root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if content is None:
                target.touch()
            elif isinstance(content, bytes):
                target.write_bytes(content)
            else:
                target.write_text(content, encoding="utf-8")
        return self.service.import_source(str(source_root), display_name=name)


class GallerySourceLifecycleTest(GalleryServiceTestBase):
    def test_import_rejects_missing_or_symlink_root(self) -> None:
        with self.assertRaises(GalleryRootMissing):
            self.service.import_source(str(self.root / "missing"))
        link = self.root / "link-src"
        real = self.root / "real-src"
        real.mkdir()
        link.symlink_to(real)
        with self.assertRaises(GalleryRootMissing):
            self.service.import_source(str(link))

    def test_public_projection_strips_root_paths(self) -> None:
        source = self.make_source()
        self.assertNotIn("root_path", source)
        self.assertNotIn("canonical_root_key", source)
        listed = self.service.list_sources()
        self.assertEqual(len(listed), 1)
        self.assertNotIn("root_path", listed[0])
        fetched = self.service.get_source(source["source_id"])
        self.assertEqual(fetched["source_id"], source["source_id"])

    def test_conflicting_imports_rejected_with_stable_conflict(self) -> None:
        self.make_source()
        source_root = self.root / "src-a"
        (source_root / "nested").mkdir()
        with self.assertRaises(GallerySourceConflictError):
            self.service.import_source(str(source_root / "nested"), display_name="子")
        try:
            self.service.import_source(str(self.root), display_name="父")
            self.fail("ancestor conflict expected")
        except GallerySourceConflictError as conflict:
            self.assertEqual(conflict.relation, "ancestor")

    def test_update_unregister_and_relink(self) -> None:
        source = self.make_source()
        renamed = self.service.update_source(
            source["source_id"], display_name="改名后的图库"
        )
        self.assertEqual(renamed["display_name"], "改名后的图库")
        with self.assertRaises(ValueError):
            self.service.update_source(source["source_id"], display_name="   ")
        new_root = self.root / "src-b"
        new_root.mkdir()
        relinked = self.service.relink_source(source["source_id"], str(new_root))
        self.assertEqual(relinked["availability"], "available")
        with self.assertRaises(GalleryRootMissing):
            self.service.relink_source(source["source_id"], str(self.root / "gone"))
        self.service.unregister_source(source["source_id"])
        with self.assertRaises(GallerySourceNotFound):
            self.service.get_source(source["source_id"])


class GalleryScanTest(GalleryServiceTestBase):
    def test_scan_indexes_supported_files_with_txt_states(self) -> None:
        source = self.make_source(
            {
                "1.jpg": _png_bytes(4, 3),
                "1.txt": "tag_a, tag_b",
                "2.png": _png_bytes(6, 2),
                "2.txt": "   \n\t",
                "3.webp": _png_bytes(2, 2),
                "3.txt": "标签",
                "4.jpeg": _png_bytes(2, 2),  # 无 txt → missing
                "5.gif": _png_bytes(2, 2),  # 不支持扩展
                "6.txt": "孤儿 txt 不是资产",
                "data.bin": b"\x00\x01",
                "download.part": b"partial",
                "sub/7.jpg": _png_bytes(8, 8),
                "sub/7.txt": "sub tag",
                ".imageweave/trash/op-1/x.jpg": _png_bytes(1, 1),
                ".imageweave-copy-op/partial.jpg": _png_bytes(1, 1),
                ".imageweave-copy-op/partial.txt": "must stay hidden",
            }
        )
        stats = self.service.scan_source(source["source_id"])
        self.assertEqual(stats["asset_count"], 5)
        self.assertEqual(stats["directory_count"], 2)
        self.assertFalse(stats["offline"])

        detail = self.service.get_source(source["source_id"])
        self.assertEqual(detail["asset_count"], 5)
        self.assertEqual(detail["indexed_version"], 1)

        root = self.repo.get_root_directory(source["source_id"])
        assert root is not None
        entries = self.repo.list_directory_entries(directory_id=root["directory_id"])
        by_name = {asset["name"]: asset for asset in entries["assets"]}
        self.assertEqual(by_name["1.jpg"]["txt_state"], "normal")
        self.assertEqual(by_name["2.png"]["txt_state"], "blank")
        self.assertEqual(by_name["3.webp"]["txt_state"], "normal")
        self.assertEqual(by_name["4.jpeg"]["txt_state"], "missing")
        self.assertEqual(by_name["1.jpg"]["width"], 4)
        self.assertEqual(by_name["1.jpg"]["height"], 3)
        self.assertEqual(by_name["1.jpg"]["format"], "PNG")
        self.assertEqual(by_name["1.jpg"]["read_state"], "ok")
        self.assertNotIn("6.jpg", by_name)
        self.assertEqual(len(entries["directories"]), 1)
        sub = entries["directories"][0]
        self.assertEqual(sub["name"], "sub")

    def test_scan_skips_symlinks_and_reserved_dirs(self) -> None:
        source_root = self.root / "src-a"
        source_root.mkdir()
        (source_root / "real.jpg").write_bytes(_png_bytes())
        (source_root / "linked.jpg").symlink_to(source_root / "real.jpg")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "outer.jpg").write_bytes(_png_bytes())
        (source_root / "linked-dir").symlink_to(outside)
        source = self.service.import_source(str(source_root))
        stats = self.service.scan_source(source["source_id"])
        self.assertEqual(stats["asset_count"], 1)
        root = self.repo.get_root_directory(source["source_id"])
        assert root is not None
        entries = self.repo.list_directory_entries(directory_id=root["directory_id"])
        self.assertEqual([a["name"] for a in entries["assets"]], ["real.jpg"])
        self.assertEqual(entries["directories"], [])

    def test_pair_conflict_and_invalid_encoding(self) -> None:
        source = self.make_source(
            {
                "a.jpg": _png_bytes(),
                "a.png": _png_bytes(),
                "a.txt": "shared",
                "b.jpg": _png_bytes(),
                "b.txt": b"\xd6\xd0\xce\xc4",  # GBK 字节，非 UTF-8
            }
        )
        self.service.scan_source(source["source_id"])
        root = self.repo.get_root_directory(source["source_id"])
        assert root is not None
        entries = self.repo.list_directory_entries(directory_id=root["directory_id"])
        states = {asset["name"]: asset["txt_state"] for asset in entries["assets"]}
        self.assertEqual(states["a.jpg"], "pair_conflict")
        self.assertEqual(states["a.png"], "pair_conflict")
        self.assertEqual(states["b.jpg"], "invalid_encoding")

    def test_incremental_rescan_reuses_and_reacts(self) -> None:
        source = self.make_source({"a.jpg": _png_bytes(), "a.txt": "v1"})
        first = self.service.scan_source(source["source_id"])
        self.assertTrue(first["content_changed"])

        # 完全不变的重扫描：只有 indexed_version 前进。
        second = self.service.scan_source(source["source_id"])
        self.assertFalse(second["content_changed"])
        self.assertFalse(second["annotation_changed"])
        self.assertEqual(second["indexed_version"], first["indexed_version"] + 1)

        # TXT 变化：annotation_version 前进，content 不动。
        (self.root / "src-a" / "a.txt").write_text("v2", encoding="utf-8")
        third = self.service.scan_source(source["source_id"])
        self.assertTrue(third["annotation_changed"])
        self.assertFalse(third["content_changed"])

        # 图片字节变化：content_version 前进。
        (self.root / "src-a" / "a.jpg").write_bytes(_png_bytes(9, 9))
        time.sleep(0.01)
        fourth = self.service.scan_source(source["source_id"])
        self.assertTrue(fourth["content_changed"])

        # 新增文件。
        (self.root / "src-a" / "c.jpg").write_bytes(_png_bytes())
        fifth = self.service.scan_source(source["source_id"])
        self.assertEqual(fifth["asset_count"], 2)
        self.assertTrue(fifth["content_changed"])

    def test_scan_waits_for_source_filesystem_lock(self) -> None:
        """扫描必须与持有 source:{id} 文件系统锁的文件操作互斥。"""
        locks = GalleryFilesystemLocks()
        service = GalleryCatalogService(self.repo, filesystem_locks=locks)
        self.addCleanup(service.stop)
        source = self.make_source({"a.jpg": _png_bytes()})

        with locks.hold(f"source:{source['source_id']}"):
            finished = threading.Event()

            def run_scan() -> None:
                service.scan_source(source["source_id"])
                finished.set()

            thread = threading.Thread(target=run_scan, daemon=True)
            thread.start()
            self.assertFalse(finished.wait(0.3), "scan must block on source lock")

        self.assertTrue(finished.wait(5.0), "scan must finish after lock release")
        refreshed = service.get_source(source["source_id"])
        self.assertEqual(refreshed["asset_count"], 1)

    def test_scan_marks_offline_without_wiping_index(self) -> None:
        source = self.make_source({"a.jpg": _png_bytes(), "a.txt": "t"})
        self.service.scan_source(source["source_id"])
        moved = self.root / "moved"
        # POSIX 允许 rename 覆盖已存在的空目录，Windows 拒绝：目标名直接选不存在的。
        os.rename(self.root / "src-a", moved)
        stats = self.service.scan_source(source["source_id"])
        self.assertTrue(stats["offline"])
        detail = self.service.get_source(source["source_id"])
        self.assertEqual(detail["availability"], "offline")
        self.assertEqual(detail["asset_count"], 1)  # 索引保留
        # 目录仍可读。
        root = self.repo.get_root_directory(source["source_id"])
        assert root is not None
        os.rename(moved, self.root / "src-a")
        revived = self.service.scan_source(source["source_id"])
        self.assertFalse(revived["offline"])
        self.assertEqual(revived["asset_count"], 1)

    def test_async_scan_job_lifecycle(self) -> None:
        source = self.make_source({"a.jpg": _png_bytes()})
        record = self.service.start_scan(source["source_id"])
        self.assertEqual(record["state"], "running")
        with self.assertRaises(GalleryScanInProgress):
            self.service.start_scan(source["source_id"])
        for _ in range(200):
            state = self.service.get_scan(source["source_id"])
            if state["state"] != "running":
                break
            time.sleep(0.02)
        self.assertEqual(state["state"], "succeeded")
        self.assertIsNotNone(state["finished_at"])
        self.assertEqual(state["stats"]["asset_count"], 1)

    def test_async_scan_missing_source(self) -> None:
        with self.assertRaises(GallerySourceNotFound):
            self.service.start_scan("missing-source")


class GalleryBatchAutoRegisterTest(GalleryServiceTestBase):
    def _batch_root(self) -> Path:
        root = self.root / "batch-out"
        root.mkdir(exist_ok=True)
        (root / "img.jpg").write_bytes(_png_bytes())
        (root / "img.txt").write_text("标签", encoding="utf-8")
        return root

    def _create_batch(self, batch_id: str, root: Path) -> None:
        # gallery_sources.batch_id 有 FK + UNIQUE，批次行必须真实存在。
        self.db.create_crawl_batch(
            {
                "id": batch_id,
                "output_dir": str(root),
                "concurrency": 1,
                "max_tasks": 1,
            },
            [
                {
                    "id": f"{batch_id}-addr",
                    "site": "example.com",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://example.com/gallery",
                    "proxy_mode": "direct",
                    "max_attempts": 1,
                    "priority": 3,
                }
            ],
        )

    def test_auto_register_dedup_and_idempotent(self) -> None:
        root = self._batch_root()
        self._create_batch("batch-1", root)
        source = self.service.auto_register_batch_source(
            batch_id="batch-1",
            root_path=str(root),
            display_name="Danbooru 批次 2026-08-27",
            dedup_required=True,
        )
        assert source is not None
        self.assertEqual(source["kind"], "crawl_batch")
        self.assertEqual(source["dedup_required"], True)
        detail = self.repo.get_source(source["source_id"])
        self.assertEqual(detail["dedup_state"], "pending_analysis")
        for _ in range(200):
            record = self.service.get_scan(source["source_id"])
            if record["state"] != "running":
                break
            time.sleep(0.02)
        self.assertEqual(record["state"], "succeeded")
        # 同批次幂等：再次调用不新建来源。
        again = self.service.auto_register_batch_source(
            batch_id="batch-1",
            root_path=str(root),
            display_name="重复",
            dedup_required=True,
        )
        self.assertIsNone(again)
        self.assertEqual(len(self.service.list_sources()), 1)

    def test_auto_register_skips_missing_root_and_conflicts(self) -> None:
        self._create_batch("batch-2", self.root / "gone")
        skipped = self.service.auto_register_batch_source(
            batch_id="batch-2",
            root_path=str(self.root / "gone"),
            display_name="缺失",
            dedup_required=False,
        )
        self.assertIsNone(skipped)

        root = self._batch_root()
        self._create_batch("batch-3", root)
        # 先作为导入来源占用，再尝试同根批次 → 冲突静默跳过。
        self.service.import_source(str(root), display_name="已有导入")
        conflicted = self.service.auto_register_batch_source(
            batch_id="batch-3",
            root_path=str(root),
            display_name="冲突批次",
            dedup_required=False,
        )
        self.assertIsNone(conflicted)
        self.assertEqual(len(self.service.list_sources()), 1)

    def test_auto_register_starts_scan(self) -> None:
        root = self._batch_root()
        self._create_batch("batch-4", root)
        source = self.service.auto_register_batch_source(
            batch_id="batch-4",
            root_path=str(root),
            display_name="批次",
            dedup_required=False,
        )
        assert source is not None
        for _ in range(200):
            record = self.service.get_scan(source["source_id"])
            if record["state"] != "running":
                break
            time.sleep(0.02)
        self.assertEqual(record["state"], "succeeded")
        self.assertEqual(record["stats"]["asset_count"], 1)


class GalleryBatchReconcileTest(unittest.TestCase):
    """容器层集成：批次终态钩子与启动对账。"""

    def setUp(self) -> None:
        from gdl_backend.app import ServiceContainer
        from tests.helpers import make_settings

        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.settings = make_settings(self.root)
        self.container = ServiceContainer(self.settings)
        self.addCleanup(self.container.db.close)
        # LIFO：先 join 扫描线程再关库。
        self.addCleanup(self.container.gallery_catalog.stop)

    def _create_terminal_batch(self, batch_id: str, output_dir: Path) -> None:
        self.container.db.create_crawl_batch(
            {
                "id": batch_id,
                "output_dir": str(output_dir),
                "concurrency": 1,
                "max_tasks": 1,
            },
            [
                {
                    "id": f"{batch_id}-addr",
                    "site": "example.com",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://example.com/gallery",
                    "proxy_mode": "direct",
                    "max_attempts": 1,
                    "priority": 3,
                }
            ],
        )

    def test_finish_hook_registers_source(self) -> None:
        output_dir = self.root / "batch-a"
        output_dir.mkdir()
        (output_dir / "pic.jpg").write_bytes(_png_bytes())
        self._create_terminal_batch("batch-a", output_dir)

        # planning 失败使地址终态，批次随之终态（钩子触发自动注册）。
        self.container.db.begin_crawl_address_planning("batch-a-addr")
        self.container.db.fail_crawl_address("batch-a-addr", "planning blew up")
        finished = self.container.db.finish_crawl_batch_if_ready("batch-a")
        self.assertTrue(finished)
        sources = self.container.gallery_catalog.list_sources()
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]["kind"], "crawl_batch")
        self.assertIn("example.com", sources[0]["display_name"])
        self.assertEqual(sources[0]["dedup_required"], False)

        # 幂等：再次终态化不重复注册。
        self.container.db.finish_crawl_batch_if_ready("batch-a")
        self.assertEqual(len(self.container.gallery_catalog.list_sources()), 1)

    def test_reconcile_registers_pending_terminal_batches(self) -> None:
        output_dir = self.root / "batch-b"
        output_dir.mkdir()
        (output_dir / "pic.jpg").write_bytes(_png_bytes())
        self._create_terminal_batch("batch-b", output_dir)
        # 模拟批次在应用关闭期间终态（无钩子触发）。
        self.container.db.begin_crawl_address_planning("batch-b-addr")
        self.container.db.fail_crawl_address("batch-b-addr", "planning blew up")
        self.container.db._crawl_repository.finish_crawl_batch_if_ready("batch-b")

        registered = self.container.reconcile_gallery_batch_sources()
        self.assertEqual(registered, 1)
        again = self.container.reconcile_gallery_batch_sources()
        self.assertEqual(again, 0)

    def test_reconcile_recovers_applied_review_without_a_handoff_event(self) -> None:
        output_dir = self.root / "batch-c"
        output_dir.mkdir()
        (output_dir / "keep.jpg").write_bytes(_png_bytes())
        (output_dir / "reject.jpg").write_bytes(_png_bytes())
        self._create_terminal_batch("batch-c", output_dir)
        source = self.container.gallery_catalog.register_batch_source(
            batch_id="batch-c",
            root_path=str(output_dir),
            display_name="批次 C",
            dedup_required=True,
        )
        self.container.gallery_catalog.scan_source(source["source_id"])
        rejected_root = output_dir / "duplicates"
        rejected_root.mkdir()
        (output_dir / "reject.jpg").rename(rejected_root / "reject.jpg")

        images = [
            {"relative_path": "keep.jpg", "final_relative_path": "keep.jpg", "disposition": "kept"},
            {
                "relative_path": "reject.jpg",
                "final_relative_path": "duplicates/reject.jpg",
                "disposition": "rejected",
            },
        ]
        with (
            mock.patch.object(
                self.container.db, "get_crawl_review", return_value={"status": "applied"}
            ),
            mock.patch.object(
                self.container.db, "crawl_review_apply_images", return_value=images
            ),
        ):
            self.assertEqual(self.container.reconcile_applied_gallery_reviews(), 1)

        event = self.container.db.gallery.get_review_reconciliation(source["source_id"])
        assert event is not None
        self.assertEqual(event["state"], "applied")
        self.assertEqual(self.container.reconcile_applied_gallery_reviews(), 0)


class GallerySearchIntegrationTest(GalleryServiceTestBase):
    def test_search_over_scanned_txt(self) -> None:
        source = self.make_source(
            {
                "1.jpg": _png_bytes(),
                "1.txt": "hatsune miku",
                "sub/2.jpg": _png_bytes(),
                "sub/2.txt": "kagamine rin",
            }
        )
        self.service.scan_source(source["source_id"])
        result = self.repo.search_assets(scope="gallery", query="miku")
        self.assertEqual(len(result["assets"]), 1)
        self.assertEqual(result["assets"][0]["relative_path"], "1.jpg")
        result = self.repo.search_assets(scope="gallery", query="rin miku")
        self.assertEqual(result["assets"], [])


if __name__ == "__main__":
    unittest.main()
