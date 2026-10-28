"""批量打标执行器与只读分数查询。

职责：把"文件列表 + 模型集合 + 策略"变成"分数入库 + 筛选入库 + 同名 caption"。
- 文件身份 = 内容 SHA256，与路径无关：同一张图挪动位置不会重打；
- 先 describe()（只读词表）拿到指纹查缓存，只有确实缺分数的模型才加载权重；
- 多模型同批：按"任一模型缺结果"的并集分块，每块只解码一次，
  各模型在块内挑自己缺的子批推理；
- 解码预取：推理当前块时预解码下一块，窗口有界避免内存堆积；
- 改策略只重算筛选层，绝不重新推理。

caption 输出：按模型选择顺序合并标签，重复标签跳过，新标签追加；
每张图片只写一个同名 .txt。

只读查询（不写任何文件）：
- run_candidates：从缓存取稀疏候选分数，供前端实时阈值预览；
- run_compose：按策略从缓存的完整分数算出最终 caption 标签列表。
"""

from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable, Iterator, Mapping, Sequence

import numpy as np

from adapters import TaggerAdapterError
from cache import TaggerCache
from postprocess import SelectionPolicy, merge_selections, policy_categories, select, write_caption_file
from preprocess import load_image
from specs import SPECS, TaggerModelSpec
from vocabulary import Vocabulary

RunProgressCallback = Callable[[str, int, int], None]  # (阶段, 已完成, 总数)

# 候选分数下限：低于它的标签不下发（rating 类除外）。前端阈值滑块不能低于它。
DEFAULT_CANDIDATE_FLOOR = 0.05


@dataclass(slots=True)
class ModelRunStats:
    inferred: int = 0
    score_cache_hits: int = 0
    selected_cache_hits: int = 0
    loaded: bool = False  # 是否加载了权重（全部命中缓存时不加载）


@dataclass(slots=True)
class RunStats:
    total: int = 0
    decode_errors: list[str] = field(default_factory=list)
    unreadable: list[str] = field(default_factory=list)
    captions_written: int = 0
    captions_skipped: int = 0
    per_model: dict[str, ModelRunStats] = field(default_factory=dict)


@dataclass(slots=True)
class ImageResult:
    """一张图的最终标签。status: ok | missing_scores | decode_error | unreadable。"""

    path: Path
    sha256: str | None
    status: str
    tags: list[dict] = field(default_factory=list)
    missing_models: list[str] = field(default_factory=list)

    @property
    def caption(self) -> str:
        return ", ".join(tag["text"] for tag in self.tags)

    def to_payload(self) -> dict:
        # 分数只作展示（筛选已在完整精度上完成），统一保留 5 位小数，与 selected 缓存一致
        return {
            "type": "result",
            "path": str(self.path),
            "sha256": self.sha256,
            "status": self.status,
            "missing_models": list(self.missing_models),
            "tags": [{**tag, "score": round(tag["score"], 5)} for tag in self.tags],
            "caption": self.caption,
        }


@dataclass(frozen=True, slots=True)
class LookupInput:
    """查询输入：路径 + 调用方已知的内容哈希（None 表示按内容计算）。"""

    path: Path
    sha256: str | None = None


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


def effective_policy(
    spec: TaggerModelSpec, policy: SelectionPolicy, overrides: Mapping[str, float],
) -> SelectionPolicy:
    """模型独立设置优先；未覆盖的类别用全局设置，再退到模型默认值。"""
    merged = {**spec.default_thresholds, **policy.thresholds, **overrides}
    return replace(policy, thresholds=merged)


