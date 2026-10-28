"""图库内容哈希：有条件写入、扫描清值、扫描监听。"""

from __future__ import annotations

import hashlib
import io
import os
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from gdl_backend.database import Database
from gdl_backend.gallery_hashing import GalleryHashingService
from gdl_backend.gallery_service import GalleryCatalogService


def _png_bytes(color: str = "#336699") -> bytes:
    image = Image.new("RGB", (4, 3), color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class GalleryHashingTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = Database(self.root / "db.sqlite3")
        self.addCleanup(self.db.close)
        self.repo = self.db.gallery
        self.catalog = GalleryCatalogService(self.repo)
        self.addCleanup(self.catalog.stop)
        self.source_root = self.root / "src"
        self.source_root.mkdir()

    def write(self, relative: str, content: bytes) -> Path:
        target = self.source_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return target

    def import_and_scan(self) -> str:
        source = self.catalog.import_source(str(self.source_root), display_name="图库")
        self.catalog.scan_source(source["source_id"])
        return str(source["source_id"])

    def asset_by_path(self, source_id: str, relative_path: str) -> dict:
        with self.db._read() as conn:
            row = conn.execute(
                "SELECT id FROM gallery_assets WHERE source_id=? AND relative_path=?",
                (source_id, relative_path),
            ).fetchone()
        self.assertIsNotNone(row, relative_path)
        asset = self.repo.get_asset(str(row["id"]))
        assert asset is not None
        return asset

    def bump_mtime(self, path: Path) -> None:
        stat = path.stat()
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))


class ConditionalHashWriteTest(GalleryHashingTestBase):
    def test_hash_matches_file_content(self) -> None:
        payload = _png_bytes()
        self.write("a.png", payload)
        source_id = self.import_and_scan()
        asset = self.asset_by_path(source_id, "a.png")
        self.assertEqual(asset["content_sha256"], "")

        hashing = GalleryHashingService(self.repo)
        self.assertEqual(hashing.hash_asset(asset["asset_id"]), "hashed")
        stored = self.repo.get_asset(asset["asset_id"])
        self.assertEqual(stored["content_sha256"], hashlib.sha256(payload).hexdigest())
        # 已有哈希的不再重算。
        self.assertEqual(hashing.hash_asset(asset["asset_id"]), "skipped")

    def test_file_rewritten_during_read_is_not_recorded(self) -> None:
        path = self.write("a.png", _png_bytes())
        source_id = self.import_and_scan()
        asset = self.asset_by_path(source_id, "a.png")

        def rewrite(_asset: dict) -> None:
            path.write_bytes(_png_bytes("#ff0000") + b"tail")

        hashing = GalleryHashingService(self.repo, after_read=rewrite)
        self.assertEqual(hashing.hash_asset(asset["asset_id"]), "changed")
        self.assertEqual(self.repo.get_asset(asset["asset_id"])["content_sha256"], "")

    def test_index_rescanned_between_read_and_write_is_not_overwritten(self) -> None:
        path = self.write("a.png", _png_bytes())
        source_id = self.import_and_scan()
        asset = self.asset_by_path(source_id, "a.png")

        def rescan_with_new_content(_asset: dict) -> None:
            # 读完旧内容后：文件被原子替换并重新扫描。旧句柄指向旧 inode，
            # fstat 看不出变化，只有写库时的大小/mtime 条件能拦住。
            replacement = self.root / "replacement.png"
            replacement.write_bytes(_png_bytes("#00ff00"))
            os.replace(replacement, path)
            self.bump_mtime(path)
            self.catalog.scan_source(source_id)

        hashing = GalleryHashingService(self.repo, after_read=rescan_with_new_content)
        self.assertEqual(hashing.hash_asset(asset["asset_id"]), "changed")
        self.assertEqual(self.repo.get_asset(asset["asset_id"])["content_sha256"], "")

        # 下一轮按新索引重算，得到新内容的哈希。
        self.assertEqual(GalleryHashingService(self.repo).hash_asset(asset["asset_id"]), "hashed")
        self.assertEqual(
            self.repo.get_asset(asset["asset_id"])["content_sha256"],
            hashlib.sha256(path.read_bytes()).hexdigest(),
        )

    def test_set_content_sha256_requires_matching_stat_and_empty_hash(self) -> None:
        self.write("a.png", _png_bytes())
        source_id = self.import_and_scan()
        asset = self.asset_by_path(source_id, "a.png")
        digest = "a" * 64

        self.assertFalse(
            self.repo.set_content_sha256(
                asset["asset_id"], digest,
                size_bytes=asset["size_bytes"] + 1, modified_ns=asset["modified_ns"],
            )
        )
        self.assertFalse(
            self.repo.set_content_sha256(
                asset["asset_id"], digest,
                size_bytes=asset["size_bytes"], modified_ns=asset["modified_ns"] + 1,
            )
        )
        self.assertTrue(
            self.repo.set_content_sha256(
                asset["asset_id"], digest,
                size_bytes=asset["size_bytes"], modified_ns=asset["modified_ns"],
            )
        )
        # 已有值时不覆盖。
        self.assertFalse(
            self.repo.set_content_sha256(
                asset["asset_id"], "b" * 64,
                size_bytes=asset["size_bytes"], modified_ns=asset["modified_ns"],
            )
        )
        self.assertEqual(self.repo.get_asset(asset["asset_id"])["content_sha256"], digest)
        with self.assertRaises(ValueError):
            self.repo.set_content_sha256(
                asset["asset_id"], "short",
                size_bytes=asset["size_bytes"], modified_ns=asset["modified_ns"],
            )

    def test_missing_file_is_unavailable(self) -> None:
        path = self.write("a.png", _png_bytes())
        source_id = self.import_and_scan()
        asset = self.asset_by_path(source_id, "a.png")
        path.unlink()
        self.assertEqual(GalleryHashingService(self.repo).hash_asset(asset["asset_id"]), "unavailable")


