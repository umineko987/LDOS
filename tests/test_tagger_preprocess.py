import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tagger"))

import numpy as np
from PIL import Image

from preprocess import load_image, wd_prepare
from vocabulary import Vocabulary, load_wd_csv


class VocabularyTests(unittest.TestCase):
    def _csv(self, root: Path) -> Path:
        path = root / "selected_tags.csv"
        path.write_text(
            "tag_id,name,category,count\n"
            "0,general_solo,0,100\n"
            "1,1girl,0,50\n"
            "2,chara_a,4,10\n"
            "3,general,9,5\n",
            encoding="utf-8",
        )
        return path

    def test_parse_order_and_categories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vocab = load_wd_csv(self._csv(Path(tmp)))
        self.assertEqual(vocab.names, ("general_solo", "1girl", "chara_a", "general"))
        self.assertEqual(vocab.categories(), ["general", "character", "rating"])
        self.assertEqual(vocab.category_index["general"].tolist(), [0, 1])
        self.assertEqual(vocab.category_index["character"].tolist(), [2])
        self.assertEqual(len(vocab), 4)

    def test_fingerprint_stable_and_order_sensitive(self) -> None:
        first = Vocabulary(["a", "b"], ["general", "general"])
        same = Vocabulary(["a", "b"], ["general", "general"])
        swapped = Vocabulary(["b", "a"], ["general", "general"])
        self.assertEqual(first.fingerprint, same.fingerprint)
        self.assertNotEqual(first.fingerprint, swapped.fingerprint)

    def test_rejects_unknown_category(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "selected_tags.csv"
            path.write_text("tag_id,name,category,count\n0,bad,7,1\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                load_wd_csv(path)


class PreprocessTests(unittest.TestCase):
    def test_alpha_composited_on_white(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rgba.png"
            overlay = Image.new("RGBA", (10, 10), (255, 0, 0, 128))
            overlay.save(path)
            image = load_image(path)
        self.assertEqual(image.mode, "RGB")
        pixel = image.getpixel((5, 5))
        # 红色 128/255 透明度叠白底 → (255,128,128) 附近
        self.assertGreater(pixel[0], 200)
        self.assertTrue(100 <= pixel[1] <= 155)
        self.assertTrue(100 <= pixel[2] <= 155)

    def test_wd_prepare_shape_bgr_and_padding(self) -> None:
        image = Image.new("RGB", (60, 20), (0, 0, 255))  # 蓝色横图
        result = wd_prepare(image, 32)
        self.assertEqual(result.shape, (32, 32, 3))
        self.assertEqual(result.dtype, np.float32)
        # 中心像素仍是蓝色：BGR 中 B=255 在通道 0
        center = result[16, 16]
        self.assertGreater(center[0], 200)
        self.assertLess(center[1], 60)
        self.assertLess(center[2], 60)
        # 上下边缘为白色 pad：B=G=R≈255
        edge = result[0, 16]
        self.assertGreater(edge.min(), 200)

    def test_wd_prepare_uneven_pad_rounding(self) -> None:
        image = Image.new("RGB", (61, 20), (255, 255, 255))
        result = wd_prepare(image, 16)
        self.assertEqual(result.shape, (16, 16, 3))


if __name__ == "__main__":
    unittest.main()
