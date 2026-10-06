import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tagger"))

from cli import scan_images


class ScanImagesTests(unittest.TestCase):
    def test_recursive_with_hidden_and_symlink_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "sub").mkdir()
            (root / ".hidden").mkdir()
            for path in (root / "a.png", root / "sub" / "b.jpg", root / "sub" / "c.webp"):
                path.write_bytes(b"x")
            (root / ".hidden" / "d.png").write_bytes(b"x")
            (root / "skip.txt").write_bytes(b"x")
            link = root / "link.png"
            link.symlink_to(root / "a.png")
            result = scan_images([root])
            self.assertEqual(
                sorted(item.name for item in result),
                ["a.png", "b.jpg", "c.webp"],
            )

    def test_single_file_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "image.PNG"
            file.write_bytes(b"x")
            self.assertEqual(scan_images([file]), [file])


if __name__ == "__main__":
    unittest.main()