class ScanClearsHashTest(GalleryHashingTestBase):
    def test_rescan_keeps_hash_when_file_unchanged(self) -> None:
        self.write("a.png", _png_bytes())
        source_id = self.import_and_scan()
        asset = self.asset_by_path(source_id, "a.png")
        GalleryHashingService(self.repo).hash_asset(asset["asset_id"])
        digest = self.repo.get_asset(asset["asset_id"])["content_sha256"]
        self.assertTrue(digest)

        self.catalog.scan_source(source_id)
        self.assertEqual(self.repo.get_asset(asset["asset_id"])["content_sha256"], digest)

    def test_rescan_clears_hash_when_mtime_changes(self) -> None:
        path = self.write("a.png", _png_bytes())
        source_id = self.import_and_scan()
        asset = self.asset_by_path(source_id, "a.png")
        GalleryHashingService(self.repo).hash_asset(asset["asset_id"])

        self.bump_mtime(path)
        self.catalog.scan_source(source_id)
        self.assertEqual(self.repo.get_asset(asset["asset_id"])["content_sha256"], "")

    def test_rescan_clears_hash_when_size_changes(self) -> None:
        path = self.write("a.png", _png_bytes())
        source_id = self.import_and_scan()
        asset = self.asset_by_path(source_id, "a.png")
        GalleryHashingService(self.repo).hash_asset(asset["asset_id"])

        stat = path.stat()
        path.write_bytes(_png_bytes("#ff00ff") + b"padding")
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.catalog.scan_source(source_id)
        self.assertEqual(self.repo.get_asset(asset["asset_id"])["content_sha256"], "")

    def test_reappearing_missing_asset_starts_without_hash(self) -> None:
        path = self.write("a.png", _png_bytes())
        source_id = self.import_and_scan()
        asset = self.asset_by_path(source_id, "a.png")
        GalleryHashingService(self.repo).hash_asset(asset["asset_id"])
        payload = path.read_bytes()
        stat = path.stat()

        path.unlink()
        self.catalog.scan_source(source_id)
        self.assertEqual(self.repo.get_asset(asset["asset_id"])["lifecycle_state"], "missing")

        path.write_bytes(payload)
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.catalog.scan_source(source_id)
        refreshed = self.repo.get_asset(asset["asset_id"])
        self.assertEqual(refreshed["lifecycle_state"], "active")
        self.assertEqual(refreshed["content_sha256"], "")


class HashingQueueTest(GalleryHashingTestBase):
    def test_queue_hashes_in_background_and_deduplicates(self) -> None:
        self.write("a.png", _png_bytes())
        self.write("b.png", _png_bytes("#ff0000"))
        source_id = self.import_and_scan()
        ids = [
            self.asset_by_path(source_id, "a.png")["asset_id"],
            self.asset_by_path(source_id, "b.png")["asset_id"],
        ]
        hashing = GalleryHashingService(self.repo)
        self.addCleanup(hashing.stop)
        self.assertEqual(hashing.enqueue(ids + ids), 2)
        self.assertTrue(hashing.wait_idle(10))
        for asset_id in ids:
            self.assertTrue(self.repo.get_asset(asset_id)["content_sha256"])
        self.assertEqual(hashing.status(), {"pending": 0, "hashed_total": 2})

    def test_stopped_queue_rejects_new_work(self) -> None:
        hashing = GalleryHashingService(self.repo)
        hashing.stop()
        self.assertEqual(hashing.enqueue(["anything"]), 0)

    def test_scan_listener_is_notified_after_commit(self) -> None:
        self.write("a.png", _png_bytes())
        calls: list[str] = []
        self.catalog.add_scan_listener(calls.append)

        def broken(_source_id: str) -> None:
            raise RuntimeError("listener boom")

        self.catalog.add_scan_listener(broken)
        with self.assertLogs("gdl_backend.gallery_service", level="ERROR"):
            source_id = self.import_and_scan()
        self.assertEqual(calls, [source_id])


if __name__ == "__main__":
    unittest.main()
