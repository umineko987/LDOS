"""Retirement contract for the obsolete persistent dataset-export runtime.

The historical schema and implementation modules remain readable for migration
compatibility, but the application container and public API must not register or
start that workflow.  Active copy behavior is covered by
``test_gallery_directory_export*.py``.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from gdl_backend.app import ServiceContainer, create_app
from tests.helpers import local_test_client, make_settings


class LegacyDatasetExportRuntimeRetirementTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temp.name))
        self.container = ServiceContainer(self.settings)
        self.app = create_app(
            self.settings,
            container=self.container,
            start_background=False,
        )
        self.client_context = local_test_client(self.app, self.settings)
        self.client_context.__enter__()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.temp.cleanup()

    def test_obsolete_runtime_and_routes_are_not_registered(self) -> None:
        self.assertFalse(hasattr(self.container, "dataset_export_manager"))
        self.assertTrue(hasattr(self.container, "gallery_directory_exports"))
        legacy_paths = sorted(
            path
            for path in self.app.openapi()["paths"]
            if path.startswith("/api/v1/dataset-exports")
        )
        self.assertEqual(legacy_paths, [])


if __name__ == "__main__":
    unittest.main()
