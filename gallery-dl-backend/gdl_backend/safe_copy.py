"""安全复制原语：描述符锚定的目标根、服务自有临时目录和不覆盖提交。

目录导出（gallery_directory_export）和数据集导出（dataset_export）共用这一层：
目标根以目录描述符锚定，所有输出只写进以 ``.ldos-copy-`` 开头的自有临时目录，
最后用 RENAME_NOREPLACE 一次性改名成最终名字，绝不覆盖已有条目。
"""

from __future__ import annotations

import contextlib
import ctypes
import errno
import os
import stat
import sys
import threading
import unicodedata
from pathlib import Path
from typing import Any, BinaryIO, Callable, Mapping, Sequence

from .gallery_catalog import LDOS_TEMP_DIRECTORY_PREFIXES
from .gallery_safe_paths import (
    SafeSourceRoot,
    UnsafeSourcePathError,
    is_reparse_path,
    validate_relative_path,
)


TEMPORARY_PREFIX = LDOS_TEMP_DIRECTORY_PREFIXES[0]
_TEMPORARY_PREFIX = TEMPORARY_PREFIX  # 旧名，模块内部沿用
_OPEN_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_NO_FOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOSE_ON_EXEC = getattr(os, "O_CLOEXEC", 0)
_BINARY = getattr(os, "O_BINARY", 0)
_HAS_DIR_FD = os.open in os.supports_dir_fd and os.stat in os.supports_dir_fd
_NO_CLOBBER_UNSUPPORTED_ERRNOS = frozenset(
    {errno.ENOSYS, errno.EINVAL, getattr(errno, "EOPNOTSUPP", errno.ENOTSUP)}
)


