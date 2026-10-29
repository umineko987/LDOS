"""图库注解的批量读取和删除（数据集 caption 管线的底层）。"""

from __future__ import annotations

import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from gdl_backend._database_gallery_repository import GalleryVersionConflict, gallery_asset_id
from gdl_backend.database import Database
from gdl_backend.gallery_safe_paths import MISSING_DISK_VERSION
from gdl_backend.gallery_service import GalleryCatalogService


def png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (2, 2), "#123456").save(buffer, format="PNG")
    return buffer.getvalue()


class AnnotationBulkTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.library = self.root / "lib"
        (self.library / "sub").mkdir(parents=True)
        for name in ("a.png", "b.png", "sub/c.png"):
            (self.library / name).write_bytes(png_bytes())
        (self.library / "a.txt").write_text("1girl, solo", encoding="utf-8")
        (self.library / "sub/c.txt").write_bytes(b"\xff\xfe broken")
        self.db = Database(self.root / "db.sqlite3")
        self.addCleanup(self.db.close)
        self.catalog = GalleryCatalogService(self.db.gallery)
        self.source_id = str(self.catalog.import_source(str(self.library))["source_id"])
        self.catalog.scan_source(self.source_id)
        self.ids = {name: gallery_asset_id(self.source_id, name) for name in ("a.png", "b.png", "sub/c.png")}

    def test_read_annotations_matches_single_reads(self) -> None:
        ids = [self.ids["sub/c.png"], "missing-asset", self.ids["a.png"], self.ids["b.png"]]
        bulk = self.catalog.read_annotations(ids)
        self.assertEqual(list(bulk), ids)
        for asset_id in (self.ids["a.png"], self.ids["b.png"], self.ids["sub/c.png"]):
            self.assertEqual(bulk[asset_id], self.catalog.get_annotation(asset_id))
        self.assertEqual(bulk[self.ids["a.png"]]["content"], "1girl, solo")
        self.assertEqual(bulk[self.ids["b.png"]]["txt_state"], "missing")
        self.assertEqual(bulk[self.ids["b.png"]]["disk_version"], MISSING_DISK_VERSION)
        self.assertEqual(bulk[self.ids["sub/c.png"]]["txt_state"], "invalid_encoding")
        self.assertEqual(bulk["missing-asset"]["error"], "asset_not_found")

    def test_offline_source_reports_error_per_asset(self) -> None:
        with self.db._transaction() as conn:
            conn.execute("UPDATE gallery_sources SET availability='offline' WHERE id=?", (self.source_id,))
        bulk = self.catalog.read_annotations([self.ids["a.png"]])
        self.assertEqual(bulk[self.ids["a.png"]]["error"], "source_offline")
        self.assertIsNone(bulk[self.ids["a.png"]]["content"])

    def test_unsafe_txt_is_isolated_to_its_asset(self) -> None:
        (self.library / "b.txt").symlink_to(self.library / "a.txt")
        bulk = self.catalog.read_annotations([self.ids["b.png"], self.ids["a.png"]])
        self.assertEqual(bulk[self.ids["b.png"]]["error"], "unsafe_source_path")
        self.assertEqual(bulk[self.ids["a.png"]]["content"], "1girl, solo")

    def test_remove_annotation_deletes_file_and_index_state(self) -> None:
        current = self.catalog.get_annotation(self.ids["a.png"])
        removed = self.catalog.remove_annotation(
            self.ids["a.png"],
            expected_txt_version=current["txt_version"],
            expected_disk_version=current["disk_version"],
        )
        self.assertFalse((self.library / "a.txt").exists())
        self.assertEqual(removed["disk_version"], MISSING_DISK_VERSION)
        self.assertIsNone(removed["content"])
        self.assertEqual(removed["txt_version"], current["txt_version"] + 1)
        asset = self.db.gallery.get_asset(self.ids["a.png"])
        self.assertEqual((asset["txt_state"], asset["txt_size_bytes"]), ("missing", 0))
        hits = self.db._conn.execute(
            "SELECT txt_content FROM gallery_search_index WHERE asset_id=?", (self.ids["a.png"],)
        ).fetchall()
        self.assertEqual([row[0] for row in hits], [""])

    def test_remove_rejects_stale_disk_version(self) -> None:
        current = self.catalog.get_annotation(self.ids["a.png"])
        (self.library / "a.txt").write_text("edited elsewhere", encoding="utf-8")
        with self.assertRaises(GalleryVersionConflict) as caught:
            self.catalog.remove_annotation(
                self.ids["a.png"],
                expected_txt_version=current["txt_version"],
                expected_disk_version=current["disk_version"],
            )
        self.assertEqual(caught.exception.code, "txt_disk_conflict")
        self.assertEqual((self.library / "a.txt").read_text(encoding="utf-8"), "edited elsewhere")

    def test_remove_restores_file_when_index_update_fails(self) -> None:
        current = self.catalog.get_annotation(self.ids["a.png"])
        with patch.object(self.db.gallery, "update_annotation", side_effect=RuntimeError("db gone")):
            with self.assertRaises(RuntimeError):
                self.catalog.remove_annotation(
                    self.ids["a.png"],
                    expected_txt_version=current["txt_version"],
                    expected_disk_version=current["disk_version"],
                )
        self.assertEqual((self.library / "a.txt").read_text(encoding="utf-8"), "1girl, solo")

    def test_failed_replace_leaves_original_and_no_temp_files(self) -> None:
        current = self.catalog.get_annotation(self.ids["a.png"])
        real_replace = os.replace

        def failing_replace(source, target, *args, **kwargs):
            if str(target).endswith("a.txt"):
                raise OSError("disk full")
            return real_replace(source, target, *args, **kwargs)

        with patch("gdl_backend.gallery_safe_paths.os.replace", side_effect=failing_replace):
            with self.assertRaises(Exception):
                self.catalog.save_annotation(
                    self.ids["a.png"], "overwritten",
                    expected_txt_version=current["txt_version"],
                    expected_disk_version=current["disk_version"],
                )
        self.assertEqual((self.library / "a.txt").read_text(encoding="utf-8"), "1girl, solo")
        self.assertEqual(sorted(path.name for path in self.library.iterdir() if path.name.startswith(".")), [])
        self.assertEqual(self.catalog.get_annotation(self.ids["a.png"]), current)


if __name__ == "__main__":
    unittest.main()
