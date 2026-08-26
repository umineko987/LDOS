from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from gdl_backend._database_schema import (
    CURRENT_SCHEMA_VERSION,
    GALLERY_EXPORT_SCHEMA_VERSION,
    initialize_schema,
)
from gdl_backend.database import Database


GALLERY_V9_TABLES = frozenset(
    {
        "gallery_sources",
        "gallery_directories",
        "gallery_assets",
        "gallery_file_operations",
        "gallery_file_operation_items",
        "gallery_search_index",
        "dataset_export_jobs",
        "dataset_export_sources",
        "dataset_export_items",
        "dataset_export_events",
    }
)

# 契约列子集：图库/导出所有权边界（docs/图库(含导出).md §5）必须由这些列承载，
# 后续 repository 不得改用无边界 JSON 大表。
GALLERY_SOURCE_COLUMNS = frozenset(
    {
        "id",
        "kind",
        "batch_id",
        "display_name",
        "root_path",
        "canonical_root_key",
        "availability",
        "crawl_complete",
        "dedup_required",
        "dedup_state",
        "content_version",
        "annotation_version",
        "indexed_version",
        "last_scanned_at",
    }
)
GALLERY_ASSET_COLUMNS = frozenset(
    {
        "id",
        "source_id",
        "directory_id",
        "relative_path",
        "name",
        "extension",
        "sort_key",
        "size_bytes",
        "modified_ns",
        "content_sha256",
        "content_version",
        "format",
        "width",
        "height",
        "read_state",
        "error_code",
        "txt_relative_path",
        "txt_size_bytes",
        "txt_modified_ns",
        "txt_sha256",
        "txt_version",
        "txt_state",
        "dedup_visibility",
        "lifecycle_state",
    }
)
DATASET_EXPORT_ITEM_COLUMNS = frozenset(
    {
        "job_id",
        "asset_id",
        "source_id",
        "output_relative_path",
        "source_relative_path",
        "txt_output_relative_path",
        "txt_source_relative_path",
        "expected_content_version",
        "expected_txt_version",
        "image_size_bytes",
        "txt_size_bytes",
        "image_sha256",
        "txt_sha256",
        "copy_state",
        "committed_at",
    }
)


class GalleryExportSchemaMigrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def _table_names(self, conn: sqlite3.Connection) -> set[str]:
        return {
            str(row[0])
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }

    def _columns(self, conn: sqlite3.Connection, table: str) -> set[str]:
        return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}

    def test_fresh_database_creates_v9_gallery_and_export_objects(self) -> None:
        db = Database(self.root / "fresh.sqlite3")
        try:
            version = db._conn.execute(
                "SELECT value FROM meta WHERE key='schema_version'"
            ).fetchone()[0]
            self.assertEqual(version, str(GALLERY_EXPORT_SCHEMA_VERSION))
            tables = self._table_names(db._conn)
            self.assertTrue(GALLERY_V9_TABLES.issubset(tables))
            self.assertTrue(
                GALLERY_SOURCE_COLUMNS.issubset(self._columns(db._conn, "gallery_sources"))
            )
            self.assertTrue(
                GALLERY_ASSET_COLUMNS.issubset(self._columns(db._conn, "gallery_assets"))
            )
            self.assertTrue(
                DATASET_EXPORT_ITEM_COLUMNS.issubset(
                    self._columns(db._conn, "dataset_export_items")
                )
            )
        finally:
            db.close()

    def test_v8_database_upgrades_to_v9_and_preserves_crawl_data(self) -> None:
        path = self.root / "legacy-v8.sqlite3"
        legacy = Database(path)
        with legacy._transaction() as conn:
            conn.execute(
                """
                INSERT INTO crawl_batches(
                    id, status, output_dir, concurrency, max_tasks,
                    created_at, updated_at
                ) VALUES ('batch-keep', 'completed', '/tmp/out', 1, 5, 1.0, 1.0)
                """
            )
            conn.execute(
                "UPDATE meta SET value='8' WHERE key='schema_version'"
            )
            # 模拟真实的 v8 数据库：v9 对象不存在。
            for table in sorted(GALLERY_V9_TABLES):
                conn.execute(f"DROP TABLE IF EXISTS {table}")
        legacy.close()

        upgraded = Database(path)
        try:
            version = upgraded._conn.execute(
                "SELECT value FROM meta WHERE key='schema_version'"
            ).fetchone()[0]
            self.assertEqual(version, str(CURRENT_SCHEMA_VERSION))
            tables = self._table_names(upgraded._conn)
            self.assertTrue(GALLERY_V9_TABLES.issubset(tables))
            batch = upgraded._conn.execute(
                "SELECT id, status FROM crawl_batches WHERE id='batch-keep'"
            ).fetchone()
            self.assertEqual(tuple(batch), ("batch-keep", "completed"))
        finally:
            upgraded.close()

    def test_repeated_startup_is_idempotent_and_keeps_version_9(self) -> None:
        path = self.root / "twice.sqlite3"
        first = Database(path)
        first.close()
        second = Database(path)
        try:
            version = second._conn.execute(
                "SELECT value FROM meta WHERE key='schema_version'"
            ).fetchone()[0]
            self.assertEqual(version, str(GALLERY_EXPORT_SCHEMA_VERSION))
            self.assertTrue(GALLERY_V9_TABLES.issubset(self._table_names(second._conn)))
        finally:
            second.close()

    def test_failed_version_bump_rolls_back_and_next_startup_recovers(self) -> None:
        path = self.root / "rollback.sqlite3"
        seed = Database(path)
        with seed._transaction() as conn:
            conn.execute("UPDATE meta SET value='8' WHERE key='schema_version'")
        seed.close()

        conn = sqlite3.connect(path)
        conn.isolation_level = None
        conn.row_factory = sqlite3.Row

        @contextmanager
        def failing_transaction() -> "sqlite3.Connection":  # type: ignore[override]
            conn.execute("BEGIN")
            raise RuntimeError("injected migration failure")

        with self.assertRaises(RuntimeError):
            initialize_schema(conn, failing_transaction)
        rolled_back_version = conn.execute(
            "SELECT value FROM meta WHERE key='schema_version'"
        ).fetchone()[0]
        self.assertEqual(rolled_back_version, "8")
        tables_after_failure = self._table_names(conn)
        self.assertTrue(GALLERY_V9_TABLES.issubset(tables_after_failure))
        conn.close()

        recovered = Database(path)
        try:
            version = recovered._conn.execute(
                "SELECT value FROM meta WHERE key='schema_version'"
            ).fetchone()[0]
            self.assertEqual(version, str(GALLERY_EXPORT_SCHEMA_VERSION))
        finally:
            recovered.close()

    def test_fts5_search_index_is_available_and_queryable(self) -> None:
        # 计划 §5.4：受控 runtime 必须提供 FTS5；缺失属于部署错误而不是可降级行为。
        db = Database(self.root / "fts.sqlite3")
        try:
            sql_row = db._conn.execute(
                "SELECT sql FROM sqlite_master WHERE name='gallery_search_index'"
            ).fetchone()
            self.assertIsNotNone(sql_row)
            self.assertIn("USING fts5", str(sql_row[0]))
            db._conn.execute(
                """
                INSERT INTO gallery_search_index(
                    asset_id, source_id, file_name, relative_path, txt_content
                ) VALUES ('asset-1', 'source-1', '10.jpg', 'sub/10.jpg', 'masterpiece, scenery')
                """
            )
            hits = db._conn.execute(
                """
                SELECT asset_id FROM gallery_search_index
                WHERE gallery_search_index MATCH 'scenery'
                """
            ).fetchall()
            self.assertEqual([row[0] for row in hits], ["asset-1"])
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
