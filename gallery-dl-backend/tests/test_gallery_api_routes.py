"""图库 HTTP 路由集成测试（G1-3：§7.1/§7.2 已落地部分）。

覆盖来源生命周期、扫描任务、目录条目分页、资产详情/原图/缩略图/
TXT 标注读取，以及稳定错误码与 view=desktop 投影约束。
"""

from __future__ import annotations

import io
import re
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image
from fastapi.testclient import TestClient
from fastapi.routing import APIRoute

from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.api_routes.gallery import (
    GalleryAnnotationResponse,
    GalleryAssetEntryResponse,
    GalleryDirectoryEntryResponse,
    GalleryDirectoryExportOperationResponse,
    GalleryDirectoryExportResultResponse,
    GalleryDirectoryPageResponse,
    GalleryFileOperationResponse,
    GalleryPurgeAllTrashResponse,
    GalleryScanOperationResponse,
    GalleryScanStatsResponse,
    GallerySearchPageResponse,
    GallerySourcePageResponse,
    GallerySourceResponse,
    GalleryTrashOperationResponse,
    GalleryTrashPageResponse,
)
from tests.helpers import local_test_client, make_settings


def _png_bytes(width: int = 4, height: int = 3) -> bytes:
    image = Image.new("RGB", (width, height), "#336699")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _included_api_routes(router):
    for route in router.routes:
        if isinstance(route, APIRoute):
            yield route
            continue
        original = getattr(route, "original_router", None)
        if original is not None:
            yield from _included_api_routes(original)


_DESKTOP_GALLERY_MODEL = (
    Path(__file__).resolve().parents[2] / "desktop/src/apps/gallery/model.ts"
)


def _typescript_key_set(name: str) -> set[str]:
    source = _DESKTOP_GALLERY_MODEL.read_text(encoding="utf-8")
    match = re.search(
        rf"const {re.escape(name)} = new Set(?:<[^>]+>)?\(\[(.*?)\]\);",
        source,
        flags=re.DOTALL,
    )
    if match is None:
        raise AssertionError(f"missing desktop Gallery key set: {name}")
    return set(re.findall(r'"([^"]+)"', match.group(1)))


class GalleryApiTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.settings = make_settings(self.root)
        self.container = ServiceContainer(self.settings)
        self.app = create_app(self.settings, container=self.container, start_background=False)
        self.client_context = local_test_client(self.app, self.settings)
        self.client: TestClient = self.client_context.__enter__()
        self.addCleanup(self.client_context.__exit__, None, None, None)

    def make_source_root(self, files: dict[str, bytes | str]) -> Path:
        source_root = self.root / "src-a"
        source_root.mkdir(exist_ok=True)
        for relative, content in files.items():
            target = source_root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, str):
                target.write_text(content, encoding="utf-8")
            else:
                target.write_bytes(content)
        return source_root

    def import_source(self, files: dict[str, bytes | str] | None = None) -> dict:
        source_root = self.make_source_root(files or {})
        response = self.client.post(
            "/api/v1/gallery/imports",
            json={"root_path": str(source_root), "display_name": "图库A"},
        )
        self.assertEqual(response.status_code, 201, response.text)
        source = response.json()
        self.wait_scan_finished(source["source_id"])
        return source

    def wait_scan_finished(self, source_id: str) -> dict:
        for _ in range(300):
            response = self.client.get(
                f"/api/v1/gallery/sources/{source_id}/scan", params={"view": "desktop"}
            )
            self.assertEqual(response.status_code, 200, response.text)
            record = response.json()
            if record["state"] != "running":
                return record
            time.sleep(0.02)
        self.fail("扫描未在限时内完成")


