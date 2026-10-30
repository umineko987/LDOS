"""v16 caption 批次表：v15 库升级、仓储读写、级联删除。"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from gdl_backend._database_schema import CAPTION_BATCH_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION
from gdl_backend.database import Database


CAPTION_TABLES = frozenset({"caption_batches", "caption_batch_items"})


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _version(conn: sqlite3.Connection) -> str:
    return str(conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0])


def _item(asset_id: str, before: str | None, after: str | None, *, tags=None, same=False) -> dict:
    return {
        "asset_id": asset_id,
        "before_text": before,
        "before_version": f"v-{asset_id}-0",
        "after_text": after,
        "after_version": f"v-{asset_id}-0" if same else f"v-{asset_id}-1",
        "tagger_tags": tags,
    }


class CaptionSchemaTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def test_current_version_is_v16(self) -> None:
        self.assertEqual(CAPTION_BATCH_SCHEMA_VERSION, 16)
        self.assertGreaterEqual(CURRENT_SCHEMA_VERSION, CAPTION_BATCH_SCHEMA_VERSION)

    def test_v15_database_upgrades_and_keeps_datasets(self) -> None:
        path = self.root / "legacy-v15.sqlite3"
        legacy = Database(path)
        dataset = legacy.datasets.create_dataset(name="角色", kind="character", trigger_word="sks")
        with legacy._transaction() as conn:
            for table in ("caption_batch_items", "caption_batches"):
                conn.execute(f"DROP TABLE IF EXISTS {table}")
            conn.execute("UPDATE meta SET value='15' WHERE key='schema_version'")
        self.assertTrue(CAPTION_TABLES.isdisjoint(_tables(legacy._conn)))
        legacy.close()

        upgraded = Database(path)
        try:
            self.assertEqual(_version(upgraded._conn), str(CURRENT_SCHEMA_VERSION))
            self.assertTrue(CAPTION_TABLES.issubset(_tables(upgraded._conn)))
            kept = upgraded.datasets.get_dataset(dataset["dataset_id"])
            self.assertEqual((kept["name"], kept["trigger_word"]), ("角色", "sks"))
            batch = upgraded.captions.create_batch(
                dataset["dataset_id"], kind="ops", params={"ops": []}, stats={"changed": 1},
                items=[_item("a1", "old", "new")],
            )
            self.assertEqual(batch["changed_count"], 1)
        finally:
            upgraded.close()

        again = Database(path)
        try:
            self.assertEqual(_version(again._conn), str(CURRENT_SCHEMA_VERSION))
            self.assertEqual(len(again.captions.list_batches(dataset["dataset_id"])), 1)
        finally:
            again.close()

    def test_early_v16_tables_gain_new_columns_with_old_behaviour(self) -> None:
        # 早期 v16 的表没有写入日志和逐张撤销的列：打开时补上，旧行默认是已写完、未撤销
        path = self.root / "early-v16.sqlite3"
        early = Database(path)
        dataset_id = early.datasets.create_dataset(name="d", kind="style")["dataset_id"]
        batch = early.captions.create_batch(dataset_id, kind="ops", params={}, stats={},
                                            items=[_item("a1", "old", "new")])
        with early._transaction() as conn:
            for table, column in (("caption_batches", "state"), ("caption_batch_items", "write_state"),
                                  ("caption_batch_items", "undo_state"), ("caption_batch_items", "before_bom")):
                conn.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
        early.close()

        upgraded = Database(path)
        try:
            self.assertEqual(_version(upgraded._conn), str(CURRENT_SCHEMA_VERSION))
            kept = upgraded.captions.get_batch(batch["batch_id"])
            self.assertEqual((kept["state"], kept["changed_count"], kept["undoable_count"]), ("complete", 1, 1))
            (item,) = upgraded.captions.batch_items(batch["batch_id"])
            self.assertEqual((item["write_state"], item["undo_state"], item["before_bom"]), ("written", None, False))
            self.assertEqual(upgraded.captions.writing_batches(), [])
        finally:
            upgraded.close()

    def test_repository_round_trip_undo_and_tagger_baseline(self) -> None:
        db = Database(self.root / "repo.sqlite3")
        self.addCleanup(db.close)
        dataset_id = db.datasets.create_dataset(name="d", kind="style")["dataset_id"]
        first = db.captions.create_batch(
            dataset_id, kind="from_tagger", params={"mode": "merge"}, stats={},
            items=[_item("a1", None, "1girl, hat", tags=["1girl", "hat"]),
                   _item("a2", "x", "x", tags=["x"], same=True)],
        )
        self.assertEqual(first["changed_count"], 1)
        self.assertIsNone(first["undone_at"])
        items = db.captions.batch_items(first["batch_id"])
        self.assertEqual([item["asset_id"] for item in items], ["a1", "a2"])
        self.assertIsNone(items[0]["before_text"])
        self.assertEqual(items[0]["tagger_tags"], ["1girl", "hat"])

        second = db.captions.create_batch(
            dataset_id, kind="from_tagger", params={}, stats={},
            items=[_item("a1", "1girl, hat", "1girl", tags=["1girl"])],
        )
        db.captions.create_batch(dataset_id, kind="ops", params={}, stats={},
                                 items=[_item("a1", "1girl", "1girl, smile")])
        self.assertEqual(db.captions.latest_tagger_tags(dataset_id),
                         {"a1": ["1girl"], "a2": ["x"]})
        self.assertTrue(db.captions.mark_undone(second["batch_id"], {"restored": 1}))
        self.assertFalse(db.captions.mark_undone(second["batch_id"], {"restored": 0}))
        self.assertEqual(db.captions.latest_tagger_tags(dataset_id, ["a1"]), {"a1": ["1girl", "hat"]})

        history = db.captions.list_batches(dataset_id)
        self.assertEqual([batch["kind"] for batch in history], ["ops", "from_tagger", "from_tagger"])
        self.assertEqual(history[1]["undo_stats"], {"restored": 1})
        self.assertIsNotNone(history[1]["undone_at"])

        with self.assertRaises(ValueError):
            db.captions.create_batch(dataset_id, kind="bogus", params={}, stats={}, items=[])

    def test_deleting_dataset_cascades_to_batches(self) -> None:
        db = Database(self.root / "cascade.sqlite3")
        self.addCleanup(db.close)
        dataset_id = db.datasets.create_dataset(name="d", kind="style")["dataset_id"]
        db.captions.create_batch(dataset_id, kind="edit", params={}, stats={},
                                 items=[_item("a1", "a", "b")])
        self.assertTrue(db.datasets.delete_dataset(dataset_id))
        for table in CAPTION_TABLES:
            self.assertEqual(db._conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0, table)


if __name__ == "__main__":
    unittest.main()
