"""语义地图（atlas）服务：在子进程里跑 ``dedup/atlas_worker.py``，结果按输入摘要缓存在磁盘上。

后端 venv 没有 numpy，所以计算放在 dedup 的 Python 里（与去重审核 worker 同一套环境）。

目录布局（``runtime_dir/atlas/<dataset_id>/``）::

  current.json          {"run_id": ...}；原子替换，只指向已经写完 atlas.json 的运行
  runs/<run_id>/
    job.json            worker 任务（含绝对路径，0600）
    run.json            后端元数据：输入摘要、输入清单 {asset_id: 指纹}、选项、时间
    atlas.json          worker 输出（最后原子写入，存在即代表完成）
    sprites/sheet-NNNN.webp
    worker.log          worker 的 stderr

worker 启动时会删掉输出目录里旧的 atlas.json 和雪碧图，所以每次运行都写进新目录，
成功后才切换 current.json；失败或取消时 current 不动，前端继续看到上一次的结果。

输入与移除：
- 地图读取打标阶段（``tag``）的输入，也就是清洗、去重排除之后的活跃图片。
- 在地图上移除图片记为 **去重阶段** 的 ``exclude`` 决定（reason=``atlas``），不动文件；
  于是它们从打标、校对、导出的输入里消失。之后去重阶段对同一张图做出的决定会覆盖它。
- restore 只清掉 reason=atlas 的去重决定，不碰去重审核自己记下的决定。

缓存与 stale：输入摘要 = 每张图的指纹（content_sha256，缺失时用 大小:修改时间）+ 选项。
摘要不变时 run 直接返回已有结果（除非 force）。读取时把当前输入和结果的输入清单比对：
新增或内容变化的图让结果 stale；只是被移除的图放进 ``removed_asset_ids``，前端隐藏即可。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import stat
import subprocess
import threading
import time
from collections import OrderedDict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .caption_tags import parse_caption
from .file_security import ensure_private_directory, open_private_binary, write_private_text
from .gallery_safe_paths import SafeSourceRoot, UnsafeSourcePathError
from .process_control import terminate_process
from .redaction import redact_text


logger = logging.getLogger(__name__)

ATLAS_STAGE = "tag"
REMOVAL_STAGE = "dedup"
REMOVAL_REASON = "atlas"
ATLAS_EVENT = "atlas.updated"
OVER_REPRESENTED_SHARE = 0.08
THUMBNAIL_SOURCE_SIZE = 256
KEEP_PREVIOUS_RUNS = 1
RUN_SCHEMA_VERSION = 1
PAYLOAD_CACHE_SIZE = 4
TOP_TAG_COUNT = 3
# 成员上影响文件名和 caption 的字段；任一变化都换地图的 ETag。
_CAPTION_KEYS = ("asset_id", "name", "txt_version", "txt_state", "txt_size_bytes", "txt_modified_ns")

_DATASET_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_RUN_ID = re.compile(r"^\d{13}-[0-9a-f]{8}$")
_SHEET = re.compile(r"^sprites/sheet-\d{4}\.(webp|png)$")
_SPRITE_MEDIA_TYPES = {"webp": "image/webp", "png": "image/png"}

PHASE_LABELS = {
    "queued": "排队中",
    "preparing": "整理输入",
    "hashing": "计算文件哈希",
    "read": "读取图片",
    "embed": "计算嵌入",
    "pca": "降维",
    "neighbors": "近邻",
    "layout": "布局",
    "cluster": "聚类",
    "write": "写出结果",
}


class AtlasError(Exception):
    """语义地图业务错误；路由层按 status/code 转成错误封套。"""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message


class _Cancelled(Exception):
    pass


@dataclass(slots=True)
class _ActiveRun:
    dataset_id: str
    run_id: str
    job_id: str
    options: dict[str, Any]
    force: bool
    started_at: float
    phase: str = "queued"
    done: int | None = None
    total: int | None = None
    cancelled: bool = False
    task: asyncio.Task | None = None
    process: asyncio.subprocess.Process | None = None


@dataclass(slots=True)
class _Prepared:
    run_dir: Path
    job_path: Path
    digest: str
    inputs: dict[str, str]
    item_count: int
    skipped: list[dict[str, str]] = field(default_factory=list)


def fingerprint(member: Mapping[str, Any]) -> str:
    """单张图的内容指纹：有哈希用哈希，否则退回 大小:修改时间。"""
    sha = member.get("content_sha256")
    if sha:
        return str(sha)
    return f"{member['size_bytes']}:{member['modified_ns']}"


def atlas_digest(inputs: Mapping[str, str], options: Mapping[str, Any]) -> str:
    digest = hashlib.sha256()
    for asset_id in sorted(inputs):
        digest.update(f"{asset_id}\0{inputs[asset_id]}\n".encode("utf-8"))
    digest.update(json.dumps(dict(options), sort_keys=True).encode("utf-8"))
    return digest.hexdigest()


def caption_signature(trigger_word: str, members: Iterable[Mapping[str, Any]]) -> str:
    digest = hashlib.sha1(f"{trigger_word}\n".encode("utf-8"))
    for member in members:
        line = "\0".join(str(member[key]) for key in _CAPTION_KEYS)
        digest.update(line.encode("utf-8", "surrogateescape") + b"\n")
    return digest.hexdigest()


def cluster_top_tags(
    items: Iterable[Mapping[str, Any]],
    captions: Mapping[str, str],
    trigger_word: str,
    limit: int = TOP_TAG_COUNT,
) -> dict[int, list[str]]:
    """每个簇里出现在最多张图上的标签（不含触发词），同票按标签排序。"""
    counts: dict[int, dict[str, int]] = {}
    for item in items:
        tags = parse_caption(captions.get(str(item.get("asset_id"))))
        if not tags:
            continue
        counter = counts.setdefault(int(item.get("cluster", 0)), {})
        for tag in tags:
            if tag != trigger_word:
                counter[tag] = counter.get(tag, 0) + 1
    return {
        cluster: [tag for tag, _ in sorted(counter.items(), key=lambda entry: (-entry[1], entry[0]))[:limit]]
        for cluster, counter in counts.items()
    }


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    if not if_none_match:
        return False
    candidates = {value.strip() for value in if_none_match.split(",")}
    return etag in candidates or "*" in candidates


def _new_run_id(clock: float) -> str:
    return f"{int(clock * 1000):013d}-{secrets.token_hex(4)}"


def _clamp(value: int, upper: int) -> int:
    return max(0, min(int(value), upper))


class AtlasService:
    def __init__(
        self,
        settings: Any,
        database: Any,
        datasets: Any,
        *,
        jobs: Any = None,
        events: Any = None,
        thumbnails: Any = None,
        clock: Any = time.time,
    ) -> None:
        self._settings = settings
        self._db = database
        self._datasets = datasets
        self._jobs = jobs
        self._events = events
        self._thumbnails = thumbnails
        self._clock = clock
        self._root = Path(settings.runtime_dir) / "atlas"
        self._active: dict[str, _ActiveRun] = {}
        self._failures: dict[str, dict[str, Any]] = {}
        self._gate: asyncio.Lock | None = None
        self._cache: OrderedDict[tuple[str, str], tuple[dict[str, Any], dict[str, Any]]] = OrderedDict()
        # dataset_id → ((run_id, 输入摘要, caption 指纹), {簇: top_tags})
        self._tag_cache: OrderedDict[str, tuple[tuple[str, ...], dict[int, list[str]]]] = OrderedDict()
        self._cache_lock = threading.Lock()
        self._stopping = False
        self._orphans_checked = False

    @classmethod
    def for_container(cls, container: Any) -> "AtlasService":
        return cls(
            container.settings,
            container.db,
            container.datasets,
            jobs=container.jobs,
            events=container.events,
            thumbnails=container.gallery_thumbnails,
        )

    # ---- 可用性 ----

    def availability(self) -> dict[str, Any]:
        dedup = self._settings.dedup
        if not dedup.enabled:
            return {"available": False, "reason": "dedup_disabled"}
        if not Path(dedup.python_executable).absolute().is_file():
            return {"available": False, "reason": "python_missing"}
        if not Path(dedup.atlas_script).resolve().is_file():
            return {"available": False, "reason": "worker_missing"}
        return {"available": True, "reason": ""}

    def _require_available(self) -> None:
        state = self.availability()
        if state["available"]:
            return
        messages = {
            "dedup_disabled": "语义地图依赖去重环境，去重功能当前已关闭",
            "python_missing": "去重 Python 环境不存在",
            "worker_missing": "语义地图 worker 不存在",
        }
        raise AtlasError(409, "atlas_unavailable", messages[state["reason"]])

    # ---- 路径 ----

    def _dataset_dir(self, dataset_id: str) -> Path:
        if not _DATASET_ID.match(dataset_id):
            raise AtlasError(404, "dataset_not_found", "数据集不存在")
        return self._root / dataset_id

    def _run_dir(self, dataset_id: str, run_id: str) -> Path:
        if not _RUN_ID.match(run_id):
            raise AtlasError(422, "invalid_atlas_run", "地图运行编号无效")
        return self._dataset_dir(dataset_id) / "runs" / run_id

    def _current_run_id(self, dataset_id: str) -> str | None:
        pointer = self._dataset_dir(dataset_id) / "current.json"
        try:
            if pointer.is_symlink():
                return None
            run_id = json.loads(pointer.read_text(encoding="utf-8")).get("run_id")
        except (OSError, ValueError, AttributeError):
            return None
        return run_id if isinstance(run_id, str) and _RUN_ID.match(run_id) else None

    def _load_run(self, dataset_id: str, run_id: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """读一次已完成运行的 (run.json, atlas.json)；完成后内容不再变，按 run_id 缓存。"""
        key = (dataset_id, run_id)
        with self._cache_lock:
            cached = self._cache.get(key)
            if cached is not None:
                self._cache.move_to_end(key)
                return cached
        run_dir = self._run_dir(dataset_id, run_id)
        try:
            meta = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
            atlas = json.loads((run_dir / "atlas.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(meta, dict) or not isinstance(atlas, dict):
            return None
        loaded = (meta, atlas)
        with self._cache_lock:
            self._cache[key] = loaded
            while len(self._cache) > PAYLOAD_CACHE_SIZE:
                self._cache.popitem(last=False)
        return loaded

    # ---- 输入 ----

    def _members(self, dataset_id: str) -> list[dict[str, Any]]:
        return self._datasets.stage_input(dataset_id, ATLAS_STAGE)

    def _inputs(self, members: Iterable[Mapping[str, Any]]) -> dict[str, str]:
        return {str(member["asset_id"]): fingerprint(member) for member in members}

    def _precheck(self, dataset_id: str, options: Mapping[str, Any], force: bool) -> str:
        """run 之前的同步检查：empty / cached / run。缺哈希时摘要还不准，交给后台任务补完再比。"""
        members = self._members(dataset_id)
        if not members:
            return "empty"
        if force or any(not member.get("content_sha256") for member in members):
            return "run"
        run_id = self._current_run_id(dataset_id)
        loaded = self._load_run(dataset_id, run_id) if run_id else None
        if loaded is not None and loaded[0].get("input_digest") == atlas_digest(self._inputs(members), options):
            return "cached"
        return "run"

    def _set_phase(self, active: _ActiveRun, phase: str, done: int | None = None, total: int | None = None) -> None:
        active.phase, active.done, active.total = phase, done, total
        if self._jobs is not None:
            self._jobs.update(
                active.job_id,
                status="running",
                current=done,
                total=total,
                message=PHASE_LABELS.get(phase, phase),
            )

    def _prepare(self, active: _ActiveRun) -> _Prepared | None:
        """整理 worker 输入（线程里跑）。摘要和当前结果一致且不强制时返回 None。"""
        dataset_id = active.dataset_id
        members = self._members(dataset_id)
        missing = [member for member in members if not member.get("content_sha256")]
        if missing:
            # 嵌入缓存按文件 sha256 取；先把缺的哈希补上，worker 只需读一遍图。
            for index, member in enumerate(missing):
                if active.cancelled:
                    raise _Cancelled()
                self._set_phase(active, "hashing", index, len(missing))
                try:
                    self._datasets.hashing.hash_asset(member["asset_id"])
                except Exception:
                    logger.warning("atlas hashing failed; asset_id=%s", member["asset_id"], exc_info=True)
            self._set_phase(active, "hashing", len(missing), len(missing))
            members = self._members(dataset_id)
        if active.cancelled:
            raise _Cancelled()
        inputs = self._inputs(members)
        digest = atlas_digest(inputs, active.options)
        if not active.force:
            run_id = self._current_run_id(dataset_id)
            loaded = self._load_run(dataset_id, run_id) if run_id else None
            if loaded is not None and loaded[0].get("input_digest") == digest:
                return None
        if not members:
            raise AtlasError(422, "atlas_empty", "打标阶段没有可用图片，无法生成语义地图")

        items: list[dict[str, Any]] = []
        skipped: list[dict[str, str]] = []
        by_source: dict[str, list[dict[str, Any]]] = {}
        for member in members:
            by_source.setdefault(str(member["source_id"]), []).append(member)
        for source_id, source_members in by_source.items():
            if active.cancelled:
                raise _Cancelled()
            source = self._db.gallery.get_source(source_id)
            if source is None or source.get("availability") != "available":
                skipped.extend({"asset_id": member["asset_id"], "reason": "missing"} for member in source_members)
                continue
            try:
                with SafeSourceRoot(source["root_path"]) as root:
                    for member in source_members:
                        # 只把确实是普通文件、没有越过来源根目录的路径交给 worker。
                        try:
                            root.stat_regular(member["relative_path"])
                        except UnsafeSourcePathError as error:
                            reason = "missing" if error.reason in {"file_missing", "parent_missing"} else "unreadable"
                            skipped.append({"asset_id": member["asset_id"], "reason": reason})
                            continue
                        item: dict[str, Any] = {
                            "asset_id": member["asset_id"],
                            "path": str(root.path / member["relative_path"]),
                            "sha256": member.get("content_sha256") or None,
                        }
                        thumbnail = self._thumbnail(member)
                        if thumbnail is not None:
                            item["thumbnail_path"] = str(thumbnail)
                        items.append(item)
            except UnsafeSourcePathError:
                skipped.extend({"asset_id": member["asset_id"], "reason": "unreadable"} for member in source_members)
        if not items:
            raise AtlasError(422, "atlas_empty", "打标阶段的图片都无法读取，无法生成语义地图")

        if active.cancelled:
            raise _Cancelled()
        run_dir = self._run_dir(dataset_id, active.run_id)
        ensure_private_directory(run_dir.parent)
        ensure_private_directory(run_dir)
        job_path = run_dir / "job.json"
        job = {"schema_version": 1, "output_dir": str(run_dir), "items": items, "options": active.options}
        with open_private_binary(job_path) as handle:
            handle.write(json.dumps(job, ensure_ascii=False).encode("utf-8"))
        return _Prepared(
            run_dir=run_dir,
            job_path=job_path,
            digest=digest,
            inputs=inputs,
            item_count=len(items),
            skipped=skipped,
        )

    def _thumbnail(self, member: Mapping[str, Any]) -> Path | None:
        if self._thumbnails is None:
            return None
        try:
            return self._thumbnails.cached_path(
                str(member["asset_id"]), int(member["modified_ns"]), THUMBNAIL_SOURCE_SIZE
            )
        except Exception:
            return None

    # ---- 运行 ----

    def state(self, dataset_id: str) -> dict[str, Any]:
        """在事件循环里取的运行状态快照，交给线程里的读取逻辑使用。"""
        active = self._active.get(dataset_id)
        progress = None
        if active is not None:
            progress = {
                "phase": active.phase,
                "label": PHASE_LABELS.get(active.phase, active.phase),
                "done": active.done,
                "total": active.total,
            }
        failure = self._failures.get(dataset_id)
        return {
            "running": active is not None,
            "run_id": active.run_id if active is not None else None,
            "progress": progress,
            "error": dict(failure) if failure else None,
            "availability": self.availability(),
        }

    async def run(
        self,
        dataset_id: str,
        *,
        force: bool = False,
        options: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        dataset = await asyncio.to_thread(self._db.datasets.get_dataset, dataset_id)
        if dataset is None:
            raise AtlasError(404, "dataset_not_found", "数据集不存在")
        self._dataset_dir(dataset_id)
        if self._stopping:
            raise AtlasError(503, "atlas_unavailable", "后端正在关闭")
        self._require_available()
        if dataset_id in self._active:
            return await self.status(dataset_id)
        normalized = {key: value for key, value in dict(options or {}).items() if value is not None}
        if not self._orphans_checked:
            self._orphans_checked = True
            await asyncio.to_thread(self._cleanup_orphans)
        precheck = await asyncio.to_thread(self._precheck, dataset_id, normalized, force)
        if precheck == "empty":
            raise AtlasError(422, "atlas_empty", "打标阶段没有可用图片，无法生成语义地图")
        if precheck == "cached":
            self._failures.pop(dataset_id, None)
            return {**await self.status(dataset_id), "cached": True}
        now = self._clock()
        active = _ActiveRun(
            dataset_id=dataset_id,
            run_id=_new_run_id(now),
            job_id=f"atlas:{dataset_id}",
            options=normalized,
            force=force,
            started_at=now,
        )
        self._active[dataset_id] = active
        self._failures.pop(dataset_id, None)
        if self._jobs is not None:
            self._jobs.start(
                "atlas.run",
                f"语义地图 · {dataset['name']}",
                job_id=active.job_id,
                status="queued",
                message=PHASE_LABELS["queued"],
                ref={"dataset_id": dataset_id, "run_id": active.run_id},
            )
        self._publish(dataset_id, "running", active.run_id)
        active.task = asyncio.create_task(self._execute(active), name=f"atlas-{dataset_id}")
        return await self.status(dataset_id)

    async def _execute(self, active: _ActiveRun) -> None:
        dataset_id = active.dataset_id
        outcome = "failed"
        message = ""
        try:
            if self._gate is None:
                self._gate = asyncio.Lock()
            # 全局同一时间只跑一个 worker：嵌入和 t-SNE 都吃满 CPU/GPU。
            async with self._gate:
                if active.cancelled:
                    raise _Cancelled()
                # 在事件循环里切到 preparing：之后取消只靠 cancelled 标志，不再取消任务本身。
                self._set_phase(active, "preparing")
                prepared = await asyncio.to_thread(self._prepare, active)
                if prepared is None:
                    outcome, message = "succeeded", "输入未变化，沿用已有结果"
                    return
                if active.cancelled:
                    raise _Cancelled()
                await self._run_worker(active, prepared)
                await asyncio.to_thread(self._commit, active, prepared)
                outcome, message = "succeeded", ""
        except (_Cancelled, asyncio.CancelledError):
            outcome, message = "cancelled", "已取消"
            await asyncio.to_thread(self._discard_run, dataset_id, active.run_id)
        except AtlasError as error:
            message = error.message
            self._failures[dataset_id] = {"code": error.code, "message": error.message, "at": self._clock()}
            await asyncio.to_thread(self._discard_run, dataset_id, active.run_id)
        except Exception as error:
            logger.exception("atlas run failed; dataset_id=%s", dataset_id)
            message = redact_text(f"{type(error).__name__}: {error}")[-500:]
            self._failures[dataset_id] = {"code": "atlas_internal", "message": message, "at": self._clock()}
            await asyncio.to_thread(self._discard_run, dataset_id, active.run_id)
        finally:
            if self._active.get(dataset_id) is active:
                del self._active[dataset_id]
            if self._jobs is not None:
                self._jobs.finish(active.job_id, outcome, message=message)  # type: ignore[arg-type]
            self._publish(dataset_id, outcome, active.run_id)

    async def _run_worker(self, active: _ActiveRun, prepared: _Prepared) -> None:
        dedup = self._settings.dedup
        # 不解引用 .venv/bin/python 符号链接，否则会退化为缺少依赖的系统 Python。
        python = Path(dedup.python_executable).absolute()
        script = Path(dedup.atlas_script).resolve()
        command = [
            str(python),
            str(script),
            "--job", str(prepared.job_path),
            "--output-dir", str(prepared.run_dir),
            "--model-dir", str(Path(dedup.model_dir).resolve()),
            "--device", str(dedup.device),
            "--workers", str(_clamp(dedup.workers, 64)),
            "--torch-threads", str(_clamp(dedup.torch_threads, 128)),
            "--deep-batch-size", str(_clamp(dedup.deep_batch_size, 128)),
        ]
        environment = os.environ.copy()
        environment.setdefault("PYTHONUTF8", "1")
        environment["PYTHONUNBUFFERED"] = "1"
        kwargs: dict[str, Any] = {}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
        else:
            kwargs["start_new_session"] = True
        log_path = prepared.run_dir / "worker.log"
        worker_error: dict[str, Any] | None = None
        with open_private_binary(log_path) as log_file:
            process = await asyncio.create_subprocess_exec(
                *command,
                cwd=str(script.parent),
                env=environment,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=log_file,
                limit=1 << 20,
                **kwargs,
            )
            active.process = process
            try:
                if active.cancelled:
                    await terminate_process(process, dedup.shutdown_grace_seconds)
                assert process.stdout is not None
                self._set_phase(active, "read", 0, prepared.item_count)
                async for raw in process.stdout:
                    event = self._parse_event(raw)
                    if event is None:
                        continue
                    kind = event.get("type")
                    if kind == "progress":
                        self._set_phase(active, str(event.get("stage") or "read"), event.get("done"), event.get("total"))
                    elif kind == "stage":
                        self._set_phase(active, str(event.get("stage") or active.phase))
                    elif kind == "error":
                        worker_error = event
                return_code = await process.wait()
            except asyncio.CancelledError:
                await terminate_process(process, dedup.shutdown_grace_seconds)
                raise
            finally:
                active.process = None
        if active.cancelled:
            raise _Cancelled()
        if return_code != 0 or not (prepared.run_dir / "atlas.json").is_file():
            if worker_error is not None:
                code = str(worker_error.get("code") or "internal")
                detail = redact_text(str(worker_error.get("message") or ""))[-500:]
                raise AtlasError(500, f"atlas_{code}", detail or f"语义地图 worker 失败（{code}）")
            tail = redact_text(self._log_tail(log_path))[-500:]
            raise AtlasError(500, "atlas_worker_failed", tail or f"语义地图 worker 退出码 {return_code}")

    @staticmethod
    def _parse_event(raw: bytes) -> dict[str, Any] | None:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line.startswith("{"):
            return None
        try:
            event = json.loads(line)
        except ValueError:
            return None
        return event if isinstance(event, dict) else None

    @staticmethod
    def _log_tail(path: Path, limit: int = 2000) -> str:
        try:
            with path.open("rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                handle.seek(max(0, size - limit))
                return handle.read(limit).decode("utf-8", "replace").strip()
        except OSError:
            return ""

    def _commit(self, active: _ActiveRun, prepared: _Prepared) -> None:
        dataset_id = active.dataset_id
        try:
            atlas = json.loads((prepared.run_dir / "atlas.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise AtlasError(500, "atlas_output_invalid", f"无法读取 atlas.json: {error}") from None
        if not isinstance(atlas, dict) or atlas.get("schema_version") != 1 or not isinstance(atlas.get("items"), list):
            raise AtlasError(500, "atlas_output_invalid", "atlas.json 格式无效")
        sprites = atlas.get("sprites")
        if sprites is not None:
            sheets = sprites.get("sheets") if isinstance(sprites, dict) else None
            if not isinstance(sheets, list) or not all(isinstance(sheet, str) and _SHEET.match(sheet) for sheet in sheets):
                raise AtlasError(500, "atlas_output_invalid", "atlas.json 的雪碧图列表无效")
        previous = self._current_run_id(dataset_id)
        meta = {
            "schema_version": RUN_SCHEMA_VERSION,
            "run_id": active.run_id,
            "dataset_id": dataset_id,
            "started_at": active.started_at,
            "finished_at": self._clock(),
            "input_digest": prepared.digest,
            "options": active.options,
            "inputs": prepared.inputs,
            "skipped": prepared.skipped,
        }
        write_private_text(prepared.run_dir / "run.json", json.dumps(meta, ensure_ascii=False))
        # job.json 里是本机绝对路径；结果写完就不再需要。
        (prepared.run_dir / "job.json").unlink(missing_ok=True)
        write_private_text(
            self._dataset_dir(dataset_id) / "current.json",
            json.dumps({"run_id": active.run_id}),
        )
        # 留一份上一次的结果：前端可能还在用带 ?run= 的旧雪碧图地址。
        self._prune_runs(dataset_id, keep={active.run_id, previous} - {None})

    def _discard_run(self, dataset_id: str, run_id: str) -> None:
        try:
            run_dir = self._run_dir(dataset_id, run_id)
        except AtlasError:
            return
        if run_id != self._current_run_id(dataset_id):
            self._remove_tree(run_dir)

    def _prune_runs(self, dataset_id: str, *, keep: set[str]) -> None:
        runs = self._dataset_dir(dataset_id) / "runs"
        try:
            entries = list(runs.iterdir())
        except OSError:
            return
        active = self._active.get(dataset_id)
        for entry in entries:
            if entry.name in keep or (active is not None and entry.name == active.run_id):
                continue
            self._remove_tree(entry)
        with self._cache_lock:
            for key in [key for key in self._cache if key[0] == dataset_id and key[1] not in keep]:
                self._cache.pop(key, None)

    @staticmethod
    def _remove_tree(path: Path) -> None:
        try:
            info = path.lstat()
        except OSError:
            return
        try:
            if stat.S_ISDIR(info.st_mode):
                shutil.rmtree(path)
            else:
                path.unlink()
        except OSError:
            logger.warning("atlas cleanup failed; path=%s", path, exc_info=True)

    def _cleanup_orphans(self) -> None:
        """删掉已删除数据集的地图目录和崩溃留下的半成品运行（每个进程首次运行时做一次）。"""
        try:
            entries = list(self._root.iterdir())
        except OSError:
            return
        for entry in entries:
            if not _DATASET_ID.match(entry.name) or self._db.datasets.get_dataset(entry.name) is None:
                if entry.name not in self._active:
                    self._remove_tree(entry)
                continue
            current = self._current_run_id(entry.name)
            runs = entry / "runs"
            try:
                names = sorted(child.name for child in runs.iterdir())
            except OSError:
                continue
            completed = [
                name for name in names
                if name != current and _RUN_ID.match(name) and (runs / name / "atlas.json").is_file()
                and (runs / name / "run.json").is_file()
            ]
            keep = {name for name in [current, *completed[-KEEP_PREVIOUS_RUNS:]] if name}
            self._prune_runs(entry.name, keep=keep)

    async def cancel(self, dataset_id: str) -> dict[str, Any]:
        dataset = await asyncio.to_thread(self._db.datasets.get_dataset, dataset_id)
        if dataset is None:
            raise AtlasError(404, "dataset_not_found", "数据集不存在")
        active = self._active.get(dataset_id)
        if active is not None:
            await self._cancel_active(active)
        return await self.status(dataset_id)

    async def _cancel_active(self, active: _ActiveRun) -> None:
        active.cancelled = True
        process = active.process
        if process is not None:
            await terminate_process(process, self._settings.dedup.shutdown_grace_seconds)
        elif active.task is not None and active.phase == "queued":
            # 还在等全局锁：直接取消。整理输入的线程会在下一张图前看到 cancelled 自己退出，
            # 不在这里取消，免得线程还在写 job.json 时目录已被删掉。
            active.task.cancel()
        if active.task is not None:
            await asyncio.gather(active.task, return_exceptions=True)

    async def stop(self) -> None:
        self._stopping = True
        for active in list(self._active.values()):
            try:
                await self._cancel_active(active)
            except Exception:
                logger.warning("atlas shutdown cancel failed; dataset_id=%s", active.dataset_id, exc_info=True)

    def _publish(self, dataset_id: str, status: str, run_id: str | None) -> None:
        if self._events is not None:
            self._events.publish(ATLAS_EVENT, {"dataset_id": dataset_id, "status": status, "run_id": run_id})

    # ---- 读取 ----

    async def status(self, dataset_id: str) -> dict[str, Any]:
        snapshot = self.state(dataset_id)
        payload, _etag = await asyncio.to_thread(self._build, dataset_id, snapshot, full=False)
        assert payload is not None
        return payload

    async def payload(self, dataset_id: str, *, if_none_match: str | None = None) -> tuple[dict[str, Any] | None, str]:
        """完整地图；If-None-Match 命中时返回 (None, etag)，路由回 304。"""
        snapshot = self.state(dataset_id)
        return await asyncio.to_thread(self._build, dataset_id, snapshot, full=True, if_none_match=if_none_match)

    def _build(
        self,
        dataset_id: str,
        snapshot: Mapping[str, Any],
        *,
        full: bool,
        if_none_match: str | None = None,
    ) -> tuple[dict[str, Any] | None, str]:
        self._datasets.require(dataset_id)
        self._dataset_dir(dataset_id)
        run_id = self._current_run_id(dataset_id)
        loaded = self._load_run(dataset_id, run_id) if run_id else None
        members = self._members(dataset_id)
        current_inputs = self._inputs(members)
        meta, atlas = loaded if loaded is not None else ({}, {})
        run_inputs: dict[str, str] = meta.get("inputs") or {}
        options = meta.get("options") or {}
        current_digest = atlas_digest(current_inputs, options)
        added = sum(1 for asset_id in current_inputs if asset_id not in run_inputs)
        changed = sum(
            1 for asset_id, value in current_inputs.items()
            if asset_id in run_inputs and run_inputs[asset_id] != value
        )
        atlas_items = atlas.get("items") or []
        removed = [item["asset_id"] for item in atlas_items if item.get("asset_id") not in current_inputs]
        stale = loaded is not None and (added > 0 or changed > 0)
        if snapshot["running"]:
            status = "running"
        elif snapshot["error"] is not None:
            status = "failed"
        elif loaded is None:
            status = "none"
        else:
            status = "stale" if stale else "ready"
        progress = snapshot["progress"]
        dataset = self._db.datasets.get_dataset(dataset_id) or {}
        trigger_word = str(dataset.get("trigger_word") or "").strip()
        captions_digest = caption_signature(trigger_word, members)
        # 运行完成后内容不变，removed/stale 都由 run_id + 当前输入摘要决定，文件名和 top_tags 由
        # caption 指纹决定，ETag 不必序列化整张地图。
        etag_source = json.dumps(
            [run_id, status, progress, snapshot["error"], current_digest, snapshot["availability"], captions_digest],
            sort_keys=True,
            default=str,
        )
        etag = f'W/"{hashlib.sha1(etag_source.encode("utf-8")).hexdigest()[:32]}"'
        if full and etag_matches(if_none_match, etag):
            return None, etag
        result: dict[str, Any] = {
            "dataset_id": dataset_id,
            "status": status,
            "progress": progress,
            "error": snapshot["error"],
            "availability": snapshot["availability"],
            "running_run_id": snapshot["run_id"],
            "cached": False,
            "run": None,
            "stale": stale,
            "current_digest": current_digest,
            "delta": {"added": added, "changed": changed, "removed_asset_ids": removed},
        }
        if loaded is not None:
            result["run"] = {
                "run_id": run_id,
                "input_digest": meta.get("input_digest"),
                "started_at": meta.get("started_at"),
                "finished_at": meta.get("finished_at"),
                "options": options,
                "method": atlas.get("method"),
                "params": atlas.get("params") or {},
                "counts": atlas.get("counts") or {},
            }
        if not full:
            return result, etag
        removed_set = set(removed)
        clusters = []
        live_sizes: dict[int, int] = {}
        for item in atlas_items:
            if item.get("asset_id") not in removed_set:
                live_sizes[int(item.get("cluster", 0))] = live_sizes.get(int(item.get("cluster", 0)), 0) + 1
        live_total = sum(live_sizes.values())
        top_tags = self._top_tags(
            dataset_id,
            (str(run_id), current_digest, captions_digest),
            [item for item in atlas_items if item.get("asset_id") not in removed_set],
            trigger_word,
        )
        for cluster in atlas.get("clusters") or []:
            live_size = live_sizes.get(int(cluster["id"]), 0)
            clusters.append({
                **cluster,
                "live_size": live_size,
                "live_share": round(live_size / live_total, 6) if live_total else 0.0,
                "top_tags": top_tags.get(int(cluster["id"]), []),
            })
        # 缓存里的 atlas_items 不能改，复制一份带上文件名；已移出输入的图没有名字（前端本就隐藏）。
        names = {member["asset_id"]: member["name"] for member in members}
        items = [{**item, "name": names.get(item.get("asset_id"))} for item in atlas_items]
        params = atlas.get("params") or {}
        threshold = float(params.get("outlier_threshold", 1.0))
        outliers = sorted(
            (item for item in atlas_items if item.get("asset_id") not in removed_set and float(item.get("outlier", 0)) >= threshold),
            key=lambda item: (-float(item.get("outlier", 0)), item["asset_id"]),
        )
        sprites = atlas.get("sprites")
        sprite_payload = None
        if isinstance(sprites, dict):
            sprite_payload = {
                key: sprites.get(key) for key in ("format", "sheet_size", "cell_size", "columns", "per_sheet")
            } | {
                "urls": [
                    f"/api/v1/datasets/{dataset_id}/atlas/sprites/{index}?run={run_id}"
                    for index in range(len(sprites.get("sheets") or []))
                ]
            }
        result.update({
            "items": items,
            "clusters": clusters,
            "vectors": atlas.get("vectors"),
            "sprites": sprite_payload,
            "skipped": [*(meta.get("skipped") or []), *(atlas.get("skipped") or [])],
            "hints": {
                "share_threshold": OVER_REPRESENTED_SHARE,
                "outlier_threshold": threshold,
                "over_represented": [
                    {"cluster": cluster["id"], "share": cluster["live_share"], "size": cluster["live_size"]}
                    for cluster in clusters if cluster["live_share"] > OVER_REPRESENTED_SHARE
                ],
                "outliers": [item["asset_id"] for item in outliers],
            },
        })
        return result, etag

    def _top_tags(
        self,
        dataset_id: str,
        key: tuple[str, ...],
        live_items: Sequence[Mapping[str, Any]],
        trigger_word: str,
    ) -> dict[int, list[str]]:
        """按簇统计 caption 标签；caption 文本取自图库搜索索引，结果按 (运行, 输入, caption 指纹) 缓存。"""
        with self._cache_lock:
            cached = self._tag_cache.get(dataset_id)
            if cached is not None and cached[0] == key:
                self._tag_cache.move_to_end(dataset_id)
                return cached[1]
        captions = self._db.gallery.caption_texts(str(item.get("asset_id")) for item in live_items)
        top_tags = cluster_top_tags(live_items, captions, trigger_word)
        with self._cache_lock:
            self._tag_cache[dataset_id] = (key, top_tags)
            self._tag_cache.move_to_end(dataset_id)
            while len(self._tag_cache) > PAYLOAD_CACHE_SIZE:
                self._tag_cache.popitem(last=False)
        return top_tags

    def sprite(self, dataset_id: str, index: int, run_id: str | None) -> dict[str, Any]:
        """雪碧图文件定位：只接受 atlas.json 列出的 sprites/sheet-NNNN.* 普通文件。"""
        self._datasets.require(dataset_id)
        pinned = run_id is not None
        if run_id is None:
            run_id = self._current_run_id(dataset_id)
            if run_id is None:
                raise AtlasError(404, "atlas_sprite_not_found", "雪碧图不存在")
        run_dir = self._run_dir(dataset_id, run_id)
        loaded = self._load_run(dataset_id, run_id)
        sprites = loaded[1].get("sprites") if loaded is not None else None
        sheets = sprites.get("sheets") if isinstance(sprites, dict) else None
        if not isinstance(sheets, list) or not 0 <= index < len(sheets):
            raise AtlasError(404, "atlas_sprite_not_found", "雪碧图不存在")
        relative = sheets[index]
        if not isinstance(relative, str) or not _SHEET.match(relative):
            raise AtlasError(404, "atlas_sprite_not_found", "雪碧图不存在")
        path = run_dir / relative
        try:
            info = path.lstat()
        except OSError:
            raise AtlasError(404, "atlas_sprite_not_found", "雪碧图不存在") from None
        if not stat.S_ISREG(info.st_mode) or path.parent.is_symlink() or run_dir.is_symlink():
            raise AtlasError(404, "atlas_sprite_not_found", "雪碧图不存在")
        return {
            "path": path,
            "media_type": _SPRITE_MEDIA_TYPES[relative.rsplit(".", 1)[1]],
            "etag": f'"{run_id}-{index}"',
            "immutable": pinned,
        }

    # ---- 地图上的移除 ----

    def remove(self, dataset_id: str, asset_ids: Sequence[str]) -> dict[str, Any]:
        result = self._datasets.decide(
            dataset_id,
            stage=REMOVAL_STAGE,
            asset_ids=list(asset_ids),
            decision="exclude",
            reason=REMOVAL_REASON,
        )
        self._publish_dataset(dataset_id)
        return result

    def restore(self, dataset_id: str, asset_ids: Sequence[str]) -> dict[str, Any]:
        self._datasets.require(dataset_id)
        removed = [
            row["asset_id"]
            for row in self._db.datasets.list_decisions(dataset_id, asset_ids)
            if row["stage"] == REMOVAL_STAGE and row["decision"] == "exclude" and row["reason"] == REMOVAL_REASON
        ]
        if not removed:
            return {"updated": 0, "funnel": self._datasets.funnel(dataset_id)}
        result = self._datasets.decide(dataset_id, stage=REMOVAL_STAGE, asset_ids=removed, decision="clear")
        self._publish_dataset(dataset_id)
        return result

    def _publish_dataset(self, dataset_id: str) -> None:
        if self._events is not None:
            self._events.publish("dataset.updated", {"dataset_id": dataset_id, "reason": REMOVAL_REASON})


__all__ = [
    "ATLAS_EVENT",
    "ATLAS_STAGE",
    "AtlasError",
    "AtlasService",
    "OVER_REPRESENTED_SHARE",
    "REMOVAL_REASON",
    "REMOVAL_STAGE",
    "atlas_digest",
    "etag_matches",
    "fingerprint",
]