class GallerySourceRoutesTest(GalleryApiTestBase):
    def test_import_scans_and_strips_absolute_paths(self) -> None:
        source = self.import_source({"a.jpg": _png_bytes(), "a.txt": "tag"})
        self.assertNotIn("root_path", source)
        self.assertNotIn("canonical_root_key", source)
        self.assertEqual(source["availability"], "available")

        listing = self.client.get(
            "/api/v1/gallery/sources", params={"view": "desktop"}
        )
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(len(listing.json()["sources"]), 1)
        self.assertNotIn("root_path", listing.json()["sources"][0])
        # 加法扩展（G2-2）：来源投影携带进入首页所需的根目录 ID。
        root_directory_id = listing.json()["sources"][0]["root_directory_id"]
        self.assertIsInstance(root_directory_id, str)
        self.assertTrue(root_directory_id)


        detail = self.client.get(
            f"/api/v1/gallery/sources/{source['source_id']}", params={"view": "desktop"}
        )
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["asset_count"], 1)
        self.assertEqual(detail.json()["root_directory_id"], root_directory_id)

    def test_import_conflict_and_missing_paths(self) -> None:
        missing = self.client.post(
            "/api/v1/gallery/imports", json={"root_path": str(self.root / "nope")}
        )
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["error"]["code"], "source_path_not_found")

        source = self.import_source()
        (self.root / "src-a" / "sub").mkdir()
        conflict = self.client.post(
            "/api/v1/gallery/imports",
            json={"root_path": str(self.root / "src-a" / "sub")},
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["error"]["code"], "source_path_conflict")
        self.assertEqual(conflict.json()["error"]["details"]["relation"], "descendant")

        gone = self.client.get(
            "/api/v1/gallery/sources/missing", params={"view": "desktop"}
        )
        self.assertEqual(gone.status_code, 404)
        self.assertEqual(gone.json()["error"]["code"], "source_not_found")

    def test_patch_relink_delete_and_scan(self) -> None:
        source = self.import_source({"a.jpg": _png_bytes()})
        source_id = source["source_id"]

        patched = self.client.patch(
            f"/api/v1/gallery/sources/{source_id}",
            json={"display_name": "新名字"},
        )
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(patched.json()["display_name"], "新名字")

        started = self.client.post(f"/api/v1/gallery/sources/{source_id}/scan")
        self.assertEqual(started.status_code, 202, started.text)
        self.wait_scan_finished(source_id)

        new_root = self.root / "src-b"
        new_root.mkdir()
        relinked = self.client.post(
            f"/api/v1/gallery/sources/{source_id}/relink",
            json={"root_path": str(new_root)},
        )
        self.assertEqual(relinked.status_code, 200)
        self.assertEqual(relinked.json()["availability"], "available")
        # relink 与 import 一致地自动触发重扫描，等待索引与磁盘一致。
        self.wait_scan_finished(source_id)
        refreshed = self.client.get(
            f"/api/v1/gallery/sources/{source_id}", params={"view": "desktop"}
        )
        self.assertEqual(refreshed.json()["asset_count"], 0)

        gone = self.client.post(
            f"/api/v1/gallery/sources/{source_id}/relink",
            json={"root_path": str(self.root / "nope")},
        )
        self.assertEqual(gone.status_code, 404)
        self.assertEqual(gone.json()["error"]["code"], "source_path_not_found")

        removed = self.client.delete(f"/api/v1/gallery/sources/{source_id}")
        self.assertEqual(removed.status_code, 200)
        self.assertTrue(removed.json()["removed"])
        missing = self.client.delete(f"/api/v1/gallery/sources/{source_id}")
        self.assertEqual(missing.status_code, 404)

    def test_delete_batch_recursively_removes_physical_root(self) -> None:
        batch_root = self.root / "batch-1"
        (batch_root / "eh" / "gallery").mkdir(parents=True)
        (batch_root / "eh" / "gallery" / "image.jpg").write_bytes(_png_bytes())
        (batch_root / "eh" / "gallery" / "image.txt").write_text("tag", encoding="utf-8")
        (batch_root / "other.bin").write_bytes(b"other")
        self.container.db.create_crawl_batch(
            {"id": "batch-1", "output_dir": str(batch_root), "concurrency": 1, "max_tasks": 1},
            [{
                "id": "batch-1-addr",
                "site": "example.com",
                "source_order": 0,
                "address_order": 0,
                "url": "https://example.com/gallery",
                "proxy_mode": "direct",
                "max_attempts": 1,
                "priority": 0,
            }],
        )
        source = self.container.gallery_catalog.register_batch_source(
            batch_id="batch-1",
            root_path=str(batch_root),
            display_name="批次 1",
            dedup_required=False,
        )
        source_id = source["source_id"]

        response = self.client.delete(
            f"/api/v1/gallery/sources/{source_id}",
            params={"delete_files": "true"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["removed"])
        self.assertFalse(batch_root.exists())
        self.assertIsNone(self.container.db.gallery.get_source(source_id))

    def test_source_lifecycle_validates_optional_idempotency_keys(self) -> None:
        source = self.import_source({"a.jpg": _png_bytes()})
        source_id = source["source_id"]
        requests = [
            ("PATCH", f"/api/v1/gallery/sources/{source_id}", {"display_name": "新名字"}),
            ("POST", f"/api/v1/gallery/sources/{source_id}/scan", None),
            (
                "POST",
                f"/api/v1/gallery/sources/{source_id}/relink",
                {"root_path": str(self.root)},
            ),
            ("DELETE", f"/api/v1/gallery/sources/{source_id}", None),
        ]
        for method, path, body in requests:
            with self.subTest(method=method, path=path):
                response = self.client.request(
                    method,
                    path,
                    json=body,
                    headers={"Idempotency-Key": "   "},
                )
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(
                    response.json()["error"]["code"], "invalid_idempotency_key"
                )

    def test_reconciliation_retry_rejects_sources_without_a_retryable_event(self) -> None:
        source = self.import_source({"a.jpg": _png_bytes()})
        response = self.client.post(
            f"/api/v1/gallery/sources/{source['source_id']}/reconciliation/retry"
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(
            response.json()["error"]["code"],
            "gallery_reconciliation_not_retryable",
        )

    def test_view_must_be_desktop(self) -> None:
        # Literal["desktop"] 在校验层拒绝其他取值，走全局 validation_error 封套
        #（与 policies view 处理一致）。
        response = self.client.get("/api/v1/gallery/sources", params={"view": "legacy"})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "validation_error")


class GalleryDirectoryEntriesRoutesTest(GalleryApiTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.source = self.import_source(
            {
                "10.jpg": _png_bytes(),
                "10.txt": "hat red",
                "2.jpg": _png_bytes(),
                "2.txt": "hat blue",
                "sub/1.jpg": _png_bytes(),
                "sub/1.txt": "car",
            }
        )
        root_dir = self.container.db.gallery.get_root_directory(self.source["source_id"])
        assert root_dir is not None
        self.root_id = root_dir["directory_id"]

    def test_entries_with_paging_and_filters(self) -> None:
        first = self.client.get(
            f"/api/v1/gallery/directories/{self.root_id}/entries",
            params={"view": "desktop", "limit": 1},
        )
        self.assertEqual(first.status_code, 200)
        payload = first.json()
        self.assertEqual([d["name"] for d in payload["directories"]], ["sub"])
        self.assertEqual([a["name"] for a in payload["assets"]], ["2.jpg"])
        self.assertIsNotNone(payload["asset_cursor"])

        second = self.client.get(
            f"/api/v1/gallery/directories/{self.root_id}/entries",
            params={"view": "desktop", "limit": 1, "asset_cursor": payload["asset_cursor"]},
        )
        self.assertEqual(
            [a["name"] for a in second.json()["assets"]], ["10.jpg"]
        )
        self.assertIsNone(second.json()["asset_cursor"])

        recursive = self.client.get(
            f"/api/v1/gallery/directories/{self.root_id}/entries",
            params={"view": "desktop", "include_descendants": "true"},
        )
        self.assertEqual(len(recursive.json()["assets"]), 3)

        searched = self.client.get(
            f"/api/v1/gallery/directories/{self.root_id}/entries",
            params={"view": "desktop", "include_descendants": "true", "query": "car"},
        )
        self.assertEqual(
            [a["relative_path"] for a in searched.json()["assets"]], ["sub/1.jpg"]
        )

    def test_entries_error_codes(self) -> None:
        missing = self.client.get("/api/v1/gallery/directories/missing/entries")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["error"]["code"], "directory_not_found")

        bad_cursor = self.client.get(
            f"/api/v1/gallery/directories/{self.root_id}/entries",
            params={"asset_cursor": "garbage"},
        )
        self.assertEqual(bad_cursor.status_code, 422)
        self.assertEqual(bad_cursor.json()["error"]["code"], "invalid_gallery_cursor")

        bad_state = self.client.get(
            f"/api/v1/gallery/directories/{self.root_id}/entries",
            params={"txt_state": "approved"},
        )
        self.assertEqual(bad_state.status_code, 422)
        self.assertEqual(bad_state.json()["error"]["code"], "invalid_txt_state")

    def test_search_scopes_page_across_filename_path_and_txt_content(self) -> None:
        first = self.client.get(
            "/api/v1/gallery/search",
            params={"view": "desktop", "scope": "library", "query": "hat", "limit": 1},
        )
        self.assertEqual(first.status_code, 200, first.text)
        payload = first.json()
        self.assertEqual(payload["scope"], "library")
        self.assertEqual([asset["name"] for asset in payload["assets"]], ["2.jpg"])
        self.assertIsNotNone(payload["asset_cursor"])

        second = self.client.get(
            "/api/v1/gallery/search",
            params={
                "view": "desktop",
                "scope": "library",
                "query": "hat",
                "limit": 1,
                "asset_cursor": payload["asset_cursor"],
            },
        )
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual([asset["name"] for asset in second.json()["assets"]], ["10.jpg"])
        self.assertIsNone(second.json()["asset_cursor"])

        recursive = self.client.get(
            "/api/v1/gallery/search",
            params={
                "view": "desktop",
                "scope": "directory",
                "directory_id": self.root_id,
                "include_descendants": "true",
                "query": "car",
                "txt_state": "normal",
            },
        )
        self.assertEqual(recursive.status_code, 200, recursive.text)
        self.assertEqual(
            [asset["relative_path"] for asset in recursive.json()["assets"]],
            ["sub/1.jpg"],
        )

        source = self.client.get(
            "/api/v1/gallery/search",
            params={
                "view": "desktop",
                "scope": "source",
                "source_id": self.source["source_id"],
                "query": "jpg",
            },
        )
        self.assertEqual(source.status_code, 200, source.text)
        self.assertEqual(len(source.json()["assets"]), 3)

    def test_pages_expose_source_roots_for_asset_protocol(self) -> None:
        source_id = self.source["source_id"]
        expected_root = str((self.root / "src-a").resolve())

        page = self.client.get(
            "/api/v1/gallery/directories/{0}/entries".format(self.root_id),
            params={"view": "desktop"},
        )
        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual(page.json()["source_roots"], {source_id: expected_root})

        search = self.client.get(
            "/api/v1/gallery/search",
            params={"view": "desktop", "scope": "library", "query": "jpg"},
        )
        self.assertEqual(search.status_code, 200, search.text)
        self.assertEqual(search.json()["source_roots"], {source_id: expected_root})

        asset_id = search.json()["assets"][0]["asset_id"]
        detail = self.client.get(
            "/api/v1/gallery/assets/{0}".format(asset_id),
            params={"view": "desktop"},
        )
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["source_roots"], {source_id: expected_root})

    def test_search_rejects_missing_scope_ids_and_invalid_filters(self) -> None:
        cases = [
            ({"scope": "directory", "query": "hat"}, "gallery_search_directory_required"),
            ({"scope": "source", "query": "hat"}, "gallery_search_source_required"),
            ({"scope": "library", "query": "   "}, "gallery_search_query_required"),
            ({"scope": "library", "query": "hat", "txt_state": "approved"}, "invalid_txt_state"),
            ({"scope": "library", "query": "hat", "asset_cursor": "garbage"}, "invalid_gallery_cursor"),
        ]
        for params, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                response = self.client.get("/api/v1/gallery/search", params=params)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(response.json()["error"]["code"], expected_code)


