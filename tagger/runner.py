"""批量打标执行器。

职责：把"文件列表 + 模型集合 + 策略"变成"分数入库 + 筛选入库 + 同名 caption"。
- 文件身份 = 内容 SHA256，与路径无关：同一张图挪动位置不会重打；
- 多模型同批：按"任一模型缺结果"的并集分块，每块只解码一次，
  各模型在块内挑自己缺的子批推理；
- 解码预取：推理当前块时预解码下一块，窗口有界避免内存堆积；
- 改策略只重算筛选层，绝不重新推理。

caption 输出：按模型选择顺序合并标签，重复标签跳过，新标签追加；
每张图片只写一个同名 .txt。
"""

from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable, Sequence

from adapters import WdOnnxAdapter
from cache import TaggerCache
from postprocess import SelectionPolicy, caption_from_tags, select, write_caption_file
from preprocess import load_image
from specs import SPECS, TaggerModelSpec

RunProgressCallback = Callable[[str, int, int], None]  # (阶段, 已完成, 总数)


@dataclass(slots=True)
class ModelRunStats:
    inferred: int = 0
    score_cache_hits: int = 0
    selected_cache_hits: int = 0


@dataclass(slots=True)
class RunStats:
    total: int = 0
    decode_errors: list[str] = field(default_factory=list)
    captions_written: int = 0
    captions_skipped: int = 0
    per_model: dict[str, ModelRunStats] = field(default_factory=dict)


def file_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as file_obj:
        while chunk := file_obj.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def default_adapter_factory(spec: TaggerModelSpec, model_dir: Path):
    from adapters import ADAPTERS

    if spec.adapter not in ADAPTERS:
        raise KeyError(f"未知适配器类型: {spec.adapter}")
    return ADAPTERS[spec.adapter](spec, model_dir)


