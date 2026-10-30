"""打标 CLI 替身：照常跑 tagger/cli.py（缓存、筛选、compose 都是真的），
只把 WD 适配器的推理换成按像素算分，不加载 ONNX。词表见 prepare.py 的 VOCABULARY：
- rating：general 0.9，其余 0.05；
- 1girl 0.95、solo 0.9、simple_background 0.6；
- 平均颜色里最大的通道对应的 *_theme 0.8，其余 0.05；
- 角色 golden_hero_(ldos) 0.1（低于默认阈值 0.85）。
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "tagger"))

import numpy as np  # noqa: E402

import adapters  # noqa: E402
import cli  # noqa: E402

FIXED = {"general": 0.9, "1girl": 0.95, "solo": 0.9, "simple_background": 0.6}
THEMES = ("red_theme", "green_theme", "blue_theme")


class FakeWdAdapter(adapters.WdOnnxAdapter):
    def load(self) -> None:
        self.describe()

    def infer_scores(self, images):
        names = self.vocabulary.names
        rows = []
        for image in images:
            means = np.asarray(image.convert("RGB"), dtype=np.float64).reshape(-1, 3).mean(axis=0)
            theme = THEMES[int(np.argmax(means))]
            scores = {**FIXED, theme: 0.8}
            rows.append([scores.get(name, 0.1 if name == "golden_hero_(ldos)" else 0.05) for name in names])
        return np.asarray(rows, dtype=np.float32)

    def close(self) -> None:
        pass


adapters.ADAPTERS["wd_onnx"] = FakeWdAdapter
sys.exit(cli.main())
