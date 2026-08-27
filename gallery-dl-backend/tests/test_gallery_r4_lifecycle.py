"""R4 regressions: durable review reconciliation and source-level Gallery counts."""
from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from gdl_backend._database_gallery_repository import gallery_asset_id
from gdl_backend.database import Database
from gdl_backend.gallery_service import GalleryCatalogService, GalleryScanInProgress


def _png_bytes(color: str) -> bytes:
    image = Image.new("RGB", (5, 4), color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class GalleryR4LifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source_root = self.root / "batch-output"
        self.source_root.mkdir()
        self.db = Database(self.root / "db.sqlite3")
        self.addCleanup(self.db.close)
        self.service = GalleryCatalogService(self.db.gallery)
        self.addCleanup(self.service.stop)
        self.db.create_crawl_batch(
            {
                "id": "batch-r4",
                "output_dir": str(self.source_root),
                "concurrency": 1,
                "max_tasks": 1,
            },
            [
                {
                    "id": "batch-r4-address",
                    "site": "example.com",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://example.com/gallery",
                    "proxy_mode": "direct",
                    "max_attempts": 1,
                    "priority": 0,
                }
            ],
        )

    def _make_scanned_source(self) -> dict:
        (self.source_root / "keep.jpg").write_bytes(_png_bytes("#111111"))
        (self.source_root / "keep.txt").write_text("keep-tag", encoding="utf-8")
        (self.source_root / "reject.jpg").write_bytes(_png_bytes("#222222"))
        (self.source_root / "reject.txt").write_text("reject-tag", encoding="utf-8")
        source = self.service.register_batch_source(
            batch_id="batch-r4",
            root_path=str(self.source_root),
            display_name="批次来源",
            dedup_required=True,
        )
        self.service.scan_source(source["source_id"])
        return self.service.get_source(source["source_id"])

    def test_moved_rejection_stays_excluded_after_rescan_and_counts_remain_stable(self) -> None:
        source = self._make_scanned_source()
        duplicate_root = self.source_root / "duplicates"
        duplicate_root.mkdir()
        (self.source_root / "reject.jpg").rename(duplicate_root / "reject.jpg")
        (self.source_root / "reject.txt").rename(duplicate_root / "reject.txt")

        reconciled = self.service.reconcile_review_result(
            "batch-r4",
            retained_relative_paths=["keep.jpg"],
            excluded_relative_paths=["reject.jpg"],
            rejected_relative_paths=["duplicates/reject.jpg"],
        )
        assert reconciled is not None
        self.assertEqual(reconciled["reconciliation_state"], "applied")
        self.assertEqual(reconciled["candidate_count"], 0)
        self.assertEqual(reconciled["kept_count"], 1)
        self.assertEqual(reconciled["removed_count"], 1)

        self.service.scan_source(source["source_id"])
        rescanned = self.service.get_source(source["source_id"])
        self.assertEqual(rescanned["asset_count"], 1)
        self.assertEqual(rescanned["candidate_count"], 0)
        self.assertEqual(rescanned["kept_count"], 1)
        self.assertEqual(rescanned["removed_count"], 1)
        self.assertEqual(rescanned["dedup_state"], "applied")

        page = self.db.gallery.list_directory_entries(
            directory_id=rescanned["root_directory_id"],
            include_descendants=True,
            limit=50,
        )
        self.assertEqual([asset["relative_path"] for asset in page["assets"]], ["keep.jpg"])
        rejected = self.db.gallery.get_asset(
            gallery_asset_id(source["source_id"], "duplicates/reject.jpg")
        )
        assert rejected is not None
        self.assertEqual(rejected["dedup_visibility"], "excluded")
        self.assertEqual(
            self.db.gallery.search_assets(
                scope="source",
                source_id=source["source_id"],
                query="reject-tag",
                limit=20,
            )["assets"],
            [],
        )

        # The old rejected path is not a permanent tombstone. Recreating it
        # introduces a new candidate and makes the applied result stale.
        (self.source_root / "reject.jpg").write_bytes(_png_bytes("#333333"))
        (self.source_root / "reject.txt").write_text("new-tag", encoding="utf-8")
        self.service.scan_source(source["source_id"])
        recreated = self.service.get_source(source["source_id"])
        self.assertEqual(recreated["candidate_count"], 1)
        self.assertEqual(recreated["kept_count"], 1)
        self.assertEqual(recreated["removed_count"], 1)
        self.assertEqual(recreated["dedup_state"], "stale")
        replacement = self.db.gallery.get_asset(
            gallery_asset_id(source["source_id"], "reject.jpg")
        )
        assert replacement is not None
        self.assertEqual(replacement["dedup_visibility"], "candidate")

    def test_scan_retries_when_review_reconciliation_commits_a_newer_projection(self) -> None:
        source = self._make_scanned_source()
        real_commit = self.db.gallery.commit_scan
        injected = False

        def commit_with_review_race(*args, **kwargs):
            nonlocal injected
            if not injected:
                injected = True
                duplicate_root = self.source_root / "duplicates"
                duplicate_root.mkdir()
                (self.source_root / "reject.jpg").rename(duplicate_root / "reject.jpg")
                (self.source_root / "reject.txt").rename(duplicate_root / "reject.txt")
                event = self.db.gallery.queue_review_reconciliation(
                    source_id=source["source_id"],
                    batch_id="batch-r4",
                    retained_relative_paths=["keep.jpg"],
                    excluded_relative_paths=["reject.jpg"],
                    rejected_relative_paths=["duplicates/reject.jpg"],
                )
                self.db.gallery.apply_review_reconciliation(event["event_id"])
            return real_commit(*args, **kwargs)

        with mock.patch.object(
            self.db.gallery, "commit_scan", side_effect=commit_with_review_race
        ) as commit:
            self.service.scan_source(source["source_id"])

        self.assertEqual(commit.call_count, 2)
        rescanned = self.service.get_source(source["source_id"])
        self.assertEqual(rescanned["dedup_state"], "applied")
        self.assertEqual(rescanned["kept_count"], 1)
        self.assertEqual(rescanned["removed_count"], 1)
        page = self.db.gallery.list_directory_entries(
            directory_id=rescanned["root_directory_id"],
            include_descendants=True,
            limit=50,
        )
        self.assertEqual([asset["relative_path"] for asset in page["assets"]], ["keep.jpg"])

    def test_reconciliation_failure_is_persisted_and_retryable(self) -> None:
        source = self._make_scanned_source()
        duplicate_root = self.source_root / "duplicates"
        duplicate_root.mkdir()
        (self.source_root / "reject.jpg").rename(duplicate_root / "reject.jpg")
        (self.source_root / "reject.txt").rename(duplicate_root / "reject.txt")
        real_apply = self.db.gallery.apply_review_reconciliation
        with mock.patch.object(
            self.db.gallery,
            "apply_review_reconciliation",
            side_effect=RuntimeError("injected raw detail must not escape"),
        ):
            failed = self.service.reconcile_review_result(
                "batch-r4",
                retained_relative_paths=["keep.jpg"],
                excluded_relative_paths=["reject.jpg"],
                rejected_relative_paths=["duplicates/reject.jpg"],
            )
        assert failed is not None
        self.assertEqual(failed["reconciliation_state"], "failed")
        self.assertEqual(
            failed["reconciliation_error_code"], "review_reconciliation_apply_failed"
        )
        self.assertNotIn("injected", str(failed))
        self.assertEqual(failed["asset_count"], 1)
        self.assertEqual(failed["removed_count"], 1)
        failed_page = self.db.gallery.list_directory_entries(
            directory_id=failed["root_directory_id"],
            include_descendants=True,
            limit=50,
        )
        self.assertEqual(
            [asset["relative_path"] for asset in failed_page["assets"]], ["keep.jpg"]
        )

        self.service.scan_source(source["source_id"])
        pending = self.service.get_source(source["source_id"])
        self.assertEqual(pending["dedup_state"], "reconciliation_pending")
        self.assertEqual(pending["removed_count"], 1)
        page = self.db.gallery.list_directory_entries(
            directory_id=pending["root_directory_id"],
            include_descendants=True,
            limit=50,
        )
        self.assertEqual([asset["relative_path"] for asset in page["assets"]], ["keep.jpg"])

        with mock.patch.object(
            self.db.gallery, "apply_review_reconciliation", wraps=real_apply
        ) as retried_apply:
            retried = self.service.retry_review_reconciliation(source["source_id"])
        retried_apply.assert_called_once()
        self.assertEqual(retried["reconciliation_state"], "applied")
        self.assertEqual(retried["reconciliation_error_code"], "")
        self.assertGreaterEqual(retried["reconciliation_attempt_count"], 2)

    def test_finished_scan_worker_cannot_overwrite_a_newer_operation(self) -> None:
        source = self._make_scanned_source()
        newer = {
            "operation_id": "scan-new",
            "source_id": source["source_id"],
            "state": "running",
            "started_at": 20.0,
            "finished_at": None,
            "error_code": "",
            "stats": None,
        }
        with self.service._scan_lock:
            self.service._scan_jobs[source["source_id"]] = newer
        with mock.patch.object(
            self.service, "scan_source", return_value={"asset_count": 2}
        ):
            self.service._run_scan(source["source_id"], "scan-old")
        current = self.service.get_scan(source["source_id"])
        self.assertEqual(current["operation_id"], "scan-new")
        self.assertEqual(current["state"], "running")
        self.assertIsNone(current["finished_at"])
        self.assertIsNone(current["stats"])


    def test_relink_does_not_change_root_while_a_scan_is_running(self) -> None:
        source = self._make_scanned_source()
        replacement_root = self.root / "replacement"
        replacement_root.mkdir()
        with self.service._scan_lock:
            self.service._scan_jobs[source["source_id"]] = {"state": "running"}
        try:
            with self.assertRaises(GalleryScanInProgress):
                self.service.relink_source(source["source_id"], str(replacement_root))
        finally:
            with self.service._scan_lock:
                self.service._scan_jobs.pop(source["source_id"], None)

        persisted = self.db.gallery.get_source(source["source_id"])
        assert persisted is not None
        self.assertEqual(Path(persisted["root_path"]), self.source_root)

if __name__ == "__main__":
    unittest.main()
