"""v17 数据集导出迁移：旧库补上 dataset_id / options_json 与按数据集的索引。"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from gdl_backend._database_schema import CURRENT_SCHEMA_VERSION, DATASET_EXPORT_SCHEMA_VERSION
from gdl_backend.database import Database


# v9 起的旧表结构（没有 v17 补的两列）。
_LEGACY_JOBS_TABLE = """
CREATE TABLE dataset_export_jobs (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    status TEXT NOT NULL,
    target_path TEXT NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    image_bytes INTEGER NOT NULL DEFAULT 0,
    txt_bytes INTEGER NOT NULL DEFAULT 0,
    snapshot_digest TEXT NOT NULL DEFAULT '',
    error_class TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    started_at REAL,
    finished_at REAL
)
"""


class DatasetExportSchemaMigrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    @staticmethod
    def _columns(conn: sqlite3.Connection) -> set[str]:
        return {str(row[1]) for row in conn.execute("PRAGMA table_info(dataset_export_jobs)")}

    @staticmethod
    def _indexes(conn: sqlite3.Connection) -> set[str]:
        return {str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}

    @staticmethod
    def _version(conn: sqlite3.Connection) -> str:
        return str(conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0])

    def _legacy(self, name: str, version: int) -> Path:
        """建一个 vN 库：导出任务表是旧结构，并带一行旧数据。"""
        path = self.root / name
        Database(path).close()
        conn = sqlite3.connect(path)
        try:
            conn.execute("PRAGMA foreign_keys=OFF")
            for table in ("dataset_export_events", "dataset_export_items", "dataset_export_sources",
                          "dataset_export_jobs"):
                conn.execute(f"DROP TABLE IF EXISTS {table}")
            conn.execute(_LEGACY_JOBS_TABLE)
            conn.execute(
                "INSERT INTO dataset_export_jobs(id, status, target_path, created_at, updated_at)"
                " VALUES ('legacy-job', 'succeeded', '/tmp/out', 1.0, 1.0)"
            )
            conn.execute("UPDATE meta SET value=? WHERE key='schema_version'", (str(version),))
            conn.commit()
        finally:
            conn.close()
        return path

    def test_current_version_includes_dataset_exports(self) -> None:
        self.assertEqual(DATASET_EXPORT_SCHEMA_VERSION, 17)
        self.assertGreaterEqual(CURRENT_SCHEMA_VERSION, DATASET_EXPORT_SCHEMA_VERSION)

    def test_fresh_database_has_dataset_export_columns(self) -> None:
        db = Database(self.root / "fresh.sqlite3")
        try:
            self.assertEqual(self._version(db._conn), str(CURRENT_SCHEMA_VERSION))
            self.assertTrue({"dataset_id", "options_json"} <= self._columns(db._conn))
            self.assertIn("idx_dataset_export_jobs_dataset", self._indexes(db._conn))
        finally:
            db.close()

    def test_v14_and_v16_databases_upgrade_and_keep_rows(self) -> None:
        # v16（标注）迁移是否存在都不影响 v17：只按列探测补齐。
        for version in (14, 15, 16):
            with self.subTest(version=version):
                path = self._legacy(f"legacy-v{version}.sqlite3", version)
                conn = sqlite3.connect(path)
                self.assertNotIn("dataset_id", self._columns(conn))
                conn.close()
                upgraded = Database(path)
                try:
                    self.assertEqual(self._version(upgraded._conn), str(CURRENT_SCHEMA_VERSION))
                    self.assertTrue({"dataset_id", "options_json"} <= self._columns(upgraded._conn))
                    self.assertIn("idx_dataset_export_jobs_dataset", self._indexes(upgraded._conn))
                    row = upgraded._conn.execute(
                        "SELECT id, dataset_id, options_json FROM dataset_export_jobs"
                    ).fetchone()
                    self.assertEqual(tuple(row), ("legacy-job", "", "{}"))
                finally:
                    upgraded.close()

    def test_repeated_startup_is_idempotent(self) -> None:
        path = self._legacy("twice.sqlite3", 16)
        Database(path).close()
        again = Database(path)
        try:
            self.assertEqual(self._version(again._conn), str(CURRENT_SCHEMA_VERSION))
            self.assertEqual(sum(1 for column in self._columns(again._conn) if column == "dataset_id"), 1)
        finally:
            again.close()


if __name__ == "__main__":
    unittest.main()
