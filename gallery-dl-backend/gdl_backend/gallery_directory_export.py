"""Short-lived, Gallery-owned safe directory copy operations.

The service deliberately owns no SQLite job/item state.  Gallery directory IDs
are resolved server-side, allow-listed files are copied byte-for-byte, and each
selected directory is committed independently with no-clobber semantics.
The descriptor-anchored copy primitives live in ``safe_copy``.
"""

from __future__ import annotations

import logging
import os
import secrets
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .gallery_catalog import (
    LDOS_RESERVED_DIR,
    LDOS_TEMP_DIRECTORY_PREFIXES,
    SUPPORTED_IMAGE_EXTENSIONS,
    canonical_root_key,
    root_relation,
)
from .gallery_safe_paths import (
    GalleryFilesystemLocks,
    SafeSourceRoot,
    UnsafeSourcePathError,
    validate_relative_path,
)
from .redaction import safe_exception_category
from .safe_copy import (
    TEMPORARY_PREFIX as _TEMPORARY_PREFIX,
    CopyCancelled as _CopyCancelled,
    SafeCopyError,
    TargetFileSnapshot as _TargetFileSnapshot,
    TargetRoot as _TargetRoot,
    copy_stream,
    file_version as _file_version,
    file_versions_match as _file_versions_match,
    portable_name_key as _portable_name_key,
    validate_leaf_name as _validate_leaf_name,
    validate_staged_tree,
)


logger = logging.getLogger(__name__)

ALLOWED_DIRECTORY_EXPORT_EXTENSIONS: frozenset[str] = frozenset(
    {*SUPPORTED_IMAGE_EXTENSIONS, ".txt"}
)
MAX_DIRECTORY_EXPORT_SELECTIONS = 500
MAX_DIRECTORY_EXPORT_ID_LENGTH = 128
_DIRECTORY_EXPORT_STATES: frozenset[str] = frozenset(
    {"copying", "completed", "failed", "cancelled"}
)
_EXCLUDED_DIRECTORY_NAMES = frozenset({LDOS_RESERVED_DIR})
_MAX_OPERATIONS = 128
_MAX_ACTIVE_OPERATIONS = 4

# 与 safe_copy 共用同一个错误类：复制原语抛出的错误码在这里照常捕获。
GalleryDirectoryExportError = SafeCopyError


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

    def has_active_operations(self) -> bool:
        """只读内存状态；活动中心采样器用它判断是否需要采样。"""

        with self._lock:
            return any(
                operation["state"] == "copying"
                for operation in self._operations.values()
            )

    def list_operations(self) -> list[dict[str, Any]]:
        with self._lock:
            return [self._project(operation) for operation in self._operations.values()]

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
                component == LDOS_RESERVED_DIR
                or any(
                    component.startswith(prefix)
                    for prefix in LDOS_TEMP_DIRECTORY_PREFIXES
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
                        excluded_directory_prefixes=LDOS_TEMP_DIRECTORY_PREFIXES,
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
                    excluded_directory_prefixes=LDOS_TEMP_DIRECTORY_PREFIXES,
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
        if not _file_versions_match(source_version, expected_version):
            source_handle.close()
            raise GalleryDirectoryExportError("source_changed")
        def on_chunk(chunk: bytes, copied: int) -> None:
            self._increment(operation_id, copied_byte_count=len(chunk))
            if self._copy_chunk_hook is not None:
                self._copy_chunk_hook(operation_id, output_relative, copied)

        target_version: _TargetFileSnapshot | None = None
        try:
            with target_root.open_output_file(
                temporary_name, output_relative
            ) as target_handle:
                copied = copy_stream(
                    source_handle,
                    target_handle,
                    chunk_size=self._copy_chunk_size,
                    cancel_event=cancel_event,
                    on_chunk=on_chunk,
                )
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
        validate_staged_tree(
            target_root,
            temporary_name,
            expected_directories,
            expected_files,
            cancel_event,
        )

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