def _named_selection(model: str, vocabulary: Vocabulary, policy: SelectionPolicy, categories: list[dict]):
    return ((model, category, tags) for category, tags in zip(policy_categories(vocabulary, policy), categories))


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
        return effective_policy(spec, policy, overrides)

    def run(
        self,
        files: Sequence[Path],
        policy: SelectionPolicy,
        *,
        model_thresholds: dict[str, dict[str, float]] | None = None,
        write_captions: bool = True,
        overwrite_captions: bool = False,
        underscore_to_space: bool = True,
        escape_parens: bool = False,
        on_progress: RunProgressCallback | None = None,
        on_result: Callable[[ImageResult], None] | None = None,
    ) -> RunStats:
        paths = [Path(item) for item in files]
        stats = RunStats(total=len(paths))
        adapters = []
        try:
            for spec in self.specs:
                adapter = self.adapter_factory(spec, self.model_dir)
                adapter.describe()
                adapters.append(adapter)
                stats.per_model[spec.key] = ModelRunStats()

            on_progress and on_progress("hashing", 0, len(paths))
            hashes: list[str | None] = []
            for position, path in enumerate(paths):
                try:
                    hashes.append(file_sha256(path))
                except OSError:
                    hashes.append(None)
                    stats.unreadable.append(str(path))
                on_progress and on_progress("hashing", position + 1, len(paths))

            self._infer_missing(paths, hashes, adapters, stats, on_progress)
            self._select_and_write(
                paths, hashes, adapters, policy, stats,
                model_thresholds=model_thresholds or {},
                write_captions=write_captions,
                overwrite_captions=overwrite_captions,
                underscore_to_space=underscore_to_space,
                escape_parens=escape_parens,
                on_progress=on_progress,
                on_result=on_result,
            )
        finally:
            for adapter in adapters:
                adapter.close()
        return stats

    def _infer_missing(
        self,
        paths: list[Path],
        hashes: list[str | None],
        adapters: list,
        stats: RunStats,
        on_progress: RunProgressCallback | None,
    ) -> None:
        readable = [file_hash for file_hash in hashes if file_hash is not None]
        missing: list[set[str]] = []
        for adapter in adapters:
            missing.append({
                file_hash for file_hash in readable
                if self.cache.get_scores(adapter.fingerprint, file_hash) is None
            })
        for adapter, needed in zip(adapters, missing):
            stats.per_model[adapter.spec.key].score_cache_hits = len(readable) - len(needed)
        union = [
            position for position, file_hash in enumerate(hashes)
            if file_hash is not None and any(file_hash in needed for needed in missing)
        ]
        if not union:
            return

        for adapter, needed in zip(adapters, missing):
            if not needed:
                continue
            described = adapter.fingerprint
            adapter.load()
            stats.per_model[adapter.spec.key].loaded = True
            if adapter.fingerprint != described:
                raise TaggerAdapterError(f"{adapter.spec.key} 的 describe() 与 load() 指纹不一致")

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

    def _select_and_write(
        self,
        paths: list[Path],
        hashes: list[str | None],
        adapters: list,
        policy: SelectionPolicy,
        stats: RunStats,
        *,
        model_thresholds: dict[str, dict[str, float]],
        write_captions: bool,
        overwrite_captions: bool,
        underscore_to_space: bool,
        escape_parens: bool,
        on_progress: RunProgressCallback | None,
        on_result: Callable[[ImageResult], None] | None,
    ) -> None:
        on_progress and on_progress("selecting", 0, len(paths))
        failed = set(stats.decode_errors)
        merging = write_captions or on_result is not None
        for position, file_hash in enumerate(hashes):
            path = paths[position]
            if file_hash is None:
                on_result and on_result(ImageResult(path, None, "unreadable", missing_models=[a.spec.key for a in adapters]))
                continue
            if str(path) in failed:
                on_result and on_result(ImageResult(path, file_hash, "decode_error", missing_models=[a.spec.key for a in adapters]))
                continue
            selections = []
            missing_models: list[str] = []
            for adapter in adapters:
                effective = self._effective_policy(adapter.spec, policy, model_thresholds.get(adapter.spec.key, {}))
                scores = self.cache.get_scores(adapter.fingerprint, file_hash)
                if scores is None:
                    missing_models.append(adapter.spec.key)
                    continue
                cached = self.cache.get_selected(adapter.fingerprint, effective.fingerprint, file_hash)
                if cached is not None:
                    stats.per_model[adapter.spec.key].selected_cache_hits += 1
                    categories = cached
                else:
                    categories = select(scores, adapter.vocabulary, effective)
                    self.cache.put_selected(
                        adapter.fingerprint,
                        effective.fingerprint,
                        [(file_hash, categories)],
                    )
                if merging:
                    selections.extend(_named_selection(adapter.spec.key, adapter.vocabulary, effective, categories))
            merged = merge_selections(
                selections, underscore_to_space=underscore_to_space, escape_parens=escape_parens,
            ) if merging else []
            if write_captions:
                caption = ", ".join(tag["text"] for tag in merged)
                if write_caption_file(path, caption, overwrite=overwrite_captions):
                    stats.captions_written += 1
                else:
                    stats.captions_skipped += 1
            if on_result is not None:
                on_result(ImageResult(path, file_hash, "missing_scores" if missing_models else "ok", merged, missing_models))
            on_progress and on_progress("selecting", position + 1, len(paths))


