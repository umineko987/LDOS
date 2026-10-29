"""清洗 / 去重阶段：在图库审核机制上跑数据集流水线的一段，再逐组定夺。

- 清洗（clean）：只开过滤器的审核——基础去重和相似分组都关。worker 让每张图
  单独成组，给黑白 / 草稿打辅助分类（只标记、等人定夺）；角色过滤不匹配的图
  属于自动排除，分析完立即移入回收区。
- 去重（dedup）：基础去重（完全相同 / 压缩同源，自动回收）加相似分组，过滤器全关。

一次运行从 ``stage_input`` 取这一段的全部输入（没有图库审核 API 的 200 张上限），
建一次图库审核，并记一条阶段运行（ref_id = review_id）。审核分析完、自动回收落地
后，被自动回收的图记成本阶段「排除」，阶段运行标为成功；之后用户逐组定夺：
保留的记「通过」，淘汰的移入回收区（可恢复）并记「排除」。每一批定夺都能撤销。

限制：图库审核是一次性任务，后端重启时全部清除。重启后旧运行的分组不能再定夺
（stage_triage_expired），要重跑这一段；已记下的决定和回收区里的文件都保留。
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
import uuid
from collections.abc import Mapping, Sequence
from typing import Any

from ._database_dataset_repository import DatasetNotFound
from .dataset_service import DatasetError, DatasetService, thumbnail_url
from .redaction import safe_exception_category
from .review_filters import BUILTIN_PRESETS, FilterConfigurationError


logger = logging.getLogger(__name__)

TRIAGE_STAGES: tuple[str, ...] = ("clean", "dedup")
FILTER_KEYS: tuple[str, ...] = ("filter_monochrome", "filter_sketch", "filter_character")
CLEAN_REASONS: tuple[str, ...] = ("monochrome", "rough", "filter_character", "unreadable")
DEDUP_GROUP_KINDS: tuple[str, ...] = ("duplicate", "unreadable", "auto_exact", "auto_compression")
ACTIVE_REVIEW_STATUSES = frozenset({"pending", "analyzing", "auto_applying"})
UNDO_DEPTH = 50
GROUP_PAGE_MAX = 100
ITEM_PAGE_MAX = 200

# 自动组 → 记在本阶段「排除」上的原因。
_AUTOMATIC_REASONS = {"auto_exact": "auto_exact", "auto_compression": "auto_compression",
                      "auto_filtered": "filter_character"}
_TRIAGE_REASON = "triage"
_QUALITY_KEYS = ("sharpness", "blockiness", "noise_sigma", "jpeg_quality")
_FLAGGED_SQL = (
    "(g.kind='auto_filtered' OR i.readable=0 OR g.kind='unreadable'"
    " OR json_extract(i.metadata_json, '$.classification') IN ('rough', 'monochrome'))"
)


def _review_error(error: Exception) -> DatasetError:
    """图库审核抛出的错误 → 数据集错误封套。"""
    if isinstance(error, FilterConfigurationError):
        status = 409 if error.code == "review_filter_unavailable" else 422
        return DatasetError(status, error.code, str(error), details=error.details if isinstance(error.details, Mapping) else None)
    if isinstance(error, KeyError):
        return DatasetError(409, "stage_input_changed", "阶段输入在建审核时变了，请重试")
    message = str(error)
    if isinstance(error, ValueError):
        if message == "review_selection_empty":
            return DatasetError(409, "stage_input_empty", "这一段没有可处理的图片")
        return DatasetError(422, "invalid_filter_options", "过滤选项无效")
    if isinstance(error, RuntimeError) and message.startswith("review_"):
        return DatasetError(409, message, "图库来源离线或在建审核时变了，请稍后重试")
    if isinstance(error, RuntimeError) and "去重功能未启用" in message:
        return DatasetError(409, "dedup_disabled", "去重功能未启用")
    return DatasetError(409, "review_rejected", message[:200] or "图库审核拒绝了这次操作")


class DatasetTriageService:
    """clean / dedup 两段的运行、分组读取、定夺与撤销。"""

    def __init__(
        self,
        *,
        database: Any,
        datasets: DatasetService,
        reviews: Any,
        settings: Any,
        events: Any = None,
    ) -> None:
        self._db = database
        self._repo = database.datasets
        self._review_repo = database.gallery_reviews
        self._datasets = datasets
        self._reviews = reviews
        self._settings = settings
        self._events = events
        # 定夺 / 收尾都要读改写审核与决定，串行化；只在短暂 DB 操作期间持有。
        self._lock = threading.RLock()
        self._starting: set[tuple[str, str]] = set()
        self._undo: dict[tuple[str, str], list[dict[str, Any]]] = {}
        self._review_runs: dict[str, dict[str, str]] = {}
        reviews.add_listener(self._on_review_changed)

    @classmethod
    def for_container(cls, container: Any) -> "DatasetTriageService":
        return cls(
            database=container.db,
            datasets=container.datasets,
            reviews=container.gallery_reviews,
            settings=container.settings.dedup,
            events=container.events,
        )

    # ---- 运行 ----

    def run(
        self,
        dataset_id: str,
        stage: str,
        *,
        preset_id: str | None = None,
        options: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        self._require_stage(stage)
        self._datasets.require(dataset_id)
        if not self._settings.enabled:
            raise DatasetError(409, "dedup_disabled", "去重功能未启用，请先在设置里准备去重环境")
        key = (dataset_id, stage)
        with self._lock:
            if key in self._starting:
                raise DatasetError(409, "stage_run_active", "这一段正在启动")
            self._starting.add(key)
        try:
            previous = self._latest_run(dataset_id, stage)
            if previous is not None and previous["status"] == "running":
                previous = self._finalize(previous) or previous
                if previous["status"] == "running":
                    raise DatasetError(409, "stage_run_active", "这一段正在运行",
                                       details={"run_id": previous["run_id"]})
            preset_name, config_options = self._options(stage, preset_id, options)
            members = self._datasets.stage_input(dataset_id, stage)
            if not members:
                raise DatasetError(409, "stage_input_empty", "这一段没有可处理的图片")
            config = {"preset_name": preset_name, "options": config_options}
            try:
                review = self._reviews.create([], [member["asset_id"] for member in members], config)
            except (FilterConfigurationError, KeyError, ValueError, RuntimeError) as error:
                raise _review_error(error) from None
            review_id = str(review["review_id"])
            stats = {"mode": stage, "preset_name": preset_name, "options": config_options,
                     "input_count": len(members)}
            try:
                run = self._datasets.start_stage_run(dataset_id, stage, ref_id=review_id, stats=stats)
            except DatasetNotFound:
                self._discard_review(review_id)
                raise DatasetError(404, "dataset_not_found", "数据集不存在") from None
            with self._lock:
                self._review_runs[review_id] = {"dataset_id": dataset_id, "stage": stage, "run_id": run["run_id"]}
                self._undo.pop(key, None)
            if previous is not None and previous.get("ref_id"):
                self._discard_review(str(previous["ref_id"]))
        finally:
            with self._lock:
                self._starting.discard(key)
        self._publish_stage(run)
        # 分析可能在登记阶段运行之前就结束了（例如 worker 立即失败）：补一次收尾。
        run = self._finalize(run) or run
        return self.summary(dataset_id, stage)

    def recover(self) -> int:
        """启动恢复：图库审核已被清空，还挂着 running 的 clean/dedup 运行一律标失败。"""
        with self._db._read() as conn:
            rows = conn.execute(
                "SELECT id FROM dataset_stage_runs WHERE status='running' AND stage IN (?, ?)",
                TRIAGE_STAGES,
            ).fetchall()
        recovered = 0
        for row in rows:
            run = self._repo.get_stage_run(str(row["id"]))
            if run is not None and self._finalize(run, interrupted=True) is not None:
                recovered += 1
        return recovered

    def describe_review(self, review_id: str) -> dict[str, Any] | None:
        """活动中心：审核 Job 补上数据集归属（采样线程调用，只读内存）。"""
        with self._lock:
            owner = self._review_runs.get(review_id)
        if owner is None:
            return None
        title = "清洗分析" if owner["stage"] == "clean" else "去重分析"
        return {"title": title, "ref": dict(owner)}

    def _options(
        self, stage: str, preset_id: str | None, overrides: Mapping[str, Any] | None
    ) -> tuple[str, dict[str, Any]]:
        if preset_id is not None:
            presets = {preset["id"]: preset for preset in self._review_repo.list_presets()}
            preset = presets.get(preset_id)
            if preset is None:
                raise DatasetError(404, "review_preset_not_found", "过滤预设不存在")
            name = str(preset["name"])
            options = dict(preset["options"])
        elif stage == "clean":
            builtin = BUILTIN_PRESETS[0]
            name, options = "数据集清洗", dict(builtin["options"])
        else:
            name = "数据集去重"
            options = {"basic_dedup": True, "similarity_groups": True,
                       **{key: False for key in FILTER_KEYS}, "reference_asset_ids": []}
        for key, value in (overrides or {}).items():
            if value is not None:
                options[key] = value
        options["reference_asset_ids"] = list(options.get("reference_asset_ids") or [])
        if stage == "clean":
            # 只过滤不分组：每张图单独成组，没有自动去重组。
            options["basic_dedup"] = False
            options["similarity_groups"] = False
            if not any(options.get(key) for key in FILTER_KEYS):
                raise DatasetError(422, "clean_stage_no_filters", "清洗至少要开一个过滤器")
        else:
            for key in FILTER_KEYS:
                options[key] = False
            options["reference_asset_ids"] = []
            if not (options.get("basic_dedup") or options.get("similarity_groups")):
                raise DatasetError(422, "dedup_stage_no_checks", "去重至少要开基础去重或相似分组之一")
        return name, options

    # ---- 收尾（审核循环的监听回调） ----

    def _on_review_changed(self, review_id: str) -> None:
        # 回调发生在审核循环（事件循环线程）里；收尾要等定夺锁、写决定，放到线程池里做。
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self._finalize_review(review_id)
        else:
            loop.run_in_executor(None, self._finalize_review, review_id)

    def _finalize_review(self, review_id: str) -> None:
        try:
            with self._lock:
                owner = self._review_runs.get(review_id)
            run = self._repo.get_stage_run(owner["run_id"]) if owner else self._running_run_for_review(review_id)
            if run is not None:
                self._finalize(run)
        except Exception as exc:
            logger.warning("dataset triage finalize failed; category=%s", safe_exception_category(exc))

    def _running_run_for_review(self, review_id: str) -> dict[str, Any] | None:
        with self._db._read() as conn:
            row = conn.execute(
                "SELECT id FROM dataset_stage_runs WHERE ref_id=? AND status='running' AND stage IN (?, ?)"
                " ORDER BY created_at DESC LIMIT 1",
                (review_id, *TRIAGE_STAGES),
            ).fetchone()
        return None if row is None else self._repo.get_stage_run(str(row["id"]))

    def _finalize(self, run: Mapping[str, Any], *, interrupted: bool = False) -> dict[str, Any] | None:
        """审核到了终态就把阶段运行收尾；返回收尾后的运行，还在分析中返回 None。"""
        decisions_changed = False
        with self._lock:
            current = self._repo.get_stage_run(str(run["run_id"]))
            if current is None or current["status"] != "running":
                return None
            review_id = str(current["ref_id"])
            review = self._review_repo.get_crawl_review(review_id) if review_id else None
            stats = dict(current["stats"])
            if review is None:
                code = "interrupted" if interrupted else "review_lost"
                finished = self._datasets.finish_stage_run(current["run_id"], status="failed",
                                                          stats=stats, error_code=code)
            elif review["status"] == "failed":
                stats["error"] = str(review.get("error") or "")[:500]
                finished = self._datasets.finish_stage_run(current["run_id"], status="failed",
                                                          stats=stats, error_code="review_failed")
            elif review["status"] == "ready":
                excluded = self._record_automatic_exclusions(current, review_id)
                decisions_changed = bool(excluded)
                stats["review"] = self._counts(current["dataset_id"], current["stage"], review_id)
                finished = self._datasets.finish_stage_run(current["run_id"], status="succeeded", stats=stats)
            else:
                return None
        if finished is not None:
            self._publish_stage(finished)
            if decisions_changed:
                self._publish_dataset(str(finished["dataset_id"]))
        return finished

    def _record_automatic_exclusions(self, run: Mapping[str, Any], review_id: str) -> int:
        with self._db._read() as conn:
            rows = conn.execute(
                "SELECT i.id, g.kind FROM gallery_review_images i JOIN gallery_review_groups g"
                " ON g.review_id=i.review_id AND g.id=i.group_id"
                " WHERE i.review_id=? AND g.kind LIKE 'auto_%' AND i.disposition='rejected'",
                (review_id,),
            ).fetchall()
        by_reason: dict[str, list[str]] = {}
        for row in rows:
            reason = _AUTOMATIC_REASONS.get(str(row["kind"]), str(row["kind"]))
            by_reason.setdefault(reason, []).append(str(row["id"]))
        for reason, asset_ids in by_reason.items():
            self._repo.set_decisions(str(run["dataset_id"]), str(run["stage"]), asset_ids, "exclude", reason=reason)
        return len(rows)

    # ---- 读取 ----

    def summary(self, dataset_id: str, stage: str) -> dict[str, Any]:
        self._require_stage(stage)
        self._datasets.require(dataset_id)
        run = self._latest_run(dataset_id, stage)
        if run is not None and run["status"] == "running":
            run = self._finalize(run) or run
        review = None
        if run is not None and run.get("ref_id"):
            review = self._review_repo.get_crawl_review(str(run["ref_id"]))
        review_status = None
        if run is not None:
            review_status = str(review["status"]) if review is not None else "expired"
        with self._lock:
            stack = [batch for batch in self._undo.get((dataset_id, stage), [])
                     if run is not None and batch["run_id"] == run["run_id"]]
        counts = (self._counts(dataset_id, stage, str(run["ref_id"])) if review is not None and run is not None
                  else self._empty_counts(run))
        return {
            "dataset_id": dataset_id,
            "stage": stage,
            "run": run,
            "review_id": str(run["ref_id"]) if run is not None and run.get("ref_id") else None,
            "review_status": review_status,
            "review_error": str((review or {}).get("error") or "")[:500],
            "counts": counts,
            "undo_depth": len(stack),
            "last_batch_id": stack[-1]["batch_id"] if stack else None,
        }

    @staticmethod
    def _empty_counts(run: Mapping[str, Any] | None) -> dict[str, int]:
        stats = dict((run or {}).get("stats") or {})
        recorded = dict(stats.get("review") or {})
        counts = {key: 0 for key in ("input", "groups", "pending_groups", "decided_groups", "flagged",
                                     "automatic_excluded", "kept", "rejected", "failed")}
        counts.update({key: int(value) for key, value in recorded.items() if key in counts})
        counts["input"] = int(stats.get("input_count") or counts["input"])
        return counts

    def _counts(self, dataset_id: str, stage: str, review_id: str) -> dict[str, int]:
        group_kinds = ("'duplicate'", "'unreadable'") if stage == "dedup" else None
        with self._db._read() as conn:
            review = conn.execute("SELECT total_image_count FROM gallery_reviews WHERE review_id=?",
                                  (review_id,)).fetchone()
            if stage == "dedup":
                groups = conn.execute(
                    "SELECT COUNT(*) AS total, SUM(CASE WHEN decided=0 THEN 1 ELSE 0 END) AS pending"
                    f" FROM gallery_review_groups WHERE review_id=? AND kind IN ({','.join(group_kinds)})",
                    (review_id,),
                ).fetchone()
                flagged = int(groups["total"] or 0)
            else:
                groups = conn.execute(
                    "SELECT COUNT(DISTINCT g.id) AS total,"
                    " COUNT(DISTINCT CASE WHEN g.decided=0 THEN g.id END) AS pending"
                    " FROM gallery_review_images i JOIN gallery_review_groups g"
                    " ON g.review_id=i.review_id AND g.id=i.group_id"
                    f" WHERE i.review_id=? AND g.kind NOT LIKE 'auto_%' AND {_FLAGGED_SQL}",
                    (review_id,),
                ).fetchone()
                flagged = int(conn.execute(
                    "SELECT COUNT(*) FROM gallery_review_images i JOIN gallery_review_groups g"
                    " ON g.review_id=i.review_id AND g.id=i.group_id"
                    f" WHERE i.review_id=? AND {_FLAGGED_SQL}",
                    (review_id,),
                ).fetchone()[0])
            images = conn.execute(
                "SELECT SUM(CASE WHEN g.kind LIKE 'auto_%' AND i.disposition='rejected' THEN 1 ELSE 0 END) AS auto,"
                " SUM(CASE WHEN g.kind NOT LIKE 'auto_%' AND g.decided=1 AND i.disposition='kept' THEN 1 ELSE 0 END) AS kept,"
                " SUM(CASE WHEN g.kind NOT LIKE 'auto_%' AND i.disposition='rejected' THEN 1 ELSE 0 END) AS rejected,"
                " SUM(CASE WHEN i.disposition='failed' THEN 1 ELSE 0 END) AS failed"
                " FROM gallery_review_images i JOIN gallery_review_groups g"
                " ON g.review_id=i.review_id AND g.id=i.group_id WHERE i.review_id=?",
                (review_id,),
            ).fetchone()
        total = int(groups["total"] or 0)
        pending = int(groups["pending"] or 0)
        return {
            "input": int(review["total_image_count"]) if review is not None else 0,
            "groups": total,
            "pending_groups": pending,
            "decided_groups": total - pending,
            "flagged": flagged,
            "automatic_excluded": int(images["auto"] or 0),
            "kept": int(images["kept"] or 0),
            "rejected": int(images["rejected"] or 0),
            "failed": int(images["failed"] or 0),
        }

    def dedup_groups(
        self,
        dataset_id: str,
        *,
        state: str = "all",
        include_automatic: bool = True,
        offset: int = 0,
        limit: int = 50,
    ) -> dict[str, Any]:
        run, review = self._context(dataset_id, "dedup")
        review_id = str(run["ref_id"])
        kinds = ["duplicate", "unreadable"] + (["auto_exact", "auto_compression"] if include_automatic else [])
        where = f"review_id=? AND kind IN ({','.join('?' for _ in kinds)})"
        params: list[Any] = [review_id, *kinds]
        if state == "pending":
            where += " AND decided=0"
        elif state == "decided":
            where += " AND decided=1"
        limit = max(1, min(int(limit), GROUP_PAGE_MAX))
        offset = max(0, int(offset))
        with self._db._read() as conn:
            total = int(conn.execute(f"SELECT COUNT(*) FROM gallery_review_groups WHERE {where}", params).fetchone()[0])
            group_rows = conn.execute(
                f"SELECT * FROM gallery_review_groups WHERE {where} ORDER BY ordinal LIMIT ? OFFSET ?",
                [*params, limit, offset],
            ).fetchall()
            members = self._member_rows(conn, review_id, [str(row["id"]) for row in group_rows])
        decisions = self._stage_decisions(dataset_id, "dedup", [row["id"] for rows in members.values() for row in rows])
        paths = {}
        for rows in members.values():
            for row in rows:
                paths[str(row["relative_path"])] = str(row["id"])
        winners = self._winner_ids(review_id, group_rows, paths)
        items = []
        for row in group_rows:
            group_members = [self._member(review_id, image, decisions) for image in members.get(str(row["id"]), [])]
            items.append({
                "group_id": str(row["id"]),
                "kind": str(row["kind"]),
                "automatic": str(row["kind"]).startswith("auto_"),
                "decided": bool(row["decided"]),
                "match_levels": [str(level) for level in json.loads(row["match_levels_json"] or "[]")],
                "reason": str(row["reason"] or ""),
                "suggested_keep": [member["asset_id"] for member in group_members if member["recommended"]],
                "winner_asset_id": winners.get(str(row["id"])),
                "members": group_members,
            })
        return {"run_id": run["run_id"], "review_id": review_id, "total": total,
                "offset": offset, "limit": limit, "items": items}

    def clean_items(
        self,
        dataset_id: str,
        *,
        state: str = "all",
        reason: str | None = None,
        offset: int = 0,
        limit: int = 100,
    ) -> dict[str, Any]:
        run, review = self._context(dataset_id, "clean")
        review_id = str(run["ref_id"])
        where = f"i.review_id=? AND {_FLAGGED_SQL}"
        params: list[Any] = [review_id]
        if state == "pending":
            where += " AND g.decided=0"
        elif state == "decided":
            where += " AND g.decided=1"
        if reason == "filter_character":
            where += " AND g.kind='auto_filtered'"
        elif reason == "unreadable":
            where += " AND (i.readable=0 OR g.kind='unreadable')"
        elif reason in {"rough", "monochrome"}:
            where += " AND json_extract(i.metadata_json, '$.classification')=?"
            params.append(reason)
        limit = max(1, min(int(limit), ITEM_PAGE_MAX))
        offset = max(0, int(offset))
        joined = ("FROM gallery_review_images i JOIN gallery_review_groups g"
                  " ON g.review_id=i.review_id AND g.id=i.group_id"
                  " LEFT JOIN gallery_assets a ON a.id=i.id")
        with self._db._read() as conn:
            total = int(conn.execute(f"SELECT COUNT(*) {joined} WHERE {where}", params).fetchone()[0])
            rows = conn.execute(
                f"SELECT i.*, g.kind AS group_kind, g.decided AS group_decided, {self._asset_columns()}"
                f" {joined} WHERE {where} ORDER BY g.ordinal, i.ordinal LIMIT ? OFFSET ?",
                [*params, limit, offset],
            ).fetchall()
        decisions = self._stage_decisions(dataset_id, "clean", [row["id"] for row in rows])
        items = []
        for row in rows:
            member = self._member(review_id, row, decisions)
            metadata = json.loads(row["metadata_json"] or "{}")
            reasons = []
            if row["group_kind"] == "auto_filtered":
                reasons.append("filter_character")
            if metadata.get("classification") in {"rough", "monochrome"}:
                reasons.append(str(metadata["classification"]))
            if not row["readable"] or row["group_kind"] == "unreadable":
                reasons.append("unreadable")
            items.append(member | {
                "group_id": str(row["group_id"]),
                "group_kind": str(row["group_kind"]),
                "automatic": str(row["group_kind"]).startswith("auto_"),
                "decided": bool(row["group_decided"]),
                "reasons": reasons,
            })
        return {"run_id": run["run_id"], "review_id": review_id, "total": total,
                "offset": offset, "limit": limit, "items": items}

    @staticmethod
    def _asset_columns() -> str:
        return ("a.name AS asset_name, a.relative_path AS asset_relative_path, a.source_id AS asset_source_id,"
                " a.width AS asset_width, a.height AS asset_height, a.size_bytes AS asset_size,"
                " a.format AS asset_format, a.lifecycle_state AS asset_lifecycle")

    def _member_rows(self, conn: Any, review_id: str, group_ids: Sequence[str]) -> dict[str, list[Any]]:
        if not group_ids:
            return {}
        rows = conn.execute(
            f"SELECT i.*, {self._asset_columns()} FROM gallery_review_images i"
            " LEFT JOIN gallery_assets a ON a.id=i.id"
            f" WHERE i.review_id=? AND i.group_id IN ({','.join('?' for _ in group_ids)})"
            " ORDER BY i.group_id, i.ordinal",
            (review_id, *group_ids),
        ).fetchall()
        grouped: dict[str, list[Any]] = {}
        for row in rows:
            grouped.setdefault(str(row["group_id"]), []).append(row)
        return grouped

    def _winner_ids(self, review_id: str, group_rows: Sequence[Any], paths: dict[str, str]) -> dict[str, str | None]:
        """自动组只存淘汰图，保留图（winner）按 metadata 里的路径反查。"""
        wanted: dict[str, str] = {}
        with self._db._read() as conn:
            for row in group_rows:
                if not str(row["kind"]).startswith("auto_"):
                    continue
                first = conn.execute(
                    "SELECT metadata_json FROM gallery_review_images WHERE review_id=? AND group_id=?"
                    " ORDER BY ordinal LIMIT 1",
                    (review_id, row["id"]),
                ).fetchone()
                metadata = json.loads(first["metadata_json"] or "{}") if first else {}
                winner_path = str((metadata.get("automatic_dedup") or {}).get("winner_relative_path") or "")
                if winner_path:
                    wanted[str(row["id"])] = winner_path
            missing = [path for path in wanted.values() if path not in paths]
            if missing:
                found = conn.execute(
                    f"SELECT id, relative_path FROM gallery_review_images WHERE review_id=?"
                    f" AND relative_path IN ({','.join('?' for _ in missing)})",
                    (review_id, *missing),
                ).fetchall()
                paths = {**paths, **{str(item["relative_path"]): str(item["id"]) for item in found}}
        return {group_id: paths.get(path) for group_id, path in wanted.items()}

    def _stage_decisions(self, dataset_id: str, stage: str, asset_ids: Sequence[str]) -> dict[str, str]:
        return {
            row["asset_id"]: row["decision"]
            for row in self._repo.list_decisions(dataset_id, [str(asset_id) for asset_id in asset_ids])
            if row["stage"] == stage
        }

    @staticmethod
    def _member(review_id: str, row: Any, decisions: Mapping[str, str]) -> dict[str, Any]:
        metadata = json.loads(row["metadata_json"] or "{}")
        asset_id = str(row["id"])
        review_path = str(row["relative_path"])
        relative_path = row["asset_relative_path"] or review_path.partition("/")[2]
        quality = {key: metadata.get(key) for key in _QUALITY_KEYS if isinstance(metadata.get(key), (int, float))}
        return {
            "asset_id": asset_id,
            "source_id": row["asset_source_id"] or review_path.partition("/")[0],
            "name": row["asset_name"] or relative_path.rsplit("/", 1)[-1],
            "relative_path": relative_path,
            "thumbnail_url": thumbnail_url(asset_id),
            "image_url": f"/api/v1/gallery/reviews/{review_id}/images/{asset_id}",
            "width": int(metadata.get("w") or row["asset_width"] or 0),
            "height": int(metadata.get("h") or row["asset_height"] or 0),
            "size_bytes": int(metadata.get("size") or row["asset_size"] or 0),
            "format": str(metadata.get("format") or row["asset_format"] or ""),
            "readable": bool(row["readable"]),
            "recommended": bool(row["recommended"]),
            "selected": bool(row["selected"]),
            "disposition": str(row["disposition"]),
            "trashed": row["asset_lifecycle"] == "trashed",
            "classification": metadata.get("classification") if metadata.get("classification") in {"rough", "monochrome"} else None,
            "quality": quality,
            "review_metrics": metadata.get("review_metrics") if isinstance(metadata.get("review_metrics"), dict) else None,
            "decision": decisions.get(asset_id),
            "error": str(row["error"] or ""),
        }

    # ---- 定夺与撤销 ----

    def apply(
        self,
        dataset_id: str,
        stage: str,
        *,
        run_id: str,
        groups: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        """逐组定夺：keep 里的保留（记「通过」），其余移入回收区（记「排除」）。

        先整体校验再动文件；中途某组失败时，已经落地的组照常记进这一批，可撤销。
        自动组也能定夺：把 keep 里自动回收的图找回来。
        """
        run, _review = self._context(dataset_id, stage, run_id=run_id)
        review_id = str(run["ref_id"])
        seen: set[str] = set()
        for group in groups:
            if group["group_id"] in seen:
                raise DatasetError(422, "triage_group_duplicate", "同一组在一批里出现了两次",
                                   details={"group_id": group["group_id"]})
            seen.add(group["group_id"])
        kept: list[str] = []
        rejected: list[str] = []
        failed: list[dict[str, str]] = []
        entries: list[dict[str, Any]] = []
        error: dict[str, Any] | None = None
        with self._lock:
            plans = []
            for group in groups:
                group_id = str(group["group_id"])
                row = self._group_row(review_id, group_id)
                if row is None:
                    raise DatasetError(404, "triage_group_not_found", "分组不存在", details={"group_id": group_id})
                images = self._review_repo.crawl_review_group_images(review_id, group_id)
                member_ids = {str(image["id"]) for image in images}
                keep = list(dict.fromkeys(str(asset_id) for asset_id in group.get("keep") or ()))
                unknown = [asset_id for asset_id in keep if asset_id not in member_ids]
                if unknown:
                    raise DatasetError(422, "triage_asset_not_in_group", "保留的图不在这一组里",
                                       details={"group_id": group_id, "asset_ids": unknown[:20]})
                plans.append((group_id, str(row["kind"]), bool(row["decided"]), images, keep))
            for group_id, kind, decided, images, keep in plans:
                previous_decisions = self._previous_decisions(dataset_id, stage, [str(image["id"]) for image in images])
                try:
                    self._adopt(review_id, group_id, keep, automatic=kind.startswith("auto_"))
                except (KeyError, ValueError, RuntimeError) as exc:
                    error = {"group_id": group_id, "code": "triage_group_rejected", "message": str(exc)[:200]}
                    break
                entries.append({
                    "group_id": group_id,
                    "automatic": kind.startswith("auto_"),
                    "selected": [str(image["id"]) for image in images if image["selected"]],
                    "decided": decided,
                    "decisions": previous_decisions,
                })
                settled = self._review_repo.crawl_review_group_images(review_id, group_id)
                group_kept = [str(image["id"]) for image in settled if image["disposition"] == "kept"]
                group_rejected = [str(image["id"]) for image in settled if image["disposition"] == "rejected"]
                failed.extend({"asset_id": str(image["id"]), "error": str(image.get("error") or "")[:200]}
                              for image in settled if image["disposition"] == "failed")
                if group_kept:
                    self._repo.set_decisions(dataset_id, stage, group_kept, "approve", reason=_TRIAGE_REASON)
                for asset_id in group_rejected:
                    # 自动组里仍在回收区的图保留原来的自动原因。
                    reason = previous_decisions.get(asset_id) or {}
                    keep_reason = kind.startswith("auto_") and reason.get("decision") == "exclude"
                    self._repo.set_decisions(dataset_id, stage, [asset_id], "exclude",
                                             reason=reason["reason"] if keep_reason else _TRIAGE_REASON)
                kept.extend(group_kept)
                rejected.extend(group_rejected)
            batch_id = None
            if entries:
                batch_id = str(uuid.uuid4())
                stack = self._undo.setdefault((dataset_id, stage), [])
                stack.append({"batch_id": batch_id, "run_id": run["run_id"], "created_at": time.time(),
                              "groups": entries})
                del stack[:-UNDO_DEPTH]
        if entries:
            self._publish_stage(run)
            self._publish_dataset(dataset_id)
        return {
            "batch_id": batch_id,
            "applied_groups": len(entries),
            "kept": kept,
            "rejected": rejected,
            "failed": failed,
            "error": error,
            "summary": self.summary(dataset_id, stage),
        }

    def undo(self, dataset_id: str, stage: str, *, batch_id: str | None = None) -> dict[str, Any]:
        """撤销最近一批定夺：文件按原选择对账（找回或重新回收），组恢复待定，决定复原。"""
        run, _review = self._context(dataset_id, stage)
        review_id = str(run["ref_id"])
        with self._lock:
            stack = self._undo.get((dataset_id, stage), [])
            if not stack or stack[-1]["run_id"] != run["run_id"]:
                raise DatasetError(409, "triage_nothing_to_undo", "没有可撤销的定夺")
            batch = stack[-1]
            if batch_id is not None and batch_id != batch["batch_id"]:
                raise DatasetError(409, "triage_undo_not_latest", "只能撤销最近一批定夺",
                                   details={"latest_batch_id": batch["batch_id"]})
            undone = 0
            error = None
            while batch["groups"]:
                entry = batch["groups"][-1]
                try:
                    self._adopt(review_id, entry["group_id"], entry["selected"], automatic=entry["automatic"])
                except (KeyError, ValueError, RuntimeError) as exc:
                    error = {"group_id": entry["group_id"], "code": "triage_undo_failed", "message": str(exc)[:200]}
                    break
                if not entry["decided"]:
                    self._review_repo.reset_group_decided(review_id, entry["group_id"])
                self._restore_decisions(dataset_id, stage, entry["decisions"])
                batch["groups"].pop()
                undone += 1
            if not batch["groups"]:
                stack.pop()
        if undone:
            self._publish_stage(run)
            self._publish_dataset(dataset_id)
        if error is not None and not undone:
            raise DatasetError(409, "triage_undo_failed", "撤销失败：" + error["message"],
                               details={"group_id": error["group_id"]})
        return {"batch_id": batch["batch_id"], "undone_groups": undone, "error": error,
                "summary": self.summary(dataset_id, stage)}

    def _adopt(self, review_id: str, group_id: str, keep: Sequence[str], *, automatic: bool) -> None:
        review = self._review_repo.get_crawl_review(review_id)
        if review is None:
            raise KeyError(review_id)
        self._reviews.adopt_group(review_id, group_id, list(keep), version=int(review["version"]),
                                  allow_automatic=automatic)

    def _previous_decisions(self, dataset_id: str, stage: str, asset_ids: Sequence[str]) -> dict[str, dict[str, str] | None]:
        previous: dict[str, dict[str, str] | None] = {asset_id: None for asset_id in asset_ids}
        for row in self._repo.list_decisions(dataset_id, asset_ids):
            if row["stage"] == stage:
                previous[row["asset_id"]] = {"decision": row["decision"], "reason": row["reason"]}
        return previous

    def _restore_decisions(self, dataset_id: str, stage: str, previous: Mapping[str, Mapping[str, str] | None]) -> None:
        cleared = [asset_id for asset_id, value in previous.items() if value is None]
        if cleared:
            self._repo.clear_decisions(dataset_id, stage, cleared)
        for asset_id, value in previous.items():
            if value is not None:
                self._repo.set_decisions(dataset_id, stage, [asset_id], value["decision"], reason=value["reason"])

    def _group_row(self, review_id: str, group_id: str) -> Any:
        with self._db._read() as conn:
            return conn.execute("SELECT * FROM gallery_review_groups WHERE review_id=? AND id=?",
                                (review_id, group_id)).fetchone()

    # ---- 公共小工具 ----

    @staticmethod
    def _require_stage(stage: str) -> None:
        if stage not in TRIAGE_STAGES:
            raise DatasetError(422, "invalid_triage_stage", f"只有清洗和去重阶段支持定夺: {stage}")

    def _latest_run(self, dataset_id: str, stage: str) -> dict[str, Any] | None:
        # 同一时刻建的两次运行按 rowid 定先后（id 是随机 UUID）。
        with self._db._read() as conn:
            row = conn.execute(
                "SELECT id FROM dataset_stage_runs WHERE dataset_id=? AND stage=?"
                " ORDER BY created_at DESC, rowid DESC LIMIT 1",
                (dataset_id, stage),
            ).fetchone()
        return None if row is None else self._repo.get_stage_run(str(row["id"]))

    def _context(self, dataset_id: str, stage: str, *, run_id: str | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
        """定夺 / 读取的前提：最近一次运行已成功，且它的图库审核还在。"""
        self._require_stage(stage)
        self._datasets.require(dataset_id)
        run = self._latest_run(dataset_id, stage)
        if run is None:
            raise DatasetError(404, "stage_run_not_found", "这一段还没有运行过")
        if run_id is not None and run_id != run["run_id"]:
            raise DatasetError(409, "stage_run_superseded", "这次运行已被更新的运行取代",
                               details={"run_id": run["run_id"]})
        if run["status"] == "running":
            run = self._finalize(run) or run
        if run["status"] == "running":
            raise DatasetError(409, "stage_run_active", "这一段还在分析", details={"run_id": run["run_id"]})
        if run["status"] != "succeeded":
            raise DatasetError(409, "stage_run_failed", "最近一次运行没有成功",
                               details={"run_id": run["run_id"], "error_code": run["error_code"]})
        review = self._review_repo.get_crawl_review(str(run["ref_id"]))
        if review is None:
            raise DatasetError(409, "stage_triage_expired", "后端重启后这次运行的分组已失效，请重跑这一段",
                               details={"run_id": run["run_id"]})
        return run, review

    def _discard_review(self, review_id: str) -> None:
        review = self._review_repo.get_crawl_review(review_id)
        if review is None or review["status"] in ACTIVE_REVIEW_STATUSES:
            return
        try:
            self._reviews.finish(review_id)
        except KeyError:
            pass
        with self._lock:
            self._review_runs.pop(review_id, None)

    def _publish_stage(self, run: Mapping[str, Any]) -> None:
        if self._events is None:
            return
        try:
            self._events.publish("dataset.stage.updated", {
                "dataset_id": run["dataset_id"], "stage": run["stage"],
                "run_id": run["run_id"], "status": run["status"], "review_id": run.get("ref_id") or "",
            })
        except Exception as exc:
            logger.warning("dataset stage event failed; category=%s", safe_exception_category(exc))

    def _publish_dataset(self, dataset_id: str) -> None:
        if self._events is None:
            return
        try:
            self._events.publish("dataset.updated", {"dataset_id": dataset_id})
        except Exception as exc:
            logger.warning("dataset event failed; category=%s", safe_exception_category(exc))


__all__ = [
    "CLEAN_REASONS",
    "DEDUP_GROUP_KINDS",
    "TRIAGE_STAGES",
    "DatasetTriageService",
]
