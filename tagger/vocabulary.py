"""打标模型词表：有序标签 + 类别索引 + 指纹。

词表的输出顺序是一等公民：推理分数数组与 names 严格一一对应，
category_index 记录各类别在数组中的下标，筛选时按类别切片。
"""

from __future__ import annotations

import csv
import hashlib
from pathlib import Path

import numpy as np

# WD selected_tags.csv 的 category 取值
WD_CATEGORIES = {0: "general", 4: "character", 9: "rating"}


class Vocabulary:
    def __init__(self, names: list[str], categories: list[str]):
        if len(names) != len(categories):
            raise ValueError("标签名与类别数量不一致")
        self.names = tuple(names)
        index_by_category: dict[str, list[int]] = {}
        for position, category in enumerate(categories):
            index_by_category.setdefault(category, []).append(position)
        self.category_index: dict[str, np.ndarray] = {
            category: np.asarray(positions, dtype=np.int64)
            for category, positions in index_by_category.items()
        }
        digest = hashlib.sha256()
        for name, category in zip(names, categories):
            digest.update(name.encode("utf-8"))
            digest.update(b"\x00")
            digest.update(category.encode("utf-8"))
            digest.update(b"\x00")
        self.fingerprint = digest.hexdigest()

    def __len__(self) -> int:
        return len(self.names)

    def categories(self) -> list[str]:
        return list(self.category_index)


def load_wd_csv(path: Path) -> Vocabulary:
    """解析 SmilingWolf selected_tags.csv（列: tag_id,name,category,count）。"""
    names: list[str] = []
    categories: list[str] = []
    with open(path, encoding="utf-8", newline="") as file_obj:
        reader = csv.DictReader(file_obj)
        for row in reader:
            name = (row.get("name") or "").strip()
            category_id = int(row.get("category", "-1"))
            category = WD_CATEGORIES.get(category_id)
            if not name or category is None:
                raise ValueError(f"selected_tags.csv 出现未知行: {row}")
            names.append(name)
            categories.append(category)
    if not names:
        raise ValueError("selected_tags.csv 为空")
    return Vocabulary(names, categories)
