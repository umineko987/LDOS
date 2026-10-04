from __future__ import annotations

import inspect
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any

from gdl_backend import (
    _database_crawl_repository,
    _database_policy_repository,
    _database_proxy_repository,
    _database_review_repository,
    _database_schema,
    _database_task_repository,
)
from gdl_backend.database import (
    CURRENT_SCHEMA_VERSION,
    SITE_POLICY_SIMPLIFICATION_SCHEMA_VERSION,
    Database,
)

def task_values(root: Path, task_id: str = "task-transaction") -> dict[str, Any]:
    return {
        "id": task_id,
        "url": "https://example.com/gallery/transaction",
        "site": "example.com",
        "subcategory": "gallery",
        "extractor": "ExampleExtractor",
        "output_dir": str(root / "out"),
        "proxy_mode": "prefer",
        "max_attempts": 3,
        "policy": {"max_concurrency": 1},
        "extra_args": [],
    }


def manifest(image_ids: tuple[str, str] = ("image-1", "image-2")) -> dict[str, Any]:
    return {
        "schema_version": 2,
        "counts": {"images": 2},
        "groups": [
            {
                "id": "group-1",
                "ordinal": 1,
                "kind": "duplicate",
                "match_levels": ["L0-完全相同"],
                "reason": "characterization",
                "items": [
                    {
                        "id": image_id,
                        "relative_path": f"source/{image_id}.png",
                        "readable": True,
                        "recommended": index == 0,
                        "metadata": {"file_hash": image_id, "size": index + 1},
                    }
                    for index, image_id in enumerate(image_ids)
                ],
            }
        ],
        "auto_groups": [],
    }


class _FailFirstBeginConnection:
    """Transparent connection proxy that fails exactly one BEGIN IMMEDIATE."""

    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection
        self.control_statements: list[str] = []
        self._fail_begin = True

    @property
    def in_transaction(self) -> bool:
        return self._connection.in_transaction

    def execute(self, sql: str, parameters=()):
        normalized = " ".join(sql.strip().upper().split())
        if normalized in {"BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"}:
            self.control_statements.append(normalized)
        if normalized == "BEGIN IMMEDIATE" and self._fail_begin:
            self._fail_begin = False
            raise sqlite3.OperationalError("injected BEGIN IMMEDIATE failure")
        return self._connection.execute(sql, parameters)

    def __getattr__(self, name: str):
        return getattr(self._connection, name)


class DatabaseTransactionBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.db = Database(self.root / "database.sqlite3", max_logs_per_task=100)

    def tearDown(self) -> None:
        self.db.close()
        self.temporary.cleanup()

    def _create_analyzing_review(self, batch_id: str = "batch-review") -> None:
        self.db.create_crawl_batch(
            {
                "id": batch_id,
                "output_dir": str(self.root / batch_id),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": f"{batch_id}-address",
                    "site": "danbooru",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=boundary",
                    "proxy_mode": "direct",
                    "max_attempts": 1,
                }
            ],
        )
        address_id = f"{batch_id}-address"
        self.assertTrue(self.db.begin_crawl_address_planning(address_id))
        self.assertTrue(self.db.finish_crawl_address_as_pre_deduplicated(address_id, 0))
        self.assertTrue(self.db.finish_crawl_batch_if_ready(batch_id))
        self.assertEqual(self.db.start_crawl_review(batch_id)["status"], "pending")
        self.assertEqual(self.db.claim_next_crawl_review()["batch_id"], batch_id)

    def _review_rows(self, batch_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        with self.db._read() as connection:
            groups = [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM crawl_review_groups WHERE batch_id=? ORDER BY ordinal",
                    (batch_id,),
                ).fetchall()
            ]
            images = [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM crawl_review_images WHERE batch_id=? ORDER BY ordinal",
                    (batch_id,),
                ).fetchall()
            ]
        return groups, images

    def test_database_is_the_begin_commit_and_rollback_owner(self) -> None:
        source = inspect.getsource(Database._transaction)
        self.assertIn('self._conn.execute("BEGIN IMMEDIATE")', source)
        self.assertIn('self._conn.execute("COMMIT")', source)
        self.assertIn('self._conn.execute("ROLLBACK")', source)
        self.assertIn("with self._lock", source)

    def test_schema_module_uses_database_owned_connection_and_transaction(self) -> None:
        source = inspect.getsource(_database_schema)
        self.assertNotIn("sqlite3.connect(", source)
        self.assertNotIn('execute("BEGIN', source)
        self.assertNotIn('execute("COMMIT', source)
        self.assertNotIn('execute("ROLLBACK', source)
        self.assertIn("with transaction() as conn", source)
        self.assertEqual(CURRENT_SCHEMA_VERSION, _database_schema.CURRENT_SCHEMA_VERSION)
        self.assertEqual(
            SITE_POLICY_SIMPLIFICATION_SCHEMA_VERSION,
            _database_schema.SITE_POLICY_SIMPLIFICATION_SCHEMA_VERSION,
        )

    def test_task_repository_uses_database_owned_boundaries(self) -> None:
        source = inspect.getsource(_database_task_repository)
        self.assertNotIn("sqlite3.connect(", source)
        self.assertNotIn('execute("BEGIN', source)
        self.assertNotIn('execute("COMMIT', source)
        self.assertNotIn('execute("ROLLBACK', source)
        repository = self.db._task_repository
        self.assertIs(repository._read.__self__, self.db)
        self.assertIs(repository._transaction.__self__, self.db)
        self.assertIs(repository._lock, self.db._lock)

    def test_crawl_repository_uses_database_owned_boundaries(self) -> None:
        source = inspect.getsource(_database_crawl_repository)
        self.assertNotIn("sqlite3.connect(", source)
        self.assertNotIn('execute("BEGIN', source)
        self.assertNotIn('execute("COMMIT', source)
        self.assertNotIn('execute("ROLLBACK', source)
        repository = self.db._crawl_repository
        self.assertIs(repository._read.__self__, self.db)
        self.assertIs(repository._transaction.__self__, self.db)
        self.assertIs(repository._add_event.__self__, self.db._task_repository)

    def test_review_repository_uses_database_owned_boundaries(self) -> None:
        source = inspect.getsource(_database_review_repository)
        self.assertNotIn("sqlite3.connect(", source)
        self.assertNotIn('execute("BEGIN', source)
        self.assertNotIn('execute("COMMIT', source)
        self.assertNotIn('execute("ROLLBACK', source)
        repository = self.db._review_repository
        self.assertIs(repository._read.__self__, self.db)
        self.assertIs(repository._transaction.__self__, self.db)

    def test_manifest_steps_are_independently_projectable(self) -> None:
        normalized = _database_review_repository.normalize_crawl_review_manifest(
            manifest(("step-1", "step-2"))
        )
        self.assertEqual(normalized["image_count"], 2)
        self.assertEqual(normalized["manual_group_count"], 1)
        self.assertEqual(
            [image["id"] for image in normalized["groups"][0]["images"]],
            ["step-1", "step-2"],
        )
        self.assertEqual(
            _database_review_repository.project_crawl_review_manifest_result(
                normalized
            ),
            {
                "status": "ready",
                "total_image_count": 2,
                "total_group_count": 1,
                "duplicate_group_count": 1,
                "unreadable_image_count": 0,
                "automatic_group_count": 0,
                "automatic_rejected_image_count": 0,
            },
        )
        with self.assertRaisesRegex(ValueError, "重复的图片 ID"):
            _database_review_repository.normalize_crawl_review_manifest(
                manifest(("duplicate", "duplicate"))
            )

    def test_manifest_state_read_and_final_write_share_one_transaction(self) -> None:
        batch_id = "batch-one-manifest-transaction"
        self._create_analyzing_review(batch_id)
        with self.db._read() as connection:
            state = _database_review_repository.read_crawl_review_manifest_state(
                connection, batch_id
            )
        self.assertEqual(state, {"status": "analyzing"})

        proxy = _FailFirstBeginConnection(self.db._conn)
        proxy._fail_begin = False
        self.db._conn = proxy  # type: ignore[assignment]
        self.db.replace_crawl_review_manifest(batch_id, manifest())

        self.assertEqual(proxy.control_statements, ["BEGIN IMMEDIATE", "COMMIT"])
        self.assertEqual(self.db.get_crawl_review(batch_id)["status"], "ready")

    def test_proxy_repository_uses_database_owned_boundaries(self) -> None:
        source = inspect.getsource(_database_proxy_repository)
        self.assertNotIn("sqlite3.connect(", source)
        self.assertNotIn('execute("BEGIN', source)
        self.assertNotIn('execute("COMMIT', source)
        self.assertNotIn('execute("ROLLBACK', source)
        repository = self.db._proxy_probe_repository
        self.assertIs(repository._read.__self__, self.db)
        self.assertIs(repository._transaction.__self__, self.db)

    def test_proxy_probe_node_failure_rolls_back_summary_and_nodes(self) -> None:
        batch_id = "batch-proxy-rollback"
        self._create_analyzing_review(batch_id)
        address_id = f"{batch_id}-address"
        original = self.db.save_crawl_address_proxy_probe(
            address_id,
            target_url="https://example.com/original",
            total_count=1,
            healthy_node_ids=["original-node"],
        )
        self.db._conn.executescript(
            """
            CREATE TRIGGER fail_proxy_node_insert
            BEFORE INSERT ON crawl_address_proxy_nodes
            WHEN NEW.node_id='failing-node'
            BEGIN
                SELECT RAISE(ABORT, 'injected proxy-node failure');
            END;
            """
        )

        with self.assertRaisesRegex(sqlite3.IntegrityError, "injected proxy-node"):
            self.db.save_crawl_address_proxy_probe(
                address_id,
                target_url="https://example.com/replacement",
                total_count=2,
                healthy_node_ids=["healthy-node", "failing-node"],
            )

        self.assertEqual(self.db.get_crawl_address_proxy_probe(address_id), original)
        self.db._conn.execute("DROP TRIGGER fail_proxy_node_insert")
        replacement = self.db.save_crawl_address_proxy_probe(
            address_id,
            target_url="https://example.com/replacement",
            total_count=2,
            healthy_node_ids=["healthy-node"],
        )
        self.assertEqual(replacement["target_url"], "https://example.com/replacement")
        self.assertEqual(replacement["node_ids"], ["healthy-node"])

    def test_site_policy_repository_and_facade_are_converged(self) -> None:
        source = inspect.getsource(_database_policy_repository)
        self.assertNotIn("sqlite3.connect(", source)
        self.assertNotIn('execute("BEGIN', source)
        self.assertNotIn('execute("COMMIT', source)
        self.assertNotIn('execute("ROLLBACK', source)
        repository = self.db._site_policy_repository
        self.assertIs(repository._read.__self__, self.db)
        self.assertIs(repository._transaction.__self__, self.db)

        for method_name in sorted(
            name for name, value in Database.__dict__.items() if callable(value) and not name.startswith("_")
        ):
            if method_name in {"close", "ping"}:
                continue
            with self.subTest(method=method_name):
                self.assertIn(
                    "_repository",
                    inspect.getsource(getattr(Database, method_name)),
                )

    def test_failed_begin_immediate_does_not_poison_shared_connection(self) -> None:
        proxy = _FailFirstBeginConnection(self.db._conn)
        self.db._conn = proxy  # type: ignore[assignment]

        with self.assertRaisesRegex(sqlite3.OperationalError, "injected BEGIN"):
            self.db.create_task(task_values(self.root))

        self.assertFalse(proxy.in_transaction)
        self.assertEqual(proxy.control_statements, ["BEGIN IMMEDIATE"])
        created, is_new = self.db.create_task(task_values(self.root))
        self.assertTrue(is_new)
        self.assertEqual(created["id"], "task-transaction")
        self.assertEqual(
            proxy.control_statements,
            ["BEGIN IMMEDIATE", "BEGIN IMMEDIATE", "COMMIT"],
        )

    def test_mid_transaction_exception_rolls_back_and_connection_remains_usable(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "injected middle failure"):
            with self.db._transaction() as connection:
                connection.execute(
                    "INSERT INTO meta(key, value) VALUES ('half-written', '1')"
                )
                raise RuntimeError("injected middle failure")

        with self.db._read() as connection:
            row = connection.execute(
                "SELECT value FROM meta WHERE key='half-written'"
            ).fetchone()
        self.assertIsNone(row)
        created, is_new = self.db.create_task(task_values(self.root))
        self.assertTrue(is_new)
        self.assertEqual(created["status"], "queued")

    def test_concurrent_claim_has_exactly_one_winner_and_event(self) -> None:
        self.db.create_task(task_values(self.root, "task-claim"))
        contender_count = 8
        barrier = threading.Barrier(contender_count)
        results: list[bool | None] = [None] * contender_count
        errors: list[BaseException | None] = [None] * contender_count

        def claim(index: int) -> None:
            try:
                barrier.wait(timeout=5.0)
                results[index] = self.db.claim_task("task-claim")
            except BaseException as exc:
                errors[index] = exc

        threads = [threading.Thread(target=claim, args=(index,)) for index in range(contender_count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10.0)

        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [None] * contender_count)
        self.assertEqual(results.count(True), 1)
        self.assertEqual(results.count(False), contender_count - 1)
        self.assertEqual(self.db.get_task("task-claim")["status"], "starting")
        self.assertEqual(
            [event["event_type"] for event in self.db.get_events("task-claim")],
            ["queued", "starting"],
        )

    def test_manifest_mid_write_failure_restores_old_rows(self) -> None:
        batch_id = "batch-mid-write"
        self._create_analyzing_review(batch_id)
        self.db.replace_crawl_review_manifest(batch_id, manifest(("old-1", "old-2")))
        before = self._review_rows(batch_id)
        with self.db._transaction() as connection:
            connection.execute(
                "UPDATE crawl_reviews SET status='analyzing' WHERE batch_id=?",
                (batch_id,),
            )
        self.db._conn.executescript(
            """
            CREATE TRIGGER fail_second_manifest_image
            BEFORE INSERT ON crawl_review_images
            WHEN NEW.id='new-2'
            BEGIN
                SELECT RAISE(ABORT, 'injected manifest write failure');
            END;
            """
        )

        with self.assertRaisesRegex(sqlite3.IntegrityError, "injected manifest"):
            self.db.replace_crawl_review_manifest(batch_id, manifest(("new-1", "new-2")))

        self.assertEqual(self._review_rows(batch_id), before)
        self.assertEqual(self.db.get_crawl_review(batch_id)["status"], "analyzing")
        self.db._conn.execute("DROP TRIGGER fail_second_manifest_image")
        self.db.replace_crawl_review_manifest(batch_id, manifest(("new-1", "new-2")))
        self.assertEqual(self.db.get_crawl_review(batch_id)["status"], "ready")

    def test_duplicate_manifest_rolls_back_and_facade_shapes_remain_usable(self) -> None:
        batch_id = "batch-duplicate"
        self._create_analyzing_review(batch_id)
        original = manifest(("old-a", "old-b"))
        self.db.replace_crawl_review_manifest(batch_id, original, log_path="analysis.log")
        before = self._review_rows(batch_id)
        with self.db._transaction() as connection:
            connection.execute(
                "UPDATE crawl_reviews SET status='analyzing' WHERE batch_id=?",
                (batch_id,),
            )
        duplicate = manifest(("duplicate", "duplicate"))

        with self.assertRaisesRegex(ValueError, "重复的图片 ID"):
            self.db.replace_crawl_review_manifest(batch_id, duplicate)

        self.assertEqual(self._review_rows(batch_id), before)
        review = self.db.get_crawl_review(batch_id)
        self.assertEqual(review["status"], "analyzing")
        self.assertEqual(review["selected_image_count"], 2)
        batch = self.db.get_crawl_batch(batch_id)
        self.assertEqual(batch["review"], review)
        self.assertEqual(
            set(self.db.save_crawl_address_proxy_probe(
                f"{batch_id}-address",
                target_url="https://example.com/probe",
                total_count=2,
                healthy_node_ids=["node-b", "node-a", "node-a"],
            )),
            {
                "address_id",
                "target_url",
                "total_count",
                "healthy_count",
                "checked_at",
                "last_error",
                "node_ids",
            },
        )
        self.assertEqual(
            self.db.get_crawl_address_proxy_probe(f"{batch_id}-address")["node_ids"],
            ["node-a", "node-b"],
        )


if __name__ == "__main__":
    unittest.main()
