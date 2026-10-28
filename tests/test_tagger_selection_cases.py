import importlib.util
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tagger"))

FIXTURE = ROOT / "desktop" / "src" / "lib" / "domain" / "fixtures" / "tagger_selection_cases.json"


def load_generator():
    spec = importlib.util.spec_from_file_location("gen_selection_cases", ROOT / "tagger" / "tools" / "gen_selection_cases.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_PLAIN = re.compile(r"[a-z0-9_]+")


def reference_compose(case: dict) -> dict:
    """按生成器文档字符串描述的 JS 语义，只用样例输入（稀疏候选 + 模型头）重算。

    与生产代码完全独立：若这里与 expected 不一致，说明文档描述的语义不完整。
    """
    policy, fmt = case["policy"], case["format"]
    effective, selected, merged, seen = {}, {}, [], set()
    for model in case["models"]:
        thresholds = {**model["default_thresholds"], **policy["thresholds"],
                      **policy["model_thresholds"].get(model["key"], {})}
        effective[model["key"]] = thresholds
        output = []
        for category in policy["categories"] or model["categories"]:
            rows = [row for row in model["candidates"] if row[1] == category]
            tags: dict[str, float] = {}
            if category in model["categories"]:
                if category == "rating" and policy["rating_mode"] == "argmax":
                    best = None
                    for row in rows:
                        if best is None or row[2] > best[2]:
                            best = row
                    if best is not None and best[2] >= thresholds.get("rating", 0.0):
                        tags[best[0]] = best[2]
                else:
                    threshold = thresholds.get(category, 0.5)
                    for name, _, score in rows:
                        if score >= threshold:
                            tags[name] = score
            output.append({"category": category, "tags": [[name, score] for name, score in tags.items()]})
            for name, score in tags.items():
                text = name.replace("_", " ") if fmt["underscore_to_space"] and _PLAIN.fullmatch(name) else name
                if fmt["escape_parens"]:
                    text = text.replace("(", "\\(").replace(")", "\\)")
                if text not in seen:
                    seen.add(text)
                    merged.append({"name": name, "text": text, "category": category, "score": score,
                                   "model": model["key"]})
        selected[model["key"]] = output
    return {"effective_thresholds": effective, "selected": selected, "tags": merged,
            "caption": ", ".join(tag["text"] for tag in merged)}


class SelectionCasesFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.generator = load_generator()
        cls.text = FIXTURE.read_text(encoding="utf-8")
        cls.data = json.loads(cls.text)
        cls.cases = {case["id"]: case for case in cls.data["cases"]}

    def test_committed_fixture_is_up_to_date(self) -> None:
        self.assertEqual(
            self.generator.render(), self.text,
            "样例已过期：运行 python tagger/tools/gen_selection_cases.py",
        )

    def test_documented_semantics_reproduce_every_case_from_inputs_alone(self) -> None:
        self.assertGreaterEqual(len(self.cases), 40)
        for case_id, case in self.cases.items():
            with self.subTest(case=case_id):
                self.assertEqual(reference_compose(case), case["expected"])

    def test_float32_equality_edge_is_pinned(self) -> None:
        case = self.cases["threshold_equality_float32"]
        rows = {row[0]: row[2] for row in case["models"][0]["candidates"]}
        self.assertEqual(rows["below"], 0.3499999940395355)
        self.assertLess(rows["below"], 0.35)
        self.assertEqual([tag["name"] for tag in case["expected"]["tags"]], ["above", "exact_half"])

    def test_sparse_case_category_order_cannot_be_inferred_from_rows(self) -> None:
        model = self.cases["interleaved_categories_sparse"]["models"][0]
        first_seen = list(dict.fromkeys(row[1] for row in model["candidates"]))
        self.assertNotEqual(first_seen, model["categories"])
        self.assertEqual(model["categories"], ["general", "character", "quality", "rating"])

    def test_fixture_covers_required_edges(self) -> None:
        cases = self.cases.values()
        self.assertTrue(any(case["floor"] > 0 for case in cases))
        self.assertTrue(any(case["policy"]["rating_mode"] == "threshold" for case in cases))
        self.assertTrue(any(case["format"]["escape_parens"] for case in cases))
        self.assertTrue(any(not case["format"]["underscore_to_space"] for case in cases))
        self.assertTrue(any(len(case["models"]) > 1 for case in cases))
        self.assertTrue(any(case["expected"]["caption"] == "" for case in cases))
        rating_below_floor = False
        for case in cases:
            for model in case["models"]:
                for name, category, score in model["candidates"]:
                    # rating 行不受 floor 影响，保持完整；其余行一律 >= floor
                    if category == "rating":
                        rating_below_floor |= score < case["floor"]
                    else:
                        self.assertGreaterEqual(score, case["floor"], (case["id"], name))
        self.assertTrue(rating_below_floor)


if __name__ == "__main__":
    unittest.main()
