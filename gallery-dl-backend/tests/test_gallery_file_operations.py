"""G3-2：文件操作引擎（rename/trash/undo/restore/purge）契约测试。"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from gdl_backend.app import ServiceContainer
from gdl_backend.gallery_file_operations import (
    GalleryFileOperationError,
    GalleryFileOperations,
)
from tests.helpers import make_settings


def _png_bytes(width: int = 4, height: int = 3) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), color=(10, 200, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


class GalleryFileOperationsTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temp.name))
        self.container = ServiceContainer(self.settings)
        self.db = self.container.db
        self.engine = GalleryFileOperations(self.db.gallery)
        self.root = Path(self.temp.name) / "src"
        self.root.mkdir()

    def tearDown(self) -> None:
        self.container.gallery_catalog.stop()
        self.container.db.close()
        self.temp.cleanup()

    def scan_source(self, files: dict[str, bytes | str]) -> dict:
        for name, payload in files.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(payload, str):
                target.write_text(payload, encoding="utf-8")
            else:
                target.write_bytes(payload)
        catalog = self.container.gallery_catalog
        source = catalog.import_source(str(self.root))
        catalog.scan_source(source["source_id"])
        return source

    def asset_by_name(self, source_id: str, name: str) -> dict:
        repo = self.db.gallery
        root_dir = repo.get_root_directory(source_id)
        assert root_dir is not None
        directories: list[str] = [root_dir["directory_id"]]
        while directories:
            directory_id = directories.pop()
            entries = repo.list_directory_entries(directory_id=directory_id)
            for asset in entries["assets"]:
                if asset["name"] == name:
                    return asset
            for child in entries["directories"]:
                directories.append(child["directory_id"])
        raise AssertionError(f"asset not found: {name}")


class RenameTest(GalleryFileOperationsTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.source = self.scan_source(
            {"pic.jpg": _png_bytes(5, 2), "pic.txt": "tag_one"}
        )
        self.asset = self.asset_by_name(self.source["source_id"], "pic.jpg")

    def test_rename_pair_updates_files_and_index(self) -> None:
        result = self.engine.rename_asset(self.asset["asset_id"], "renamed")
        self.assertEqual(result["status"], "committed")
        self.assertEqual(result["item_count"], 1)
        # 文件成对改名。
        self.assertTrue((self.root / "renamed.jpg").exists())
        self.assertTrue((self.root / "renamed.txt").exists())
        self.assertFalse((self.root / "pic.jpg").exists())
        self.assertFalse((self.root / "pic.txt").exists())
        # 索引：ID 保持稳定，路径与名称更新。
        asset = self.db.gallery.get_asset(self.asset["asset_id"])
        self.assertIsNotNone(asset)
        self.assertEqual(asset["relative_path"], "renamed.jpg")
        self.assertEqual(asset["name"], "renamed.jpg")
        self.assertEqual(asset["txt_relative_path"], "renamed.txt")

    def test_rename_target_conflict_blocks_whole_operation(self) -> None:
        (self.root / "existing.jpg").write_bytes(_png_bytes())
        with self.assertRaises(GalleryFileOperationError) as ctx:
            self.engine.rename_asset(self.asset["asset_id"], "existing")
        self.assertEqual(ctx.exception.code, "rename_target_conflict")
        # 原文件未被触碰。
        self.assertTrue((self.root / "pic.jpg").exists())
        self.assertTrue((self.root / "pic.txt").exists())

    def test_rename_txt_target_conflict(self) -> None:
        (self.root / "other.txt").write_text("occupied", encoding="utf-8")
        with self.assertRaises(GalleryFileOperationError) as ctx:
            self.engine.rename_asset(self.asset["asset_id"], "other")
        self.assertEqual(ctx.exception.code, "rename_target_conflict")

    def test_rename_invalid_names(self) -> None:
        for bad in ("", ".jpg", "a/b", "a\\b", "..", "a.", "a ", "a<b"):
            with self.subTest(bad=bad):
                with self.assertRaises(GalleryFileOperationError) as ctx:
                    self.engine.rename_asset(self.asset["asset_id"], bad)
                self.assertEqual(ctx.exception.code, "invalid_rename_target")

    def test_rename_missing_asset(self) -> None:
        with self.assertRaises(GalleryFileOperationError) as ctx:
            self.engine.rename_asset("missing", "newname")
        self.assertEqual(ctx.exception.code, "asset_not_found")


class TrashTest(GalleryFileOperationsTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.source = self.scan_source(
            {
                "a.jpg": _png_bytes(),
                "a.txt": "alpha",
                "b.jpg": _png_bytes(),
                "sub/c.jpg": _png_bytes(),
                "sub/c.txt": "gamma",
            }
        )
        self.sid = self.source["source_id"]

    def test_trash_moves_pair_to_hidden_area(self) -> None:
        asset_a = self.asset_by_name(self.sid, "a.jpg")
        result = self.engine.trash_assets([asset_a["asset_id"]])
        self.assertEqual(result["status"], "committed")
        self.assertEqual(result["item_count"], 1)
        self.assertEqual(result["has_txt_count"], 1)
        # 文件移入 .imageweave/trash/<op>/files/。
        op_id = result["operation_id"]
        trash_img = self.root / ".imageweave" / "trash" / op_id / "files" / "a.jpg"
        trash_txt = self.root / ".imageweave" / "trash" / op_id / "files" / "a.txt"
        self.assertTrue(trash_img.exists())
        self.assertTrue(trash_txt.exists())
        self.assertFalse((self.root / "a.jpg").exists())
        self.assertFalse((self.root / "a.txt").exists())
        # operation.json 元数据。
        manifest = (
            self.root / ".imageweave" / "trash" / op_id / "operation.json"
        )
        self.assertTrue(manifest.exists())
        data = json.loads(manifest.read_text(encoding="utf-8"))
        self.assertEqual(data["kind"], "trash")
        # 资产 lifecycle → trashed，从目录列表消失。
        asset = self.db.gallery.get_asset(asset_a["asset_id"])
        self.assertEqual(asset["lifecycle_state"], "trashed")
        root_dir = self.db.gallery.get_root_directory(self.sid)
        entries = self.db.gallery.list_directory_entries(
            directory_id=root_dir["directory_id"]
        )
        names = [a["name"] for a in entries["assets"]]
        self.assertNotIn("a.jpg", names)
        self.assertIn("b.jpg", names)

    def test_batch_trash_atomic_rollback(self) -> None:
        asset_a = self.asset_by_name(self.sid, "a.jpg")
        asset_sub = self.asset_by_name(self.sid, "c.jpg")
        # 制造失败：让 sub/c.jpg 消失（磁盘缺失）。
        (self.root / "sub" / "c.jpg").unlink()
        with self.assertRaises(GalleryFileOperationError):
            self.engine.trash_assets([asset_a["asset_id"], asset_sub["asset_id"]])
        # 回滚：a.jpg 回到原位。
        self.assertTrue((self.root / "a.jpg").exists())
        self.assertTrue((self.root / "a.txt").exists())
        asset = self.db.gallery.get_asset(asset_a["asset_id"])
        self.assertEqual(asset["lifecycle_state"], "active")

    def test_undo_trash_restores_group(self) -> None:
        asset_a = self.asset_by_name(self.sid, "a.jpg")
        result = self.engine.trash_assets([asset_a["asset_id"]])
        op_id = result["operation_id"]
        undo = self.engine.undo_trash(op_id)
        self.assertEqual(undo["status"], "committed")
        self.assertTrue((self.root / "a.jpg").exists())
        self.assertTrue((self.root / "a.txt").exists())
        asset = self.db.gallery.get_asset(asset_a["asset_id"])
        self.assertEqual(asset["lifecycle_state"], "active")
        root_dir = self.db.gallery.get_root_directory(self.sid)
        entries = self.db.gallery.list_directory_entries(
            directory_id=root_dir["directory_id"]
        )
        names = [a["name"] for a in entries["assets"]]
        self.assertIn("a.jpg", names)

    def test_restore_conflict_blocks(self) -> None:
        asset_a = self.asset_by_name(self.sid, "a.jpg")
        result = self.engine.trash_assets([asset_a["asset_id"]])
        # 原路径被外部占用。
        (self.root / "a.jpg").write_bytes(_png_bytes())
        with self.assertRaises(GalleryFileOperationError) as ctx:
            self.engine.restore_trash(result["operation_id"])
        self.assertEqual(ctx.exception.code, "restore_target_conflict")
        # 回收区文件仍在。
        op_id = result["operation_id"]
        self.assertTrue(
            (self.root / ".imageweave" / "trash" / op_id / "files" / "a.jpg").exists()
        )

    def test_purge_removes_permanently(self) -> None:
        asset_a = self.asset_by_name(self.sid, "a.jpg")
        result = self.engine.trash_assets([asset_a["asset_id"]])
        op_id = result["operation_id"]
        purge = self.engine.purge_trash(op_id)
        self.assertEqual(purge["status"], "committed")
        # 物理文件与资产记录全部消失。
        self.assertFalse(
            (self.root / ".imageweave" / "trash" / op_id / "files" / "a.jpg").exists()
        )
        self.assertIsNone(self.db.gallery.get_asset(asset_a["asset_id"]))

    def test_list_trash_pagination(self) -> None:
        asset_a = self.asset_by_name(self.sid, "a.jpg")
        asset_b = self.asset_by_name(self.sid, "b.jpg")
        self.engine.trash_assets([asset_a["asset_id"]])
        self.engine.trash_assets([asset_b["asset_id"]])
        listing = self.engine.list_trash(limit=1)
        self.assertEqual(len(listing["operations"]), 1)
        self.assertIsNotNone(listing["next_cursor"])
        page2 = self.engine.list_trash(cursor=listing["next_cursor"], limit=1)
        self.assertEqual(len(page2["operations"]), 1)
        ids = {
            listing["operations"][0]["operation_id"],
            page2["operations"][0]["operation_id"],
        }
        self.assertEqual(len(ids), 2)


class ConcurrentOperationTest(GalleryFileOperationsTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.source = self.scan_source({"a.jpg": _png_bytes(), "a.txt": "x"})
        self.sid = self.source["source_id"]
        self.asset = self.asset_by_name(self.sid, "a.jpg")

    def test_source_locked_during_unfinished_operation(self) -> None:
        # 手动构造一个未终结操作锁住来源。
        with self.db.gallery._transaction() as conn:  # noqa: SLF001
            conn.execute(
                """
                INSERT INTO gallery_file_operations(
                    id, kind, status, source_ids_json, created_at, updated_at
                ) VALUES ('op-stuck', 'trash', 'applying', ?, 1, 1)
                """,
                (json.dumps([self.sid]),),
            )
            conn.execute(
                """
                INSERT INTO gallery_file_operation_items(
                    operation_id, ordinal, source_id, asset_id,
                    origin_relative_path, target_relative_path, has_txt
                ) VALUES ('op-stuck', 0, ?, ?, 'a.jpg', '', 1)
                """,
                (self.sid, self.asset["asset_id"]),
            )
        with self.assertRaises(GalleryFileOperationError) as ctx:
            self.engine.rename_asset(self.asset["asset_id"], "blocked")
        self.assertEqual(ctx.exception.code, "operation_in_progress")


class RecoveryTest(GalleryFileOperationsTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.source = self.scan_source({"a.jpg": _png_bytes(), "a.txt": "x"})
        self.sid = self.source["source_id"]
        self.asset = self.asset_by_name(self.sid, "a.jpg")

    def test_recover_applying_operation(self) -> None:
        # 模拟崩溃：操作处于 applying，文件已移动但状态未推进。
        op_id = "op-crashed"
        trash_dir = self.root / ".imageweave" / "trash" / op_id / "files"
        trash_dir.mkdir(parents=True)
        (self.root / "a.jpg").rename(trash_dir / "a.jpg")
        (self.root / "a.txt").rename(trash_dir / "a.txt")
        with self.db.gallery._transaction() as conn:  # noqa: SLF001
            conn.execute(
                """
                INSERT INTO gallery_file_operations(
                    id, kind, status, source_ids_json, created_at, updated_at
                ) VALUES (?, 'trash', 'applying', ?, 1, 1)
                """,
                (op_id, json.dumps([self.sid])),
            )
            conn.execute(
                """
                INSERT INTO gallery_file_operation_items(
                    operation_id, ordinal, source_id, asset_id,
                    origin_relative_path, target_relative_path, has_txt
                ) VALUES (?, 0, ?, ?, 'a.jpg', '', 1)
                """,
                (op_id, self.sid, self.asset["asset_id"]),
            )
        recovered = self.engine.recover_unfinished()
        self.assertEqual(len(recovered), 1)
        self.assertEqual(recovered[0]["outcome"], "committed")
        # 状态推进与索引一致。
        asset = self.db.gallery.get_asset(self.asset["asset_id"])
        self.assertEqual(asset["lifecycle_state"], "trashed")

    def test_recover_rolling_back_operation(self) -> None:
        # 模拟崩溃在回滚中：文件在回收区，操作状态 rolling_back。
        op_id = "op-rollback"
        trash_dir = self.root / ".imageweave" / "trash" / op_id / "files"
        trash_dir.mkdir(parents=True)
        (self.root / "a.jpg").rename(trash_dir / "a.jpg")
        (self.root / "a.txt").rename(trash_dir / "a.txt")
        with self.db.gallery._transaction() as conn:  # noqa: SLF001
            conn.execute(
                """
                INSERT INTO gallery_file_operations(
                    id, kind, status, source_ids_json, created_at, updated_at
                ) VALUES (?, 'trash', 'rolling_back', ?, 1, 1)
                """,
                (op_id, json.dumps([self.sid])),
            )
            conn.execute(
                """
                INSERT INTO gallery_file_operation_items(
                    operation_id, ordinal, source_id, asset_id,
                    origin_relative_path, target_relative_path, has_txt, status
                ) VALUES (?, 0, ?, ?, 'a.jpg', '', 1, 'done')
                """,
                (op_id, self.sid, self.asset["asset_id"]),
            )
        recovered = self.engine.recover_unfinished()
        self.assertEqual(recovered[0]["outcome"], "rolled_back")
        # 文件回到原位，资产回到 active。
        self.assertTrue((self.root / "a.jpg").exists())
        asset = self.db.gallery.get_asset(self.asset["asset_id"])
        self.assertEqual(asset["lifecycle_state"], "active")


if __name__ == "__main__":
    unittest.main()
