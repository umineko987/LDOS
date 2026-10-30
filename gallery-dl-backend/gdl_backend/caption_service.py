"""数据集 caption：全量读取、批量写入和撤销。

caption 就是图片旁边的同名 .txt。读写都走 GalleryCatalogService 的注解路径
（安全路径、临时文件 + 原子替换、txt_version 与 disk_version 双版本检查、
FTS 索引同步），所以这里写的文件在图库里立刻可见、可搜索。

caption 的版本就是磁盘版本（gallery_safe_paths 的 disk_version，不透明字符串）。
每次批量写入记成一个 caption 批次（schema v16）：条目带写入前后的文本和版本。
撤销按文本判断：当前文本仍等于 after_text 才恢复（每次写都是临时文件 + 改名，
磁盘版本会变，所以不能拿版本比），恢复本身仍按刚读到的版本做条件写入。

标签解析和序列化全部用 caption_tags，后端只此一份。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import uuid
from collections import OrderedDict
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from ._database_caption_repository import CaptionBatchRepository
from ._database_gallery_repository import GalleryVersionConflict
from .caption_tags import (
    apply_ops,
    diff_tags,
    format_caption,
    merge_tagger_tags,
    parse_caption,
)
from .dataset_service import DatasetError, DatasetService
from .gallery_service import (
    GalleryAnnotationError,
    GalleryAssetNotFound,
    GalleryCatalogService,
    GallerySourceNotFound,
    GallerySourceOffline,
    annotation_relative_path,
)

logger = logging.getLogger(__name__)

# 能安全读改写的 TXT 状态；其余（编码错误、读不了、同名冲突、来源离线）只读。
EDITABLE_STATES = frozenset({"normal", "blank", "missing"})
SAMPLE_LIMIT_DEFAULT = 20
# 冲突 / 跳过 / 失败清单最多列这么多条，总数在 stats 里。
REPORT_LIMIT = 200
_LISTING_CACHE_SIZE = 8
_PROGRESS_EVERY = 25

ComputeTags = Callable[[str, list[str]], list[str] | None]


def entry_state(entry: Mapping[str, Any]) -> str:
    return "unavailable" if entry.get("error") else str(entry["txt_state"])


@dataclass(slots=True)
class _Planned:
    asset_id: str
    entry: dict[str, Any]
    before: list[str]
    after: list[str]
    change: str  # changed | new | unchanged
    tagger_tags: list[str] | None = None


@dataclass(slots=True)
class _Plan:
    total: int
    planned: list[_Planned]
    skipped: list[dict[str, str]]
    conflicts: list[dict[str, str]]

    def count(self, change: str) -> int:
        return sum(1 for item in self.planned if item.change == change)

    def stats(self) -> dict[str, int]:
        return {
            "total": self.total,
            "changed": self.count("changed"),
            "new": self.count("new"),
            "unchanged": self.count("unchanged"),
            "skipped": len(self.skipped),
            "conflicts": len(self.conflicts),
        }

    def samples(self, limit: int) -> list[dict[str, Any]]:
        samples = []
        for item in self.planned:
            if len(samples) >= limit:
                break
            if item.change != "unchanged":
                samples.append({
                    "asset_id": item.asset_id,
                    "change": item.change,
                    "before": item.before,
                    "after": item.after,
                    **diff_tags(item.before, item.after),
                })
        return samples


class CaptionService:
    def __init__(
        self,
        *,
        database: Any,
        catalog: GalleryCatalogService,
        datasets: DatasetService,
        events: Any | None = None,
        jobs: Any | None = None,
    ) -> None:
        self._db = database
        self._repo: CaptionBatchRepository = database.captions
        self._catalog = catalog
        self._datasets = datasets
        self._events = events
        self._jobs = jobs
        self._locks_guard = threading.Lock()
        self._locks: dict[str, threading.Lock] = {}
        self._listing_guard = threading.Lock()
        self._listing_cache: OrderedDict[str, tuple[str, bytes]] = OrderedDict()

    @classmethod
    def for_container(cls, container: Any) -> "CaptionService":
        return cls(
            database=container.db,
            catalog=container.gallery_catalog,
            datasets=container.datasets,
            events=container.events,
            jobs=container.jobs,
        )

    @contextmanager
    def _dataset_lock(self, dataset_id: str) -> Iterator[None]:
        # 同一数据集的批量写入和撤销串行执行，计划时读到的版本才不会被自己人改掉。
        with self._locks_guard:
            lock = self._locks.setdefault(dataset_id, threading.Lock())
        with lock:
            yield

    def _dataset(self, dataset_id: str) -> dict[str, Any]:
        dataset = self._db.datasets.get_dataset(dataset_id)
        if dataset is None:
            raise DatasetError(404, "dataset_not_found", "数据集不存在")
        return dataset

    # ---- 全量读取 ----

    def listing(self, dataset_id: str) -> tuple[str, bytes]:
        """review 阶段输入的全部 caption，返回 (ETag, JSON 字节)。

        ETag 由成员、触发词和每个 TXT 的 stat 指纹算出，不读文件内容；
        指纹没变时直接返回缓存的载荷。
        """
        dataset = self._dataset(dataset_id)
        members = self._datasets.stage_input(dataset_id, "review")
        etag = self._listing_etag(dataset, members)
        with self._listing_guard:
            cached = self._listing_cache.get(dataset_id)
            if cached is not None and cached[0] == etag:
                self._listing_cache.move_to_end(dataset_id)
                return cached
        entries = self._catalog.read_annotations([member["asset_id"] for member in members])
        items = []
        for member in members:
            entry = entries[member["asset_id"]]
            text = entry["content"]
            items.append({
                "asset_id": member["asset_id"],
                "name": member["name"],
                "state": entry_state(entry),
                "text": text or "",
                "tags": parse_caption(text),
                "version": entry["disk_version"],
            })
        body = json.dumps(
            {
                "dataset_id": dataset_id,
                "trigger_word": dataset["trigger_word"],
                "etag": etag,
                "items": items,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        with self._listing_guard:
            self._listing_cache[dataset_id] = (etag, body)
            self._listing_cache.move_to_end(dataset_id)
            while len(self._listing_cache) > _LISTING_CACHE_SIZE:
                self._listing_cache.popitem(last=False)
        return etag, body

    def _listing_etag(self, dataset: Mapping[str, Any], members: Sequence[Mapping[str, Any]]) -> str:
        digest = hashlib.sha256(b"ldos:captions:v1\0")
        digest.update(json.dumps([dataset["dataset_id"], dataset["trigger_word"]]).encode("utf-8"))
        roots: dict[str, str | None] = {}
        for member in members:
            source_id = str(member["source_id"])
            if source_id not in roots:
                source = self._db.gallery.get_source(source_id)
                available = source is not None and source["availability"] == "available"
                roots[source_id] = str(source["root_path"]) if available else None
            root = roots[source_id]
            signature = "offline"
            if root is not None:
                path = os.path.join(root, *annotation_relative_path(member).split("/"))
                try:
                    stat = os.stat(path, follow_symlinks=False)
                except OSError:
                    signature = "missing"
                else:
                    signature = (
                        f"{stat.st_dev}:{stat.st_ino}:{stat.st_mode}:"
                        f"{stat.st_size}:{stat.st_mtime_ns}"
                    )
            line = "\0".join((
                str(member["asset_id"]), str(member["name"]), str(member["txt_version"]),
                str(member["txt_state"]), signature,
            ))
            digest.update(line.encode("utf-8", "surrogateescape") + b"\n")
        return f'"{digest.hexdigest()[:40]}"'

    # ---- 计划 ----

    def _stage_members(self, dataset_id: str, stage: str) -> dict[str, dict[str, Any]]:
        return {member["asset_id"]: member for member in self._datasets.stage_input(dataset_id, stage)}

    @staticmethod
    def _select(members: Mapping[str, Any], asset_ids: Sequence[str] | None, stage: str) -> list[str]:
        if asset_ids is None:
            return list(members)
        selected = list(dict.fromkeys(asset_ids))
        unknown = [asset_id for asset_id in selected if asset_id not in members]
        if unknown:
            raise DatasetError(
                422,
                "caption_asset_not_in_stage",
                f"有图片不在「{stage}」这一步的输入里",
                details={"stage": stage, "asset_ids": unknown[:20]},
            )
        return selected

    def _plan(
        self,
        asset_ids: Sequence[str],
        compute: ComputeTags,
        *,
        expected_versions: Mapping[str, str] | None = None,
        tagger_tags: Mapping[str, list[str]] | None = None,
    ) -> _Plan:
        entries = self._catalog.read_annotations(asset_ids)
        plan = _Plan(total=len(asset_ids), planned=[], skipped=[], conflicts=[])
        for asset_id in asset_ids:
            entry = entries[asset_id]
            state = entry_state(entry)
            if state not in EDITABLE_STATES:
                plan.skipped.append({"asset_id": asset_id, "reason": entry.get("error") or state})
                continue
            expected = (expected_versions or {}).get(asset_id)
            if expected is not None and expected != entry["disk_version"]:
                plan.conflicts.append({"asset_id": asset_id, "reason": "caption_version_conflict"})
                continue
            before = parse_caption(entry["content"])
            after = compute(asset_id, before)
            if after is None:
                plan.skipped.append({"asset_id": asset_id, "reason": "no_tagger_result"})
                continue
            if after == before:
                change = "unchanged"
            else:
                change = "changed" if before else "new"
            plan.planned.append(_Planned(
                asset_id, entry, before, after, change,
                None if tagger_tags is None else tagger_tags.get(asset_id),
            ))
        return plan

    # ---- 写入 ----

    def _job(self, kind: str, title: str, *, job_id: str, total: int, ref: Mapping[str, Any]) -> str | None:
        if self._jobs is None:
            return None
        try:
            return str(self._jobs.start(kind, title, job_id=job_id, total=total, ref=ref)["id"])
        except Exception:
            logger.exception("caption job start failed")
            return None

    def _job_call(self, method: str, job_id: str | None, *args: Any, **kwargs: Any) -> None:
        if self._jobs is None or job_id is None:
            return
        try:
            getattr(self._jobs, method)(job_id, *args, **kwargs)
        except Exception:
            logger.exception("caption job %s failed", method)

    def _publish(self, dataset_id: str, *, batch_id: str, changed: int, reason: str) -> None:
        if self._events is not None:
            try:
                self._events.publish("captions.updated", {
                    "dataset_id": dataset_id, "batch_id": batch_id,
                    "changed": changed, "reason": reason,
                })
            except Exception:
                logger.exception("captions.updated publish failed; dataset_id=%s", dataset_id)
        self._datasets.publish_updated(dataset_id, "captions")

    @staticmethod
    def _write_failure(error: BaseException) -> tuple[str, str]:
        """把注解写入的异常归成 (类别, 原因码)：类别是 conflicts 或 failed。"""
        if isinstance(error, GalleryVersionConflict):
            return "conflicts", error.code
        if isinstance(error, GalleryAnnotationError):
            return "failed", error.code
        if isinstance(error, GallerySourceOffline):
            return "failed", "source_offline"
        if isinstance(error, (GalleryAssetNotFound, GallerySourceNotFound)):
            return "failed", "asset_not_found"
        if isinstance(error, (OSError, UnicodeError)):
            return "failed", "txt_write_failed"
        return "failed", "caption_write_failed"

    def _execute(
        self,
        dataset_id: str,
        plan: _Plan,
        *,
        kind: str,
        params: Mapping[str, Any],
        dry_run: bool,
        sample_limit: int,
    ) -> dict[str, Any]:
        stats = plan.stats()
        result: dict[str, Any] = {
            "dataset_id": dataset_id,
            "dry_run": dry_run,
            "batch_id": None,
            "stats": {**stats, "written": 0, "failed": 0},
            "samples": plan.samples(sample_limit),
            "skipped": plan.skipped[:REPORT_LIMIT],
            "conflicts": plan.conflicts[:REPORT_LIMIT],
            "failed": [],
        }
        if dry_run:
            return result
        to_write = [item for item in plan.planned if item.change != "unchanged"]
        batch_id = str(uuid.uuid4())
        job_id = None
        if to_write:
            job_id = self._job(
                "captions.write", f"写入 caption {len(to_write)} 张",
                job_id=f"captions:{batch_id}", total=len(to_write),
                ref={"dataset_id": dataset_id, "batch_id": batch_id, "kind": kind},
            )
        reports: dict[str, list[dict[str, str]]] = {"conflicts": list(plan.conflicts), "failed": []}
        items: list[dict[str, Any]] = []
        try:
            for position, planned in enumerate(to_write, start=1):
                text = format_caption(planned.after)
                entry = planned.entry
                try:
                    saved = self._catalog.save_annotation(
                        planned.asset_id,
                        text,
                        expected_txt_version=int(entry["txt_version"]),
                        expected_disk_version=str(entry["disk_version"]),
                    )
                except Exception as error:
                    category, reason = self._write_failure(error)
                    if reason == "caption_write_failed":
                        logger.exception("caption write failed; asset_id=%s", planned.asset_id)
                    reports[category].append({"asset_id": planned.asset_id, "reason": reason})
                else:
                    items.append({
                        "asset_id": planned.asset_id,
                        "before_text": entry["content"],
                        "before_version": entry["disk_version"],
                        "after_text": text,
                        "after_version": saved["disk_version"],
                        "tagger_tags": planned.tagger_tags,
                    })
                if position % _PROGRESS_EVERY == 0 or position == len(to_write):
                    self._job_call("update", job_id, current=position, total=len(to_write))
            written = len(items)
            stats = {
                **stats,
                "conflicts": len(reports["conflicts"]),
                "written": written,
                "failed": len(reports["failed"]),
            }
            if written:
                # from_tagger 把没变的图也记下打标基线，下次 merge 才认得出手改。
                for planned in plan.planned:
                    if planned.change == "unchanged" and planned.tagger_tags is not None:
                        items.append({
                            "asset_id": planned.asset_id,
                            "before_text": planned.entry["content"],
                            "before_version": planned.entry["disk_version"],
                            "after_text": planned.entry["content"],
                            "after_version": planned.entry["disk_version"],
                            "tagger_tags": planned.tagger_tags,
                        })
                self._repo.create_batch(
                    dataset_id, kind=kind, params=params, stats=stats, items=items,
                    batch_id=batch_id,
                )
                result["batch_id"] = batch_id
        except BaseException:
            self._job_call("finish", job_id, "failed", message="caption 写入中断")
            raise
        self._job_call(
            "finish", job_id, "succeeded" if not reports["failed"] else "failed",
            message="" if not reports["failed"] else f"{len(reports['failed'])} 张写入失败",
        )
        if result["batch_id"] is not None:
            self._publish(dataset_id, batch_id=batch_id, changed=written, reason=kind)
        result["stats"] = stats
        result["conflicts"] = reports["conflicts"][:REPORT_LIMIT]
        result["failed"] = reports["failed"][:REPORT_LIMIT]
        return result

    # ---- 对外操作 ----

    def run_ops(
        self,
        dataset_id: str,
        *,
        asset_ids: Sequence[str],
        ops: Sequence[Mapping[str, Any]],
        dry_run: bool = False,
        expected_versions: Mapping[str, str] | None = None,
        sample_limit: int = SAMPLE_LIMIT_DEFAULT,
    ) -> dict[str, Any]:
        """对 review 阶段输入里明确列出的图执行批量操作；实际写入时记成一个可撤销批次。"""
        dataset = self._dataset(dataset_id)
        trigger = str(dataset["trigger_word"])
        with self._dataset_lock(dataset_id):
            selected = self._select(self._stage_members(dataset_id, "review"), asset_ids, "review")
            plan = self._plan(
                selected,
                lambda _asset_id, before: apply_ops(before, ops, trigger_word=trigger),
                expected_versions=expected_versions,
            )
            return self._execute(
                dataset_id, plan, kind="ops",
                params={"ops": [dict(op) for op in ops], "asset_count": len(selected)},
                dry_run=dry_run, sample_limit=sample_limit,
            )

    def edit(self, dataset_id: str, asset_id: str, text: str, *, expected_version: str) -> dict[str, Any]:
        """改一张图的 caption（规范化成标签列表再写）。版本不符抛 409。"""
        self._dataset(dataset_id)
        tags = parse_caption(text)
        with self._dataset_lock(dataset_id):
            selected = self._select(self._stage_members(dataset_id, "review"), [asset_id], "review")
            plan = self._plan(
                selected, lambda _asset_id, _before: tags,
                expected_versions={asset_id: expected_version},
            )
            if plan.skipped:
                raise DatasetError(
                    422, "caption_not_editable", "这张图的 caption 当前不能编辑",
                    details={"asset_id": asset_id, "reason": plan.skipped[0]["reason"]},
                )
            result = self._execute(
                dataset_id, plan, kind="edit", params={"asset_id": asset_id},
                dry_run=False, sample_limit=1,
            )
        if result["conflicts"]:
            raise DatasetError(
                409, "caption_version_conflict", "caption 已被其他操作修改，请刷新后再改",
                details={"asset_id": asset_id, "reason": result["conflicts"][0]["reason"]},
            )
        if result["failed"]:
            raise DatasetError(
                409, result["failed"][0]["reason"], "caption 写入失败",
                details={"asset_id": asset_id},
            )
        entry = self._catalog.read_annotations([asset_id])[asset_id]
        return {
            "batch_id": result["batch_id"],
            "caption": {
                "asset_id": asset_id,
                "state": entry_state(entry),
                "text": entry["content"] or "",
                "tags": parse_caption(entry["content"]),
                "version": entry["disk_version"],
            },
        }

    def apply_tagger(
        self,
        dataset_id: str,
        *,
        tagger_tags: Mapping[str, list[str]],
        unavailable: Mapping[str, str],
        asset_ids: Sequence[str],
        mode: str,
        params: Mapping[str, Any],
        dry_run: bool = False,
        sample_limit: int = SAMPLE_LIMIT_DEFAULT,
    ) -> dict[str, Any]:
        """把一次 compose 的结果按模式合进现有 caption。

        tagger_tags：asset_id → 打标标签；unavailable：没有结果的图及原因
        （missing_scores / unreadable / decode_error / source_offline）。
        """
        dataset = self._dataset(dataset_id)
        trigger = str(dataset["trigger_word"])
        with self._dataset_lock(dataset_id):
            previous = self._repo.latest_tagger_tags(dataset_id, asset_ids) if mode == "merge" else {}
            available = [asset_id for asset_id in asset_ids if asset_id in tagger_tags]

            def compute(asset_id: str, before: list[str]) -> list[str] | None:
                tags = tagger_tags.get(asset_id)
                if tags is None:
                    return None
                return merge_tagger_tags(
                    before, tags,
                    previous_tagger_tags=previous.get(asset_id),
                    mode=mode, trigger_word=trigger,
                )

            plan = self._plan(available, compute, tagger_tags=tagger_tags)
            if mode == "fill_empty":
                # 已有 caption 的图没用上这次结果，不能记成打标基线，否则下次 merge
                # 会把「打标有、caption 里没有」误判成手动删掉的。
                for item in plan.planned:
                    if item.before:
                        item.tagger_tags = None
            missing = [
                {"asset_id": asset_id, "reason": unavailable.get(asset_id, "no_tagger_result")}
                for asset_id in asset_ids if asset_id not in tagger_tags
            ]
            plan.total = len(asset_ids)
            plan.skipped = missing + plan.skipped
            return self._execute(
                dataset_id, plan, kind="from_tagger",
                params={**params, "mode": mode, "asset_count": len(asset_ids)},
                dry_run=dry_run, sample_limit=sample_limit,
            )

    def undo(self, batch_id: str) -> dict[str, Any]:
        """撤销一个批次：当前文本仍等于 after_text 的图恢复成 before_text，其余报告为冲突。"""
        batch = self._repo.get_batch(batch_id)
        if batch is None:
            raise DatasetError(404, "caption_batch_not_found", "caption 批次不存在")
        dataset_id = str(batch["dataset_id"])
        with self._dataset_lock(dataset_id):
            batch = self._repo.get_batch(batch_id)
            if batch is None:
                raise DatasetError(404, "caption_batch_not_found", "caption 批次不存在")
            if batch["undone_at"] is not None:
                raise DatasetError(409, "caption_batch_already_undone", "这个批次已经撤销过了")
            items = [
                item for item in self._repo.batch_items(batch_id)
                if item["before_version"] != item["after_version"]
            ]
            entries = self._catalog.read_annotations([item["asset_id"] for item in items])
            job_id = self._job(
                "captions.undo", f"撤销 caption {len(items)} 张",
                job_id=f"captions:undo:{batch_id}", total=len(items),
                ref={"dataset_id": dataset_id, "batch_id": batch_id},
            ) if items else None
            restored = 0
            reports: dict[str, list[dict[str, str]]] = {"conflicts": [], "failed": []}
            try:
                for position, item in enumerate(items, start=1):
                    asset_id = item["asset_id"]
                    entry = entries[asset_id]
                    if entry.get("error"):
                        reports["failed"].append({"asset_id": asset_id, "reason": entry["error"]})
                    elif entry["content"] is None or entry["content"] != item["after_text"]:
                        reports["conflicts"].append({"asset_id": asset_id, "reason": "caption_changed_since_batch"})
                    else:
                        try:
                            versions = {
                                "expected_txt_version": int(entry["txt_version"]),
                                "expected_disk_version": str(entry["disk_version"]),
                            }
                            if item["before_text"] is None:
                                self._catalog.remove_annotation(asset_id, **versions)
                            else:
                                self._catalog.save_annotation(asset_id, item["before_text"], **versions)
                        except Exception as error:
                            category, reason = self._write_failure(error)
                            if reason == "caption_write_failed":
                                logger.exception("caption undo failed; asset_id=%s", asset_id)
                            reports[category].append({"asset_id": asset_id, "reason": reason})
                        else:
                            restored += 1
                    if position % _PROGRESS_EVERY == 0 or position == len(items):
                        self._job_call("update", job_id, current=position, total=len(items))
                undo_stats = {
                    "total": len(items),
                    "restored": restored,
                    "conflicts": len(reports["conflicts"]),
                    "failed": len(reports["failed"]),
                }
                # 撤销只做一次：冲突的图保持现状，不会在下次撤销时被覆盖。
                self._repo.mark_undone(batch_id, undo_stats)
            except BaseException:
                self._job_call("finish", job_id, "failed", message="caption 撤销中断")
                raise
        self._job_call(
            "finish", job_id, "succeeded" if not reports["failed"] else "failed",
            message="" if not reports["failed"] else f"{len(reports['failed'])} 张恢复失败",
        )
        if restored:
            self._publish(dataset_id, batch_id=batch_id, changed=restored, reason="undo")
        return {
            "batch_id": batch_id,
            "dataset_id": dataset_id,
            "stats": undo_stats,
            "conflicts": reports["conflicts"][:REPORT_LIMIT],
            "failed": reports["failed"][:REPORT_LIMIT],
        }

    def history(self, dataset_id: str, *, limit: int = 50) -> list[dict[str, Any]]:
        self._dataset(dataset_id)
        return [
            {**batch, "can_undo": batch["undone_at"] is None and batch["changed_count"] > 0}
            for batch in self._repo.list_batches(dataset_id, limit=limit)
        ]


__all__ = ["CaptionService", "EDITABLE_STATES", "entry_state"]
