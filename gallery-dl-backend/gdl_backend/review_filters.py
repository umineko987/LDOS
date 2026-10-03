"""Review filter contract and explicit capability gates (no implicit model downloads)."""
from __future__ import annotations

from typing import Any

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

# Source APIs verified: imgutils.validate.is_monochrome is a trained classifier;
# imgutils.metrics.ccip_extract_feature/ccip_difference require separate ONNX
# feature + metric models and model-specific thresholds. Neither is provisioned
# by LDOS's SSCD/DINO installer. CCIP documents single-character inputs only.
# No reliable ready-made sketch classifier has been confirmed; monochrome is NOT sketch.
FILTER_BLOCKERS = {
    "filter_monochrome": "训练型单色分类器尚未接入：imgutils/ONNX 的锁定版本及模型准备未完成；现有安装器只准备 SSCD/DINO",
    "filter_sketch": "尚未确认可靠的现成素描检测模型；单色分类器不能代替素描检测",
    "filter_character": "CCIP 尚未接入：imgutils/ONNX 的锁定版本及模型准备未完成；多角色图片与显式参考集的判定规则尚未确认",
}


class FilterConfigurationError(ValueError):
    def __init__(self, code: str, message: str, *, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


def filter_capabilities() -> dict[str, dict[str, Any]]:
    return {option: {"available": False, "reason": reason} for option, reason in FILTER_BLOCKERS.items()}


def require_filter_capabilities(options: dict[str, Any]) -> None:
    blocked = [{"option": option, "reason": reason}
               for option, reason in FILTER_BLOCKERS.items() if options[option]]
    if blocked:
        raise FilterConfigurationError("review_filter_unavailable", "启用的自动过滤尚不可用：" + "；".join(item["reason"] for item in blocked), details={"filters": blocked})


def filter_images(image_infos: list[dict[str, Any]], options: dict[str, Any],
                  references: list[Any]) -> list[dict[str, Any]]:
    """Return exclusions as {image: info, reason: filter option}; never invent a winner.

    Until the documented model blockers are resolved, enabled filters fail closed.
    This boundary allows the fixed pipeline/recycling contract to be tested with
    stub classifiers without claiming that any production classifier is ready.
    References must be decoded from held files by the caller, not client paths.
    """
    if options["filter_character"] and not references:
        raise FilterConfigurationError("filter_reference_required", "角色过滤必须指定有效参考图")
    require_filter_capabilities(options)
    return []
