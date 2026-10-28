import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tagger"))

import numpy as np

from postprocess import SelectionPolicy, caption_from_tags, select, write_caption_file
from vocabulary import Vocabulary


def sample_vocab() -> Vocabulary:
    # general: solo(0), 1girl(1), long_hair(2) / character: hatsune_miku(3) / rating: g(4), s(5), q(6), e(7)
    return Vocabulary(
        ["solo", "1girl", "long_hair", "hatsune_miku", "general", "sensitive", "questionable", "explicit"],
        ["general", "general", "general", "character", "rating", "rating", "rating", "rating"],
    )


def sample_scores() -> np.ndarray:
    return np.array([0.9, 0.5, 0.34, 0.9, 0.1, 0.8, 0.05, 0.02], dtype=np.float32)


def approx(result: list[dict[str, float]]) -> list[dict[str, float]]:
    return [{tag: round(score, 5) for tag, score in tags.items()} for tags in result]


class SelectTests(unittest.TestCase):
    def test_threshold_and_order(self) -> None:
        policy = SelectionPolicy(thresholds={"general": 0.35, "character": 0.85}, categories=("general", "character"))
        result = select(sample_scores(), sample_vocab(), policy)
        self.assertEqual(approx(result), [{"solo": 0.9, "1girl": 0.5}, {"hatsune_miku": 0.9}])
        # 0.34 < 0.35 被截掉，保持词表顺序

    def test_threshold_change_keeps_order_and_includes_more(self) -> None:
        policy = SelectionPolicy(thresholds={"general": 0.3, "character": 0.85}, categories=("general", "character"))
        result = select(sample_scores(), sample_vocab(), policy)
        self.assertEqual(list(result[0]), ["solo", "1girl", "long_hair"])

    def test_rating_argmax(self) -> None:
        policy = SelectionPolicy(
            thresholds={"general": 0.35},
            categories=("general", "rating"),
        )
        result = select(sample_scores(), sample_vocab(), policy)
        self.assertEqual(approx(result)[1], {"sensitive": 0.8})

    def test_rating_argmax_respects_threshold(self) -> None:
        rejected = SelectionPolicy(thresholds={"rating": 0.99}, categories=("rating",))
        accepted = SelectionPolicy(thresholds={"rating": 0.01}, categories=("rating",))
        self.assertEqual(select(sample_scores(), sample_vocab(), rejected), [{}])
        self.assertEqual(approx(select(sample_scores(), sample_vocab(), accepted)), [{"sensitive": 0.8}])

    def test_no_categories_selects_all_vocabulary_categories(self) -> None:
        categories = ["general", "character", "copyright", "quality", "meta", "style", "rating", "artist"]
        vocab = Vocabulary([f"tag_{category}" for category in categories], categories)
        result = select(np.full(len(categories), 0.9, dtype=np.float32), vocab, SelectionPolicy(thresholds={}))
        self.assertEqual([list(tags) for tags in result], [[f"tag_{category}"] for category in categories])

    def test_rating_threshold_mode(self) -> None:
        policy = SelectionPolicy(
            thresholds={"rating": 0.04},
            categories=("rating",),
            rating_mode="threshold",
        )
        result = select(sample_scores(), sample_vocab(), policy)
        self.assertEqual(approx(result)[0], {"general": 0.1, "sensitive": 0.8, "questionable": 0.05})

    def test_missing_category_yields_empty(self) -> None:
        policy = SelectionPolicy(thresholds={"artist": 0.5}, categories=("artist",))
        result = select(sample_scores(), sample_vocab(), policy)
        self.assertEqual(result, [{}])

    def test_policy_fingerprint_varies(self) -> None:
        base = SelectionPolicy(thresholds={"general": 0.35})
        same = SelectionPolicy(thresholds={"general": 0.35})
        changed = SelectionPolicy(thresholds={"general": 0.25})
        self.assertEqual(base.fingerprint, same.fingerprint)
        self.assertNotEqual(base.fingerprint, changed.fingerprint)


