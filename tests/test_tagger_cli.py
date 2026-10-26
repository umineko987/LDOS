import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tagger"))

from cli import build_parser, command_tag, scan_images


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


class TaggerCliTests(unittest.TestCase):
    def test_all_thresholds_and_default_all_categories_reach_runner(self) -> None:
        from unittest.mock import patch
        from runner import RunStats

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files = [root / "a.png", root / "b.png"]
            for file in files:
                file.write_bytes(b"image")
            categories = ["general", "character", "copyright", "quality", "meta", "rating", "style"]
            args = build_parser().parse_args([
                "tag", "--models", "wd-vit-v3", "--inputs", *(str(file) for file in files),
                "--cache", str(root / "cache.sqlite3"),
                *(arg for category in categories for arg in (f"--{category}-thr", "0.75")),
            ])
            args.models = ["wd-vit-v3"]
            with patch("runner.TaggerRunner") as runner:
                runner.return_value.run.return_value = RunStats(total=2)
                self.assertEqual(command_tag(args), 0)
            inputs, policy = runner.return_value.run.call_args.args
            self.assertEqual(inputs, files)
            self.assertEqual(policy.thresholds, dict.fromkeys(categories, 0.75))
            self.assertEqual(policy.categories, ())

    def test_per_model_thresholds_reach_runner(self) -> None:
        from unittest.mock import patch
        from runner import RunStats

        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp) / "a.png"
            image.write_bytes(b"image")
            args = build_parser().parse_args([
                "tag", "--models", "wd-vit-v3,pixai-tagger-v1", "--inputs", str(image),
                "--cache", str(Path(tmp) / "cache.sqlite3"),
                "--model-threshold", "wd-vit-v3", "general", "0.4",
                "--model-threshold", "pixai-tagger-v1", "general", "0.2",
                "--model-threshold", "pixai-tagger-v1", "style", "0.15",
            ])
            args.models = args.models.split(",")
            with patch("runner.TaggerRunner") as runner:
                runner.return_value.run.return_value = RunStats(total=1)
                self.assertEqual(command_tag(args), 0)
            self.assertEqual(runner.return_value.run.call_args.kwargs["model_thresholds"], {
                "wd-vit-v3": {"general": 0.4}, "pixai-tagger-v1": {"general": 0.2, "style": 0.15},
            })

    def test_invalid_model_thresholds_rejected_before_runner(self) -> None:
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp) / "a.png"
            image.write_bytes(b"image")
            for override in (("missing", "general", "0.4"), ("wd-vit-v3", "style", "0.4"),
                             ("wd-vit-v3", "general", "nan"), ("wd-vit-v3", "general", "1.5")):
                with self.subTest(override=override):
                    args = build_parser().parse_args([
                        "tag", "--models", "wd-vit-v3", "--inputs", str(image), "--model-threshold", *override,
                    ])
                    args.models = ["wd-vit-v3"]
                    with patch("runner.TaggerRunner") as runner:
                        self.assertEqual(command_tag(args), 2)
                        runner.assert_not_called()


if __name__ == "__main__":
    unittest.main()
