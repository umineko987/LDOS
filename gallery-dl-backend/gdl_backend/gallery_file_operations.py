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
import os
import threading
import uuid
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

from ._database_gallery_repository import (
    GalleryRepository,
    GalleryVersionConflict,
)
from .gallery_catalog import (
    natural_sort_key,
    trash_files_relative_dir,
    trash_operation_manifest_relative_path,
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
    ) -> None:
        import time

        self._repo = repository
        self._clock = clock or time.time
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

    def trash_assets(self, asset_ids: list[str]) -> dict[str, Any]:
        """批量回收：图片与同名 TXT 成对移入来源回收区，作为单个逻辑操作。"""
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
        items = []
        for asset in assets:
            has_txt = bool(
                asset["txt_relative_path"]
                and asset["txt_state"] not in {"missing", "pair_conflict"}
            )
            items.append(
                {
                    "source_id": asset["source_id"],
                    "asset_id": asset["asset_id"],
                    "origin_relative_path": asset["relative_path"],
                    "target_relative_path": "",
                    "has_txt": has_txt,
                    "expected_asset_version": int(asset["content_version"]),
                    "expected_txt_version": int(asset["txt_version"]),
                    "txt_origin": asset["txt_relative_path"] if has_txt else "",
                    "txt_target": "",
                }
            )
        return self._execute(kind="trash", items=items)

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
            asset = self._repo.get_asset(item["asset_id"])
            if asset is None or asset["lifecycle_state"] != "trashed":
                continue
            restore_items.append(
                {
                    "source_id": item["source_id"],
                    "asset_id": item["asset_id"],
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
                "source_id": item["source_id"],
                "asset_id": item["asset_id"],
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
            return self._execute_locked(
                kind=kind, items=items, source_ids=source_ids,
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
                conn.execute(
                    """
                    INSERT INTO gallery_file_operation_items(
                        operation_id, ordinal, source_id, asset_id,
                        origin_relative_path, target_relative_path, has_txt,
                        expected_asset_version, expected_txt_version, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')
                    """,
                    (
                        operation_id,
                        ordinal,
                        item["source_id"],
                        item["asset_id"],
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
        root = Path(source["root_path"])
        # 崩溃恢复重放时 item 可能缺少运行期字段（txt_origin/undo_of/purge_of），
        # 从资产索引重新推导。
        asset = self._repo.get_asset(item["asset_id"])
        if asset is not None:
            if not item.get("txt_origin") and item.get("has_txt"):
                item["txt_origin"] = asset["txt_relative_path"] or ""
            if not item.get("undo_of") and not item.get("purge_of"):
                item["undo_of"] = self._find_operation_for_item(item)
        elif kind in {"rename", "trash"}:
            raise GalleryFileOperationError(
                "asset_not_found", {"asset_id": item["asset_id"]}
            )
        if kind == "rename":
            self._apply_rename(root, item)
            self._commit_rename_index(item)
        elif kind == "trash":
            self._apply_trash(root, operation_id, item)
            self._commit_trash_index(item)
        elif kind == "restore":
            self._apply_restore(root, item)
            self._commit_restore_index(item)
        elif kind == "purge":
            self._apply_purge(root, item)
            self._commit_purge_index(item)
        else:  # pragma: no cover - kind 由入口校验
            raise GalleryFileOperationError("invalid_operation_kind")

    # rename：成对改名 + 索引原位更新（ID 保持稳定）。

    def _apply_rename(self, root: Path, item: dict[str, Any]) -> None:
        old_path = root / item["origin_relative_path"]
        new_path = root / item["target_relative_path"]
        _ensure_parent(new_path)
        # 冲突预检：目标图片或 TXT 已存在时阻止整个操作。
        if new_path.exists() or new_path.is_symlink():
            raise GalleryFileOperationError(
                "rename_target_conflict",
                {"target": item["target_relative_path"]},
            )
        moves: list[tuple[Path, Path]] = [(old_path, new_path)]
        if item["has_txt"]:
            old_txt = root / item["txt_origin"]
            new_txt = root / item["txt_target"]
            if new_txt.exists() or new_txt.is_symlink():
                raise GalleryFileOperationError(
                    "rename_target_conflict",
                    {"target": item["txt_target"]},
                )
            moves.append((old_txt, new_txt))
        for source, target in moves:
            if not source.exists():
                raise GalleryFileOperationError(
                    "asset_file_missing",
                    {"relative_path": str(item["origin_relative_path"])},
                )
            os.replace(source, target)

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
                    ) VALUES (?, ?, ?, ?, '')
                    """,
                    (item["asset_id"], row["source_id"], name,
                     item["target_relative_path"]),
                )
            self._bump_source_content_version(conn, item["asset_id"], now)

    # trash：移入 `.imageweave/trash/<op>/files/…` + lifecycle='trashed'。

    def _apply_trash(
        self, root: Path, operation_id: str, item: dict[str, Any]
    ) -> None:
        files_dir = root / trash_files_relative_dir(operation_id)
        image_origin = root / item["origin_relative_path"]
        image_target = files_dir / item["origin_relative_path"]
        _ensure_parent(image_target)
        moves: list[tuple[Path, Path]] = []
        if image_origin.exists():
            if image_target.exists():
                raise GalleryFileOperationError(
                    "trash_target_conflict",
                    {"operation_id": operation_id},
                )
            moves.append((image_origin, image_target))
        elif not image_target.exists():
            raise GalleryFileOperationError(
                "asset_file_missing",
                {"relative_path": item["origin_relative_path"]},
            )
        if item["has_txt"] and item["txt_origin"]:
            txt_origin = root / item["txt_origin"]
            txt_target = files_dir / item["txt_origin"]
            if txt_origin.exists():
                if txt_target.exists():
                    raise GalleryFileOperationError(
                        "trash_target_conflict",
                        {"operation_id": operation_id},
                    )
                moves.append((txt_origin, txt_target))
        for source, target in moves:
            os.replace(source, target)
        # operation.json 元数据（幂等写）。
        manifest_path = root / trash_operation_manifest_relative_path(operation_id)
        _ensure_parent(manifest_path)
        if not manifest_path.exists():
            manifest_path.write_text(
                json.dumps(
                    {
                        "operation_id": operation_id,
                        "kind": "trash",
                        "created_at": self._clock(),
                        "items": [
                            {
                                "asset_id": item["asset_id"],
                                "origin_relative_path": item["origin_relative_path"],
                                "has_txt": bool(item["has_txt"]),
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

    def _commit_trash_index(self, item: dict[str, Any]) -> None:
        now = self._clock()
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

    def _apply_restore(self, root: Path, item: dict[str, Any]) -> None:
        operation_id = item["undo_of"]
        files_dir = root / trash_files_relative_dir(operation_id)
        image_target = root / item["target_relative_path"]
        image_origin = files_dir / item["target_relative_path"]
        _ensure_parent(image_target)
        # 恢复前重新检查原路径冲突（§3.5：绝不覆盖）。
        if image_target.exists() or image_target.is_symlink():
            raise GalleryFileOperationError(
                "restore_target_conflict",
                {"target": item["target_relative_path"]},
            )
        moves: list[tuple[Path, Path]] = []
        if image_origin.exists():
            moves.append((image_origin, image_target))
        else:
            raise GalleryFileOperationError(
                "trash_file_missing",
                {"operation_id": operation_id},
            )
        if item["has_txt"] and item["txt_origin"]:
            txt_relative = item["txt_origin"]
            txt_origin = files_dir / txt_relative
            txt_target = root / txt_relative
            if txt_origin.exists():
                if txt_target.exists():
                    raise GalleryFileOperationError(
                        "restore_target_conflict",
                        {"target": txt_relative},
                    )
                moves.append((txt_origin, txt_target))
        for source, target in moves:
            os.replace(source, target)

    def _commit_restore_index(self, item: dict[str, Any]) -> None:
        now = self._clock()
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
                    ) VALUES (?, ?, ?, ?, '')
                    """,
                    (item["asset_id"], row["source_id"], row["name"],
                     row["relative_path"]),
                )
            self._bump_source_content_version(conn, item["asset_id"], now)

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

    def _apply_purge(self, root: Path, item: dict[str, Any]) -> None:
        operation_id = item["purge_of"]
        files_dir = root / trash_files_relative_dir(operation_id)
        targets = [files_dir / item["origin_relative_path"]]
        if item["has_txt"] and item["txt_origin"]:
            targets.append(files_dir / item["txt_origin"])
        for target in targets:
            try:
                target.unlink()
            except FileNotFoundError:
                pass

    def _commit_purge_index(self, item: dict[str, Any]) -> None:
        """清除回收项的资产记录与 FTS 行（永久，不可撤销）。"""
        now = self._clock()
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
        root = Path(source["root_path"])
        if item.get("has_txt") and not item.get("txt_origin"):
            asset = self._repo.get_asset(item["asset_id"])
            item["txt_origin"] = asset["txt_relative_path"] if asset else ""
        if kind == "rename":
            # 反向改名。
            old = root / item["origin_relative_path"]
            new = root / item["target_relative_path"]
            if new.exists():
                os.replace(new, old)
            if item["has_txt"] and item["txt_target"]:
                new_txt = root / item["txt_target"]
                old_txt = root / item["txt_origin"]
                if new_txt.exists():
                    os.replace(new_txt, old_txt)
            # 索引还原。
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
                        ) VALUES (?, ?, ?, ?, '')
                        """,
                        (item["asset_id"], row["source_id"], name,
                         item["origin_relative_path"]),
                    )
        elif kind == "trash":
            # 从回收区移回。
            operation_id = self._find_operation_for_item(item)
            files_dir = root / trash_files_relative_dir(operation_id)
            image_origin = files_dir / item["origin_relative_path"]
            image_target = root / item["origin_relative_path"]
            if image_origin.exists():
                _ensure_parent(image_target)
                os.replace(image_origin, image_target)
            if item["has_txt"] and item["txt_origin"]:
                txt_origin = files_dir / item["txt_origin"]
                txt_target = root / item["txt_origin"]
                if txt_origin.exists():
                    os.replace(txt_origin, txt_target)
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
                    "SELECT source_id, name, relative_path FROM gallery_assets WHERE id=?",
                    (item["asset_id"],),
                ).fetchone()
                if row is not None:
                    conn.execute(
                        """
                        INSERT INTO gallery_search_index(
                            asset_id, source_id, file_name, relative_path, txt_content
                        ) VALUES (?, ?, ?, ?, '')
                        """,
                        (item["asset_id"], row["source_id"], row["name"],
                         row["relative_path"]),
                    )
        elif kind == "restore":
            # 回滚恢复：把文件再移回回收区。
            operation_id = item["undo_of"]
            files_dir = root / trash_files_relative_dir(operation_id)
            image_target = root / item["target_relative_path"]
            image_origin = files_dir / item["target_relative_path"]
            if image_target.exists():
                _ensure_parent(image_origin)
                os.replace(image_target, image_origin)
            if item["has_txt"] and item["txt_origin"]:
                txt_target = root / item["txt_origin"]
                txt_origin = files_dir / item["txt_origin"]
                if txt_target.exists():
                    os.replace(txt_target, txt_origin)
            now = self._clock()
            with self._repo._transaction() as conn:  # noqa: SLF001
                conn.execute(
                    "UPDATE gallery_assets SET lifecycle_state='trashed', updated_at=? WHERE id=?",
                    (now, item["asset_id"]),
                )
                conn.execute(
                    "DELETE FROM gallery_search_index WHERE asset_id=?",
                    (item["asset_id"],),
                )
        # purge 不可回滚（物理删除）；回滚阶段遇到 purge 项视为失败。

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
                SELECT * FROM gallery_file_operations
                WHERE kind='trash' AND status='committed'
                ORDER BY created_at DESC
                """
            ).fetchall()
        return [_project_operation_row(row) for row in rows]

    def _repo_list_trash(
        self, *, cursor: str | None, limit: int
    ) -> dict[str, Any]:
        with self._repo._read() as conn:  # noqa: SLF001
            predicate = "kind='trash' AND status='committed'"
            params: list[Any] = []
            if cursor is not None:
                row = conn.execute(
                    "SELECT created_at, id FROM gallery_file_operations WHERE id=?",
                    (cursor,),
                ).fetchone()
                if row is None:
                    raise GalleryFileOperationError("invalid_cursor")
                predicate += " AND (created_at, id) < (?, ?)"
                params.extend([row["created_at"], row["id"]])
            rows = conn.execute(
                f"""
                SELECT * FROM gallery_file_operations
                WHERE {predicate}
                ORDER BY created_at DESC, id DESC LIMIT ?
                """,
                (*params, limit + 1),
            ).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        operations = [_project_operation_row(row) for row in rows]
        for operation in operations:
            items = self._repo_list_items(operation["operation_id"])
            done = [item for item in items if item["status"] == "done"]
            operation["item_count"] = len(done)
            operation["has_txt_count"] = sum(1 for i in done if i["has_txt"])
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


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


__all__ = [
    "GalleryFileOperations",
    "GalleryFileOperationError",
    "FILE_OPERATION_KINDS",
    "FILE_OPERATION_STATUSES",
]
