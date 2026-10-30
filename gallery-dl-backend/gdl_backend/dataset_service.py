"""数据集服务：成员、漏斗、阶段输入摘要和在线采集挂根。

一个数据集（一次 LoRA 训练）由若干根目录组成。成员是根目录下的活跃图片；
流水线依次是 collect → clean → dedup → tag → review → export，每一段的
输出是下一段的输入。某段「排除」的图从下一段起不再出现；「通过」只是记录。

阶段运行（dataset_stage_runs）记下开始时这一段输入的摘要。之后输入变了
（前面的段多排除了几张、文件被改、加了新根目录），最近一次成功运行就标为
stale，前端据此提示需要重跑。
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from ._database_dataset_repository import (
    DATASET_DECISIONS,
    DATASET_STAGES,
    DatasetNotFound,
    DatasetRepository,
)
from ._database_gallery_repository import (
    GallerySourceConflictError,
    gallery_directory_id,
)
from .gallery_catalog import is_safe_relative_path
from .gallery_hashing import GalleryHashingService
from .gallery_review_selection import excluded_review_path
from .gallery_service import (
    GalleryCatalogService,
    GalleryRootMissing,
    GalleryScanInProgress,
)


logger = logging.getLogger(__name__)

_TERMINAL_BATCH_STATUSES = frozenset({"succeeded", "completed_with_errors", "cancelled"})
THUMBNAIL_SIZE = 256
# 补哈希进度事件的档数：每完成 1/4 发一次，最后一档就是这一轮结束。
_HASHING_STEPS = 4


@dataclass
class _HashingPass:
    pending: set[str] = field(default_factory=set)
    total: int = 0
    step: int = 0


class DatasetError(Exception):
    """数据集业务错误；路由层按 status/code 转成错误封套。"""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message
        self.details = dict(details or {})


def thumbnail_url(asset_id: str) -> str:
    return f"/api/v1/gallery/assets/{asset_id}/thumbnail?size={THUMBNAIL_SIZE}"


def stage_index(stage: str) -> int:
    try:
        return DATASET_STAGES.index(stage)
    except ValueError:
        raise DatasetError(422, "invalid_dataset_stage", f"未知阶段: {stage}") from None


def input_digest(stage: str, members: Iterable[Mapping[str, Any]]) -> str:
    """阶段输入摘要：成员集合 + 文件大小/修改时间；导出段还算上 caption 文件。

    打标会改写 caption，所以 tag/review 段的摘要不含 caption，否则打完标
    自己就 stale 了；只有导出关心 caption 是否在导出后又被改过。
    """
    include_txt = stage == "export"
    lines = []
    for member in members:
        line = f"{member['asset_id']}:{member['size_bytes']}:{member['modified_ns']}"
        if include_txt:
            line += f":{member['txt_state']}:{member['txt_size_bytes']}:{member['txt_modified_ns']}"
        lines.append(line)
    lines.sort()
    digest = hashlib.sha256()
    digest.update(stage.encode("ascii"))
    for line in lines:
        digest.update(b"\n")
        digest.update(line.encode("utf-8"))
    return digest.hexdigest()


def _live(member: Mapping[str, Any]) -> bool:
    return member["lifecycle_state"] == "active" and member["dedup_visibility"] != "excluded"


class DatasetService:
    def __init__(
        self,
        database: Any,
        catalog: GalleryCatalogService,
        hashing: GalleryHashingService,
        *,
        events: Any | None = None,
    ) -> None:
        self._db = database
        self._repo: DatasetRepository = database.datasets
        self._gallery = database.gallery
        self._catalog = catalog
        self.hashing = hashing
        self._events = events
        # 每个数据集这一轮补哈希还没处理完的图；处理完一档就发 dataset.updated。
        self._hashing_guard = threading.Lock()
        self._hashing_passes: dict[str, _HashingPass] = {}
        hashing.add_listener(self._on_asset_hashed)

    @classmethod
    def for_container(cls, container: Any) -> "DatasetService":
        """接到 ServiceContainer 上：扫描后补哈希、爬取批次结束后挂根。"""
        service = cls(
            container.db,
            container.gallery_catalog,
            GalleryHashingService(container.db.gallery),
            events=container.events,
        )
        container.gallery_catalog.add_scan_listener(service.on_scan_committed)
        previous = container.db.gallery_batch_registrar

        def registrar(batch_id: str) -> Any:
            # 先让图库注册批次来源，再挂到等着它的数据集上；
            # 两步都失败也不影响爬取收尾（Database 只记日志）。
            try:
                return previous(batch_id) if previous is not None else None
            finally:
                service.on_batch_finished(batch_id)

        container.db.gallery_batch_registrar = registrar
        return service

    def stop(self) -> None:
        self.hashing.stop()

    def publish_updated(self, dataset_id: str, reason: str) -> None:
        """SSE `dataset.updated`：前端据此重拉数据集详情和漏斗。总线出错不影响写入本身。"""
        if self._events is None:
            return
        try:
            self._events.publish("dataset.updated", {"dataset_id": dataset_id, "reason": reason})
        except Exception:
            logger.exception("dataset.updated publish failed; dataset_id=%s", dataset_id)

    # ---- 数据集 ----

    def _require(self, dataset_id: str) -> dict[str, Any]:
        dataset = self._repo.get_dataset(dataset_id)
        if dataset is None:
            raise DatasetError(404, "dataset_not_found", "数据集不存在")
        return dataset

    def require(self, dataset_id: str) -> None:
        """数据集不存在时抛 404；路由在做有副作用的事之前先调用。"""
        self._require(dataset_id)

    def list_summaries(self) -> list[dict[str, Any]]:
        return [self._summary(dataset) for dataset in self._repo.list_datasets()]

    def create(
        self,
        *,
        name: str,
        kind: str,
        trigger_word: str = "",
        config: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        dataset = self._repo.create_dataset(
            name=name.strip(), kind=kind, trigger_word=trigger_word.strip(), config=config
        )
        self.publish_updated(dataset["dataset_id"], "created")
        return self.detail(dataset["dataset_id"])

    def detail(self, dataset_id: str) -> dict[str, Any]:
        dataset = self._require(dataset_id)
        members = self._repo.member_rows(dataset_id)
        funnel = self._funnel(dataset_id, members)
        return {**self._summary(dataset, members=members, funnel=funnel), "funnel": funnel["stages"]}

    def update(self, dataset_id: str, changes: Mapping[str, Any]) -> dict[str, Any]:
        self._require(dataset_id)
        normalized = dict(changes)
        for key in ("name", "trigger_word"):
            if isinstance(normalized.get(key), str):
                normalized[key] = normalized[key].strip()
        try:
            self._repo.update_dataset(dataset_id, normalized)
        except DatasetNotFound:
            raise DatasetError(404, "dataset_not_found", "数据集不存在") from None
        self.publish_updated(dataset_id, "updated")
        return self.detail(dataset_id)

    def delete(self, dataset_id: str) -> None:
        if not self._repo.delete_dataset(dataset_id):
            raise DatasetError(404, "dataset_not_found", "数据集不存在")
        self.publish_updated(dataset_id, "deleted")

    def _summary(
        self,
        dataset: Mapping[str, Any],
        *,
        members: list[dict[str, Any]] | None = None,
        funnel: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        dataset_id = str(dataset["dataset_id"])
        if members is None:
            members = self._repo.member_rows(dataset_id)
        if funnel is None:
            funnel = self._funnel(dataset_id, members)
        live_ids = [member["asset_id"] for member in members if _live(member)]
        cover = dataset.get("cover_asset_id")
        if cover not in set(live_ids):
            cover = live_ids[0] if live_ids else None
        return {
            "dataset_id": dataset_id,
            "name": dataset["name"],
            "kind": dataset["kind"],
            "trigger_word": dataset["trigger_word"],
            "config": dataset["config"],
            "cover_asset_id": cover,
            "cover_thumbnail_url": thumbnail_url(cover) if cover else None,
            "member_count": funnel["member_count"],
            "output_count": funnel["stages"][-1]["output"],
            "root_count": len(self._repo.list_roots(dataset_id)),
            "stage_outputs": [
                {"stage": stage["stage"], "output": stage["output"], "stale": stage["stale"]}
                for stage in funnel["stages"]
            ],
            "created_at": dataset["created_at"],
            "updated_at": dataset["updated_at"],
        }

    # ---- 漏斗与阶段输入 ----

    def funnel(self, dataset_id: str) -> dict[str, Any]:
        self._require(dataset_id)
        return self._funnel(dataset_id, self._repo.member_rows(dataset_id))

    def _decision_map(self, dataset_id: str) -> dict[str, dict[str, str]]:
        decisions: dict[str, dict[str, str]] = {}
        for row in self._repo.list_decisions(dataset_id):
            decisions.setdefault(row["asset_id"], {})[row["stage"]] = row["decision"]
        return decisions

    def _stage_inputs(
        self, dataset_id: str, members: list[dict[str, Any]]
    ) -> list[tuple[str, list[dict[str, Any]], dict[str, dict[str, str]]]]:
        decisions = self._decision_map(dataset_id)
        result = []
        current = members
        for stage in DATASET_STAGES:
            result.append((stage, current, decisions))
            current = [
                member for member in current
                if decisions.get(member["asset_id"], {}).get(stage) != "exclude"
            ]
        return result

    def _funnel(self, dataset_id: str, members: list[dict[str, Any]]) -> dict[str, Any]:
        latest = self._repo.latest_stage_runs(dataset_id)
        stages = []
        for stage, stage_members, decisions in self._stage_inputs(dataset_id, members):
            excluded = approved = 0
            for member in stage_members:
                decision = decisions.get(member["asset_id"], {}).get(stage)
                if decision == "exclude":
                    excluded += 1
                elif decision == "approve":
                    approved += 1
            digest = input_digest(stage, stage_members)
            run = latest.get(stage)
            stages.append(
                {
                    "stage": stage,
                    "input": len(stage_members),
                    "excluded": excluded,
                    "approved": approved,
                    "output": len(stage_members) - excluded,
                    "input_digest": digest,
                    "status": run["status"] if run else "idle",
                    "stale": bool(run and run["status"] == "succeeded" and run["input_digest"] != digest),
                    "last_run": run,
                }
            )
        return {"dataset_id": dataset_id, "member_count": len(members), "stages": stages}

    def stage_input(
        self, dataset_id: str, stage: str, *, live_only: bool = True
    ) -> list[dict[str, Any]]:
        """某一阶段的输入成员（按自然排序）。Wave 2 的阶段运行从这里取图。

        live_only=True 时去掉已在回收区或被去重排除、只因决定记录还留在漏斗里的图，
        也就是阶段真正能处理的那些。
        """
        self._require(dataset_id)
        index = stage_index(stage)
        members = self._repo.member_rows(dataset_id)
        _, stage_members, _ = self._stage_inputs(dataset_id, members)[index]
        return [member for member in stage_members if _live(member)] if live_only else stage_members

    def stage_input_digest(self, dataset_id: str, stage: str) -> str:
        return input_digest(stage, self.stage_input(dataset_id, stage, live_only=False))

    def members_page(
        self,
        dataset_id: str,
        *,
        stage: str | None = None,
        decision: str | None = None,
        query: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        self._require(dataset_id)
        excluded_before: Sequence[str] = ()
        if stage is not None:
            excluded_before = DATASET_STAGES[: stage_index(stage)]
        elif decision is not None:
            raise DatasetError(422, "invalid_dataset_member_filter", "按决定过滤时必须指定阶段")
        page = self._repo.page_members(
            dataset_id,
            excluded_before=excluded_before,
            stage=stage,
            decision=decision,
            query=query.strip() if query else None,
            cursor=cursor,
            limit=limit,
        )
        decisions: dict[str, list[dict[str, Any]]] = {}
        for row in self._repo.list_decisions(
            dataset_id, (item["asset_id"] for item in page["items"])
        ):
            decisions.setdefault(row["asset_id"], []).append(
                {"stage": row["stage"], "decision": row["decision"], "reason": row["reason"]}
            )
        order = {name: index for index, name in enumerate(DATASET_STAGES)}
        items = []
        for item in page["items"]:
            item_decisions = sorted(decisions.get(item["asset_id"], []), key=lambda row: order[row["stage"]])
            items.append(
                {
                    key: item[key]
                    for key in (
                        "asset_id", "source_id", "directory_id", "relative_path", "name",
                        "format", "width", "height", "size_bytes", "content_sha256",
                        "txt_state", "lifecycle_state", "dedup_visibility",
                    )
                }
                | {"thumbnail_url": thumbnail_url(item["asset_id"]), "decisions": item_decisions}
            )
        return {
            "items": items,
            "next_cursor": page["next_cursor"],
            "total": page["total"],
            "limit": page["limit"],
        }

    def decide(
        self,
        dataset_id: str,
        *,
        stage: str,
        asset_ids: Sequence[str],
        decision: str,
        reason: str = "",
    ) -> dict[str, Any]:
        """批量记录决定（exclude / approve）或清掉本阶段的决定（clear）。

        只接受当前确实是本数据集成员的图，避免记下和数据集无关的行。
        """
        self._require_members(dataset_id, asset_ids)
        stage_index(stage)
        if decision == "clear":
            updated = self._repo.clear_decisions(dataset_id, stage, asset_ids)
        elif decision in DATASET_DECISIONS:
            updated = self._repo.set_decisions(dataset_id, stage, asset_ids, decision, reason=reason)
        else:
            raise DatasetError(422, "invalid_dataset_decision", f"未知决定: {decision}")
        return self._decided(dataset_id, updated, "decisions")

    def set_aside(self, dataset_id: str, *, stage: str, asset_ids: Sequence[str], reason: str) -> dict[str, Any]:
        """临时排除一批成员：原决定收起来，`put_back` 时放回。`reason` 同时是决定和事件的原因。"""
        self._require_members(dataset_id, asset_ids)
        stage_index(stage)
        updated = self._repo.set_aside(dataset_id, stage, asset_ids, reason=reason)
        return self._decided(dataset_id, updated, reason)

    def put_back(self, dataset_id: str, *, stage: str, asset_ids: Sequence[str], reason: str) -> dict[str, Any]:
        """撤销 `set_aside`：只动这个 `reason` 记下的排除，`updated` 是真正放回的张数。"""
        self._require(dataset_id)
        stage_index(stage)
        updated = self._repo.put_back(dataset_id, stage, asset_ids, reason=reason)
        return self._decided(dataset_id, updated, reason)

    def _require_members(self, dataset_id: str, asset_ids: Sequence[str]) -> None:
        self._require(dataset_id)
        member_ids = {member["asset_id"] for member in self._repo.member_rows(dataset_id)}
        unknown = [asset_id for asset_id in dict.fromkeys(asset_ids) if asset_id not in member_ids]
        if unknown:
            raise DatasetError(
                422,
                "dataset_asset_not_member",
                "有图片不属于这个数据集",
                details={"asset_ids": unknown[:20]},
            )

    def _decided(self, dataset_id: str, updated: int, reason: str) -> dict[str, Any]:
        """决定写完：有变化时发一条 `dataset.updated`，返回张数和新的漏斗。"""
        if updated:
            self.publish_updated(dataset_id, reason)
        return {"updated": updated, "funnel": self.funnel(dataset_id)}

    # ---- 阶段运行（Wave 2 的各阶段服务调用） ----

    def start_stage_run(
        self,
        dataset_id: str,
        stage: str,
        *,
        ref_id: str = "",
        stats: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        digest = self.stage_input_digest(dataset_id, stage)
        run = self._repo.create_stage_run(
            dataset_id, stage, input_digest=digest, ref_id=ref_id, stats=stats
        )
        self.publish_updated(dataset_id, "stage_run")
        return run

    def finish_stage_run(
        self,
        run_id: str,
        *,
        status: str,
        stats: Mapping[str, Any] | None = None,
        error_code: str = "",
        ref_id: str | None = None,
    ) -> dict[str, Any] | None:
        if status == "running":
            raise ValueError("finish_stage_run_requires_terminal_status")
        run = self._repo.update_stage_run(
            run_id, status=status, stats=stats, error_code=error_code, ref_id=ref_id
        )
        if run is not None:
            self.publish_updated(run["dataset_id"], "stage_run")
        return run

    def list_stage_runs(
        self, dataset_id: str, *, stage: str | None = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        self._require(dataset_id)
        if stage is not None:
            stage_index(stage)
        return self._repo.list_stage_runs(dataset_id, stage=stage, limit=limit)

    # ---- 根目录 ----

    def list_roots(self, dataset_id: str) -> list[dict[str, Any]]:
        self._require(dataset_id)
        return self._repo.list_roots(dataset_id)

    def attach_directory(
        self, dataset_id: str, directory_id: str, *, origin: str = "library"
    ) -> tuple[dict[str, Any], bool]:
        self._require(dataset_id)
        directory = self._gallery.get_directory(directory_id)
        if directory is None:
            raise DatasetError(404, "gallery_directory_not_found", "图库目录不存在")
        return self._attach(
            dataset_id, directory["source_id"], directory["relative_path"], origin=origin
        )

    def attach_source(
        self, dataset_id: str, source_id: str, *, origin: str = "library"
    ) -> tuple[dict[str, Any], bool]:
        self._require(dataset_id)
        if self._gallery.get_source(source_id) is None:
            raise DatasetError(404, "gallery_source_not_found", "图库来源不存在")
        return self._attach(dataset_id, source_id, "", origin=origin)

    def attach_path(
        self, dataset_id: str, path: str, *, display_name: str | None = None
    ) -> tuple[dict[str, Any], bool]:
        """从文件夹导入：新建（或复用）覆盖这个路径的图库来源，扫描后挂为根目录。"""
        self._require(dataset_id)
        root = Path(path).expanduser()
        if not root.is_absolute():
            raise DatasetError(422, "dataset_root_path_invalid", "导入目录必须是绝对路径")
        try:
            source = self._catalog.import_source(str(root), display_name=display_name)
            source_id, relative_path = str(source["source_id"]), ""
        except GalleryRootMissing:
            raise DatasetError(404, "source_path_not_found", "导入目录不存在或不是普通目录") from None
        except GallerySourceConflictError as conflict:
            resolved = self._resolve_conflict(root, conflict)
            if resolved is None:
                raise DatasetError(
                    409,
                    "source_path_conflict",
                    "该目录包含已有的图库来源，请改为分别添加这些来源",
                    details={"relation": conflict.relation},
                ) from None
            source_id, relative_path = resolved
        self._start_scan_if_idle(source_id)
        return self._attach(dataset_id, source_id, relative_path, origin="import")

    def detach_root(self, dataset_id: str, root_id: str) -> None:
        self._require(dataset_id)
        if not self._repo.delete_root(dataset_id, root_id):
            raise DatasetError(404, "dataset_root_not_found", "数据集根目录不存在")
        self.publish_updated(dataset_id, "roots")

    def _resolve_conflict(
        self, root: Path, conflict: GallerySourceConflictError
    ) -> tuple[str, str] | None:
        existing = conflict.existing_source
        if conflict.relation == "same":
            return str(existing["source_id"]), ""
        if conflict.relation != "descendant":
            return None
        source = self._gallery.get_source(str(existing["source_id"]))
        if source is None:
            return None
        try:
            relative = Path(os.path.realpath(root)).relative_to(
                Path(os.path.realpath(source["root_path"]))
            )
        except ValueError:
            return None
        relative_path = PurePosixPath(*relative.parts).as_posix()
        if relative_path in ("", "."):
            return str(source["source_id"]), ""
        return str(source["source_id"]), relative_path

    def _attach(
        self, dataset_id: str, source_id: str, relative_path: str, *, origin: str
    ) -> tuple[dict[str, Any], bool]:
        if relative_path and not is_safe_relative_path(relative_path):
            raise DatasetError(422, "dataset_root_path_invalid", "根目录路径不安全")
        if relative_path and excluded_review_path(relative_path):
            raise DatasetError(422, "dataset_root_path_excluded", "回收区、keep、duplicates 等目录不能作为数据集根目录")
        root, created = self._repo.add_root(
            dataset_id,
            source_id=source_id,
            relative_path=relative_path,
            directory_id=gallery_directory_id(source_id, relative_path),
            origin=origin,
        )
        self.enqueue_hashing(dataset_id)
        if created:
            self.publish_updated(dataset_id, "roots")
        return root, created

    def _start_scan_if_idle(self, source_id: str) -> None:
        try:
            self._catalog.start_scan(source_id)
        except GalleryScanInProgress:
            pass

    # ---- 文件哈希 ----

    def enqueue_hashing(self, dataset_id: str, *, source_id: str | None = None) -> dict[str, int]:
        members = self._repo.member_rows(dataset_id)
        missing = [
            member["asset_id"]
            for member in members
            if _live(member)
            and not member["content_sha256"]
            and (source_id is None or member["source_id"] == source_id)
        ]
        if missing:
            with self._hashing_guard:
                current = self._hashing_passes.setdefault(dataset_id, _HashingPass())
                added = set(missing) - current.pending
                current.pending |= added
                current.total += len(added)
        self.hashing.enqueue(missing)
        return self._hashing_status(members)

    def _on_asset_hashed(self, asset_id: str, _outcome: str) -> None:
        """哈希线程回调：数据集这一轮每完成一档（1/4）发一次 `dataset.updated` reason=hashing。"""
        updated: list[str] = []
        with self._hashing_guard:
            for dataset_id, current in list(self._hashing_passes.items()):
                if asset_id not in current.pending:
                    continue
                current.pending.discard(asset_id)
                if not current.pending:
                    del self._hashing_passes[dataset_id]
                    updated.append(dataset_id)
                    continue
                step = (current.total - len(current.pending)) * _HASHING_STEPS // current.total
                if step > current.step:
                    current.step = step
                    updated.append(dataset_id)
        for dataset_id in updated:
            self.publish_updated(dataset_id, "hashing")

    def hashing_status(self, dataset_id: str) -> dict[str, int]:
        self._require(dataset_id)
        return self._hashing_status(self._repo.member_rows(dataset_id))

    def _hashing_status(self, members: list[dict[str, Any]]) -> dict[str, int]:
        live = [member for member in members if _live(member)]
        return {
            "member_count": len(live),
            "hashed_count": sum(1 for member in live if member["content_sha256"]),
            "pending": self.hashing.pending_count(),
        }

    def on_scan_committed(self, source_id: str) -> None:
        # 扫描可能增删了根目录下的图，成员和各段输入随之变化。
        for dataset_id in self._repo.dataset_ids_for_source(source_id):
            self.enqueue_hashing(dataset_id, source_id=source_id)
            self.publish_updated(dataset_id, "members")

    # ---- 在线采集 ----

    def register_crawl(self, dataset_id: str, batch_id: str) -> dict[str, Any]:
        self._require(dataset_id)
        self._repo.add_crawl(dataset_id, batch_id)
        self.publish_updated(dataset_id, "crawls")
        # 幂等重放到一个已经结束的批次时，直接挂根。
        self.on_batch_finished(batch_id)
        for crawl in self._repo.list_crawls(dataset_id):
            if crawl["batch_id"] == batch_id:
                return crawl
        raise DatasetError(404, "dataset_crawl_not_found", "数据集采集记录不存在")

    def list_crawls(self, dataset_id: str) -> list[dict[str, Any]]:
        self._require(dataset_id)
        return self._repo.list_crawls(dataset_id)

    def on_batch_finished(self, batch_id: str) -> None:
        for crawl in self._repo.pending_crawls(batch_id):
            try:
                self._try_attach_crawl(crawl)
            except Exception:
                logger.exception(
                    "dataset crawl attach failed; dataset_id=%s batch_id=%s",
                    crawl["dataset_id"], batch_id,
                )

    def _try_attach_crawl(self, crawl: Mapping[str, Any]) -> bool:
        dataset_id, batch_id = str(crawl["dataset_id"]), str(crawl["batch_id"])
        batch = self._db.get_crawl_batch(batch_id)
        if batch is None:
            self._repo.mark_crawl(dataset_id, batch_id, state="failed", error_code="crawl_not_found")
            return False
        if batch["status"] not in _TERMINAL_BATCH_STATUSES:
            return False
        source = self._gallery.get_source_by_batch_id(batch_id)
        resolved: tuple[str, str] | None = None
        if source is not None:
            resolved = (str(source["source_id"]), "")
        else:
            output_dir = Path(str(batch.get("output_dir") or ""))
            if not str(batch.get("output_dir") or "") or not output_dir.is_dir():
                self._repo.mark_crawl(
                    dataset_id, batch_id, state="failed", error_code="crawl_output_missing"
                )
                return False
            # 批次目录落在某个已导入来源里面时，图库不会为它单独注册来源；
            # 这时直接挂那个来源下的子目录。
            for candidate in self._gallery.list_sources():
                try:
                    relative = Path(os.path.realpath(output_dir)).relative_to(
                        Path(os.path.realpath(candidate["root_path"]))
                    )
                except ValueError:
                    continue
                resolved = (str(candidate["source_id"]), PurePosixPath(*relative.parts).as_posix())
                if resolved[1] == ".":
                    resolved = (resolved[0], "")
                self._start_scan_if_idle(resolved[0])
                break
        if resolved is None:
            # 批次目录和已有来源冲突（例如包含了别的来源），图库没能注册它。
            self._repo.mark_crawl(
                dataset_id, batch_id, state="failed", error_code="crawl_source_conflict"
            )
            return False
        root, _created = self._attach(dataset_id, resolved[0], resolved[1], origin="crawl")
        self._repo.mark_crawl(dataset_id, batch_id, state="attached", root_id=root["root_id"])
        return True

    def reconcile(self) -> dict[str, int]:
        """启动对账：补挂重启前没来得及挂的批次，给所有数据集排队补哈希。"""
        attached = 0
        for crawl in self._repo.pending_crawls():
            try:
                if self._try_attach_crawl(crawl):
                    attached += 1
            except Exception:
                logger.exception(
                    "dataset crawl reconcile failed; dataset_id=%s batch_id=%s",
                    crawl["dataset_id"], crawl["batch_id"],
                )
        queued = 0
        for dataset in self._repo.list_datasets():
            try:
                before = self.hashing.pending_count()
                self.enqueue_hashing(dataset["dataset_id"])
                queued += max(0, self.hashing.pending_count() - before)
            except Exception:
                logger.exception("dataset hashing enqueue failed; dataset_id=%s", dataset["dataset_id"])
        return {"attached_crawls": attached, "queued_hashes": queued}


__all__ = [
    "DatasetError",
    "DatasetService",
    "input_digest",
    "stage_index",
    "thumbnail_url",
]
