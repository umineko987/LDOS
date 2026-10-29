"""caption 标签的解析、序列化和批量变换（纯函数，整个后端只此一份）。

caption 文件格式与 tagger 写出的一致：标签之间用 ``", "`` 分隔。解析时
逗号和换行都当分隔符，去掉首尾空白，丢弃空标签，重复标签只保留第一次
出现的位置。标签按原文精确比较（不改大小写、不动下划线和括号转义）。

触发词（数据集的 trigger_word）在任何变换之后都钉在最前面。
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

CAPTION_SEPARATOR = ", "
_SPLIT = re.compile(r"[,\r\n]")


def parse_caption(text: str | None) -> list[str]:
    if not text:
        return []
    return dedupe(part.strip() for part in _SPLIT.split(text))


def format_caption(tags: Iterable[str]) -> str:
    return CAPTION_SEPARATOR.join(tags)


def dedupe(tags: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for tag in tags:
        if tag and tag not in seen:
            seen.add(tag)
            result.append(tag)
    return result


def pin_trigger(tags: Sequence[str], trigger_word: str) -> list[str]:
    """触发词放到最前面；caption 里没有它时补上（触发词为空则原样返回）。"""
    trigger = trigger_word.strip()
    if not trigger:
        return dedupe(tags)
    return dedupe([trigger, *(tag for tag in tags if tag != trigger)])


def _clean(values: Iterable[str]) -> list[str]:
    return dedupe(value.strip() for value in values)


def apply_op(tags: Sequence[str], op: Mapping[str, Any]) -> list[str]:
    """对一张图的标签执行一个批量操作，返回新列表（输入不变）。

    - ``add``：追加没有的标签；``position="front"`` 时插到最前面（触发词之后由调用方保证）
    - ``remove``：删掉列出的标签
    - ``replace``：``from`` 换成 ``to``，位置不变；``to`` 已存在时只删 ``from``
    - ``merge``：``tags`` 里出现的那些合成一个 ``into``，放在其中第一个出现的位置
    - ``pin``：把列出的标签按给定顺序移到最前面（只移动已有的）
    """
    kind = op["op"]
    current = list(tags)
    if kind == "add":
        additions = [tag for tag in _clean(op["tags"]) if tag not in current]
        return dedupe([*additions, *current] if op.get("position") == "front" else [*current, *additions])
    if kind == "remove":
        removed = set(_clean(op["tags"]))
        return [tag for tag in current if tag not in removed]
    if kind == "replace":
        source, target = op["from"].strip(), op["to"].strip()
        if source not in current or source == target:
            return current
        if target in current:
            return [tag for tag in current if tag != source]
        return [target if tag == source else tag for tag in current]
    if kind == "merge":
        sources = set(_clean(op["tags"]))
        target = op["into"].strip()
        if not any(tag in sources for tag in current):
            return current
        result: list[str] = []
        placed = False
        for tag in current:
            if tag in sources or tag == target:
                if not placed:
                    result.append(target)
                    placed = True
                continue
            result.append(tag)
        return result
    if kind == "pin":
        pinned = [tag for tag in _clean(op["tags"]) if tag in current]
        return dedupe([*pinned, *current])
    raise ValueError(f"unknown_caption_op:{kind}")


def apply_ops(tags: Sequence[str], ops: Sequence[Mapping[str, Any]], *, trigger_word: str = "") -> list[str]:
    """按顺序执行多个操作；触发词若原本就在 caption 里，结果中仍在最前面。"""
    result = list(tags)
    for op in ops:
        result = apply_op(result, op)
    trigger = trigger_word.strip()
    if trigger and trigger in result:
        result = pin_trigger(result, trigger)
    return result


def merge_tagger_tags(
    current: Sequence[str],
    tagger_tags: Sequence[str],
    *,
    previous_tagger_tags: Sequence[str] | None,
    mode: str,
    trigger_word: str = "",
) -> list[str]:
    """把一次打标结果和现有 caption 合并成新的标签列表。

    - ``overwrite``：触发词 + 打标结果
    - ``fill_empty``：现有 caption 为空时同 overwrite，否则保持不变
    - ``merge``：保留手改。``previous_tagger_tags`` 是上一次（未撤销的）打标写入
      这张图的标签：现有 caption 里不属于它的标签算手动加的，保留在触发词之后；
      它里面有、现有 caption 里却没有的标签算手动删掉的，这次也不加回来。
      从没打过标（None）时，现有标签全部算手动加的。
    """
    if mode == "overwrite":
        return pin_trigger(tagger_tags, trigger_word)
    if mode == "fill_empty":
        if current:
            return list(current)
        return pin_trigger(tagger_tags, trigger_word)
    if mode != "merge":
        raise ValueError(f"unknown_merge_mode:{mode}")
    previous = set(previous_tagger_tags or ())
    current_set = set(current)
    manual_added = [tag for tag in current if tag not in previous]
    manual_removed = previous - current_set
    fresh = [tag for tag in tagger_tags if tag not in manual_removed]
    return pin_trigger([*manual_added, *fresh], trigger_word)


def diff_tags(before: Sequence[str], after: Sequence[str]) -> dict[str, list[str]]:
    before_set, after_set = set(before), set(after)
    return {
        "added": [tag for tag in after if tag not in before_set],
        "removed": [tag for tag in before if tag not in after_set],
    }


__all__ = [
    "CAPTION_SEPARATOR",
    "apply_op",
    "apply_ops",
    "dedupe",
    "diff_tags",
    "format_caption",
    "merge_tagger_tags",
    "parse_caption",
    "pin_trigger",
]
