"""图库文件操作引擎（§3.5/§5.5；G3-2）。

单一所有者：本模块拥有 rename / trash / undo / restore / purge 的
文件系统事务与持久操作日志。API 路由只做参数校验与错误翻译。

不变式：
- 任何时刻每个来源至多一个未终结操作（DB 状态守卫 + 进程内写锁）；
- 操作日志先落库（planned）再动磁盘（applying → committed）；
- 任一项失败回滚整组（rolling_back → rolled_back）；
- 回滚本身失败进入 recovery_required 并锁定来源；
- trash 布局遵循 §3.5：`.imageweave/trash/<op>/files/<原相对路径>` + operation.json；
- 资产 ID 在 ImageWeave 自己的 rename/trash/restore 中保持稳定。
"""

from __future__ import annotations

import json
import threading
import uuid
from pathlib import PurePosixPath
from typing import Any, Mapping

from ._database_gallery_repository import (
    GalleryRepository,
    GalleryVersionConflict,
)
from .gallery_catalog import (
    decode_txt_bytes,
    natural_sort_key,
    trash_files_relative_dir,
    trash_operation_manifest_relative_path,
)
from .gallery_safe_paths import (
    GalleryFilesystemLocks,
    SafeSourceRoot,
    UnsafeSourcePathError,
)

FILE_OPERATION_KINDS: frozenset[str] = frozenset(
    {"rename", "trash", "restore", "purge"}
)
FILE_OPERATION_STATUSES: frozenset[str] = frozenset(
    {
        "planned",
        "applying",
        "committed",
        "rolling_back",
        "rolled_back",
        "recovery_required",
        "failed",
    }
)
_TERMINAL_OPERATION_STATUSES: frozenset[str] = frozenset(
    {"committed", "rolled_back", "failed"}
)


