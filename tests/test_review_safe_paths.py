from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dedup"))

from review_safe_paths import SafeSourceRoot, UnsafeSourcePathError, held_file_disk_version


class ReviewSafePathsTests(unittest.TestCase):
    def test_disk_version_matches_wire_fields_and_preserves_held_inode_and_position(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "image.png"
            payload = b"original input" * 20000
            path.write_bytes(payload)
            with SafeSourceRoot(root) as safe, safe.open_binary(path.name) as handle:
                self.assertEqual(safe.root_identity(), (root.stat().st_dev, root.stat().st_ino))
                metadata = os.fstat(handle.fileno())
                fields = (metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_size, metadata.st_mtime_ns)
                wire = b"ldos:disk-version:v1\0" + b"".join(str(value).encode("ascii") + b"\0" for value in fields)
                expected = hashlib.sha256(wire + hashlib.sha256(payload).digest()).hexdigest()
                handle.seek(7)
                self.assertEqual(held_file_disk_version(handle), expected)
                self.assertEqual(handle.tell(), 7)
                replacement = root / "replacement.png"
                replacement.write_bytes(b"replacement input")
                replacement.replace(path)
                self.assertEqual(held_file_disk_version(handle), expected)
                self.assertEqual(handle.tell(), 7)
                with safe.open_binary(path.name) as updated:
                    self.assertNotEqual(held_file_disk_version(updated), expected)
            self.assertTrue(handle.closed)

    def test_rejects_traversal_non_normalized_paths_links_and_non_regular_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "directory").mkdir()
            (root / "directory" / "image.png").write_bytes(b"inside")
            (root / "parent-link").symlink_to(root / "directory", target_is_directory=True)
            (root / "leaf-link.png").symlink_to(root / "directory" / "image.png")
            os.mkfifo(root / "pipe")
            paths = ("", ".", "..", "../image.png", "/image.png", "C:/image.png", "image\\name.png",
                     "image\x00.png", "directory//image.png", "directory/./image.png", "directory/",
                     "parent-link/image.png", "leaf-link.png", "directory", "pipe", "missing.png", "missing/image.png")
            with SafeSourceRoot(root) as safe:
                for path in paths:
                    with self.subTest(path=path), self.assertRaises(UnsafeSourcePathError):
                        safe.open_binary(path)
            link = root / "root-link"
            link.symlink_to(root / "directory", target_is_directory=True)
            with self.assertRaises(UnsafeSourcePathError):
                with SafeSourceRoot(link):
                    self.fail("linked roots must not open")

    def test_directory_replacement_after_open_keeps_reads_on_held_root(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            root = parent / "source"
            root.mkdir()
            (root / "image.png").write_bytes(b"held original")
            with SafeSourceRoot(root) as safe:
                identity = safe.root_identity()
                descriptor = safe.root_fd
                safe.open()
                self.assertEqual(safe.root_fd, descriptor)
                root.rename(parent / "original")
                root.mkdir()
                (root / "image.png").write_bytes(b"replacement")
                self.assertEqual(safe.root_identity(), identity)
                with safe.open_binary("image.png") as handle:
                    self.assertEqual(handle.read(), b"held original")
            with self.assertRaises(OSError):
                os.fstat(descriptor)
            safe.close()

    def test_parent_symlink_swap_before_open_cannot_escape_root(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            root = parent / "source"
            root.mkdir()
            nested = root / "nested"
            nested.mkdir()
            (nested / "image.png").write_bytes(b"original")
            outside = parent / "outside"
            outside.mkdir()
            (outside / "image.png").write_bytes(b"outside")
            original_open = os.open
            def swap_then_open(path, flags, *args, **kwargs):
                if path == "nested":
                    nested.rename(root / "original")
                    nested.symlink_to(outside, target_is_directory=True)
                return original_open(path, flags, *args, **kwargs)
            with SafeSourceRoot(root) as safe, mock.patch("review_safe_paths.os.open", side_effect=swap_then_open):
                with self.assertRaises(UnsafeSourcePathError) as caught:
                    safe.open_binary("nested/image.png")
                self.assertEqual(caught.exception.reason, "unsafe_parent")


if __name__ == "__main__":
    unittest.main()
