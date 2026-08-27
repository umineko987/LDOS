"""R0 red-first regressions for Gallery data-safety and index corrections.

These tests describe the corrected contracts before the implementation lands.  They
must fail against the G6 baseline for the focused reason, while unrelated suites
remain green.
"""

from __future__ import annotations

import io
import os
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from gdl_backend.app import ServiceContainer
from gdl_backend.gallery_file_operations import GalleryFileOperationError
from tests.helpers import make_settings
from tests.test_gallery_api_routes import GalleryApiTestBase


def _png_bytes(color: str = "#336699") -> bytes:
    image = Image.new("RGB", (8, 6), color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class GalleryPathAndAnnotationRegressionTest(GalleryApiTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.source = self.import_source(
            {
                "nested/pic.jpg": _png_bytes(),
                "nested/pic.txt": "original token",
            }
        )
        root_directory = self.container.db.gallery.get_root_directory(
            self.source["source_id"]
        )
        assert root_directory is not None
        page = self.container.db.gallery.list_directory_entries(
            directory_id=root_directory["directory_id"],
            include_descendants=True,
        )
        self.asset = page["assets"][0]
        self.asset_url = f"/api/v1/gallery/assets/{self.asset['asset_id']}"

    def test_annotation_exposes_opaque_disk_version_and_rejects_external_change(self) -> None:
        annotation = self.client.get(f"{self.asset_url}/annotation")
        self.assertEqual(annotation.status_code, 200, annotation.text)
        disk_version = annotation.json().get("disk_version")
        self.assertIsInstance(disk_version, str)
        self.assertGreater(len(disk_version), 8)

        txt_path = self.root / "src-a" / "nested" / "pic.txt"
        txt_path.write_bytes(b"externally changed")

        response = self.client.put(
            f"{self.asset_url}/annotation",
            json={
                "content": "editor draft",
                "expected_txt_version": annotation.json()["txt_version"],
                "expected_disk_version": disk_version,
            },
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["error"]["code"], "txt_disk_conflict")
        self.assertEqual(txt_path.read_bytes(), b"externally changed")

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks are unavailable")
    def test_parent_symlink_swap_blocks_content_thumbnail_annotation_and_rename(self) -> None:
        annotation = self.client.get(f"{self.asset_url}/annotation").json()
        source_root = self.root / "src-a"
        original_parent = source_root / "nested"
        held_parent = source_root / "nested-held"
        outside_parent = self.root / "outside"
        outside_parent.mkdir()
        (outside_parent / "pic.jpg").write_bytes(_png_bytes("#ff0000"))
        (outside_parent / "pic.txt").write_bytes(b"outside sentinel")
        original_parent.rename(held_parent)
        original_parent.symlink_to(outside_parent, target_is_directory=True)

        content = self.client.get(f"{self.asset_url}/content")
        self.assertEqual(content.status_code, 409, content.text)
        self.assertEqual(content.json()["error"]["code"], "unsafe_source_path")

        thumbnail = self.client.get(
            f"{self.asset_url}/thumbnail", params={"size": 256}
        )
        self.assertEqual(thumbnail.status_code, 409, thumbnail.text)
        self.assertEqual(thumbnail.json()["error"]["code"], "unsafe_source_path")

        save = self.client.put(
            f"{self.asset_url}/annotation",
            json={
                "content": "must not escape",
                "expected_txt_version": annotation["txt_version"],
                "expected_disk_version": annotation["disk_version"],
            },
        )
        self.assertEqual(save.status_code, 409, save.text)
        self.assertEqual(save.json()["error"]["code"], "unsafe_source_path")

        rename = self.client.post(
            f"{self.asset_url}/rename", json={"new_stem": "renamed"}
        )
        self.assertEqual(rename.status_code, 409, rename.text)
        self.assertEqual(rename.json()["error"]["code"], "unsafe_source_path")

        self.assertEqual((outside_parent / "pic.txt").read_bytes(), b"outside sentinel")
        self.assertTrue((outside_parent / "pic.jpg").is_file())
        self.assertFalse((outside_parent / "renamed.jpg").exists())


class GalleryFtsAndDedupRegressionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.container = ServiceContainer(make_settings(self.root))
        self.source_root = self.root / "source"
        self.source_root.mkdir()

    def tearDown(self) -> None:
        self.container.gallery_catalog.stop()
        self.container.db.close()
        self.temp.cleanup()

    def _scan_imported(self) -> tuple[dict, dict]:
        (self.source_root / "pic.jpg").write_bytes(_png_bytes())
        (self.source_root / "pic.txt").write_text(
            "fts_unique_marker", encoding="utf-8"
        )
        source = self.container.gallery_catalog.import_source(str(self.source_root))
        self.container.gallery_catalog.scan_source(source["source_id"])
        root_directory = self.container.db.gallery.get_root_directory(source["source_id"])
        assert root_directory is not None
        asset = self.container.db.gallery.list_directory_entries(
            directory_id=root_directory["directory_id"]
        )["assets"][0]
        return source, asset

    def test_rename_and_restore_keep_real_txt_content_in_fts(self) -> None:
        source, asset = self._scan_imported()
        operations = self.container.gallery_file_operations

        operations.rename_asset(asset["asset_id"], "renamed")
        renamed_search = self.container.db.gallery.search_assets(
            scope="source",
            source_id=source["source_id"],
            query="fts_unique_marker",
        )
        self.assertEqual(
            [item["name"] for item in renamed_search["assets"]], ["renamed.jpg"]
        )

        trashed = operations.trash_assets([asset["asset_id"]])
        hidden_search = self.container.db.gallery.search_assets(
            scope="source",
            source_id=source["source_id"],
            query="fts_unique_marker",
        )
        self.assertEqual(hidden_search["assets"], [])

        operations.undo_trash(trashed["operation_id"])
        restored_search = self.container.db.gallery.search_assets(
            scope="source",
            source_id=source["source_id"],
            query="fts_unique_marker",
        )
        self.assertEqual(
            [item["name"] for item in restored_search["assets"]], ["renamed.jpg"]
        )

    def test_review_marks_retained_kept_and_rejected_never_reenters_after_scan(self) -> None:
        for name, color in (("keep.jpg", "#111111"), ("reject.jpg", "#222222")):
            (self.source_root / name).write_bytes(_png_bytes(color))
        self.container.db.create_crawl_batch(
            {
                "id": "batch-r0",
                "output_dir": str(self.source_root),
                "concurrency": 1,
                "max_tasks": 1,
            },
            [
                {
                    "id": "batch-r0-address",
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
        source = self.container.gallery_catalog.register_batch_source(
            batch_id="batch-r0",
            root_path=str(self.source_root),
            display_name="batch",
            dedup_required=True,
        )
        self.container.gallery_catalog.scan_source(source["source_id"])
        root_directory = self.container.db.gallery.get_root_directory(source["source_id"])
        assert root_directory is not None
        assets = self.container.db.gallery.list_directory_entries(
            directory_id=root_directory["directory_id"], include_descendants=True
        )["assets"]
        by_name = {asset["name"]: asset for asset in assets}

        self.container.gallery_catalog.on_review_applied(
            "batch-r0", excluded_asset_ids=[by_name["reject.jpg"]["asset_id"]]
        )
        retained = self.container.db.gallery.get_asset(by_name["keep.jpg"]["asset_id"])
        rejected = self.container.db.gallery.get_asset(by_name["reject.jpg"]["asset_id"])
        assert retained is not None and rejected is not None
        self.assertEqual(retained["dedup_visibility"], "kept")
        self.assertEqual(rejected["dedup_visibility"], "excluded")

        self.container.gallery_catalog.scan_source(source["source_id"])
        rescanned = self.container.db.gallery.list_directory_entries(
            directory_id=root_directory["directory_id"], include_descendants=True
        )["assets"]
        self.assertEqual([asset["name"] for asset in rescanned], ["keep.jpg"])
        rejected_after = self.container.db.gallery.get_asset(
            by_name["reject.jpg"]["asset_id"]
        )
        assert rejected_after is not None
        self.assertEqual(rejected_after["dedup_visibility"], "excluded")

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks are unavailable")
    def test_file_operation_rejects_parent_symlink_replacement(self) -> None:
        _source, asset = self._scan_imported()
        held = self.root / "source-held"
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "pic.jpg").write_bytes(_png_bytes("#ff0000"))
        (outside / "pic.txt").write_text("outside sentinel", encoding="utf-8")
        self.source_root.rename(held)
        self.source_root.symlink_to(outside, target_is_directory=True)

        with self.assertRaises(GalleryFileOperationError) as caught:
            self.container.gallery_file_operations.rename_asset(
                asset["asset_id"], "escaped"
            )
        self.assertEqual(caught.exception.code, "unsafe_source_path")
        self.assertTrue((outside / "pic.jpg").is_file())
        self.assertFalse((outside / "escaped.jpg").exists())


if __name__ == "__main__":
    unittest.main()