def resolve_specs(keys: Sequence[str]) -> list[TaggerModelSpec]:
    unknown = [key for key in keys if key not in SPECS]
    if unknown:
        raise KeyError(f"未登记的打标模型: {', '.join(unknown)}")
    return [SPECS[key] for key in dict.fromkeys(keys)]


# ---- 只读查询 ----


def sparse_candidates(scores: np.ndarray, vocabulary: Vocabulary, floor: float) -> list[list]:
    """词表顺序的 [标签, 类别, 分数]。

    保留 float64(分数) >= floor 的标签；rating 类全部保留（argmax 需要完整档位）。
    分数是 float32 无损扩成的 float64，JSON 里的十进制表示可被 JS 精确还原。
    """
    widened = np.asarray(scores, dtype=np.float32).astype(np.float64)
    keep = widened >= floor
    rating = vocabulary.category_index.get("rating")
    if rating is not None:
        keep[rating] = True
    return [
        [vocabulary.names[position], vocabulary.category_of[position], float(widened[position])]
        for position in np.flatnonzero(keep).tolist()
    ]


def hash_inputs(inputs: Sequence[LookupInput], on_progress: RunProgressCallback | None = None) -> list[LookupInput]:
    """补齐内容哈希；调用方给出的哈希原样采用，读不了的文件哈希为 None。"""
    total = len(inputs)
    on_progress and on_progress("hashing", 0, total)
    resolved: list[LookupInput] = []
    for position, item in enumerate(inputs):
        digest = item.sha256
        if digest is None:
            try:
                digest = file_sha256(item.path)
            except OSError:
                digest = None
        resolved.append(LookupInput(item.path, digest))
        on_progress and on_progress("hashing", position + 1, total)
    return resolved


class ScoreLookup:
    """只读：所有模型只 describe()（不加载权重），按内容哈希从缓存取完整分数。"""

    def __init__(
        self,
        model_dir: Path,
        cache: TaggerCache,
        specs: Sequence[TaggerModelSpec],
        *,
        adapter_factory=default_adapter_factory,
    ):
        if not specs:
            raise ValueError("至少选择一个模型")
        self.cache = cache
        self.adapters = []
        try:
            for spec in specs:
                adapter = adapter_factory(spec, Path(model_dir))
                adapter.describe()
                self.adapters.append(adapter)
        except Exception:
            self.close()
            raise

    @property
    def keys(self) -> list[str]:
        return [adapter.spec.key for adapter in self.adapters]

    def models(self) -> list[dict]:
        return [
            {
                "key": adapter.spec.key,
                "adapter": adapter.spec.adapter,
                "revision": adapter.spec.revision,
                "fingerprint": adapter.fingerprint,
                "vocabulary_fingerprint": adapter.vocabulary.fingerprint,
                "vocabulary_size": len(adapter.vocabulary),
                "categories": list(adapter.vocabulary.category_index),
                "default_thresholds": dict(adapter.spec.default_thresholds),
            }
            for adapter in self.adapters
        ]

    def _scores(self, adapter, file_hash: str) -> np.ndarray | None:
        scores = self.cache.get_scores(adapter.fingerprint, file_hash)
        if scores is None or scores.shape != (len(adapter.vocabulary),):
            return None
        return scores

    def missing_models(self, file_hash: str) -> list[str]:
        return [adapter.spec.key for adapter in self.adapters if self._scores(adapter, file_hash) is None]

    def candidates(self, item: LookupInput, floor: float) -> dict:
        line = {"type": "candidates", "path": str(item.path), "sha256": item.sha256, "models": {}, "missing_models": []}
        if item.sha256 is None:
            return {**line, "status": "unreadable", "missing_models": self.keys}
        for adapter in self.adapters:
            scores = self._scores(adapter, item.sha256)
            if scores is None:
                line["missing_models"].append(adapter.spec.key)
            else:
                line["models"][adapter.spec.key] = sparse_candidates(scores, adapter.vocabulary, floor)
        return {**line, "status": "missing_scores" if line["missing_models"] else "ok"}

    def compose(
        self,
        item: LookupInput,
        policy: SelectionPolicy,
        model_thresholds: Mapping[str, Mapping[str, float]],
        *,
        underscore_to_space: bool = True,
        escape_parens: bool = False,
    ) -> ImageResult:
        if item.sha256 is None:
            return ImageResult(item.path, None, "unreadable", missing_models=self.keys)
        selections = []
        missing: list[str] = []
        for adapter in self.adapters:
            scores = self._scores(adapter, item.sha256)
            if scores is None:
                missing.append(adapter.spec.key)
                continue
            effective = effective_policy(adapter.spec, policy, model_thresholds.get(adapter.spec.key, {}))
            categories = select(scores, adapter.vocabulary, effective)
            selections.extend(_named_selection(adapter.spec.key, adapter.vocabulary, effective, categories))
        merged = merge_selections(selections, underscore_to_space=underscore_to_space, escape_parens=escape_parens)
        return ImageResult(item.path, item.sha256, "missing_scores" if missing else "ok", merged, missing)

    def close(self) -> None:
        for adapter in self.adapters:
            adapter.close()