class SafeCopyError(Exception):
    def __init__(self, code: str, details: Mapping[str, Any] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.details = dict(details or {})


class CopyCancelled(Exception):
    pass


class TargetRoot:
    """Descriptor-anchored target root used only for service-owned temp trees."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._fd: int | None = None
        self._identity: tuple[int, int] | None = None
        self._owned_directory_identities: dict[str, tuple[int, int]] = {}

    def __enter__(self) -> "TargetRoot":
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
            # 没有 dir_fd 时逐组件校验路径，并保存根目录身份。
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
                raise SafeCopyError("target_root_changed")
            return
        descriptor = _open_absolute_directory(self.path)
        try:
            metadata = os.fstat(descriptor)
            if (int(metadata.st_dev), int(metadata.st_ino)) != self._identity:
                raise SafeCopyError("target_root_changed")
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
                    raise SafeCopyError("target_path_changed")
        except FileNotFoundError:
            return None
        if not stat.S_ISDIR(metadata.st_mode):
            raise SafeCopyError("target_path_changed")
        return int(metadata.st_dev), int(metadata.st_ino)

    def _require_owned_directory(self, name: str) -> tuple[int, int]:
        expected = self._owned_directory_identities.get(name)
        if expected is None or self._directory_identity(name) != expected:
            raise SafeCopyError("target_path_changed")
        return expected
    def entry_exists(self, name: str) -> bool:
        validate_leaf_name(name)
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
            raise SafeCopyError("target_path_changed")
        self._owned_directory_identities[name] = identity

    def adopt_owned_directory(
        self, name: str, expected_identity: Sequence[int]
    ) -> bool:
        """续传：认领上次由本服务建好的临时目录。

        只认身份（st_dev, st_ino）与当时记下的一致的目录；不存在返回 False，
        身份不符一律拒绝，绝不接管别人放在那里的同名目录。
        """
        identity = self._directory_identity(name)
        if identity is None:
            return False
        if identity != (int(expected_identity[0]), int(expected_identity[1])):
            raise SafeCopyError("target_path_changed")
        self._owned_directory_identities[name] = identity
        return True

    def owned_directory_identity(self, name: str) -> tuple[int, int]:
        return self._require_owned_directory(name)

    def entry_identity(self, name: str) -> tuple[int, int] | None:
        """目标根下某个条目的身份（不跟随符号链接）；不存在返回 None。

        续传据此认出「临时目录已改名成最终名字、但任务还没来得及记成功」。
        """
        validate_leaf_name(name)
        self.verify_identity()
        try:
            if _HAS_DIR_FD:
                metadata = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            else:
                _validate_absolute_directory_components(self.path)
                metadata = (self.path / name).lstat()
        except FileNotFoundError:
            return None
        return int(metadata.st_dev), int(metadata.st_ino)

    def remove_output_file(self, temporary_name: str, relative_path: str) -> bool:
        """续传：删掉自有临时目录里上次没写完的文件；不存在返回 False，只删普通文件。"""
        _validate_owned_temp_name(temporary_name)
        expected_temporary_identity = self._require_owned_directory(temporary_name)
        parts = validate_relative_path(relative_path)
        self.verify_identity()
        if not _HAS_DIR_FD:
            target = self.path / temporary_name
            for component in parts:
                target = target / component
            try:
                metadata = target.lstat()
            except FileNotFoundError:
                return False
            if not stat.S_ISREG(metadata.st_mode) or is_reparse_path(target):
                raise SafeCopyError("target_path_unsafe")
            target.unlink()
            return True
        descriptor = os.dup(self.fd)
        try:
            try:
                descriptor = _open_child_directory(descriptor, temporary_name, create=False)
                temporary_metadata = os.fstat(descriptor)
                if (
                    int(temporary_metadata.st_dev),
                    int(temporary_metadata.st_ino),
                ) != expected_temporary_identity:
                    raise SafeCopyError("target_path_changed")
                for component in parts[:-1]:
                    descriptor = _open_child_directory(descriptor, component, create=False)
                metadata = os.stat(parts[-1], dir_fd=descriptor, follow_symlinks=False)
            except FileNotFoundError:
                return False
            if not stat.S_ISREG(metadata.st_mode):
                raise SafeCopyError("target_path_unsafe")
            os.unlink(parts[-1], dir_fd=descriptor)
            os.fsync(descriptor)
            return True
        finally:
            os.close(descriptor)

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
                raise SafeCopyError("target_path_changed")
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
                raise SafeCopyError("target_path_unsafe") from error
            try:
                metadata = os.fstat(descriptor)
                if not stat.S_ISREG(metadata.st_mode):
                    raise SafeCopyError("target_path_unsafe")
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
                raise SafeCopyError("target_path_changed")
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
                    raise SafeCopyError("target_path_unsafe")
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
                        raise SafeCopyError(
                            "target_path_changed"
                        ) from error
                    if (
                        not stat.S_ISREG(current.st_mode)
                        or (int(current.st_dev), int(current.st_ino))
                        != expected_identity
                    ):
                        raise SafeCopyError("target_path_changed")
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
        validate_leaf_name(final_name)
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
            raise SafeCopyError(
                "target_name_conflict", {"names": [final_name]}
            ) from error
        if _HAS_DIR_FD:
            os.fsync(self.fd)

    def remove_owned_directory(self, name: str) -> bool:
        _validate_owned_temp_name(name)
        try:
            self._require_owned_directory(name)
        except (SafeCopyError, OSError):
            return False
        if _HAS_DIR_FD:
            try:
                _remove_tree_at(self.fd, name)
                removed = not self.entry_exists(name)
                if removed:
                    self._owned_directory_identities.pop(name, None)
                return removed
            except (SafeCopyError, OSError):
                return False
        try:
            _remove_fallback_tree(self.path / name)
            removed = not self.entry_exists(name)
            if removed:
                self._owned_directory_identities.pop(name, None)
            return removed
        except (SafeCopyError, OSError):
            return False


def file_version(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
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

TargetFileSnapshot = tuple[int, int, int, int, int]


def file_versions_match(
    observed: TargetFileSnapshot, expected: TargetFileSnapshot
) -> bool:
    """Compare an enumerated file with its safely opened handle."""
    return observed == expected

def portable_name_key(name: str) -> str:
    return unicodedata.normalize("NFC", name).casefold()


def validate_leaf_name(name: str) -> None:
    if (
        not isinstance(name, str)
        or not name
        or name in {".", ".."}
        or "/" in name
        or "\\" in name
        or "\x00" in name
    ):
        raise SafeCopyError("directory_name_invalid")


def _validate_owned_temp_name(name: str) -> None:
    validate_leaf_name(name)
    if not name.startswith(_TEMPORARY_PREFIX):
        raise SafeCopyError("temporary_name_invalid")


def _validate_absolute_directory_components(path: Path) -> os.stat_result:
    current = Path(path.anchor)
    try:
        metadata = current.lstat()
    except OSError as error:
        raise SafeCopyError("target_unavailable") from error
    if is_reparse_path(current):
        raise SafeCopyError("target_path_unsafe")
    if not stat.S_ISDIR(metadata.st_mode):
        raise SafeCopyError("target_not_directory")
    anchor_parts = len(current.parts)
    for component in path.parts[anchor_parts:]:
        current = current / component
        try:
            metadata = current.lstat()
        except OSError as error:
            raise SafeCopyError("target_unavailable") from error
        if is_reparse_path(current):
            raise SafeCopyError("target_path_unsafe")
        if not stat.S_ISDIR(metadata.st_mode):
            raise SafeCopyError("target_not_directory")
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
        raise SafeCopyError("target_path_changed") from error
    if is_reparse_path(path) or not stat.S_ISREG(metadata.st_mode):
        raise SafeCopyError("target_path_unsafe")
    if (int(metadata.st_dev), int(metadata.st_ino)) != expected_identity:
        raise SafeCopyError("target_path_changed")


def _validate_fallback_tree(root: Path) -> None:
    stack = [root]
    while stack:
        current = stack.pop()
        _validate_absolute_directory_components(current)
        with os.scandir(current) as entries:
            for entry in entries:
                child = current / entry.name
                if is_reparse_path(child):
                    raise SafeCopyError("target_path_unsafe")
                metadata = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(metadata.st_mode):
                    stack.append(child)
                elif not stat.S_ISREG(metadata.st_mode):
                    raise SafeCopyError("target_path_unsafe")


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
        raise SafeCopyError("target_path_not_absolute")
    if not _HAS_DIR_FD:
        expected = _validate_absolute_directory_components(path)
        try:
            descriptor = os.open(path, os.O_RDONLY | _OPEN_DIRECTORY | _CLOSE_ON_EXEC)
        except OSError as error:
            raise SafeCopyError("target_unavailable") from error
        try:
            actual = os.fstat(descriptor)
            observed = _validate_absolute_directory_components(path)
            expected_identity = (expected.st_dev, expected.st_ino)
            if (actual.st_dev, actual.st_ino) != expected_identity or (
                observed.st_dev,
                observed.st_ino,
            ) != expected_identity:
                raise SafeCopyError("target_path_changed")
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
        raise SafeCopyError("target_unavailable") from error
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
                raise SafeCopyError("target_unavailable") from error
            except OSError as error:
                raise SafeCopyError("target_path_unsafe") from error
            metadata = os.fstat(child)
            if not stat.S_ISDIR(metadata.st_mode):
                os.close(child)
                raise SafeCopyError("target_not_directory")
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
        raise SafeCopyError("target_path_unsafe")
    os.close(parent_fd)
    return child


def _validate_tree_at(parent_fd: int, name: str) -> None:
    try:
        metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as error:
        raise SafeCopyError("target_path_changed") from error
    if not stat.S_ISDIR(metadata.st_mode):
        raise SafeCopyError("target_path_unsafe")
    try:
        child_fd = os.open(
            name,
            os.O_RDONLY | _OPEN_DIRECTORY | _CLOSE_ON_EXEC | _NO_FOLLOW,
            dir_fd=parent_fd,
        )
    except OSError as error:
        raise SafeCopyError("target_path_unsafe") from error
    try:
        with os.scandir(child_fd) as entries:
            names = [entry.name for entry in entries]
        for child_name in names:
            try:
                child_metadata = os.stat(
                    child_name, dir_fd=child_fd, follow_symlinks=False
                )
            except OSError as error:
                raise SafeCopyError("target_path_changed") from error
            if stat.S_ISDIR(child_metadata.st_mode):
                _validate_tree_at(child_fd, child_name)
            elif not stat.S_ISREG(child_metadata.st_mode):
                raise SafeCopyError("target_path_unsafe")
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
            raise SafeCopyError("no_clobber_unsupported")
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
                raise SafeCopyError("no_clobber_unsupported")
            raise OSError(code, os.strerror(code), target_name)
        return

    if sys.platform == "darwin" and _HAS_DIR_FD:
        libc = ctypes.CDLL(None, use_errno=True)
        renameatx_np = getattr(libc, "renameatx_np", None)
        if renameatx_np is None:
            raise SafeCopyError("no_clobber_unsupported")
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
                raise SafeCopyError("no_clobber_unsupported")
            raise OSError(code, os.strerror(code), target_name)
        return

    raise SafeCopyError("no_clobber_unsupported")


def copy_stream(
    source: BinaryIO,
    target: BinaryIO,
    *,
    chunk_size: int,
    cancel_event: threading.Event | None = None,
    on_chunk: Callable[[bytes, int], None] | None = None,
) -> int:
    """逐块复制并 fsync 目标，返回字节数。每块写完回调 on_chunk(块, 累计字节)。"""
    copied = 0
    while True:
        if cancel_event is not None and cancel_event.is_set():
            raise CopyCancelled()
        chunk = source.read(chunk_size)
        if not chunk:
            break
        target.write(chunk)
        copied += len(chunk)
        if on_chunk is not None:
            on_chunk(chunk, copied)
    target.flush()
    os.fsync(target.fileno())
    return copied


@contextlib.contextmanager
def open_staged_root(target_root: TargetRoot, temporary_name: str) -> Any:
    """以 SafeSourceRoot 打开自有临时目录（身份必须与创建/认领时一致）。"""
    expected_identity = target_root.owned_directory_identity(temporary_name)
    with SafeSourceRoot(target_root.path / temporary_name) as staged_root:
        if staged_root.root_identity() != expected_identity:
            raise SafeCopyError("target_path_changed")
        yield staged_root


def validate_staged_tree(
    target_root: TargetRoot,
    temporary_name: str,
    expected_directories: set[str],
    expected_files: Mapping[str, TargetFileSnapshot],
    cancel_event: threading.Event | None = None,
    *,
    size_only: bool = False,
) -> None:
    """提交前核对临时目录：只含预期的目录和普通文件，文件版本（或大小）一致。

    size_only=True 用于跨进程续传：上次会话写下的文件只有日志里的大小可比。
    """
    target_root.validate_owned_directory(temporary_name)
    seen_directories: set[str] = set()
    seen_files: set[str] = set()
    try:
        with open_staged_root(target_root, temporary_name) as staged_root:
            for directory in staged_root.iter_subtree(
                "",
                excluded_directories=frozenset(),
                excluded_directory_prefixes=(),
            ):
                if cancel_event is not None and cancel_event.is_set():
                    raise CopyCancelled()
                relative_directory = directory.relative_path
                if relative_directory not in expected_directories:
                    raise SafeCopyError("target_path_changed")
                seen_directories.add(relative_directory)
                for file_name, _metadata in directory.files:
                    relative_file = (
                        f"{relative_directory}/{file_name}"
                        if relative_directory
                        else file_name
                    )
                    expected = expected_files.get(relative_file)
                    if expected is None:
                        raise SafeCopyError("target_path_changed")
                    handle = staged_root.open_binary(relative_file)
                    try:
                        actual = file_version(os.fstat(handle.fileno()))
                    finally:
                        handle.close()
                    matches = actual[2] == expected[2] if size_only else actual == expected
                    if not matches:
                        raise SafeCopyError("target_path_changed")
                    seen_files.add(relative_file)
    except CopyCancelled:
        raise
    except SafeCopyError:
        raise
    except (OSError, UnsafeSourcePathError) as error:
        raise SafeCopyError("target_path_changed") from error
    if (
        seen_directories != expected_directories
        or seen_files != set(expected_files)
    ):
        raise SafeCopyError("target_path_changed")


__all__ = [
    "TEMPORARY_PREFIX",
    "CopyCancelled",
    "SafeCopyError",
    "TargetFileSnapshot",
    "TargetRoot",
    "copy_stream",
    "file_version",
    "file_versions_match",
    "open_staged_root",
    "portable_name_key",
    "validate_leaf_name",
    "validate_staged_tree",
]