class TaggerRunner:
    def __init__(
        self,
        model_dir: Path,
        cache: TaggerCache,
        specs: Sequence[TaggerModelSpec],
        *,
        adapter_factory=default_adapter_factory,
        batch_size: int = 8,
        decode_workers: int = 4,
    ):
        if not specs:
            raise ValueError("至少选择一个模型")
        self.model_dir = Path(model_dir)
        self.cache = cache
        self.specs = list(specs)
        self.adapter_factory = adapter_factory
        self.batch_size = max(1, batch_size)
        self.decode_workers = max(1, decode_workers)

    def _effective_policy(
        self, spec: TaggerModelSpec, policy: SelectionPolicy, overrides: dict[str, float],
    ) -> SelectionPolicy:
        # 模型独立设置优先；未覆盖的类别保留 CLI 全局设置或模型默认值。
        merged = {**spec.default_thresholds, **policy.thresholds, **overrides}
        return replace(policy, thresholds=merged)

    def run(
        self,
        files: Sequence[Path],
        policy: SelectionPolicy,
        *,
        model_thresholds: dict[str, dict[str, float]] | None = None,
        write_captions: bool = True,
        overwrite_captions: bool = False,
        on_progress: RunProgressCallback | None = None,
    ) -> RunStats:
        paths = [Path(item) for item in files]
        stats = RunStats(total=len(paths))
        adapters = []
        try:
            for spec in self.specs:
                adapter = self.adapter_factory(spec, self.model_dir)
                adapter.load()
                adapters.append(adapter)
                stats.per_model[spec.key] = ModelRunStats()

            on_progress and on_progress("hashing", 0, len(paths))
            hashes: list[str] = []
            for position, path in enumerate(paths):
                hashes.append(file_sha256(path))
                on_progress and on_progress("hashing", position + 1, len(paths))

            self._infer_missing(paths, hashes, adapters, stats, on_progress)
            self._select_and_write(
                paths, hashes, adapters, policy, stats,
                model_thresholds=model_thresholds or {},
                write_captions=write_captions,
                overwrite_captions=overwrite_captions,
                on_progress=on_progress,
            )
        finally:
            for adapter in adapters:
                adapter.close()
        return stats

    def _infer_missing(
        self,
        paths: list[Path],
        hashes: list[str],
        adapters: list,
        stats: RunStats,
        on_progress: RunProgressCallback | None,
    ) -> None:
        missing: list[set[str]] = []
        for adapter in adapters:
            missing.append({
                file_hash for file_hash in hashes
                if self.cache.get_scores(adapter.fingerprint, file_hash) is None
            })
        union = [
            position for position, file_hash in enumerate(hashes)
            if any(file_hash in needed for needed in missing)
        ]
        if not union:
            for adapter, spec_stats, needed in zip(adapters, stats.per_model.values(), missing):
                spec_stats.score_cache_hits = len(hashes) - len(needed)
            return

        total = len(union)
        on_progress and on_progress("inferring", 0, total)
        window = self.batch_size * 3
        with ThreadPoolExecutor(max_workers=self.decode_workers) as pool:
            futures: dict[int, object] = {}
            submitted = 0
            consumed = 0

            def submit_next() -> None:
                nonlocal submitted
                if submitted < total:
                    futures[union[submitted]] = pool.submit(load_image, paths[union[submitted]])
                    submitted += 1

            for _ in range(min(window, total)):
                submit_next()
            while consumed < total:
                positions = union[consumed:consumed + self.batch_size]
                batch = []
                for position in positions:
                    future = futures.pop(position)
                    try:
                        batch.append((position, future.result()))
                    except Exception:
                        stats.decode_errors.append(str(paths[position]))
                    consumed += 1
                    submit_next()
                try:
                    for adapter, needed in zip(adapters, missing):
                        pending = [(hashes[position], image) for position, image in batch if hashes[position] in needed]
                        if not pending:
                            continue
                        scores = adapter.infer_scores([image for _, image in pending])
                        self.cache.put_scores(adapter.fingerprint, list(zip((digest for digest, _ in pending), scores, strict=True)))
                        stats.per_model[adapter.spec.key].inferred += len(pending)
                finally:
                    for _, image in batch:
                        image.close()
                on_progress and on_progress("inferring", consumed, total)
        for adapter, spec_stats, needed in zip(adapters, stats.per_model.values(), missing):
            spec_stats.score_cache_hits = len(hashes) - len(needed)

    def _select_and_write(
        self,
        paths: list[Path],
        hashes: list[str],
        adapters: list,
        policy: SelectionPolicy,
        stats: RunStats,
        *,
        model_thresholds: dict[str, dict[str, float]],
        write_captions: bool,
        overwrite_captions: bool,
        on_progress: RunProgressCallback | None,
    ) -> None:
        on_progress and on_progress("selecting", 0, len(paths))
        pending: list[tuple[int, str]] = []
        for position, file_hash in enumerate(hashes):
            if str(paths[position]) in stats.decode_errors:
                continue
            pending.append((position, file_hash))
        for position, _file_hash in pending:
            merged_categories: list[dict[str, float]] = []
            for adapter in adapters:
                effective = self._effective_policy(adapter.spec, policy, model_thresholds.get(adapter.spec.key, {}))
                scores = self.cache.get_scores(adapter.fingerprint, hashes[position])
                if scores is None:
                    continue
                cached = self.cache.get_selected(adapter.fingerprint, effective.fingerprint, hashes[position])
                if cached is not None:
                    stats.per_model[adapter.spec.key].selected_cache_hits += 1
                    categories = cached
                else:
                    categories = select(scores, adapter.vocabulary, effective)
                    self.cache.put_selected(
                        adapter.fingerprint,
                        effective.fingerprint,
                        [(hashes[position], categories)],
                    )
                if write_captions:
                    merged_categories.extend(categories)
            if write_captions:
                caption = caption_from_tags(merged_categories)
                if write_caption_file(paths[position], caption, overwrite=overwrite_captions):
                    stats.captions_written += 1
                else:
                    stats.captions_skipped += 1
            on_progress and on_progress("selecting", position + 1, len(paths))


def resolve_specs(keys: Sequence[str]) -> list[TaggerModelSpec]:
    unknown = [key for key in keys if key not in SPECS]
    if unknown:
        raise KeyError(f"未登记的打标模型: {', '.join(unknown)}")
    return [SPECS[key] for key in dict.fromkeys(keys)]
