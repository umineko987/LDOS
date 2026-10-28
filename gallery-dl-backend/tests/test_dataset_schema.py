"""v15 数据集表迁移：v14 库带着图库数据升级，数据不丢、新对象齐全。"""

from __future__ import annotations

import io
import sqlite3
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from gdl_backend._database_schema import CURRENT_SCHEMA_VERSION, DATASET_SCHEMA_VERSION
from gdl_backend.database import Database
from gdl_backend.gallery_service import GalleryCatalogService


DATASET_TABLES = frozenset(
    {"datasets", "dataset_roots", "dataset_crawls", "dataset_decisions", "dataset_stage_runs"}
)


class DatasetSchemaMigrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    @staticmethod
    def _tables(conn: sqlite3.Connection) -> set[str]:
        return {
            str(row[0])
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }

    @staticmethod
    def _indexes(conn: sqlite3.Connection) -> set[str]:
        return {
            str(row[0])
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")
        }

    @staticmethod
    def _version(conn: sqlite3.Connection) -> str:
        return str(conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0])

    def test_current_version_is_v15(self) -> None:
        self.assertEqual(CURRENT_SCHEMA_VERSION, DATASET_SCHEMA_VERSION)
        self.assertEqual(CURRENT_SCHEMA_VERSION, 15)

    def test_populated_v14_database_upgrades_and_keeps_gallery_rows(self) -> None:
        path = self.root / "legacy-v14.sqlite3"
        library = self.root / "lib"
        (library / "a").mkdir(parents=True)
        buffer = io.BytesIO()
        Image.new("RGB", (4, 3), "#336699").save(buffer, format="PNG")
        (library / "a" / "one.png").write_bytes(buffer.getvalue())

        legacy = Database(path)
        catalog = GalleryCatalogService(legacy.gallery)
        source = catalog.import_source(str(library), display_name="旧图库")
        source_id = str(source["source_id"])
        catalog.scan_source(source_id)
        with legacy._transaction() as conn:
            conn.execute(
                "UPDATE gallery_assets SET content_sha256=? WHERE source_id=?",
                ("c" * 64, source_id),
            )
            # 模拟真正的 v14 库：v15 对象都不存在。
            conn.execute("DROP INDEX IF EXISTS idx_gallery_assets_content_sha256")
            for table in ("dataset_stage_runs", "dataset_decisions", "dataset_crawls",
                          "dataset_roots", "datasets"):
                conn.execute(f"DROP TABLE IF EXISTS {table}")
            conn.execute("UPDATE meta SET value='14' WHERE key='schema_version'")
        self.assertTrue(DATASET_TABLES.isdisjoint(self._tables(legacy._conn)))
        legacy.close()

        upgraded = Database(path)
        try:
            self.assertEqual(self._version(upgraded._conn), "15")
            self.assertTrue(DATASET_TABLES.issubset(self._tables(upgraded._conn)))
            self.assertIn("idx_gallery_assets_content_sha256", self._indexes(upgraded._conn))
            rows = upgraded._conn.execute(
                "SELECT relative_path, content_sha256 FROM gallery_assets WHERE source_id=?",
                (source_id,),
            ).fetchall()
            self.assertEqual([tuple(row) for row in rows], [("a/one.png", "c" * 64)])

            # 新表可直接使用，并能引用升级前就存在的图库来源。
            dataset = upgraded.datasets.create_dataset(name="角色", kind="character")
            root, created = upgraded.datasets.add_root(
                dataset["dataset_id"],
                source_id=source_id,
                relative_path="a",
                directory_id="dir-a",
                origin="library",
            )
            self.assertTrue(created)
            members = upgraded.datasets.member_rows(dataset["dataset_id"])
            self.assertEqual([member["relative_path"] for member in members], ["a/one.png"])
            self.assertEqual(root["source_display_name"], "旧图库")
        finally:
            upgraded.close()

    def test_repeated_startup_is_idempotent(self) -> None:
        path = self.root / "twice.sqlite3"
        Database(path).close()
        again = Database(path)
        try:
            self.assertEqual(self._version(again._conn), str(CURRENT_SCHEMA_VERSION))
            self.assertTrue(DATASET_TABLES.issubset(self._tables(again._conn)))
        finally:
            again.close()

    def test_deleting_dataset_or_source_cascades(self) -> None:
        db = Database(self.root / "cascade.sqlite3")
        try:
            source = db.gallery.register_source(
                kind="imported", root_path=str(self.root), display_name="图库"
            )
            dataset = db.datasets.create_dataset(name="风格", kind="style")
            dataset_id = dataset["dataset_id"]
            db.datasets.add_root(
                dataset_id, source_id=source["source_id"], relative_path="",
                directory_id="root", origin="library",
            )
            db.datasets.set_decisions(dataset_id, "clean", ["asset-1"], "exclude")
            db.datasets.create_stage_run(dataset_id, "clean", input_digest="d")

            with db._transaction() as conn:
                conn.execute("DELETE FROM gallery_sources WHERE id=?", (source["source_id"],))
            self.assertEqual(db.datasets.list_roots(dataset_id), [])

            self.assertTrue(db.datasets.delete_dataset(dataset_id))
            for table in ("dataset_decisions", "dataset_stage_runs"):
                count = db._conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                self.assertEqual(count, 0, table)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
