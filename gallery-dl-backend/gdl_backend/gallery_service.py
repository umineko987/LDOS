"""图库目录服务：来源生命周期、递归扫描与异步扫描任务（§3.1–§3.3、§6.1）。

`GalleryCatalogService` 组合 `GalleryRepository` 与磁盘扫描器。扫描遵守
G0 合同：跳过符号链接、`.imageweave` 保留区与临时下载文件；只索引
受支持扩展名；TXT 只接受严格 UTF-8（允许 BOM 读取）；图片元数据经
Pillow 有界探测，失败进入固定 error_code，不外泄原始异常文本。
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Sequence

from PIL import Image, UnidentifiedImageError

from ._database_gallery_repository import (
    GalleryRepository,
    GallerySourceConflictError,
    GalleryVersionConflict,
)
from .gallery_catalog import (
    IMAGEWEAVE_RESERVED_DIR,
    IMAGEWEAVE_TEMP_DIRECTORY_PREFIXES,
    classify_txt_state,
    decode_txt_bytes,
    is_supported_image_name,
    txt_name_for_image,
)
from .gallery_safe_paths import (
    GalleryFilesystemLocks,
    SafeSourceRoot,
    UnsafeSourcePathError,
)


class GallerySourceNotFound(Exception):
    def __init__(self, source_id: str) -> None:
        super().__init__(f"gallery_source_not_found:{source_id}")
        self.source_id = source_id


class GalleryScanInProgress(Exception):
    def __init__(self, source_id: str) -> None:
        super().__init__(f"gallery_scan_in_progress:{source_id}")
        self.source_id = source_id


class GalleryRootMissing(Exception):
    """导入或重关联指定的来源根目录不存在（source_path_not_found）。"""


class GalleryAssetNotFound(Exception):
    def __init__(self, asset_id: str) -> None:
        super().__init__(f"gallery_asset_not_found:{asset_id}")
        self.asset_id = asset_id



class GalleryAssetFileError(Exception):
    def __init__(self, code: str, asset_id: str) -> None:
        super().__init__(code)
        self.code = code
        self.asset_id = asset_id

class GallerySourceOffline(Exception):
    """来源当前不可用（source_offline），写操作被拒绝。"""

    def __init__(self, source_id: str) -> None:
        super().__init__(f"gallery_source_offline:{source_id}")
        self.source_id = source_id


class GalleryAnnotationError(Exception):
    """TXT 写路径失败（txt_write_failed / txt_target_not_regular_file）。"""

    def __init__(self, code: str, txt_relative_path: str) -> None:
        super().__init__(code)
        self.code = code
        self.txt_relative_path = txt_relative_path


SCAN_STATES: frozenset[str] = frozenset(
    {"idle", "running", "succeeded", "failed"}
)

_TEMP_FILE_SUFFIXES: tuple[str, ...] = (".part", ".tmp", ".crdownload")
_TXT_READ_MAX_BYTES = 8 * 1024 * 1024
_PROBE_ERROR_CODES: frozenset[str] = frozenset(
    {"decode_failed", "truncated", "unidentified", "probe_error"}
)


_DEDUP_REVIEW_PENDING_STATES = frozenset({"pending", "ready"})


def _effective_dedup_state(
    source: dict[str, Any], review_status: str | None
) -> str:
    """有效去重状态（§3.8）：存储状态 + 审核状态 + 内容版本推导。

    - not_required：来源未启用去重；
    - applied：审核已应用且内容版本未再变化；
    - stale：审核已应用但图库内容版本已前进（需重新分析）；
    - review_pending：审核已就绪等待人工决策；
    - pending_analysis：等待去重分析。
    """
    stored = str(source["dedup_state"])
    if not source["dedup_required"]:
        return "not_required"
    if stored == "applied":
        applied_version = int(source.get("dedup_applied_version", 0))
        content_version = int(source["content_version"])
        if applied_version < content_version:
            return "stale"
        return "applied"
    if review_status in _DEDUP_REVIEW_PENDING_STATES:
        return "review_pending"
    if review_status == "applied":
        # 审核已应用但图库侧提交尚未落库（应用钩子失败）。
        return "pending_analysis"
    return "pending_analysis"


def _public_source(
    source: dict[str, Any],
    *,
    asset_count: int | None = None,
    root_directory_id: str | None = None,
    review_status: str | None = None,
) -> dict[str, Any]:
    """公开来源投影：剥离 root_path 与 canonical_root_key（§6.4）。

    root_directory_id 是进入来源首页所需的稳定目录 ID；首次扫描前为 None。
    """
    projected = {
        "source_id": source["source_id"],
        "root_directory_id": root_directory_id,
        "kind": source["kind"],
        "batch_id": source["batch_id"],
        "display_name": source["display_name"],
        "availability": source["availability"],
        "crawl_complete": source["crawl_complete"],
        "dedup_required": source["dedup_required"],
        "dedup_state": _effective_dedup_state(source, review_status),
        "dedup_applied_version": source.get("dedup_applied_version", 0),
        "content_version": source["content_version"],
        "annotation_version": source["annotation_version"],
        "indexed_version": source["indexed_version"],
        "last_scanned_at": source["last_scanned_at"],
        "created_at": source["created_at"],
        "updated_at": source["updated_at"],
    }
    if asset_count is not None:
        projected["asset_count"] = asset_count
    return projected


class GalleryCatalogService:
    def __init__(
        self,
        repository: GalleryRepository,
        *,
        clock=time.time,
        filesystem_locks: GalleryFilesystemLocks | None = None,
    ) -> None:
        self._repo = repository
        self._clock = clock
        self._filesystem_locks = filesystem_locks or GalleryFilesystemLocks()
        self._scan_jobs: dict[str, dict[str, Any]] = {}
        self._scan_lock = threading.Lock()
        self._scan_threads: dict[str, threading.Thread] = {}
        # 审核状态查询回调（由容器注入，避免服务层直接依赖审核仓储）。
        self._review_status_lookup: Callable[[str], str | None] | None = None

    def set_review_status_lookup(
        self, lookup: Callable[[str], str | None]
    ) -> None:
        self._review_status_lookup = lookup

    def _review_status(self, source: dict[str, Any]) -> str | None:
        batch_id = source.get("batch_id")
        if not batch_id or self._review_status_lookup is None:
            return None
        return self._review_status_lookup(batch_id)

    # ---- 来源生命周期（§3.1） ----

    def import_source(
        self, root_path: str, *, display_name: str | None = None
    ) -> dict[str, Any]:
        root = Path(root_path).expanduser()
        if not root.is_dir() or root.is_symlink():
            raise GalleryRootMissing(str(root))
        name = display_name or root.name or str(root)
        try:
            source = self._repo.register_source(
                kind="imported", root_path=str(root.resolve()), display_name=name
            )
        except GallerySourceConflictError as conflict:
            raise conflict
        return _public_source(
            source,
            asset_count=0,
            review_status=self._review_status(source),
        )

    def register_batch_source(
        self,
        *,
        batch_id: str,
        root_path: str,
        display_name: str,
        dedup_required: bool,
    ) -> dict[str, Any]:
        try:
            source = self._repo.register_source(
                kind="crawl_batch",
                root_path=root_path,
                display_name=display_name,
                batch_id=batch_id,
                dedup_required=dedup_required,
            )
        except GallerySourceConflictError as conflict:
            raise conflict
        return _public_source(source, asset_count=0)


    def on_review_applied(
        self,
        batch_id: str,
        *,
        excluded_asset_ids: Sequence[str] | None = None,
    ) -> dict[str, Any] | None:
        """去重审核应用后的图库侧提交（§3.8）。

        原子地把被排除资产标记为 excluded、目录计数/封面立即修正、
        来源 dedup_state='applied' 并记录 dedup_applied_version。
        调用方（review apply 路由）负责在审核事务成功后调用；
        本方法失败不影响审核结果本身。
        """
        source = self._repo.get_source_by_batch_id(batch_id)
        if source is None:
            return None
        ids = list(excluded_asset_ids or [])
        self._repo.apply_review_result(source["source_id"], excluded_asset_ids=ids)
        updated = self._repo.get_source(source["source_id"])
        assert updated is not None
        # 后台触发一次增量扫描，使 physical 布局与索引对齐。
        self.start_scan(source["source_id"])
        return _public_source(
            updated,
            asset_count=self._repo.count_source_assets(source["source_id"]),
            review_status="applied",
        )
    def auto_register_batch_source(
        self,
        *,
        batch_id: str,
        root_path: str,
        display_name: str,
        dedup_required: bool,
    ) -> dict[str, Any] | None:
        """批次终态后的自动注册（§4 来源生命周期）。

        幂等：同批次已注册时直接返回 None；
        冲突或根目录缺失时静默跳过（不打断爬取收尾），由启动对账重试。
        """
        if self._repo.get_source_by_batch_id(batch_id) is not None:
            return None
        root = Path(root_path).expanduser()
        if not root.is_dir() or root.is_symlink():
            return None
        try:
            source = self.register_batch_source(
                batch_id=batch_id,
                root_path=str(root.resolve()),
                display_name=display_name,
                dedup_required=dedup_required,
            )
        except GallerySourceConflictError:
            return None
        self.start_scan(source["source_id"])
        return source

    def update_source(self, source_id: str, *, display_name: str) -> dict[str, Any]:
        source = self._repo.get_source(source_id)
        if source is None:
            raise GallerySourceNotFound(source_id)
        if not display_name or not display_name.strip():
            raise ValueError("invalid_gallery_source_display_name")
        # 显示名只改元数据：经 repository 的唯一写入口。
        self._repo.rename_source(source_id, display_name.strip())
        updated = self._repo.get_source(source_id)
        assert updated is not None
        return _public_source(
            updated,
            asset_count=self._repo.count_source_assets(source_id),
            review_status=self._review_status(updated),
        )

    def unregister_source(self, source_id: str) -> None:
        source = self._repo.get_source(source_id)
        if source is None:
            raise GallerySourceNotFound(source_id)
        with self._scan_lock:
            job = self._scan_jobs.get(source_id)
            if job is not None and job["state"] == "running":
                raise GalleryScanInProgress(source_id)
        self._repo.unregister_source(source_id)

    def relink_source(self, source_id: str, new_root_path: str) -> dict[str, Any]:
        source = self._repo.get_source(source_id)
        if source is None:
            raise GallerySourceNotFound(source_id)
        root = Path(new_root_path).expanduser()
        if not root.exists():
            raise GalleryRootMissing(str(root))
        if not root.is_dir() or root.is_symlink():
            raise GalleryRootMissing(str(root))
        try:
            updated = self._repo.relink_source(source_id, str(root.resolve()))
        except GallerySourceConflictError as conflict:
            raise conflict
        return _public_source(
            updated,
            asset_count=self._repo.count_source_assets(source_id),
            review_status=self._review_status(updated),
        )

    def get_source(self, source_id: str) -> dict[str, Any]:
        source = self._repo.get_source(source_id)
        if source is None:
            raise GallerySourceNotFound(source_id)
        return _public_source(
            source,
            asset_count=self._repo.count_source_assets(source_id),
            root_directory_id=self._root_directory_id(source_id),
            review_status=self._review_status(source),
        )

    def list_sources(self) -> list[dict[str, Any]]:
        return [
            _public_source(
                source,
                asset_count=self._repo.count_source_assets(source["source_id"]),
                root_directory_id=self._root_directory_id(source["source_id"]),
                review_status=self._review_status(source),
            )
            for source in self._repo.list_sources()
        ]

    def _root_directory_id(self, source_id: str) -> str | None:
        root = self._repo.get_root_directory(source_id)
        return root["directory_id"] if root is not None else None

    def resolve_source_root(self, source_id: str) -> Path:
        """仅供媒体端点使用的内部路径解析（不进入公开投影）。"""
        source = self._repo.get_source(source_id)
        if source is None:
            raise GallerySourceNotFound(source_id)
        return Path(source["root_path"])


    def open_asset_content(self, asset_id: str) -> dict[str, Any]:
        asset = self._repo.get_asset(asset_id)
        if asset is None:
            raise GalleryAssetNotFound(asset_id)
        source = self._repo.get_source(asset["source_id"])
        if source is None:
            raise GallerySourceNotFound(asset["source_id"])
        try:
            with SafeSourceRoot(source["root_path"]) as safe_root:
                handle = safe_root.open_binary(asset["relative_path"])
        except UnsafeSourcePathError as error:
            code = "asset_file_missing" if error.reason == "file_missing" else "unsafe_source_path"
            raise GalleryAssetFileError(code, asset_id) from error
        metadata = os.fstat(handle.fileno())
        return {
            "handle": handle,
            "extension": asset["extension"].lower(),
            "modified_ns": int(metadata.st_mtime_ns),
            "size_bytes": int(metadata.st_size),
        }

    # ---- TXT 注解保存（§3.4/§7.2；G3-1） ----

    def get_annotation(self, asset_id: str) -> dict[str, Any]:
        asset = self._repo.get_asset(asset_id)
        if asset is None:
            raise GalleryAssetNotFound(asset_id)
        source = self._repo.get_source(asset["source_id"])
        if source is None:
            raise GallerySourceNotFound(asset["source_id"])
        if source["availability"] != "available":
            raise GallerySourceOffline(asset["source_id"])
        txt_relative = (
            asset["txt_relative_path"]
            if asset["txt_relative_path"]
            else _txt_relative_for_image(asset["relative_path"])
        )
        lock_keys = (f"source:{asset['source_id']}", f"asset:{asset_id}")
        with self._filesystem_locks.hold(*lock_keys):
            try:
                with SafeSourceRoot(source["root_path"]) as safe_root:
                    try:
                        payload, disk_version = safe_root.read_with_disk_version(
                            txt_relative,
                            allow_missing=True,
                            max_bytes=_TXT_READ_MAX_BYTES,
                        )
                    except UnsafeSourcePathError as error:
                        if error.reason != "file_too_large":
                            raise
                        payload = None
                        disk_version = safe_root.disk_version(txt_relative)
                        txt_state = "io_error"
                    else:
                        txt_state = classify_txt_state(
                            exists=payload is not None,
                            data=payload,
                            pair_conflict=asset["txt_state"] == "pair_conflict",
                        )
            except UnsafeSourcePathError as error:
                raise GalleryAnnotationError("unsafe_source_path", txt_relative) from error
        content: str | None = None
        if payload is not None and txt_state not in {"invalid_encoding", "io_error", "pair_conflict"}:
            decoded, text = decode_txt_bytes(payload)
            content = text if decoded else None
        return {
            "asset_id": asset_id,
            "txt_state": txt_state,
            "txt_version": int(asset["txt_version"]),
            "disk_version": disk_version,
            "content": content,
        }

    def save_annotation(
        self,
        asset_id: str,
        content: str,
        *,
        expected_txt_version: int,
        expected_disk_version: str,
    ) -> dict[str, Any]:
        """Save strict UTF-8 TXT after checking both DB and on-disk versions.

        The process-local asset/source lock serializes Gallery mutations.  The
        disk version is recomputed from a descriptor-anchored read immediately
        before replacement.  If the SQLite update fails, the prior bytes are
        restored only while the just-written version still owns the path.
        """
        initial = self._repo.get_asset(asset_id)
        if initial is None:
            raise GalleryAssetNotFound(asset_id)
        lock_keys = (f"source:{initial['source_id']}", f"asset:{asset_id}")
        with self._filesystem_locks.hold(*lock_keys):
            asset = self._repo.get_asset(asset_id)
            if asset is None:
                raise GalleryAssetNotFound(asset_id)
            if asset["lifecycle_state"] != "active":
                raise GalleryVersionConflict(
                    "asset_not_active", {"asset_id": asset_id}
                )
            if int(asset["txt_version"]) != expected_txt_version:
                raise GalleryVersionConflict(
                    "txt_version_conflict",
                    {
                        "asset_id": asset_id,
                        "expected": expected_txt_version,
                        "actual": int(asset["txt_version"]),
                    },
                )
            if asset["txt_state"] == "pair_conflict":
                raise GalleryAnnotationError(
                    "txt_pair_conflict", str(asset["txt_relative_path"] or "")
                )
            source = self._repo.get_source(asset["source_id"])
            if source is None:
                raise GallerySourceNotFound(asset["source_id"])
            if source["availability"] != "available":
                raise GallerySourceOffline(asset["source_id"])
            txt_relative = (
                asset["txt_relative_path"]
                if asset["txt_relative_path"]
                else _txt_relative_for_image(asset["relative_path"])
            )
            data = content.encode("utf-8", errors="strict")
            try:
                with SafeSourceRoot(source["root_path"]) as safe_root:
                    previous_payload, actual_disk_version = safe_root.read_with_disk_version(
                        txt_relative, allow_missing=True
                    )
                    if actual_disk_version != expected_disk_version:
                        raise GalleryVersionConflict(
                            "txt_disk_conflict",
                            {
                                "asset_id": asset_id,
                                "expected": expected_disk_version,
                                "actual": actual_disk_version,
                            },
                        )
                    metadata, written_disk_version = safe_root.atomic_write_bytes(
                        txt_relative,
                        data,
                        expected_disk_version=actual_disk_version,
                    )
                    new_state = classify_txt_state(
                        exists=True, read_ok=True, data=data
                    )
                    try:
                        updated = self._repo.update_annotation(
                            asset_id,
                            expected_txt_version=expected_txt_version,
                            txt_state=new_state,
                            txt_size_bytes=metadata.size,
                            txt_modified_ns=metadata.modified_ns,
                            txt_sha256="",
                            txt_relative_path=txt_relative,
                            txt_content=content,
                        )
                    except Exception:
                        try:
                            if previous_payload is None:
                                safe_root.unlink_if_version(
                                    txt_relative,
                                    expected_disk_version=written_disk_version,
                                )
                            else:
                                safe_root.atomic_write_bytes(
                                    txt_relative,
                                    previous_payload,
                                    expected_disk_version=written_disk_version,
                                )
                        except Exception as rollback_error:
                            raise GalleryAnnotationError(
                                "txt_index_inconsistent", txt_relative
                            ) from rollback_error
                        raise
            except GalleryVersionConflict:
                raise
            except GalleryAnnotationError:
                raise
            except UnsafeSourcePathError as error:
                if error.reason == "disk_version_conflict":
                    raise GalleryVersionConflict(
                        "txt_disk_conflict", {"asset_id": asset_id}
                    ) from error
                raise GalleryAnnotationError(
                    "unsafe_source_path", txt_relative
                ) from error
            except OSError as error:
                raise GalleryAnnotationError("txt_write_failed", txt_relative) from error
        return {
            "asset_id": asset_id,
            "txt_state": updated["txt_state"],
            "txt_version": updated["txt_version"],
            "disk_version": written_disk_version,
            "content": content,
        }

    # ---- 扫描（§6.1） ----

    def start_scan(self, source_id: str) -> dict[str, Any]:
        source = self._repo.get_source(source_id)
        if source is None:
            raise GallerySourceNotFound(source_id)
        with self._scan_lock:
            job = self._scan_jobs.get(source_id)
            if job is not None and job["state"] == "running":
                raise GalleryScanInProgress(source_id)
            record = {
                "source_id": source_id,
                "state": "running",
                "started_at": self._clock(),
                "finished_at": None,
                "error_code": "",
                "stats": None,
            }
            self._scan_jobs[source_id] = record
        thread = threading.Thread(
            target=self._run_scan,
            args=(source_id,),
            name=f"gallery-scan-{source_id[:8]}",
            daemon=True,
        )
        with self._scan_lock:
            self._scan_threads[source_id] = thread
        thread.start()
        return self.get_scan(source_id)

    def stop(self, timeout: float = 30.0) -> None:
        """等待所有运行中的扫描线程结束（应用关停前调用，避免写已关闭的库）。"""
        with self._scan_lock:
            threads = list(self._scan_threads.values())
        for thread in threads:
            thread.join(timeout=timeout)

    def get_scan(self, source_id: str) -> dict[str, Any]:
        source = self._repo.get_source(source_id)
        if source is None:
            raise GallerySourceNotFound(source_id)
        with self._scan_lock:
            job = self._scan_jobs.get(source_id)
            if job is None:
                return {
                    "source_id": source_id,
                    "state": "idle",
                    "started_at": None,
                    "finished_at": None,
                    "error_code": "",
                    "stats": None,
                }
            return dict(job)

    def _run_scan(self, source_id: str) -> None:
        try:
            stats = self.scan_source(source_id)
            with self._scan_lock:
                job = self._scan_jobs.get(source_id)
                if job is not None:
                    job["state"] = "succeeded"
                    job["finished_at"] = self._clock()
                    job["stats"] = stats
        except Exception as exc:  # 固定错误码，不含原始异常路径。
            code = "scan_failed"
            if isinstance(exc, GallerySourceNotFound):
                code = "source_not_found"
            elif isinstance(exc, GalleryRootMissing):
                code = "source_offline"
            elif isinstance(exc, (OSError, PermissionError)):
                code = "io_error"
            with self._scan_lock:
                job = self._scan_jobs.get(source_id)
                if job is not None:
                    job["state"] = "failed"
                    job["finished_at"] = self._clock()
                    job["error_code"] = code
        finally:
            with self._scan_lock:
                job = self._scan_jobs.get(source_id)
                if job is not None and job["state"] == "running":
                    job["state"] = "failed"
                    job["error_code"] = "scan_interrupted"

    def scan_source(self, source_id: str) -> dict[str, Any]:
        """同步全量扫描：walk + 有界解码 + 单事务提交。"""
        source = self._repo.get_source(source_id)
        if source is None:
            raise GallerySourceNotFound(source_id)
        root = Path(source["root_path"])
        try:
            safe_root = SafeSourceRoot(root)
            safe_root.open()
        except UnsafeSourcePathError:
            # Offline/unsafe sources keep their previous index intact.
            self._repo.set_source_availability(source_id, "offline")
            return {"asset_count": 0, "directory_count": 0, "offline": True}
        self._repo.set_source_availability(source_id, "available")

        existing = self._repo.get_source_asset_stats(source_id)
        directories: list[dict[str, Any]] = []
        assets: list[dict[str, Any]] = []
        skipped = {"temporary": 0, "unsupported": 0}
        try:
            for directory in safe_root.iter_tree(
                excluded_directories=frozenset({IMAGEWEAVE_RESERVED_DIR}),
                excluded_directory_prefixes=IMAGEWEAVE_TEMP_DIRECTORY_PREFIXES,
            ):
                relative_path = directory.relative_path
                directories.append(
                    {
                        "relative_path": relative_path,
                        "name": directory.name,
                        "parent_relative_path": (
                            relative_path.rpartition("/")[0] if relative_path else None
                        ),
                    }
                )
                image_names: list[str] = []
                file_entries: list[tuple[str, os.stat_result]] = []
                for file_name, file_stat in directory.files:
                    if is_supported_image_name(file_name):
                        image_names.append(file_name)
                        file_entries.append((file_name, file_stat))
                    elif file_name.lower().endswith(_TEMP_FILE_SUFFIXES):
                        skipped["temporary"] += 1
                    else:
                        skipped["unsupported"] += 1
                conflicts = _pair_conflicts(image_names)
                for file_name, file_stat in file_entries:
                    assets.append(
                        self._asset_record(
                            safe_root,
                            relative_path,
                            file_name,
                            file_stat,
                            existing,
                            pair_conflict=file_name in conflicts,
                        )
                    )
        finally:
            safe_root.close()
        commit = self._repo.commit_scan(source_id, directories=directories, assets=assets)
        return {
            "asset_count": commit["asset_count"],
            "directory_count": commit["directory_count"],
            "content_changed": commit["content_changed"],
            "annotation_changed": commit["annotation_changed"],
            "indexed_version": commit["indexed_version"],
            "offline": False,
            **{"skipped_" + key: value for key, value in skipped.items()},
        }

    def _asset_record(
        self,
        safe_root: SafeSourceRoot,
        directory_relative: str,
        name: str,
        stat: os.stat_result,
        existing: dict[str, dict[str, Any]],
        *,
        pair_conflict: bool,
    ) -> dict[str, Any]:
        relative_path = f"{directory_relative}/{name}" if directory_relative else name
        txt_name = txt_name_for_image(name)
        txt_relative = (
            f"{directory_relative}/{txt_name}" if directory_relative else txt_name
        )
        txt_size = 0
        txt_modified_ns = 0
        txt_state = "missing"
        txt_content = ""
        try:
            with safe_root.open_binary(txt_relative) as handle:
                txt_stat = os.fstat(handle.fileno())
                txt_size = int(txt_stat.st_size)
                txt_modified_ns = int(txt_stat.st_mtime_ns)
                if txt_size > _TXT_READ_MAX_BYTES:
                    txt_state = classify_txt_state(exists=True, read_ok=False)
                else:
                    data = handle.read(_TXT_READ_MAX_BYTES + 1)
                    txt_state = classify_txt_state(
                        exists=True, data=data, pair_conflict=pair_conflict
                    )
                    if txt_state == "normal":
                        ok, text = _decode_txt(data)
                        txt_content = text if ok else ""
        except UnsafeSourcePathError as error:
            if error.reason == "file_missing":
                txt_state = classify_txt_state(
                    exists=False, pair_conflict=pair_conflict
                )
            elif error.reason == "file_unavailable":
                txt_state = classify_txt_state(exists=True, read_ok=False)
            else:
                raise

        previous = existing.get(relative_path)
        if (
            previous is not None
            and int(previous["size_bytes"]) == stat.st_size
            and int(previous["modified_ns"]) == stat.st_mtime_ns
        ):
            format_name = previous["format"]
            width = previous["width"]
            height = previous["height"]
            read_state = previous["read_state"]
            error_code = previous["error_code"]
        else:
            format_name, width, height, read_state, error_code = _probe_image(
                safe_root, relative_path
            )
        return {
            "relative_path": relative_path,
            "name": name,
            "extension": name[name.rfind(".") :].lower(),
            "size_bytes": stat.st_size,
            "modified_ns": stat.st_mtime_ns,
            "format": format_name,
            "width": width,
            "height": height,
            "read_state": read_state,
            "error_code": error_code,
            "txt_relative_path": txt_relative,
            "txt_size_bytes": txt_size,
            "txt_modified_ns": txt_modified_ns,
            "txt_state": txt_state,
            "txt_content": txt_content,
        }



def _txt_relative_for_image(image_relative_path: str) -> str:
    """按同名规则推导 TXT 相对路径（§3.4：foo.jpg → foo.txt）。"""
    parts = image_relative_path.rsplit("/", 1)
    directory = parts[0] + "/" if len(parts) == 2 else ""
    return f"{directory}{txt_name_for_image(parts[-1])}"

def _decode_txt(data: bytes) -> tuple[bool, str]:
    return decode_txt_bytes(data)



def _pair_conflicts(image_names: list[str]) -> set[str]:
    by_txt: dict[str, list[str]] = {}
    for name in image_names:
        by_txt.setdefault(txt_name_for_image(name).casefold(), []).append(name)
    conflicts: set[str] = set()
    for names in by_txt.values():
        if len(names) > 1:
            conflicts.update(names)
    return conflicts


def _probe_image(
    safe_root: SafeSourceRoot, relative_path: str
) -> tuple[str, int, int, str, str]:
    """Probe metadata from a no-follow descriptor without decoding full pixels."""
    try:
        with safe_root.open_binary(relative_path) as handle:
            with Image.open(handle) as image:
                format_name = str(image.format or "")
                width, height = image.size
                return format_name, int(width), int(height), "ok", ""
    except UnidentifiedImageError:
        return "", 0, 0, "failed", "unidentified"
    except UnsafeSourcePathError:
        raise
    except OSError:
        return "", 0, 0, "failed", "decode_failed"
    except Exception:
        return "", 0, 0, "failed", "probe_error"
