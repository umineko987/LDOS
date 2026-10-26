from __future__ import annotations

import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch
import unittest

from fastapi.testclient import TestClient
from PIL import Image

from gdl_backend.app import ServiceContainer, create_app
from tests.helpers import local_test_client, make_settings


class TaggerApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.settings = make_settings(self.root)
        self.settings.tagger.model_dir = self.root / "models"
        self.settings.tagger.cache_path = self.root / "tags.sqlite3"
        self.container = ServiceContainer(self.settings)
        self.app = create_app(self.settings, container=self.container, start_background=False)
        context = local_test_client(self.app, self.settings)
        self.client: TestClient = context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)

    def mock_installed_model(self, models: tuple[str, ...] = ("wd-vit-v3",)) -> None:
        catalog = self.container.tagger.model_catalog()
        for entry in catalog:
            entry["installed"] = entry["key"] in models
        patcher = patch.object(self.container.tagger, "model_catalog", return_value=catalog)
        patcher.start()
        self.addCleanup(patcher.stop)

    def gallery_inputs(self, relative_paths: tuple[str, ...] = ("first.png", "nested/second.png")) -> tuple[Path, list[str]]:
        root = self.root / "gallery"
        for relative in relative_paths:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGB", (8, 8), "#336699").save(path)
        source = self.container.gallery_catalog.import_source(str(root))
        self.container.gallery_catalog.scan_source(source["source_id"])
        ids = self.container.db.gallery.get_asset_ids_by_relative_paths(source["source_id"], list(relative_paths))
        self.assertEqual(len(ids), len(relative_paths))
        return root, ids

    def test_models_catalog_shape(self) -> None:
        response = self.client.get("/api/v1/tagger/models")
        self.assertEqual(response.status_code, 200)
        models = response.json()
        self.assertTrue(models, "登记表不应为空")
        keys = {entry["key"] for entry in models}
        self.assertIn("wd-vit-v3", keys)
        for entry in models:
            self.assertIn("installed", entry)
            self.assertIn("gated", entry)
            self.assertIn("default_thresholds", entry)
            self.assertFalse(entry["installed"])  # 临时 model_dir 均未安装

        defaults = {entry["key"]: entry["default_thresholds"] for entry in models}
        self.assertEqual(defaults["wd-vit-v3"], {"general": 0.35, "character": 0.85, "rating": 0.0})
        self.assertEqual(defaults["wd-eva02-2026-canary"], {"general": 0.6094, "character": 0.85, "rating": 0.0})
        self.assertEqual(defaults["cl-tagger-v2"], dict.fromkeys(("general", "character", "copyright", "meta", "rating", "quality"), 0.55))

    def test_status_idle(self) -> None:
        response = self.client.get("/api/v1/tagger/status")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["phase"], "idle")
        self.assertTrue(body["enabled"])

    def test_run_rejects_unknown_model(self) -> None:
        response = self.client.post(
            "/api/v1/tagger/run",
            json={"models": ["no-such-model"], "asset_ids": ["missing"]},
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "unknown_tagger_model")

    def test_run_rejects_uninstalled_model(self) -> None:
        response = self.client.post(
            "/api/v1/tagger/run",
            json={"models": ["wd-vit-v3"], "asset_ids": ["missing"]},
        )
        # 模型未安装的 409 优先于输入路径校验
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "tagger_model_missing")

    def test_cancel_when_idle(self) -> None:
        response = self.client.post("/api/v1/tagger/cancel")
        self.assertEqual(response.status_code, 200)
        self.assertIn("message", response.json())

    def test_packaged_catalog_works_in_isolated_process_with_custom_cli_path(self) -> None:
        workspace = Path(__file__).resolve().parents[2]
        code = f"""
import json, sys
from pathlib import Path
sys.path.insert(0, {str(workspace / 'scripts')!r})
import desktop_release as release
app = Path({str(self.root / 'app')!r})
app.mkdir()
release.copy_backend_sources(app)
lock = json.loads((release.ROOT / 'desktop/release/runtime-lock.json').read_text())
release.copy_application_scripts(app, lock)
sys.path.insert(0, str(app))
from gdl_backend.config import AppSettings, TaggerSettings
from gdl_backend.tagger_service import TaggerService
settings = AppSettings(tagger=TaggerSettings(cli_script=Path('/missing/custom-cli.py'), model_dir=app / 'models'))
catalog = TaggerService(settings).model_catalog()
assert any(model['key'] == 'wd-vit-v3' for model in catalog)
assert all(not model['installed'] for model in catalog)
"""
        subprocess.run([sys.executable, "-I", "-B", "-c", code], cwd=self.root, capture_output=True, text=True, check=True, timeout=10)

    def test_prepare_gated_requires_license(self) -> None:
        response = self.client.post("/api/v1/tagger/models/prepare", json={"models": ["cl-tagger-v2"]})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "tagger_license_required")

    def test_disabled_tagger_rejects_models_prepare_and_run(self) -> None:
        self.settings.tagger.enabled = False
        self.assertEqual(self.client.get("/api/v1/tagger/models").status_code, 409)
        for endpoint in ("models/prepare", "run"):
            response = self.client.post(f"/api/v1/tagger/{endpoint}", json={"models": ["wd-vit-v3"]})
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["error"]["code"], "tagger_disabled")
        self.assertFalse(self.client.get("/api/v1/tagger/status").json()["enabled"])

    def test_run_resolves_and_deduplicates_gallery_image_ids(self) -> None:
        self.mock_installed_model()
        root, ids = self.gallery_inputs()
        with patch.object(self.container.tagger, "tag", new_callable=AsyncMock, return_value={"phase": "tagging"}) as tag:
            response = self.client.post("/api/v1/tagger/run", json={
                "models": ["wd-vit-v3"], "asset_ids": [*ids, ids[0]],
                "thresholds": {"wd-vit-v3": {"general": 0.4, "rating": 0.9}},
                "categories": ["general", "rating", "style"],
            })
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(tag.await_args.args[1], [str(root / "first.png"), str(root / "nested/second.png")])
        self.assertEqual(tag.await_args.kwargs["thresholds"], {"wd-vit-v3": {"general": 0.4, "rating": 0.9}})
        self.assertEqual(tag.await_args.kwargs["categories"], ["general", "rating", "style"])

    def test_run_forwards_independent_model_thresholds(self) -> None:
        self.mock_installed_model(("wd-vit-v3", "pixai-tagger-v1"))
        _, ids = self.gallery_inputs()
        thresholds = {"wd-vit-v3": {"general": 0.4}, "pixai-tagger-v1": {"general": 0.2, "style": 0.15}}
        with patch.object(self.container.tagger, "tag", new_callable=AsyncMock, return_value={"phase": "tagging"}) as tag:
            response = self.client.post("/api/v1/tagger/run", json={
                "models": list(thresholds), "asset_ids": ids, "thresholds": thresholds,
            })
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(tag.await_args.kwargs["thresholds"], thresholds)

    def test_run_rejects_unselected_models_and_unsupported_threshold_categories(self) -> None:
        self.mock_installed_model()
        _, ids = self.gallery_inputs()
        for thresholds in ({"pixai-tagger-v1": {"general": 0.2}}, {"missing": {"general": 0.2}},
                           {"wd-vit-v3": {"style": 0.2}}, {"wd-vit-v3": {"unknown": 0.2}},
                           {"wd-vit-v3": {"general": 1.5}}, {"wd-vit-v3": {"rating": 0}}):
            with self.subTest(thresholds=thresholds), patch.object(self.container.tagger, "tag", new_callable=AsyncMock) as tag:
                response = self.client.post("/api/v1/tagger/run", json={
                    "models": ["wd-vit-v3"], "asset_ids": ids, "thresholds": thresholds,
                })
                self.assertEqual(response.status_code, 422, response.text)
                tag.assert_not_called()

    def test_run_selects_flat_source_root_without_child_directories(self) -> None:
        self.mock_installed_model()
        root, ids = self.gallery_inputs(("first.png", "second.png"))
        repo = self.container.db.gallery
        root_id = repo.get_root_directory(repo.get_asset(ids[0])["source_id"])["directory_id"]
        page = self.client.get(f"/api/v1/gallery/directories/{root_id}/entries")
        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual(page.json()["directory"]["direct_directory_count"], 0)
        self.assertEqual(page.json()["directories"], [])
        self.assertEqual(len(page.json()["assets"]), 2)
        with patch.object(self.container.tagger, "tag", new_callable=AsyncMock, return_value={"phase": "tagging"}) as tag:
            response = self.client.post("/api/v1/tagger/run", json={"models": ["wd-vit-v3"], "directory_ids": [root_id]})
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(tag.await_args.args[1], [str(root / "first.png"), str(root / "second.png")])

    def test_run_expands_complete_directory_and_deduplicates_overlapping_selection(self) -> None:
        self.mock_installed_model()
        root, ids = self.gallery_inputs()
        repo = self.container.db.gallery
        source_id = repo.get_asset(ids[0])["source_id"]
        root_id = repo.get_root_directory(source_id)["directory_id"]
        nested_id = repo.get_asset(ids[1])["directory_id"]
        with patch.object(self.container.tagger, "tag", new_callable=AsyncMock, return_value={"phase": "tagging"}) as tag:
            response = self.client.post("/api/v1/tagger/run", json={
                "models": ["wd-vit-v3"], "asset_ids": [ids[0]], "directory_ids": [root_id, nested_id, root_id],
            })
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(tag.await_args.args[1], [str(root / "first.png"), str(root / "nested/second.png")])

    def test_run_directory_selection_paginates_beyond_200_images(self) -> None:
        self.mock_installed_model()
        root, ids = self.gallery_inputs()
        for index in range(200):
            Image.new("RGB", (8, 8), "#446688").save(root / f"extra-{index:03d}.png")
        repo = self.container.db.gallery
        source_id = repo.get_asset(ids[0])["source_id"]
        self.container.gallery_catalog.scan_source(source_id)
        root_id = repo.get_root_directory(source_id)["directory_id"]
        with patch.object(self.container.tagger, "tag", new_callable=AsyncMock, return_value={"phase": "tagging"}) as tag:
            response = self.client.post("/api/v1/tagger/run", json={"models": ["wd-vit-v3"], "directory_ids": [root_id]})
        self.assertEqual(response.status_code, 202, response.text)
        paths = tag.await_args.args[1]
        self.assertEqual(len(paths), 202)
        self.assertEqual(len(set(paths)), 202)
        self.assertIn(str(root / "nested/second.png"), paths)

    def test_run_rejects_missing_empty_or_symlink_replaced_gallery_directory(self) -> None:
        self.mock_installed_model()
        response = self.client.post("/api/v1/tagger/run", json={"models": ["wd-vit-v3"], "directory_ids": ["missing"]})
        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(response.json()["error"]["code"], "gallery_directory_not_found")
        root, ids = self.gallery_inputs()
        repo = self.container.db.gallery
        source_id = repo.get_asset(ids[0])["source_id"]
        nested_id = repo.get_asset(ids[1])["directory_id"]
        (root / "nested").rename(self.root / "outside-folder")
        (root / "nested").symlink_to(self.root / "outside-folder", target_is_directory=True)
        response = self.client.post("/api/v1/tagger/run", json={"models": ["wd-vit-v3"], "directory_ids": [nested_id]})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["error"]["code"], "invalid_tagger_input")
        empty = self.root / "empty"
        empty.mkdir()
        source = self.container.gallery_catalog.import_source(str(empty))
        self.container.gallery_catalog.scan_source(source["source_id"])
        empty_id = repo.get_root_directory(source["source_id"])["directory_id"]
        response = self.client.post("/api/v1/tagger/run", json={"models": ["wd-vit-v3"], "directory_ids": [empty_id]})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["error"]["code"], "invalid_tagger_input")

    def test_run_rejects_missing_asset_and_symlink_replacement(self) -> None:
        self.mock_installed_model()
        response = self.client.post("/api/v1/tagger/run", json={"models": ["wd-vit-v3"], "asset_ids": ["missing"]})
        self.assertEqual(response.status_code, 404)
        root, ids = self.gallery_inputs()
        image = root / "first.png"
        outside = self.root / "outside.png"
        image.rename(outside)
        image.symlink_to(outside)
        response = self.client.post("/api/v1/tagger/run", json={"models": ["wd-vit-v3"], "asset_ids": [ids[0]]})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "invalid_tagger_input")

    def test_run_rejects_empty_selection_raw_paths_and_invalid_thresholds(self) -> None:
        self.mock_installed_model()
        for extra in ({}, {"inputs": [str(self.root)]},
                      {"asset_ids": ["missing"], "thresholds": {"unknown": 0.3}},
                      {"directory_ids": ["missing"], "thresholds": {"meta": 1.5}}):
            with self.subTest(extra=extra):
                response = self.client.post("/api/v1/tagger/run", json={"models": ["wd-vit-v3"], **extra})
                self.assertEqual(response.status_code, 422, response.text)

    def test_prepare_download_proxy_is_independent_of_mirror_and_license(self) -> None:
        for proxy, expected in ((" http://127.0.0.1:7890/ ", "http://127.0.0.1:7890"),
                                ("https://user:pass@[::1]:8443", "https://user:pass@[::1]:8443"), ("  ", None)):
            with self.subTest(proxy=proxy), patch.object(self.container.tagger, "prepare", new_callable=AsyncMock, return_value={"phase": "preparing"}) as prepare:
                response = self.client.post("/api/v1/tagger/models/prepare", json={
                    "models": ["cl-tagger-v2"], "accept_license": True, "token": "test-token",
                    "proxy_url": "https://mirror.example", "download_proxy": proxy,
                })
                self.assertEqual(response.status_code, 202, response.text)
                prepare.assert_awaited_once_with(["cl-tagger-v2"], "test-token", accept_license=True,
                                               proxy_url="https://mirror.example", download_proxy=expected)

    def test_prepare_rejects_invalid_download_proxy_before_starting(self) -> None:
        for proxy in ("socks5://127.0.0.1:7890", "file:///tmp", "127.0.0.1:7890", "http://localhost",
                      "http://localhost:bad", "http://localhost:99999", "http://localhost:7890/path",
                      "http://localhost:7890?key=value", "http://localhost:7890#fragment", "http://local host:7890"):
            with self.subTest(proxy=proxy), patch.object(self.container.tagger, "prepare", new_callable=AsyncMock) as prepare:
                response = self.client.post("/api/v1/tagger/models/prepare", json={"models": ["wd-vit-v3"], "download_proxy": proxy})
                self.assertEqual(response.status_code, 422, response.text)
                prepare.assert_not_awaited()

    def test_prepare_normalizes_mirror_and_rejects_invalid_urls(self) -> None:
        with patch.object(self.container.tagger, "prepare", new_callable=AsyncMock, return_value={"phase": "preparing"}) as prepare:
            response = self.client.post("/api/v1/tagger/models/prepare", json={"models": ["wd-vit-v3"], "proxy_url": " https://mirror.example/ "})
            self.assertEqual(response.status_code, 202)
            self.assertEqual(prepare.await_args.kwargs["proxy_url"], "https://mirror.example")
        for url in ("file:///tmp", "https://user:password@example.com", "http://example.com:bad", "https://example.com?token=test"):
            with self.subTest(url=url):
                response = self.client.post("/api/v1/tagger/models/prepare", json={"models": ["wd-vit-v3"], "proxy_url": url})
                self.assertEqual(response.status_code, 422)

    def test_missing_cli_returns_503_and_failed_state_not_stuck_running(self) -> None:
        self.mock_installed_model()
        _, ids = self.gallery_inputs()
        self.settings.tagger.cli_script = self.root / "missing-cli.py"
        for endpoint in ("models/prepare", "run"):
            response = self.client.post(f"/api/v1/tagger/{endpoint}", json={"models": ["wd-vit-v3"], **({"asset_ids": ids} if endpoint == "run" else {})})
            self.assertEqual(response.status_code, 503, response.text)
            self.assertEqual(response.json()["error"]["code"], "tagger_start_failed")
            self.assertEqual(self.client.get("/api/v1/tagger/status").json()["phase"], "failed")

    def test_gallery_ids_reach_cli_as_real_paths_and_job_completes(self) -> None:
        self.mock_installed_model()
        root, ids = self.gallery_inputs()
        tagger_root = Path(__file__).resolve().parents[2] / "tagger"
        script = self.root / "fake-cli.py"
        script.write_text(f"""
import json, sys
sys.path.insert(0, {str(tagger_root)!r})
from cli import build_parser
args = build_parser().parse_args()
print(json.dumps({{'type': 'done', 'total': len(args.inputs), 'inputs': args.inputs}}), flush=True)
""", encoding="utf-8")
        self.settings.tagger.cli_script = script
        self.settings.tagger.python_executable = Path(sys.executable)
        repo = self.container.db.gallery
        root_id = repo.get_root_directory(repo.get_asset(ids[0])["source_id"])["directory_id"]
        for selection in ({"asset_ids": ids}, {"directory_ids": [root_id]}):
            with self.subTest(selection=selection):
                response = self.client.post("/api/v1/tagger/run", json={"models": ["wd-vit-v3"], **selection})
                self.assertEqual(response.status_code, 202, response.text)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    status = self.client.get("/api/v1/tagger/status").json()
                    if status["phase"] not in ("tagging", "preparing"):
                        break
                    time.sleep(0.01)
                self.assertEqual(status["phase"], "idle", status)
                self.assertEqual(status["last_result"]["inputs"], [str(root / "first.png"), str(root / "nested/second.png")])
                self.assertEqual(status["last_result"]["total"], 2)


if __name__ == "__main__":
    unittest.main()