class CaptionTests(unittest.TestCase):
    def test_underscore_replacement_for_plain_tags_only(self) -> None:
        categories = [{"long_hair": 0.9, "^_^": 0.8, "hatsune_miku": 0.7, "group(c)": 0.6}]
        caption = caption_from_tags(categories)
        self.assertEqual(caption, "long hair, ^_^, hatsune miku, group(c)")

    def test_duplicate_tags_keep_first_position_after_formatting(self) -> None:
        categories = [
            {"solo": 0.8, "long_hair": 0.9, "^_^": 0.7},
            {"hero": 0.9},
            {"long hair": 0.95, "solo": 0.99, "smile": 0.8, "^_^": 0.9},
            {"hero": 0.95, "new_character": 0.9},
        ]
        self.assertEqual(caption_from_tags(categories), "solo, long hair, ^_^, hero, smile, new character")
        self.assertEqual(
            caption_from_tags(categories, underscore_to_space=False),
            "solo, long_hair, ^_^, hero, long hair, smile, new_character",
        )

    def test_deduplication_preserves_symbol_tags_with_commas(self) -> None:
        categories = [{"0,0": 0.8, "group(c)": 0.8}, {"0,0": 0.9, "group(c)": 0.9, "smile": 0.8}]
        self.assertEqual(caption_from_tags(categories, escape_parens=True), "0,0, group\\(c\\), smile")

    def test_escape_parens(self) -> None:
        caption = caption_from_tags([{"group(c)": 0.6}], escape_parens=True)
        self.assertEqual(caption, "group\\(c\\)")


class SelectionSemanticsTests(unittest.TestCase):
    """前端 JS 移植版依赖的边界语义。"""

    def test_threshold_compares_widened_float32_in_float64(self) -> None:
        vocab = Vocabulary(["below", "above", "exact"], ["general"] * 3)
        just_below = np.float32(0.35)  # float32 最近值 0.3499999940… < 0.35
        just_above = np.nextafter(just_below, np.float32(1))
        scores = np.array([just_below, just_above, 0.5], dtype=np.float32)
        result = select(scores, vocab, SelectionPolicy(thresholds={"general": 0.35}))
        self.assertEqual(list(result[0]), ["above", "exact"])
        self.assertEqual(result[0]["above"], float(just_above))  # 无损扩展，未取整
        exact = select(scores, vocab, SelectionPolicy(thresholds={"general": 0.5}))
        self.assertEqual(list(exact[0]), ["exact"])  # 相等即入选

    def test_rating_argmax_tie_takes_first_in_vocabulary_order(self) -> None:
        vocab = Vocabulary(["general", "sensitive", "questionable"], ["rating"] * 3)
        scores = np.array([0.2, 0.7, 0.7], dtype=np.float32)
        self.assertEqual(list(select(scores, vocab, SelectionPolicy(thresholds={}))[0]), ["sensitive"])

    def test_policy_categories_default_to_first_appearance_order(self) -> None:
        from postprocess import policy_categories

        vocab = Vocabulary(["a", "b", "c", "d"], ["general", "character", "general", "rating"])
        self.assertEqual(policy_categories(vocab, SelectionPolicy(thresholds={})), ("general", "character", "rating"))
        explicit = SelectionPolicy(thresholds={}, categories=("rating", "artist"))
        self.assertEqual(policy_categories(vocab, explicit), ("rating", "artist"))


