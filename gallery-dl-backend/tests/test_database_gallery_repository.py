"""GalleryRepository 合同测试（G1：来源注册、扫描提交、分页与搜索）。"""

from __future__ import annotations

import os
import sqlite3
import unittest

from gdl_backend._database_gallery_repository import (
    GalleryCursorError,
    GalleryRepository,
    GallerySourceConflictError,
    gallery_asset_id,
    gallery_directory_id,
)
from gdl_backend.database import Database


class GalleryRepositoryTestBase(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile

        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Database(os.path.join(self.temp.name, "db.sqlite3"))
        self.repo: GalleryRepository = self.db.gallery
        self.addCleanup(self.db.close)

    def register(self, root: str = "/tmp/gallery-a", **kwargs) -> dict:
        return self.repo.register_source(
            kind=kwargs.pop("kind", "imported"),
            root_path=root,
            display_name=kwargs.pop("display_name", "来源A"),
            **kwargs,
        )

    @staticmethod
    def scan_payload(
        *,
        directories: list[tuple[str, str | None]] | None = None,
        assets: list[dict] | None = None,
    ) -> dict:
        directory_records = []
        for relative_path, parent in directories if directories is not None else [("", None)]:
            directory_records.append(
                {
                    "relative_path": relative_path,
                    "name": relative_path.rpartition("/")[-1],
                    "parent_relative_path": parent,
                }
            )
        asset_records = []
        for asset in assets or []:
            base = {
                "relative_path": "a.jpg",
                "name": "a.jpg",
                "extension": ".jpg",
                "size_bytes": 10,
                "modified_ns": 1,
                "format": "JPEG",
                "width": 4,
                "height": 4,
                "read_state": "ok",
                "error_code": "",
                "txt_relative_path": "a.txt",
                "txt_size_bytes": 3,
                "txt_modified_ns": 1,
                "txt_state": "normal",
                "txt_content": "tag",
            }
            base.update(asset)
            base["name"] = asset.get("name") or base["relative_path"].rpartition("/")[-1]
            asset_records.append(base)
        return {"directories": directory_records, "assets": asset_records}


class GallerySourceRegistrationTest(GalleryRepositoryTestBase):
    def test_registers_imported_source_with_defaults(self) -> None:
        source = self.register("/tmp/gallery-a")
        self.assertEqual(source["kind"], "imported")
        self.assertEqual(source["availability"], "available")
        self.assertEqual(source["dedup_state"], "not_required")
        self.assertEqual(source["indexed_version"], 0)
        self.assertEqual(source["content_version"], 1)
        self.assertIsNone(source["batch_id"])
        self.assertTrue(source["source_id"])

    def test_rejects_invalid_kinds_and_batch_combinations(self) -> None:
        with self.assertRaises(ValueError):
            self.repo.register_source(
                kind="external", root_path="/tmp/x", display_name="x"
            )
        with self.assertRaises(ValueError):
            self.repo.register_source(
                kind="crawl_batch", root_path="/tmp/x", display_name="x"
            )
        with self.assertRaises(ValueError):
            self.repo.register_source(
                kind="imported",
                root_path="/tmp/x",
                display_name="x",
                batch_id="b1",
            )

    def test_rejects_same_ancestor_and_descendant_roots(self) -> None:
        self.register("/tmp/gallery-a")
        with self.assertRaises(GallerySourceConflictError) as caught:
            self.register("/tmp/gallery-a/sub")
        self.assertEqual(caught.exception.relation, "descendant")
        with self.assertRaises(GallerySourceConflictError) as caught:
            self.register("/tmp")
        self.assertEqual(caught.exception.relation, "ancestor")
        with self.assertRaises(GallerySourceConflictError):
            self.register("/tmp/gallery-a")
        # 规范化后等价的路径同样视为 same。
        with self.assertRaises(GallerySourceConflictError):
            self.register("/tmp/gallery-a/./")

    def test_normalizes_root_paths_by_realpath(self) -> None:
        source = self.register("/tmp/../tmp/gallery-a")
        self.assertNotEqual(source["canonical_root_key"], "/tmp/../tmp/gallery-a")

    def test_unregister_cascades_index(self) -> None:
        source = self.register()
        self.repo.commit_scan(source["source_id"], **self.scan_payload())
        self.assertTrue(self.repo.unregister_source(source["source_id"]))
        self.assertFalse(self.repo.unregister_source(source["source_id"]))
        self.assertIsNone(self.repo.get_source(source["source_id"]))
        self.assertIsNone(self.repo.get_root_directory(source["source_id"]))

    def test_relink_updates_root_and_checks_conflicts(self) -> None:
        source = self.register()
        other = self.register("/tmp/gallery-b", display_name="来源B")
        with self.assertRaises(GallerySourceConflictError):
            self.repo.relink_source(source["source_id"], "/tmp/gallery-b/sub")
        relinked = self.repo.relink_source(source["source_id"], "/tmp/gallery-c")
        # canonical_root_key 应用 normcase（Windows 归一化盘符大小写与分隔符），
        # 期望值必须经过同样的归一化，不能用裸 realpath。
        self.assertEqual(
            relinked["canonical_root_key"],
            os.path.normcase(os.path.realpath("/tmp/gallery-c")),
        )
        with self.assertRaises(ValueError):
            self.repo.relink_source("missing", "/tmp/gallery-d")
        self.assertEqual(other["source_id"], other["source_id"])


class GalleryScanCommitTest(GalleryRepositoryTestBase):
    def test_commit_scan_creates_root_directory_and_assets(self) -> None:
        source = self.register()
        result = self.repo.commit_scan(
            source["source_id"],
            **self.scan_payload(
                directories=[("", None), ("sub", ""), ("sub/deep", "sub")],
                assets=[
                    {"relative_path": "10.jpg"},
                    {"relative_path": "2.jpg"},
                    {"relative_path": "sub/1.jpg"},
                    {"relative_path": "sub/deep/3.jpg"},
                ],
            ),
        )
        self.assertEqual(result["indexed_version"], 1)
        self.assertEqual(result["content_version"], 2)
        self.assertEqual(result["annotation_version"], 1)
        self.assertEqual(result["asset_count"], 4)

        root = self.repo.get_root_directory(source["source_id"])
        assert root is not None
        self.assertEqual(root["direct_asset_count"], 2)
        self.assertEqual(root["recursive_asset_count"], 4)
        self.assertEqual(root["direct_directory_count"], 1)
        self.assertEqual(
            [a["name"] for a in self._assets(root)[0]],
            ["2.jpg", "10.jpg"],
        )

        sub = self.repo.get_directory(gallery_directory_id(source["source_id"], "sub"))
        assert sub is not None
        self.assertEqual(sub["direct_asset_count"], 1)
        self.assertEqual(sub["recursive_asset_count"], 2)

    def _assets(self, directory: dict, **kwargs) -> tuple[list[dict], str | None]:
        entries = self.repo.list_directory_entries(
            directory_id=directory["directory_id"], **kwargs
        )
        return entries["assets"], entries["asset_cursor"]

    def test_rescan_keeps_stable_ids_and_versions(self) -> None:
        source = self.register()
        payload = self.scan_payload(assets=[{"relative_path": "a.jpg"}])
        self.repo.commit_scan(source["source_id"], **payload)
        first = self.repo.get_asset(gallery_asset_id(source["source_id"], "a.jpg"))
        assert first is not None

        unchanged = self.repo.commit_scan(source["source_id"], **payload)
        self.assertEqual(unchanged["content_version"], 2)
        self.assertEqual(unchanged["annotation_version"], 1)
        self.assertEqual(unchanged["indexed_version"], 2)
        again = self.repo.get_asset(gallery_asset_id(source["source_id"], "a.jpg"))
        assert again is not None
        self.assertEqual(again["asset_id"], first["asset_id"])

        changed = self.repo.commit_scan(
            source["source_id"],
            **self.scan_payload(
                assets=[{"relative_path": "a.jpg", "size_bytes": 99, "modified_ns": 5}]
            ),
        )
        self.assertEqual(changed["content_version"], 3)
        self.assertEqual(changed["annotation_version"], 1)

        txt_changed = self.repo.commit_scan(
            source["source_id"],
            **self.scan_payload(
                assets=[
                    {
                        "relative_path": "a.jpg",
                        "size_bytes": 99,
                        "modified_ns": 5,
                        "txt_modified_ns": 9,
                    }
                ]
            ),
        )
        self.assertEqual(txt_changed["annotation_version"], 2)
        self.assertEqual(txt_changed["content_version"], changed["content_version"])

    def test_missing_assets_are_marked_not_deleted(self) -> None:
        source = self.register()
        self.repo.commit_scan(
            source["source_id"],
            **self.scan_payload(assets=[{"relative_path": "a.jpg"}]),
        )
        asset_id = gallery_asset_id(source["source_id"], "a.jpg")
        self.repo.commit_scan(
            source["source_id"], **self.scan_payload(assets=[])
        )
        asset = self.repo.get_asset(asset_id)
        assert asset is not None
        self.assertEqual(asset["lifecycle_state"], "missing")
        entries = self.repo.list_directory_entries(
            directory_id=gallery_directory_id(source["source_id"], "")
        )
        self.assertEqual(entries["assets"], [])
        # 文件重新出现则恢复 active 并 bump content_version。
        self.repo.commit_scan(
            source["source_id"],
            **self.scan_payload(assets=[{"relative_path": "a.jpg"}]),
        )
        asset = self.repo.get_asset(asset_id)
        assert asset is not None
        self.assertEqual(asset["lifecycle_state"], "active")

    def test_covers_and_counts_follow_natural_order(self) -> None:
        source = self.register()
        self.repo.commit_scan(
            source["source_id"],
            **self.scan_payload(
                assets=[{"relative_path": f"{name}.jpg"} for name in ["10", "2", "1", "20", "3"]]
            ),
        )
        root = self.repo.get_root_directory(source["source_id"])
        assert root is not None
        self.assertEqual(
            root["cover_asset_ids"],
            [
                gallery_asset_id(source["source_id"], f"{name}.jpg")
                for name in ["1", "2", "3", "10"]
            ],
        )

    def test_rejects_unsafe_paths_and_states(self) -> None:
        source = self.register()
        with self.assertRaises(ValueError):
            self.repo.commit_scan(
                source["source_id"],
                **self.scan_payload(assets=[{"relative_path": "../escape.jpg"}]),
            )
        with self.assertRaises(ValueError):
            self.repo.commit_scan(
                source["source_id"],
                **self.scan_payload(assets=[{"relative_path": "a.jpg", "txt_state": "approved"}]),
            )
        with self.assertRaises(ValueError):
            self.repo.commit_scan("missing-source", **self.scan_payload())


class GalleryPaginationAndSearchTest(GalleryRepositoryTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.source = self.register()
        self.repo.commit_scan(
            self.source["source_id"],
            **self.scan_payload(
                directories=[("", None), ("b", ""), ("a", "")],
                assets=[
                    {"relative_path": "10.jpg", "txt_content": "hat red"},
                    {"relative_path": "2.jpg", "txt_content": "hat blue"},
                    {"relative_path": "b/1.jpg", "txt_content": "car"},
                    {"relative_path": "a/9.jpg", "txt_state": "missing", "txt_relative_path": "9.txt"},
                    {"relative_path": "a/8.jpg", "txt_state": "blank", "txt_relative_path": "8.txt"},
                ],
            ),
        )
        self.root_id = gallery_directory_id(self.source["source_id"], "")

    def test_pages_assets_and_directories_with_cursors(self) -> None:
        first = self.repo.list_directory_entries(directory_id=self.root_id, limit=1)
        self.assertEqual([d["name"] for d in first["directories"]], ["a"])
        self.assertIsNotNone(first["directory_cursor"])
        self.assertEqual([a["name"] for a in first["assets"]], ["2.jpg"])
        self.assertIsNotNone(first["asset_cursor"])

        second = self.repo.list_directory_entries(
            directory_id=self.root_id,
            directory_cursor=first["directory_cursor"],
            asset_cursor=first["asset_cursor"],
            limit=1,
        )
        self.assertEqual([d["name"] for d in second["directories"]], ["b"])
        self.assertIsNone(second["directory_cursor"])
        self.assertEqual([a["name"] for a in second["assets"]], ["10.jpg"])
        self.assertIsNone(second["asset_cursor"])

    def test_invalid_cursors_and_limits_are_rejected(self) -> None:
        with self.assertRaises(GalleryCursorError):
            self.repo.list_directory_entries(
                directory_id=self.root_id, asset_cursor="not-a-cursor"
            )
        with self.assertRaises(GalleryCursorError):
            self.repo.list_directory_entries(
                directory_id=self.root_id,
                asset_cursor="eyJraW5kIjoiZ2FsbGVyeS1kaXJlY3RvcnkiLCJzb3J0X2tleSI6ImEiLCJuYW1lIjoiYSIsImlkIjoiYSJ9",
            )
        with self.assertRaises(ValueError):
            self.repo.list_directory_entries(directory_id=self.root_id, limit=0)
        with self.assertRaises(ValueError):
            self.repo.list_directory_entries(directory_id=self.root_id, limit=201)
        with self.assertRaises(ValueError):
            self.repo.list_directory_entries(directory_id="missing-directory")

    def test_include_descendants_expands_scope(self) -> None:
        direct = self.repo.list_directory_entries(directory_id=self.root_id)
        self.assertEqual(len(direct["assets"]), 2)
        wide = self.repo.list_directory_entries(
            directory_id=self.root_id, include_descendants=True, limit=200
        )
        self.assertEqual(len(wide["assets"]), 5)

    def test_txt_state_filter(self) -> None:
        entries = self.repo.list_directory_entries(
            directory_id=self.root_id, include_descendants=True, txt_state="missing"
        )
        self.assertEqual([a["name"] for a in entries["assets"]], ["9.jpg"])
        entries = self.repo.list_directory_entries(
            directory_id=self.root_id, include_descendants=True, txt_state="blank"
        )
        self.assertEqual([a["name"] for a in entries["assets"]], ["8.jpg"])

    def test_search_matches_name_path_and_txt_content(self) -> None:
        result = self.repo.search_assets(scope="source", source_id=self.source["source_id"], query="hat")
        self.assertEqual(len(result["assets"]), 2)
        result = self.repo.search_assets(
            scope="source", source_id=self.source["source_id"], query="hat red"
        )
        self.assertEqual([a["name"] for a in result["assets"]], ["10.jpg"])
        result = self.repo.search_assets(scope="gallery", query="car")
        self.assertEqual(len(result["assets"]), 1)
        # 目录范围 + 包含子目录。
        result = self.repo.search_assets(
            scope="directory", directory_id=self.root_id, query="hat", include_descendants=False
        )
        self.assertEqual(len(result["assets"]), 2)
        # 不在 FTS 内的状态（missing/blank）不参与内容搜索。
        result = self.repo.search_assets(scope="gallery", query="8")
        self.assertEqual(len(result["assets"]), 0)

    def test_large_fts_and_recursive_scope_are_paged_inside_sqlite(self) -> None:
        self.repo.commit_scan(
            self.source["source_id"],
            **self.scan_payload(
                directories=[
                    ("", None),
                    *[(f"branch-{index:03d}", "") for index in range(40)],
                ],
                assets=[
                    {
                        "relative_path": (
                            f"branch-{index:03d}/asset-{index:03d}.jpg"
                        ),
                        "txt_relative_path": (
                            f"branch-{index:03d}/asset-{index:03d}.txt"
                        ),
                        "txt_content": "bulk match",
                    }
                    for index in range(40)
                ]
            ),
        )

        reader = self.db._reader()  # noqa: SLF001
        if not hasattr(reader, "setlimit") or not hasattr(
            sqlite3, "SQLITE_LIMIT_VARIABLE_NUMBER"
        ):
            self.skipTest("当前 Python 不支持降低 SQLite 变量上限")
        reader.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 8)
        names: list[str] = []
        cursor: str | None = None
        while True:
            page = self.repo.search_assets(
                scope="directory",
                directory_id=self.root_id,
                include_descendants=True,
                query="bulk",
                cursor=cursor,
                limit=7,
            )
            names.extend(asset["name"] for asset in page["assets"])
            cursor = page["asset_cursor"]
            if cursor is None:
                break

        self.assertEqual(names, [f"asset-{index:03d}.jpg" for index in range(40)])

    def test_search_requires_query_and_valid_scope(self) -> None:
        with self.assertRaises(ValueError):
            self.repo.search_assets(scope="source", source_id=self.source["source_id"], query="  ")
        with self.assertRaises(ValueError):
            self.repo.search_assets(scope="everywhere", query="x")
        with self.assertRaises(ValueError):
            self.repo.search_assets(scope="directory", query="x")


class GalleryPersistenceAcrossReopenTest(unittest.TestCase):
    def test_index_survives_database_reopen(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "gallery.sqlite3")
            db = Database(path)
            source = db.gallery.register_source(
                kind="imported", root_path=os.path.join(tmp, "src"), display_name="来源"
            )
            db.gallery.commit_scan(
                source["source_id"],
                directories=[{"relative_path": "", "name": "", "parent_relative_path": None}],
                assets=[
                    {
                        "relative_path": "a.jpg",
                        "name": "a.jpg",
                        "extension": ".jpg",
                        "size_bytes": 1,
                        "modified_ns": 1,
                        "format": "JPEG",
                        "width": 1,
                        "height": 1,
                        "read_state": "ok",
                        "error_code": "",
                        "txt_relative_path": "a.txt",
                        "txt_size_bytes": 1,
                        "txt_modified_ns": 1,
                        "txt_state": "normal",
                        "txt_content": "hello",
                    }
                ],
            )
            db.close()
            db = Database(path)
            root = db.gallery.get_root_directory(source["source_id"])
            assert root is not None
            self.assertEqual(root["direct_asset_count"], 1)
            found = db.gallery.search_assets(scope="gallery", query="hello")
            self.assertEqual(len(found["assets"]), 1)
            db.close()


if __name__ == "__main__":
    unittest.main()
