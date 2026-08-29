"""Contract tests for Gallery-embedded simple directory export."""

from __future__ import annotations

import importlib
import os
import tempfile
import threading
import time
import unittest
from unittest import mock
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

from gdl_backend._database_gallery_repository import gallery_directory_id
from gdl_backend.app import ServiceContainer
from gdl_backend import gallery_safe_paths as safe_paths
from gdl_backend.gallery_safe_paths import SafeSourceRoot, UnsafeSourcePathError
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
            "gdl_backend.gallery_directory_export must be importable",
        )
        assert directory_export is not None
        return directory_export

    def _manager(self, **kwargs: Any) -> Any:
        module = self._module()
        kwargs.setdefault(
            "filesystem_locks", self.container.gallery_filesystem_locks
        )
        manager_type = getattr(module, "GalleryDirectoryExportService", None)
        self.assertTrue(
            callable(manager_type),
            "GalleryDirectoryExportService must be exported",
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
        (source_root / "empty-nested").mkdir()
        (source_root / "excluded-only").mkdir()
        (source_root / "excluded-only" / "video.mp4").write_bytes(b"video")
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

        self.assertFalse((output / "empty-nested").exists())
        self.assertFalse((output / "excluded-only").exists())

    def test_selected_subdirectory_becomes_one_top_level_and_preserves_its_subtree(
        self,
    ) -> None:
        source, _source_root, _root_id = self._source(
            "sources",
            "alpha",
            {
                "parent/chosen/one.jpg": b"one",
                "parent/chosen/one.txt": b"raw\xff",
                "parent/chosen/nested/two.WEBP": b"two",
                "parent/outside.jpg": b"outside",
                "root.txt": b"outside",
            },
        )
        selected_id = gallery_directory_id(
            source["source_id"], "parent/chosen"
        )
        target = self.root / "target"
        target.mkdir()
        manager = self._manager()
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[selected_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(record["state"], "completed")
        output = target / "chosen"
        self.assertEqual(
            sorted(
                path.relative_to(output).as_posix()
                for path in output.rglob("*")
                if path.is_file()
            ),
            ["nested/two.WEBP", "one.jpg", "one.txt"],
        )
        self.assertEqual((output / "one.txt").read_bytes(), b"raw\xff")

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

    def test_windows_style_scandir_stats_without_file_index_copy_completes(self) -> None:
        # Windows 的 DirEntry.stat() 来自 WIN32_FIND_DATA，st_dev/st_ino 恒为
        # 0；_copy_file 的源版本比较不得因此把未变化的文件判成 source_changed。
        _source, _root, directory_id = self._source(
            "sources", "alpha", {"nested/one.jpg": b"source"}
        )
        target = self.root / "target"
        target.mkdir()

        def zero_index(metadata: os.stat_result) -> os.stat_result:
            return os.stat_result(
                (
                    metadata.st_mode,
                    0,
                    0,
                    metadata.st_nlink,
                    metadata.st_uid,
                    metadata.st_gid,
                    metadata.st_size,
                    metadata.st_atime,
                    metadata.st_mtime,
                    metadata.st_ctime,
                ),
                {
                    "st_atime_ns": metadata.st_atime_ns,
                    "st_mtime_ns": metadata.st_mtime_ns,
                    "st_ctime_ns": metadata.st_ctime_ns,
                },
            )

        original_iter_subtree = SafeSourceRoot.iter_subtree

        def windows_style_iter_subtree(self, relative_directory, **kwargs):
            for entry in original_iter_subtree(self, relative_directory, **kwargs):
                zeroed = tuple(
                    (name, zero_index(metadata))
                    for name, metadata in entry.files
                )
                yield safe_paths.SafeDirectoryEntry(
                    entry.relative_path, entry.name, zeroed
                )

        manager = self._manager()
        with mock.patch.object(
            SafeSourceRoot, "iter_subtree", windows_style_iter_subtree
        ):
            record = self._wait(
                manager,
                manager.start(
                    directory_ids=[directory_id], target_path=str(target)
                )["operation_id"],
            )
        self.assertEqual(
            record["state"],
            "completed",
            f"error_code={record.get('error_code')} details={record.get('details')}",
        )
        self.assertEqual(
            (target / "alpha" / "nested" / "one.jpg").read_bytes(),
            b"source",
        )

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
        _b, _b_root, second_id = self._source("two", "SAME", {"b.jpg": b"b"})
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

    def test_target_path_validation_is_bounded_and_explicit(self) -> None:
        _source, _root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"x"}
        )
        manager = self._manager()
        self._assert_error(
            "target_path_invalid",
            lambda: manager.start(
                directory_ids=[directory_id], target_path="bad\x00target"
            ),
        )
        self._assert_error(
            "target_path_not_absolute",
            lambda: manager.start(
                directory_ids=[directory_id], target_path="relative-target"
            ),
        )

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

    def test_target_may_be_elsewhere_in_the_same_source(self) -> None:
        source, source_root, _root_id = self._source(
            "sources", "alpha", {"chosen/one.jpg": b"x"}
        )
        directory_id = gallery_directory_id(source["source_id"], "chosen")
        target = source_root / "exports"
        target.mkdir()
        manager = self._manager()
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(record["state"], "completed")
        self.assertEqual((target / "chosen" / "one.jpg").read_bytes(), b"x")

    def test_target_may_be_inside_an_unselected_gallery_source(self) -> None:
        _selected, _selected_root, directory_id = self._source(
            "selected", "alpha", {"one.jpg": b"x"}
        )
        _other, other_root, _other_id = self._source(
            "other", "beta", {"two.jpg": b"y"}
        )
        target = other_root / "exports"
        target.mkdir()
        manager = self._manager()
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(record["state"], "completed")
        self.assertEqual((target / "alpha" / "one.jpg").read_bytes(), b"x")

    def test_target_root_replacement_after_preflight_is_rejected(self) -> None:
        _source, _source_root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"source"}
        )
        target = self.root / "target-replaced-after-preflight"
        target.mkdir()
        original_target = self.root / "target-before-replacement"
        original_start = threading.Thread.start

        def replace_then_start(thread: threading.Thread) -> None:
            target.rename(original_target)
            target.mkdir()
            original_start(thread)

        manager = self._manager()
        with mock.patch.object(threading.Thread, "start", replace_then_start):
            started = manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )
        record = self._wait(manager, started["operation_id"])
        self.assertEqual(record["state"], "failed")
        self.assertEqual(record["error_code"], "target_root_changed")
        self.assertEqual(list(target.iterdir()), [])
        self.assertEqual(list(original_target.iterdir()), [])

    def test_source_root_replacement_after_preflight_is_rejected(self) -> None:
        _source, source_root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"original"}
        )
        target = self.root / "target-source-root-replaced"
        target.mkdir()
        original_source = self.root / "source-before-replacement"
        original_start = threading.Thread.start

        def replace_then_start(thread: threading.Thread) -> None:
            source_root.rename(original_source)
            source_root.mkdir()
            (source_root / "one.jpg").write_bytes(b"replacement")
            original_start(thread)

        manager = self._manager()
        with mock.patch.object(threading.Thread, "start", replace_then_start):
            started = manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )
        record = self._wait(manager, started["operation_id"])
        self.assertEqual(record["state"], "failed")
        self.assertEqual(record["error_code"], "source_changed")
        self.assertEqual(list(target.iterdir()), [])
        self.assertEqual((original_source / "one.jpg").read_bytes(), b"original")

    def test_fallback_rejects_a_symlink_in_the_target_parent_chain(self) -> None:
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks unavailable")
        _source, _source_root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"x"}
        )
        real_parent = self.root / "real-target-parent"
        target = real_parent / "target"
        target.mkdir(parents=True)
        linked_parent = self.root / "linked-target-parent"
        linked_parent.symlink_to(real_parent, target_is_directory=True)
        manager = self._manager()
        with mock.patch.object(self._module(), "_HAS_DIR_FD", False):
            self._assert_error(
                "target_path_unsafe",
                lambda: manager.start(
                    directory_ids=[directory_id],
                    target_path=str(linked_parent / "target"),
                ),
            )

    def test_fallback_source_root_replacement_is_rejected(self) -> None:
        source_root = self.root / "fallback-source-root"
        source_root.mkdir()
        (source_root / "one.jpg").write_bytes(b"original")
        moved_root = self.root / "moved-fallback-source-root"

        with (
            mock.patch.object(safe_paths, "_DESCRIPTOR_ANCHORED", False),
            mock.patch.object(safe_paths, "_HAS_DIR_FD", False),
        ):
            with SafeSourceRoot(source_root) as safe_root:
                source_root.rename(moved_root)
                source_root.mkdir()
                (source_root / "one.jpg").write_bytes(b"replacement")
                with self.assertRaises(UnsafeSourcePathError) as raised:
                    list(
                        safe_root.iter_subtree(
                            "", excluded_directories=frozenset()
                        )
                    )
        self.assertEqual(raised.exception.reason, "source_root_changed")

    def test_fallback_copy_revalidates_each_output_component(self) -> None:
        _source, _source_root, directory_id = self._source(
            "sources", "alpha", {"nested/one.jpg": b"source"}
        )
        target = self.root / "target"
        target.mkdir()
        module = self._module()

        def fallback_rename(
            *,
            parent_fd: int,
            parent_path: Path,
            source_name: str,
            target_name: str,
        ) -> None:
            del parent_fd
            destination = parent_path / target_name
            if destination.exists() or destination.is_symlink():
                raise FileExistsError(target_name)
            os.rename(parent_path / source_name, destination)

        manager = self._manager()
        with (
            mock.patch.object(module, "_HAS_DIR_FD", False),
            mock.patch("gdl_backend.gallery_safe_paths._HAS_DIR_FD", False),
            mock.patch.object(
                module, "_rename_directory_noreplace", fallback_rename
            ),
        ):
            record = self._wait(
                manager,
                manager.start(
                    directory_ids=[directory_id], target_path=str(target)
                )["operation_id"],
            )
        self.assertEqual(record["state"], "completed")
        self.assertEqual(
            (target / "alpha" / "nested" / "one.jpg").read_bytes(),
            b"source",
        )

    def test_fallback_rejects_an_injected_link_before_commit(self) -> None:
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks unavailable")
        _source, _source_root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"source"}
        )
        outside = self.root / "outside.jpg"
        outside.write_bytes(b"outside")
        target = self.root / "target"
        target.mkdir()

        def inject_link(
            _operation_id: str,
            _directory_name: str,
            temporary_path: Path,
            _final_path: Path,
        ) -> None:
            copied = temporary_path / "one.jpg"
            copied.unlink()
            copied.symlink_to(outside)

        manager = self._manager(before_commit=inject_link)
        with mock.patch.object(self._module(), "_HAS_DIR_FD", False):
            record = self._wait(
                manager,
                manager.start(
                    directory_ids=[directory_id], target_path=str(target)
                )["operation_id"],
            )
        self.assertEqual(record["state"], "failed")
        self.assertEqual(record["results"][0]["error_code"], "target_path_unsafe")
        self.assertEqual(outside.read_bytes(), b"outside")
        self.assertFalse((target / "alpha").exists())
        self.assertFalse(
            any(path.name.startswith(".imageweave-copy-") for path in target.iterdir())
        )

    def test_descriptor_target_rejects_an_injected_link_before_commit(self) -> None:
        module = self._module()
        if not getattr(module, "_HAS_DIR_FD", False) or not hasattr(os, "symlink"):
            self.skipTest("descriptor-relative symlink checks unavailable")
        _source, _source_root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"source"}
        )
        outside = self.root / "outside-descriptor.jpg"
        outside.write_bytes(b"outside")
        target = self.root / "target-descriptor"
        target.mkdir()

        def inject_link(
            _operation_id: str,
            _directory_name: str,
            temporary_path: Path,
            _final_path: Path,
        ) -> None:
            copied = temporary_path / "one.jpg"
            copied.unlink()
            copied.symlink_to(outside)

        manager = self._manager(before_commit=inject_link)
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(record["state"], "failed")
        self.assertEqual(record["results"][0]["error_code"], "target_path_unsafe")
        self.assertEqual(outside.read_bytes(), b"outside")
        self.assertFalse((target / "alpha").exists())
        self.assertFalse(
            any(path.name.startswith(".imageweave-copy-") for path in target.iterdir())
        )

    def test_injected_regular_file_is_not_committed(self) -> None:
        _source, _source_root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"source"}
        )
        target = self.root / "target-injected-regular"
        target.mkdir()

        def inject_regular_file(
            _operation_id: str,
            _directory_name: str,
            temporary_path: Path,
            _final_path: Path,
        ) -> None:
            (temporary_path / "extra.bin").write_bytes(b"external")

        manager = self._manager(before_commit=inject_regular_file)
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )["operation_id"],
        )

        self.assertEqual(record["state"], "failed")
        self.assertEqual(record["results"][0]["error_code"], "target_path_changed")
        self.assertFalse((target / "alpha").exists())
        self.assertEqual(list(target.iterdir()), [])


    def test_descriptor_output_replacement_during_write_is_rejected(self) -> None:
        module = self._module()
        if not getattr(module, "_HAS_DIR_FD", False) or not hasattr(os, "symlink"):
            self.skipTest("descriptor-relative symlink checks unavailable")
        _source, _source_root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"source" * 1024}
        )
        outside = self.root / "outside-open-output.jpg"
        outside.write_bytes(b"outside")
        target = self.root / "target-open-output"
        target.mkdir()
        injected = threading.Event()

        def replace_open_output(
            _operation_id: str, _relative_path: str, _copied: int
        ) -> None:
            if injected.is_set():
                return
            injected.set()
            temporary = next(
                path
                for path in target.iterdir()
                if path.name.startswith(".imageweave-copy-")
            )
            copied = temporary / "one.jpg"
            copied.unlink()
            copied.symlink_to(outside)

        manager = self._manager(copy_chunk_hook=replace_open_output)
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(record["state"], "failed")
        self.assertEqual(
            record["results"][0]["error_code"], "target_path_changed"
        )
        self.assertEqual(outside.read_bytes(), b"outside")
        self.assertFalse((target / "alpha").exists())

    def test_source_change_during_copy_discards_the_temporary_directory(self) -> None:
        _source, source_root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"a" * 4096}
        )
        target = self.root / "target-source-change"
        target.mkdir()
        changed = threading.Event()

        def mutate_source(
            _operation_id: str, _relative_path: str, _copied: int
        ) -> None:
            if not changed.is_set():
                changed.set()
                (source_root / "one.jpg").write_bytes(b"b" * 4096)

        manager = self._manager(
            copy_chunk_size=1024, copy_chunk_hook=mutate_source
        )
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(record["state"], "failed")
        self.assertEqual(record["results"][0]["error_code"], "source_changed")
        self.assertFalse((target / "alpha").exists())
        self.assertFalse(
            any(path.name.startswith(".imageweave-copy-") for path in target.iterdir())
        )

    def test_source_replacement_after_copy_does_not_claim_a_frozen_snapshot(self) -> None:
        _source, source_root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"original"}
        )
        target = self.root / "target-source-replacement"
        target.mkdir()

        def replace_source(
            _operation_id: str,
            _directory_name: str,
            _temporary_path: Path,
            _final_path: Path,
        ) -> None:
            replacement = source_root / "replacement.jpg"
            replacement.write_bytes(b"changed")
            os.replace(replacement, source_root / "one.jpg")

        manager = self._manager(before_commit=replace_source)
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(record["state"], "completed")
        self.assertEqual((target / "alpha" / "one.jpg").read_bytes(), b"original")
        self.assertEqual((source_root / "one.jpg").read_bytes(), b"changed")

    def test_file_added_after_copy_is_not_part_of_the_short_lived_operation(self) -> None:
        _source, source_root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"original"}
        )
        target = self.root / "target-source-addition"
        target.mkdir()

        def add_source_file(
            _operation_id: str,
            _directory_name: str,
            _temporary_path: Path,
            _final_path: Path,
        ) -> None:
            (source_root / "late.txt").write_bytes(b"late")

        manager = self._manager(before_commit=add_source_file)
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(record["state"], "completed")
        self.assertEqual((target / "alpha" / "one.jpg").read_bytes(), b"original")
        self.assertFalse((target / "alpha" / "late.txt").exists())
        self.assertEqual((source_root / "late.txt").read_bytes(), b"late")

    def test_empty_directory_added_after_copy_is_not_exported(self) -> None:
        _source, source_root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"original"}
        )
        target = self.root / "target-source-directory-addition"
        target.mkdir()

        def add_source_directory(
            _operation_id: str,
            _directory_name: str,
            _temporary_path: Path,
            _final_path: Path,
        ) -> None:
            (source_root / "late-empty").mkdir()

        manager = self._manager(before_commit=add_source_directory)
        record = self._wait(
            manager,
            manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )["operation_id"],
        )
        self.assertEqual(record["state"], "completed")
        self.assertEqual((target / "alpha" / "one.jpg").read_bytes(), b"original")
        self.assertFalse((target / "alpha" / "late-empty").exists())
        self.assertTrue((source_root / "late-empty").is_dir())

    def test_preexisting_generated_probe_directory_is_never_deleted(self) -> None:
        _source, _root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"source"}
        )
        target = self.root / "target-preexisting-probe"
        target.mkdir()
        probe = target / ".imageweave-copy-probe-deadbeef"
        probe.mkdir()
        sentinel = probe / "sentinel.txt"
        sentinel.write_bytes(b"external")
        module = self._module()
        manager = self._manager()

        with mock.patch.object(module.secrets, "token_hex", return_value="deadbeef"):
            self._assert_error(
                "target_unavailable",
                lambda: manager.start(
                    directory_ids=[directory_id], target_path=str(target)
                ),
            )
        self.assertEqual(sentinel.read_bytes(), b"external")

    def test_preexisting_generated_temporary_directory_is_never_deleted(self) -> None:
        _source, _root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"source"}
        )
        target = self.root / "target-preexisting-temporary"
        target.mkdir()
        module = self._module()
        fixed_uuid = module.uuid.UUID("00000000-0000-4000-8000-000000000001")
        temporary = (
            target
            / ".imageweave-copy-00000000-0000-4000-8000-000000000001-0-deadbeef"
        )
        temporary.mkdir()
        sentinel = temporary / "sentinel.txt"
        sentinel.write_bytes(b"external")

        manager = self._manager()
        with (
            mock.patch.object(module.uuid, "uuid4", return_value=fixed_uuid),
            mock.patch.object(module.secrets, "token_hex", return_value="deadbeef"),
        ):
            started = manager.start(
                directory_ids=[directory_id], target_path=str(target)
            )
            record = self._wait(manager, started["operation_id"])
        self.assertEqual(record["state"], "failed")
        self.assertEqual(record["error_code"], "copy_io_error")
        self.assertEqual(sentinel.read_bytes(), b"external")

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
        self.assertFalse(
            any(path.name.startswith(".imageweave-copy-") for path in target.iterdir())
        )

    def test_unexpected_copy_failure_is_sanitized_and_cleans_temporary_output(
        self,
    ) -> None:
        _source, _root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"source"}
        )
        target = self.root / "target"
        target.mkdir()

        def fail_unexpectedly(
            _operation_id: str,
            _directory_name: str,
            _temporary_path: Path,
            _final_path: Path,
        ) -> None:
            raise RuntimeError("sensitive absolute path must not enter the API")

        manager = self._manager(before_commit=fail_unexpectedly)
        with self.assertLogs(
            "gdl_backend.gallery_directory_export", level="ERROR"
        ) as captured:
            record = self._wait(
                manager,
                manager.start(
                    directory_ids=[directory_id], target_path=str(target)
                )["operation_id"],
            )
        self.assertEqual(record["state"], "failed")
        self.assertEqual(record["results"][0]["error_code"], "internal_error")
        self.assertNotIn(str(self.root), "\n".join(captured.output))
        self.assertFalse(
            any(path.name.startswith(".imageweave-copy-") for path in target.iterdir())
        )

    def test_cleanup_failure_is_reported_instead_of_claiming_cancellation(self) -> None:
        _source, _root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"source"}
        )
        target = self.root / "target-cleanup-failure"
        target.mkdir()
        module = self._module()
        original_remove = module._TargetRoot.remove_owned_directory

        def fail_operation_cleanup(target_root: Any, name: str) -> bool:
            if "probe-" in name:
                return bool(original_remove(target_root, name))
            return False

        def fail_copy(
            _operation_id: str,
            _directory_name: str,
            _temporary_path: Path,
            _final_path: Path,
        ) -> None:
            raise OSError("injected copy failure")

        manager = self._manager(before_commit=fail_copy)
        with mock.patch.object(
            module._TargetRoot,
            "remove_owned_directory",
            fail_operation_cleanup,
        ):
            record = self._wait(
                manager,
                manager.start(
                    directory_ids=[directory_id], target_path=str(target)
                )["operation_id"],
            )
        self.assertEqual(record["state"], "failed")
        self.assertEqual(
            record["results"][0]["error_code"], "temporary_cleanup_failed"
        )
        self.assertTrue(
            any(path.name.startswith(".imageweave-copy-") for path in target.iterdir())
        )

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

    def test_second_operation_for_the_same_target_is_rejected_while_copying(
        self,
    ) -> None:
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

        manager = self._manager(
            copy_chunk_size=1024, copy_chunk_hook=pause_copy
        )
        first = manager.start(
            directory_ids=[directory_id], target_path=str(target)
        )
        self.assertTrue(entered.wait(timeout=5.0))
        try:
            self._assert_error(
                "target_busy",
                lambda: manager.start(
                    directory_ids=[directory_id], target_path=str(target)
                ),
            )
            manager.cancel(first["operation_id"])
        finally:
            release.set()
        self.assertEqual(
            self._wait(manager, first["operation_id"])["state"], "cancelled"
        )

    def test_active_operation_capacity_is_bounded(self) -> None:
        _source, _root, directory_id = self._source(
            "sources", "alpha", {"large.jpg": b"x" * (1024 * 256)}
        )
        first_target = self.root / "first-target"
        second_target = self.root / "second-target"
        first_target.mkdir()
        second_target.mkdir()
        entered = threading.Event()
        release = threading.Event()

        def pause_copy(_operation_id: str, _relative_path: str, _copied: int) -> None:
            if not entered.is_set():
                entered.set()
                release.wait(timeout=5.0)

        manager = self._manager(
            copy_chunk_size=1024, copy_chunk_hook=pause_copy
        )
        with mock.patch.object(self._module(), "_MAX_ACTIVE_OPERATIONS", 1):
            first = manager.start(
                directory_ids=[directory_id], target_path=str(first_target)
            )
            self.assertTrue(entered.wait(timeout=5.0))
            try:
                self._assert_error(
                    "operation_capacity_reached",
                    lambda: manager.start(
                        directory_ids=[directory_id], target_path=str(second_target)
                    ),
                )
                manager.cancel(first["operation_id"])
            finally:
                release.set()
        self.assertEqual(
            self._wait(manager, first["operation_id"])["state"], "cancelled"
        )

    def test_thread_start_failure_releases_operation_and_target_state(self) -> None:
        _source, _root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"source"}
        )
        target = self.root / "target-start-failure"
        target.mkdir()
        manager = self._manager()
        with mock.patch.object(
            threading.Thread, "start", side_effect=RuntimeError("thread unavailable")
        ):
            self._assert_error(
                "operation_start_failed",
                lambda: manager.start(
                    directory_ids=[directory_id], target_path=str(target)
                ),
            )

        started = manager.start(
            directory_ids=[directory_id], target_path=str(target)
        )
        record = self._wait(manager, started["operation_id"])
        self.assertEqual(
            record["state"],
            "completed",
            f"error_code={record.get('error_code')} details={record.get('details')}",
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
        self.assertFalse(
            any(path.name.startswith(".imageweave-copy-") for path in target.iterdir())
        )

    def test_shared_source_lock_serializes_copy_with_file_mutation(self) -> None:
        source, _root, directory_id = self._source(
            "sources", "alpha", {"one.jpg": b"x" * (1024 * 256)}
        )
        root_directory = self.container.db.gallery.get_root_directory(
            source["source_id"]
        )
        assert root_directory is not None
        asset = self.container.db.gallery.list_directory_entries(
            directory_id=root_directory["directory_id"]
        )["assets"][0]
        target = self.root / "target"
        target.mkdir()
        entered = threading.Event()
        release = threading.Event()
        renamed = threading.Event()
        rename_errors: list[Exception] = []

        def pause_copy(_operation_id: str, _relative_path: str, _copied: int) -> None:
            if not entered.is_set():
                entered.set()
                release.wait(timeout=5.0)

        def rename_source() -> None:
            try:
                self.container.gallery_file_operations.rename_asset(
                    asset["asset_id"], "renamed"
                )
            except Exception as error:  # pragma: no cover - asserted below
                rename_errors.append(error)
            finally:
                renamed.set()

        manager = self._manager(
            copy_chunk_size=1024, copy_chunk_hook=pause_copy
        )
        started = manager.start(
            directory_ids=[directory_id], target_path=str(target)
        )
        self.assertTrue(entered.wait(timeout=5.0))
        mutation_thread = threading.Thread(target=rename_source)
        mutation_thread.start()
        try:
            time.sleep(0.05)
            self.assertFalse(renamed.is_set())
        finally:
            release.set()
        mutation_thread.join(timeout=5.0)
        self.assertFalse(mutation_thread.is_alive())
        self.assertEqual(rename_errors, [])
        record = self._wait(manager, started["operation_id"])
        self.assertEqual(record["state"], "completed")
        self.assertTrue((target / "alpha" / "one.jpg").is_file())
        self.assertTrue((_root / "renamed.jpg").is_file())

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


class SafeSourceRootDescriptorlessTest(unittest.TestCase):
    """无描述符平台（Windows）回退模式：SafeSourceRoot.open 走纯路径校验。"""

    def test_descriptorless_mode_opens_and_validates_via_lstat(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = SafeSourceRoot(Path(tmp))
            with mock.patch.object(safe_paths, "_DESCRIPTOR_ANCHORED", False):
                root.open()
                self.assertTrue(root._descriptorless)
                self.assertIsNone(root._root_fd)
                # 幂等：重复 open 不再尝试描述符。
                root.open()
                root.close()
                self.assertFalse(root._descriptorless)

    def test_descriptorless_mode_rejects_non_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "file.txt"
            target.write_text("x", encoding="utf-8")
            root = SafeSourceRoot(target)
            with mock.patch.object(safe_paths, "_DESCRIPTOR_ANCHORED", False):
                with self.assertRaises(UnsafeSourcePathError) as ctx:
                    root.open()
                self.assertEqual(ctx.exception.reason, "source_root_not_directory")

    def test_descriptorless_mode_rejects_missing_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = SafeSourceRoot(Path(tmp) / "absent")
            with mock.patch.object(safe_paths, "_DESCRIPTOR_ANCHORED", False):
                with self.assertRaises(UnsafeSourcePathError) as ctx:
                    root.open()
                self.assertEqual(ctx.exception.reason, "source_root_unavailable")

    def test_descriptorless_open_binary_reports_missing_file(self) -> None:
        # Windows 上扫描 sidecar（a.txt）与 rename 目标探测都会对不存在的
        # 文件调用 open_binary：必须翻译为 UnsafeSourcePathError("file_missing")
        # 而不是裸 FileNotFoundError，否则扫描线程直接崩溃。
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "keep.jpg").write_bytes(b"x")
            root = SafeSourceRoot(Path(tmp))
            with (
                mock.patch.object(safe_paths, "_DESCRIPTOR_ANCHORED", False),
                mock.patch.object(safe_paths, "_HAS_DIR_FD", False),
            ):
                root.open()
                self.assertFalse(root.exists_regular("missing.txt"))
                with self.assertRaises(UnsafeSourcePathError) as ctx:
                    root.open_binary("missing.txt")
                self.assertEqual(ctx.exception.reason, "file_missing")
                handle = root.open_binary("keep.jpg")
                handle.close()
                root.close()

    def test_descriptorless_exists_regular_treats_missing_parent_as_absent(self) -> None:
        # trash/rename 的目标探测会对父目录尚未创建的目标调用 exists_regular：
        # 父组件缺失必须是 parent_missing（视为不存在），不能是 unsafe_parent。
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "keep.jpg").write_bytes(b"x")
            root = SafeSourceRoot(Path(tmp))
            with (
                mock.patch.object(safe_paths, "_DESCRIPTOR_ANCHORED", False),
                mock.patch.object(safe_paths, "_HAS_DIR_FD", False),
            ):
                root.open()
                self.assertFalse(
                    root.exists_regular(".imageweave-trash/op-1/files/keep.jpg")
                )
                self.assertEqual(
                    root.disk_version(
                        ".imageweave-trash/op-1/files/keep.jpg", allow_missing=True
                    ),
                    safe_paths._MISSING_DISK_VERSION,
                )
                root.close()

    def test_descriptorless_directory_probes_and_root_identity(self) -> None:
        # 目录 trash 在目标目录尚未创建时探测 exists_directory：
        # 父目录缺失 + allow_missing 必须返回 False；root_identity 在无描述符
        # 平台退化为 lstat（此前裸用 root_fd 会直接 AssertionError）。
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "whole").mkdir()
            (Path(tmp) / "whole" / "a.jpg").write_bytes(b"x")
            root = SafeSourceRoot(Path(tmp))
            with (
                mock.patch.object(safe_paths, "_DESCRIPTOR_ANCHORED", False),
                mock.patch.object(safe_paths, "_HAS_DIR_FD", False),
            ):
                root.open()
                self.assertEqual(
                    root.root_identity(),
                    (int(os.stat(tmp).st_dev), int(os.stat(tmp).st_ino)),
                )
                self.assertFalse(
                    root.exists_directory(
                        ".imageweave/trash/op-1/files/whole", allow_missing=True
                    )
                )
                self.assertTrue(
                    root.exists_directory("whole", allow_missing=True)
                )
                root.move_directory(
                    "whole", ".imageweave/trash/op-1/files/whole"
                )
                self.assertTrue(
                    (Path(tmp) / ".imageweave/trash/op-1/files/whole/a.jpg").is_file()
                )
                root.close()



if __name__ == "__main__":
    unittest.main()
