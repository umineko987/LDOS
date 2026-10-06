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


def load_cl_vocabulary(path: Path) -> Vocabulary:
    """解析 CL tagger v2 的 model_vocabulary.json。

    idx_to_tag 给出输出顺序，tag_to_category 给出类别（首字母大写，
    统一转小写）。
    """
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    num_tags = int(data["num_tags"])
    idx_to_tag = data["idx_to_tag"]
    tag_to_category = data["tag_to_category"]
    names: list[str | None] = [None] * num_tags
    for raw_index, tag in idx_to_tag.items():
        index = int(raw_index)
        if not 0 <= index < num_tags:
            raise ValueError(f"CL 词表索引越界: {raw_index}")
        names[index] = str(tag)
    if any(name is None for name in names):
        missing = names.index(None)
        raise ValueError(f"CL 词表 idx_to_tag 不完整，首个缺口 {missing}")
    resolved = [str(name) for name in names]
    categories: list[str] = []
    for tag in resolved:
        category = tag_to_category.get(tag)
        if category is None:
            raise ValueError(f"CL 词表缺少类别: {tag!r}")
        categories.append(str(category).lower())
    return Vocabulary(resolved, categories)


def load_pixai_config(path: Path) -> Vocabulary:
    """解析 pixai-tagger config.json：tags（有序）+ tags_split（(类别, 数量) 分段）。"""
    import json

    config = json.loads(path.read_text(encoding="utf-8"))
    tags = config.get("tags") or []
    tags_split = config.get("tags_split") or []
    if not isinstance(tags, list) or not tags or not isinstance(tags_split, list):
        raise ValueError("pixai config.json 缺少 tags/tags_split")
    names: list[str] = []
    categories: list[str] = []
    for category, count in tags_split:
        if not isinstance(category, str) or not isinstance(count, int) or count < 0:
            raise ValueError(f"tags_split 条目非法: {(category, count)!r}")
        if count == 0:
            continue
        categories.extend([category] * count)
    if len(categories) != len(tags):
        raise ValueError(f"tags_split 总数 {len(categories)} 与 tags {len(tags)} 不一致")
    names = [str(tag) for tag in tags]
    return Vocabulary(names, categories)