class GalleryAssetRoutesTest(GalleryApiTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.source = self.import_source(
            {
                "pic.jpg": _png_bytes(5, 2),
                "pic.txt": "tag_one",
                "no_txt.jpg": _png_bytes(),
                "broken.jpg": _png_bytes(),
                "broken.txt": b"\xd6\xd0\xce\xc4",
            }
        )
        repo = self.container.db.gallery
        root_dir = repo.get_root_directory(self.source["source_id"])
        assert root_dir is not None
        entries = repo.list_directory_entries(directory_id=root_dir["directory_id"])
        self.assets = {asset["name"]: asset for asset in entries["assets"]}

    def test_asset_detail_and_missing(self) -> None:
        asset_id = self.assets["pic.jpg"]["asset_id"]
        response = self.client.get(
            f"/api/v1/gallery/assets/{asset_id}", params={"view": "desktop"}
        )
        self.assertEqual(response.status_code, 200)
        asset = response.json()["asset"]
        self.assertEqual(asset["width"], 5)
        self.assertEqual(asset["height"], 2)
        self.assertEqual(asset["txt_state"], "normal")
        self.assertNotIn("txt_content", asset)

        missing = self.client.get("/api/v1/gallery/assets/missing")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["error"]["code"], "asset_not_found")

    def test_content_serves_bytes_with_etag(self) -> None:
        asset_id = self.assets["pic.jpg"]["asset_id"]
        response = self.client.get(f"/api/v1/gallery/assets/{asset_id}/content")
        self.assertEqual(response.status_code, 200)
        # 扩展名是声明的格式：.jpg 按声明提供 image/jpeg（内容是测试用 PNG 字节）。
        self.assertEqual(response.headers["content-type"], "image/jpeg")
        self.assertIn("etag", response.headers)
        self.assertEqual(len(response.content), len(_png_bytes(5, 2)))

    def test_thumbnail_generates_and_caches(self) -> None:
        asset_id = self.assets["pic.jpg"]["asset_id"]
        modified_ns = int(self.assets["pic.jpg"]["modified_ns"])
        thumbnails = self.container.gallery_thumbnails
        self.assertIsNone(thumbnails.cached_path(asset_id, modified_ns, 256))
        response = self.client.get(
            f"/api/v1/gallery/assets/{asset_id}/thumbnail", params={"size": 256}
        )
        self.assertEqual(response.status_code, 200)
        cached = thumbnails.cached_path(asset_id, modified_ns, 256)
        self.assertIsNotNone(cached)
        self.assertEqual(cached.read_bytes(), response.content)
        self.assertIsNone(thumbnails.cached_path(asset_id, modified_ns, 512))
        self.assertEqual(response.headers["content-type"], "image/jpeg")
        with Image.open(io.BytesIO(response.content)) as thumb:
            self.assertLessEqual(max(thumb.size), 256)
        etag = response.headers["etag"]
        again = self.client.get(
            f"/api/v1/gallery/assets/{asset_id}/thumbnail",
            params={"size": 256},
            headers={"If-None-Match": etag},
        )
        # TestClient 不处理条件请求；服务端一致性由相同 ETag 体现。
        self.assertEqual(again.headers["etag"], etag)

        bad_size = self.client.get(
            f"/api/v1/gallery/assets/{asset_id}/thumbnail", params={"size": 100}
        )
        self.assertEqual(bad_size.status_code, 422)
        self.assertEqual(bad_size.json()["error"]["code"], "invalid_thumbnail_size")

    def test_annotation_states(self) -> None:
        normal = self.client.get(
            f"/api/v1/gallery/assets/{self.assets['pic.jpg']['asset_id']}/annotation"
        )
        self.assertEqual(normal.json()["txt_state"], "normal")
        self.assertEqual(normal.json()["content"], "tag_one")

        missing = self.client.get(
            f"/api/v1/gallery/assets/{self.assets['no_txt.jpg']['asset_id']}/annotation"
        )
        self.assertEqual(missing.json()["txt_state"], "missing")
        self.assertIsNone(missing.json()["content"])

        invalid = self.client.get(
            f"/api/v1/gallery/assets/{self.assets['broken.jpg']['asset_id']}/annotation"
        )
        self.assertEqual(invalid.json()["txt_state"], "invalid_encoding")
        self.assertIsNone(invalid.json()["content"])

        gone = self.client.get("/api/v1/gallery/assets/missing/annotation")
        self.assertEqual(gone.status_code, 404)
        self.assertEqual(gone.json()["error"]["code"], "asset_not_found")

    def test_content_missing_file(self) -> None:
        asset_id = self.assets["pic.jpg"]["asset_id"]
        (self.root / "src-a" / "pic.jpg").unlink()
        response = self.client.get(f"/api/v1/gallery/assets/{asset_id}/content")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "asset_file_missing")


