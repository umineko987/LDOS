"""Linux descriptor-anchored, read-only access to snapshotted review inputs."""
from __future__ import annotations

import contextlib
import hashlib
import os
import stat
from collections.abc import Iterator
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import BinaryIO


class UnsafeSourcePathError(OSError):
    """A source path is unsafe, escaped, linked, or no longer a regular file."""

    code = "unsafe_source_path"

    def __init__(self, relative_path: str, reason: str = "unsafe_source_path") -> None:
        super().__init__(reason)
        self.relative_path = relative_path
        self.reason = reason


def validate_relative_path(relative_path: str) -> tuple[str, ...]:
    if not isinstance(relative_path, str):
        raise UnsafeSourcePathError("", "relative_path_not_string")
    if relative_path == "":
        raise UnsafeSourcePathError(relative_path, "relative_path_empty")
    if "\\" in relative_path or "\x00" in relative_path:
        raise UnsafeSourcePathError(relative_path, "relative_path_invalid")
    pure = PurePosixPath(relative_path)
    if pure.is_absolute() or PureWindowsPath(relative_path).drive:
        raise UnsafeSourcePathError(relative_path, "relative_path_absolute")
    parts = pure.parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise UnsafeSourcePathError(relative_path, "relative_path_traversal")
    if "/".join(parts) != relative_path:
        raise UnsafeSourcePathError(relative_path, "relative_path_not_normalized")
    return parts


def _opaque_disk_version(metadata: os.stat_result, payload_digest: bytes) -> str:
    digest = hashlib.sha256()
    digest.update(b"ldos:disk-version:v1\0")
    for value in (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_size,
        metadata.st_mtime_ns,
    ):
        digest.update(str(int(value)).encode("ascii"))
        digest.update(b"\0")
    digest.update(payload_digest)
    return digest.hexdigest()


def held_file_disk_version(handle: BinaryIO) -> str:
    """Fingerprint the held inode using the existing disk-version wire protocol."""
    position = handle.tell()
    try:
        handle.seek(0)
        metadata = os.fstat(handle.fileno())
        digest = hashlib.sha256()
        while chunk := handle.read(128 * 1024):
            digest.update(chunk)
        return _opaque_disk_version(metadata, digest.digest())
    finally:
        handle.seek(position)


class SafeSourceRoot:
    """Hold a source directory and open regular files beneath it without links."""

    def __init__(self, root_path: str | os.PathLike[str]) -> None:
        self.path = Path(root_path)
        self._root_fd: int | None = None

    def __enter__(self) -> "SafeSourceRoot":
        self.open()
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()

    def open(self) -> None:
        if self._root_fd is not None:
            return
        if self.path.is_symlink():
            raise UnsafeSourcePathError("", "source_root_reparse_point")
        try:
            descriptor = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
        except OSError as error:
            raise UnsafeSourcePathError("", "source_root_unavailable") from error
        metadata = os.fstat(descriptor)
        if not stat.S_ISDIR(metadata.st_mode):
            os.close(descriptor)
            raise UnsafeSourcePathError("", "source_root_not_directory")
        try:
            observed = self.path.lstat()
        except OSError as error:
            os.close(descriptor)
            raise UnsafeSourcePathError("", "source_root_changed") from error
        if (
            not stat.S_ISDIR(observed.st_mode)
            or (int(observed.st_dev), int(observed.st_ino))
            != (int(metadata.st_dev), int(metadata.st_ino))
        ):
            os.close(descriptor)
            raise UnsafeSourcePathError("", "source_root_changed")
        self._root_fd = descriptor

    def close(self) -> None:
        descriptor, self._root_fd = self._root_fd, None
        if descriptor is not None:
            os.close(descriptor)

    @property
    def root_fd(self) -> int:
        self.open()
        assert self._root_fd is not None
        return self._root_fd

    def root_identity(self) -> tuple[int, int]:
        metadata = os.fstat(self.root_fd)
        return (int(metadata.st_dev), int(metadata.st_ino))

    @contextlib.contextmanager
    def _parent_fd(self, relative_path: str) -> Iterator[tuple[int, str]]:
        parts = validate_relative_path(relative_path)
        descriptor = os.dup(self.root_fd)
        try:
            for component in parts[:-1]:
                try:
                    child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
                                    dir_fd=descriptor)
                except FileNotFoundError as error:
                    raise UnsafeSourcePathError(relative_path, "parent_missing") from error
                except OSError as error:
                    raise UnsafeSourcePathError(relative_path, "unsafe_parent") from error
                metadata = os.fstat(child)
                if not stat.S_ISDIR(metadata.st_mode):
                    os.close(child)
                    raise UnsafeSourcePathError(relative_path, "parent_not_directory")
                os.close(descriptor)
                descriptor = child
            yield descriptor, parts[-1]
        finally:
            os.close(descriptor)

    def open_binary(self, relative_path: str) -> BinaryIO:
        with self._parent_fd(relative_path) as (parent_fd, name):
            try:
                # Nonblocking opens let fstat reject a FIFO without waiting for a writer.
                descriptor = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
                                     dir_fd=parent_fd)
            except FileNotFoundError as error:
                raise UnsafeSourcePathError(relative_path, "file_missing") from error
            except OSError as error:
                raise UnsafeSourcePathError(relative_path, "file_unavailable") from error
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            os.close(descriptor)
            raise UnsafeSourcePathError(relative_path, "leaf_not_regular")
        return os.fdopen(descriptor, "rb", closefd=True)
