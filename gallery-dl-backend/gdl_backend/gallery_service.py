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
from typing import Any

from PIL import Image, UnidentifiedImageError

from ._database_gallery_repository import (
    GalleryRepository,
    GallerySourceConflictError,
    GalleryVersionConflict,
)
from .gallery_catalog import (
    classify_txt_state,
    decode_txt_bytes,
    is_supported_image_name,
    txt_name_for_image,
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


def _public_source(
    source: dict[str, Any],
    *,
    asset_count: int | None = None,
    root_directory_id: str | None = None,
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
        "dedup_state": source["dedup_state"],
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
    def __init__(self, repository: GalleryRepository, *, clock=time.time) -> None:
        self._repo = repository
        self._clock = clock
        self._scan_jobs: dict[str, dict[str, Any]] = {}
        self._scan_lock = threading.Lock()
        self._scan_threads: dict[str, threading.Thread] = {}

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
        return _public_source(source, asset_count=0)

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
        return _public_source(updated, asset_count=self._repo.count_source_assets(source_id))

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
            updated, asset_count=self._repo.count_source_assets(source_id)
        )

    def get_source(self, source_id: str) -> dict[str, Any]:
        source = self._repo.get_source(source_id)
        if source is None:
            raise GallerySourceNotFound(source_id)
        return _public_source(
            source,
            asset_count=self._repo.count_source_assets(source_id),
            root_directory_id=self._root_directory_id(source_id),
        )

    def list_sources(self) -> list[dict[str, Any]]:
        return [
            _public_source(
                source,
                asset_count=self._repo.count_source_assets(source["source_id"]),
                root_directory_id=self._root_directory_id(source["source_id"]),
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


    # ---- TXT 注解保存（§3.4/§7.2；G3-1） ----

    def save_annotation(
        self,
        asset_id: str,
        content: str,
        *,
        expected_txt_version: int,
    ) -> dict[str, Any]:
        """严格 UTF-8（无 BOM）原子写 TXT，并推进索引版本。

        - expected_txt_version 与当前索引不一致时抛 GalleryVersionConflict
          （txt_version_conflict），磁盘不被触碰，前端草稿得以保留；
        - 磁盘写通过临时文件 + os.replace 原子完成；
        - 成功后 txt_version +1、来源 annotation_version +1、FTS 同步。
        """
        asset = self._repo.get_asset(asset_id)
        if asset is None:
            raise GalleryAssetNotFound(asset_id)
        if asset["lifecycle_state"] != "active":
            raise GalleryVersionConflict(
                "asset_not_active", {"asset_id": asset_id},
            )
        if int(asset["txt_version"]) != expected_txt_version:
            raise GalleryVersionConflict(
                "txt_version_conflict",
                {"asset_id": asset_id, "expected": expected_txt_version,
                 "actual": int(asset["txt_version"])},
            )
        source = self._repo.get_source(asset["source_id"])
        if source is None:
            raise GallerySourceNotFound(asset["source_id"])
        if source["availability"] != "available":
            raise GallerySourceOffline(asset["source_id"])
        root = Path(source["root_path"])

        # 目标 TXT：已有配对路径优先；缺失时按同名规则创建。
        if asset["txt_relative_path"] and asset["txt_state"] not in {"missing", "pair_conflict"}:
            txt_relative = asset["txt_relative_path"]
        else:
            txt_relative = _txt_relative_for_image(asset["relative_path"])
        txt_path = root / txt_relative
        if txt_path.is_symlink():
            raise GalleryAnnotationError(
                "txt_target_not_regular_file", txt_relative)

        # 严格 UTF-8 无 BOM 原子写（§3.4：任何成功保存都写为无 BOM UTF-8）。
        data = content.encode("utf-8", errors="strict")
        parent = txt_path.parent
        parent.mkdir(parents=True, exist_ok=True)
        tmp_path = txt_path.with_name(txt_path.name + ".imageweave-tmp")
        try:
            with open(tmp_path, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, txt_path)
        except OSError:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise GalleryAnnotationError("txt_write_failed", txt_relative) from None

        stat = txt_path.stat()
        new_state = classify_txt_state(
            exists=True,
            read_ok=True,
            data=data,
        )
        updated = self._repo.update_annotation(
            asset_id,
            expected_txt_version=expected_txt_version,
            txt_state=new_state,
            txt_size_bytes=stat.st_size,
            txt_modified_ns=stat.st_mtime_ns,
            txt_sha256="",
            txt_relative_path=txt_relative,
            txt_content=content if new_state == "normal" else "",
        )
        return {
            "asset_id": asset_id,
            "txt_state": updated["txt_state"],
            "txt_version": updated["txt_version"],
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
        if not root.is_dir():
            # 离线来源保留现有索引（§3.2），只更新可用性。
            self._repo.set_source_availability(source_id, "offline")
            return {"asset_count": 0, "directory_count": 0, "offline": True}
        self._repo.set_source_availability(source_id, "available")

        existing = self._repo.get_source_asset_stats(source_id)
        directories: list[dict[str, Any]] = []
        assets: list[dict[str, Any]] = []
        skipped = {"temporary": 0, "unsupported": 0}
        for relative_path, name in _walk_source(root):
            directories.append(
                {
                    "relative_path": relative_path,
                    "name": name,
                    "parent_relative_path": (
                        relative_path.rpartition("/")[0] if relative_path else None
                    ),
                }
            )
            image_names: list[str] = []
            file_entries: list[tuple[str, os.stat_result]] = []
            for file_name, file_stat in _iter_directory_files(root, relative_path):
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
                        root,
                        relative_path,
                        file_name,
                        file_stat,
                        existing,
                        pair_conflict=file_name in conflicts,
                    )
                )
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
        root: Path,
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
        txt_path = root / txt_relative
        txt_size = 0
        txt_modified_ns = 0
        txt_state = "missing"
        txt_content = ""
        if txt_path.is_symlink() or not txt_path.exists():
            txt_state = classify_txt_state(exists=False)
        else:
            txt_stat = txt_path.stat()
            txt_size = txt_stat.st_size
            txt_modified_ns = txt_stat.st_mtime_ns
            if txt_size > _TXT_READ_MAX_BYTES:
                txt_state = classify_txt_state(exists=True, read_ok=False)
            else:
                data = txt_path.read_bytes()
                txt_state = classify_txt_state(
                    exists=True, data=data, pair_conflict=pair_conflict
                )
                if txt_state == "normal":
                    ok, text = _decode_txt(data)
                    txt_content = text if ok else ""

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
                root / relative_path
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


def _walk_source(root: Path):
    """深度优先遍历目录树，产出（相对路径, 名称）目录记录。

    跳过符号链接目录与 `.imageweave` 保留区（§6.1 rule 3/4）。
    """
    stack: list[tuple[str, str]] = [("", "")]
    while stack:
        relative, name = stack.pop()
        yield relative, name
        absolute = root / relative if relative else root
        with os.scandir(absolute) as entries:
            children: list[tuple[str, str]] = []
            for entry in entries:
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    if entry.name == ".imageweave":
                        continue
                    child_relative = (
                        f"{relative}/{entry.name}" if relative else entry.name
                    )
                    children.append((child_relative, entry.name))
            for child in reversed(children):
                stack.append(child)


def _iter_directory_files(root: Path, directory_relative: str):
    absolute = root / directory_relative if directory_relative else root
    with os.scandir(absolute) as entries:
        files: list[tuple[str, os.stat_result]] = []
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.is_file(follow_symlinks=False):
                files.append((entry.name, entry.stat(follow_symlinks=False)))
        files.sort(key=lambda item: item[0])
        yield from files


def _pair_conflicts(image_names: list[str]) -> set[str]:
    by_txt: dict[str, list[str]] = {}
    for name in image_names:
        by_txt.setdefault(txt_name_for_image(name).casefold(), []).append(name)
    conflicts: set[str] = set()
    for names in by_txt.values():
        if len(names) > 1:
            conflicts.update(names)
    return conflicts


def _probe_image(path: Path) -> tuple[str, int, int, str, str]:
    """有界图片探测：只读头部元数据，不整图解码（§6.3）。"""
    try:
        with Image.open(path) as image:
            format_name = str(image.format or "")
            width, height = image.size
            return format_name, int(width), int(height), "ok", ""
    except UnidentifiedImageError:
        return "", 0, 0, "failed", "unidentified"
    except OSError:
        return "", 0, 0, "failed", "decode_failed"
    except Exception:
        return "", 0, 0, "failed", "probe_error"
