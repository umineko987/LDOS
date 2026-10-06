from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from gdl_backend.app import create_app
from tests.helpers import local_test_client, make_settings


class TaggerApiTests(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile
        from pathlib import Path

        self._tmp = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self._tmp.name))
        self.app = create_app(self.settings)
        self.client: TestClient = local_test_client(self.app, self.settings)

    def tearDown(self) -> None:
        self._tmp.cleanup()

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

    def test_status_idle(self) -> None:
        response = self.client.get("/api/v1/tagger/status")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["phase"], "idle")
        self.assertTrue(body["enabled"])

    def test_run_rejects_unknown_model(self) -> None:
        response = self.client.post(
            "/api/v1/tagger/run",
            json={"models": ["no-such-model"], "inputs": ["/tmp"]},
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "unknown_tagger_model")

    def test_run_rejects_uninstalled_model(self) -> None:
        response = self.client.post(
            "/api/v1/tagger/run",
            json={"models": ["wd-vit-v3"], "inputs": ["/definitely/not/here"]},
        )
        # 模型未安装的 409 优先于输入路径校验
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "tagger_model_missing")

    def test_cancel_when_idle(self) -> None:
        response = self.client.post("/api/v1/tagger/cancel")
        self.assertEqual(response.status_code, 200)
        self.assertIn("message", response.json())


if __name__ == "__main__":
    unittest.main()

    def test_prepare_gated_requires_license(self) -> None:
        response = self.client.post(
            "/api/v1/tagger/models/prepare",
            json={"models": ["cl-tagger-v2"]},
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "tagger_license_required")
