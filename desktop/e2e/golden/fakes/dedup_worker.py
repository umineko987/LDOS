"""去重 worker 替身：照常跑 dedup/dedup_review_worker.py 和 dedup_core.py（配置里关了 SSCD/DINO），
只把完成度过滤模型换成按像素判断，不加载 ONNX：
- 八成以上像素接近白色 → rough（草稿）；
- 每个像素三个通道几乎相等 → monochrome（黑白）；
- 其余 → polished。
角色过滤（CCIP）不支持。
"""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
WORKER = REPO / "dedup" / "dedup_review_worker.py"
sys.path.insert(0, str(WORKER.parent))

from gdl_backend import review_filters  # noqa: E402  后端把 gallery-dl-backend 放进了 PYTHONPATH


class FakeCompleteness:
    def completeness(self, image) -> str:
        pixels = list(image.convert("RGB").getdata())
        white = sum(1 for r, g, b in pixels if min(r, g, b) > 235)
        if white > 0.8 * len(pixels):
            return "rough"
        if all(max(r, g, b) - min(r, g, b) <= 8 for r, g, b in pixels):
            return "monochrome"
        return "polished"


_original = review_filters.require_filter_capabilities


def require_filter_capabilities(options, model_dir=None, python_executable=None):
    # worker 里只传 model_dir：真实实现在这里加载 ONNX 模型。
    if model_dir is not None and python_executable is None and (options["filter_monochrome"] or options["filter_sketch"]):
        if options["filter_character"]:
            raise review_filters.FilterConfigurationError("review_filter_unavailable", "黄金路径不支持角色过滤")
        return FakeCompleteness()
    return _original(options, model_dir, python_executable)


review_filters.require_filter_capabilities = require_filter_capabilities
sys.argv[0] = str(WORKER)
runpy.run_path(str(WORKER), run_name="__main__")
