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
from typing import Iterable, Mapping, Sequence

import numpy as np

from vocabulary import Vocabulary

_PLAIN_TAG = re.compile(r"^[a-z0-9_]+$")


@dataclass(frozen=True, slots=True)
class SelectionPolicy:
    thresholds: Mapping[str, float]
    categories: tuple[str, ...] = ()
    rating_mode: str = "argmax"  # "argmax" | "threshold"

    @property
    def fingerprint(self) -> str:
        digest = hashlib.sha256()
        digest.update(b"selection:v2")
        digest.update(self.rating_mode.encode())
        for category in sorted(self.thresholds):
            digest.update(f"{category}:{self.thresholds[category]!r}".encode())
        for category in self.categories:
            digest.update(category.encode())
        return digest.hexdigest()


def policy_categories(vocabulary: Vocabulary, policy: SelectionPolicy) -> tuple[str, ...]:
    """select() 输出与之一一对应的类别名：策略显式给出的顺序，否则按词表中类别首次出现的顺序。"""
    return tuple(policy.categories) or tuple(vocabulary.category_index)


def select(
    scores: np.ndarray,
    vocabulary: Vocabulary,
    policy: SelectionPolicy,
) -> list[dict[str, float]]:
    """单张图的分数 -> 按类别的 {tag: score}，只含选中类别与过阈值的标签。

    比较一律在 float64 下做：float32 分数先无损扩成 float64，再与阈值
    （Python float）比较 `score >= threshold`。前端移植版依赖这一点逐位一致。
    """
    if scores.shape != (len(vocabulary),):
        raise ValueError(f"分数形状 {scores.shape} 与词表 {len(vocabulary)} 不一致")
    selected: dict[str, dict[str, float]] = {}
    categories = policy_categories(vocabulary, policy)
    for category in categories:
        positions = vocabulary.category_index.get(category)
        if positions is None or positions.size == 0:
            continue
        block = scores[positions].astype(np.float64)
        if category == "rating" and policy.rating_mode == "argmax":
            best = int(np.argmax(block))
            if float(block[best]) >= float(policy.thresholds.get("rating", 0.0)):
                selected[category] = {
                    vocabulary.names[int(positions[best])]: float(block[best])
                }
            continue
        threshold = float(policy.thresholds.get(category, 0.5))
        picked: dict[str, float] = {}
        for offset in np.flatnonzero(block >= threshold):
            picked[vocabulary.names[int(positions[offset])]] = float(block[offset])
        if picked:
            selected[category] = picked
    return [selected.get(category, {}) for category in categories]


def format_tag(name: str, *, underscore_to_space: bool = True, escape_parens: bool = False) -> str:
    """标签写进 caption 的文本：只有纯 [a-z0-9_] 标签把下划线换成空格，然后按需转义括号。"""
    tag = name.replace("_", " ") if underscore_to_space and _PLAIN_TAG.fullmatch(name) else name
    if escape_parens:
        tag = tag.replace("(", "\\(").replace(")", "\\)")
    return tag


def merge_selections(
    selections: Iterable[tuple[str, str, Mapping[str, float]]],
    *,
    underscore_to_space: bool = True,
    escape_parens: bool = False,
) -> list[dict]:
    """按给定顺序（模型顺序 × 类别顺序 × 词表顺序）合并，按最终文本去重，先出现者保留。

    selections 的每一项是 (模型 key, 类别, {标签: 分数})。
    返回 [{"name", "text", "category", "score", "model"}]。
    """
    merged: list[dict] = []
    seen: set[str] = set()
    for model, category, tags in selections:
        for name, score in tags.items():
            text = format_tag(name, underscore_to_space=underscore_to_space, escape_parens=escape_parens)
            if text in seen:
                continue
            seen.add(text)
            merged.append({"name": name, "text": text, "category": category, "score": float(score), "model": model})
    return merged


def caption_from_tags(
    categories: Sequence[dict[str, float]],
    *,
    underscore_to_space: bool = True,
    escape_parens: bool = False,
) -> str:
    """按类别顺序拼 caption，并按最终标签文本去重；普通标签的下划线转空格。"""
    merged = merge_selections(
        (("", "", tags) for tags in categories),
        underscore_to_space=underscore_to_space,
        escape_parens=escape_parens,
    )
    return ", ".join(tag["text"] for tag in merged)


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
