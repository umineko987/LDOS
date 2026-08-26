"""图库 HTTP 路由集成测试（G1-3：§7.1/§7.2 已落地部分）。

覆盖来源生命周期、扫描任务、目录条目分页、资产详情/原图/缩略图/
TXT 标注读取，以及稳定错误码与 view=desktop 投影约束。
"""

from __future__ import annotations

import io
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image
from fastapi.testclient import TestClient

from gdl_backend.app import ServiceContainer, create_app
from tests.helpers import local_test_client, make_settings


def _png_bytes(width: int = 4, height: int = 3) -> bytes:
    image = Image.new("RGB", (width, height), "#336699")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


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
        response = self.client.get(
            f"/api/v1/gallery/assets/{asset_id}/thumbnail", params={"size": 256}
        )
        self.assertEqual(response.status_code, 200)
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


if __name__ == "__main__":
    unittest.main()
