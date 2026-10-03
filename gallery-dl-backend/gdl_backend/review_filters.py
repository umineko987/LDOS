"""Review filter contract, explicit offline capability gates and exclusions."""
from __future__ import annotations

import hashlib
import json
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .review_filter_models import (
    CCIP_REJECT_DISTANCE, MODEL_FILES, MONO_REJECT_SCORE, FilterModels, model_paths, rgb_image,
)

BUILTIN_PRESETS = (
    {"id": "builtin-style", "name": "画风", "builtin": True, "options": {
        "basic_dedup": True, "filter_monochrome": True, "filter_sketch": True,
        "filter_character": False, "similarity_groups": True, "reference_asset_ids": [],
    }},
    {"id": "builtin-character", "name": "角色", "builtin": True, "options": {
        "basic_dedup": True, "filter_monochrome": False, "filter_sketch": False,
        "filter_character": True, "similarity_groups": True, "reference_asset_ids": [],
    }},
)
FILTER_MODELS = {"filter_monochrome": "monochrome", "filter_character": "ccip"}
SKETCH_BLOCKER = "素描检测暂缓，尚无已接入的可靠模型；单色分类器不能代替素描检测"
FILTER_BLOCKERS = {
    "filter_monochrome": "单色过滤模型及去重 ONNX 环境尚未验证，请先准备模型",
    "filter_sketch": SKETCH_BLOCKER,
    "filter_character": "CCIP 模型及去重 ONNX 环境尚未验证，请先准备模型",
}
_probe_cache: dict[tuple, tuple[float, dict]] = {}
_probe_lock = threading.Lock()


class FilterConfigurationError(ValueError):
    def __init__(self, code: str, message: str, *, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


def filter_capabilities(model_dir: Path | None = None, python_executable: Path | None = None,
                        *, selected: list[str] | None = None, refresh: bool = False) -> dict[str, dict[str, Any]]:
    result = {option: {"available": False, "reason": reason} for option, reason in FILTER_BLOCKERS.items()}
    if model_dir is None or python_executable is None:
        return result
    names = selected if selected is not None else list(MODEL_FILES)
    candidates = []
    fingerprints = []
    for name in names:
        paths = model_paths(model_dir, name)
        try:
            stats = [path.stat() for path in paths]
            complete = all(stat.st_size == entry[1] for stat, entry in zip(stats, MODEL_FILES[name]))
        except OSError:
            complete = False
        if not complete:
            option = next(option for option, model in FILTER_MODELS.items() if model == name)
            result[option] = {"available": False, "reason": f"缺少或损坏的 {name} 模型，请先准备模型"}
        if complete:
            candidates.append(name)
            fingerprints.extend((str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns) for path, stat in zip(paths, stats))
    if not candidates:
        return result
    try:
        stat = python_executable.stat()
        fingerprints.append((str(python_executable), stat.st_size, stat.st_mtime_ns))
    except OSError:
        return result
    key = (tuple(candidates), tuple(fingerprints))
    # Status polls share a short cache; task creation and installation force a new
    # checksum + execution check. No ONNX imports/sessions in the API process.
    with _probe_lock:
        cached = _probe_cache.get(key)
        if not refresh and cached and time.monotonic() - cached[0] < 30:
            return {option: dict(value) for option, value in cached[1].items()}
        try:
            completed = subprocess.run(
                [str(python_executable), str(Path(__file__).with_name("review_filter_models.py")),
                 "--model-dir", str(model_dir), "--models", *candidates],
                capture_output=True, text=True, encoding="utf-8", timeout=60, check=False,
            )
            data = json.loads(completed.stdout)
            if completed.returncode not in (0, 1) or set(data) != set(candidates):
                raise ValueError("invalid model probe")
            for option, name in FILTER_MODELS.items():
                if name not in data:
                    continue
                capability = data[name]
                if (set(capability) != {"available", "reason"} or type(capability["available"]) is not bool or
                        not isinstance(capability["reason"], str) or
                        (not capability["available"] and not capability["reason"])):
                    raise ValueError("invalid model capability")
                result[option] = capability
            if (completed.returncode == 0) != all(data[name]["available"] for name in candidates):
                raise ValueError("inconsistent model probe")
        except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError):
            for option, name in FILTER_MODELS.items():
                if name in candidates:
                    result[option] = {"available": False, "reason": "去重 Python 模型检查失败，请检查运行依赖和模型"}
        _probe_cache.clear()
        _probe_cache[key] = (time.monotonic(), result)
    return {option: dict(value) for option, value in result.items()}


