from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

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
                production_controller = client.get("/__webui__/js/apps/gallery.js", headers=headers)

        self.assertEqual(production.status_code, 200)
        self.assertNotIn("tests-only fixture host", production.text)
        self.assertEqual(fixture.status_code, 200)
        self.assertIn("tests-only fixture host", fixture.text)
        self.assertEqual(fixture_module.status_code, 200)
        self.assertIn("TESTS_ONLY_STAGE5 = true", fixture_module.text)
        self.assertEqual(production_controller.status_code, 200)
        self.assertIn("createGalleryController", production_controller.text)
        self.assertNotIn("stage5-preview-fixtures", production_controller.text)


if __name__ == "__main__":
    unittest.main()
