from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from gdl_backend.app import ServiceContainer, create_app
from tests.helpers import make_settings
from tests.stage5_preview_harness import FIXTURE_ROOT, WEBUI_ROOT, build_harness


class Stage5PreviewHarnessTests(unittest.TestCase):
    def test_tests_only_host_and_production_ui_are_separate(self):
        self.assertTrue((FIXTURE_ROOT / "stage5-preview-host.html").is_file())
        self.assertTrue((FIXTURE_ROOT / "stage5-preview-host.js").is_file())
        self.assertTrue((FIXTURE_ROOT / "stage5-preview-fixtures.js").is_file())
        self.assertTrue((WEBUI_ROOT / "index.html").is_file())

        with TemporaryDirectory(prefix="imageweave-stage5-harness-test-") as temporary:
            app = build_harness(Path(temporary), 18855)
            with TestClient(app, client=("127.0.0.1", 50000)) as client:
                headers = {"host": "127.0.0.1:18855"}
                production = client.get("/ui/", headers=headers)
                fixture = client.get("/__stage5__/stage5-preview-host.html", headers=headers)
                fixture_module = client.get("/__stage5__/stage5-preview-fixtures.js", headers=headers)
                fixture_host = client.get("/__stage5__/stage5-preview-host.js", headers=headers)
                production_controller = client.get("/__webui__/js/apps/gallery.js", headers=headers)
                export_controller = client.get("/__webui__/js/apps/export.js", headers=headers)
                export_view = client.get("/__webui__/js/components/export-view.js", headers=headers)
                export_styles = client.get("/__webui__/styles/apps/export.css", headers=headers)
                production_fixture_probe = client.get("/ui/stage5-preview-host.js", headers=headers)

        self.assertEqual(production.status_code, 200)
        self.assertNotIn("tests-only fixture host", production.text)
        self.assertEqual(fixture.status_code, 200)
        self.assertIn("tests-only fixture host", fixture.text)
        self.assertEqual(fixture_module.status_code, 200)
        self.assertIn("TESTS_ONLY_STAGE5 = true", fixture_module.text)
        self.assertEqual(fixture_host.status_code, 200)
        self.assertIn("createGalleryMediaFixture", fixture_host.text)
        self.assertIn("URL.createObjectURL(blob)", fixture_host.text)
        self.assertIn("balancedObjectUrls", fixture_host.text)
        self.assertEqual(production_controller.status_code, 200)
        self.assertIn("createGalleryController", production_controller.text)
        self.assertNotIn("stage5-preview-fixtures", production_controller.text)
        self.assertNotIn("createGalleryMediaFixture", production_controller.text)
        self.assertEqual(export_controller.status_code, 200)
        self.assertIn("createExportController", export_controller.text)
        self.assertIn("createExportUnavailableAdapter()", export_controller.text)
        self.assertNotIn("context.api", export_controller.text)
        self.assertNotIn("stage5-preview-fixtures", export_controller.text)
        self.assertNotRegex(export_controller.text, r"setTimeout|setInterval")
        self.assertEqual(export_view.status_code, 200)
        self.assertIn('"aria-valuetext": valueText', export_view.text)
        self.assertIn("不会写入文件、读取路径或发送业务请求", export_view.text)
        self.assertNotIn("夹具", export_view.text)
        self.assertEqual(export_styles.status_code, 200)
        self.assertIn("--imageweave-glass-surface-secondary", export_styles.text)
        self.assertNotIn("--imageweave-surface-content-solid", export_styles.text)
        self.assertEqual(production_fixture_probe.status_code, 404)

    def test_formal_create_app_has_no_stage5_fixture_mount(self):
        with TemporaryDirectory(prefix="imageweave-stage5-production-test-") as temporary:
            settings = make_settings(Path(temporary))
            settings.server.port = 18856
            app = create_app(
                settings,
                container=ServiceContainer(settings),
                start_background=False,
            )
            with TestClient(app, client=("127.0.0.1", 50001)) as client:
                headers = {"host": "127.0.0.1:18856"}
                production = client.get("/ui/", headers=headers)
                fixture = client.get(
                    "/__stage5__/stage5-preview-host.html", headers=headers
                )
                fixture_module = client.get(
                    "/__stage5__/stage5-preview-fixtures.js", headers=headers
                )

        self.assertEqual(production.status_code, 200)
        self.assertNotIn("data-stage5-tests-only", production.text)
        self.assertNotIn("stage5-preview-fixtures", production.text)
        self.assertEqual(fixture.status_code, 404)
        self.assertEqual(fixture_module.status_code, 404)


if __name__ == "__main__":
    unittest.main()
