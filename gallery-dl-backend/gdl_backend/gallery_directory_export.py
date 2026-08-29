"""Short-lived, Gallery-owned safe directory copy operations.

The service deliberately owns no SQLite job/item state.  Gallery directory IDs
are resolved server-side, allow-listed files are copied byte-for-byte, and each
selected directory is committed independently with no-clobber semantics.
"""

from __future__ import annotations

import contextlib
import ctypes
import errno
import logging
import os
import secrets
import stat
import sys
import threading
import unicodedata
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .gallery_catalog import (
    IMAGEWEAVE_RESERVED_DIR,
    IMAGEWEAVE_TEMP_DIRECTORY_PREFIXES,
    SUPPORTED_IMAGE_EXTENSIONS,
    canonical_root_key,
    root_relation,
)
from .gallery_safe_paths import (
    GalleryFilesystemLocks,
    SafeSourceRoot,
    UnsafeSourcePathError,
    is_reparse_path,
    validate_relative_path,
)
from .redaction import safe_exception_category


logger = logging.getLogger(__name__)

ALLOWED_DIRECTORY_EXPORT_EXTENSIONS: frozenset[str] = frozenset(
    {*SUPPORTED_IMAGE_EXTENSIONS, ".txt"}
)
MAX_DIRECTORY_EXPORT_SELECTIONS = 500
MAX_DIRECTORY_EXPORT_ID_LENGTH = 128
_DIRECTORY_EXPORT_STATES: frozenset[str] = frozenset(
    {"copying", "completed", "failed", "cancelled"}
)
_EXCLUDED_DIRECTORY_NAMES = frozenset({IMAGEWEAVE_RESERVED_DIR})
_TEMPORARY_PREFIX = IMAGEWEAVE_TEMP_DIRECTORY_PREFIXES[0]
_OPEN_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_NO_FOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOSE_ON_EXEC = getattr(os, "O_CLOEXEC", 0)
_BINARY = getattr(os, "O_BINARY", 0)
_HAS_DIR_FD = os.open in os.supports_dir_fd and os.stat in os.supports_dir_fd
_MAX_OPERATIONS = 128
_MAX_ACTIVE_OPERATIONS = 4
_NO_CLOBBER_UNSUPPORTED_ERRNOS = frozenset(
    {errno.ENOSYS, errno.EINVAL, getattr(errno, "EOPNOTSUPP", errno.ENOTSUP)}
)