class MergeSelectionsTests(unittest.TestCase):
    def test_format_tag_rules(self) -> None:
        from postprocess import format_tag

        self.assertEqual(format_tag("long_hair"), "long hair")
        self.assertEqual(format_tag("Long_Hair"), "Long_Hair")  # 只有纯小写 [a-z0-9_] 才替换
        self.assertEqual(format_tag("hatsune_miku_(vocaloid)"), "hatsune_miku_(vocaloid)")
        self.assertEqual(format_tag("^_^"), "^_^")
        self.assertEqual(format_tag("long_hair", underscore_to_space=False), "long_hair")
        self.assertEqual(format_tag("miku_(cosplay)", escape_parens=True), "miku_\\(cosplay\\)")

    def test_merge_attributes_model_and_category_and_dedups_by_text(self) -> None:
        from postprocess import merge_selections

        merged = merge_selections([
            ("model-a", "general", {"blue_hair": 0.9, "solo": 0.8}),
            ("model-a", "character", {"hero": 0.7}),
            ("model-b", "general", {"blue hair": 0.95, "smile": 0.6}),
        ])
        self.assertEqual([tag["text"] for tag in merged], ["blue hair", "solo", "hero", "smile"])
        self.assertEqual(merged[0], {"name": "blue_hair", "text": "blue hair", "category": "general",
                                     "score": 0.9, "model": "model-a"})
        self.assertEqual(merged[3]["model"], "model-b")


class CaptionFileTests(unittest.TestCase):
    def test_write_and_skip_existing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp) / "img 001.png"
            image.write_bytes(b"png")
            self.assertTrue(write_caption_file(image, "1girl, solo"))
            self.assertEqual((Path(tmp) / "img 001.txt").read_text(encoding="utf-8"), "1girl, solo")
            # 默认不覆盖
            self.assertFalse(write_caption_file(image, "changed"))
            self.assertEqual((Path(tmp) / "img 001.txt").read_text(encoding="utf-8"), "1girl, solo")
            self.assertTrue(write_caption_file(image, "changed", overwrite=True))
            self.assertEqual((Path(tmp) / "img 001.txt").read_text(encoding="utf-8"), "changed")
            self.assertFalse(list(Path(tmp).glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()


class PixaiVocabularyTests(unittest.TestCase):
    def test_load_pixai_config(self) -> None:
        import json
        import tempfile
        from vocabulary import load_pixai_config

        with tempfile.TemporaryDirectory() as tmp:
            config = {
                "tags": ["1girl", "solo", "miku", "sketch", "rating:general"],
                "tags_split": [["general", 2], ["character", 1], ["style", 1], ["rating", 1]],
            }
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            vocab = load_pixai_config(path)
            self.assertEqual(vocab.names, ("1girl", "solo", "miku", "sketch", "rating:general"))
            self.assertEqual(sorted(vocab.category_index), ["character", "general", "rating", "style"])
            self.assertEqual(vocab.category_index["character"].tolist(), [2])

    def test_split_count_mismatch_rejected(self) -> None:
        import json
        import tempfile
        from vocabulary import load_pixai_config

        with tempfile.TemporaryDirectory() as tmp:
            config = {"tags": ["a", "b", "c"], "tags_split": [["general", 2]]}
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_pixai_config(path)


class ClVocabularyTests(unittest.TestCase):
    def test_load_cl_vocabulary(self) -> None:
        import json
        import tempfile
        from vocabulary import load_cl_vocabulary

        with tempfile.TemporaryDirectory() as tmp:
            data = {
                "num_tags": 3,
                "idx_to_tag": {"2": "miku", "0": "tree", "1": "sky"},
                "tag_to_category": {"tree": "General", "sky": "General", "miku": "Character"},
            }
            path = Path(tmp) / "model_vocabulary.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            vocab = load_cl_vocabulary(path)
            self.assertEqual(vocab.names, ("tree", "sky", "miku"))
            self.assertEqual(vocab.category_index["character"].tolist(), [2])

    def test_cl_incomplete_idx_rejected(self) -> None:
        import json
        import tempfile
        from vocabulary import load_cl_vocabulary

        with tempfile.TemporaryDirectory() as tmp:
            data = {"num_tags": 3, "idx_to_tag": {"0": "a"}, "tag_to_category": {"a": "General"}}
            path = Path(tmp) / "model_vocabulary.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_cl_vocabulary(path)