class GalleryFileOperationError(Exception):
    """文件操作失败（稳定错误码 + 安全相对路径细节）。"""

    def __init__(self, code: str, details: Mapping[str, Any] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.details = dict(details or {})


class GalleryFileOperations:
    """rename / trash / undo / restore / purge 的唯一执行者。"""

    def __init__(
        self,
        repository: GalleryRepository,
        *,
        clock: Any = None,
        filesystem_locks: GalleryFilesystemLocks | None = None,
    ) -> None:
        import time

        self._repo = repository
        self._clock = clock or time.time
        self._filesystem_locks = filesystem_locks or GalleryFilesystemLocks()
        self._source_locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    # ---- 锁 ----

    def _lock_for(self, source_id: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._source_locks.get(source_id)
            if lock is None:
                lock = threading.Lock()
                self._source_locks[source_id] = lock
            return lock

    # ---- 公开操作 ----

    def rename_asset(
        self,
        asset_id: str,
        new_base_name: str,
        *,
        expected_txt_version: int | None = None,
    ) -> dict[str, Any]:
        """单张成对重命名（§3.5）：只改基本名，保留扩展名。

        - TXT 存在时同步改名；缺失时不自动创建；
        - 目标名冲突（图片或 TXT）阻止整个操作；
        - 失败回滚，不留半状态。
        """
        asset = self._repo.get_asset(asset_id)
        if asset is None:
            raise GalleryFileOperationError("asset_not_found", {"asset_id": asset_id})
        if asset["lifecycle_state"] != "active":
            raise GalleryFileOperationError(
                "asset_not_active", {"asset_id": asset_id}
            )
        name = _validate_new_base_name(new_base_name, asset["name"], asset["extension"])
        old_relative = asset["relative_path"]
        parent = _parent_relative(old_relative)
        new_relative = f"{parent}/{name}" if parent else name
        if new_relative == old_relative:
            raise GalleryFileOperationError(
                "rename_noop", {"asset_id": asset_id}
            )
        has_txt = bool(
            asset["txt_relative_path"]
            and asset["txt_state"] not in {"missing", "pair_conflict"}
        )
        items = [
            {
                "source_id": asset["source_id"],
                "asset_id": asset_id,
                "origin_relative_path": old_relative,
                "target_relative_path": new_relative,
                "has_txt": has_txt,
                "expected_asset_version": int(asset["content_version"]),
                "expected_txt_version": int(asset["txt_version"]),
                "txt_origin": asset["txt_relative_path"] if has_txt else "",
                "txt_target": (
                    _txt_target_for_rename(new_relative) if has_txt else ""
                ),
            }
        ]
        return self._execute(
            kind="rename",
            items=items,
            expected_txt_version=expected_txt_version,
        )

    def trash_assets(
        self, asset_ids: list[str], directory_ids: list[str] | None = None
    ) -> dict[str, Any]:
        """回收图片或完整物理目录；所有选择作为一个逻辑操作执行。"""
        directory_ids = list(directory_ids or [])
        if not asset_ids and not directory_ids:
            raise GalleryFileOperationError("selection_required")
        if len(asset_ids) != len(set(asset_ids)):
            raise GalleryFileOperationError(
                "asset_selection_invalid", {"reason": "duplicate_asset_ids"}
            )
        if len(directory_ids) != len(set(directory_ids)):
            raise GalleryFileOperationError(
                "directory_selection_invalid", {"reason": "duplicate_directory_ids"}
            )

        assets = self._repo.get_assets_by_ids(asset_ids)
        if len(assets) != len(set(asset_ids)):
            missing = sorted(set(asset_ids) - {a["asset_id"] for a in assets})
            raise GalleryFileOperationError(
                "asset_not_found", {"asset_ids": missing}
            )
        inactive = [a["asset_id"] for a in assets if a["lifecycle_state"] != "active"]
        if inactive:
            raise GalleryFileOperationError(
                "asset_not_active", {"asset_ids": inactive}
            )

        directories: list[dict[str, Any]] = []
        missing_directories: list[str] = []
        for directory_id in directory_ids:
            directory = self._repo.get_directory(directory_id)
            if directory is None:
                missing_directories.append(directory_id)
                continue
            if not directory["relative_path"]:
                raise GalleryFileOperationError(
                    "directory_root_not_deletable",
                    {"directory_id": directory_id},
                )
            directories.append(directory)
        if missing_directories:
            raise GalleryFileOperationError(
                "directory_not_found", {"directory_ids": missing_directories}
            )
        for index, directory in enumerate(directories):
            path = str(directory["relative_path"])
            for other in directories[index + 1 :]:
                other_path = str(other["relative_path"])
                if directory["source_id"] != other["source_id"]:
                    continue
                if _path_is_within(path, other_path) or _path_is_within(
                    other_path, path
                ):
                    raise GalleryFileOperationError(
                        "directory_selection_overlap",
                        {"directory_ids": directory_ids},
                    )

        items: list[dict[str, Any]] = []
        for asset in assets:
            # A directory item owns every physical descendant; do not move
            # selected descendants a second time as individual assets.
            if any(
                asset["source_id"] == directory["source_id"]
                and _path_is_within(
                    str(asset["relative_path"]), str(directory["relative_path"])
                )
                for directory in directories
            ):
                continue
            has_txt = bool(
                asset["txt_relative_path"]
                and asset["txt_state"] not in {"missing", "pair_conflict"}
            )
            items.append(
                {
                    "item_type": "asset",
                    "source_id": asset["source_id"],
                    "asset_id": asset["asset_id"],
                    "directory_id": asset["directory_id"],
                    "origin_relative_path": asset["relative_path"],
                    "target_relative_path": "",
                    "has_txt": has_txt,
                    "expected_asset_version": int(asset["content_version"]),
                    "expected_txt_version": int(asset["txt_version"]),
                    "txt_origin": asset["txt_relative_path"] if has_txt else "",
                    "txt_target": "",
                }
            )
        for directory in directories:
            items.append(
                {
                    "item_type": "directory",
                    "source_id": directory["source_id"],
                    "asset_id": "",
                    "directory_id": directory["directory_id"],
                    "origin_relative_path": directory["relative_path"],
                    "target_relative_path": "",
                    "has_txt": False,
                    "expected_asset_version": 0,
                    "expected_txt_version": 0,
                    "txt_origin": "",
                    "txt_target": "",
                }
            )
        return self._execute(kind="trash", items=items)

    def trash_directories(self, directory_ids: list[str]) -> dict[str, Any]:
        """Compatibility helper for callers that only select directories."""
        return self.trash_assets([], directory_ids)

    def undo_trash(self, operation_id: str) -> dict[str, Any]:
        """撤销回收：把整组文件移回原路径（恢复 asset lifecycle）。"""
        operation = self._get_operation(operation_id)
        if operation["kind"] != "trash":
            raise GalleryFileOperationError(
                "operation_not_undoable", {"operation_id": operation_id}
            )
        if operation["status"] != "committed":
            raise GalleryFileOperationError(
                "operation_version_mismatch",
                {"operation_id": operation_id, "status": operation["status"]},
            )
        # undo 是一个 restore 操作，引用原操作的 items。
        items = self._repo_list_items(operation_id)
        restore_items = []
        for item in items:
            if item["status"] != "done":
                continue
            item_type = item.get("item_type", "asset")
            if item_type == "directory":
                if not self._directory_has_lifecycle(
                    item["directory_id"], "trashed"
                ):
                    continue
                restore_items.append(
                    {
                        "item_type": "directory",
                        "source_id": item["source_id"],
                        "asset_id": "",
                        "directory_id": item["directory_id"],
                        "origin_relative_path": item["origin_relative_path"],
                        "target_relative_path": "",
                        "has_txt": False,
                        "expected_asset_version": 0,
                        "expected_txt_version": 0,
                        "undo_of": operation_id,
                        "ordinal": item["ordinal"],
                    }
                )
                continue
            asset = self._repo.get_asset(item["asset_id"])
            if asset is None or asset["lifecycle_state"] != "trashed":
                continue
            restore_items.append(
                {
                    "item_type": "asset",
                    "source_id": item["source_id"],
                    "asset_id": item["asset_id"],
                    "directory_id": item.get("directory_id", ""),
                    "origin_relative_path": "",  # trash 位置（由引擎推导）
                    "target_relative_path": item["origin_relative_path"],
                    "has_txt": bool(item["has_txt"]),
                    "expected_asset_version": int(asset["content_version"]),
                    "expected_txt_version": int(asset["txt_version"]),
                    "undo_of": operation_id,
                    "ordinal": item["ordinal"],
                }
            )
        if not restore_items:
            raise GalleryFileOperationError(
                "operation_not_undoable",
                {"operation_id": operation_id, "reason": "no_restorable_items"},
            )
        return self._execute(kind="restore", items=restore_items)

    def restore_trash(self, operation_id: str) -> dict[str, Any]:
        """从回收区恢复（§3.5）：恢复前重新检查原路径冲突。"""
        return self.undo_trash(operation_id)

    def purge_trash(self, operation_id: str) -> dict[str, Any]:
        """永久清理单个回收操作：不可撤销，删除物理文件与资产记录。"""
        operation = self._get_operation(operation_id)
        if operation["kind"] != "trash":
            raise GalleryFileOperationError(
                "operation_not_purgeable", {"operation_id": operation_id}
            )
        if operation["status"] != "committed":
            raise GalleryFileOperationError(
                "operation_version_mismatch",
                {"operation_id": operation_id, "status": operation["status"]},
            )
        items = self._repo_list_items(operation_id)
        purge_items = [
            {
                "item_type": item.get("item_type", "asset"),
                "source_id": item["source_id"],
                "asset_id": item.get("asset_id", ""),
                "directory_id": item.get("directory_id", ""),
                "origin_relative_path": item["origin_relative_path"],
                "target_relative_path": "",
                "has_txt": bool(item["has_txt"]),
                "expected_asset_version": 0,
                "expected_txt_version": 0,
                "purge_of": operation_id,
                "ordinal": item["ordinal"],
            }
            for item in items
            if item["status"] == "done"
        ]
        if not purge_items:
            raise GalleryFileOperationError(
                "operation_not_purgeable",
                {"operation_id": operation_id, "reason": "no_purgeable_items"},
            )
        return self._execute(kind="purge", items=purge_items)

    def purge_all_trash(self) -> dict[str, Any]:
        """清空所有来源的回收区（每个来源一个逻辑操作）。"""
        operations = self._repo_list_trash_operations()
        results = []
        for operation in operations:
            if operation["status"] == "committed":
                results.append(self.purge_trash(operation["operation_id"]))
        return {
            "purged_operations": len(results),
            "purged_items": sum(r.get("item_count", 0) for r in results),
        }

    def list_trash(self, *, cursor: str | None = None, limit: int = 100) -> dict[str, Any]:
        """回收区条目列表（§3.5 管理界面）：操作粒度，含项目数与字节数。"""
        return self._repo_list_trash(cursor=cursor, limit=limit)

    # ---- 启动恢复（§5.5） ----

    def recover_unfinished(self) -> list[dict[str, Any]]:
        """重启恢复：完成或回滚所有未终结操作。

        - applying：重新执行幂等文件移动并推进到 committed（文件已在
          目标位置时视为已完成的步骤）；
        - rolling_back / recovery_required：再次尝试回滚。
        """
        recovered: list[dict[str, Any]] = []
        unfinished = self._repo_list_unfinished()
        for operation in unfinished:
            source_id = operation["source_ids"][0] if operation["source_ids"] else ""
            if not source_id:
                continue
            with self._lock_for(source_id):
                try:
                    outcome = self._recover_one(operation)
                    recovered.append(outcome)
                except GalleryFileOperationError:
                    # 恢复失败保持 recovery_required，来源继续被锁定。
                    pass
        return recovered

    # ---- 内部：计划/执行/回滚 ----

    def _execute(
        self,
        *,
        kind: str,
        items: list[dict[str, Any]],
        expected_txt_version: int | None = None,
    ) -> dict[str, Any]:
        source_ids = sorted({item["source_id"] for item in items})
        locks = [self._lock_for(sid) for sid in source_ids]
        for lock in locks:
            lock.acquire()
        try:
            shared_keys = [*(f"source:{sid}" for sid in source_ids)]
            shared_keys.extend(
                (
                    f"asset:{item['asset_id']}"
                    if item.get("item_type", "asset") == "asset"
                    else f"directory:{item['source_id']}:{item['origin_relative_path']}"
                )
                for item in items
            )
            with self._filesystem_locks.hold(*shared_keys):
                return self._execute_locked(
                    kind=kind,
                    items=items,
                    source_ids=source_ids,
                    expected_txt_version=expected_txt_version,
                )
        finally:
            for lock in reversed(locks):
                lock.release()

    def _execute_locked(
        self,
        *,
        kind: str,
        items: list[dict[str, Any]],
        source_ids: list[str],
        expected_txt_version: int | None,
    ) -> dict[str, Any]:
        operation_id = str(uuid.uuid4())
        now = self._clock()
        # 1) 计划落库：状态 planned。检查来源无未终结操作。
        with self._repo._transaction() as conn:  # noqa: SLF001 - 单一所有者边界
            for sid in source_ids:
                row = conn.execute(
                    """
                    SELECT COUNT(*) AS pending FROM gallery_file_operations
                    WHERE kind != 'purge' AND status IN ('planned', 'applying',
                        'rolling_back', 'recovery_required')
                      AND EXISTS (
                        SELECT 1 FROM gallery_file_operation_items
                        WHERE operation_id = gallery_file_operations.id
                          AND source_id = ?
                      )
                    """,
                    (sid,),
                ).fetchone()
                if int(row["pending"]) > 0:
                    raise GalleryFileOperationError(
                        "operation_in_progress", {"source_id": sid}
                    )
            # 版本预检（rename 需要 TXT 版本一致时）。
            if expected_txt_version is not None:
                for item in items:
                    if item.get("item_type", "asset") != "asset":
                        continue
                    row = conn.execute(
                        "SELECT txt_version FROM gallery_assets WHERE id=?",
                        (item["asset_id"],),
                    ).fetchone()
                    if row is None or int(row["txt_version"]) != expected_txt_version:
                        raise GalleryVersionConflict(
                            "txt_version_conflict",
                            {"asset_id": item["asset_id"]},
                        )
            conn.execute(
                """
                INSERT INTO gallery_file_operations(
                    id, kind, status, source_ids_json, created_at, updated_at
                ) VALUES (?, ?, 'planned', ?, ?, ?)
                """,
                (operation_id, kind, json.dumps(source_ids), now, now),
            )
            for ordinal, item in enumerate(items):
                item["ordinal"] = ordinal
                conn.execute(
                    """
                    INSERT INTO gallery_file_operation_items(
                        operation_id, ordinal, source_id, item_type, directory_id, asset_id,
                        origin_relative_path, target_relative_path, has_txt,
                        expected_asset_version, expected_txt_version, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')
                    """,
                    (
                        operation_id,
                        ordinal,
                        item["source_id"],
                        item.get("item_type", "asset"),
                        item.get("directory_id", ""),
                        item.get("asset_id", ""),
                        item["origin_relative_path"],
                        item["target_relative_path"],
                        1 if item["has_txt"] else 0,
                        item["expected_asset_version"],
                        item["expected_txt_version"],
                    ),
                )
        # 2) 执行。
        try:
            self._apply_operation(operation_id, kind, items)
        except Exception as error:
            # 3) 回滚。
            rolled_back = self._rollback_operation(operation_id, kind, items)
            if not rolled_back:
                self._set_operation_status(
                    operation_id, "recovery_required",
                )
                raise GalleryFileOperationError(
                    "operation_recovery_required",
                    {"operation_id": operation_id},
                ) from error
            self._set_operation_status(operation_id, "rolled_back")
            raise
        self._set_operation_status(operation_id, "committed")
        return self._operation_summary(operation_id)

    def _apply_operation(
        self,
        operation_id: str,
        kind: str,
        items: list[dict[str, Any]],
    ) -> None:
        self._set_operation_status(operation_id, "applying")
        completed: list[dict[str, Any]] = []
        try:
            for item in items:
                self._apply_item(operation_id, kind, item)
                completed.append(item)
                self._set_item_status(operation_id, item, "done")
        except Exception:
            # 失败：回滚已完成部分（raise 由 _execute 捕获处理）。
            raise

    def _apply_item(
        self,
        operation_id: str,
        kind: str,
        item: dict[str, Any],
    ) -> None:
        source = self._repo.get_source(item["source_id"])
        if source is None:
            raise GalleryFileOperationError("source_not_found")
        safe_root = SafeSourceRoot(source["root_path"])
        item_type = item.get("item_type", "asset")
        if item_type not in {"asset", "directory"}:
            raise GalleryFileOperationError("invalid_operation_item_type")
        if item_type == "asset":
            # 崩溃恢复重放时 item 可能缺少运行期字段，从资产索引重新推导。
            asset = self._repo.get_asset(item["asset_id"])
            if asset is not None:
                if not item.get("txt_origin") and item.get("has_txt"):
                    item["txt_origin"] = asset["txt_relative_path"] or ""
                if kind == "restore" and not item.get("undo_of"):
                    item["undo_of"] = self._find_trash_operation_for_item(
                        item, operation_id
                    )
                elif kind == "purge" and not item.get("purge_of"):
                    item["purge_of"] = self._find_trash_operation_for_item(
                        item, operation_id
                    )
            elif kind in {"rename", "trash", "restore"}:
                raise GalleryFileOperationError(
                    "asset_not_found", {"asset_id": item["asset_id"]}
                )
        elif kind == "rename":
            raise GalleryFileOperationError("directory_rename_not_supported")
        elif kind in {"restore", "purge"}:
            reference_key = "undo_of" if kind == "restore" else "purge_of"
            if not item.get(reference_key):
                item[reference_key] = self._find_trash_operation_for_item(
                    item, operation_id
                )
        try:
            with safe_root:
                applied = False
                try:
                    if kind == "rename":
                        self._apply_rename(safe_root, item)
                        applied = True
                        self._commit_rename_index(item)
                    elif kind == "trash":
                        self._apply_trash(safe_root, operation_id, item)
                        applied = True
                        self._commit_trash_index(item)
                    elif kind == "restore":
                        self._apply_restore(safe_root, item)
                        applied = True
                        self._commit_restore_index(safe_root, item)
                    elif kind == "purge":
                        self._apply_purge(safe_root, item)
                        applied = True
                        self._commit_purge_index(item)
                    else:  # pragma: no cover - kind validated at entry
                        raise GalleryFileOperationError("invalid_operation_kind")
                except Exception:
                    if applied and kind != "purge":
                        self._rollback_applied_files(
                            safe_root, operation_id, kind, item
                        )
                    raise
        except UnsafeSourcePathError as error:
            raise GalleryFileOperationError(
                "unsafe_source_path",
                {"relative_path": error.relative_path},
            ) from error
    def _rollback_applied_files(
        self,
        safe_root: SafeSourceRoot,
        operation_id: str,
        kind: str,
        item: dict[str, Any],
    ) -> None:
        if item.get("item_type", "asset") == "directory":
            if kind == "trash":
                moves = [(
                    f"{trash_files_relative_dir(operation_id)}/{item['origin_relative_path']}",
                    item["origin_relative_path"],
                )]
            elif kind == "restore":
                files_relative = str(trash_files_relative_dir(item["undo_of"]))
                moves = [(
                    item["origin_relative_path"],
                    f"{files_relative}/{item['origin_relative_path']}",
                )]
            else:
                return
            self._rollback_directory_moves(safe_root, moves)
            return
        if kind == "rename":
            moves = [
                (item["target_relative_path"], item["origin_relative_path"]),
            ]
            if item.get("has_txt") and item.get("txt_target"):
                moves.append((item["txt_target"], item["txt_origin"]))
        elif kind == "trash":
            files_relative = str(trash_files_relative_dir(operation_id))
            moves = [
                (
                    f"{files_relative}/{item['origin_relative_path']}",
                    item["origin_relative_path"],
                )
            ]
            if item.get("has_txt") and item.get("txt_origin"):
                moves.append(
                    (
                        f"{files_relative}/{item['txt_origin']}",
                        item["txt_origin"],
                    )
                )
        elif kind == "restore":
            files_relative = str(trash_files_relative_dir(item["undo_of"]))
            moves = [
                (
                    item["target_relative_path"],
                    f"{files_relative}/{item['target_relative_path']}",
                )
            ]
            if item.get("has_txt") and item.get("txt_origin"):
                moves.append(
                    (
                        item["txt_origin"],
                        f"{files_relative}/{item['txt_origin']}",
                    )
                )
        else:
            return
        self._rollback_moves(safe_root, moves)


    @staticmethod
    def _rollback_directory_moves(
        safe_root: SafeSourceRoot, moves: list[tuple[str, str]]
    ) -> None:
        for source_relative, target_relative in moves:
            source_exists = safe_root.exists_directory(
                source_relative, allow_missing=True
            )
            target_exists = safe_root.exists_directory(
                target_relative, allow_missing=True
            )
            if source_exists and target_exists:
                raise GalleryFileOperationError(
                    "rollback_target_conflict", {"target": target_relative}
                )
            if source_exists:
                safe_root.move_directory(source_relative, target_relative)
    # rename：成对改名 + 索引原位更新（ID 保持稳定）。


    @staticmethod
    def _read_txt_for_search(safe_root: SafeSourceRoot, relative_path: str) -> str:
        if not relative_path:
            return ""
        try:
            payload = safe_root.read_bytes(relative_path, max_bytes=8 * 1024 * 1024)
        except UnsafeSourcePathError as error:
            if error.reason == "file_missing":
                return ""
            raise
        ok, text = decode_txt_bytes(payload)
        return text if ok else ""
    def _apply_rename(self, safe_root: SafeSourceRoot, item: dict[str, Any]) -> None:
        item["_txt_content"] = (
            self._read_txt_for_search(safe_root, item["txt_origin"])
            if item["has_txt"]
            else ""
        )
        moves = [
            (item["origin_relative_path"], item["target_relative_path"]),
        ]
        if item["has_txt"]:
            moves.append((item["txt_origin"], item["txt_target"]))
        completed: list[tuple[str, str]] = []
        try:
            for source_relative, target_relative in moves:
                source_exists = safe_root.exists_regular(source_relative)
                target_exists = safe_root.exists_regular(target_relative)
                if source_exists and target_exists:
                    raise GalleryFileOperationError(
                        "rename_target_conflict", {"target": target_relative}
                    )
                if not source_exists:
                    if target_exists:
                        # Crash replay after the no-clobber move but before item status.
                        continue
                    raise GalleryFileOperationError(
                        "asset_file_missing", {"relative_path": source_relative}
                    )
                try:
                    safe_root.move_regular(source_relative, target_relative)
                except FileExistsError as error:
                    raise GalleryFileOperationError(
                        "rename_target_conflict", {"target": target_relative}
                    ) from error
                completed.append((source_relative, target_relative))
        except Exception:
            for source_relative, target_relative in reversed(completed):
                if safe_root.exists_regular(target_relative):
                    safe_root.move_regular(target_relative, source_relative)
            raise
    def _commit_rename_index(self, item: dict[str, Any]) -> None:
        now = self._clock()
        name = PurePosixPath(item["target_relative_path"]).name
        with self._repo._transaction() as conn:  # noqa: SLF001
            conn.execute(
                """
                UPDATE gallery_assets SET
                    relative_path=?, name=?, sort_key=?,
                    txt_relative_path=?, updated_at=?
                WHERE id=?
                """,
                (
                    item["target_relative_path"],
                    name,
                    natural_sort_key(name),
                    item["txt_target"],
                    now,
                    item["asset_id"],
                ),
            )
            conn.execute(
                "DELETE FROM gallery_search_index WHERE asset_id=?",
                (item["asset_id"],),
            )
            row = conn.execute(
                "SELECT source_id, relative_path FROM gallery_assets WHERE id=?",
                (item["asset_id"],),
            ).fetchone()
            if row is not None:
                conn.execute(
                    """
                    INSERT INTO gallery_search_index(
                        asset_id, source_id, file_name, relative_path, txt_content
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        item["asset_id"],
                        row["source_id"],
                        name,
                        item["target_relative_path"],
                        item.get("_txt_content", ""),
                    ),
                )
            self._bump_source_content_version(conn, item["asset_id"], now)

    # trash：移入 `.imageweave/trash/<op>/files/…` + lifecycle='trashed'。

    def _write_trash_manifest(
        self, safe_root: SafeSourceRoot, operation_id: str, item: Mapping[str, Any]
    ) -> None:
        manifest_relative = str(
            trash_operation_manifest_relative_path(operation_id)
        )
        manifest_payload, manifest_version = safe_root.read_with_disk_version(
            manifest_relative, allow_missing=True
        )
        if manifest_payload is None:
            payload_data: dict[str, Any] = {
                "operation_id": operation_id,
                "kind": "trash",
                "created_at": self._clock(),
                "items": [],
            }
        else:
            try:
                payload_data = json.loads(manifest_payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise GalleryFileOperationError(
                    "trash_manifest_invalid", {"operation_id": operation_id}
                ) from error
            if not isinstance(payload_data, dict):
                raise GalleryFileOperationError(
                    "trash_manifest_invalid", {"operation_id": operation_id}
                )
            payload_data.setdefault("items", [])
        manifest_item = {
            "item_type": item.get("item_type", "asset"),
            "asset_id": item.get("asset_id", ""),
            "directory_id": item.get("directory_id", ""),
            "origin_relative_path": item["origin_relative_path"],
            "has_txt": bool(item.get("has_txt")),
        }
        if manifest_item not in payload_data["items"]:
            payload_data["items"].append(manifest_item)
            payload = json.dumps(
                payload_data, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            safe_root.atomic_write_bytes(
                manifest_relative, payload, expected_disk_version=manifest_version
            )


    def _apply_trash(
        self, safe_root: SafeSourceRoot, operation_id: str, item: dict[str, Any]
    ) -> None:
        files_relative = str(trash_files_relative_dir(operation_id))
        if item.get("item_type", "asset") == "directory":
            files_relative = str(trash_files_relative_dir(operation_id))
            target_relative = f"{files_relative}/{item['origin_relative_path']}"
            source_exists = safe_root.exists_directory(
                item["origin_relative_path"], allow_missing=True
            )
            target_exists = safe_root.exists_directory(
                target_relative, allow_missing=True
            )
            if source_exists and target_exists:
                raise GalleryFileOperationError(
                    "trash_target_conflict", {"operation_id": operation_id}
                )
            if not source_exists:
                if target_exists:
                    self._write_trash_manifest(safe_root, operation_id, item)
                    return
                raise GalleryFileOperationError(
                    "directory_missing",
                    {"relative_path": item["origin_relative_path"]},
                )
            try:
                safe_root.move_directory(
                    item["origin_relative_path"], target_relative
                )
                self._write_trash_manifest(safe_root, operation_id, item)
            except FileExistsError as error:
                raise GalleryFileOperationError(
                    "trash_target_conflict", {"operation_id": operation_id}
                ) from error
            except Exception:
                if safe_root.exists_directory(
                    target_relative, allow_missing=True
                ) and not safe_root.exists_directory(
                    item["origin_relative_path"], allow_missing=True
                ):
                    safe_root.move_directory(
                        target_relative, item["origin_relative_path"]
                    )
                raise
            return
        item["_txt_content"] = (
            self._read_txt_for_search(safe_root, item["txt_origin"])
            if item["has_txt"] and item["txt_origin"]
            else ""
        )
        moves = [
            (
                item["origin_relative_path"],
                f"{files_relative}/{item['origin_relative_path']}",
            )
        ]
        if item["has_txt"] and item["txt_origin"]:
            moves.append(
                (item["txt_origin"], f"{files_relative}/{item['txt_origin']}")
            )
        completed: list[tuple[str, str]] = []
        try:
            for source_relative, target_relative in moves:
                source_exists = safe_root.exists_regular(source_relative)
                target_exists = safe_root.exists_regular(target_relative)
                if source_exists and target_exists:
                    raise GalleryFileOperationError(
                        "trash_target_conflict", {"operation_id": operation_id}
                    )
                if not source_exists:
                    if target_exists:
                        continue
                    if source_relative == item["origin_relative_path"]:
                        raise GalleryFileOperationError(
                            "asset_file_missing", {"relative_path": source_relative}
                        )
                    # An externally removed optional TXT does not block image trash.
                    continue
                try:
                    safe_root.move_regular(source_relative, target_relative)
                except FileExistsError as error:
                    raise GalleryFileOperationError(
                        "trash_target_conflict", {"operation_id": operation_id}
                    ) from error
                completed.append((source_relative, target_relative))
            self._write_trash_manifest(safe_root, operation_id, item)
        except Exception:
            for source_relative, target_relative in reversed(completed):
                if safe_root.exists_regular(target_relative):
                    safe_root.move_regular(target_relative, source_relative)
            raise
    def _commit_trash_index(self, item: Mapping[str, Any]) -> None:
        now = self._clock()
        if item.get("item_type", "asset") == "directory":
            source_id = item["source_id"]
            relative_path = str(item["origin_relative_path"])
            prefix = f"{relative_path}/"
            with self._repo._transaction() as conn:  # noqa: SLF001
                conn.execute(
                    """
                    UPDATE gallery_directories SET
                        lifecycle_state='trashed', updated_at=?
                    WHERE source_id=? AND lifecycle_state='active'
                      AND (relative_path=? OR instr(relative_path, ?)=1)
                    """,
                    (now, source_id, relative_path, prefix),
                )
                conn.execute(
                    """
                    UPDATE gallery_assets SET
                        lifecycle_state='trashed', updated_at=?,
                        content_version=content_version+1
                    WHERE source_id=? AND lifecycle_state='active'
                      AND (relative_path=? OR instr(relative_path, ?)=1)
                    """,
                    (now, source_id, relative_path, prefix),
                )
                conn.execute(
                    """
                    DELETE FROM gallery_search_index WHERE asset_id IN (
                        SELECT id FROM gallery_assets
                        WHERE source_id=?
                          AND (relative_path=? OR instr(relative_path, ?)=1)
                    )
                    """,
                    (source_id, relative_path, prefix),
                )
                self._recount_source_directories(conn, source_id, now)
                self._bump_source_content_version_for_source(conn, source_id, now)
            return
        with self._repo._transaction() as conn:  # noqa: SLF001
            conn.execute(
                """
                UPDATE gallery_assets SET
                    lifecycle_state='trashed', updated_at=?,
                    content_version=content_version+1
                WHERE id=? AND lifecycle_state='active'
                """,
                (now, item["asset_id"]),
            )
            conn.execute(
                "DELETE FROM gallery_search_index WHERE asset_id=?",
                (item["asset_id"],),
            )
            self._bump_source_content_version(conn, item["asset_id"], now)
    # restore（undo 同路径）：移回原路径 + lifecycle='active'。

    def _apply_restore(self, safe_root: SafeSourceRoot, item: dict[str, Any]) -> None:
        if item.get("item_type", "asset") == "directory":
            operation_id = item["undo_of"]
            files_relative = str(trash_files_relative_dir(operation_id))
            source_relative = f"{files_relative}/{item['origin_relative_path']}"
            target_relative = item["origin_relative_path"]
            source_exists = safe_root.exists_directory(
                source_relative, allow_missing=True
            )
            target_exists = safe_root.exists_directory(
                target_relative, allow_missing=True
            )
            if source_exists and target_exists:
                raise GalleryFileOperationError(
                    "restore_target_conflict", {"target": target_relative}
                )
            if not source_exists:
                if target_exists:
                    return
                raise GalleryFileOperationError(
                    "trash_directory_missing", {"operation_id": operation_id}
                )
            try:
                safe_root.move_directory(source_relative, target_relative)
            except FileExistsError as error:
                raise GalleryFileOperationError(
                    "restore_target_conflict", {"target": target_relative}
                ) from error
            return
        operation_id = item["undo_of"]
        files_relative = str(trash_files_relative_dir(operation_id))
        item["_txt_content"] = (
            self._read_txt_for_search(
                safe_root, f"{files_relative}/{item['txt_origin']}"
            )
            if item["has_txt"] and item["txt_origin"]
            else ""
        )
        moves = [
            (
                f"{files_relative}/{item['target_relative_path']}",
                item["target_relative_path"],
            )
        ]
        if item["has_txt"] and item["txt_origin"]:
            moves.append(
                (f"{files_relative}/{item['txt_origin']}", item["txt_origin"])
            )
        completed: list[tuple[str, str]] = []
        try:
            for source_relative, target_relative in moves:
                source_exists = safe_root.exists_regular(source_relative)
                target_exists = safe_root.exists_regular(target_relative)
                if source_exists and target_exists:
                    raise GalleryFileOperationError(
                        "restore_target_conflict", {"target": target_relative}
                    )
                if not source_exists:
                    if target_exists:
                        continue
                    if target_relative == item["target_relative_path"]:
                        raise GalleryFileOperationError(
                            "trash_file_missing", {"operation_id": operation_id}
                        )
                    continue
                try:
                    safe_root.move_regular(source_relative, target_relative)
                except FileExistsError as error:
                    raise GalleryFileOperationError(
                        "restore_target_conflict", {"target": target_relative}
                    ) from error
                completed.append((source_relative, target_relative))
        except Exception:
            for source_relative, target_relative in reversed(completed):
                if safe_root.exists_regular(target_relative):
                    safe_root.move_regular(target_relative, source_relative)
            raise
    def _commit_restore_index(
        self, safe_root: SafeSourceRoot, item: dict[str, Any]
    ) -> None:
        now = self._clock()
        if item.get("item_type", "asset") == "directory":
            source_id = item["source_id"]
            relative_path = str(item["origin_relative_path"])
            prefix = f"{relative_path}/"
            with self._repo._transaction() as conn:  # noqa: SLF001
                conn.execute(
                    """
                    UPDATE gallery_directories SET
                        lifecycle_state='active', updated_at=?
                    WHERE source_id=? AND lifecycle_state='trashed'
                      AND (relative_path=? OR instr(relative_path, ?)=1)
                    """,
                    (now, source_id, relative_path, prefix),
                )
                conn.execute(
                    """
                    UPDATE gallery_assets SET
                        lifecycle_state='active', updated_at=?
                    WHERE source_id=? AND lifecycle_state='trashed'
                      AND (relative_path=? OR instr(relative_path, ?)=1)
                    """,
                    (now, source_id, relative_path, prefix),
                )
                self._rebuild_source_search_index(conn, safe_root, source_id)
                self._recount_source_directories(conn, source_id, now)
                self._bump_source_content_version_for_source(conn, source_id, now)
            return
        with self._repo._transaction() as conn:  # noqa: SLF001
            conn.execute(
                """
                UPDATE gallery_assets SET
                    lifecycle_state='active', updated_at=?
                WHERE id=? AND lifecycle_state='trashed'
                """,
                (now, item["asset_id"]),
            )
            row = conn.execute(
                """
                SELECT source_id, name, relative_path FROM gallery_assets
                WHERE id=?
                """,
                (item["asset_id"],),
            ).fetchone()
            if row is not None:
                conn.execute(
                    """
                    INSERT INTO gallery_search_index(
                        asset_id, source_id, file_name, relative_path, txt_content
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        item["asset_id"],
                        row["source_id"],
                        row["name"],
                        row["relative_path"],
                        item.get("_txt_content", ""),
                    ),
                )
            self._bump_source_content_version(conn, item["asset_id"], now)

    def _recount_source_directories(
        self, conn: Any, source_id: str, now: float
    ) -> None:
        rows = conn.execute(
            "SELECT id FROM gallery_directories "
            "WHERE source_id=? AND lifecycle_state='active'",
            (source_id,),
        ).fetchall()
        for row in rows:
            self._repo._recount_directory(  # noqa: SLF001
                conn, source_id, str(row["id"]), now
            )

    def _rebuild_source_search_index(
        self, conn: Any, safe_root: SafeSourceRoot, source_id: str
    ) -> None:
        conn.execute(
            """
            DELETE FROM gallery_search_index WHERE source_id=?
            """,
            (source_id,),
        )
        rows = conn.execute(
            """
            SELECT id, name, relative_path, txt_relative_path, txt_state
            FROM gallery_assets
            WHERE source_id=? AND lifecycle_state='active'
              AND dedup_visibility!='excluded'
            """,
            (source_id,),
        ).fetchall()
        for row in rows:
            txt_content = (
                self._read_txt_for_search(safe_root, str(row["txt_relative_path"]))
                if str(row["txt_state"]) == "normal"
                else ""
            )
            self._upsert_search_index(
                conn,
                asset_id=str(row["id"]),
                file_name=str(row["name"]),
                relative_path=str(row["relative_path"]),
                txt_content=txt_content,
            )

    @staticmethod
    def _bump_source_content_version_for_source(
        conn: Any, source_id: str, now: float
    ) -> None:
        conn.execute(
            """
            UPDATE gallery_sources
            SET content_version=content_version+1, updated_at=?
            WHERE id=?
            """,
            (now, source_id),
        )


    def _bump_source_content_version(
        self, conn: Any, asset_id: str, now: float
    ) -> None:
        """文件操作使来源内容前进（记忆 #37：去重结果过期）。"""
        conn.execute(
            """
            UPDATE gallery_sources
            SET content_version=content_version+1, updated_at=?
            WHERE id=(SELECT source_id FROM gallery_assets WHERE id=?)
            """,
            (now, asset_id),
        )

    # purge：物理删除回收文件与资产记录（不可撤销）。

    def _apply_purge(self, safe_root: SafeSourceRoot, item: dict[str, Any]) -> None:
        operation_id = item["purge_of"]
        if item.get("item_type", "asset") == "directory":
            files_relative = str(trash_files_relative_dir(operation_id))
            safe_root.remove_directory_tree(
                f"{files_relative}/{item['origin_relative_path']}",
                missing_ok=True,
            )
            return
        files_relative = str(trash_files_relative_dir(operation_id))
        targets = [f"{files_relative}/{item['origin_relative_path']}"]
        if item["has_txt"] and item["txt_origin"]:
            targets.append(f"{files_relative}/{item['txt_origin']}")
        for target in targets:
            safe_root.unlink_regular(target, missing_ok=True)

    def _commit_purge_index(self, item: Mapping[str, Any]) -> None:
        """清除回收项的资产/目录记录与 FTS 行（永久，不可撤销）。"""
        now = self._clock()
        if item.get("item_type", "asset") == "directory":
            source_id = item["source_id"]
            relative_path = str(item["origin_relative_path"])
            prefix = f"{relative_path}/"
            with self._repo._transaction() as conn:  # noqa: SLF001
                conn.execute(
                    """
                    DELETE FROM gallery_search_index WHERE asset_id IN (
                        SELECT id FROM gallery_assets
                        WHERE source_id=?
                          AND (relative_path=? OR instr(relative_path, ?)=1)
                    )
                    """,
                    (source_id, relative_path, prefix),
                )
                conn.execute(
                    """
                    DELETE FROM gallery_assets
                    WHERE source_id=?
                      AND (relative_path=? OR instr(relative_path, ?)=1)
                    """,
                    (source_id, relative_path, prefix),
                )
                conn.execute(
                    """
                    DELETE FROM gallery_directories
                    WHERE source_id=?
                      AND (relative_path=? OR instr(relative_path, ?)=1)
                    """,
                    (source_id, relative_path, prefix),
                )
                self._bump_source_content_version_for_source(conn, source_id, now)
            return
        with self._repo._transaction() as conn:  # noqa: SLF001
            self._bump_source_content_version(conn, item["asset_id"], now)
            conn.execute(
                "DELETE FROM gallery_search_index WHERE asset_id=?",
                (item["asset_id"],),
            )
            conn.execute(
                "DELETE FROM gallery_assets WHERE id=?",
                (item["asset_id"],),
            )
    # ---- 回滚 ----

    def _rollback_operation(
        self,
        operation_id: str,
        kind: str,
        items: list[dict[str, Any]],
    ) -> bool:
        """回滚已完成的步骤；返回是否完全回滚。"""
        self._set_operation_status(operation_id, "rolling_back")
        try:
            # 完成标记为 done 的项逆序回滚。
            done_items = [
                item for item in items
                if self._item_status(operation_id, item) == "done"
            ]
            for item in reversed(done_items):
                self._rollback_item(kind, item)
                self._set_item_status(operation_id, item, "rolled_back")
            return True
        except Exception:
            return False

    def _rollback_item(self, kind: str, item: dict[str, Any]) -> None:
        source = self._repo.get_source(item["source_id"])
        if source is None:
            raise GalleryFileOperationError("source_not_found")
        if item.get("item_type", "asset") == "directory":
            if kind == "trash":
                operation_id = self._find_operation_for_directory_item(item)
                moves = [(
                    f"{trash_files_relative_dir(operation_id)}/{item['origin_relative_path']}",
                    item["origin_relative_path"],
                )]
            elif kind == "restore":
                operation_id = item["undo_of"]
                files_relative = str(trash_files_relative_dir(operation_id))
                moves = [(
                    item["origin_relative_path"],
                    f"{files_relative}/{item['origin_relative_path']}",
                )]
            else:
                return
            with SafeSourceRoot(source["root_path"]) as safe_root:
                self._rollback_directory_moves(safe_root, moves)
                now = self._clock()
                source_id = item["source_id"]
                relative_path = str(item["origin_relative_path"])
                prefix = f"{relative_path}/"
                state = "active" if kind == "trash" else "trashed"
                with self._repo._transaction() as conn:  # noqa: SLF001
                    conn.execute(
                        """
                        UPDATE gallery_directories SET lifecycle_state=?, updated_at=?
                        WHERE source_id=?
                          AND (relative_path=? OR instr(relative_path, ?)=1)
                        """,
                        (state, now, source_id, relative_path, prefix),
                    )
                    conn.execute(
                        """
                        UPDATE gallery_assets SET lifecycle_state=?, updated_at=?
                        WHERE source_id=?
                          AND (relative_path=? OR instr(relative_path, ?)=1)
                        """,
                        (state, now, source_id, relative_path, prefix),
                    )
                    if state == "active":
                        self._rebuild_source_search_index(
                            conn, safe_root, source_id
                        )
                    else:
                        conn.execute(
                            """
                            DELETE FROM gallery_search_index WHERE asset_id IN (
                                SELECT id FROM gallery_assets
                                WHERE source_id=?
                                  AND (relative_path=? OR instr(relative_path, ?)=1)
                            )
                            """,
                            (source_id, relative_path, prefix),
                        )
                    self._recount_source_directories(conn, source_id, now)
                    self._bump_source_content_version_for_source(
                        conn, source_id, now
                    )
            return
        if item.get("has_txt") and not item.get("txt_origin"):
            asset = self._repo.get_asset(item["asset_id"])
            item["txt_origin"] = asset["txt_relative_path"] if asset else ""
        try:
            with SafeSourceRoot(source["root_path"]) as safe_root:
                if kind == "rename":
                    if item.get("has_txt") and item.get("txt_target"):
                        item["_txt_content"] = self._read_txt_for_search(
                            safe_root, item["txt_target"]
                        )
                    moves = [
                        (item["target_relative_path"], item["origin_relative_path"]),
                    ]
                    if item.get("has_txt") and item.get("txt_target"):
                        moves.append((item["txt_target"], item["txt_origin"]))
                    self._rollback_moves(safe_root, moves)
                    now = self._clock()
                    name = PurePosixPath(item["origin_relative_path"]).name
                    with self._repo._transaction() as conn:  # noqa: SLF001
                        conn.execute(
                            """
                            UPDATE gallery_assets SET
                                relative_path=?, name=?, sort_key=?,
                                txt_relative_path=?, updated_at=?
                            WHERE id=?
                            """,
                            (
                                item["origin_relative_path"],
                                name,
                                natural_sort_key(name),
                                item["txt_origin"] if item["has_txt"] else "",
                                now,
                                item["asset_id"],
                            ),
                        )
                        self._upsert_search_index(
                            conn,
                            asset_id=item["asset_id"],
                            file_name=name,
                            relative_path=item["origin_relative_path"],
                            txt_content=item.get("_txt_content", ""),
                        )
                elif kind == "trash":
                    operation_id = self._find_operation_for_item(item)
                    files_relative = str(trash_files_relative_dir(operation_id))
                    if item.get("has_txt") and item.get("txt_origin"):
                        item["_txt_content"] = self._read_txt_for_search(
                            safe_root, f"{files_relative}/{item['txt_origin']}"
                        )
                    moves = [
                        (
                            f"{files_relative}/{item['origin_relative_path']}",
                            item["origin_relative_path"],
                        )
                    ]
                    if item.get("has_txt") and item.get("txt_origin"):
                        moves.append(
                            (
                                f"{files_relative}/{item['txt_origin']}",
                                item["txt_origin"],
                            )
                        )
                    self._rollback_moves(safe_root, moves)
                    now = self._clock()
                    with self._repo._transaction() as conn:  # noqa: SLF001
                        conn.execute(
                            """
                            UPDATE gallery_assets SET
                                lifecycle_state='active', updated_at=?
                            WHERE id=?
                            """,
                            (now, item["asset_id"]),
                        )
                        row = conn.execute(
                            """
                            SELECT name, relative_path FROM gallery_assets WHERE id=?
                            """,
                            (item["asset_id"],),
                        ).fetchone()
                        if row is not None:
                            self._upsert_search_index(
                                conn,
                                asset_id=item["asset_id"],
                                file_name=row["name"],
                                relative_path=row["relative_path"],
                                txt_content=item.get("_txt_content", ""),
                            )
                elif kind == "restore":
                    operation_id = item["undo_of"]
                    files_relative = str(trash_files_relative_dir(operation_id))
                    moves = [
                        (
                            item["target_relative_path"],
                            f"{files_relative}/{item['target_relative_path']}",
                        )
                    ]
                    if item.get("has_txt") and item.get("txt_origin"):
                        moves.append(
                            (
                                item["txt_origin"],
                                f"{files_relative}/{item['txt_origin']}",
                            )
                        )
                    self._rollback_moves(safe_root, moves)
                    now = self._clock()
                    with self._repo._transaction() as conn:  # noqa: SLF001
                        conn.execute(
                            """
                            UPDATE gallery_assets SET
                                lifecycle_state='trashed', updated_at=?
                            WHERE id=?
                            """,
                            (now, item["asset_id"]),
                        )
                        conn.execute(
                            "DELETE FROM gallery_search_index WHERE asset_id=?",
                            (item["asset_id"],),
                        )
        except UnsafeSourcePathError as error:
            raise GalleryFileOperationError(
                "unsafe_source_path", {"relative_path": error.relative_path}
            ) from error

    @staticmethod
    def _rollback_moves(
        safe_root: SafeSourceRoot, moves: list[tuple[str, str]]
    ) -> None:
        for source_relative, target_relative in moves:
            source_exists = safe_root.exists_regular(source_relative)
            target_exists = safe_root.exists_regular(target_relative)
            if source_exists and target_exists:
                raise GalleryFileOperationError(
                    "rollback_target_conflict", {"target": target_relative}
                )
            if source_exists:
                safe_root.move_regular(source_relative, target_relative)

    @staticmethod
    def _upsert_search_index(
        conn: Any,
        *,
        asset_id: str,
        file_name: str,
        relative_path: str,
        txt_content: str,
    ) -> None:
        row = conn.execute(
            "SELECT source_id FROM gallery_assets WHERE id=?", (asset_id,)
        ).fetchone()
        conn.execute("DELETE FROM gallery_search_index WHERE asset_id=?", (asset_id,))
        if row is None:
            return
        conn.execute(
            """
            INSERT INTO gallery_search_index(
                asset_id, source_id, file_name, relative_path, txt_content
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (asset_id, row["source_id"], file_name, relative_path, txt_content),
        )
        # purge is intentionally irreversible once its physical delete starts.
    # ---- 恢复 ----

    def _recover_one(self, operation: dict[str, Any]) -> dict[str, Any]:
        operation_id = operation["operation_id"]
        items = self._repo_list_items(operation_id)
        kind = operation["kind"]
        status = operation["status"]
        if status == "applying":
            # 重放幂等移动：剩余 planned 项重执行（已 done 的不重复）。
            pending = [
                item for item in items if item["status"] == "planned"
            ]
            for item in pending:
                self._apply_item(operation_id, kind, item)
                self._set_item_status(operation_id, item, "done")
            self._set_operation_status(operation_id, "committed")
            return {"operation_id": operation_id, "outcome": "committed"}
        # rolling_back / recovery_required：再次回滚。
        rolled_back = self._rollback_operation(operation_id, kind, items)
        if rolled_back:
            self._set_operation_status(operation_id, "rolled_back")
            return {"operation_id": operation_id, "outcome": "rolled_back"}
        raise GalleryFileOperationError(
            "operation_recovery_required", {"operation_id": operation_id}
        )

    # ---- 辅助 ----

    def _get_operation(self, operation_id: str) -> dict[str, Any]:
        with self._repo._read() as conn:  # noqa: SLF001
            row = conn.execute(
                "SELECT * FROM gallery_file_operations WHERE id=?",
                (operation_id,),
            ).fetchone()
        if row is None:
            raise GalleryFileOperationError(
                "operation_not_found", {"operation_id": operation_id}
            )
        return _project_operation_row(row)

    def _repo_list_items(self, operation_id: str) -> list[dict[str, Any]]:
        with self._repo._read() as conn:  # noqa: SLF001
            rows = conn.execute(
                """
                SELECT * FROM gallery_file_operation_items
                WHERE operation_id=? ORDER BY ordinal
                """,
                (operation_id,),
            ).fetchall()
        return [_project_item_row(row) for row in rows]

    def _repo_list_unfinished(self) -> list[dict[str, Any]]:
        with self._repo._read() as conn:  # noqa: SLF001
            rows = conn.execute(
                """
                SELECT * FROM gallery_file_operations
                WHERE status IN ('planned', 'applying', 'rolling_back',
                                 'recovery_required')
                ORDER BY created_at
                """
            ).fetchall()
        return [_project_operation_row(row) for row in rows]

    def _repo_list_trash_operations(self) -> list[dict[str, Any]]:
        with self._repo._read() as conn:  # noqa: SLF001
            rows = conn.execute(
                """
                SELECT operations.*
                FROM gallery_file_operations AS operations
                WHERE operations.kind='trash'
                  AND operations.status='committed'
                  AND (
                      EXISTS (
                          SELECT 1
                          FROM gallery_file_operation_items AS items
                          JOIN gallery_assets AS assets ON assets.id=items.asset_id
                          WHERE items.operation_id=operations.id
                            AND items.status='done'
                            AND items.item_type!='directory'
                            AND assets.lifecycle_state='trashed'
                      )
                      OR EXISTS (
                          SELECT 1
                          FROM gallery_file_operation_items AS items
                          JOIN gallery_directories AS directories
                            ON directories.id=items.directory_id
                          WHERE items.operation_id=operations.id
                            AND items.status='done'
                            AND items.item_type='directory'
                            AND directories.lifecycle_state='trashed'
                      )
                  )
                ORDER BY operations.created_at DESC
                """
            ).fetchall()
        return [_project_operation_row(row) for row in rows]

    def _trash_operation_summary(
        self, operation: Mapping[str, Any]
    ) -> dict[str, Any]:
        operation_id = str(operation["operation_id"])
        with self._repo._read() as conn:  # noqa: SLF001
            rows = conn.execute(
                """
                SELECT items.*, assets.txt_relative_path AS asset_txt_relative_path
                FROM gallery_file_operation_items AS items
                LEFT JOIN gallery_assets AS assets ON assets.id=items.asset_id
                LEFT JOIN gallery_directories AS directories
                  ON directories.id=items.directory_id
                WHERE items.operation_id=?
                  AND items.status='done'
                  AND (
                      (items.item_type='directory'
                       AND directories.lifecycle_state='trashed')
                      OR (items.item_type!='directory'
                          AND assets.lifecycle_state='trashed')
                  )
                ORDER BY items.ordinal
                """,
                (operation_id,),
            ).fetchall()
        items: list[dict[str, Any]] = []
        for row in rows:
            item = _project_item_row(row)
            item["txt_relative_path"] = str(row["asset_txt_relative_path"] or "")
            items.append(item)

        disk_usage_bytes = 0
        item_error_count = 0
        items_by_source: dict[str, list[dict[str, Any]]] = {}
        for item in items:
            items_by_source.setdefault(item["source_id"], []).append(item)
        files_relative = str(trash_files_relative_dir(operation_id))
        for source_id, source_items in items_by_source.items():
            source = self._repo.get_source(source_id)
            if source is None:
                item_error_count += len(source_items)
                continue
            try:
                with SafeSourceRoot(source["root_path"]) as safe_root:
                    for item in source_items:
                        if item.get("item_type", "asset") == "directory":
                            try:
                                saw_directory = False
                                for entry in safe_root.iter_subtree(
                                    f"{files_relative}/{item['origin_relative_path']}",
                                    excluded_directories=frozenset(),
                                ):
                                    saw_directory = True
                                    disk_usage_bytes += sum(
                                        int(metadata.st_size)
                                        for _path, metadata in entry.files
                                    )
                                if not saw_directory:
                                    item_error_count += 1
                            except (OSError, UnsafeSourcePathError):
                                item_error_count += 1
                            continue
                        relative_paths = [
                            f"{files_relative}/{item['origin_relative_path']}"
                        ]
                        if item["has_txt"]:
                            txt_relative = (
                                item["txt_relative_path"]
                                or _txt_target_for_rename(item["origin_relative_path"])
                            )
                            relative_paths.append(f"{files_relative}/{txt_relative}")
                        item_has_error = False
                        for relative_path in relative_paths:
                            try:
                                disk_usage_bytes += safe_root.stat_regular(
                                    relative_path
                                ).size
                            except (OSError, UnsafeSourcePathError):
                                item_has_error = True
                        if item_has_error:
                            item_error_count += 1
            except (OSError, UnsafeSourcePathError):
                item_error_count += len(source_items)

        return {
            "operation_id": operation_id,
            "created_at": int(round(float(operation["created_at"]) * 1000)),
            "item_count": len(items),
            "has_txt_count": sum(1 for item in items if item["has_txt"]),
            "item_error_count": item_error_count,
            "disk_usage_bytes": disk_usage_bytes,
        }

    def _repo_list_trash(
        self, *, cursor: str | None, limit: int
    ) -> dict[str, Any]:
        with self._repo._read() as conn:  # noqa: SLF001
            predicate = """
                operations.kind='trash'
                AND operations.status='committed'
                AND (
                    EXISTS (
                        SELECT 1
                        FROM gallery_file_operation_items AS items
                        JOIN gallery_assets AS assets ON assets.id=items.asset_id
                        WHERE items.operation_id=operations.id
                          AND items.status='done'
                          AND items.item_type!='directory'
                          AND assets.lifecycle_state='trashed'
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM gallery_file_operation_items AS items
                        JOIN gallery_directories AS directories
                          ON directories.id=items.directory_id
                        WHERE items.operation_id=operations.id
                          AND items.status='done'
                          AND items.item_type='directory'
                          AND directories.lifecycle_state='trashed'
                    )
                )
            """
            params: list[Any] = []
            if cursor is not None:
                row = conn.execute(
                    "SELECT created_at, id FROM gallery_file_operations WHERE id=?",
                    (cursor,),
                ).fetchone()
                if row is None:
                    raise GalleryFileOperationError("invalid_cursor")
                predicate += " AND (operations.created_at, operations.id) < (?, ?)"
                params.extend([row["created_at"], row["id"]])
            rows = conn.execute(
                f"""
                SELECT operations.*
                FROM gallery_file_operations AS operations
                WHERE {predicate}
                ORDER BY operations.created_at DESC, operations.id DESC LIMIT ?
                """,
                (*params, limit + 1),
            ).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        operations = [
            self._trash_operation_summary(_project_operation_row(row)) for row in rows
        ]
        next_cursor = (
            operations[-1]["operation_id"] if has_more and operations else None
        )
        return {
            "operations": operations,
            "next_cursor": next_cursor,
        }

    def _set_operation_status(
        self, operation_id: str, status: str
    ) -> None:
        if status not in FILE_OPERATION_STATUSES:
            raise ValueError("invalid_operation_status")
        now = self._clock()
        finished = status in _TERMINAL_OPERATION_STATUSES
        with self._repo._transaction() as conn:  # noqa: SLF001
            conn.execute(
                ""
                "UPDATE gallery_file_operations"
                " SET status=?, updated_at=?,"
                "     finished_at=CASE WHEN ? THEN ? ELSE finished_at END"
                " WHERE id=?",
                (status, now, 1 if finished else 0, now, operation_id),
            )

    def _set_item_status(
        self, operation_id: str, item: Mapping[str, Any], status: str
    ) -> None:
        ordinal = item.get("ordinal", 0)
        with self._repo._transaction() as conn:  # noqa: SLF001
            conn.execute(
                """
                UPDATE gallery_file_operation_items
                SET status=? WHERE operation_id=? AND ordinal=?
                """,
                (status, operation_id, ordinal),
            )

    def _item_status(
        self, operation_id: str, item: Mapping[str, Any]
    ) -> str:
        ordinal = item.get("ordinal", 0)
        with self._repo._read() as conn:  # noqa: SLF001
            row = conn.execute(
                """
                SELECT status FROM gallery_file_operation_items
                WHERE operation_id=? AND ordinal=?
                """,
                (operation_id, ordinal),
            ).fetchone()
        return "" if row is None else str(row["status"])

    def _directory_has_lifecycle(self, directory_id: str, lifecycle: str) -> bool:
        with self._repo._read() as conn:  # noqa: SLF001
            row = conn.execute(
                """
                SELECT 1 FROM gallery_directories
                WHERE id=? AND lifecycle_state=?
                """,
                (directory_id, lifecycle),
            ).fetchone()
        return row is not None

    def _find_operation_for_directory_item(self, item: Mapping[str, Any]) -> str:
        with self._repo._read() as conn:  # noqa: SLF001
            row = conn.execute(
                """
                SELECT operation_id FROM gallery_file_operation_items
                WHERE directory_id=? ORDER BY rowid DESC LIMIT 1
                """,
                (item["directory_id"],),
            ).fetchone()
        return "" if row is None else str(row["operation_id"])


    def _find_operation_for_item(self, item: Mapping[str, Any]) -> str:
        with self._repo._read() as conn:  # noqa: SLF001
            row = conn.execute(
                """
                SELECT operation_id FROM gallery_file_operation_items
                WHERE asset_id=? ORDER BY created_at DESC LIMIT 1
                """.replace(
                    "ORDER BY created_at DESC", "ORDER BY rowid DESC"
                ),
                (item["asset_id"],),
            ).fetchone()
        return "" if row is None else str(row["operation_id"])

    def _find_trash_operation_for_item(
        self, item: Mapping[str, Any], current_operation_id: str
    ) -> str:
        item_type = item.get("item_type", "asset")
        match_column = "directory_id" if item_type == "directory" else "asset_id"
        match_value = item.get(match_column, "")
        with self._repo._read() as conn:  # noqa: SLF001
            row = conn.execute(
                f"""
                SELECT items.operation_id
                FROM gallery_file_operation_items AS items
                JOIN gallery_file_operations AS operations
                  ON operations.id=items.operation_id
                WHERE operations.kind='trash'
                  AND items.status='done'
                  AND items.operation_id != ?
                  AND items.source_id=?
                  AND items.{match_column}=?
                ORDER BY items.rowid DESC LIMIT 1
                """,
                (current_operation_id, item["source_id"], match_value),
            ).fetchone()
        if row is None:
            raise GalleryFileOperationError(
                "trash_operation_not_found",
                {"relative_path": item.get("origin_relative_path", "")},
            )
        return str(row["operation_id"])

    def _operation_summary(self, operation_id: str) -> dict[str, Any]:
        operation = self._get_operation(operation_id)
        items = self._repo_list_items(operation_id)
        operation["item_count"] = len(items)
        operation["has_txt_count"] = sum(1 for i in items if i["has_txt"])
        return operation


def _project_operation_row(row: Any) -> dict[str, Any]:
    return {
        "operation_id": row["id"],
        "kind": row["kind"],
        "status": row["status"],
        "source_ids": json.loads(row["source_ids_json"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "finished_at": row["finished_at"],
    }


def _project_item_row(row: Any) -> dict[str, Any]:
    return {
        "operation_id": row["operation_id"],
        "ordinal": row["ordinal"],
        "source_id": row["source_id"],
        "item_type": row["item_type"] if "item_type" in row.keys() else "asset",
        "directory_id": (
            row["directory_id"] if "directory_id" in row.keys() else ""
        ),
        "asset_id": row["asset_id"],
        "origin_relative_path": row["origin_relative_path"],
        "target_relative_path": row["target_relative_path"],
        "has_txt": bool(row["has_txt"]),
        "expected_asset_version": row["expected_asset_version"],
        "expected_txt_version": row["expected_txt_version"],
        "status": row["status"],
        "error_code": row["error_code"],
    }


def _validate_new_base_name(
    new_base_name: str, current_name: str, extension: str
) -> str:
    """校验重命名基本名：只改基本名、保留扩展名、Windows 安全字符。"""
    if not new_base_name or len(new_base_name) > 255:
        raise GalleryFileOperationError("invalid_rename_target")
    if "/" in new_base_name or "\\" in new_base_name:
        raise GalleryFileOperationError("invalid_rename_target")
    if new_base_name in {".", ".."}:
        raise GalleryFileOperationError("invalid_rename_target")
    if new_base_name.endswith(" ") or new_base_name.endswith("."):
        raise GalleryFileOperationError("invalid_rename_target")
    # 保留扩展名：新基本名不得带自己的扩展名（UI 直接传基本名）。
    if new_base_name.lower().endswith(extension.lower()):
        raise GalleryFileOperationError(
            "invalid_rename_target",
            {"reason": "extension_not_allowed_in_base_name"},
        )
    forbidden = set('<>:"|?*')
    if any(ch in forbidden for ch in new_base_name):
        raise GalleryFileOperationError("invalid_rename_target")
    if any(ord(ch) < 0x20 for ch in new_base_name):
        raise GalleryFileOperationError("invalid_rename_target")
    return f"{new_base_name}{extension}"


def _txt_target_for_rename(new_image_relative: str) -> str:
    parts = new_image_relative.rsplit("/", 1)
    directory = parts[0] + "/" if len(parts) == 2 else ""
    stem = parts[-1].rsplit(".", 1)[0]
    return f"{directory}{stem}.txt"


def _parent_relative(relative: str) -> str:
    parent, _, _ = relative.rpartition("/")
    return parent


def _path_is_within(path: str, directory: str) -> bool:
    """Return whether ``path`` is the directory itself or a descendant."""
    return path == directory or (directory != "" and path.startswith(f"{directory}/"))



__all__ = [
    "GalleryFileOperations",
    "GalleryFileOperationError",
    "FILE_OPERATION_KINDS",
    "FILE_OPERATION_STATUSES",
]