def _status_counts(statuses: Sequence[str]) -> dict[str, int]:
    counts = dict.fromkeys(("ok", "missing_scores", "decode_error", "unreadable"), 0)
    for status in statuses:
        counts[status] += 1
    return counts


def run_candidates(
    model_dir: Path,
    cache: TaggerCache,
    specs: Sequence[TaggerModelSpec],
    inputs: Sequence[LookupInput],
    *,
    floor: float = DEFAULT_CANDIDATE_FLOOR,
    compute: bool = False,
    batch_size: int = 8,
    adapter_factory=default_adapter_factory,
    on_progress: RunProgressCallback | None = None,
) -> Iterator[dict]:
    """产出 JSON 行：models 头 → 每张图一行 candidates → done。

    compute=True 时先为缺分数的图推理入库；推理会写缓存，所以此时
    一律按内容重算哈希，忽略调用方给的哈希。
    """
    lookup = ScoreLookup(model_dir, cache, specs, adapter_factory=adapter_factory)
    try:
        yield {"type": "models", "floor": floor, "models": lookup.models()}
        if compute:
            inputs = [LookupInput(item.path) for item in inputs]
        resolved = hash_inputs(inputs, on_progress)
        inferred: dict[str, int] = {}
        decode_errors: set[str] = set()
        if compute:
            needing = [item.path for item in resolved if item.sha256 and lookup.missing_models(item.sha256)]
            if needing:
                runner = TaggerRunner(model_dir, cache, specs, adapter_factory=adapter_factory, batch_size=batch_size)
                stats = runner.run(needing, SelectionPolicy(thresholds={}), write_captions=False, on_progress=on_progress)
                inferred = {key: model_stats.inferred for key, model_stats in stats.per_model.items()}
                decode_errors = set(stats.decode_errors)
        statuses = []
        for item in resolved:
            line = lookup.candidates(item, floor)
            if str(item.path) in decode_errors:
                line["status"] = "decode_error"
            statuses.append(line["status"])
            yield line
        yield {"type": "done", "command": "candidates", "total": len(resolved), **_status_counts(statuses), "inferred": inferred}
    finally:
        lookup.close()


def run_compose(
    model_dir: Path,
    cache: TaggerCache,
    specs: Sequence[TaggerModelSpec],
    inputs: Sequence[LookupInput],
    policy: SelectionPolicy,
    *,
    model_thresholds: Mapping[str, Mapping[str, float]] | None = None,
    underscore_to_space: bool = True,
    escape_parens: bool = False,
    adapter_factory=default_adapter_factory,
    on_progress: RunProgressCallback | None = None,
) -> Iterator[dict]:
    """产出 JSON 行：models 头（含各模型生效阈值）→ 每张图一行 result → done。不写文件。"""
    overrides = model_thresholds or {}
    lookup = ScoreLookup(model_dir, cache, specs, adapter_factory=adapter_factory)
    try:
        models = lookup.models()
        for entry, adapter in zip(models, lookup.adapters):
            effective = effective_policy(adapter.spec, policy, overrides.get(adapter.spec.key, {}))
            entry["thresholds"] = dict(effective.thresholds)
            entry["selected_categories"] = list(policy_categories(adapter.vocabulary, effective))
        yield {"type": "models", "models": models}
        statuses = []
        for item in hash_inputs(inputs, on_progress):
            result = lookup.compose(
                item, policy, overrides, underscore_to_space=underscore_to_space, escape_parens=escape_parens,
            )
            statuses.append(result.status)
            yield result.to_payload()
        yield {"type": "done", "command": "compose", "total": len(statuses), **_status_counts(statuses)}
    finally:
        lookup.close()
