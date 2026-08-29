"""G4 去重对账测试：审核应用→图库提交、有效状态推导、内容过期与候选过滤。"""

from __future__ import annotations

import io
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image

from gdl_backend._database_gallery_repository import GalleryRepository
from gdl_backend.database import Database
from gdl_backend.gallery_safe_paths import GalleryFilesystemLocks
from gdl_backend.gallery_file_operations import GalleryFileOperations
from gdl_backend.gallery_service import GalleryCatalogService


def _png_bytes(color: str = "#336699") -> bytes:
    image = Image.new("RGB", (5, 4), color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class DedupReconciliationTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = Database(self.root / "db.sqlite3")
        self.addCleanup(self.db.close)
        self.repo: GalleryRepository = self.db.gallery
        # 与 app.py 相同：目录服务与文件操作必须共享同一文件系统锁注册表，
        # 否则 on_review_applied 的后台重扫会与 rename/trash 竞争索引提交。
        self.locks = GalleryFilesystemLocks()
        self.service = GalleryCatalogService(self.repo, filesystem_locks=self.locks)
        self.operations = GalleryFileOperations(self.repo, filesystem_locks=self.locks)
        self.addCleanup(self.service.stop)

    def make_batch_source(self, files: dict[str, bytes]) -> tuple[dict, Path]:
        source_root = self.root / "batch-out"
        source_root.mkdir(exist_ok=True)
        for relative, content in files.items():
            target = source_root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        # gallery_sources.batch_id 有外键约束，批次行必须先存在。
        self.db.create_crawl_batch(
            {
                "id": "batch-1",
                "output_dir": str(source_root),
                "concurrency": 1,
                "max_tasks": 1,
            },
            [
                {
                    "id": "batch-1-addr",
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
        source = self.service.register_batch_source(
            batch_id="batch-1",
            root_path=str(source_root),
            display_name="批次来源",
            dedup_required=True,
        )
        self.service.start_scan(source["source_id"])
        # 等待后台扫描完成。
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            state = self.service.get_scan(source["source_id"])["state"]
            if state not in {"running", "queued"}:
                break
            time.sleep(0.01)
        assert self.service.get_scan(source["source_id"])["state"] == "succeeded"
        # 扫描完成后 root_directory_id 才可用，重新读取投影。
        refreshed = self.service.get_source(source["source_id"])
        return refreshed, source_root


class DedupApplyExclusionTest(DedupReconciliationTestBase):
    def test_apply_excludes_rejected_assets_immediately(self) -> None:
        source, root = self.make_batch_source(
            {"a.jpg": _png_bytes("#111111"), "b.jpg": _png_bytes("#222222")}
        )
        page = self.repo.list_directory_entries(
            directory_id=source["root_directory_id"], include_descendants=True, limit=50
        )
        assert page["assets"], page
        asset_ids = {asset["relative_path"]: asset["asset_id"] for asset in page["assets"]}
        rejected_id = asset_ids["b.jpg"]

        updated = self.service.on_review_applied(
            "batch-1", excluded_asset_ids=[rejected_id]
        )
        self.assertEqual(updated["dedup_state"], "applied")
        self.assertEqual(updated["asset_count"], 1)

        page2 = self.repo.list_directory_entries(
            directory_id=source["root_directory_id"], include_descendants=True, limit=50
        )
        remaining = [asset["relative_path"] for asset in page2["assets"]]
        self.assertEqual(remaining, ["a.jpg"])

        search = self.repo.search_assets(scope="source", source_id=source["source_id"], query="b", limit=10)
        self.assertEqual(search["assets"], [])

    def test_apply_records_dedup_applied_version(self) -> None:
        source, _root = self.make_batch_source({"a.jpg": _png_bytes()})
        before = self.repo.get_source(source["source_id"])
        self.service.on_review_applied("batch-1", excluded_asset_ids=[])
        after = self.repo.get_source(source["source_id"])
        self.assertEqual(after["dedup_state"], "applied")
        self.assertEqual(
            after["dedup_applied_version"], before["content_version"]
        )
        self.assertGreater(after["indexed_version"], before["indexed_version"])

    def test_directory_counts_recomputed_without_excluded(self) -> None:
        source, _root = self.make_batch_source(
            {"a.jpg": _png_bytes(), "sub/b.jpg": _png_bytes(), "sub/c.jpg": _png_bytes()}
        )
        page = self.repo.list_directory_entries(
            directory_id=source["root_directory_id"], include_descendants=False, limit=50
        )
        sub_entry = next(d for d in page["directories"] if d["relative_path"] == "sub")
        self.assertEqual(sub_entry["direct_asset_count"], 2)

        assets = self.repo.list_directory_entries(
            directory_id=sub_entry["directory_id"], include_descendants=False, limit=50
        )["assets"]
        rejected = next(a["asset_id"] for a in assets if a["relative_path"] == "sub/b.jpg")
        self.service.on_review_applied("batch-1", excluded_asset_ids=[rejected])

        page2 = self.repo.list_directory_entries(
            directory_id=source["root_directory_id"], include_descendants=False, limit=50
        )
        sub2 = next(d for d in page2["directories"] if d["relative_path"] == "sub")
        self.assertEqual(sub2["direct_asset_count"], 1)
        self.assertEqual(sub2["recursive_asset_count"], 1)


class EffectiveDedupStateTest(DedupReconciliationTestBase):
    def test_imported_source_reports_not_required(self) -> None:
        source = self.service.import_source(str(self.root), display_name="导入")
        self.assertEqual(source["dedup_state"], "not_required")

    def test_batch_source_pending_analysis_then_review_pending(self) -> None:
        source, _root = self.make_batch_source({"a.jpg": _png_bytes()})
        self.assertEqual(source["dedup_state"], "pending_analysis")

        statuses = {"pending": "review_pending", "ready": "review_pending",
                    "analyzing": "pending_analysis", "waiting_for_crawl": "pending_analysis"}
        for review_status, expected in statuses.items():
            self.service.set_review_status_lookup(lambda b, s=review_status: s)
            projected = self.service.get_source(source["source_id"])
            self.assertEqual(projected["dedup_state"], expected)

    def test_applied_then_content_change_marks_stale(self) -> None:
        source, root = self.make_batch_source({"a.jpg": _png_bytes()})
        self.service.on_review_applied("batch-1", excluded_asset_ids=[])
        self.service.set_review_status_lookup(lambda b: "applied")
        projected = self.service.get_source(source["source_id"])
        self.assertEqual(projected["dedup_state"], "applied")

        # 内容前进：rename 后来源 content_version+1 → stale。
        assets = self.repo.list_directory_entries(
            directory_id=source["root_directory_id"], include_descendants=True, limit=10
        )["assets"]
        self.operations.rename_asset(assets[0]["asset_id"], "renamed")
        projected2 = self.service.get_source(source["source_id"])
        self.assertEqual(projected2["dedup_state"], "stale")

    def test_trash_bumps_content_version(self) -> None:
        source, _root = self.make_batch_source(
            {"a.jpg": _png_bytes(), "a.txt": b"tag"}
        )
        self.service.on_review_applied("batch-1", excluded_asset_ids=[])
        before = self.repo.get_source(source["source_id"])

        assets = self.repo.list_directory_entries(
            directory_id=source["root_directory_id"], include_descendants=True, limit=10
        )["assets"]
        outcome = self.operations.trash_assets([assets[0]["asset_id"]])
        self.assertEqual(outcome["status"], "committed")
        after = self.repo.get_source(source["source_id"])
        self.assertGreater(after["content_version"], before["content_version"])


class ApplyWithoutGallerySourceTest(unittest.TestCase):
    def test_on_review_applied_without_source_returns_none(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db = Database(root / "db.sqlite3")
            try:
                service = GalleryCatalogService(db.gallery)
                try:
                    self.assertIsNone(service.on_review_applied("missing-batch"))
                finally:
                    service.stop()
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
