from __future__ import annotations

import inspect
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any

from gdl_backend import _database_schema, _database_task_repository
from gdl_backend.database import (
    CURRENT_SCHEMA_VERSION,
    SITE_POLICY_SIMPLIFICATION_SCHEMA_VERSION,
    Database,
)


PUBLIC_DATABASE_SIGNATURES = {
    "close": "(self) -> 'None'",
    "ping": "(self) -> 'bool'",
    "create_task": "(self, values: 'dict[str, Any]', *, idempotency_key: 'str | None' = None) -> 'tuple[dict[str, Any], bool]'",
    "create_crawl_media_tasks": "(self, address_id: 'str', items: 'list[dict[str, Any]]') -> 'list[dict[str, Any]]'",
    "get_task": "(self, task_id: 'str') -> 'dict[str, Any] | None'",
    "get_task_by_idempotency": "(self, key: 'str') -> 'dict[str, Any] | None'",
    "list_tasks": "(self, *, status: 'str | None' = None, site: 'str | None' = None, limit: 'int' = 50, offset: 'int' = 0) -> 'list[dict[str, Any]]'",
    "queued_tasks": "(self, limit: 'int' = 100, exclude_sites: 'set[str] | None' = None) -> 'list[dict[str, Any]]'",
    "queued_task_ids": "(self, task_ids: 'set[str]') -> 'set[str]'",
    "mark_task_credentials_unavailable": "(self, task_id: 'str', site: 'str') -> 'bool'",
    "claim_task": "(self, task_id: 'str') -> 'bool'",
    "begin_attempt": "(self, task_id: 'str') -> 'dict[str, Any]'",
    "set_process": "(self, task_id: 'str', attempt_id: 'str', pid: 'int', marker: 'str') -> 'None'",
    "finish_attempt": "(self, attempt_id: 'str', *, exit_code: 'int | None', status: 'str', error_class: 'str' = '', error_message: 'str' = '', retryable: 'bool' = False, proxy_node_id: 'str | None' = None, proxy_endpoint: 'str | None' = None) -> 'None'",
    "complete_task": "(self, task_id: 'str', status: 'str', *, exit_code: 'int | None' = None, error_class: 'str' = '', error_message: 'str' = '', expected_attempt_id: 'str | None' = None) -> 'dict[str, Any] | None'",
    "requeue_task": "(self, task_id: 'str', *, next_run_at: 'float', exit_code: 'int | None', error_class: 'str', error_message: 'str', tried_proxy_ids: 'list[str]', expected_attempt_id: 'str | None' = None) -> 'bool'",
    "request_cancel": "(self, task_id: 'str') -> 'dict[str, Any] | None'",
    "retry_task": "(self, task_id: 'str', additional_attempts: 'int') -> 'dict[str, Any] | None'",
    "retry_failed_crawl_tasks": "(self, batch_id: 'str', additional_attempts: 'int' = 1) -> 'dict[str, Any] | None'",
    "rerun_crawl_batch": "(self, batch_id: 'str', additional_attempts: 'int' = 1, requeue_succeeded: 'bool' = False) -> 'dict[str, Any] | None'",
    "set_lease": "(self, task_id: 'str', attempt_id: 'str', node_id: 'str', endpoint: 'str', site: 'str') -> 'None'",
    "clear_lease": "(self, task_id: 'str', attempt_id: 'str | None' = None) -> 'None'",
    "append_logs_bulk": "(self, rows: 'Iterable[tuple[str, str | None, float, str, str]]') -> 'int | None'",
    "append_log": "(self, task_id: 'str', attempt_id: 'str | None', stream: 'str', line: 'str') -> 'int'",
    "get_logs": "(self, task_id: 'str', *, since: 'int' = 0, tail: 'int | None' = None, limit: 'int' = 1000) -> 'list[dict[str, Any]]'",
    "get_events": "(self, task_id: 'str', *, since: 'int' = 0, limit: 'int' = 1000) -> 'list[dict[str, Any]]'",
    "update_artifacts": "(self, task_id: 'str', count: 'int', total_bytes: 'int') -> 'None'",
    "create_crawl_batch": "(self, values: 'dict[str, Any]', addresses: 'list[dict[str, Any]]', *, idempotency_key: 'str | None' = None) -> 'tuple[str, bool]'",
    "get_crawl_batch_by_idempotency": "(self, key: 'str') -> 'dict[str, Any] | None'",
    "crawl_batch_tick_view": "(self, batch_id: 'str') -> 'dict[str, Any] | None'",
    "get_crawl_batch": "(self, batch_id: 'str') -> 'dict[str, Any] | None'",
    "list_crawl_batches": "(self, *, limit: 'int' = 50, offset: 'int' = 0) -> 'list[dict[str, Any]]'",
    "get_crawl_review": "(self, batch_id: 'str') -> 'dict[str, Any] | None'",
    "start_crawl_review": "(self, batch_id: 'str') -> 'dict[str, Any]'",
    "recover_crawl_reviews": "(self) -> 'int'",
    "claim_next_crawl_review": "(self) -> 'dict[str, Any] | None'",
    "next_crawl_review_automatic": "(self) -> 'dict[str, Any] | None'",
    "requeue_crawl_review": "(self, batch_id: 'str') -> 'None'",
    "fail_crawl_review": "(self, batch_id: 'str', error: 'str', *, log_path: 'str' = '') -> 'None'",
    "retry_crawl_review": "(self, batch_id: 'str') -> 'bool'",
    "replace_crawl_review_manifest": "(self, batch_id: 'str', manifest: 'dict[str, Any]', *, log_path: 'str' = '') -> 'None'",
    "list_crawl_review_groups": "(self, batch_id: 'str', *, kind: 'str | None' = None, limit: 'int' = 12, offset: 'int' = 0, all_groups: 'bool' = False) -> 'dict[str, Any]'",
    "update_crawl_review_decisions": "(self, batch_id: 'str', decisions: 'list[dict[str, Any]]') -> 'None'",
    "get_crawl_review_image": "(self, batch_id: 'str', image_id: 'str') -> 'dict[str, Any] | None'",
    "begin_crawl_review_apply": "(self, batch_id: 'str') -> 'bool'",
    "crawl_review_apply_images": "(self, batch_id: 'str') -> 'list[dict[str, Any]]'",
    "crawl_review_automatic_images": "(self, batch_id: 'str') -> 'list[dict[str, Any]]'",
    "finish_crawl_review_automatic": "(self, batch_id: 'str') -> 'dict[str, Any] | None'",
    "stage_crawl_review_image_move": "(self, batch_id: 'str', image_id: 'str', final_relative_path: 'str') -> 'None'",
    "finish_crawl_review_image": "(self, batch_id: 'str', image_id: 'str', disposition: 'str', *, final_relative_path: 'str', error: 'str' = '') -> 'None'",
    "finish_crawl_review_apply": "(self, batch_id: 'str') -> 'dict[str, Any] | None'",
    "active_crawl_batch_ids": "(self) -> 'list[str]'",
    "next_crawl_address": "(self, batch_id: 'str') -> 'dict[str, Any] | None'",
    "save_crawl_address_proxy_probe": "(self, address_id: 'str', *, target_url: 'str', total_count: 'int', healthy_node_ids: 'list[str]', error: 'str' = '') -> 'dict[str, Any]'",
    "get_crawl_address_proxy_probe": "(self, address_id: 'str') -> 'dict[str, Any] | None'",
    "begin_crawl_address_planning": "(self, address_id: 'str') -> 'bool'",
    "task_crawl_batch_id": "(self, task_id: 'str') -> 'str | None'",
    "crawl_batch_cancel_requested": "(self, batch_id: 'str') -> 'bool | None'",
    "link_crawl_task": "(self, address_id: 'str', task_id: 'str', sequence_no: 'int', *, source_key: 'str | None' = None, source_url: 'str | None' = None) -> 'None'",
    "succeeded_danbooru_source_keys": "(self, batch_id: 'str', source_keys: 'list[str] | set[str] | tuple[str, ...]') -> 'set[str]'",
    "succeeded_danbooru_source_key_count": "(self, batch_id: 'str', target_site: 'str') -> 'int'",
    "set_crawl_address_pre_dedup_skipped_count": "(self, address_id: 'str', skipped_count: 'int') -> 'bool'",
    "finish_crawl_address_as_pre_deduplicated": "(self, address_id: 'str', skipped_count: 'int') -> 'bool'",
    "mark_crawl_address_running": "(self, address_id: 'str', *, last_error: 'str' = '', planning_error: 'str' = '') -> 'bool'",
    "reset_crawl_address_planning": "(self, address_id: 'str', error: 'str' = '') -> 'bool'",
    "crawl_address_tasks": "(self, address_id: 'str') -> 'list[dict[str, Any]]'",
    "list_crawl_tasks": "(self, batch_id: 'str', *, address_id: 'str | None' = None, limit: 'int' = 100, offset: 'int' = 0) -> 'list[dict[str, Any]]'",
    "crawl_batch_task_count": "(self, batch_id: 'str') -> 'int'",
    "crawl_address_task_count": "(self, address_id: 'str') -> 'int'",
    "finish_crawl_address_if_terminal": "(self, address_id: 'str') -> 'bool'",
    "fail_crawl_address": "(self, address_id: 'str', error: 'str') -> 'None'",
    "finish_crawl_batch_if_ready": "(self, batch_id: 'str') -> 'bool'",
    "request_cancel_crawl_batch": "(self, batch_id: 'str') -> 'tuple[dict[str, Any] | None, list[str]]'",
    "recover_ordered_crawls": "(self) -> 'int'",
    "put_site_policy": "(self, site: 'str', policy: 'dict[str, Any]') -> 'dict[str, Any]'",
    "get_site_policy": "(self, site: 'str') -> 'dict[str, Any] | None'",
    "list_site_policies": "(self) -> 'list[dict[str, Any]]'",
    "delete_site_policy": "(self, site: 'str') -> 'bool'",
    "incomplete_processes": "(self) -> 'list[dict[str, Any]]'",
    "recover_incomplete": "(self) -> 'int'",
}


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

    def test_public_database_facade_signatures_are_stable(self) -> None:
        actual = {
            name: str(inspect.signature(value))
            for name, value in Database.__dict__.items()
            if callable(value) and not name.startswith("_")
        }
        self.assertEqual(actual, PUBLIC_DATABASE_SIGNATURES)

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
