"""v18 决定行迁移：旧库的 dataset_decisions 补上 previous_decision / previous_reason，旧行不丢。"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from gdl_backend._database_schema import CURRENT_SCHEMA_VERSION, DATASET_DECISION_STASH_SCHEMA_VERSION
from gdl_backend.database import Database


# v15 起的旧表结构（没有 v18 补的两列）。
_LEGACY_DECISIONS_TABLE = """
CREATE TABLE dataset_decisions (
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY(dataset_id, stage, asset_id)
)
"""


class DatasetDecisionSchemaMigrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    @staticmethod
    def _columns(conn: sqlite3.Connection) -> set[str]:
        return {str(row[1]) for row in conn.execute("PRAGMA table_info(dataset_decisions)")}

    @staticmethod
    def _version(conn: sqlite3.Connection) -> str:
        return str(conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0])

    def _legacy(self, name: str) -> Path:
        """建一个 v17 库：决定表是旧结构，并带一行去重阶段的「通过」。"""
        path = self.root / name
        Database(path).close()
        conn = sqlite3.connect(path)
        try:
            conn.execute("PRAGMA foreign_keys=OFF")
            conn.execute("DROP TABLE dataset_decisions")
            conn.execute(_LEGACY_DECISIONS_TABLE)
            conn.execute(
                "INSERT INTO datasets(id, name, kind, created_at, updated_at)"
                " VALUES ('d1', '角色', 'character', 1.0, 1.0)"
            )
            conn.execute(
                "INSERT INTO dataset_decisions(dataset_id, stage, asset_id, decision, reason, created_at, updated_at)"
                " VALUES ('d1', 'dedup', 'a1', 'approve', '审核保留', 1.0, 1.0)"
            )
            conn.execute("UPDATE meta SET value='17' WHERE key='schema_version'")
            conn.commit()
        finally:
            conn.close()
        return path

    def test_current_version_includes_decision_stash(self) -> None:
        self.assertEqual(DATASET_DECISION_STASH_SCHEMA_VERSION, 18)
        self.assertGreaterEqual(CURRENT_SCHEMA_VERSION, DATASET_DECISION_STASH_SCHEMA_VERSION)

    def test_fresh_database_has_stash_columns(self) -> None:
        db = Database(self.root / "fresh.sqlite3")
        try:
            self.assertTrue({"previous_decision", "previous_reason"} <= self._columns(db._conn))
        finally:
            db.close()

    def test_v17_database_upgrades_and_old_rows_can_be_set_aside(self) -> None:
        path = self._legacy("legacy-v17.sqlite3")
        conn = sqlite3.connect(path)
        self.assertNotIn("previous_decision", self._columns(conn))
        conn.close()
        upgraded = Database(path)
        try:
            self.assertEqual(self._version(upgraded._conn), str(CURRENT_SCHEMA_VERSION))
            row = upgraded._conn.execute(
                "SELECT decision, reason, previous_decision, previous_reason FROM dataset_decisions"
            ).fetchone()
            self.assertEqual(tuple(row), ("approve", "审核保留", None, ""))
            # 升级前记下的决定同样能被收起、放回。
            self.assertEqual(upgraded.datasets.set_aside("d1", "dedup", ["a1"], reason="atlas"), 1)
            self.assertEqual(upgraded.datasets.put_back("d1", "dedup", ["a1"], reason="atlas"), 1)
            rows = [(row["decision"], row["reason"]) for row in upgraded.datasets.list_decisions("d1")]
            self.assertEqual(rows, [("approve", "审核保留")])
        finally:
            upgraded.close()

    def test_repeated_startup_is_idempotent(self) -> None:
        path = self._legacy("twice.sqlite3")
        Database(path).close()
        again = Database(path)
        try:
            self.assertEqual(self._version(again._conn), str(CURRENT_SCHEMA_VERSION))
            self.assertEqual(sum(1 for column in self._columns(again._conn) if column == "previous_decision"), 1)
        finally:
            again.close()


if __name__ == "__main__":
    unittest.main()
