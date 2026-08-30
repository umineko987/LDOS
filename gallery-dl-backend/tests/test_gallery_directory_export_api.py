"""FastAPI contract for Gallery-owned short-lived directory exports."""

from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any

from gdl_backend.app import ServiceContainer, create_app
from tests.helpers import local_test_client, make_settings


class GalleryDirectoryExportApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.settings = make_settings(self.root)
        self.container = ServiceContainer(self.settings)
        self.app = create_app(
            self.settings,
            container=self.container,
            start_background=False,
        )
        self.client_context = local_test_client(self.app, self.settings)
        self.client = self.client_context.__enter__()

        self.source_root = self.root / "sources" / "alpha"
        self.source_root.mkdir(parents=True)
        (self.source_root / "one.jpg").write_bytes(b"image")
        (self.source_root / "orphan.txt").write_bytes(b"\xffraw")
        (self.source_root / "video.mp4").write_bytes(b"video")
        source = self.container.gallery_catalog.import_source(str(self.source_root))
        self.container.gallery_catalog.scan_source(source["source_id"])
        directory = self.container.db.gallery.get_root_directory(source["source_id"])
        assert directory is not None
        self.directory_id = str(directory["directory_id"])
        self.target = self.root / "target"
        self.target.mkdir()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.temp.cleanup()

    def _wait(self, operation_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            response = self.client.get(
                f"/api/v1/gallery/directory-exports/{operation_id}",
                params={"view": "desktop"},
            )
            self.assertEqual(response.status_code, 200, response.text)
            record = response.json()
            if record["state"] != "copying":
                return record
            time.sleep(0.01)
        self.fail("directory export API did not reach a terminal state")

    def _legacy_row_counts(self) -> dict[str, int]:
        with self.container.db.gallery._read() as connection:  # noqa: SLF001
            tables = [
                row["name"]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table' AND name LIKE 'dataset_export_%'"
                ).fetchall()
            ]
            return {
                table: int(
                    connection.execute(
                        f'SELECT COUNT(*) AS total FROM "{table}"'
                    ).fetchone()["total"]
                )
                for table in tables
            }

    def test_start_route_is_protected_by_the_write_origin_guard(self) -> None:
        response = self.client.post(
            "/api/v1/gallery/directory-exports",
            json={
                "directory_ids": [self.directory_id],
                "target_path": str(self.target),
            },
            headers={
                "Origin": "https://attacker.invalid",
                "Sec-Fetch-Site": "cross-site",
            },
        )
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(response.json()["error"]["code"], "forbidden_cross_site")
        self.assertEqual(list(self.target.iterdir()), [])

    def test_post_get_copy_projection_and_legacy_persistence_boundary(self) -> None:
        before = self._legacy_row_counts()
        response = self.client.post(
            "/api/v1/gallery/directory-exports",
            json={
                "directory_ids": [self.directory_id],
                "target_path": str(self.target),
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        operation_id = response.json()["operation_id"]
        missing_view = self.client.get(
            f"/api/v1/gallery/directory-exports/{operation_id}"
        )
        self.assertEqual(missing_view.status_code, 422, missing_view.text)
        record = self._wait(operation_id)
        self.assertEqual(record["state"], "completed")
        self.assertEqual(record["copied_file_count"], 2)
        self.assertEqual(record["successful_directory_names"], ["alpha"])
        self.assertEqual(self._legacy_row_counts(), before)

        output = self.target / "alpha"
        self.assertEqual((output / "one.jpg").read_bytes(), b"image")
        self.assertEqual((output / "orphan.txt").read_bytes(), b"\xffraw")
        self.assertFalse((output / "video.mp4").exists())

        serialized = json.dumps(record, ensure_ascii=False)
        self.assertNotIn(str(self.source_root), serialized)
        self.assertNotIn(str(self.target), serialized)
        self.assertNotIn("target_path", record)
        self.assertNotIn("source_root", record)

    def test_top_level_conflict_is_bounded_and_copies_nothing(self) -> None:
        (self.target / "alpha").mkdir()
        response = self.client.post(
            "/api/v1/gallery/directory-exports",
            json={
                "directory_ids": [self.directory_id],
                "target_path": str(self.target),
            },
        )
        self.assertEqual(response.status_code, 409, response.text)
        error = response.json()["error"]
        self.assertEqual(error["code"], "target_name_conflict")
        self.assertEqual(error["details"], {"names": ["alpha"]})
        self.assertNotIn(str(self.target), json.dumps(error))
        self.assertEqual(list((self.target / "alpha").iterdir()), [])
        self.assertFalse(
            any(path.name.startswith(".ldos-copy-") for path in self.target.iterdir())
        )

    def test_idempotency_key_is_optional_validated_and_process_local(self) -> None:
        payload = {
            "directory_ids": [self.directory_id],
            "target_path": str(self.target),
        }
        first = self.client.post(
            "/api/v1/gallery/directory-exports",
            json=payload,
            headers={"Idempotency-Key": "gallery-copy-one"},
        )
        self.assertEqual(first.status_code, 202, first.text)
        repeated = self.client.post(
            "/api/v1/gallery/directory-exports",
            json=payload,
            headers={"Idempotency-Key": "gallery-copy-one"},
        )
        self.assertEqual(repeated.status_code, 202, repeated.text)
        self.assertEqual(
            repeated.json()["operation_id"], first.json()["operation_id"]
        )

        invalid = self.client.post(
            "/api/v1/gallery/directory-exports",
            json=payload,
            headers={"Idempotency-Key": "x" * 201},
        )
        self.assertEqual(invalid.status_code, 422, invalid.text)
        self.assertEqual(invalid.json()["error"]["code"], "invalid_idempotency_key")
        invalid_delete = self.client.delete(
            f"/api/v1/gallery/directory-exports/{first.json()['operation_id']}",
            headers={"Idempotency-Key": "x" * 201},
        )
        self.assertEqual(invalid_delete.status_code, 422, invalid_delete.text)
        self.assertEqual(
            invalid_delete.json()["error"]["code"], "invalid_idempotency_key"
        )
        self._wait(first.json()["operation_id"])

    def test_delete_requests_cancellation_and_removes_partial_output(self) -> None:
        (self.source_root / "large.webp").write_bytes(b"x" * (1024 * 256))
        self.container.gallery_catalog.scan_source(
            self.container.db.gallery.get_directory(self.directory_id)["source_id"]
        )
        entered = threading.Event()
        release = threading.Event()

        def pause_copy(_operation_id: str, relative: str, _copied: int) -> None:
            if relative == "large.webp" and not entered.is_set():
                entered.set()
                release.wait(timeout=5.0)

        service = self.container.gallery_directory_exports
        service._copy_chunk_size = 1024  # noqa: SLF001
        service._copy_chunk_hook = pause_copy  # noqa: SLF001
        started = self.client.post(
            "/api/v1/gallery/directory-exports",
            json={
                "directory_ids": [self.directory_id],
                "target_path": str(self.target),
            },
        )
        self.assertEqual(started.status_code, 202, started.text)
        self.assertTrue(entered.wait(timeout=5.0))
        operation_id = started.json()["operation_id"]
        try:
            cancelled = self.client.delete(
                f"/api/v1/gallery/directory-exports/{operation_id}"
            )
            self.assertEqual(cancelled.status_code, 200, cancelled.text)
        finally:
            release.set()
        record = self._wait(operation_id)
        self.assertEqual(record["state"], "cancelled")
        self.assertFalse((self.target / "alpha").exists())
        self.assertFalse(
            any(path.name.startswith(".ldos-copy-") for path in self.target.iterdir())
        )

    def test_target_inside_selected_directory_is_rejected(self) -> None:
        nested_target = self.source_root / "nested-target"
        nested_target.mkdir()
        response = self.client.post(
            "/api/v1/gallery/directory-exports",
            json={
                "directory_ids": [self.directory_id],
                "target_path": str(nested_target),
            },
        )
        self.assertEqual(response.status_code, 409, response.text)
        error = response.json()["error"]
        self.assertEqual(error["code"], "target_inside_source")
        self.assertEqual(error["details"], {"directory_name": "alpha"})


if __name__ == "__main__":
    unittest.main()
