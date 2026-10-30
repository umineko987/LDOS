from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path
import unittest

from fastapi.testclient import TestClient

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

    def test_disabled_tagger_rejects_models(self) -> None:
        self.settings.tagger.enabled = False
        response = self.client.get("/api/v1/tagger/models")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "tagger_disabled")

    def test_legacy_direct_caption_routes_are_gone(self) -> None:
        # 打标只走数据集的 tag 阶段（写 caption 经批次和图库索引），不再有直接写 .txt 的旧入口。
        for method, path in (
            ("POST", "/api/v1/tagger/run"),
            ("POST", "/api/v1/tagger/models/prepare"),
            ("GET", "/api/v1/tagger/status"),
        ):
            with self.subTest(path=path):
                response = self.client.request(method, path, json={"models": ["wd-vit-v3"]})
                self.assertIn(response.status_code, (404, 405), response.text)


if __name__ == "__main__":
    unittest.main()
