"""数据集导出：把流水线最后一段（export）的输出复制成训练用目录。

- 布局：kohya（``{repeats}_{trigger}``）或平铺（文件夹名默认取数据集名）。
- 可选顺序重命名（0001.png …）；不重命名时同主干名冲突加 ``_2`` 后缀并在预览里列出。
- 标注变换：触发词置顶、按黑名单删标签、下划线转空格（颜文字除外）、去重，
  非空才写同名 ``.txt``。
- 只导出 export 阶段的输出：该段输入里去掉本段记了「排除」的图。

安全与续传：输出只写进目标目录下的自有临时目录（``.ldos-copy-dataset-<id>``，
描述符锚定，见 safe_copy），全部写完、按日志核对后一次性不覆盖改名成最终名字。
每个文件写完（fsync）就在 dataset_export_items 里记 ``staged``——这就是逐文件日志：
进程崩溃后任务在启动时记为 interrupted，续传时认领原临时目录、删掉没写完的文件、
只补复制未完成的条目。最终名字被占用时任务失败但保留临时目录，腾出名字后可续传。
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ._database_dataset_repository import DatasetNotFound
from .dataset_service import DatasetError, DatasetService
from .gallery_catalog import canonical_root_key, decode_txt_bytes, root_relation
from .gallery_safe_paths import GalleryFilesystemLocks, SafeSourceRoot, UnsafeSourcePathError
from .redaction import safe_exception_category
from .safe_copy import (
    TEMPORARY_PREFIX,
    CopyCancelled,
    SafeCopyError,
    TargetRoot,
    copy_stream,
    portable_name_key,
    validate_staged_tree,
)


logger = logging.getLogger(__name__)

EXPORT_LAYOUTS: tuple[str, ...] = ("kohya", "flat")
EXPORT_RENAMES: tuple[str, ...] = ("none", "sequential")
EXPORT_STATUSES: tuple[str, ...] = ("queued", "running", "succeeded", "failed", "cancelled", "interrupted")
ACTIVE_EXPORT_STATUSES = frozenset({"queued", "running"})
# 这些失败保留临时目录，可以续传；其余失败清理临时目录。
RESUMABLE_ERRORS = frozenset({"export_target_exists", "copy_io_error"})
MAX_ACTIVE_EXPORTS = 2
PREVIEW_LIMIT = 100
JOB_KIND = "dataset.export"
JOB_TITLE = "导出数据集"
_CAPTION_MAX_BYTES = 1024 * 1024
_UNREADABLE_TXT_STATES = frozenset({"invalid_encoding", "io_error", "pair_conflict"})
# WD14 标签里的颜文字：下划线是表情的一部分，不转空格。
KAOMOJI_TAGS = frozenset({
    "0_0", "(o)_(o)", "+_+", "+_-", "._.", "<o>_<o>", "<|>_<|>", "=_=", ">_<", "3_3",
    "6_9", ">_o", "@_@", "^_^", "o_o", "u_u", "x_x", "|_|", "||_||",
})
_FORBIDDEN_NAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WINDOWS_RESERVED = frozenset({"con", "prn", "aux", "nul", *(f"com{n}" for n in range(1, 10)),
                               *(f"lpt{n}" for n in range(1, 10))})
_STAGE_RUN_STATUS = {"succeeded": "succeeded", "failed": "failed", "cancelled": "cancelled",
                     "interrupted": "failed"}
_JOB_STATUS = {"queued": "queued", "running": "running", "succeeded": "succeeded", "failed": "failed",
               "cancelled": "cancelled", "interrupted": "failed"}


# ---- 标注变换与命名 ----


def normalize_tag(tag: str) -> str:
    """比较用的标签键：下划线当空格、折叠空白、忽略大小写。"""
    return " ".join(tag.replace("_", " ").split()).casefold()


def transform_caption(
    text: str,
    *,
    trigger: str = "",
    pin_trigger: bool = True,
    blacklist: Sequence[str] = (),
    underscore_to_space: bool = False,
) -> str:
    """逗号分隔的标签串 → 导出用的标注。"""
    blocked = {normalize_tag(tag) for tag in blacklist if normalize_tag(tag)}
    trigger = trigger.strip()
    trigger_key = normalize_tag(trigger) if trigger else ""
    result: list[str] = []
    seen: set[str] = set()
    for raw in text.replace("\r", "\n").replace("\n", ",").split(","):
        tag = raw.strip()
        key = normalize_tag(tag)
        if not key or key in blocked or key in seen:
            continue
        if pin_trigger and key == trigger_key:
            continue
        if underscore_to_space and tag not in KAOMOJI_TAGS:
            tag = tag.replace("_", " ")
        seen.add(key)
        result.append(tag)
    if pin_trigger and trigger:
        result.insert(0, trigger)
    return ", ".join(result)


def safe_folder_name(name: str) -> str:
    """跨平台可用的文件夹名：去掉非法字符、首尾空白与点，避开 Windows 保留名。"""
    cleaned = _FORBIDDEN_NAME_CHARS.sub("_", name)
    cleaned = " ".join(cleaned.split()).strip(" .")
    cleaned = cleaned[:120].strip(" .")
    if not cleaned:
        return "dataset"
    if cleaned.split(".", 1)[0].casefold() in _WINDOWS_RESERVED:
        cleaned += "_"
    return cleaned


def staging_name(export_id: str) -> str:
    return f"{TEMPORARY_PREFIX}dataset-{export_id}"


@dataclass
class _PlanItem:
    ordinal: int
    asset_id: str
    source_id: str
    name: str
    source_relative_path: str
    output_relative_path: str
    txt_source_relative_path: str
    txt_output_relative_path: str
    caption: str
    image_size_bytes: int
    expected_content_version: int
    expected_txt_version: int
    content_sha256: str

    @property
    def caption_bytes(self) -> bytes:
        return self.caption.encode("utf-8")


@dataclass
class _Plan:
    dataset_id: str
    options: dict[str, Any]
    target: Path
    target_key: str
    target_identity: tuple[int, int] | None
    target_exists: bool
    items: list[_PlanItem]
    collisions: list[dict[str, Any]]
    blockers: list[dict[str, Any]]

    @property
    def folder_name(self) -> str:
        return str(self.options["folder_name"])

    @property
    def output_path(self) -> str:
        return str(self.target / self.folder_name)

    @property
    def image_bytes(self) -> int:
        return sum(item.image_size_bytes for item in self.items)

    @property
    def txt_bytes(self) -> int:
        return sum(len(item.caption_bytes) for item in self.items if item.txt_output_relative_path)


class DatasetExportService:
    def __init__(
        self,
        *,
        database: Any,
        datasets: DatasetService,
        filesystem_locks: GalleryFilesystemLocks | None = None,
        jobs: Any = None,
        events: Any = None,
        chunk_size: int = 1024 * 1024,
        threaded: bool = True,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._db = database
        self._repo = database.datasets
        self._gallery = database.gallery
        self._datasets = datasets
        self._locks = filesystem_locks or GalleryFilesystemLocks()
        self._jobs = jobs
        self._events = events
        self._chunk_size = max(1, int(chunk_size))
        self._threaded = threaded
        self._clock = clock
        self._lock = threading.RLock()
        self._active: dict[str, tuple[str, str]] = {}
        self._cancel_events: dict[str, threading.Event] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._stopping = False
        # 测试钩子：每个条目记完日志后调用 (export_id, 第几个条目，从 1 起)。
        self.after_item: Callable[[str, int], None] | None = None

    @classmethod
    def for_container(cls, container: Any) -> "DatasetExportService":
        return cls(
            database=container.db,
            datasets=container.datasets,
            filesystem_locks=container.gallery_filesystem_locks,
            jobs=container.jobs,
            events=container.events,
        )

    # ---- 计划 ----

    def preview(self, dataset_id: str, options: Mapping[str, Any]) -> dict[str, Any]:
        """dry_run：只算计划，不碰目标目录（除了查最终名字是否已被占用）。"""
        plan = self._plan(dataset_id, options)
        return self._project_plan(plan)

    def _plan(self, dataset_id: str, raw: Mapping[str, Any]) -> _Plan:
        dataset = self._repo.get_dataset(dataset_id)
        if dataset is None:
            raise DatasetError(404, "dataset_not_found", "数据集不存在")
        options = self._normalize_options(dataset, raw)
        target, target_key = self._target(options["target_path"])
        excluded = {
            row["asset_id"] for row in self._repo.list_decisions(dataset_id)
            if row["stage"] == "export" and row["decision"] == "exclude"
        }
        members = [member for member in self._datasets.stage_input(dataset_id, "export")
                   if member["asset_id"] not in excluded]
        if not members:
            raise DatasetError(409, "export_empty", "导出阶段没有可导出的图片")

        blockers: dict[str, list[str]] = {}
        sources: dict[str, dict[str, Any]] = {}
        for source_id in dict.fromkeys(str(member["source_id"]) for member in members):
            source = self._gallery.get_source(source_id)
            if source is None or source.get("availability") != "available":
                blockers.setdefault("source_offline", []).append(source_id)
                continue
            sources[source_id] = source
            if root_relation(target_key, str(source["canonical_root_key"])) in {"same", "descendant"}:
                raise DatasetError(409, "target_inside_source", "导出目录不能在图库来源里面",
                                   details={"source_id": source_id})

        items, collisions = self._name_items(members, options)
        self._read_captions(items, members, sources, options, blockers)
        identity, exists = self._probe_target(target, options["folder_name"])
        return _Plan(
            dataset_id=dataset_id,
            options=options,
            target=target,
            target_key=target_key,
            target_identity=identity,
            target_exists=exists,
            items=items,
            collisions=collisions,
            blockers=[{"code": code, "count": len(ids), "ids": ids[:50]} for code, ids in blockers.items()],
        )

    @staticmethod
    def _normalize_options(dataset: Mapping[str, Any], raw: Mapping[str, Any]) -> dict[str, Any]:
        layout = str(raw.get("layout") or "kohya")
        if layout not in EXPORT_LAYOUTS:
            raise DatasetError(422, "export_layout_invalid", "导出布局只能是 kohya 或 flat")
        rename = str(raw.get("rename") or "none")
        if rename not in EXPORT_RENAMES:
            raise DatasetError(422, "export_rename_invalid", "重命名只能是 none 或 sequential")
        repeats = int(raw.get("repeats") or 10)
        if not 1 <= repeats <= 10000:
            raise DatasetError(422, "export_repeats_invalid", "repeats 必须在 1–10000 之间")
        trigger = raw.get("trigger_word")
        trigger = str(dataset.get("trigger_word") or "" if trigger is None else trigger).strip()
        requested = str(raw.get("folder_name") or "").strip()
        if requested and safe_folder_name(requested) != requested:
            raise DatasetError(422, "export_folder_name_invalid", "文件夹名含有不能用的字符",
                               details={"suggestion": safe_folder_name(requested)})
        if layout == "kohya":
            if not (requested or trigger):
                raise DatasetError(422, "export_trigger_required", "kohya 布局需要触发词（或指定文件夹名）")
            folder = f"{repeats}_{requested or safe_folder_name(trigger)}"
        else:
            folder = requested or safe_folder_name(str(dataset.get("name") or ""))
        if folder.startswith(TEMPORARY_PREFIX) or folder.startswith(".ldos"):
            raise DatasetError(422, "export_folder_name_invalid", "文件夹名不能以 .ldos 开头")
        blacklist = [str(tag).strip() for tag in raw.get("tag_blacklist") or () if str(tag).strip()]
        return {
            "target_path": str(raw.get("target_path") or ""),
            "layout": layout,
            "repeats": repeats,
            "trigger_word": trigger,
            "folder_name": folder,
            "rename": rename,
            "include_captions": bool(raw.get("include_captions", True)),
            "pin_trigger": bool(raw.get("pin_trigger", True)),
            "tag_blacklist": blacklist,
            "underscore_to_space": bool(raw.get("underscore_to_space", False)),
        }

    @staticmethod
    def _target(raw_path: str) -> tuple[Path, str]:
        if not raw_path or "\x00" in raw_path:
            raise DatasetError(422, "target_path_invalid", "导出目录无效")
        target = Path(raw_path)
        if not target.is_absolute():
            raise DatasetError(422, "target_path_not_absolute", "导出目录必须是绝对路径")
        try:
            key = canonical_root_key(target)
        except (OSError, RuntimeError, ValueError):
            raise DatasetError(422, "target_path_invalid", "导出目录无效") from None
        if not target.is_dir():
            raise DatasetError(409, "target_unavailable", "导出目录不存在或不是文件夹")
        return target, key

    @staticmethod
    def _probe_target(target: Path, folder: str) -> tuple[tuple[int, int], bool]:
        try:
            with TargetRoot(target) as root:
                return root.identity, root.entry_exists(folder)
        except SafeCopyError as error:
            raise DatasetError(409, error.code, "导出目录不安全或已变化") from None
        except PermissionError:
            raise DatasetError(409, "target_not_writable", "没有权限写入导出目录") from None
        except OSError:
            raise DatasetError(409, "target_unavailable", "导出目录不可用") from None

    @staticmethod
    def _name_items(
        members: Sequence[Mapping[str, Any]], options: Mapping[str, Any]
    ) -> tuple[list[_PlanItem], list[dict[str, Any]]]:
        sequential = options["rename"] == "sequential"
        width = max(4, len(str(len(members))))
        used: set[str] = set()
        items: list[_PlanItem] = []
        collisions: list[dict[str, Any]] = []
        for ordinal, member in enumerate(members, 1):
            name = str(member["name"])
            path = Path(name)
            stem = f"{ordinal:0{width}d}" if sequential else path.stem
            extension = path.suffix.lower() if sequential else path.suffix
            candidate, suffix = stem, 2
            # 图片和同名 .txt 共用主干名：按主干名去重（大小写 / Unicode 规范化不敏感）。
            while portable_name_key(candidate) in used:
                candidate, suffix = f"{stem}_{suffix}", suffix + 1
            used.add(portable_name_key(candidate))
            if candidate != stem:
                collisions.append({"asset_id": str(member["asset_id"]), "name": name,
                                   "output_name": candidate + extension})
            items.append(_PlanItem(
                ordinal=ordinal,
                asset_id=str(member["asset_id"]),
                source_id=str(member["source_id"]),
                name=name,
                source_relative_path=str(member["relative_path"]),
                output_relative_path=candidate + extension,
                txt_source_relative_path=str(member.get("txt_relative_path") or ""),
                txt_output_relative_path=candidate + ".txt",
                caption="",
                image_size_bytes=int(member["size_bytes"]),
                expected_content_version=int(member["content_version"]),
                expected_txt_version=int(member.get("txt_version") or 0),
                content_sha256=str(member.get("content_sha256") or ""),
            ))
        return items, collisions

    def _read_captions(
        self,
        items: list[_PlanItem],
        members: Sequence[Mapping[str, Any]],
        sources: Mapping[str, Mapping[str, Any]],
        options: Mapping[str, Any],
        blockers: dict[str, list[str]],
    ) -> None:
        states = {str(member["asset_id"]): str(member.get("txt_state") or "missing") for member in members}
        with contextlib.ExitStack() as stack:
            roots: dict[str, SafeSourceRoot] = {}
            for item in items:
                if not options["include_captions"]:
                    item.txt_output_relative_path = ""
                    continue
                state = states.get(item.asset_id, "missing")
                if state in _UNREADABLE_TXT_STATES:
                    blockers.setdefault("caption_unreadable", []).append(item.asset_id)
                    continue
                text = ""
                if state == "missing":
                    # 没有标注文件：复制时也不去读（成员行里仍带着预期的 .txt 路径）。
                    item.txt_source_relative_path = ""
                if item.txt_source_relative_path and item.source_id in sources:
                    root = roots.get(item.source_id)
                    if root is None:
                        root = stack.enter_context(SafeSourceRoot(str(sources[item.source_id]["root_path"])))
                        roots[item.source_id] = root
                    try:
                        text = _read_caption(root, item.txt_source_relative_path)
                    except (OSError, UnsafeSourcePathError, ValueError):
                        blockers.setdefault("caption_unreadable", []).append(item.asset_id)
                        continue
                item.caption = self._transform(text, options)
                if not item.caption:
                    item.txt_output_relative_path = ""

    @staticmethod
    def _transform(text: str, options: Mapping[str, Any]) -> str:
        return transform_caption(
            text,
            trigger=str(options["trigger_word"]),
            pin_trigger=bool(options["pin_trigger"]),
            blacklist=options["tag_blacklist"],
            underscore_to_space=bool(options["underscore_to_space"]),
        )

    def _project_plan(self, plan: _Plan) -> dict[str, Any]:
        captions = sum(1 for item in plan.items if item.txt_output_relative_path)
        return {
            "dataset_id": plan.dataset_id,
            "layout": plan.options["layout"],
            "folder_name": plan.folder_name,
            "target_path": str(plan.target),
            "output_path": plan.output_path,
            "target_exists": plan.target_exists,
            "options": self._public_options(plan.options),
            "image_count": len(plan.items),
            "caption_count": captions,
            "image_bytes": plan.image_bytes,
            "txt_bytes": plan.txt_bytes,
            "total_bytes": plan.image_bytes + plan.txt_bytes,
            "collision_count": len(plan.collisions),
            "collisions": plan.collisions[:PREVIEW_LIMIT],
            "blockers": plan.blockers,
            "items": [
                {
                    "asset_id": item.asset_id,
                    "name": item.name,
                    "source_relative_path": item.source_relative_path,
                    "output_relative_path": item.output_relative_path,
                    "caption_output_relative_path": item.txt_output_relative_path or None,
                    "caption_preview": item.caption[:300],
                    "size_bytes": item.image_size_bytes,
                }
                for item in plan.items[:PREVIEW_LIMIT]
            ],
        }

    @staticmethod
    def _public_options(options: Mapping[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in options.items() if key != "target_identity"}

    # ---- 启动 / 续传 / 取消 ----

    def start(self, dataset_id: str, options: Mapping[str, Any]) -> dict[str, Any]:
        plan = self._plan(dataset_id, options)
        if plan.blockers:
            first = plan.blockers[0]
            raise DatasetError(409, f"export_{first['code']}", "有图片暂时不能导出",
                               details={"blockers": plan.blockers})
        if plan.target_exists:
            raise DatasetError(409, "export_target_exists", "导出目录里已经有同名文件夹",
                               details={"output_path": plan.output_path})
        export_id = str(uuid.uuid4())
        reservation = (plan.target_key, portable_name_key(plan.folder_name))
        self._reserve(export_id, reservation)
        try:
            self._insert(export_id, plan)
            self._start_stage_run(export_id, dataset_id)
        except BaseException:
            self._release(export_id)
            raise
        self._publish(export_id)
        self._spawn(export_id)
        return self.get(export_id)

    def resume(self, export_id: str) -> dict[str, Any]:
        row = self._require_row(export_id)
        if not self._resumable(row):
            raise DatasetError(409, "export_not_resumable", "这次导出不能续传",
                               details={"status": row["status"], "error_code": row["error_class"]})
        options = json.loads(row["options_json"] or "{}")
        target_key = canonical_root_key(Path(row["target_path"]))
        self._reserve(export_id, (target_key, portable_name_key(str(options.get("folder_name") or ""))))
        try:
            # 等锁的时候可能刚被取消：占位之后再确认一次还能续传。
            current = self._require_row(export_id)
            if not self._resumable(current):
                raise DatasetError(409, "export_not_resumable", "这次导出不能续传",
                                   details={"status": current["status"], "error_code": current["error_class"]})
            with self._db._transaction() as conn:
                conn.execute(
                    "UPDATE dataset_export_jobs SET status='queued', error_class='', finished_at=NULL,"
                    " updated_at=? WHERE id=?",
                    (self._clock(), export_id),
                )
            self._event(export_id, "resumed", {})
            self._start_stage_run(export_id, str(row["dataset_id"]))
        except BaseException:
            self._release(export_id)
            raise
        self._publish(export_id)
        self._spawn(export_id)
        return self.get(export_id)

    def cancel(self, export_id: str) -> dict[str, Any]:
        self._require_row(export_id)
        with self._lock:
            event = self._cancel_events.get(export_id)
            if event is not None:
                # 正在复制：复制线程在下一块 / 下一个条目处收尾并清理临时目录。
                event.set()
                return self.get(export_id)
            # 复制线程先写终态再释放取消事件，所以这里在锁内重读：拿进锁之前读到的 running
            # 会把刚写下的 succeeded 改成 cancelled。收尾也在锁内，续传的 _reserve 要等它做完。
            row = self._require_row(export_id)
            if row["status"] in ACTIVE_EXPORT_STATUSES or self._resumable(row):
                self._remove_staging(export_id, row)
                self._finish(export_id, "cancelled", "")
                return self.get(export_id)
        raise DatasetError(409, "export_not_cancellable", "这次导出已经结束",
                           details={"status": row["status"]})

    def recover(self) -> int:
        """启动恢复：上次会话没收尾的导出记为中断（临时目录保留，可续传）。"""
        with self._db._read() as conn:
            rows = conn.execute(
                "SELECT id FROM dataset_export_jobs WHERE dataset_id != '' AND status IN ('queued', 'running')"
            ).fetchall()
        recovered = 0
        for row in rows:
            export_id = str(row["id"])
            with self._lock:
                if export_id in self._active:
                    continue
            self._finish(export_id, "interrupted", "export_interrupted")
            recovered += 1
        return recovered

    def stop(self) -> None:
        with self._lock:
            self._stopping = True
            for event in self._cancel_events.values():
                event.set()
            threads = list(self._threads.values())
        for thread in threads:
            thread.join(timeout=10)

    def _reserve(self, export_id: str, reservation: tuple[str, str]) -> None:
        with self._lock:
            if self._stopping:
                raise DatasetError(409, "service_stopping", "后端正在关闭")
            if reservation in self._active.values():
                raise DatasetError(409, "export_target_busy", "同一个目标文件夹正在导出")
            if len(self._active) >= MAX_ACTIVE_EXPORTS:
                raise DatasetError(409, "export_capacity_reached", "同时进行的导出太多了，请稍后再试")
            self._active[export_id] = reservation
            self._cancel_events[export_id] = threading.Event()

    def _release(self, export_id: str) -> None:
        with self._lock:
            self._active.pop(export_id, None)
            self._cancel_events.pop(export_id, None)
            self._threads.pop(export_id, None)

    def _spawn(self, export_id: str) -> None:
        if not self._threaded:
            self._run(export_id)
            return
        thread = threading.Thread(target=self._run, args=(export_id,),
                                  name=f"dataset-export-{export_id[:8]}", daemon=True)
        with self._lock:
            self._threads[export_id] = thread
        thread.start()

    # ---- 复制 ----

    def _run(self, export_id: str) -> None:
        try:
            with self._lock:
                cancel = self._cancel_events[export_id]
            try:
                stats = self._execute(export_id, cancel)
            except CopyCancelled:
                if self._stopping:
                    self._finish(export_id, "interrupted", "export_interrupted")
                else:
                    self._remove_staging(export_id)
                    self._finish(export_id, "cancelled", "")
            except SafeCopyError as error:
                if error.code not in RESUMABLE_ERRORS:
                    self._remove_staging(export_id)
                self._finish(export_id, "failed", error.code, details=error.details)
            except PermissionError:
                self._remove_staging(export_id)
                self._finish(export_id, "failed", "target_not_writable")
            except (OSError, UnsafeSourcePathError) as error:
                logger.warning("dataset export io failure; category=%s", safe_exception_category(error))
                self._finish(export_id, "failed", "copy_io_error")
            except Exception as error:
                logger.error("dataset export failed; category=%s", safe_exception_category(error))
                self._remove_staging(export_id)
                self._finish(export_id, "failed", "internal_error")
            else:
                self._finish(export_id, "succeeded", "", stats=stats)
        finally:
            self._release(export_id)

    def _execute(self, export_id: str, cancel: threading.Event) -> dict[str, Any]:
        row = self._require_row(export_id)
        options = json.loads(row["options_json"] or "{}")
        folder = str(options["folder_name"])
        staging = staging_name(export_id)
        now = self._clock()
        with self._db._transaction() as conn:
            conn.execute(
                "UPDATE dataset_export_jobs SET status='running', updated_at=?,"
                " started_at=COALESCE(started_at, ?) WHERE id=?",
                (now, now, export_id),
            )
        self._publish(export_id)
        target = Path(row["target_path"])
        with self._locks.hold(f"target:{canonical_root_key(target)}"):
            with TargetRoot(target) as root:
                if list(root.identity) != list(options.get("target_identity") or ()):
                    raise SafeCopyError("target_root_changed")
                staged_identity = self._staging_identity(export_id)
                resumed = staged_identity is not None
                if staged_identity is not None and not root.adopt_owned_directory(staging, staged_identity):
                    if root.entry_identity(folder) == staged_identity:
                        # 上次已经改名成功，只是没来得及记成功。
                        self._event(export_id, "committed", {"recovered": True})
                        return self._success_stats(export_id, options, row)
                    # 临时目录丢了：从头再来。
                    self._reset_items(export_id)
                    staged_identity = None
                if staged_identity is None:
                    root.create_owned_directory(staging)
                    self._event(export_id, "staging_created",
                                {"name": staging, "identity": list(root.owned_directory_identity(staging))})
                items = self._items(export_id)
                staged = sum(1 for item in items if item["copy_state"] == "staged")
                self._progress(export_id, staged, len(items))
                with contextlib.ExitStack() as stack:
                    sources: dict[str, SafeSourceRoot] = {}
                    for index, item in enumerate(items, 1):
                        if cancel.is_set():
                            raise CopyCancelled()
                        if item["copy_state"] == "staged":
                            continue
                        if resumed:
                            root.remove_output_file(staging, item["output_relative_path"])
                            if item["txt_output_relative_path"]:
                                root.remove_output_file(staging, item["txt_output_relative_path"])
                        self._copy_item(root, staging, item, options, sources, stack, cancel)
                        staged += 1
                        self._progress(export_id, staged, len(items))
                        if self.after_item is not None:
                            self.after_item(export_id, index)
                if cancel.is_set():
                    raise CopyCancelled()
                expected = {}
                for item in items:
                    expected[item["output_relative_path"]] = (0, 0, int(item["image_size_bytes"]), 0, 0)
                    if item["txt_output_relative_path"]:
                        expected[item["txt_output_relative_path"]] = (0, 0, int(item["txt_size_bytes"]), 0, 0)
                validate_staged_tree(root, staging, {""}, expected, cancel, size_only=True)
                self._event(export_id, "commit_started", {})
                try:
                    root.commit_owned_directory(staging, folder)
                except SafeCopyError as error:
                    if error.code == "target_name_conflict":
                        raise SafeCopyError("export_target_exists", {"output_path": str(target / folder)}) from None
                    raise
                self._event(export_id, "committed", {})
        return self._success_stats(export_id, options, row)

    def _copy_item(
        self,
        root: TargetRoot,
        staging: str,
        item: Mapping[str, Any],
        options: Mapping[str, Any],
        sources: dict[str, SafeSourceRoot],
        stack: contextlib.ExitStack,
        cancel: threading.Event,
    ) -> None:
        asset_id = str(item["asset_id"])
        changed = SafeCopyError("source_changed", {"asset_id": asset_id})
        asset = self._gallery.get_asset(asset_id)
        if (
            asset is None
            or asset["lifecycle_state"] != "active"
            or asset["relative_path"] != item["source_relative_path"]
            or int(asset["content_version"]) != int(item["expected_content_version"])
            or int(asset.get("txt_version") or 0) != int(item["expected_txt_version"])
        ):
            raise changed
        source_id = str(item["source_id"])
        with self._locks.hold(f"source:{source_id}"):
            safe = sources.get(source_id)
            if safe is None:
                source = self._gallery.get_source(source_id)
                if source is None or source.get("availability") != "available":
                    raise SafeCopyError("source_offline", {"source_id": source_id})
                safe = stack.enter_context(SafeSourceRoot(str(source["root_path"])))
                sources[source_id] = safe
            digest = hashlib.sha256()
            try:
                handle = safe.open_binary(str(item["source_relative_path"]))
            except UnsafeSourcePathError:
                raise changed from None
            try:
                if os.fstat(handle.fileno()).st_size != int(item["image_size_bytes"]):
                    raise changed
                with root.open_output_file(staging, str(item["output_relative_path"])) as output:
                    copied = copy_stream(handle, output, chunk_size=self._chunk_size, cancel_event=cancel,
                                         on_chunk=lambda chunk, _copied: digest.update(chunk))
            finally:
                handle.close()
            if copied != int(item["image_size_bytes"]):
                raise changed
            if item["image_sha256"] and digest.hexdigest() != item["image_sha256"]:
                raise changed
            if item["txt_output_relative_path"]:
                text = ""
                if item["txt_source_relative_path"]:
                    try:
                        text = _read_caption(safe, str(item["txt_source_relative_path"]))
                    except (UnsafeSourcePathError, ValueError):
                        raise changed from None
                data = self._transform(text, options).encode("utf-8")
                if hashlib.sha256(data).hexdigest() != item["txt_sha256"]:
                    raise changed
                with root.open_output_file(staging, str(item["txt_output_relative_path"])) as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
        # 文件已落盘才记日志：崩溃时最多重做这一个条目。
        with self._db._transaction() as conn:
            conn.execute(
                "UPDATE dataset_export_items SET copy_state='staged', image_sha256=?, committed_at=?"
                " WHERE job_id=? AND asset_id=?",
                (digest.hexdigest(), self._clock(), item["job_id"], asset_id),
            )

    def _success_stats(self, export_id: str, options: Mapping[str, Any], row: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "export_id": export_id,
            "exported": int(row["sample_count"]),
            "image_bytes": int(row["image_bytes"]),
            "txt_bytes": int(row["txt_bytes"]),
            "layout": options.get("layout"),
            "folder_name": options.get("folder_name"),
            "output_path": str(Path(row["target_path"]) / str(options.get("folder_name") or "")),
        }

    def _remove_staging(self, export_id: str, row: Mapping[str, Any] | None = None) -> None:
        row = row or self._row(export_id)
        identity = self._staging_identity(export_id)
        if row is None or identity is None:
            return
        try:
            with TargetRoot(Path(row["target_path"])) as root:
                if root.adopt_owned_directory(staging_name(export_id), identity):
                    if not root.remove_owned_directory(staging_name(export_id)):
                        logger.warning("dataset export staging cleanup failed")
        except (SafeCopyError, OSError) as error:
            logger.warning("dataset export staging cleanup failed; category=%s", safe_exception_category(error))

    # ---- 收尾 ----

    def _finish(
        self,
        export_id: str,
        status: str,
        code: str,
        *,
        stats: Mapping[str, Any] | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        now = self._clock()
        with self._db._transaction() as conn:
            conn.execute(
                "UPDATE dataset_export_jobs SET status=?, error_class=?, updated_at=?, finished_at=? WHERE id=?",
                (status, code, now, now, export_id),
            )
        self._event(export_id, "finished", {"status": status, "error_code": code, **({"details": dict(details)} if details else {})})
        row = self._row(export_id)
        with self._db._read() as conn:
            run = conn.execute(
                "SELECT id, stats_json FROM dataset_stage_runs WHERE ref_id=? AND stage='export' AND status='running'"
                " ORDER BY created_at DESC, rowid DESC LIMIT 1",
                (export_id,),
            ).fetchone()
        if run is not None:
            run_stats = json.loads(run["stats_json"] or "{}")
            run_stats.update(stats or {})
            self._datasets.finish_stage_run(str(run["id"]), status=_STAGE_RUN_STATUS[status], stats=run_stats,
                                            error_code=code)
        if self._jobs is not None:
            message = {"interrupted": "已中断，可以续传", "failed": code}.get(status, "")
            if self._jobs.get(_job_id(export_id)) is None and row is not None:
                self._jobs.start(JOB_KIND, JOB_TITLE, job_id=_job_id(export_id), status="running",
                                 ref={"dataset_id": row["dataset_id"], "export_id": export_id})
            self._jobs.finish(_job_id(export_id), _JOB_STATUS[status], message=message)
        self._publish(export_id)
        if row is not None and self._events is not None:
            self._safe_publish("dataset.stage.updated", {"dataset_id": row["dataset_id"], "stage": "export",
                                                         "export_id": export_id, "status": status})

    def _start_stage_run(self, export_id: str, dataset_id: str) -> None:
        try:
            self._datasets.start_stage_run(dataset_id, "export", ref_id=export_id, stats={"export_id": export_id})
        except DatasetNotFound:
            raise DatasetError(404, "dataset_not_found", "数据集不存在") from None

    def _progress(self, export_id: str, current: int, total: int) -> None:
        if self._jobs is None:
            return
        job_id = _job_id(export_id)
        if self._jobs.get(job_id) is None or self._jobs.get(job_id)["status"] not in ACTIVE_EXPORT_STATUSES:
            row = self._row(export_id)
            self._jobs.start(JOB_KIND, JOB_TITLE, job_id=job_id, current=current, total=total,
                             ref={"dataset_id": row["dataset_id"] if row else "", "export_id": export_id})
        else:
            self._jobs.update(job_id, current=current, total=total, message=f"{current}/{total}")

    def _publish(self, export_id: str) -> None:
        if self._events is None:
            return
        row = self._row(export_id)
        if row is None:
            return
        self._safe_publish("dataset.export.updated", {"dataset_id": row["dataset_id"], "export_id": export_id,
                                                      "status": row["status"]})

    def _safe_publish(self, kind: str, data: Mapping[str, Any]) -> None:
        try:
            self._events.publish(kind, data)
        except Exception as error:
            logger.warning("dataset export event failed; category=%s", safe_exception_category(error))

    # ---- 存储（dataset_export_* 表） ----

    def _insert(self, export_id: str, plan: _Plan) -> None:
        now = self._clock()
        options = {**plan.options, "target_identity": list(plan.target_identity or ())}
        with self._db._transaction() as conn:
            conn.execute(
                "INSERT INTO dataset_export_jobs(id, dataset_id, options_json, status, target_path, sample_count,"
                " image_bytes, txt_bytes, snapshot_digest, created_at, updated_at)"
                " VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)",
                (export_id, plan.dataset_id, json.dumps(options, ensure_ascii=False), str(plan.target),
                 len(plan.items), plan.image_bytes, plan.txt_bytes,
                 self._datasets.stage_input_digest(plan.dataset_id, "export"), now, now),
            )
            conn.executemany(
                "INSERT INTO dataset_export_items(job_id, asset_id, source_id, output_relative_path,"
                " source_relative_path, txt_output_relative_path, txt_source_relative_path, has_txt,"
                " expected_content_version, expected_txt_version, image_size_bytes, txt_size_bytes,"
                " image_sha256, txt_sha256, copy_state)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
                [
                    (export_id, item.asset_id, item.source_id, item.output_relative_path,
                     item.source_relative_path, item.txt_output_relative_path, item.txt_source_relative_path,
                     int(bool(item.txt_output_relative_path)), item.expected_content_version,
                     item.expected_txt_version, item.image_size_bytes,
                     len(item.caption_bytes) if item.txt_output_relative_path else 0,
                     item.content_sha256,
                     hashlib.sha256(item.caption_bytes).hexdigest() if item.txt_output_relative_path else "")
                    for item in plan.items
                ],
            )
            conn.execute(
                "INSERT INTO dataset_export_events(job_id, ts, event_type, detail_json) VALUES (?, ?, 'planned', ?)",
                (export_id, now, json.dumps({"items": len(plan.items), "collisions": len(plan.collisions)})),
            )

    def _event(self, export_id: str, event_type: str, detail: Mapping[str, Any]) -> None:
        with self._db._transaction() as conn:
            conn.execute(
                "INSERT INTO dataset_export_events(job_id, ts, event_type, detail_json) VALUES (?, ?, ?, ?)",
                (export_id, self._clock(), event_type, json.dumps(dict(detail), ensure_ascii=False)),
            )

    def _staging_identity(self, export_id: str) -> tuple[int, int] | None:
        with self._db._read() as conn:
            row = conn.execute(
                "SELECT detail_json FROM dataset_export_events WHERE job_id=? AND event_type='staging_created'"
                " ORDER BY id DESC LIMIT 1",
                (export_id,),
            ).fetchone()
        if row is None:
            return None
        identity = json.loads(row["detail_json"] or "{}").get("identity") or ()
        return (int(identity[0]), int(identity[1])) if len(identity) == 2 else None

    def _items(self, export_id: str) -> list[dict[str, Any]]:
        with self._db._read() as conn:
            rows = conn.execute(
                "SELECT * FROM dataset_export_items WHERE job_id=? ORDER BY rowid",
                (export_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def _reset_items(self, export_id: str) -> None:
        with self._db._transaction() as conn:
            conn.execute(
                "UPDATE dataset_export_items SET copy_state='pending', committed_at=NULL WHERE job_id=?",
                (export_id,),
            )

    def _row(self, export_id: str) -> dict[str, Any] | None:
        with self._db._read() as conn:
            row = conn.execute("SELECT * FROM dataset_export_jobs WHERE id=? AND dataset_id != ''",
                               (export_id,)).fetchone()
        return None if row is None else dict(row)

    def _require_row(self, export_id: str) -> dict[str, Any]:
        row = self._row(export_id)
        if row is None:
            raise DatasetError(404, "export_not_found", "导出任务不存在")
        return row

    @staticmethod
    def _resumable(row: Mapping[str, Any]) -> bool:
        return row["status"] == "interrupted" or (
            row["status"] == "failed" and row["error_class"] in RESUMABLE_ERRORS
        )

    # ---- 读取 ----

    def get(self, export_id: str) -> dict[str, Any]:
        return self._project(self._require_row(export_id))

    def list_exports(self, dataset_id: str, *, limit: int = 50) -> list[dict[str, Any]]:
        self._datasets.require(dataset_id)
        with self._db._read() as conn:
            rows = conn.execute(
                "SELECT * FROM dataset_export_jobs WHERE dataset_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (dataset_id, max(1, min(int(limit), 200))),
            ).fetchall()
        return [self._project(dict(row)) for row in rows]

    def _project(self, row: Mapping[str, Any]) -> dict[str, Any]:
        options = json.loads(row["options_json"] or "{}")
        with self._db._read() as conn:
            progress = conn.execute(
                "SELECT COUNT(*) AS staged, COALESCE(SUM(image_size_bytes + txt_size_bytes), 0) AS bytes"
                " FROM dataset_export_items WHERE job_id=? AND copy_state='staged'",
                (row["id"],),
            ).fetchone()
            finished = conn.execute(
                "SELECT detail_json FROM dataset_export_events WHERE job_id=? AND event_type='finished'"
                " ORDER BY id DESC LIMIT 1",
                (row["id"],),
            ).fetchone()
        details = json.loads(finished["detail_json"]).get("details") if finished is not None else None
        folder = str(options.get("folder_name") or "")
        return {
            "export_id": row["id"],
            "dataset_id": row["dataset_id"],
            "status": row["status"],
            "target_path": row["target_path"],
            "folder_name": folder,
            "output_path": str(Path(row["target_path"]) / folder),
            "options": self._public_options(options),
            "total_items": int(row["sample_count"]),
            "staged_items": int(progress["staged"]),
            "image_bytes": int(row["image_bytes"]),
            "txt_bytes": int(row["txt_bytes"]),
            "total_bytes": int(row["image_bytes"]) + int(row["txt_bytes"]),
            "copied_bytes": int(progress["bytes"]),
            "error_code": row["error_class"] or None,
            "error_details": details if row["status"] == "failed" else None,
            "resumable": self._resumable(row),
            "job_id": _job_id(str(row["id"])),
            "created_at": float(row["created_at"]),
            "updated_at": float(row["updated_at"]),
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
        }


def _job_id(export_id: str) -> str:
    return f"dataset-export:{export_id}"


def _read_caption(root: SafeSourceRoot, relative_path: str) -> str:
    with root.open_binary(relative_path) as handle:
        data = handle.read(_CAPTION_MAX_BYTES + 1)
    if len(data) > _CAPTION_MAX_BYTES:
        raise ValueError("caption_too_large")
    ok, text = decode_txt_bytes(data)
    if not ok:
        raise ValueError("caption_invalid_encoding")
    return text


__all__ = [
    "EXPORT_LAYOUTS",
    "EXPORT_STATUSES",
    "KAOMOJI_TAGS",
    "DatasetExportService",
    "normalize_tag",
    "safe_folder_name",
    "staging_name",
    "transform_caption",
]
