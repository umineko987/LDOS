"""Race-resistant filesystem access for Gallery-managed source roots.

All Gallery filesystem consumers use this module rather than joining an indexed
relative path to a root ``Path``.  On POSIX each path component is opened from a
held directory descriptor with ``O_NOFOLLOW``; regular files are then verified
with ``fstat``.  The fallback used on platforms without descriptor-relative
operations performs repeated reparse/link and containment checks before and
after each operation instead of trusting a single ``resolve()`` result.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import secrets
import threading
import stat
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO


class UnsafeSourcePathError(OSError):
    """A managed path is unsafe, escaped, linked, or no longer a regular file."""

    code = "unsafe_source_path"

    def __init__(self, relative_path: str, reason: str = "unsafe_source_path") -> None:
        super().__init__(reason)
        self.relative_path = relative_path
        self.reason = reason


@dataclass(frozen=True)
class SafeFileStat:
    size: int
    modified_ns: int
    device: int
    inode: int


@dataclass(frozen=True)
class SafeDirectoryEntry:
    relative_path: str
    name: str
    files: tuple[tuple[str, os.stat_result], ...]



class GalleryFilesystemLocks:
    """Process-local locks shared by Gallery readers and mutating operations.

    Entries are reference-counted and removed after their last waiter exits, so
    opening a large library does not permanently retain one lock per asset.
    """

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._entries: dict[str, tuple[threading.RLock, int]] = {}

    @contextlib.contextmanager
    def hold(self, *keys: str) -> Iterator[None]:
        normalized = tuple(sorted(set(keys)))
        acquired: list[tuple[str, threading.RLock]] = []
        with self._guard:
            for key in normalized:
                lock, count = self._entries.get(key, (threading.RLock(), 0))
                self._entries[key] = (lock, count + 1)
                acquired.append((key, lock))
        try:
            for _key, lock in acquired:
                lock.acquire()
            yield
        finally:
            for _key, lock in reversed(acquired):
                lock.release()
            with self._guard:
                for key, lock in acquired:
                    current_lock, count = self._entries[key]
                    assert current_lock is lock
                    if count == 1:
                        del self._entries[key]
                    else:
                        self._entries[key] = (lock, count - 1)

_MISSING_DISK_VERSION = hashlib.sha256(b"imageweave:missing:v1").hexdigest()
_OPEN_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_NO_FOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOSE_ON_EXEC = getattr(os, "O_CLOEXEC", 0)
_HAS_DIR_FD = os.open in os.supports_dir_fd and os.stat in os.supports_dir_fd


def validate_relative_path(relative_path: str, *, allow_root: bool = False) -> tuple[str, ...]:
    if not isinstance(relative_path, str):
        raise UnsafeSourcePathError("", "relative_path_not_string")
    if relative_path == "":
        if allow_root:
            return ()
        raise UnsafeSourcePathError(relative_path, "relative_path_empty")
    if "\\" in relative_path or "\x00" in relative_path:
        raise UnsafeSourcePathError(relative_path, "relative_path_invalid")
    pure = PurePosixPath(relative_path)
    if pure.is_absolute():
        raise UnsafeSourcePathError(relative_path, "relative_path_absolute")
    parts = pure.parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise UnsafeSourcePathError(relative_path, "relative_path_traversal")
    normalized = "/".join(parts)
    if normalized != relative_path:
        raise UnsafeSourcePathError(relative_path, "relative_path_not_normalized")
    return parts


def _is_reparse_path(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        is_junction = getattr(path, "is_junction", None)
        if callable(is_junction) and is_junction():
            return True
        metadata = path.lstat()
    except OSError:
        return False
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def _is_reparse_entry(entry: os.DirEntry[str]) -> bool:
    if entry.is_symlink():
        return True
    is_junction = getattr(entry, "is_junction", None)
    if callable(is_junction) and is_junction():
        return True
    try:
        attributes = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
    except OSError:
        return True
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def _opaque_disk_version(metadata: os.stat_result, payload_digest: bytes) -> str:
    digest = hashlib.sha256()
    digest.update(b"imageweave:disk-version:v1\0")
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


class SafeSourceRoot:
    """A short-lived, descriptor-anchored view of one registered source root."""

    def __init__(self, root_path: str | os.PathLike[str]) -> None:
        self.path = Path(root_path)
        self._canonical = self.path.resolve(strict=False)
        self._root_fd: int | None = None

    def __enter__(self) -> "SafeSourceRoot":
        self.open()
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()

    def open(self) -> None:
        if self._root_fd is not None:
            return
        if _is_reparse_path(self.path):
            raise UnsafeSourcePathError("", "source_root_reparse_point")
        try:
            flags = os.O_RDONLY | _OPEN_DIRECTORY | _CLOSE_ON_EXEC | _NO_FOLLOW
            descriptor = os.open(self.path, flags)
        except OSError as error:
            raise UnsafeSourcePathError("", "source_root_unavailable") from error
        metadata = os.fstat(descriptor)
        if not stat.S_ISDIR(metadata.st_mode):
            os.close(descriptor)
            raise UnsafeSourcePathError("", "source_root_not_directory")
        if _is_reparse_path(self.path):
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

    @contextlib.contextmanager
    def _parent_fd(
        self,
        relative_path: str,
        *,
        create: bool = False,
    ) -> Iterator[tuple[int, str]]:
        parts = validate_relative_path(relative_path)
        if not _HAS_DIR_FD:
            yield -1, parts[-1]
            return
        descriptor = os.dup(self.root_fd)
        try:
            for component in parts[:-1]:
                if create:
                    try:
                        os.mkdir(component, mode=0o755, dir_fd=descriptor)
                    except FileExistsError:
                        pass
                flags = os.O_RDONLY | _OPEN_DIRECTORY | _CLOSE_ON_EXEC | _NO_FOLLOW
                try:
                    child = os.open(component, flags, dir_fd=descriptor)
                except FileNotFoundError as error:
                    raise UnsafeSourcePathError(
                        relative_path, "parent_missing"
                    ) from error
                except OSError as error:
                    raise UnsafeSourcePathError(
                        relative_path, "unsafe_parent"
                    ) from error
                metadata = os.fstat(child)
                if not stat.S_ISDIR(metadata.st_mode):
                    os.close(child)
                    raise UnsafeSourcePathError(relative_path, "parent_not_directory")
                os.close(descriptor)
                descriptor = child
            yield descriptor, parts[-1]
        finally:
            os.close(descriptor)

    def _fallback_path(
        self,
        relative_path: str,
        *,
        allow_missing_leaf: bool = False,
        create_parents: bool = False,
    ) -> Path:
        parts = validate_relative_path(relative_path)
        current = self.path
        if _is_reparse_path(current):
            raise UnsafeSourcePathError(relative_path, "source_root_reparse_point")
        for component in parts[:-1]:
            current = current / component
            if create_parents and not current.exists():
                current.mkdir()
            if _is_reparse_path(current) or not current.is_dir():
                raise UnsafeSourcePathError(relative_path, "unsafe_parent")
        target = current / parts[-1]
        if target.exists() or not allow_missing_leaf:
            if _is_reparse_path(target):
                raise UnsafeSourcePathError(relative_path, "leaf_reparse_point")
        resolved_parent = target.parent.resolve(strict=True)
        try:
            resolved_parent.relative_to(self._canonical)
        except ValueError as error:
            raise UnsafeSourcePathError(relative_path, "path_escaped_root") from error
        if _is_reparse_path(self.path) or _is_reparse_path(target.parent):
            raise UnsafeSourcePathError(relative_path, "path_changed")
        return target

    def open_binary(self, relative_path: str) -> BinaryIO:
        if not _HAS_DIR_FD:
            target = self._fallback_path(relative_path)
            handle = target.open("rb")
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                handle.close()
                raise UnsafeSourcePathError(relative_path, "leaf_not_regular")
            return handle
        with self._parent_fd(relative_path) as (parent_fd, name):
            try:
                descriptor = os.open(
                    name,
                    os.O_RDONLY | _CLOSE_ON_EXEC | _NO_FOLLOW,
                    dir_fd=parent_fd,
                )
            except FileNotFoundError as error:
                raise UnsafeSourcePathError(relative_path, "file_missing") from error
            except OSError as error:
                raise UnsafeSourcePathError(relative_path, "file_unavailable") from error
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            os.close(descriptor)
            raise UnsafeSourcePathError(relative_path, "leaf_not_regular")
        return os.fdopen(descriptor, "rb", closefd=True)

    def read_bytes(self, relative_path: str, *, max_bytes: int | None = None) -> bytes:
        with self.open_binary(relative_path) as handle:
            if max_bytes is None:
                return handle.read()
            payload = handle.read(max_bytes + 1)
            if len(payload) > max_bytes:
                raise UnsafeSourcePathError(relative_path, "file_too_large")
            return payload

    def stat_regular(self, relative_path: str) -> SafeFileStat:
        with self.open_binary(relative_path) as handle:
            metadata = os.fstat(handle.fileno())
        return SafeFileStat(
            size=int(metadata.st_size),
            modified_ns=int(metadata.st_mtime_ns),
            device=int(metadata.st_dev),
            inode=int(metadata.st_ino),
        )

    def exists_regular(self, relative_path: str) -> bool:
        try:
            self.stat_regular(relative_path)
        except UnsafeSourcePathError as error:
            if error.reason in {"file_missing", "parent_missing"}:
                return False
            raise
        return True

    def disk_version(self, relative_path: str, *, allow_missing: bool = False) -> str:
        try:
            with self.open_binary(relative_path) as handle:
                metadata = os.fstat(handle.fileno())
                digest = hashlib.sha256()
                while chunk := handle.read(128 * 1024):
                    digest.update(chunk)
        except UnsafeSourcePathError as error:
            if allow_missing and error.reason in {"file_missing", "parent_missing"}:
                return _MISSING_DISK_VERSION
            raise
        return _opaque_disk_version(metadata, digest.digest())

    def read_with_disk_version(
        self,
        relative_path: str,
        *,
        allow_missing: bool = False,
        max_bytes: int | None = None,
    ) -> tuple[bytes | None, str]:
        try:
            with self.open_binary(relative_path) as handle:
                metadata = os.fstat(handle.fileno())
                payload = handle.read() if max_bytes is None else handle.read(max_bytes + 1)
        except UnsafeSourcePathError as error:
            if allow_missing and error.reason in {"file_missing", "parent_missing"}:
                return None, _MISSING_DISK_VERSION
            raise
        if max_bytes is not None and len(payload) > max_bytes:
            raise UnsafeSourcePathError(relative_path, "file_too_large")
        payload_digest = hashlib.sha256(payload).digest()
        return payload, _opaque_disk_version(metadata, payload_digest)

    def atomic_write_bytes(
        self,
        relative_path: str,
        payload: bytes,
        *,
        expected_disk_version: str,
    ) -> tuple[SafeFileStat, str]:
        current_version = self.disk_version(relative_path, allow_missing=True)
        if current_version != expected_disk_version:
            raise UnsafeSourcePathError(relative_path, "disk_version_conflict")
        if not _HAS_DIR_FD:
            target = self._fallback_path(
                relative_path, allow_missing_leaf=True, create_parents=True
            )
            temporary = target.with_name(
                f".{target.name}.imageweave-{secrets.token_hex(8)}.tmp"
            )
            try:
                with temporary.open("xb") as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                if self.disk_version(relative_path, allow_missing=True) != expected_disk_version:
                    raise UnsafeSourcePathError(relative_path, "disk_version_conflict")
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        else:
            with self._parent_fd(relative_path, create=True) as (parent_fd, name):
                temporary_name = f".{name}.imageweave-{secrets.token_hex(8)}.tmp"
                descriptor = -1
                try:
                    descriptor = os.open(
                        temporary_name,
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL | _CLOSE_ON_EXEC | _NO_FOLLOW,
                        0o600,
                        dir_fd=parent_fd,
                    )
                    with os.fdopen(descriptor, "wb", closefd=True) as handle:
                        descriptor = -1
                        handle.write(payload)
                        handle.flush()
                        os.fsync(handle.fileno())
                    if self.disk_version(relative_path, allow_missing=True) != expected_disk_version:
                        raise UnsafeSourcePathError(relative_path, "disk_version_conflict")
                    os.replace(
                        temporary_name,
                        name,
                        src_dir_fd=parent_fd,
                        dst_dir_fd=parent_fd,
                    )
                    os.fsync(parent_fd)
                finally:
                    if descriptor >= 0:
                        os.close(descriptor)
                    try:
                        os.unlink(temporary_name, dir_fd=parent_fd)
                    except FileNotFoundError:
                        pass
        metadata = self.stat_regular(relative_path)
        next_version = self.disk_version(relative_path)
        return metadata, next_version

    def unlink_if_version(self, relative_path: str, *, expected_disk_version: str) -> None:
        if self.disk_version(relative_path, allow_missing=True) != expected_disk_version:
            raise UnsafeSourcePathError(relative_path, "disk_version_conflict")
        self.unlink_regular(relative_path)

    def ensure_directory(self, relative_directory: str) -> None:
        parts = validate_relative_path(relative_directory, allow_root=True)
        if not parts:
            return
        marker = "/".join((*parts, ".imageweave-directory-marker"))
        if not _HAS_DIR_FD:
            target = self.path
            for component in parts:
                target /= component
                target.mkdir(exist_ok=True)
                if _is_reparse_path(target) or not target.is_dir():
                    raise UnsafeSourcePathError(relative_directory, "unsafe_parent")
            return
        with self._parent_fd(marker, create=True):
            return

    def move_regular(
        self,
        source_relative: str,
        target_relative: str,
        *,
        create_target_parents: bool = True,
    ) -> None:
        if not _HAS_DIR_FD:
            source = self._fallback_path(source_relative)
            target = self._fallback_path(
                target_relative,
                allow_missing_leaf=True,
                create_parents=create_target_parents,
            )
            if target.exists() or _is_reparse_path(target):
                raise FileExistsError(target)
            source_metadata = source.stat(follow_symlinks=False)
            if not stat.S_ISREG(source_metadata.st_mode):
                raise UnsafeSourcePathError(source_relative, "leaf_not_regular")
            os.link(source, target, follow_symlinks=False)
            try:
                current_metadata = source.stat(follow_symlinks=False)
                target_metadata = target.stat(follow_symlinks=False)
                identity = (source_metadata.st_dev, source_metadata.st_ino)
                if (
                    not stat.S_ISREG(current_metadata.st_mode)
                    or not stat.S_ISREG(target_metadata.st_mode)
                    or (current_metadata.st_dev, current_metadata.st_ino) != identity
                    or (target_metadata.st_dev, target_metadata.st_ino) != identity
                ):
                    raise UnsafeSourcePathError(source_relative, "leaf_changed")
                source.unlink()
            except Exception:
                target.unlink(missing_ok=True)
                raise
            return
        with self._parent_fd(source_relative) as (source_parent, source_name):
            with self._parent_fd(
                target_relative, create=create_target_parents
            ) as (target_parent, target_name):
                descriptor = -1
                target_created = False
                try:
                    descriptor = os.open(
                        source_name,
                        os.O_RDONLY | _CLOSE_ON_EXEC | _NO_FOLLOW,
                        dir_fd=source_parent,
                    )
                    source_metadata = os.fstat(descriptor)
                    if not stat.S_ISREG(source_metadata.st_mode):
                        raise UnsafeSourcePathError(
                            source_relative, "leaf_not_regular"
                        )
                    os.link(
                        source_name,
                        target_name,
                        src_dir_fd=source_parent,
                        dst_dir_fd=target_parent,
                        follow_symlinks=False,
                    )
                    target_created = True
                    current_metadata = os.stat(
                        source_name, dir_fd=source_parent, follow_symlinks=False
                    )
                    target_metadata = os.stat(
                        target_name, dir_fd=target_parent, follow_symlinks=False
                    )
                    identity = (source_metadata.st_dev, source_metadata.st_ino)
                    if (
                        not stat.S_ISREG(current_metadata.st_mode)
                        or not stat.S_ISREG(target_metadata.st_mode)
                        or (current_metadata.st_dev, current_metadata.st_ino) != identity
                        or (target_metadata.st_dev, target_metadata.st_ino) != identity
                    ):
                        raise UnsafeSourcePathError(source_relative, "leaf_changed")
                    os.unlink(source_name, dir_fd=source_parent)
                    target_created = False
                except OSError as error:
                    if isinstance(error, FileExistsError):
                        raise
                    raise UnsafeSourcePathError(
                        source_relative, "file_unavailable"
                    ) from error
                finally:
                    if target_created:
                        try:
                            os.unlink(target_name, dir_fd=target_parent)
                        except OSError:
                            pass
                    if descriptor >= 0:
                        os.close(descriptor)
                os.fsync(source_parent)
                if target_parent != source_parent:
                    os.fsync(target_parent)

    def unlink_regular(self, relative_path: str, *, missing_ok: bool = False) -> None:
        if not _HAS_DIR_FD:
            target = self._fallback_path(relative_path)
            target.unlink(missing_ok=missing_ok)
            return
        with self._parent_fd(relative_path) as (parent_fd, name):
            try:
                descriptor = os.open(
                    name,
                    os.O_RDONLY | _CLOSE_ON_EXEC | _NO_FOLLOW,
                    dir_fd=parent_fd,
                )
            except FileNotFoundError:
                if missing_ok:
                    return
                raise
            except OSError as error:
                raise UnsafeSourcePathError(relative_path, "file_unavailable") from error
            try:
                if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                    raise UnsafeSourcePathError(relative_path, "leaf_not_regular")
            finally:
                os.close(descriptor)
            os.unlink(name, dir_fd=parent_fd)
            os.fsync(parent_fd)

    def iter_tree(self, *, excluded_directories: frozenset[str]) -> Iterator[SafeDirectoryEntry]:
        if not _HAS_DIR_FD:
            yield from self._iter_tree_fallback(excluded_directories)
            return
        stack: list[tuple[str, str, int]] = [("", "", os.dup(self.root_fd))]
        while stack:
            relative, name, descriptor = stack.pop()
            children: list[tuple[str, str, int]] = []
            files: list[tuple[str, os.stat_result]] = []
            try:
                with os.scandir(descriptor) as entries:
                    for entry in entries:
                        if _is_reparse_entry(entry):
                            continue
                        try:
                            metadata = entry.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        child_relative = (
                            f"{relative}/{entry.name}" if relative else entry.name
                        )
                        if stat.S_ISDIR(metadata.st_mode):
                            if entry.name in excluded_directories:
                                continue
                            try:
                                child_fd = os.open(
                                    entry.name,
                                    os.O_RDONLY
                                    | _OPEN_DIRECTORY
                                    | _CLOSE_ON_EXEC
                                    | _NO_FOLLOW,
                                    dir_fd=descriptor,
                                )
                            except OSError:
                                continue
                            children.append((child_relative, entry.name, child_fd))
                        elif stat.S_ISREG(metadata.st_mode):
                            files.append((entry.name, metadata))
                files.sort(key=lambda item: item[0])
                yield SafeDirectoryEntry(relative, name, tuple(files))
                for child in reversed(sorted(children, key=lambda item: item[1])):
                    stack.append(child)
            finally:
                os.close(descriptor)

    def _iter_tree_fallback(
        self, excluded_directories: frozenset[str]
    ) -> Iterator[SafeDirectoryEntry]:
        stack: list[tuple[str, str]] = [("", "")]
        while stack:
            relative, name = stack.pop()
            absolute = self.path / relative if relative else self.path
            if _is_reparse_path(absolute):
                raise UnsafeSourcePathError(relative, "unsafe_parent")
            children: list[tuple[str, str]] = []
            files: list[tuple[str, os.stat_result]] = []
            with os.scandir(absolute) as entries:
                for entry in entries:
                    if _is_reparse_entry(entry):
                        continue
                    metadata = entry.stat(follow_symlinks=False)
                    child_relative = f"{relative}/{entry.name}" if relative else entry.name
                    if stat.S_ISDIR(metadata.st_mode):
                        if entry.name not in excluded_directories:
                            children.append((child_relative, entry.name))
                    elif stat.S_ISREG(metadata.st_mode):
                        files.append((entry.name, metadata))
            files.sort(key=lambda item: item[0])
            yield SafeDirectoryEntry(relative, name, tuple(files))
            stack.extend(reversed(sorted(children, key=lambda item: item[1])))


__all__ = [
    "SafeDirectoryEntry",
    "SafeFileStat",
    "SafeSourceRoot",
    "UnsafeSourcePathError",
    "validate_relative_path",
]
