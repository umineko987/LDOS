"""阈值筛选与训练标注导出。

筛选作用于完整分数（与推理解耦，改策略不重跑推理）：
- general/character 等多标签类别按阈值截取，保持词表顺序；
- rating 类默认取 argmax（四个互斥档位取把握最大者）。

导出为 SD 训练集惯用的同名 txt（image.png -> image.txt）。
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np

from vocabulary import Vocabulary

_PLAIN_TAG = re.compile(r"^[a-z0-9_]+$")


@dataclass(frozen=True, slots=True)
class SelectionPolicy:
    thresholds: Mapping[str, float]
    categories: tuple[str, ...] = ("general", "character")
    rating_mode: str = "argmax"  # "argmax" | "threshold"

    @property
    def fingerprint(self) -> str:
        digest = hashlib.sha256()
        digest.update(self.rating_mode.encode())
        for category in sorted(self.thresholds):
            digest.update(f"{category}:{self.thresholds[category]!r}".encode())
        for category in self.categories:
            digest.update(category.encode())
        return digest.hexdigest()


def select(
    scores: np.ndarray,
    vocabulary: Vocabulary,
    policy: SelectionPolicy,
) -> list[dict[str, float]]:
    """单张图的分数 -> 按类别的 {tag: score}，只含选中类别与过阈值的标签。"""
    if scores.shape != (len(vocabulary),):
        raise ValueError(f"分数形状 {scores.shape} 与词表 {len(vocabulary)} 不一致")
    selected: dict[str, dict[str, float]] = {}
    for category in policy.categories:
        positions = vocabulary.category_index.get(category)
        if positions is None or positions.size == 0:
            continue
        if category == "rating" and policy.rating_mode == "argmax":
            block = scores[positions]
            best = int(np.argmax(block))
            selected[category] = {
                vocabulary.names[int(positions[best])]: float(block[best])
            }
            continue
        threshold = float(policy.thresholds.get(category, 0.5))
        picked: dict[str, float] = {}
        for position in positions:
            score = float(scores[position])
            if score >= threshold:
                picked[vocabulary.names[position]] = score
        if picked:
            selected[category] = picked
    return [selected.get(category, {}) for category in policy.categories]


def caption_from_tags(
    categories: Sequence[dict[str, float]],
    *,
    underscore_to_space: bool = True,
    escape_parens: bool = False,
) -> str:
    """按类别顺序拼 caption；仅普通标签做下划线转空格（kaomoji/符号标签原样）。"""
    parts: list[str] = []
    for tags in categories:
        for name in tags:
            tag = name.replace("_", " ") if underscore_to_space and _PLAIN_TAG.match(name) else name
            if escape_parens:
                tag = tag.replace("(", "\\(").replace(")", "\\)")
            parts.append(tag)
    return ", ".join(parts)


def write_caption_file(image_path: os.PathLike | str, caption: str, *, overwrite: bool = False) -> bool:
    """写同名 txt；默认不覆盖已有文件。返回是否写入。"""
    path = os.fspath(image_path)
    caption_path = os.path.splitext(path)[0] + ".txt"
    if not overwrite and os.path.exists(caption_path):
        return False
    temporary = caption_path + ".tmp"
    with open(temporary, "w", encoding="utf-8", newline="\n") as file_obj:
        file_obj.write(caption)
    os.replace(temporary, caption_path)
    return True