def require_filter_capabilities(options: dict[str, Any], model_dir: Path | None = None,
                                python_executable: Path | None = None) -> FilterModels | None:
    selected = [name for option, name in FILTER_MODELS.items() if options[option]]
    if options["filter_sketch"]:
        raise FilterConfigurationError("review_filter_unavailable", SKETCH_BLOCKER,
                                       details={"filters": [{"option": "filter_sketch", "reason": SKETCH_BLOCKER}]})
    if not selected:
        return None
    capabilities = filter_capabilities()
    if model_dir is not None:
        if python_executable is None:
            # Worker: load only the enabled models, once, before the fixed pipeline.
            try:
                return FilterModels(model_dir, selected)
            except ImportError:
                reason = "去重 Python 缺少 ONNX 运行依赖，请更新去重环境"
            except Exception:
                reason = "过滤模型缺失、校验或 CPU 推理失败，请重新准备模型"
            for option in FILTER_MODELS:
                if options[option]:
                    capabilities[option] = {"available": False, "reason": reason}
        else:
            capabilities = filter_capabilities(model_dir, python_executable, selected=selected, refresh=True)
    blocked = [{"option": option, "reason": status["reason"]}
               for option, status in capabilities.items() if options[option] and not status["available"]]
    if blocked:
        raise FilterConfigurationError("review_filter_unavailable", "启用的自动过滤尚不可用：" + "；".join(item["reason"] for item in blocked), details={"filters": blocked})
    return None


def filter_images(image_infos: list[dict[str, Any]], options: dict[str, Any], references: list[Any],
                  *, models: FilterModels | None = None, model_dir: Path | None = None,
                  open_image: Callable | None = None) -> list[dict[str, Any]]:
    """Exclude once per surviving image; decode held inputs, never client paths.

    Multi-frame/undecodable selected inputs are retained for human review. Invalid
    references abort rather than silently shrinking the user's explicit reference set.
    CCIP distances are not probabilities; single-anime-character domain only.
    """
    if options["filter_character"] and not references:
        raise FilterConfigurationError("filter_reference_required", "角色过滤必须指定有效参考图")
    if models is None:
        models = require_filter_capabilities(options, model_dir)
    if models is None:
        return []
    from PIL import Image
    open_image = open_image or Image.open
    features = {}
    def feature(image):
        image = rgb_image(image)
        key = (image.size, hashlib.sha256(image.tobytes()).digest())
        if key not in features:
            features[key] = models.feature(image)
        return features[key]
    reference_features = []
    if options["filter_character"]:
        for reference in references:
            if getattr(reference, "n_frames", reference.info.get("ldos_frames", 1)) != 1:
                raise FilterConfigurationError("filter_reference_invalid", "角色参考图必须是可解码的静态图片")
            reference_features.append(feature(reference))
    exclusions = []
    for info in image_infos:
        if info.get("frames", 1) != 1:
            continue
        try:
            with open_image(info["path"]) as image:
                if getattr(image, "n_frames", 1) != 1:
                    continue
                image = rgb_image(image)
        except (OSError, ValueError, Image.DecompressionBombError):
            continue
        reason = None
        if options["filter_monochrome"] and models.monochrome_score(image) >= MONO_REJECT_SCORE:
            reason = "filter_monochrome"
        elif options["filter_character"]:
            distances = models.distances(feature(image), reference_features)
            # OR references: any match OR any conservative-band case retains it.
            if len(distances) and bool((distances > CCIP_REJECT_DISTANCE).all()):
                reason = "filter_character"
        if reason:
            exclusions.append({"image": info, "reason": reason})
    return exclusions
