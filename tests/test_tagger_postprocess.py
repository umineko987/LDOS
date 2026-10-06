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
        policy = SelectionPolicy(thresholds={"general": 0.35, "character": 0.85})
        result = select(sample_scores(), sample_vocab(), policy)
        self.assertEqual(approx(result), [{"solo": 0.9, "1girl": 0.5}, {"hatsune_miku": 0.9}])
        # 0.34 < 0.35 被截掉，保持词表顺序

    def test_threshold_change_keeps_order_and_includes_more(self) -> None:
        policy = SelectionPolicy(thresholds={"general": 0.3, "character": 0.85})
        result = select(sample_scores(), sample_vocab(), policy)
        self.assertEqual(list(result[0]), ["solo", "1girl", "long_hair"])

    def test_rating_argmax(self) -> None:
        policy = SelectionPolicy(
            thresholds={"general": 0.35},
            categories=("general", "rating"),
        )
        result = select(sample_scores(), sample_vocab(), policy)
        self.assertEqual(approx(result)[1], {"sensitive": 0.8})

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

    def test_escape_parens(self) -> None:
        caption = caption_from_tags([{"group(c)": 0.6}], escape_parens=True)
        self.assertEqual(caption, "group\\(c\\)")


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