class GalleryAnnotationPutRoutesTest(GalleryApiTestBase):
    """G3-1：TXT 保存契约——原子写、乐观版本、UTF-8 严格、FTS 同步。"""

    def setUp(self) -> None:
        super().setUp()
        self.source = self.import_source(
            {
                "pic.jpg": _png_bytes(5, 2),
                "pic.txt": "tag_one",
                "no_txt.jpg": _png_bytes(),
            }
        )
        repo = self.container.db.gallery
        root_dir = repo.get_root_directory(self.source["source_id"])
        assert root_dir is not None
        entries = repo.list_directory_entries(directory_id=root_dir["directory_id"])
        self.assets = {asset["name"]: asset for asset in entries["assets"]}

    def _get_annotation(self, name: str) -> dict:
        asset_id = self.assets[name]["asset_id"]
        response = self.client.get(f"/api/v1/gallery/assets/{asset_id}/annotation")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_save_updates_content_and_version(self) -> None:
        annotation = self._get_annotation("pic.jpg")
        response = self.client.put(
            f"/api/v1/gallery/assets/{self.assets['pic.jpg']['asset_id']}/annotation",
            json={
                "content": "updated content",
                "expected_txt_version": annotation["txt_version"],
                "expected_disk_version": annotation["disk_version"],
            },
            headers={"Idempotency-Key": "test-save-1"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["txt_state"], "normal")
        self.assertEqual(result["content"], "updated content")
        self.assertEqual(result["txt_version"], annotation["txt_version"] + 1)

        # 磁盘文件是严格 UTF-8 无 BOM。
        raw = (self.root / "src-a" / "pic.txt").read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertEqual(raw.decode("utf-8"), "updated content")

        # 索引同步：GET annotation 反映新内容与状态。
        fresh = self._get_annotation("pic.jpg")
        self.assertEqual(fresh["content"], "updated content")
        self.assertEqual(fresh["txt_version"], annotation["txt_version"] + 1)

    def test_save_creates_missing_txt(self) -> None:
        annotation = self._get_annotation("no_txt.jpg")
        self.assertEqual(annotation["txt_state"], "missing")
        response = self.client.put(
            f"/api/v1/gallery/assets/{self.assets['no_txt.jpg']['asset_id']}/annotation",
            json={
                "content": "new tags",
                "expected_txt_version": annotation["txt_version"],
                "expected_disk_version": annotation["disk_version"],
            },
            headers={"Idempotency-Key": "test-save-2"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        # 同名规则创建 no_txt.txt。
        self.assertEqual(
            (self.root / "src-a" / "no_txt.txt").read_text(encoding="utf-8"),
            "new tags",
        )
        fresh = self._get_annotation("no_txt.jpg")
        self.assertEqual(fresh["txt_state"], "normal")
        self.assertEqual(fresh["content"], "new tags")

    def test_version_conflict_returns_409(self) -> None:
        annotation = self._get_annotation("pic.jpg")
        response = self.client.put(
            f"/api/v1/gallery/assets/{self.assets['pic.jpg']['asset_id']}/annotation",
            json={
                "content": "stale",
                "expected_txt_version": 999,
                "expected_disk_version": annotation["disk_version"],
            },
            headers={"Idempotency-Key": "test-save-3"},
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["error"]["code"], "txt_version_conflict")
        # 磁盘未被触碰。
        self.assertEqual(
            (self.root / "src-a" / "pic.txt").read_text(encoding="utf-8"), "tag_one"
        )

    def test_missing_asset_404(self) -> None:
        response = self.client.put(
            "/api/v1/gallery/assets/missing/annotation",
            json={
                "content": "x",
                "expected_txt_version": 1,
                "expected_disk_version": "0" * 64,
            },
            headers={"Idempotency-Key": "test-save-4"},
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "asset_not_found")

    def test_search_index_reflects_saved_content(self) -> None:
        annotation = self._get_annotation("pic.jpg")
        self.client.put(
            f"/api/v1/gallery/assets/{self.assets['pic.jpg']['asset_id']}/annotation",
            json={
                "content": "zebra_unique_marker",
                "expected_txt_version": annotation["txt_version"],
                "expected_disk_version": annotation["disk_version"],
            },
            headers={"Idempotency-Key": "test-save-5"},
        )
        root_dir = self.container.db.gallery.get_root_directory(
            self.source["source_id"]
        )
        entries = self.container.db.gallery.list_directory_entries(
            directory_id=root_dir["directory_id"], query="zebra_unique_marker"
        )
        self.assertEqual(len(entries["assets"]), 1)
        self.assertEqual(entries["assets"][0]["name"], "pic.jpg")

    def test_idempotency_key_validated_when_present(self) -> None:
        # 空白 Idempotency-Key 被拒绝（与仓库现有 write-origin 惯例一致：键可选，但提供时必须合法）。
        annotation = self._get_annotation("pic.jpg")
        response = self.client.put(
            f"/api/v1/gallery/assets/{self.assets['pic.jpg']['asset_id']}/annotation",
            json={
                "content": "x",
                "expected_txt_version": annotation["txt_version"],
                "expected_disk_version": annotation["disk_version"],
            },
            headers={"Idempotency-Key": "   "},
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(
            response.json()["error"]["code"], "invalid_idempotency_key"
        )



class GalleryFileOperationRoutesTest(GalleryApiTestBase):
    """G3-2：rename / trash / undo / restore / purge 的 HTTP 层。"""

    def setUp(self) -> None:
        super().setUp()
        self.source = self.import_source(
            {"pic.jpg": _png_bytes(), "pic.txt": "tag_a", "other.jpg": _png_bytes()}
        )
        self.wait_scan_finished(self.source["source_id"])
        self.assets = self._list_assets()


    def _list_assets(self) -> dict:
        root_dir = self.container.db.gallery.get_root_directory(
            self.source["source_id"]
        )
        response = self.client.get(
            "/api/v1/gallery/directories/"
            f"{root_dir['directory_id']}/entries?view=desktop&limit=100",
        )
        return {a["name"]: a for a in response.json()["assets"]}

    def _assert_file_operation_projection(
        self, value: dict[str, object]
    ) -> None:
        self.assertEqual(
            set(value),
            {
                "operation_id",
                "kind",
                "status",
                "item_count",
                "has_txt_count",
            },
        )

    def test_gallery_json_routes_use_bounded_response_models(self) -> None:
        source_keys = {
            "source_id", "root_directory_id", "kind", "batch_id",
            "display_name", "availability", "asset_count", "candidate_count",
            "kept_count", "removed_count", "crawl_complete", "dedup_required",
            "dedup_state", "content_version", "dedup_applied_version",
            "reconciliation_state", "reconciliation_error_code",
            "reconciliation_attempt_count", "reconciliation_updated_at",
            "annotation_version", "indexed_version", "last_scanned_at",
            "created_at", "updated_at",
        }
        scan_keys = {
            "operation_id", "source_id", "state", "started_at", "finished_at",
            "error_code", "stats",
        }
        operation_keys = {
            "operation_id", "kind", "status", "item_count", "has_txt_count",
        }
        export_keys = {
            "operation_id", "state", "current_directory_name",
            "directory_count", "completed_directory_count",
            "failed_directory_count", "discovered_file_count",
            "copied_file_count", "discovered_byte_count", "copied_byte_count",
            "error_code", "successful_directory_names", "results",
        }
        expected = {
            ("GET", "/api/v1/gallery/sources"): {"sources"},
            ("GET", "/api/v1/gallery/sources/{source_id}"): source_keys,
            ("POST", "/api/v1/gallery/imports"): source_keys,
            ("PATCH", "/api/v1/gallery/sources/{source_id}"): source_keys,
            ("DELETE", "/api/v1/gallery/sources/{source_id}"): {
                "source_id", "removed",
            },
            ("POST", "/api/v1/gallery/sources/{source_id}/relink"): source_keys,
            ("POST", "/api/v1/gallery/sources/{source_id}/scan"): scan_keys,
            ("GET", "/api/v1/gallery/sources/{source_id}/scan"): scan_keys,
            (
                "POST",
                "/api/v1/gallery/sources/{source_id}/reconciliation/retry",
            ): source_keys,
            ("GET", "/api/v1/gallery/directories/{directory_id}/entries"): {
                "directory", "directories", "assets", "directory_cursor",
                "asset_cursor", "include_descendants", "limit", "source_roots",
            },
            ("GET", "/api/v1/gallery/search"): {
                "scope", "assets", "asset_cursor", "limit", "source_roots",
            },
            ("GET", "/api/v1/gallery/assets/{asset_id}"): {"asset", "source_roots"},
            ("GET", "/api/v1/gallery/assets/{asset_id}/annotation"): {
                "asset_id", "content", "txt_state", "txt_version",
                "disk_version",
            },
            ("PUT", "/api/v1/gallery/assets/{asset_id}/annotation"): {
                "asset_id", "content", "txt_state", "txt_version",
                "disk_version",
            },
            ("POST", "/api/v1/gallery/assets/{asset_id}/rename"): operation_keys,
            ("POST", "/api/v1/gallery/file-operations/trash"): operation_keys,
            ("POST", "/api/v1/gallery/file-operations/{kind}"): operation_keys,
            ("POST", "/api/v1/gallery/file-operations/{operation_id}/undo"): operation_keys,
            ("POST", "/api/v1/gallery/trash/{operation_id}/restore"): operation_keys,
            ("DELETE", "/api/v1/gallery/trash/{operation_id}"): operation_keys,
            ("GET", "/api/v1/gallery/trash"): {"operations", "next_cursor"},
            ("DELETE", "/api/v1/gallery/trash"): {
                "purged_operations", "purged_items",
            },
            ("POST", "/api/v1/gallery/directory-exports"): export_keys,
            ("GET", "/api/v1/gallery/directory-exports/{operation_id}"): export_keys,
            ("DELETE", "/api/v1/gallery/directory-exports/{operation_id}"): export_keys,
        }
        routes = {
            (method, route.path): route
            for route in _included_api_routes(self.app.router)
            for method in route.methods
            if route.path.startswith("/api/v1/gallery")
            and not route.path.endswith("/content")
            and not route.path.endswith("/thumbnail")
        }
        self.assertEqual(set(routes), set(expected))
        for key, expected_keys in expected.items():
            with self.subTest(method=key[0], path=key[1]):
                response_model = routes[key].response_model
                self.assertIsNotNone(response_model)
                self.assertEqual(set(response_model.model_fields), expected_keys)

    def test_backend_models_match_desktop_strict_key_contracts(self) -> None:
        contracts = {
            "SOURCE_SUMMARY_KEYS": GallerySourceResponse,
            "SCAN_OPERATION_KEYS": GalleryScanOperationResponse,
            "SCAN_STATS_KEYS": GalleryScanStatsResponse,
            "DIRECTORY_ENTRY_KEYS": GalleryDirectoryEntryResponse,
            "ASSET_ENTRY_KEYS": GalleryAssetEntryResponse,
            "SOURCE_PAGE_KEYS": GallerySourcePageResponse,
            "DIRECTORY_PAGE_KEYS": GalleryDirectoryPageResponse,
            "SEARCH_PAGE_KEYS": GallerySearchPageResponse,
            "ANNOTATION_KEYS": GalleryAnnotationResponse,
            "DIRECTORY_EXPORT_OPERATION_KEYS": (
                GalleryDirectoryExportOperationResponse
            ),
            "DIRECTORY_EXPORT_RESULT_KEYS": GalleryDirectoryExportResultResponse,
            "FILE_OPERATION_RESULT_KEYS": GalleryFileOperationResponse,
            "PURGE_ALL_TRASH_RESULT_KEYS": GalleryPurgeAllTrashResponse,
            "TRASH_OPERATION_KEYS": GalleryTrashOperationResponse,
            "TRASH_PAGE_KEYS": GalleryTrashPageResponse,
        }
        for key_set_name, response_model in contracts.items():
            with self.subTest(key_set=key_set_name):
                self.assertEqual(
                    set(response_model.model_fields),
                    _typescript_key_set(key_set_name),
                )

    def test_rename_route(self) -> None:
        asset_id = self.assets["pic.jpg"]["asset_id"]
        response = self.client.post(
            f"/api/v1/gallery/assets/{asset_id}/rename",
            json={"new_stem": "renamed"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self._assert_file_operation_projection(body)
        self.assertEqual(body["status"], "committed")
        self.assertTrue(
            (self.root / "src-a" / "renamed.jpg").exists(),
        )

    def test_rename_conflict_409(self) -> None:
        asset_id = self.assets["pic.jpg"]["asset_id"]
        response = self.client.post(
            f"/api/v1/gallery/assets/{asset_id}/rename",
            json={"new_stem": "other"},
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json()["error"]["code"], "rename_target_conflict"
        )

    def test_trash_undo_flow(self) -> None:
        asset_id = self.assets["pic.jpg"]["asset_id"]
        response = self.client.post(
            "/api/v1/gallery/file-operations/trash",
            json={"asset_ids": [asset_id]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        operation = response.json()
        self._assert_file_operation_projection(operation)
        self.assertEqual(operation["status"], "committed")
        self.assertFalse((self.root / "src-a" / "pic.jpg").exists())
        repeated = self.client.post(
            "/api/v1/gallery/file-operations/trash",
            json={"asset_ids": [asset_id]},
        )
        self.assertEqual(repeated.status_code, 409, repeated.text)
        self.assertEqual(
            repeated.json()["error"]["code"], "asset_not_active"
        )
        # 撤销。
        undo = self.client.post(
            f"/api/v1/gallery/file-operations/{operation['operation_id']}/undo"
        )
        self.assertEqual(undo.status_code, 200, undo.text)
        self._assert_file_operation_projection(undo.json())
        self.assertTrue((self.root / "src-a" / "pic.jpg").exists())
        listing = self.client.get("/api/v1/gallery/trash?view=desktop")
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertEqual(listing.json()["operations"], [])


    def test_directory_trash_moves_unindexed_children_and_undoes(self) -> None:
        directory_path = self.root / "src-a" / "whole"
        (directory_path / "indexed.jpg").parent.mkdir(parents=True)
        (directory_path / "indexed.jpg").write_bytes(_png_bytes())
        (directory_path / "unindexed.bin").write_bytes(b"kept with directory")
        started = self.client.post(
            f"/api/v1/gallery/sources/{self.source['source_id']}/scan"
        )
        self.assertEqual(started.status_code, 202, started.text)
        self.wait_scan_finished(self.source["source_id"])

        root_directory = self.container.db.gallery.get_root_directory(
            self.source["source_id"]
        )
        assert root_directory is not None
        entries = self.client.get(
            f"/api/v1/gallery/directories/{root_directory['directory_id']}/entries",
            params={"view": "desktop", "limit": 100},
        )
        self.assertEqual(entries.status_code, 200, entries.text)
        directory = next(item for item in entries.json()["directories"] if item["name"] == "whole")

        response = self.client.post(
            "/api/v1/gallery/file-operations/trash",
            json={"asset_ids": [], "directory_ids": [directory["directory_id"]]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        operation = response.json()
        self._assert_file_operation_projection(operation)
        self.assertFalse(directory_path.exists())
        self.assertTrue(
            (self.root / "src-a" / ".ldos" / "trash" / operation["operation_id"] / "files" / "whole" / "unindexed.bin").exists()
        )

        undo = self.client.post(
            f"/api/v1/gallery/file-operations/{operation['operation_id']}/undo"
        )
        self.assertEqual(undo.status_code, 200, undo.text)
        self.assertTrue((directory_path / "unindexed.bin").exists())
    def test_trash_list_and_purge(self) -> None:
        asset_id = self.assets["pic.jpg"]["asset_id"]
        response = self.client.post(
            "/api/v1/gallery/file-operations/trash",
            json={"asset_ids": [asset_id]},
        )
        operation = response.json()
        listing = self.client.get("/api/v1/gallery/trash?view=desktop")
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertEqual(len(listing.json()["operations"]), 1)
        trash_item = listing.json()["operations"][0]
        self.assertEqual(
            set(trash_item),
            {
                "operation_id",
                "created_at",
                "item_count",
                "has_txt_count",
                "item_error_count",
                "disk_usage_bytes",
            },
        )
        self.assertGreaterEqual(trash_item["created_at"], 1_000_000_000_000)
        self.assertEqual(trash_item["item_count"], 1)
        self.assertEqual(trash_item["has_txt_count"], 1)
        self.assertEqual(trash_item["item_error_count"], 0)
        self.assertEqual(
            trash_item["disk_usage_bytes"], len(_png_bytes()) + len(b"tag_a")
        )
        purge = self.client.delete(
            f"/api/v1/gallery/trash/{operation['operation_id']}"
        )
        self.assertEqual(purge.status_code, 200, purge.text)
        self._assert_file_operation_projection(purge.json())
        self.assertIsNone(
            self.container.db.gallery.get_asset(asset_id)
        )
        after_purge = self.client.get("/api/v1/gallery/trash?view=desktop")
        self.assertEqual(after_purge.status_code, 200, after_purge.text)
        self.assertEqual(after_purge.json()["operations"], [])

    def test_trash_list_reports_missing_managed_files(self) -> None:
        asset_id = self.assets["pic.jpg"]["asset_id"]
        trashed = self.client.post(
            "/api/v1/gallery/file-operations/trash",
            json={"asset_ids": [asset_id]},
        ).json()
        trash_image = (
            self.root
            / "src-a"
            / ".ldos"
            / "trash"
            / trashed["operation_id"]
            / "files"
            / "pic.jpg"
        )
        trash_image.unlink()

        listing = self.client.get("/api/v1/gallery/trash?view=desktop")
        self.assertEqual(listing.status_code, 200, listing.text)
        trash_item = listing.json()["operations"][0]
        self.assertEqual(trash_item["item_error_count"], 1)
        self.assertEqual(trash_item["disk_usage_bytes"], len(b"tag_a"))

    def test_purge_all_projection(self) -> None:
        asset_id = self.assets["pic.jpg"]["asset_id"]
        trashed = self.client.post(
            "/api/v1/gallery/file-operations/trash",
            json={"asset_ids": [asset_id]},
        )
        self.assertEqual(trashed.status_code, 200, trashed.text)
        purged = self.client.delete("/api/v1/gallery/trash")
        self.assertEqual(purged.status_code, 200, purged.text)
        self.assertEqual(
            purged.json(),
            {"purged_operations": 1, "purged_items": 1},
        )
        repeated = self.client.delete("/api/v1/gallery/trash")
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertEqual(
            repeated.json(),
            {"purged_operations": 0, "purged_items": 0},
        )

    def test_restore_conflict_409(self) -> None:
        asset_id = self.assets["pic.jpg"]["asset_id"]
        response = self.client.post(
            "/api/v1/gallery/file-operations/trash",
            json={"asset_ids": [asset_id]},
        )
        operation = response.json()
        # 原路径被占用。
        (self.root / "src-a" / "pic.jpg").write_bytes(_png_bytes())
        restore = self.client.post(
            f"/api/v1/gallery/trash/{operation['operation_id']}/restore"
        )
        self.assertEqual(restore.status_code, 409)
        self.assertEqual(
            restore.json()["error"]["code"], "restore_target_conflict"
        )

    def test_missing_operation_404(self) -> None:
        response = self.client.post(
            "/api/v1/gallery/trash/nonexistent/restore"
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(
            response.json()["error"]["code"], "operation_not_found"
        )


if __name__ == "__main__":
    unittest.main()
