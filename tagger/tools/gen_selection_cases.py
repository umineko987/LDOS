"""生成前端阈值筛选移植版的一致性样例。

用法：
  python tagger/tools/gen_selection_cases.py          # 重写样例文件
  python tagger/tools/gen_selection_cases.py --check  # 样例过期时退出码 1

输出 desktop/src/lib/domain/fixtures/tagger_selection_cases.json。期望值全部由
生产代码算出（runner.effective_policy → postprocess.select →
postprocess.merge_selections），前端 vitest 必须逐项、逐位一致。

JS 移植版必须复现的语义
======================

输入（与 `cli.py candidates` 的输出同构）
- 每个模型给出：
  - key；
  - categories：词表里各类别首次出现的顺序（来自 models 头，不能从候选行推断，
    候选行是稀疏的）；
  - default_thresholds；
  - candidates：词表顺序的 [标签, 类别, 分数] 行。低于 floor 的行被省略，
    但 rating 类的行总是完整的。
- 策略：
  - thresholds：全局阈值；
  - model_thresholds：按模型覆盖的阈值；
  - categories：空表示该模型的全部类别；
  - rating_mode：argmax 或 threshold。
- 格式：underscore_to_space、escape_parens。

生效阈值
- 对象展开 {...default_thresholds, ...thresholds, ...model_thresholds[key]}，
  后者覆盖前者。

每个模型的筛选
- 输出类别列表：policy.categories 非空时原样使用（保持给定顺序，重复项保留），
  否则用该模型的 categories。输出与这个列表一一对齐。
- 模型没有任何该类别标签时（类别不在 categories 里），该位置输出空。
- 类别名恰为 "rating" 且 rating_mode 为 "argmax" 时：
  - 在该模型的 rating 行里按词表顺序扫描，取第一个最大值（并列取靠前者）；
  - 当 score >= (thresholds["rating"] ?? 0.0) 时选中这一个，否则为空。
- 其余情况：
  - t = thresholds[类别] ?? 0.5；
  - 按词表顺序选出该类别中 score >= t 的行。
- 同一类别内标签重名（罕见）：只保留一项，位置取首次出现，分数取最后一个
  过阈值的（等同 JS Map.set）。

数值比较
- 一律是 IEEE-754 双精度的 `score >= threshold`，相等即入选。
- 分数是 float32 无损扩成的 float64。JSON 里的十进制数（Python repr，最短往返
  表示）经 JSON.parse 后与 Python 端是同一个 double。
- 不得对分数或阈值取整，不得用 Math.fround。
  例：float32(0.35) = 0.3499999940395355 < 0.35，不入选。

合并与格式
- 顺序：模型顺序 → 输出类别顺序 → 词表顺序，逐项生成 text：
  - underscore_to_space 为真且标签名整串匹配 /^[a-z0-9_]+$/（只认小写 ASCII，
    带括号、大写、符号或非 ASCII 的不算）时，所有 "_" 换成空格；
  - 然后若 escape_parens，把 "(" 换成 "\\("，")" 换成 "\\)"。
- 按 text 去重，先出现者保留（name、category、score、model 都取它的）。
- caption = 各 text 用 ", " 连接；没有标签时为空串。

样例中 floor > 0 时，生成器保证所有非 rating 阈值 >= floor，因此稀疏输入与
完整分数的结果相同；前端阈值滑块同样不能低于 floor。
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

TAGGER_DIR = Path(__file__).resolve().parents[1]
ROOT = TAGGER_DIR.parent
OUTPUT = ROOT / "desktop" / "src" / "lib" / "domain" / "fixtures" / "tagger_selection_cases.json"

if str(TAGGER_DIR) not in sys.path:
    sys.path.insert(0, str(TAGGER_DIR))

import numpy as np  # noqa: E402

from postprocess import SelectionPolicy, merge_selections, policy_categories, select  # noqa: E402
from runner import effective_policy, sparse_candidates  # noqa: E402
from specs import TaggerModelSpec  # noqa: E402
from vocabulary import Vocabulary  # noqa: E402

SCHEMA_VERSION = 1
SEED = 20261029

WD_DEFAULTS = {"general": 0.35, "character": 0.85, "rating": 0.0}
PIXAI_DEFAULTS = {"general": 0.17, "character": 0.27, "style": 0.15, "copyright": 0.24, "meta": 0.17, "rating": 0.41}
CL_DEFAULTS = {"general": 0.55, "character": 0.55, "copyright": 0.55, "meta": 0.55, "rating": 0.55, "quality": 0.55}


def f32(value: float) -> float:
    """float32 无损扩成的 float64：样例里所有分数都满足这一点。"""
    return float(np.float32(value))


def next_up(value: float) -> float:
    return float(np.nextafter(np.float32(value), np.float32(2)))


def next_down(value: float) -> float:
    return float(np.nextafter(np.float32(value), np.float32(-1)))


def model(key: str, rows: list[tuple[str, str, float]], defaults: dict[str, float]) -> dict:
    return {"key": key, "rows": [(name, category, f32(score)) for name, category, score in rows], "defaults": defaults}


def case(
    case_id: str,
    description: str,
    models: list[dict],
    *,
    thresholds: dict[str, float] | None = None,
    model_thresholds: dict[str, dict[str, float]] | None = None,
    categories: list[str] | None = None,
    rating_mode: str = "argmax",
    underscore_to_space: bool = True,
    escape_parens: bool = False,
    floor: float = 0.0,
) -> dict:
    return {
        "id": case_id,
        "description": description,
        "models": models,
        "thresholds": thresholds or {},
        "model_thresholds": model_thresholds or {},
        "categories": categories or [],
        "rating_mode": rating_mode,
        "underscore_to_space": underscore_to_space,
        "escape_parens": escape_parens,
        "floor": floor,
    }


def handwritten_cases() -> list[dict]:
    wd_rows = [
        ("general", "rating", 0.08), ("sensitive", "rating", 0.81), ("questionable", "rating", 0.1), ("explicit", "rating", 0.01),
        ("1girl", "general", 0.99), ("solo", "general", 0.95), ("long_hair", "general", 0.6), ("smile", "general", 0.34),
        ("hat", "general", 0.12), ("hatsune_miku", "character", 0.92), ("kagamine_rin", "character", 0.3),
    ]
    return [
        case("wd_defaults_all_categories", "WD 默认阈值，类别取词表首次出现顺序（rating 在最前）",
             [model("wd", wd_rows, WD_DEFAULTS)]),
        case("threshold_equality_float32", "相等即入选；float32(0.35) 略小于 0.35 不入选，其上一个 ulp 入选",
             [model("m", [("below", "general", 0.35), ("above", "general", next_up(0.35)),
                          ("exact_half", "general", 0.5), ("exact_quarter", "general", 0.25),
                          ("just_under_quarter", "general", next_down(0.25))], {})],
             thresholds={"general": 0.35}),
        case("threshold_equality_representable", "可精确表示的阈值与相同分数相等时入选",
             [model("m", [("half", "general", 0.5), ("quarter", "general", 0.25), ("under", "general", next_down(0.5))], {})],
             thresholds={"general": 0.5}),
        case("rating_argmax_tie_first_wins", "rating 并列最大取词表中靠前者",
             [model("m", [("general", "rating", 0.3), ("sensitive", "rating", 0.6), ("questionable", "rating", 0.6),
                          ("solo", "general", 0.9)], {"rating": 0.0})]),
        case("rating_argmax_below_threshold", "rating 最大值低于阈值时该类为空",
             [model("m", [("general", "rating", 0.3), ("sensitive", "rating", 0.4), ("solo", "general", 0.9)], {})],
             thresholds={"rating": 0.41}),
        case("rating_argmax_default_zero", "未给 rating 阈值时退到 0.0：再小的最大值也入选",
             [model("m", [("general", "rating", 0.001), ("sensitive", "rating", 0.002), ("solo", "general", 0.9)], {})]),
        case("rating_threshold_mode", "rating_mode=threshold 时 rating 与普通类别同样按阈值多选",
             [model("m", [("general", "rating", 0.5), ("sensitive", "rating", 0.45), ("explicit", "rating", 0.1)], {})],
             thresholds={"rating": 0.4}, rating_mode="threshold"),
        case("explicit_categories_order_and_unknown", "显式类别按给定顺序输出；词表里没有的类别输出空位；重复类别保留",
             [model("m", wd_rows, WD_DEFAULTS)], categories=["character", "artist", "general", "character"]),
        case("interleaved_categories_sparse", "类别交错的词表 + 稀疏候选：类别顺序必须取模型头里的 categories",
             [model("cl", [("tree", "general", 0.01), ("miku", "character", 0.9), ("sky", "general", 0.8),
                           ("masterpiece", "quality", 0.7), ("rin", "character", 0.02), ("general", "rating", 0.6)],
                    CL_DEFAULTS)],
             thresholds={"general": 0.5, "character": 0.5, "quality": 0.5}, floor=0.05),
        case("fallback_threshold_half", "类别既无全局也无默认阈值时用 0.5",
             [model("m", [("a", "copyright", 0.5), ("b", "copyright", next_down(0.5)), ("c", "meta", 0.7)], {})]),
        case("pixai_categories", "pixai 风格类别与默认阈值",
             [model("pixai", [("1girl", "general", 0.9), ("watercolor", "style", 0.16), ("vocaloid", "copyright", 0.2),
                              ("highres", "meta", 0.5), ("miku", "character", 0.28), ("general", "rating", 0.5),
                              ("sensitive", "rating", 0.3)], PIXAI_DEFAULTS)]),
        case("all_below_threshold", "全部低于阈值：每类为空，caption 为空串",
             [model("m", [("solo", "general", 0.1), ("hero", "character", 0.2)], {"general": 0.35, "character": 0.85})]),
        case("multi_model_merge_dedup", "多模型按顺序合并，按最终文本去重，先出现者保留",
             [model("wd", [("blue_hair", "general", 0.9), ("solo", "general", 0.8), ("miku", "character", 0.95)], WD_DEFAULTS),
              model("pixai", [("blue hair", "general", 0.99), ("smile", "general", 0.6), ("miku", "character", 0.97),
                              ("watercolor", "style", 0.5)], PIXAI_DEFAULTS)]),
        case("threshold_precedence", "按模型覆盖 > 全局 > 模型默认 > 0.5",
             [model("a", [("x", "general", 0.3), ("y", "general", 0.45), ("z", "copyright", 0.45)], {"general": 0.5}),
              model("b", [("p", "general", 0.3), ("q", "general", 0.45), ("r", "copyright", 0.45)], {"general": 0.5})],
             thresholds={"general": 0.4}, model_thresholds={"b": {"general": 0.25, "copyright": 0.5}}),
        case("underscore_rules", "只有整串匹配 [a-z0-9_]+ 的标签才把下划线换成空格",
             [model("m", [("long_hair", "general", 0.9), ("^_^", "general", 0.9), ("Long_Hair", "general", 0.9),
                          ("hatsune_miku_(vocaloid)", "character", 0.9), ("1girl", "general", 0.9),
                          ("猫_耳", "general", 0.9), ("o_o", "general", 0.9)], {"general": 0.5, "character": 0.5})]),
        case("keep_underscores", "underscore_to_space=false 时原样输出，去重也按原样文本",
             [model("a", [("long_hair", "general", 0.9)], {}), model("b", [("long hair", "general", 0.9)], {})],
             underscore_to_space=False),
        case("escape_parens_after_underscore", "先换下划线再转义括号；去重按转义后的文本",
             [model("a", [("miku_(cosplay)", "character", 0.9), ("(9)", "general", 0.9)], {"general": 0.5, "character": 0.5}),
              model("b", [("miku_(cosplay)", "character", 0.95), ("smile", "general", 0.9)], {"general": 0.5, "character": 0.5})],
             escape_parens=True),
        case("duplicate_names_same_category", "同一类别内重名：位置取首次，分数取最后一个过阈值的",
             [model("m", [("solo", "general", 0.6), ("smile", "general", 0.7), ("solo", "general", 0.9)], {"general": 0.5})]),
        case("same_name_across_categories", "同名标签出现在两个类别：按输出顺序先到者保留",
             [model("m", [("vocaloid", "copyright", 0.9), ("vocaloid", "general", 0.9), ("solo", "general", 0.9)],
                    {"general": 0.5, "copyright": 0.5})], categories=["general", "copyright"]),
        case("score_extremes", "0 与 1 的分数配 0.01 / 0.99 阈值",
             [model("m", [("zero", "general", 0.0), ("one", "general", 1.0), ("tiny", "character", 0.01),
                          ("big", "character", 0.99)], {})],
             thresholds={"general": 0.01, "character": 0.99}),
        case("empty_model_list_entry", "模型完全没有所选类别：输出空位，不影响其他模型",
             [model("a", [("solo", "general", 0.9)], {"general": 0.5}),
              model("b", [("miku", "character", 0.9)], {"character": 0.5})], categories=["character"]),
    ]


TAG_POOL = [
    "1girl", "solo", "long_hair", "long hair", "short_hair", "smile", "blue_eyes", "hat", "^_^", "o_o", ":d",
    "Long_Hair", "hatsune_miku", "hatsune_miku_(vocaloid)", "kagamine_rin", "miku_(cosplay)", "(9)", "vocaloid",
    "masterpiece", "best_quality", "highres", "absurdres", "watercolor", "sketch", "猫耳", "artist_name",
    "general", "sensitive", "questionable", "explicit",
]
CATEGORY_POOL = ["general", "general", "general", "character", "copyright", "meta", "quality", "style", "artist"]
RATING_NAMES = ["general", "sensitive", "questionable", "explicit"]


class Draw:
    """只用 random.random()：CPython 保证同种子下它的序列跨版本不变。"""

    def __init__(self, seed: int):
        self._random = random.Random(seed)

    def unit(self) -> float:
        return self._random.random()

    def index(self, size: int) -> int:
        return min(int(self.unit() * size), size - 1)

    def pick(self, items: list):
        return items[self.index(len(items))]

    def chance(self, probability: float) -> bool:
        return self.unit() < probability

    def grid(self, low: int, high: int) -> float:
        return (low + self.index(high - low + 1)) / 100


def random_cases(count: int) -> list[dict]:
    draw = Draw(SEED)
    cases = []
    for number in range(count):
        floor = 0.05 if draw.chance(0.5) else 0.0
        low = 5 if floor else 1
        thresholds_pool = ["general", "character", "copyright", "meta", "quality", "style"]
        models = []
        for model_number in range(1 + draw.index(3)):
            rows = []
            if draw.chance(0.8):
                for name in RATING_NAMES[: 2 + draw.index(3)]:
                    rows.append((name, "rating", draw.unit()))
            for _ in range(6 + draw.index(14)):
                name = draw.pick(TAG_POOL)
                category = draw.pick(CATEGORY_POOL)
                roll = draw.unit()
                if roll < 0.3:
                    score = draw.grid(1, 99)
                elif roll < 0.45:
                    score = next_up(draw.grid(low, 95)) if draw.chance(0.5) else next_down(draw.grid(low, 95))
                else:
                    score = draw.unit()
                rows.insert(draw.index(len(rows) + 1), (name, category, score))
            defaults = {category: draw.grid(low, 95) for category in thresholds_pool if draw.chance(0.4)}
            if draw.chance(0.5):
                defaults["rating"] = draw.grid(0, 60)
            models.append(model(f"model-{model_number}", rows, defaults))
        global_thresholds = {category: draw.grid(low, 95) for category in thresholds_pool if draw.chance(0.3)}
        model_thresholds = {}
        for entry in models:
            overrides = {category: draw.grid(low, 95) for category in thresholds_pool if draw.chance(0.25)}
            if overrides:
                model_thresholds[entry["key"]] = overrides
        categories = []
        if draw.chance(0.4):
            pool = ["general", "character", "copyright", "meta", "quality", "style", "artist", "rating", "lore"]
            categories = [draw.pick(pool) for _ in range(1 + draw.index(5))]
        cases.append(case(
            f"random_{number:02d}", "随机组合（固定种子）", models,
            thresholds=global_thresholds,
            model_thresholds=model_thresholds,
            categories=categories,
            rating_mode="threshold" if draw.chance(0.15) else "argmax",
            underscore_to_space=not draw.chance(0.2),
            escape_parens=draw.chance(0.3),
            floor=floor,
        ))
    return cases


def evaluate(spec_case: dict) -> dict:
    """用生产代码计算一个样例的输入（稀疏候选）与期望输出。"""
    policy = SelectionPolicy(
        thresholds=spec_case["thresholds"],
        categories=tuple(spec_case["categories"]),
        rating_mode=spec_case["rating_mode"],
    )
    floor = spec_case["floor"]
    models_out, selected_out, effective_out, selections = [], {}, {}, []
    for entry in spec_case["models"]:
        names = [name for name, _, _ in entry["rows"]]
        categories = [category for _, category, _ in entry["rows"]]
        vocabulary = Vocabulary(names, categories)
        scores = np.array([score for _, _, score in entry["rows"]], dtype=np.float32)
        spec = TaggerModelSpec(key=entry["key"], repo="", revision="", adapter="", files=(),
                               default_thresholds=entry["defaults"], license="")
        effective = effective_policy(spec, policy, spec_case["model_thresholds"].get(entry["key"], {}))
        # 稀疏输入只在非 rating 阈值都不低于 floor 时与完整分数等价（缺省的 0.5 恒满足）
        low = [category for category, value in effective.thresholds.items() if category != "rating" and value < floor]
        if low:
            raise ValueError(f"{spec_case['id']}: 阈值低于 floor {floor}: {low}")
        result = select(scores, vocabulary, effective)
        output_categories = policy_categories(vocabulary, effective)
        models_out.append({
            "key": entry["key"],
            "categories": list(vocabulary.category_index),
            "default_thresholds": dict(entry["defaults"]),
            "candidates": sparse_candidates(scores, vocabulary, floor),
        })
        effective_out[entry["key"]] = dict(effective.thresholds)
        selected_out[entry["key"]] = [
            {"category": category, "tags": [[name, score] for name, score in tags.items()]}
            for category, tags in zip(output_categories, result)
        ]
        selections.extend((entry["key"], category, tags) for category, tags in zip(output_categories, result))
    merged = merge_selections(
        selections,
        underscore_to_space=spec_case["underscore_to_space"],
        escape_parens=spec_case["escape_parens"],
    )
    return {
        "id": spec_case["id"],
        "description": spec_case["description"],
        "floor": floor,
        "models": models_out,
        "policy": {
            "thresholds": dict(spec_case["thresholds"]),
            "model_thresholds": {key: dict(value) for key, value in spec_case["model_thresholds"].items()},
            "categories": list(spec_case["categories"]),
            "rating_mode": spec_case["rating_mode"],
        },
        "format": {
            "underscore_to_space": spec_case["underscore_to_space"],
            "escape_parens": spec_case["escape_parens"],
        },
        "expected": {
            "effective_thresholds": effective_out,
            "selected": selected_out,
            "tags": merged,
            "caption": ", ".join(tag["text"] for tag in merged),
        },
    }


def build() -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "generator": "tagger/tools/gen_selection_cases.py",
        "note": "由生成器写出，勿手改；语义见生成器文档字符串。",
        "cases": [evaluate(item) for item in handwritten_cases() + random_cases(24)],
    }


def _scalar(value) -> bool:
    return not isinstance(value, (dict, list))


def _dump(value, level: int = 0) -> str:
    """键排序、缩进 1；只含标量的数组写在一行（候选行、标签分数对一行一条，便于看 diff）。"""
    pad, inner = " " * level, " " * (level + 1)
    if isinstance(value, list) and all(_scalar(item) for item in value):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[\n" + ",\n".join(inner + _dump(item, level + 1) for item in value) + "\n" + pad + "]"
    if isinstance(value, dict) and value:
        items = sorted(value.items())
        return "{\n" + ",\n".join(
            f"{inner}{json.dumps(key, ensure_ascii=False)}: {_dump(item, level + 1)}" for key, item in items
        ) + "\n" + pad + "}"
    return json.dumps(value, ensure_ascii=False)


def render() -> str:
    return _dump(build()) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="只检查样例文件是否最新")
    args = parser.parse_args(argv)
    text = render()
    if args.check:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.is_file() else ""
        if current != text:
            print(f"{OUTPUT.relative_to(ROOT)} 已过期，请重新运行生成器", file=sys.stderr)
            return 1
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"已写入 {OUTPUT.relative_to(ROOT)}（{len(build()['cases'])} 个样例）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