class GalleryDirectoryExportError(Exception):
    def __init__(self, code: str, details: Mapping[str, Any] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.details = dict(details or {})


class _CopyCancelled(Exception):
    pass


@dataclass(frozen=True)
class _Selection:
    directory_id: str
    source_id: str
    directory_relative_path: str
    directory_name: str
    source_root_path: str
    source_root_key: str
    directory_key: str
    source_root_identity: tuple[int, int]


class _TargetRoot:
    """Descriptor-anchored target root used only for service-owned temp trees."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._fd: int | None = None
        self._identity: tuple[int, int] | None = None
        self._owned_directory_identities: dict[str, tuple[int, int]] = {}

    def __enter__(self) -> "_TargetRoot":
        self.open()
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()

    @property
    def fd(self) -> int:
        self.open()
        assert self._fd is not None
        return self._fd

    @property
    def identity(self) -> tuple[int, int]:
        self.open()
        assert self._identity is not None
        return self._identity

    def open(self) -> None:
        if self._fd is not None or self._identity is not None:
            return
        if not _HAS_DIR_FD:
            # Windows CRT 无法以描述符锚定目录（os.open 打开目录直接
            # PermissionError）：走组件级 lstat 校验，身份取根 lstat。
            metadata = _validate_absolute_directory_components(self.path)
            self._identity = (int(metadata.st_dev), int(metadata.st_ino))
            return
        descriptor = _open_absolute_directory(self.path)
        metadata = os.fstat(descriptor)
        self._fd = descriptor
        self._identity = (int(metadata.st_dev), int(metadata.st_ino))

    def close(self) -> None:
        descriptor, self._fd = self._fd, None
        self._identity = None
        self._owned_directory_identities.clear()
        if descriptor is not None:
            os.close(descriptor)

    def verify_identity(self) -> None:
        assert self._identity is not None
        if not _HAS_DIR_FD:
            metadata = _validate_absolute_directory_components(self.path)
            if (int(metadata.st_dev), int(metadata.st_ino)) != self._identity:
                raise GalleryDirectoryExportError("target_root_changed")
            return
        descriptor = _open_absolute_directory(self.path)
        try:
            metadata = os.fstat(descriptor)
            if (int(metadata.st_dev), int(metadata.st_ino)) != self._identity:
                raise GalleryDirectoryExportError("target_root_changed")
        finally:
            os.close(descriptor)

    def _directory_identity(self, name: str) -> tuple[int, int] | None:
        _validate_owned_temp_name(name)
        self.verify_identity()
        try:
            if _HAS_DIR_FD:
                metadata = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            else:
                path = self.path / name
                metadata = path.lstat()
                if is_reparse_path(path):
                    raise GalleryDirectoryExportError("target_path_changed")
        except FileNotFoundError:
            return None
        if not stat.S_ISDIR(metadata.st_mode):
            raise GalleryDirectoryExportError("target_path_changed")
        return int(metadata.st_dev), int(metadata.st_ino)

    def _require_owned_directory(self, name: str) -> tuple[int, int]:
        expected = self._owned_directory_identities.get(name)
        if expected is None or self._directory_identity(name) != expected:
            raise GalleryDirectoryExportError("target_path_changed")
        return expected
    def entry_exists(self, name: str) -> bool:
        _validate_leaf_name(name)
        self.verify_identity()
        if _HAS_DIR_FD:
            try:
                os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            except FileNotFoundError:
                return False
            return True
        _validate_absolute_directory_components(self.path)
        try:
            (self.path / name).lstat()
        except FileNotFoundError:
            return False
        return True

    def create_owned_directory(self, name: str) -> None:
        _validate_owned_temp_name(name)
        self.verify_identity()
        if _HAS_DIR_FD:
            os.mkdir(name, mode=0o700, dir_fd=self.fd)
            os.fsync(self.fd)
        else:
            (self.path / name).mkdir(mode=0o700)
            _validate_absolute_directory_components(self.path / name)
        identity = self._directory_identity(name)
        if identity is None:
            raise GalleryDirectoryExportError("target_path_changed")
        self._owned_directory_identities[name] = identity

    @contextlib.contextmanager
    def open_output_file(self, temporary_name: str, relative_path: str) -> Any:
        _validate_owned_temp_name(temporary_name)
        expected_temporary_identity = self._require_owned_directory(temporary_name)
        parts = validate_relative_path(relative_path)
        self.verify_identity()
        if not _HAS_DIR_FD:
            root = _ensure_fallback_directory(
                self.path / temporary_name, ()
            )
            if self._directory_identity(temporary_name) != expected_temporary_identity:
                raise GalleryDirectoryExportError("target_path_changed")
            parent = _ensure_fallback_directory(root, parts[:-1])
            target = parent / parts[-1]
            flags = (
                os.O_WRONLY
                | os.O_CREAT
                | os.O_EXCL
                | _CLOSE_ON_EXEC
                | _BINARY
            )
            try:
                descriptor = os.open(target, flags, 0o600)
            except FileExistsError as error:
                raise GalleryDirectoryExportError("target_path_unsafe") from error
            try:
                metadata = os.fstat(descriptor)
                if not stat.S_ISREG(metadata.st_mode):
                    raise GalleryDirectoryExportError("target_path_unsafe")
                expected_identity = (int(metadata.st_dev), int(metadata.st_ino))
                _verify_fallback_regular_file(target, expected_identity)
                with os.fdopen(descriptor, "wb", closefd=True) as handle:
                    descriptor = -1
                    yield handle
                    _verify_fallback_regular_file(target, expected_identity)
            finally:
                if descriptor >= 0:
                    os.close(descriptor)
            return

        descriptor = os.dup(self.fd)
        try:
            descriptor = _open_child_directory(descriptor, temporary_name, create=False)
            temporary_metadata = os.fstat(descriptor)
            if (
                int(temporary_metadata.st_dev),
                int(temporary_metadata.st_ino),
            ) != expected_temporary_identity:
                raise GalleryDirectoryExportError("target_path_changed")
            for component in parts[:-1]:
                descriptor = _open_child_directory(descriptor, component, create=True)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | _CLOSE_ON_EXEC | _NO_FOLLOW
            file_descriptor = -1
            try:
                file_descriptor = os.open(
                    parts[-1], flags, 0o600, dir_fd=descriptor
                )
                metadata = os.fstat(file_descriptor)
                if not stat.S_ISREG(metadata.st_mode):
                    raise GalleryDirectoryExportError("target_path_unsafe")
                expected_identity = (int(metadata.st_dev), int(metadata.st_ino))
                raw_handle = os.fdopen(file_descriptor, "wb", closefd=True)
                file_descriptor = -1
                with raw_handle as handle:
                    yield handle
                    try:
                        current = os.stat(
                            parts[-1], dir_fd=descriptor, follow_symlinks=False
                        )
                    except OSError as error:
                        raise GalleryDirectoryExportError(
                            "target_path_changed"
                        ) from error
                    if (
                        not stat.S_ISREG(current.st_mode)
                        or (int(current.st_dev), int(current.st_ino))
                        != expected_identity
                    ):
                        raise GalleryDirectoryExportError("target_path_changed")
            finally:
                if file_descriptor >= 0:
                    os.close(file_descriptor)
        finally:
            os.close(descriptor)

    def validate_owned_directory(self, name: str) -> None:
        _validate_owned_temp_name(name)
        self._require_owned_directory(name)
        self.verify_identity()
        if _HAS_DIR_FD:
            _validate_tree_at(self.fd, name)
        else:
            _validate_fallback_tree(self.path / name)


    def commit_owned_directory(self, temporary_name: str, final_name: str) -> None:
        self.validate_owned_directory(temporary_name)
        _validate_leaf_name(final_name)
        try:
            if self.entry_exists(final_name):
                raise FileExistsError(final_name)
            _rename_directory_noreplace(
                parent_fd=self._fd if _HAS_DIR_FD else -1,
                parent_path=self.path,
                source_name=temporary_name,
                target_name=final_name,
            )
            self._owned_directory_identities.pop(temporary_name, None)
        except FileExistsError as error:
            raise GalleryDirectoryExportError(
                "target_name_conflict", {"names": [final_name]}
            ) from error
        if _HAS_DIR_FD:
            os.fsync(self.fd)

    def remove_owned_directory(self, name: str) -> bool:
        _validate_owned_temp_name(name)
        try:
            self._require_owned_directory(name)
        except (GalleryDirectoryExportError, OSError):
            return False
        if _HAS_DIR_FD:
            try:
                _remove_tree_at(self.fd, name)
                removed = not self.entry_exists(name)
                if removed:
                    self._owned_directory_identities.pop(name, None)
                return removed
            except (GalleryDirectoryExportError, OSError):
                return False
        try:
            _remove_fallback_tree(self.path / name)
            removed = not self.entry_exists(name)
            if removed:
                self._owned_directory_identities.pop(name, None)
            return removed
        except (GalleryDirectoryExportError, OSError):
            return False



def _file_version(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        int(metadata.st_dev),
        int(metadata.st_ino),
        int(metadata.st_size),
        int(
            getattr(metadata, "st_mtime_ns", metadata.st_mtime * 1_000_000_000)
        ),
        int(
            getattr(metadata, "st_ctime_ns", metadata.st_ctime * 1_000_000_000)
        ),
    )

_TargetFileSnapshot = tuple[int, int, int, int, int]

def _portable_name_key(name: str) -> str:
    return unicodedata.normalize("NFC", name).casefold()


def _validate_leaf_name(name: str) -> None:
    if (
        not isinstance(name, str)
        or not name
        or name in {".", ".."}
        or "/" in name
        or "\\" in name
        or "\x00" in name
    ):
        raise GalleryDirectoryExportError("directory_name_invalid")


def _validate_owned_temp_name(name: str) -> None:
    _validate_leaf_name(name)
    if not name.startswith(_TEMPORARY_PREFIX):
        raise GalleryDirectoryExportError("temporary_name_invalid")


def _validate_absolute_directory_components(path: Path) -> os.stat_result:
    current = Path(path.anchor)
    try:
        metadata = current.lstat()
    except OSError as error:
        raise GalleryDirectoryExportError("target_unavailable") from error
    if is_reparse_path(current):
        raise GalleryDirectoryExportError("target_path_unsafe")
    if not stat.S_ISDIR(metadata.st_mode):
        raise GalleryDirectoryExportError("target_not_directory")
    anchor_parts = len(current.parts)
    for component in path.parts[anchor_parts:]:
        current = current / component
        try:
            metadata = current.lstat()
        except OSError as error:
            raise GalleryDirectoryExportError("target_unavailable") from error
        if is_reparse_path(current):
            raise GalleryDirectoryExportError("target_path_unsafe")
        if not stat.S_ISDIR(metadata.st_mode):
            raise GalleryDirectoryExportError("target_not_directory")
    return metadata


def _ensure_fallback_directory(root: Path, components: Sequence[str]) -> Path:
    current = root
    _validate_absolute_directory_components(current)
    for component in components:
        current = current / component
        try:
            current.mkdir(mode=0o700)
        except FileExistsError:
            pass
        _validate_absolute_directory_components(current)
    return current


def _verify_fallback_regular_file(
    path: Path, expected_identity: tuple[int, int]
) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise GalleryDirectoryExportError("target_path_changed") from error
    if is_reparse_path(path) or not stat.S_ISREG(metadata.st_mode):
        raise GalleryDirectoryExportError("target_path_unsafe")
    if (int(metadata.st_dev), int(metadata.st_ino)) != expected_identity:
        raise GalleryDirectoryExportError("target_path_changed")


def _validate_fallback_tree(root: Path) -> None:
    stack = [root]
    while stack:
        current = stack.pop()
        _validate_absolute_directory_components(current)
        with os.scandir(current) as entries:
            for entry in entries:
                child = current / entry.name
                if is_reparse_path(child):
                    raise GalleryDirectoryExportError("target_path_unsafe")
                metadata = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(metadata.st_mode):
                    stack.append(child)
                elif not stat.S_ISREG(metadata.st_mode):
                    raise GalleryDirectoryExportError("target_path_unsafe")


def _remove_fallback_tree(path: Path) -> None:
    try:
        metadata = path.lstat()
    except OSError:
        return
    if is_reparse_path(path):
        try:
            if stat.S_ISDIR(metadata.st_mode):
                path.rmdir()
            else:
                path.unlink()
        except OSError:
            pass
        return
    if stat.S_ISDIR(metadata.st_mode):
        try:
            with os.scandir(path) as entries:
                children = [path / entry.name for entry in entries]
        except OSError:
            return
        for child in children:
            _remove_fallback_tree(child)
        try:
            path.rmdir()
        except OSError:
            pass
        return
    try:
        path.unlink()
    except OSError:
        pass


def _open_absolute_directory(path: Path) -> int:
    if not path.is_absolute():
        raise GalleryDirectoryExportError("target_path_not_absolute")
    if not _HAS_DIR_FD:
        expected = _validate_absolute_directory_components(path)
        try:
            descriptor = os.open(path, os.O_RDONLY | _OPEN_DIRECTORY | _CLOSE_ON_EXEC)
        except OSError as error:
            raise GalleryDirectoryExportError("target_unavailable") from error
        try:
            actual = os.fstat(descriptor)
            observed = _validate_absolute_directory_components(path)
            expected_identity = (expected.st_dev, expected.st_ino)
            if (actual.st_dev, actual.st_ino) != expected_identity or (
                observed.st_dev,
                observed.st_ino,
            ) != expected_identity:
                raise GalleryDirectoryExportError("target_path_changed")
            return descriptor
        except Exception:
            os.close(descriptor)
            raise

    anchor = Path(path.anchor)
    try:
        descriptor = os.open(
            anchor,
            os.O_RDONLY | _OPEN_DIRECTORY | _CLOSE_ON_EXEC | _NO_FOLLOW,
        )
    except OSError as error:
        raise GalleryDirectoryExportError("target_unavailable") from error
    try:
        anchor_parts = len(anchor.parts)
        for component in path.parts[anchor_parts:]:
            try:
                child = os.open(
                    component,
                    os.O_RDONLY | _OPEN_DIRECTORY | _CLOSE_ON_EXEC | _NO_FOLLOW,
                    dir_fd=descriptor,
                )
            except FileNotFoundError as error:
                raise GalleryDirectoryExportError("target_unavailable") from error
            except OSError as error:
                raise GalleryDirectoryExportError("target_path_unsafe") from error
            metadata = os.fstat(child)
            if not stat.S_ISDIR(metadata.st_mode):
                os.close(child)
                raise GalleryDirectoryExportError("target_not_directory")
            os.close(descriptor)
            descriptor = child
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _open_child_directory(parent_fd: int, name: str, *, create: bool) -> int:
    if create:
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent_fd)
        except FileExistsError:
            pass
    try:
        child = os.open(
            name,
            os.O_RDONLY | _OPEN_DIRECTORY | _CLOSE_ON_EXEC | _NO_FOLLOW,
            dir_fd=parent_fd,
        )
    except OSError:
        raise
    metadata = os.fstat(child)
    if not stat.S_ISDIR(metadata.st_mode):
        os.close(child)
        raise GalleryDirectoryExportError("target_path_unsafe")
    os.close(parent_fd)
    return child


def _validate_tree_at(parent_fd: int, name: str) -> None:
    try:
        metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as error:
        raise GalleryDirectoryExportError("target_path_changed") from error
    if not stat.S_ISDIR(metadata.st_mode):
        raise GalleryDirectoryExportError("target_path_unsafe")
    try:
        child_fd = os.open(
            name,
            os.O_RDONLY | _OPEN_DIRECTORY | _CLOSE_ON_EXEC | _NO_FOLLOW,
            dir_fd=parent_fd,
        )
    except OSError as error:
        raise GalleryDirectoryExportError("target_path_unsafe") from error
    try:
        with os.scandir(child_fd) as entries:
            names = [entry.name for entry in entries]
        for child_name in names:
            try:
                child_metadata = os.stat(
                    child_name, dir_fd=child_fd, follow_symlinks=False
                )
            except OSError as error:
                raise GalleryDirectoryExportError("target_path_changed") from error
            if stat.S_ISDIR(child_metadata.st_mode):
                _validate_tree_at(child_fd, child_name)
            elif not stat.S_ISREG(child_metadata.st_mode):
                raise GalleryDirectoryExportError("target_path_unsafe")
    finally:
        os.close(child_fd)

def _remove_tree_at(parent_fd: int, name: str) -> None:
    try:
        metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(metadata.st_mode):
        os.unlink(name, dir_fd=parent_fd)
        return
    child_fd = os.open(
        name,
        os.O_RDONLY | _OPEN_DIRECTORY | _CLOSE_ON_EXEC | _NO_FOLLOW,
        dir_fd=parent_fd,
    )
    try:
        with os.scandir(child_fd) as entries:
            names = [entry.name for entry in entries]
        for child_name in names:
            _remove_tree_at(child_fd, child_name)
    finally:
        os.close(child_fd)
    os.rmdir(name, dir_fd=parent_fd)


def _rename_directory_noreplace(
    *, parent_fd: int, parent_path: Path, source_name: str, target_name: str
) -> None:
    if sys.platform.startswith("linux") and _HAS_DIR_FD:
        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = getattr(libc, "renameat2", None)
        if renameat2 is None:
            raise GalleryDirectoryExportError("no_clobber_unsupported")
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameat2.restype = ctypes.c_int
        result = renameat2(
            parent_fd,
            os.fsencode(source_name),
            parent_fd,
            os.fsencode(target_name),
            1,  # RENAME_NOREPLACE
        )
        if result != 0:
            code = ctypes.get_errno()
            if code in {errno.EEXIST, errno.ENOTEMPTY}:
                raise FileExistsError(target_name)
            if code in _NO_CLOBBER_UNSUPPORTED_ERRNOS:
                raise GalleryDirectoryExportError("no_clobber_unsupported")
            raise OSError(code, os.strerror(code), target_name)
        return

    if sys.platform == "darwin" and _HAS_DIR_FD:
        libc = ctypes.CDLL(None, use_errno=True)
        renameatx_np = getattr(libc, "renameatx_np", None)
        if renameatx_np is None:
            raise GalleryDirectoryExportError("no_clobber_unsupported")
        renameatx_np.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameatx_np.restype = ctypes.c_int
        result = renameatx_np(
            parent_fd,
            os.fsencode(source_name),
            parent_fd,
            os.fsencode(target_name),
            0x00000004,  # RENAME_EXCL
        )
        if result != 0:
            code = ctypes.get_errno()
            if code in {errno.EEXIST, errno.ENOTEMPTY}:
                raise FileExistsError(target_name)
            if code in _NO_CLOBBER_UNSUPPORTED_ERRNOS:
                raise GalleryDirectoryExportError("no_clobber_unsupported")
            raise OSError(code, os.strerror(code), target_name)
        return

    if os.name == "nt":
        os.rename(parent_path / source_name, parent_path / target_name)
        return
    raise GalleryDirectoryExportError("no_clobber_unsupported")


class GalleryDirectoryExportService:
    """In-memory coordinator for bounded, non-resumable directory copies."""

    def __init__(
        self,
        repository: Any,
        *,
        filesystem_locks: GalleryFilesystemLocks | None = None,
        copy_chunk_size: int = 1024 * 1024,
        before_commit: Callable[[str, str, Path, Path], None] | None = None,
        copy_chunk_hook: Callable[[str, str, int], None] | None = None,
    ) -> None:
        self._repo = repository
        self._filesystem_locks = filesystem_locks or GalleryFilesystemLocks()
        self._copy_chunk_size = max(1024, int(copy_chunk_size))
        self._before_commit = before_commit
        self._copy_chunk_hook = copy_chunk_hook
        self._lock = threading.RLock()
        self._operations: dict[str, dict[str, Any]] = {}
        self._cancel_events: dict[str, threading.Event] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._active_target_keys: set[str] = set()
        self._idempotency: dict[str, str] = {}
        self._stopping = False

    def start(
        self,
        *,
        directory_ids: Sequence[str],
        target_path: str,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            if self._stopping:
                raise GalleryDirectoryExportError("service_stopping")
            if idempotency_key:
                existing_id = self._idempotency.get(idempotency_key)
                if existing_id is not None:
                    return self._project(self._operations[existing_id])
        selections = self._resolve_selections(directory_ids)
        if (
            not isinstance(target_path, str)
            or not target_path
            or "\x00" in target_path
        ):
            raise GalleryDirectoryExportError("target_path_invalid")
        target = Path(target_path)
        try:
            target_key = canonical_root_key(target)
        except (OSError, RuntimeError, ValueError) as error:
            raise GalleryDirectoryExportError("target_path_invalid") from error
        target_identity = self._preflight_target(target, target_key, selections)

        operation_id = str(uuid.uuid4())
        cancel_event = threading.Event()
        operation: dict[str, Any] = {
            "operation_id": operation_id,
            "state": "copying",
            "current_directory_name": None,
            "directory_count": len(selections),
            "completed_directory_count": 0,
            "failed_directory_count": 0,
            "discovered_file_count": 0,
            "copied_file_count": 0,
            "discovered_byte_count": 0,
            "copied_byte_count": 0,
            "error_code": None,
            "successful_directory_names": [],
            "results": [],
            "_target_path": target,
            "_target_key": target_key,
            "_target_identity": target_identity,
            "_selections": selections,
        }
        with self._lock:
            if self._stopping:
                raise GalleryDirectoryExportError("service_stopping")
            if idempotency_key:
                existing_id = self._idempotency.get(idempotency_key)
                if existing_id is not None:
                    return self._project(self._operations[existing_id])
            if target_key in self._active_target_keys:
                raise GalleryDirectoryExportError("target_busy")
            self._prune_locked()
            active_count = sum(
                operation["state"] == "copying"
                for operation in self._operations.values()
            )
            if (
                len(self._operations) >= _MAX_OPERATIONS
                or active_count >= _MAX_ACTIVE_OPERATIONS
            ):
                raise GalleryDirectoryExportError("operation_capacity_reached")
            self._active_target_keys.add(target_key)
            self._operations[operation_id] = operation
            self._cancel_events[operation_id] = cancel_event
            if idempotency_key:
                self._idempotency[idempotency_key] = operation_id
            thread = threading.Thread(
                target=self._run,
                args=(operation_id,),
                name=f"gallery-directory-export-{operation_id[:8]}",
                daemon=True,
            )
            self._threads[operation_id] = thread
            try:
                thread.start()
            except RuntimeError as error:
                self._active_target_keys.discard(target_key)
                self._operations.pop(operation_id, None)
                self._cancel_events.pop(operation_id, None)
                self._threads.pop(operation_id, None)
                if idempotency_key:
                    self._idempotency.pop(idempotency_key, None)
                raise GalleryDirectoryExportError("operation_start_failed") from error
            return self._project(operation)

    def get(self, operation_id: str) -> dict[str, Any]:
        with self._lock:
            operation = self._operations.get(operation_id)
            if operation is None:
                raise GalleryDirectoryExportError("operation_not_found")
            return self._project(operation)

    def cancel(self, operation_id: str) -> dict[str, Any]:
        with self._lock:
            operation = self._operations.get(operation_id)
            if operation is None:
                raise GalleryDirectoryExportError("operation_not_found")
            if operation["state"] == "copying":
                self._cancel_events[operation_id].set()
            return self._project(operation)

    def stop(self) -> None:
        with self._lock:
            self._stopping = True
            for event in self._cancel_events.values():
                event.set()
            threads = list(self._threads.values())
        for thread in threads:
            thread.join(timeout=10.0)

    def _resolve_selections(self, directory_ids: Sequence[str]) -> list[_Selection]:
        if (
            not isinstance(directory_ids, Sequence)
            or isinstance(directory_ids, (str, bytes))
            or not 1 <= len(directory_ids) <= MAX_DIRECTORY_EXPORT_SELECTIONS
            or any(
                not isinstance(item, str)
                or not item
                or len(item) > MAX_DIRECTORY_EXPORT_ID_LENGTH
                for item in directory_ids
            )
            or len(set(directory_ids)) != len(directory_ids)
        ):
            raise GalleryDirectoryExportError("invalid_directory_ids")
        selections: list[_Selection] = []
        names: dict[str, list[str]] = {}
        for directory_id in directory_ids:
            directory = self._repo.get_directory(directory_id)
            if directory is None:
                raise GalleryDirectoryExportError(
                    "directory_not_found", {"directory_id": directory_id}
                )
            source = self._repo.get_source(directory["source_id"])
            if source is None:
                raise GalleryDirectoryExportError("source_not_found")
            if source.get("availability") != "available":
                raise GalleryDirectoryExportError("source_offline")
            relative = str(directory["relative_path"])
            try:
                relative_parts = validate_relative_path(relative, allow_root=True)
            except UnsafeSourcePathError as error:
                raise GalleryDirectoryExportError("unsafe_source_path") from error
            if any(
                component == IMAGEWEAVE_RESERVED_DIR
                or any(
                    component.startswith(prefix)
                    for prefix in IMAGEWEAVE_TEMP_DIRECTORY_PREFIXES
                )
                for component in relative_parts
            ):
                raise GalleryDirectoryExportError("unsafe_source_path")
            name = (
                Path(source["root_path"]).name
                if not relative
                else relative_parts[-1]
            )
            _validate_leaf_name(name)
            try:
                with SafeSourceRoot(source["root_path"]) as safe_root:
                    source_root_identity = safe_root.root_identity()
                    iterator = safe_root.iter_subtree(
                        relative,
                        excluded_directories=_EXCLUDED_DIRECTORY_NAMES,
                        excluded_directory_prefixes=IMAGEWEAVE_TEMP_DIRECTORY_PREFIXES,
                    )
                    try:
                        next(iterator)
                    finally:
                        iterator.close()
            except (OSError, StopIteration, UnsafeSourcePathError) as error:
                raise GalleryDirectoryExportError(
                    "unsafe_source_path", {"directory_name": name}
                ) from error
            try:
                directory_key = canonical_root_key(
                    Path(source["root_path"]).joinpath(*relative_parts)
                )
            except (OSError, RuntimeError, ValueError) as error:
                raise GalleryDirectoryExportError(
                    "unsafe_source_path", {"directory_name": name}
                ) from error
            selection = _Selection(
                directory_id=directory_id,
                source_id=source["source_id"],
                directory_relative_path=relative,
                directory_name=name,
                source_root_path=source["root_path"],
                source_root_key=source["canonical_root_key"],
                directory_key=directory_key,
                source_root_identity=source_root_identity,
            )
            selections.append(selection)
            names.setdefault(_portable_name_key(name), []).append(name)
        duplicate_names = sorted(
            {item for grouped in names.values() if len(grouped) > 1 for item in grouped},
            key=_portable_name_key,
        )
        if duplicate_names:
            raise GalleryDirectoryExportError(
                "selected_name_conflict", {"names": duplicate_names[:50]}
            )
        return selections

    def _preflight_target(
        self,
        target: Path,
        target_key: str,
        selections: Sequence[_Selection],
    ) -> tuple[int, int]:
        if not target.is_absolute():
            raise GalleryDirectoryExportError("target_path_not_absolute")
        for selection in selections:
            if root_relation(target_key, selection.directory_key) in {
                "same",
                "descendant",
            }:
                raise GalleryDirectoryExportError(
                    "target_inside_source",
                    {"directory_name": selection.directory_name},
                )
        try:
            with _TargetRoot(target) as target_root:
                conflicts = sorted(
                    [
                        selection.directory_name
                        for selection in selections
                        if target_root.entry_exists(selection.directory_name)
                    ],
                    key=_portable_name_key,
                )
                if conflicts:
                    raise GalleryDirectoryExportError(
                        "target_name_conflict", {"names": conflicts[:50]}
                    )
                probe = f"{_TEMPORARY_PREFIX}probe-{secrets.token_hex(8)}"
                probe_created = False
                try:
                    target_root.create_owned_directory(probe)
                    probe_created = True
                except PermissionError as error:
                    raise GalleryDirectoryExportError("target_not_writable") from error
                finally:
                    if (
                        probe_created
                        and not target_root.remove_owned_directory(probe)
                    ):
                        raise GalleryDirectoryExportError(
                            "temporary_cleanup_failed"
                        )
                return target_root.identity
        except GalleryDirectoryExportError:
            raise
        except PermissionError as error:
            raise GalleryDirectoryExportError("target_not_writable") from error
        except OSError as error:
            raise GalleryDirectoryExportError("target_unavailable") from error

    def _run(self, operation_id: str) -> None:
        with self._lock:
            operation = self._operations[operation_id]
            target = operation["_target_path"]
            target_key = operation["_target_key"]
            target_identity = operation["_target_identity"]
            selections = tuple(operation["_selections"])
            cancel_event = self._cancel_events[operation_id]
        try:
            with self._filesystem_locks.hold(f"target:{target_key}"):
                with _TargetRoot(target) as target_root:
                    if target_root.identity != target_identity:
                        raise GalleryDirectoryExportError("target_root_changed")
                    for index, selection in enumerate(selections):
                        if cancel_event.is_set():
                            self._finish_cancelled(operation_id, selection.directory_name)
                            return
                        with self._filesystem_locks.hold(
                            f"source:{selection.source_id}"
                        ):
                            if not self._copy_selection(
                                operation_id,
                                index,
                                selection,
                                target_root,
                                cancel_event,
                            ):
                                return
                    self._update(operation_id, state="completed", current_directory_name=None)
        except _CopyCancelled:
            current = self.get(operation_id)["current_directory_name"]
            self._finish_cancelled(operation_id, current)
        except GalleryDirectoryExportError as error:
            self._finish_failed(operation_id, error.code)
        except (OSError, UnsafeSourcePathError):
            self._finish_failed(operation_id, "copy_io_error")
        except Exception as error:
            logger.error(
                "gallery directory export failed; category=%s",
                safe_exception_category(error),
            )
            self._finish_failed(operation_id, "internal_error")
        finally:
            with self._lock:
                operation = self._operations[operation_id]
                self._active_target_keys.discard(operation["_target_key"])
                self._threads.pop(operation_id, None)

    def _copy_selection(
        self,
        operation_id: str,
        index: int,
        selection: _Selection,
        target_root: _TargetRoot,
        cancel_event: threading.Event,
    ) -> bool:
        temporary_name = (
            f"{_TEMPORARY_PREFIX}{operation_id}-{index}-{secrets.token_hex(4)}"
        )
        self._update(operation_id, current_directory_name=selection.directory_name)
        file_count = 0
        byte_count = 0
        temporary_created = False
        target_directories: set[str] = {""}
        target_snapshots: dict[str, _TargetFileSnapshot] = {}
        try:
            self._revalidate_selection(selection)
            target_root.create_owned_directory(temporary_name)
            temporary_created = True
            with SafeSourceRoot(selection.source_root_path) as safe_root:
                if safe_root.root_identity() != (
                    selection.source_root_identity
                ):
                    raise GalleryDirectoryExportError("source_changed")
                for directory in safe_root.iter_subtree(
                    selection.directory_relative_path,
                    excluded_directories=_EXCLUDED_DIRECTORY_NAMES,
                    excluded_directory_prefixes=IMAGEWEAVE_TEMP_DIRECTORY_PREFIXES,
                ):
                    output_directory = _relative_to_selection(
                        directory.relative_path, selection.directory_relative_path
                    )
                    for file_name, file_metadata in directory.files:
                        extension = Path(file_name).suffix.casefold()
                        if extension not in ALLOWED_DIRECTORY_EXPORT_EXTENSIONS:
                            continue
                        source_relative = (
                            f"{directory.relative_path}/{file_name}"
                            if directory.relative_path
                            else file_name
                        )
                        output_relative = (
                            f"{output_directory}/{file_name}"
                            if output_directory
                            else file_name
                        )
                        output_parent_parts = output_relative.split("/")[:-1]
                        target_directories.update(
                            "/".join(output_parent_parts[:depth])
                            for depth in range(1, len(output_parent_parts) + 1)
                        )
                        self._increment(
                            operation_id,
                            discovered_file_count=1,
                            discovered_byte_count=int(file_metadata.st_size),
                        )
                        copied, target_snapshot = self._copy_file(
                            operation_id,
                            safe_root,
                            source_relative,
                            file_metadata,
                            target_root,
                            temporary_name,
                            output_relative,
                            cancel_event,
                        )
                        target_snapshots[output_relative] = target_snapshot
                        file_count += 1
                        byte_count += copied
            if cancel_event.is_set():
                raise _CopyCancelled()
            if self._before_commit is not None:
                self._before_commit(
                    operation_id,
                    selection.directory_name,
                    target_root.path / temporary_name,
                    target_root.path / selection.directory_name,
                )
            if cancel_event.is_set():
                raise _CopyCancelled()
            with SafeSourceRoot(selection.source_root_path) as validation_root:
                if validation_root.root_identity() != (
                    selection.source_root_identity
                ):
                    raise GalleryDirectoryExportError("source_changed")
            self._validate_target_snapshot(
                target_root,
                temporary_name,
                target_directories,
                target_snapshots,
                cancel_event,
            )
            target_root.commit_owned_directory(
                temporary_name, selection.directory_name
            )
            temporary_created = False
            self._append_result(
                operation_id,
                {
                    "directory_name": selection.directory_name,
                    "status": "completed",
                    "copied_file_count": file_count,
                    "copied_byte_count": byte_count,
                    "error_code": None,
                },
                completed=True,
            )
            return True
        except _CopyCancelled:
            if temporary_created and not self._cleanup_temporary(
                operation_id,
                selection,
                target_root,
                temporary_name,
                file_count,
                byte_count,
            ):
                return False
            self._append_result(
                operation_id,
                {
                    "directory_name": selection.directory_name,
                    "status": "cancelled",
                    "copied_file_count": file_count,
                    "copied_byte_count": byte_count,
                    "error_code": "cancelled",
                },
            )
            self._finish_cancelled(operation_id, selection.directory_name)
            return False
        except GalleryDirectoryExportError as error:
            if temporary_created and not self._cleanup_temporary(
                operation_id,
                selection,
                target_root,
                temporary_name,
                file_count,
                byte_count,
            ):
                return False
            self._append_result(
                operation_id,
                {
                    "directory_name": selection.directory_name,
                    "status": "failed",
                    "copied_file_count": file_count,
                    "copied_byte_count": byte_count,
                    "error_code": error.code,
                },
                failed=True,
            )
            self._finish_failed(operation_id, error.code)
            return False
        except (OSError, UnsafeSourcePathError):
            if temporary_created and not self._cleanup_temporary(
                operation_id,
                selection,
                target_root,
                temporary_name,
                file_count,
                byte_count,
            ):
                return False
            self._append_result(
                operation_id,
                {
                    "directory_name": selection.directory_name,
                    "status": "failed",
                    "copied_file_count": file_count,
                    "copied_byte_count": byte_count,
                    "error_code": "copy_io_error",
                },
                failed=True,
            )
            self._finish_failed(operation_id, "copy_io_error")
            return False
        except Exception as error:
            logger.error(
                "gallery directory copy failed; category=%s",
                safe_exception_category(error),
            )
            if temporary_created and not self._cleanup_temporary(
                operation_id,
                selection,
                target_root,
                temporary_name,
                file_count,
                byte_count,
            ):
                return False
            self._append_result(
                operation_id,
                {
                    "directory_name": selection.directory_name,
                    "status": "failed",
                    "copied_file_count": file_count,
                    "copied_byte_count": byte_count,
                    "error_code": "internal_error",
                },
                failed=True,
            )
            self._finish_failed(operation_id, "internal_error")
            return False

    def _cleanup_temporary(
        self,
        operation_id: str,
        selection: _Selection,
        target_root: _TargetRoot,
        temporary_name: str,
        file_count: int,
        byte_count: int,
    ) -> bool:
        if target_root.remove_owned_directory(temporary_name):
            return True
        code = "temporary_cleanup_failed"
        self._append_result(
            operation_id,
            {
                "directory_name": selection.directory_name,
                "status": "failed",
                "copied_file_count": file_count,
                "copied_byte_count": byte_count,
                "error_code": code,
            },
            failed=True,
        )
        self._finish_failed(operation_id, code)
        return False

    def _copy_file(
        self,
        operation_id: str,
        safe_root: SafeSourceRoot,
        source_relative: str,
        expected_metadata: os.stat_result,
        target_root: _TargetRoot,
        temporary_name: str,
        output_relative: str,
        cancel_event: threading.Event,
    ) -> tuple[int, _TargetFileSnapshot]:
        source_handle = safe_root.open_binary(source_relative)
        source_version = _file_version(os.fstat(source_handle.fileno()))
        # Windows 的 DirEntry.stat() 来自 WIN32_FIND_DATA，没有文件索引，
        # st_dev/st_ino 恒为 0，无法与 fstat 的真实身份比较；大小与时间戳
        # 在两个 API 族之间一致，身份仅在枚举给出真实 st_ino 时才可比。
        expected_version = _file_version(expected_metadata)
        if (
            source_version[2:] != expected_version[2:]
            or (
                expected_version[1] != 0
                and source_version[:2] != expected_version[:2]
            )
        ):
            source_handle.close()
            raise GalleryDirectoryExportError("source_changed")
        copied = 0
        target_version: _TargetFileSnapshot | None = None
        try:
            with target_root.open_output_file(
                temporary_name, output_relative
            ) as target_handle:
                while True:
                    if cancel_event.is_set():
                        raise _CopyCancelled()
                    chunk = source_handle.read(self._copy_chunk_size)
                    if not chunk:
                        break
                    target_handle.write(chunk)
                    copied += len(chunk)
                    self._increment(
                        operation_id,
                        copied_byte_count=len(chunk),
                    )
                    if self._copy_chunk_hook is not None:
                        self._copy_chunk_hook(operation_id, output_relative, copied)
                target_handle.flush()
                os.fsync(target_handle.fileno())
                if (
                    _file_version(os.fstat(source_handle.fileno())) != source_version
                    or copied != source_version[2]
                ):
                    raise GalleryDirectoryExportError("source_changed")
                target_version = _file_version(os.fstat(target_handle.fileno()))
        finally:
            source_handle.close()
        assert target_version is not None
        self._increment(operation_id, copied_file_count=1)
        return copied, target_version

    def _validate_target_snapshot(
        self,
        target_root: _TargetRoot,
        temporary_name: str,
        expected_directories: set[str],
        expected_files: Mapping[str, _TargetFileSnapshot],
        cancel_event: threading.Event,
    ) -> None:
        target_root.validate_owned_directory(temporary_name)
        expected_root_identity = target_root._require_owned_directory(temporary_name)
        seen_directories: set[str] = set()
        seen_files: set[str] = set()
        try:
            with SafeSourceRoot(target_root.path / temporary_name) as staged_root:
                if staged_root.root_identity() != (
                    expected_root_identity
                ):
                    raise GalleryDirectoryExportError("target_path_changed")
                for directory in staged_root.iter_subtree(
                    "",
                    excluded_directories=frozenset(),
                    excluded_directory_prefixes=(),
                ):
                    if cancel_event.is_set():
                        raise _CopyCancelled()
                    relative_directory = directory.relative_path
                    if relative_directory not in expected_directories:
                        raise GalleryDirectoryExportError("target_path_changed")
                    seen_directories.add(relative_directory)
                    for file_name, _metadata in directory.files:
                        relative_file = (
                            f"{relative_directory}/{file_name}"
                            if relative_directory
                            else file_name
                        )
                        expected = expected_files.get(relative_file)
                        if expected is None:
                            raise GalleryDirectoryExportError("target_path_changed")
                        handle = staged_root.open_binary(relative_file)
                        try:
                            actual = _file_version(os.fstat(handle.fileno()))
                        finally:
                            handle.close()
                        if actual != expected:
                            raise GalleryDirectoryExportError("target_path_changed")
                        seen_files.add(relative_file)
        except _CopyCancelled:
            raise
        except GalleryDirectoryExportError:
            raise
        except (OSError, UnsafeSourcePathError) as error:
            raise GalleryDirectoryExportError("target_path_changed") from error
        if (
            seen_directories != expected_directories
            or seen_files != set(expected_files)
        ):
            raise GalleryDirectoryExportError("target_path_changed")

    def _revalidate_selection(self, selection: _Selection) -> None:
        directory = self._repo.get_directory(selection.directory_id)
        source = self._repo.get_source(selection.source_id)
        if directory is None:
            raise GalleryDirectoryExportError("directory_not_found")
        if source is None or directory["source_id"] != selection.source_id:
            raise GalleryDirectoryExportError("source_not_found")
        if source.get("availability") != "available":
            raise GalleryDirectoryExportError("source_offline")
        if (
            directory["relative_path"] != selection.directory_relative_path
            or source["canonical_root_key"] != selection.source_root_key
        ):
            raise GalleryDirectoryExportError("source_changed")

    def _update(self, operation_id: str, **values: Any) -> None:
        with self._lock:
            operation = self._operations[operation_id]
            if operation["state"] != "copying" and values.get("state") == "copying":
                return
            operation.update(values)

    def _increment(self, operation_id: str, **values: int) -> None:
        with self._lock:
            operation = self._operations[operation_id]
            for key, value in values.items():
                operation[key] = int(operation[key]) + int(value)

    def _append_result(
        self,
        operation_id: str,
        result: dict[str, Any],
        *,
        completed: bool = False,
        failed: bool = False,
    ) -> None:
        with self._lock:
            operation = self._operations[operation_id]
            operation["results"].append(result)
            if completed:
                operation["completed_directory_count"] += 1
                operation["successful_directory_names"].append(
                    result["directory_name"]
                )
            if failed:
                operation["failed_directory_count"] += 1

    def _finish_failed(self, operation_id: str, code: str) -> None:
        with self._lock:
            operation = self._operations[operation_id]
            if operation["state"] == "copying":
                operation["state"] = "failed"
                operation["error_code"] = code
                operation["current_directory_name"] = None

    def _finish_cancelled(self, operation_id: str, directory_name: str | None) -> None:
        with self._lock:
            operation = self._operations[operation_id]
            if operation["state"] == "copying":
                operation["state"] = "cancelled"
                operation["error_code"] = "cancelled"
                operation["current_directory_name"] = directory_name

    def _prune_locked(self) -> None:
        if len(self._operations) < _MAX_OPERATIONS:
            return
        removable = [
            operation_id
            for operation_id, operation in self._operations.items()
            if operation["state"] in _DIRECTORY_EXPORT_STATES - {"copying"}
        ]
        while len(self._operations) >= _MAX_OPERATIONS and removable:
            operation_id = removable.pop(0)
            del self._operations[operation_id]
            self._cancel_events.pop(operation_id, None)
            for key, value in list(self._idempotency.items()):
                if value == operation_id:
                    del self._idempotency[key]

    @staticmethod
    def _project(operation: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "operation_id": operation["operation_id"],
            "state": operation["state"],
            "current_directory_name": operation["current_directory_name"],
            "directory_count": operation["directory_count"],
            "completed_directory_count": operation["completed_directory_count"],
            "failed_directory_count": operation["failed_directory_count"],
            "discovered_file_count": operation["discovered_file_count"],
            "copied_file_count": operation["copied_file_count"],
            "discovered_byte_count": operation["discovered_byte_count"],
            "copied_byte_count": operation["copied_byte_count"],
            "error_code": operation["error_code"],
            "successful_directory_names": list(
                operation["successful_directory_names"]
            ),
            "results": [dict(result) for result in operation["results"]],
        }


def _relative_to_selection(directory_relative: str, selected_relative: str) -> str:
    if not selected_relative:
        return directory_relative
    if directory_relative == selected_relative:
        return ""
    prefix = selected_relative + "/"
    if not directory_relative.startswith(prefix):
        raise GalleryDirectoryExportError("unsafe_source_path")
    return directory_relative[len(prefix) :]


__all__ = [
    "ALLOWED_DIRECTORY_EXPORT_EXTENSIONS",
    "MAX_DIRECTORY_EXPORT_SELECTIONS",
    "MAX_DIRECTORY_EXPORT_ID_LENGTH",
    "GalleryDirectoryExportError",
    "GalleryDirectoryExportService",
]
