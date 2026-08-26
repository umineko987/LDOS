"""GalleryCatalogService 扫描与来源生命周期合同测试（G1-2）。"""

from __future__ import annotations

import io
import os
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image

from gdl_backend._database_gallery_repository import (
    GalleryRepository,
    GallerySourceConflictError,
)
from gdl_backend.database import Database
from gdl_backend.gallery_service import (
    GalleryCatalogService,
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

    def test_scan_marks_offline_without_wiping_index(self) -> None:
        source = self.make_source({"a.jpg": _png_bytes(), "a.txt": "t"})
        self.service.scan_source(source["source_id"])
        moved = self.root / "moved"
        moved.mkdir()
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
