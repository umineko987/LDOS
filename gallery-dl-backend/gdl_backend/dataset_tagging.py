"""数据集打标：tag 阶段运行、候选分数查询、按策略把打标结果写成 caption。

- tag 阶段运行：对 tag 阶段输入整体推理入库（`--no-captions`，图片列表走
  `--inputs-file -`），登记一条阶段运行，CLI 结束时按 done 行收尾。
- 候选分数：`candidates` 从打标缓存取稀疏分数（下限 0.01），按 asset_id 返回，
  供前端在本地调阈值。服务端按输入指纹缓存载荷；ETag 是载荷的内容哈希。
- 从打标写 caption：`compose` 按每个模型、每个类别的阈值组出标签，再交给
  CaptionService 按 overwrite / merge / fill_empty 合进现有 caption。

打标缓存按内容哈希寻址；成员已有 content_sha256 时以 `sha256<TAB>路径` 传给
只读查询，省去重新读图。
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import logging
import os
import re
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .caption_service import SAMPLE_LIMIT_DEFAULT, CaptionService
from .caption_tags import parse_caption
from .dataset_service import DatasetError, DatasetService
from .gallery_safe_paths import SafeSourceRoot, UnsafeSourcePathError
from .tagger_service import TaggerQueryError, TaggerService

logger = logging.getLogger(__name__)

CANDIDATE_FLOOR = 0.01
CAPTION_MODES = ("overwrite", "merge", "fill_empty")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_CANDIDATE_CACHE_SIZE = 4
_GZIP_MIN_BYTES = 1024


@dataclass(frozen=True, slots=True)
class TagInput:
    asset_id: str
    path: str
    sha256: str
    # 来源离线、文件不见了或路径不安全时为原因码，不交给 CLI。
    unavailable: str = ""
    size: int = 0
    modified_ns: int = 0

    @property
    def line(self) -> str:
        return f"{self.sha256}\t{self.path}" if self.sha256 else self.path


@dataclass(slots=True)
class CandidatePayload:
    etag: str
    body: bytes
    gzipped: bytes | None = None

    def compressed(self) -> bytes:
        if self.gzipped is None:
            self.gzipped = gzip.compress(self.body, compresslevel=5, mtime=0)
        return self.gzipped


def _query_error(error: TaggerQueryError) -> DatasetError:
    if error.exit_code == 4:
        return DatasetError(409, "tagger_model_unavailable", "打标模型无法加载", details={"message": str(error)})
    if error.exit_code == 3:
        return DatasetError(409, "tagger_license_required", str(error))
    if error.exit_code == 2:
        return DatasetError(422, "invalid_tagger_query", str(error))
    if error.exit_code == -1:
        return DatasetError(504, "tagger_query_failed", str(error))
    return DatasetError(502, "tagger_query_failed", str(error), details={"exit_code": error.exit_code})


class DatasetTaggingService:
    def __init__(
        self,
        *,
        database: Any,
        settings: Any,
        datasets: DatasetService,
        captions: CaptionService,
        tagger: TaggerService,
    ) -> None:
        self._db = database
        self._settings = settings
        self._datasets = datasets
        self._captions = captions
        self._tagger = tagger
        self._candidate_lock = asyncio.Lock()
        self._candidate_cache: OrderedDict[str, CandidatePayload] = OrderedDict()

    @classmethod
    def for_container(cls, container: Any) -> "DatasetTaggingService":
        return cls(
            database=container.db,
            settings=container.settings,
            datasets=container.datasets,
            captions=container.captions,
            tagger=container.tagger,
        )

    # ---- 校验 ----

    def _catalog(self, models: Sequence[str]) -> list[dict[str, Any]]:
        """按请求顺序返回模型登记项；未启用、未登记、未安装分别报 409 / 422 / 409。"""
        if not self._settings.tagger.enabled:
            raise DatasetError(409, "tagger_disabled", "打标功能未启用")
        catalog = {entry["key"]: entry for entry in self._tagger.model_catalog()}
        unknown = [key for key in models if key not in catalog]
        if unknown:
            raise DatasetError(422, "unknown_tagger_model", f"未登记的模型: {', '.join(unknown)}",
                               details={"models": unknown})
        missing = [key for key in models if not catalog[key]["installed"]]
        if missing:
            raise DatasetError(409, "tagger_model_missing", f"模型未安装: {', '.join(missing)}",
                               details={"models": missing})
        return [catalog[key] for key in models]

    @staticmethod
    def _check_thresholds(
        entries: Sequence[Mapping[str, Any]], thresholds: Mapping[str, Mapping[str, float]]
    ) -> None:
        defaults = {entry["key"]: entry["default_thresholds"] for entry in entries}
        for model, overrides in thresholds.items():
            if model not in defaults:
                raise DatasetError(422, "invalid_tagger_thresholds", f"阈值对应的模型未选中: {model}")
            unsupported = sorted(set(overrides) - set(defaults[model]))
            if unsupported:
                raise DatasetError(
                    422, "invalid_tagger_thresholds",
                    f"{model} 不支持这些阈值类别: {', '.join(unsupported)}",
                    details={"model": model, "categories": unsupported},
                )

    # ---- 输入 ----

    def inputs(self, dataset_id: str, stage: str, asset_ids: Sequence[str] | None = None) -> list[TagInput]:
        """阶段输入里每张图的绝对路径；asset_ids 给出时只取这些（必须在该阶段输入里）。"""
        members = self._datasets.stage_input(dataset_id, stage)
        if asset_ids is not None:
            by_id = {member["asset_id"]: member for member in members}
            wanted = list(dict.fromkeys(asset_ids))
            unknown = [asset_id for asset_id in wanted if asset_id not in by_id]
            if unknown:
                raise DatasetError(
                    422, "caption_asset_not_in_stage", f"有图片不在「{stage}」这一步的输入里",
                    details={"stage": stage, "asset_ids": unknown[:20]},
                )
            members = [by_id[asset_id] for asset_id in wanted]
        grouped: dict[str, list[Mapping[str, Any]]] = {}
        for member in members:
            grouped.setdefault(str(member["source_id"]), []).append(member)
        resolved: dict[str, TagInput] = {}
        for source_id, group in grouped.items():
            source = self._db.gallery.get_source(source_id)
            if source is None or source["availability"] != "available":
                for member in group:
                    resolved[member["asset_id"]] = TagInput(member["asset_id"], "", "", "source_offline")
                continue
            try:
                with SafeSourceRoot(source["root_path"]) as root:
                    for member in group:
                        resolved[member["asset_id"]] = self._resolve(root, member)
            except UnsafeSourcePathError:
                for member in group:
                    resolved[member["asset_id"]] = TagInput(member["asset_id"], "", "", "source_offline")
        return [resolved[member["asset_id"]] for member in members]

    @staticmethod
    def _resolve(root: SafeSourceRoot, member: Mapping[str, Any]) -> TagInput:
        asset_id = str(member["asset_id"])
        relative = str(member["relative_path"])
        try:
            stat = root.stat_regular(relative)
        except UnsafeSourcePathError as error:
            reason = "file_missing" if error.reason == "file_missing" else "unsafe_source_path"
            return TagInput(asset_id, "", "", reason)
        except OSError:
            return TagInput(asset_id, "", "", "file_missing")
        sha = str(member.get("content_sha256") or "")
        # 文件在哈希之后又变过（扫描还没跟上）时不用旧哈希，让 CLI 按内容重算。
        if not _SHA256.fullmatch(sha) or stat.size != int(member["size_bytes"]) or stat.modified_ns != int(member["modified_ns"]):
            sha = ""
        return TagInput(asset_id, str(root.path / relative), sha, "", stat.size, stat.modified_ns)

    # ---- tag 阶段运行 ----

    async def run_tag_stage(self, dataset_id: str, *, models: list[str], batch_size: int = 8) -> dict[str, Any]:
        """对 tag 阶段的全部输入推理入库（不写 caption），返回新登记的阶段运行。"""
        await asyncio.to_thread(self._datasets.require, dataset_id)
        await asyncio.to_thread(self._catalog, models)
        inputs = await asyncio.to_thread(self.inputs, dataset_id, "tag")
        runnable = [item for item in inputs if not item.unavailable]
        if not runnable:
            raise DatasetError(422, "dataset_stage_empty", "tag 这一步没有可打标的图片")
        skipped = len(inputs) - len(runnable)

        # 先启动 CLI 拿到 Job id（忙时直接 409，不留失败的阶段运行），再登记阶段运行；
        # 结束回调等登记完成后再收尾，子进程秒退也不会丢。
        registered = asyncio.Event()
        holder: dict[str, str] = {}

        async def finished(summary: dict[str, Any]) -> None:
            await registered.wait()
            run_id = holder.get("run_id")
            if run_id is None:
                return
            last = summary.get("last_result") or {}
            stats = {
                "models": models,
                "total": int(last.get("total") or len(runnable)),
                "skipped": skipped,
                "per_model": dict(last.get("per_model") or {}),
                "decode_errors": len(last.get("decode_errors") or ()),
                "unreadable": len(last.get("unreadable") or ()),
            }
            status = summary["status"]
            error_code = {"failed": "tagger_failed", "cancelled": "tagger_cancelled"}.get(status, "")
            if status == "failed" and summary.get("message"):
                stats["message"] = str(summary["message"])[-500:]
            await asyncio.to_thread(
                self._datasets.finish_stage_run, run_id,
                status=status if status in {"succeeded", "failed", "cancelled"} else "failed",
                stats=stats, error_code=error_code,
            )

        try:
            started = await self._tagger.tag(
                models, [item.path for item in runnable],
                write_captions=False, batch_size=batch_size,
                job_ref={"dataset_id": dataset_id, "stage": "tag"},
                on_finished=finished,
            )
        except OSError as error:
            registered.set()
            raise DatasetError(503, "tagger_start_failed", str(error)) from error
        except RuntimeError as error:
            registered.set()
            raise DatasetError(409, "tagger_busy", str(error)) from error
        try:
            run = await asyncio.to_thread(
                self._datasets.start_stage_run, dataset_id, "tag",
                ref_id=str(started.get("job_id") or ""),
                stats={"models": models, "total": len(runnable), "skipped": skipped},
            )
            holder["run_id"] = str(run["run_id"])
        finally:
            registered.set()
        return run

    # ---- 候选分数 ----

    def _candidate_key(
        self, dataset_id: str, entries: Sequence[Mapping[str, Any]], floor: float, inputs: Sequence[TagInput]
    ) -> str:
        """服务端缓存键：模型登记、打标缓存的代数与文件状态、每张图的路径/哈希/大小/修改时间。"""
        digest = hashlib.sha256(b"ldos:candidates:v1\0")
        header = {
            "dataset_id": dataset_id,
            "floor": floor,
            "models": [[entry["key"], entry["revision"], entry["adapter"], bool(entry["installed"])] for entry in entries],
            "generation": self._tagger.cache_generation,
            "cache": [_file_signature(self._settings.tagger.cache_path, suffix) for suffix in ("", "-wal")],
        }
        digest.update(json.dumps(header, sort_keys=True, default=str).encode("utf-8"))
        for item in inputs:
            line = "\0".join((item.asset_id, item.path, item.sha256, item.unavailable, str(item.size), str(item.modified_ns)))
            digest.update(line.encode("utf-8", "surrogateescape") + b"\n")
        return digest.hexdigest()

    async def candidates(self, dataset_id: str, *, models: list[str], floor: float = CANDIDATE_FLOOR) -> CandidatePayload:
        """tag 阶段输入的稀疏候选分数。返回的载荷带内容哈希 ETag，可直接按 If-None-Match 比较。"""
        await asyncio.to_thread(self._datasets.require, dataset_id)
        entries = await asyncio.to_thread(self._catalog, models)
        floor = max(float(floor), CANDIDATE_FLOOR)
        inputs = await asyncio.to_thread(self.inputs, dataset_id, "tag")
        key = await asyncio.to_thread(self._candidate_key, dataset_id, entries, floor, inputs)
        async with self._candidate_lock:
            cached = self._candidate_cache.get(key)
            if cached is not None:
                self._candidate_cache.move_to_end(key)
                return cached
            runnable = [item for item in inputs if not item.unavailable]
            lines: list[dict[str, Any]] = []
            if runnable:
                try:
                    lines = await self._tagger.query(
                        "candidates", models, [item.line for item in runnable],
                        ["--floor", repr(floor)],
                    )
                except TaggerQueryError as error:
                    raise _query_error(error) from None
            body = await asyncio.to_thread(self._candidate_body, dataset_id, entries, floor, inputs, lines)
            payload = CandidatePayload(f'"{hashlib.sha256(body).hexdigest()[:40]}"', body)
            self._candidate_cache[key] = payload
            while len(self._candidate_cache) > _CANDIDATE_CACHE_SIZE:
                self._candidate_cache.popitem(last=False)
            return payload

    @staticmethod
    def _candidate_body(
        dataset_id: str,
        entries: Sequence[Mapping[str, Any]],
        floor: float,
        inputs: Sequence[TagInput],
        lines: Sequence[Mapping[str, Any]],
    ) -> bytes:
        header = next((line for line in lines if line.get("type") == "models"), None)
        if header is not None:
            models = [dict(model) for model in header["models"]]
        else:
            # 没有可查询的图：模型头只能从登记表给出，指纹留空。
            models = [
                {
                    "key": entry["key"], "adapter": entry["adapter"], "revision": entry["revision"],
                    "fingerprint": "", "vocabulary_fingerprint": "", "vocabulary_size": 0,
                    "categories": list(entry["default_thresholds"]),
                    "default_thresholds": dict(entry["default_thresholds"]),
                }
                for entry in entries
            ]
        # 每个模型一张出现过的标签表 [[名字, 类别]]，分数行只写下标，载荷小很多。
        vocab: dict[str, dict[tuple[str, str], int]] = {model["key"]: {} for model in models}
        by_path = {line["path"]: line for line in lines if line.get("type") == "candidates"}
        stats = dict.fromkeys(("ok", "missing_scores", "decode_error", "unreadable", "unavailable"), 0)
        items: dict[str, dict[str, Any]] = {}
        keys = [model["key"] for model in models]
        for item in inputs:
            line = None if item.unavailable else by_path.get(item.path)
            if line is None:
                status = "unavailable" if item.unavailable else "unreadable"
                items[item.asset_id] = {
                    "status": status, "reason": item.unavailable or "no_result",
                    "missing_models": keys, "scores": {},
                }
                stats[status] += 1
                continue
            scores: dict[str, list[list[Any]]] = {}
            for model_key, candidates in (line.get("models") or {}).items():
                table = vocab.setdefault(model_key, {})
                rows = []
                for name, category, score in candidates:
                    index = table.setdefault((name, category), len(table))
                    rows.append([index, score])
                scores[model_key] = rows
            status = str(line.get("status") or "ok")
            items[item.asset_id] = {
                "status": status, "reason": "",
                "missing_models": list(line.get("missing_models") or ()), "scores": scores,
            }
            stats[status] = stats.get(status, 0) + 1
        for model in models:
            model["tags"] = [list(pair) for pair in vocab.get(model["key"], {})]
        return json.dumps(
            {
                "dataset_id": dataset_id,
                "floor": floor,
                "models": models,
                "items": items,
                "stats": {"total": len(inputs), **stats},
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")

    # ---- 从打标写 caption ----

    async def captions_from_tagger(
        self,
        dataset_id: str,
        *,
        models: list[str],
        mode: str,
        thresholds: Mapping[str, Mapping[str, float]] | None = None,
        categories: Sequence[str] | None = None,
        keep_underscores: bool = False,
        escape_parens: bool = False,
        asset_ids: Sequence[str] | None = None,
        dry_run: bool = False,
        sample_limit: int = SAMPLE_LIMIT_DEFAULT,
    ) -> dict[str, Any]:
        """对 review 阶段输入（或其中给定的图）按策略组标签并合进 caption。"""
        if mode not in CAPTION_MODES:
            raise DatasetError(422, "invalid_caption_mode", f"未知模式: {mode}")
        await asyncio.to_thread(self._datasets.require, dataset_id)
        entries = await asyncio.to_thread(self._catalog, models)
        thresholds = {model: dict(values) for model, values in (thresholds or {}).items()}
        self._check_thresholds(entries, thresholds)
        inputs = await asyncio.to_thread(self.inputs, dataset_id, "review", asset_ids)
        unavailable = {item.asset_id: item.unavailable for item in inputs if item.unavailable}
        runnable = [item for item in inputs if not item.unavailable]
        extra: list[str] = []
        for model, overrides in thresholds.items():
            for category, value in overrides.items():
                extra += ["--model-threshold", model, category, repr(float(value))]
        if categories:
            extra += ["--categories", ",".join(categories)]
        if keep_underscores:
            extra.append("--keep-underscores")
        if escape_parens:
            extra.append("--escape-parens")
        lines: list[dict[str, Any]] = []
        if runnable:
            try:
                lines = await self._tagger.query("compose", models, [item.line for item in runnable], extra)
            except TaggerQueryError as error:
                raise _query_error(error) from None
        by_path = {line["path"]: line for line in lines if line.get("type") == "result"}
        tagger_tags: dict[str, list[str]] = {}
        for item in runnable:
            result = by_path.get(item.path)
            if result is None:
                unavailable[item.asset_id] = "no_tagger_result"
            elif result.get("status") != "ok":
                unavailable[item.asset_id] = str(result.get("status") or "no_tagger_result")
            else:
                tagger_tags[item.asset_id] = parse_caption(str(result.get("caption") or ""))
        header = next((line for line in lines if line.get("type") == "models"), None)
        params = {
            "models": models,
            "thresholds": thresholds,
            "categories": list(categories or ()),
            "keep_underscores": keep_underscores,
            "escape_parens": escape_parens,
            "effective": {
                model["key"]: {
                    "fingerprint": model.get("fingerprint", ""),
                    "thresholds": model.get("thresholds", {}),
                    "selected_categories": model.get("selected_categories", []),
                }
                for model in (header or {}).get("models", ())
            },
        }
        return await asyncio.to_thread(
            self._captions.apply_tagger,
            dataset_id,
            tagger_tags=tagger_tags,
            unavailable=unavailable,
            asset_ids=[item.asset_id for item in inputs],
            mode=mode,
            params=params,
            dry_run=dry_run,
            sample_limit=sample_limit,
        )


def _file_signature(path: Path, suffix: str) -> str:
    try:
        stat = os.stat(f"{path}{suffix}")
    except OSError:
        return "missing"
    return f"{stat.st_dev}:{stat.st_ino}:{stat.st_size}:{stat.st_mtime_ns}"


def accepts_gzip(header: str | None) -> bool:
    """Accept-Encoding 里 gzip（或 *）的 q 值大于 0。"""
    for part in (header or "").split(","):
        coding, *params = (piece.strip() for piece in part.split(";"))
        if coding.lower() not in {"gzip", "*"}:
            continue
        quality = 1.0
        for param in params:
            name, _, value = param.partition("=")
            if name.strip().lower() == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0.0
        return quality > 0
    return False


def gzip_worthwhile(body: bytes) -> bool:
    return len(body) >= _GZIP_MIN_BYTES


__all__ = [
    "CANDIDATE_FLOOR",
    "CAPTION_MODES",
    "CandidatePayload",
    "DatasetTaggingService",
    "TagInput",
    "accepts_gzip",
    "gzip_worthwhile",
]
