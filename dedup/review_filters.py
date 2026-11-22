"""Worker-local filter inference; configuration and orchestration belong to Go."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Callable

if __package__:
    from .review_filter_models import CCIP_REJECT_DISTANCE, FilterModels, rgb_image
else:
    from review_filter_models import CCIP_REJECT_DISTANCE, FilterModels, rgb_image

FILTER_MODELS = {"filter_monochrome": "monochrome", "filter_sketch": "completeness", "filter_character": "ccip"}


class FilterConfigurationError(ValueError):
    def __init__(self, code: str, message: str, *, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


def require_filter_capabilities(options: dict[str, Any], model_dir: Path | None = None) -> FilterModels | None:
    """Load only enabled local models once, without probing another process."""
    selected = list(dict.fromkeys(name for option, name in FILTER_MODELS.items() if options[option]))
    if not selected:
        return None
    reason = "过滤模型缺失、校验或 CPU 推理失败，请重新准备模型"
    if model_dir is not None:
        try:
            return FilterModels(model_dir, selected)
        except ImportError:
            reason = "去重 Python 缺少 ONNX 运行依赖，请更新去重环境"
        except Exception:
            pass
    blocked = [{"option": option, "reason": reason} for option in FILTER_MODELS if options[option]]
    raise FilterConfigurationError("review_filter_unavailable", "启用的自动过滤尚不可用：" + "；".join(item["reason"] for item in blocked), details={"filters": blocked})


def filter_images(image_infos: list[dict[str, Any]], options: dict[str, Any], references: list[Any],
                  *, models: FilterModels | None = None, model_dir: Path | None = None,
                  open_image: Callable | None = None) -> list[dict[str, Any]]:
    """Classify for human review; only character mismatches exclude. Decode held inputs.

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
        # The manifest has one review label. Preserve rough when both switches match.
        if options["filter_sketch"] and models.completeness(image) == "rough":
            info["classification"] = "rough"
        elif options["filter_monochrome"] and models.is_monochrome(image):
            info["classification"] = "monochrome"
        if options["filter_character"]:
            distances = models.distances(feature(image), reference_features)
            # OR references: any match OR any conservative-band case retains it.
            if len(distances) and bool((distances > CCIP_REJECT_DISTANCE).all()):
                reason = "filter_character"
        if reason:
            exclusions.append({"image": info, "reason": reason})
    return exclusions
