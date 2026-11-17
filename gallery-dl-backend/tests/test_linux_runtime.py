from __future__ import annotations

import asyncio
import os
import signal
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from gdl_backend.file_security import (
    ensure_private_directory,
    open_private_binary,
    secure_private_path,
    write_private_text,
)
from gdl_backend.gallery_safe_paths import (
    SafeSourceRoot,
    UnsafeSourcePathError,
    validate_relative_path,
)
from gdl_backend.process_control import (
    process_command_line,
    terminate_process,
    terminate_stale_process,
)
from gdl_backend.safe_copy import TargetRoot, file_versions_match


class LinuxProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_shutdown_signals_the_process_group(self) -> None:
        process = Mock(pid=4321, returncode=None, wait=AsyncMock())
        with patch("gdl_backend.process_control.os.killpg") as killpg:
            await terminate_process(process, 0.2)
        killpg.assert_called_once_with(4321, signal.SIGTERM)
        process.wait.assert_awaited_once()
        process.terminate.assert_not_called()

    async def test_timeout_escalates_to_group_sigkill(self) -> None:
        process = Mock(
            pid=4321, returncode=None,
            wait=AsyncMock(side_effect=[asyncio.TimeoutError, None]),
        )
        with patch("gdl_backend.process_control.os.killpg") as killpg:
            await terminate_process(process, 0.2)
        self.assertEqual(
            [call.args for call in killpg.call_args_list],
            [(4321, signal.SIGTERM), (4321, signal.SIGKILL)],
        )
        self.assertEqual(process.wait.await_count, 2)

    async def test_missing_group_falls_back_to_child_termination(self) -> None:
        process = Mock(pid=4321, returncode=None, wait=AsyncMock())
        with patch("gdl_backend.process_control.os.killpg", side_effect=ProcessLookupError):
            await terminate_process(process, 0.2)
        process.terminate.assert_called_once_with()
        process.wait.assert_awaited_once()

    def test_stale_worker_requires_matching_command_and_marker(self) -> None:
        with (
            patch("gdl_backend.process_control.process_command_line") as command,
            patch("gdl_backend.process_control.os.killpg") as killpg,
        ):
            for value in ("", "python unrelated marker", "python gdl_backend.worker_entry other"):
                command.return_value = value
                self.assertFalse(terminate_stale_process(4321, "marker"))
            killpg.assert_not_called()
            command.return_value = "python -m gdl_backend.worker_entry marker"
            self.assertTrue(terminate_stale_process(4321, "marker"))
            killpg.assert_called_once_with(4321, signal.SIGTERM)

    def test_process_command_line_reads_proc(self) -> None:
        self.assertTrue(process_command_line(os.getpid()).strip())
        self.assertEqual(process_command_line(0), "")


class LinuxFileSecurityTests(unittest.TestCase):
    def test_private_writes_keep_directory_and_file_modes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = ensure_private_directory(Path(temporary) / "private")
            log = directory / "worker.log"
            with open_private_binary(log) as handle:
                handle.write(b"first")
            log.chmod(0o666)
            with open_private_binary(log, append=True) as handle:
                handle.write(b" second")
            config = directory / "config.json"
            write_private_text(config, "old")
            write_private_text(config, "new")
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            for path in (log, config):
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(log.read_bytes(), b"first second")
            self.assertEqual(config.read_text(), "new")
            self.assertEqual({path.name for path in directory.iterdir()}, {log.name, config.name})

    def test_symlink_is_rejected_without_changing_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target"
            target.write_text("original")
            target.chmod(0o644)
            link = root / "link"
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                secure_private_path(link)
            with self.assertRaises(ValueError):
                write_private_text(link, "replacement")
            self.assertEqual(target.read_text(), "original")
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)

    def test_file_version_requires_identity_and_ctime(self) -> None:
        version = (1, 2, 100, 200, 300)
        self.assertTrue(file_versions_match(version, version))
        self.assertFalse(file_versions_match(version, (0, 0, 100, 200, 300)))
        self.assertFalse(file_versions_match(version, (1, 2, 100, 200, 301)))


class RelativePathSecurityTests(unittest.TestCase):
    unsafe_paths = (
        "C:/escape.txt", "C:escape.txt", "C:\\escape.txt",
        "//server/share/file", r"\\server\share\file",
        r"\\?\C:\escape.txt", r"\\.\C:\escape.txt",
        "/escape.txt", "../escape.txt", "nested/../../escape.txt",
    )

    def test_relative_validator_rejects_windows_and_posix_escapes(self) -> None:
        for value in self.unsafe_paths:
            with self.subTest(path=value), self.assertRaises(UnsafeSourcePathError):
                validate_relative_path(value)
        self.assertEqual(validate_relative_path("nested/image.jpg"), ("nested", "image.jpg"))
        self.assertEqual(validate_relative_path("", allow_root=True), ())

    def test_source_open_rejects_escape_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with SafeSourceRoot(temporary) as source:
                for value in self.unsafe_paths:
                    with self.subTest(path=value), self.assertRaises(UnsafeSourcePathError):
                        source.open_binary(value)

    def test_copy_output_rejects_escape_paths_without_creating_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with TargetRoot(root) as target:
                target.create_owned_directory(".ldos-copy-test")
                for value in self.unsafe_paths:
                    with self.subTest(path=value), self.assertRaises(UnsafeSourcePathError):
                        with target.open_output_file(".ldos-copy-test", value):
                            self.fail("unsafe output opened")
            self.assertEqual(list((root / ".ldos-copy-test").iterdir()), [])
