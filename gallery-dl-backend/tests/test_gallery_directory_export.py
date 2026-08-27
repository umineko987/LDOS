"""R0 red-first contract for Gallery-embedded simple directory export."""

from __future__ import annotations

import importlib
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

from gdl_backend.app import ServiceContainer
from tests.helpers import make_settings


try:
    directory_export: ModuleType | None = importlib.import_module(
        "gdl_backend.gallery_directory_export"
    )
except ModuleNotFoundError:
    directory_export = None


class GalleryDirectoryExportContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.container = ServiceContainer(make_settings(self.root))
        self.managers: list[Any] = []

    def tearDown(self) -> None:
        for manager in self.managers:
            manager.stop()
        self.container.gallery_catalog.stop()
        self.container.db.close()
        self.temp.cleanup()

    def _module(self) -> ModuleType:
        self.assertIsNotNone(
            directory_export,
            "R0 contract: gdl_backend.gallery_directory_export must exist",
        )
        assert directory_export is not None
        return directory_export

    def _manager(self, **kwargs: Any) -> Any:
        module = self._module()
        manager_type = getattr(module, "GalleryDirectoryExportService", None)
        self.assertTrue(
            callable(manager_type),
            "R0 contract: GalleryDirectoryExportService must be exported",
        )
        manager = manager_type(self.container.db.gallery, **kwargs)
        self.managers.append(manager)
        return manager

    def _source(
        self,
        parent: str,
        name: str,
        files: dict[str, bytes],
    ) -> tuple[dict[str, Any], Path, str]:
        source_root = self.root / parent / name
        source_root.mkdir(parents=True)
        for relative_path, payload in files.items():
            target = source_root / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
        source = self.container.gallery_catalog.import_source(str(source_root))
        self.container.gallery_catalog.scan_source(source["source_id"])
        root_directory = self.container.db.gallery.get_root_directory(source["source_id"])
        assert root_directory is not None
        return source, source_root, str(root_directory["directory_id"])

    def _wait(self, manager: Any, operation_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            record = manager.get(operation_id)
            if record["state"] != "copying":
                return record
            time.sleep(0.01)
        self.fail("directory export did not reach a terminal state")

    def _assert_error(self, code: str, action: Callable[[], Any]) -> None:
        module = self._module()
        error_type = getattr(module, "GalleryDirectoryExportError", None)
        self.assertTrue(isinstance(error_type, type))
        with self.assertRaises(error_type) as caught:
            action()
        self.assertEqual(caught.exception.code, code)

    def test_copies_only_allowlisted_files_and_preserves_txt_bytes(self) -> None:
        _source, source_root, directory_id = self._source(
            "sources",
            "alpha",
            {
                "one.JPG": b"jpg",
                "nested/two.jpeg": b"jpeg",
                "nested/three.PNG": b"png",
                "nested/four.webp": b"webp",
                "orphan.txt": b"\xff\xfe\x00raw\r\n",
                "empty.TXT": b"",
                "nested/image.txt": b"tag, tag\n",
                "video.webm": b"webm",
                "video.mp4": b"mp4",
                "animation.gif": b"gif",
                "bitmap.bmp": b"bmp",
                "photo.tiff": b"tiff",
                "photo.heic": b"heic",
                "raw.cr2": b"raw",
                "design.psd": b"psd",
                "metadata.json": b"{}",
                "archive.zip": b"zip",
                "page.html": b"html",
                "db.sqlite3": b"db",
                "run.log": b"log",
                "partial.jpg.part": b"partial",
                ".imageweave/trash/op/hidden.jpg": b"hidden",
                ".imageweave/copy-tmp/hidden.txt": b"hidden",
            },
        )
        outside = self.root / "outside.txt"
        outside.write_bytes(b"outside")
        if hasattr(os, "symlink"):
            (source_root / "linked.txt").symlink_to(outside)
            (source_root / "linked-dir").symlink_to(self.root, target_is_directory=True)

        target = self.root / "target"
        target.mkdir()
        manager = self._manager()
        started = manager.start(
            directory_ids=[directory_id], target_path=str(target)
        )
        record = self._wait(manager, started["operation_id"])
        self.assertEqual(record["state"], "completed")
        self.assertEqual(record["completed_directory_count"], 1)
        self.assertEqual(record["copied_file_count"], 7)

        output = target / "alpha"
        copied = sorted(
            path.relative_to(output).as_posix()
            for path in output.rglob("*")
            if path.is_file()
        )
        self.assertEqual(
            copied,
            [
                "empty.TXT",
                "nested/four.webp",
                "nested/image.txt",
                "nested/three.PNG",
                "nested/two.jpeg",
                "one.JPG",
                "orphan.txt",
            ],
        )
        self.assertEqual((output / "orphan.txt").read_bytes(), b"\xff\xfe\x00raw\r\n")
        self.assertEqual((output / "empty.TXT").read_bytes(), b"")

    def test_zero_allowed_files_commits_an_empty_named_directory(self) -> None:
        _source, _root, directory_id = self._source(
            "sources", "empty-output", {"video.mp4": b"x", "meta.json": b"{}"}
        )
        target = self.root / "target"
        target.mkdir()
        manager = self._manager()
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(record["state"], "completed")
        self.assertEqual(record["copied_file_count"], 0)
        self.assertTrue((target / "empty-output").is_dir())
        self.assertEqual(list((target / "empty-output").iterdir()), [])

    def test_only_top_level_name_conflicts_block_preflight(self) -> None:
        _source, _root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"x"}
        )
        target = self.root / "target"
        target.mkdir()
        (target / "unrelated").mkdir()
        manager = self._manager()
        completed = self._wait(
            manager,
            manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(completed["state"], "completed")

        self._assert_error(
            "target_name_conflict",
            lambda: manager.start(
                directory_ids=[directory_id], target_path=str(target)
            ),
        )

    def test_duplicate_selected_directory_names_block_the_whole_operation(self) -> None:
        _a, _a_root, first_id = self._source("one", "same", {"a.jpg": b"a"})
        _b, _b_root, second_id = self._source("two", "same", {"b.jpg": b"b"})
        target = self.root / "target"
        target.mkdir()
        manager = self._manager()
        self._assert_error(
            "selected_name_conflict",
            lambda: manager.start(
                directory_ids=[first_id, second_id], target_path=str(target)
            ),
        )
        self.assertEqual(list(target.iterdir()), [])

    def test_target_must_not_be_inside_a_selected_directory(self) -> None:
        _source, source_root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"x"}
        )
        target = source_root / "nested-target"
        target.mkdir()
        manager = self._manager()
        self._assert_error(
            "target_inside_source",
            lambda: manager.start(
                directory_ids=[directory_id], target_path=str(target)
            ),
        )

    def test_no_clobber_commit_survives_a_post_preflight_race(self) -> None:
        _source, _root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"source"}
        )
        target = self.root / "target"
        target.mkdir()

        def race_creator(
            _operation_id: str,
            _directory_name: str,
            _temporary_path: Path,
            final_path: Path,
        ) -> None:
            final_path.mkdir()
            (final_path / "sentinel.txt").write_bytes(b"external")

        manager = self._manager(before_commit=race_creator)
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(record["state"], "failed")
        self.assertEqual(record["results"][0]["error_code"], "target_name_conflict")
        self.assertEqual((target / "alpha" / "sentinel.txt").read_bytes(), b"external")
        self.assertFalse(any(path.name.startswith(".imageweave-copy-") for path in target.iterdir()))

    def test_prior_directories_remain_after_a_later_directory_fails(self) -> None:
        _a, _a_root, first_id = self._source("sources", "alpha", {"a.jpg": b"a"})
        _b, _b_root, second_id = self._source("sources", "beta", {"b.jpg": b"b"})
        target = self.root / "target"
        target.mkdir()

        def fail_beta(
            _operation_id: str,
            directory_name: str,
            _temporary_path: Path,
            _final_path: Path,
        ) -> None:
            if directory_name == "beta":
                raise OSError("injected copy commit failure")

        manager = self._manager(before_commit=fail_beta)
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[first_id, second_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(record["state"], "failed")
        self.assertTrue((target / "alpha" / "a.jpg").is_file())
        self.assertFalse((target / "beta").exists())
        self.assertEqual(
            [result["status"] for result in record["results"]],
            ["completed", "failed"],
        )

    def test_cancel_removes_the_current_temporary_directory(self) -> None:
        _source, _root, directory_id = self._source(
            "sources", "alpha", {"large.jpg": b"x" * (1024 * 256)}
        )
        target = self.root / "target"
        target.mkdir()
        entered = threading.Event()
        release = threading.Event()

        def pause_copy(_operation_id: str, _relative_path: str, _copied: int) -> None:
            if not entered.is_set():
                entered.set()
                release.wait(timeout=5.0)

        manager = self._manager(copy_chunk_size=1024, copy_chunk_hook=pause_copy)
        started = manager.start(
            directory_ids=[directory_id], target_path=str(target)
        )
        self.assertTrue(entered.wait(timeout=5.0))
        manager.cancel(started["operation_id"])
        release.set()
        record = self._wait(manager, started["operation_id"])
        self.assertEqual(record["state"], "cancelled")
        self.assertFalse((target / "alpha").exists())
        self.assertFalse(any(path.name.startswith(".imageweave-copy-") for path in target.iterdir()))

    def test_directory_export_creates_no_legacy_persistent_rows(self) -> None:
        _source, _root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"x"}
        )
        with self.container.db.gallery._read() as connection:  # noqa: SLF001
            tables = [
                row["name"]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table' AND name LIKE 'dataset_export_%'"
                ).fetchall()
            ]
            before = {
                table: connection.execute(
                    f'SELECT COUNT(*) AS total FROM "{table}"'
                ).fetchone()["total"]
                for table in tables
            }

        target = self.root / "target"
        target.mkdir()
        manager = self._manager()
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(record["state"], "completed")

        with self.container.db.gallery._read() as connection:  # noqa: SLF001
            after = {
                table: connection.execute(
                    f'SELECT COUNT(*) AS total FROM "{table}"'
                ).fetchone()["total"]
                for table in tables
            }
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
