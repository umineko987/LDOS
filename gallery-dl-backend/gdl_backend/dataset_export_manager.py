"""数据集导出引擎（G5）：预检、暂存、提交与恢复。

职责（docs/图库(含导出).md §3.9、§5.6、§7.4）：
- 预检（preflight）严格阻断：TXT 缺失/空白/解码异常、目标相对路径冲突、
  来源去重未完成一律阻止整个任务，绝不静默跳过；
- 暂存（staging）：完整复制图片与同名 TXT 到
  `<目标>/.imageweave/staging/<export-id>/`，逐条 hash 校验；
- 提交（commit）：全部样本验证通过后才进入正式目录并最后写独立
  manifest（`<目标>/.imageweave/exports/<export-id>.jsonl`）；
- 恢复（recovery）：`committing` 中断后进入 `recovery_required`，
  重放以完成或回退到 `staged`。

引擎不直接拼装路径：所有相对路径合同来自 `dataset_export.py`。
"""

from __future__ import annotations

import hashlib
import os
import shutil
import threading
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping

from .dataset_export import (
    MANIFEST_SCHEMA_VERSION,
    build_export_manifest_sample_record,
    build_export_manifest_task_record,
    export_manifest_relative_path,
    export_output_relative_path,
    export_staging_relative_dir,
    serialize_export_manifest,
    validate_export_alias,
)
from .gallery_catalog import is_safe_relative_path


class DatasetExportError(Exception):
    """导出引擎错误；code 为稳定错误分类，detail 只含安全相对路径。"""

    def __init__(self, code: str, message: str, *, detail: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.detail = detail or {}


_COPY_CHUNK = 1024 * 1024


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(_COPY_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _copy_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise DatasetExportError(
            "export_target_conflict",
            "export target already exists",
            detail={"relative_path": str(target)},
        )
    shutil.copyfile(source, target)


def _decode_txt_strict(path: Path) -> str:
    """严格 UTF-8 读取（允许 BOM）；失败视为解码异常（§3.9 预检阻断）。"""
    data = path.read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    return data.decode("utf-8")


class DatasetExportManager:
    """导出任务引擎；状态推进全部经由 DatasetExportRepository。"""

    def __init__(
        self,
        *,
        repository: Any,
        gallery_repository: Any,
        gallery_service: Any,
        clock: Callable[[], float] = __import__("time").time,
    ) -> None:
        self._repo = repository
        self._gallery = gallery_repository
        self._gallery_service = gallery_service
        self._clock = clock
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._threads: dict[str, threading.Thread] = {}

    # ---- 锁助手 ----

    def _job_lock(self, job_id: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(job_id)
            if lock is None:
                lock = threading.Lock()
                self._locks[job_id] = lock
            return lock

    # ---- 任务创建与预检 ----

    def create_export(
        self,
        *,
        target_path: str,
        selections: list[dict[str, Any]],
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """创建 draft 任务并记录来源选择；预检由 start/preflight 异步执行。"""
        for selection in selections:
            validate_export_alias(selection["output_alias"])
        digest = hashlib.sha256(
            "|".join(
                f"{s['source_id']}:{s['directory_id']}:{s['output_alias']}"
                for s in selections
            ).encode("utf-8")
        ).hexdigest()
        job = self._repo.create_job(
            target_path=target_path,
            idempotency_key=idempotency_key,
            snapshot_digest=digest,
        )
        for selection in selections:
            self._repo.add_source_snapshot(
                job["job_id"],
                source_id=selection["source_id"],
                directory_id=selection["directory_id"],
                include_descendants=selection.get("include_descendants", False),
                output_alias=selection["output_alias"],
                content_version=selection.get("content_version", 1),
                annotation_version=selection.get("annotation_version", 1),
                indexed_version=selection.get("indexed_version", 0),
            )
        return job

    def preflight(self, job_id: str) -> dict[str, Any]:
        """同步预检：冻结条目并按严格阻断规则给出 ready/blocked。"""
        job = self._require_job(job_id)
        if job["status"] not in {"draft", "blocked"}:
            raise DatasetExportError(
                "export_state_invalid",
                "preflight requires draft or blocked state",
                detail={"status": job["status"]},
            )
        self._repo.update_job_status(job_id, "preflighting")
        try:
            blockers, items = self._collect_snapshot(job_id)
        except DatasetExportError as error:
            self._repo.update_job_status(job_id, "blocked", error_class=error.code)
            raise
        if blockers:
            self._repo.update_job_status(job_id, "blocked", error_class="preflight_blocked")
            return {"status": "blocked", "blockers": blockers}
        self._repo.replace_items(job_id, items)
        return self._repo.update_job_status(job_id, "ready")

    def _collect_snapshot(
        self, job_id: str
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """冻结快照并执行 §3.9 严格阻断检查；返回 (blockers, items)。"""
        job = self._require_job(job_id)
        snapshots = self._repo.list_source_snapshots(job_id)
        blockers: list[dict[str, Any]] = []
        items: list[dict[str, Any]] = []
        seen_output: set[str] = set()
        target_root = Path(job["target_path"])

        for snapshot in snapshots:
            source = self._gallery.get_source(snapshot["source_id"])
            if source is None:
                blockers.append(
                    {
                        "code": "source_not_found",
                        "source_id": snapshot["source_id"],
                        "detail": "来源不存在",
                    }
                )
                continue
            if source.get("availability") != "available":
                blockers.append(
                    {
                        "code": "source_offline",
                        "source_id": snapshot["source_id"],
                        "detail": "来源不可用",
                    }
                )
                continue
            if source.get("dedup_required") and source.get("dedup_state") != "applied":
                blockers.append(
                    {
                        "code": "export_snapshot_stale",
                        "source_id": snapshot["source_id"],
                        "detail": "来源去重未完成",
                    }
                )
                continue
            assets = self._list_assets_for_snapshot(snapshot)
            for asset in assets:
                rel = str(asset["relative_path"])
                if not is_safe_relative_path(rel):
                    blockers.append(
                        {
                            "code": "export_target_conflict",
                            "source_id": snapshot["source_id"],
                            "detail": f"来源相对路径不安全: {rel}",
                        }
                    )
                    continue
                output_rel = export_output_relative_path(
                    snapshot["output_alias"], rel
                )
                out_str = str(output_rel)
                if out_str in seen_output:
                    blockers.append(
                        {
                            "code": "export_target_conflict",
                            "source_id": snapshot["source_id"],
                            "detail": f"目标相对路径冲突: {out_str}",
                        }
                    )
                    continue
                # 目标合并冲突检查：正式目录中已存在同相对路径文件则阻断。
                final_path = target_root / output_rel
                if final_path.exists():
                    blockers.append(
                        {
                            "code": "export_target_conflict",
                            "source_id": snapshot["source_id"],
                            "detail": f"目标已有同名文件: {out_str}",
                        }
                    )
                    continue
                seen_output.add(out_str)
                txt_rel = asset.get("txt_relative_path")
                txt_state = asset.get("txt_state", "missing")
                has_txt = txt_state in {"normal", "blank"}
                # §3.9 严格阻断：同名 TXT 缺失/空白/解码异常一律阻止。
                if txt_state == "missing":
                    blockers.append(
                        {
                            "code": "txt_missing",
                            "source_id": snapshot["source_id"],
                            "detail": f"缺少同名 TXT: {rel}",
                        }
                    )
                    continue
                if txt_state == "blank":
                    blockers.append(
                        {
                            "code": "txt_empty",
                            "source_id": snapshot["source_id"],
                            "detail": f"同名 TXT 内容空白: {rel}",
                        }
                    )
                    continue
                if txt_state != "normal":
                    blockers.append(
                        {
                            "code": "txt_invalid_encoding",
                            "source_id": snapshot["source_id"],
                            "detail": f"TXT 读取或解码异常: {rel}",
                        }
                    )
                    continue
                items.append(
                    {
                        "asset_id": asset["asset_id"],
                        "source_id": snapshot["source_id"],
                        "output_relative_path": out_str,
                        "source_relative_path": rel,
                        "txt_output_relative_path": (
                            str(PurePosixPath(out_str).with_suffix(".txt"))
                            if txt_rel
                            else ""
                        ),
                        "txt_source_relative_path": str(txt_rel) if txt_rel else "",
                        "has_txt": has_txt,
                        "source_kind": source.get("kind", "imported"),
                        "image_format": asset.get("format") or "",
                        "image_width": int(asset.get("width") or 0),
                        "image_height": int(asset.get("height") or 0),
                        "expected_content_version": asset.get("content_version", 1),
                        "expected_txt_version": asset.get("annotation_version", 1),
                        "image_size_bytes": asset.get("size_bytes", 0),
                        "txt_size_bytes": asset.get("txt_size_bytes", 0),
                        "image_sha256": "",
                        "txt_sha256": "",
                    }
                )
        # 磁盘空间检查：粗粒度（源字节数 × 1.05）对比目标卷可用空间。
        total_bytes = sum(int(i.get("image_size_bytes", 0)) for i in items) + sum(
            int(i.get("txt_size_bytes", 0)) for i in items
        )
        try:
            free = shutil.disk_usage(target_root if target_root.exists() else target_root.parent).free
            if total_bytes > 0 and free < total_bytes * 1.05:
                blockers.append(
                    {
                        "code": "export_disk_space_insufficient",
                        "detail": "目标磁盘空间不足",
                    }
                )
        except OSError:
            blockers.append(
                {
                    "code": "export_disk_space_insufficient",
                    "detail": "无法检查目标磁盘空间",
                }
            )
        return blockers, items

    def _list_assets_for_snapshot(
        self, snapshot: Mapping[str, Any]
    ) -> list[dict[str, Any]]:
        """读取快照目录下的活跃资产（含可选子目录，排除 excluded）。"""
        assets: list[dict[str, Any]] = []
        asset_cursor: str | None = None
        while True:
            page = self._gallery.list_directory_entries(
                directory_id=snapshot["directory_id"],
                include_descendants=bool(snapshot["include_descendants"]),
                asset_cursor=asset_cursor,
                limit=200,
            )
            assets.extend(page.get("assets", []))
            asset_cursor = page.get("asset_cursor")
            if not asset_cursor:
                break
        return assets

    # ---- 查询（route 使用的公共读接口） ----

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        return self._repo.get_job(job_id)

    def list_jobs(
        self,
        *,
        status: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        return self._repo.list_jobs(status=status, limit=limit, offset=offset)

    def list_sources(self, job_id: str) -> list[dict[str, Any]]:
        return self._repo.list_source_snapshots(job_id)

    def list_blockers(self, job_id: str) -> dict[str, Any]:
        """返回最近一次预检产生的阻断清单（阻塞任务专用）。"""
        job = self._require_job(job_id)
        if job["status"] != "blocked":
            return {"job_id": job_id, "status": job["status"], "blockers": []}
        _, items = self._collect_snapshot(job_id)
        # blocked 时 items 为空（或部分）；重新收集 blockers。
        blockers, _ = self._collect_snapshot(job_id)
        del items
        return {"job_id": job_id, "status": job["status"], "blockers": blockers}

    # ---- 暂存与提交 ----

    def start(self, job_id: str) -> dict[str, Any]:
        """ready 任务进入后台 staging；幂等：已在跑的任务直接返回。"""
        job = self._require_job(job_id)
        if job["status"] in {"staging"}:
            return job
        if job["status"] not in {"ready", "paused", "failed"}:
            raise DatasetExportError(
                "export_state_invalid",
                "start requires ready/paused/failed state",
                detail={"status": job["status"]},
            )
        if job["status"] == "ready":
            self._repo.update_job_status(job_id, "staging")
        else:
            self._repo.update_job_status(job_id, "staging")
        thread = threading.Thread(
            target=self._run_staging, args=(job_id,), daemon=True, name=f"export-{job_id}"
        )
        with self._locks_guard:
            self._threads[job_id] = thread
        thread.start()
        return self._require_job(job_id)

    def pause(self, job_id: str) -> dict[str, Any]:
        """请求暂停：staging → paused（后台线程在下一个条目边界停止）。"""
        job = self._require_job(job_id)
        if job["status"] != "staging":
            raise DatasetExportError(
                "export_state_invalid",
                "pause requires staging state",
                detail={"status": job["status"]},
            )
        return self._repo.update_job_status(job_id, "paused")

    def resume(self, job_id: str) -> dict[str, Any]:
        """paused/failed → staging（继续暂存）。"""
        return self.start(job_id)

    def discard(self, job_id: str) -> dict[str, Any]:
        """丢弃暂存：删除 `<目标>/.imageweave/staging/<export-id>/` 并终结任务。"""
        job = self._require_job(job_id)
        if job["status"] not in {"draft", "preflighting", "blocked", "ready", "paused", "failed", "staged", "recovery_required"}:
            raise DatasetExportError(
                "export_state_invalid",
                "discard not allowed from current state",
                detail={"status": job["status"]},
            )
        staging_dir = (
            Path(job["target_path"]) / export_staging_relative_dir(job_id)
        )
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        return self._repo.update_job_status(job_id, "discarded")

    def _run_staging(self, job_id: str) -> None:
        """后台暂存循环：逐条复制 + hash 校验；完成后进入 staged。"""
        lock = self._job_lock(job_id)
        with lock:
            try:
                self._stage_items(job_id)
                self._commit_items(job_id)
            except DatasetExportError as error:
                self._mark_interrupted(job_id, error.code)
            except Exception as error:  # pragma: no cover - 引擎兜底
                self._mark_interrupted(
                    job_id, f"internal:{type(error).__name__}"
                )


    def _mark_interrupted(self, job_id: str, error_class: str) -> None:
        """把中断的任务落到状态机允许的终态。

        staging/preflight 阶段失败 → failed；
        committing 阶段中断（已完成部分写入）→ recovery_required，由恢复
        流程重放或显式丢弃暂存。
        """
        try:
            current = self._require_job(job_id)["status"]
        except DatasetExportError:
            return
        target = "recovery_required" if current == "committing" else "failed"
        try:
            self._repo.update_job_status(job_id, target, error_class=error_class)
        except ValueError:
            # 状态已被并发修改（如用户已丢弃）——保留其结果。
            pass

    def _stage_items(self, job_id: str) -> None:
        job = self._require_job(job_id)
        target_root = Path(job["target_path"])
        staging_root = target_root / export_staging_relative_dir(job_id)
        items = self._repo.list_items(job_id)
        done = 0
        for item in items:
            # 暂停边界：状态被外部改为 paused 时立即停止。
            current = self._require_job(job_id)
            if current["status"] == "paused":
                return
            if item["copy_state"] == "staged":
                done += 1
                continue
            source = self._gallery.get_source(item["source_id"])
            if source is None:
                raise DatasetExportError(
                    "source_not_found", "来源不存在", detail={"source_id": item["source_id"]}
                )
            source_root = Path(source["root_path"])
            image_source = source_root / item["source_relative_path"]
            image_target = staging_root / item["output_relative_path"]
            _copy_file(image_source, image_target)
            image_hash = _sha256_file(image_target)
            txt_hash = ""
            if item["has_txt"] and item["txt_source_relative_path"]:
                txt_source = source_root / item["txt_source_relative_path"]
                txt_target = staging_root / item["txt_output_relative_path"]
                _copy_file(txt_source, txt_target)
                txt_hash = _sha256_file(txt_target)
                # 暂存后再次校验严格 UTF-8 可解码（§3.9）。
                _decode_txt_strict(txt_target)
            self._repo.set_item_copy_state(
                job_id,
                item["asset_id"],
                "staged",
                image_sha256=image_hash,
                txt_sha256=txt_hash,
            )
            done += 1
            self._repo.set_job_progress(
                job_id,
                sample_count=done,
                image_bytes=0,
                txt_bytes=0,
            )
        self._repo.update_job_status(job_id, "staged")

    def _commit_items(self, job_id: str) -> None:
        """提交：暂存文件移入正式目录 + 写独立 manifest（§3.9）。"""
        job = self._require_job(job_id)
        if job["status"] != "staged":
            return
        self._repo.update_job_status(job_id, "committing")
        target_root = Path(job["target_path"])
        staging_root = target_root / export_staging_relative_dir(job_id)
        items = self._repo.list_items(job_id)
        # 全部样本验证通过才能提交：staged 状态本身即全部验证完成的证明。
        for item in items:
            if item["copy_state"] != "staged":
                raise DatasetExportError(
                    "export_state_invalid",
                    "存在未验证完成的样本",
                    detail={"asset_id": item["asset_id"]},
                )
        for item in items:
            image_staged = staging_root / item["output_relative_path"]
            image_final = target_root / item["output_relative_path"]
            if image_final.exists():
                raise DatasetExportError(
                    "export_target_conflict",
                    "目标已有同名文件",
                    detail={"relative_path": item["output_relative_path"]},
                )
            image_final.parent.mkdir(parents=True, exist_ok=True)
            os.replace(image_staged, image_final)
            txt_rel = item["txt_output_relative_path"]
            if txt_rel:
                txt_staged = staging_root / txt_rel
                txt_final = target_root / txt_rel
                if txt_final.exists():
                    raise DatasetExportError(
                        "export_target_conflict",
                        "目标已有同名 TXT",
                        detail={"relative_path": txt_rel},
                    )
                txt_final.parent.mkdir(parents=True, exist_ok=True)
                os.replace(txt_staged, txt_final)
            self._repo.set_item_copy_state(job_id, item["asset_id"], "committed")
        # 写独立 manifest（任务级，不重写全目录总清单）。
        manifest_rel = export_manifest_relative_path(job_id)
        manifest_path = target_root / manifest_rel
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        completed_at = self._clock()
        task_record = build_export_manifest_task_record(
            export_id=job_id,
            created_at=float(job["created_at"]),
            completed_at=completed_at,
            sources=self._manifest_sources(job_id),
            sample_count=len(items),
            image_bytes=job["image_bytes"],
            txt_bytes=job["txt_bytes"],
            snapshot_digest=job["snapshot_digest"],
        )
        sample_records = [
            build_export_manifest_sample_record(
                image_path=item["output_relative_path"],
                txt_path=item["txt_output_relative_path"],
                image_format=item.get("image_format", ""),
                image_width=int(item.get("image_width", 0)),
                image_height=int(item.get("image_height", 0)),
                image_bytes=item["image_size_bytes"],
                image_sha256=item["image_sha256"],
                txt_bytes=item["txt_size_bytes"],
                txt_sha256=item["txt_sha256"],
                source_kind=item.get("source_kind", "imported"),
                source_id=item["source_id"],
                source_relative_path=item["source_relative_path"],
            )
            for item in items
        ]
        manifest_path.write_text(
            serialize_export_manifest(task_record, sample_records),
            encoding="utf-8",
        )
        # 提交完成后清理暂存目录残留（已全部移入正式目录）。
        if staging_root.exists():
            shutil.rmtree(staging_root, ignore_errors=True)
        self._repo.update_job_status(job_id, "completed")

    # ---- 恢复 ----

    def recover_unfinished(self) -> list[str]:
        """启动恢复：把 committing 中断的任务推进到 recovery_required。"""
        recovered: list[str] = []
        for job in self._repo.list_jobs(status="committing", limit=200):
            self._repo.update_job_status(job["job_id"], "recovery_required")
            recovered.append(job["job_id"])
        for job in self._repo.list_jobs(status="staging", limit=200):
            self._repo.update_job_status(job["job_id"], "paused")
            recovered.append(job["job_id"])
        return recovered

    def retry_recovery(self, job_id: str) -> dict[str, Any]:
        """recovery_required → 重放提交（完成或回到 staged）。"""
        job = self._require_job(job_id)
        if job["status"] != "recovery_required":
            raise DatasetExportError(
                "export_state_invalid",
                "retry requires recovery_required state",
                detail={"status": job["status"]},
            )
        self._repo.update_job_status(job_id, "committing")
        try:
            self._commit_items(job_id)
        except DatasetExportError:
            self._repo.update_job_status(job_id, "staged")
            raise
        return self._require_job(job_id)

    # ---- 内部助手 ----

    def _require_job(self, job_id: str) -> dict[str, Any]:
        job = self._repo.get_job(job_id)
        if job is None:
            raise DatasetExportError("export_not_found", "导出任务不存在")
        return job

    def _manifest_sources(self, job_id: str) -> list[dict[str, Any]]:
        """来源快照投影 + source_kind（manifest 任务记录需要）。"""
        merged: list[dict[str, Any]] = []
        for snapshot in self._repo.list_source_snapshots(job_id):
            entry = dict(snapshot)
            source = self._gallery.get_source(snapshot["source_id"])
            entry["source_kind"] = (source or {}).get("kind", "imported")
            merged.append(entry)
        return merged

    def stop(self) -> None:
        """容器关闭时等待后台线程退出（不主动中断任务）。"""
        with self._locks_guard:
            threads = list(self._threads.values())
        for thread in threads:
            if thread.is_alive():
                thread.join(timeout=5.0)
