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


def parse(*argv: str):
    args = build_parser().parse_args(list(argv))
    args.models = [key.strip() for key in args.models.split(",") if key.strip()]
    return args


def stdin_bytes(data: bytes):
    import io
    return io.TextIOWrapper(io.BytesIO(data), encoding="utf-8")


def captured_lines(function, *args, **kwargs) -> tuple[int, list[dict]]:
    import contextlib
    import io
    import json

    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = function(*args, **kwargs)
    text = buffer.getvalue()
    text.encode("ascii")  # 数据行一律 ASCII 转义
    return code, [json.loads(line) for line in text.splitlines()]


class InputsFileTests(unittest.TestCase):
    HASH = "ab" * 32

    def test_file_with_bom_crlf_blank_lines_and_known_hashes(self) -> None:
        from cli import read_inputs_file

        with tempfile.TemporaryDirectory() as tmp:
            listing = Path(tmp) / "inputs.txt"
            listing.write_bytes(
                "﻿/data/图 1.png\r\n\r\n   \n".encode("utf-8")
                + f"{self.HASH}\t/data/known one.png\n".encode()
                + b"/data/with\ttab.png\n"
                + f"{self.HASH.upper()}\t/data/upper.png".encode()
            )
            entries = read_inputs_file(str(listing))
        self.assertEqual([(str(entry.path), entry.sha256) for entry in entries], [
            ("/data/图 1.png", None),
            ("/data/known one.png", self.HASH),
            ("/data/with\ttab.png", None),
            (f"{self.HASH.upper()}\t/data/upper.png", None),  # 只认小写十六进制
        ])

    def test_stdin_and_undecodable_bytes_round_trip(self) -> None:
        import os
        from unittest.mock import patch
        from cli import read_inputs_file

        with patch("sys.stdin", stdin_bytes(b"/data/a.png\n/data/\xff\xfe.png\n")):
            entries = read_inputs_file("-")
        self.assertEqual(str(entries[0].path), "/data/a.png")
        self.assertEqual(os.fsencode(str(entries[1].path)), b"/data/\xff\xfe.png")

    def test_tag_reads_inputs_file_from_stdin_and_expands_directories(self) -> None:
        from unittest.mock import patch
        from runner import RunStats

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "dir").mkdir()
            nested = root / "dir" / "b.png"
            nested.write_bytes(b"x")
            listed = root / "a.png"
            vanished = root / "gone.png"
            args = parse("tag", "--models", "wd-vit-v3", "--inputs-file", "-", "--no-captions",
                         "--cache", str(root / "cache.sqlite3"))
            listing = f"{listed}\n{self.HASH}\t{vanished}\n{root / 'dir'}\n".encode()
            import contextlib
            import io

            output = io.StringIO()
            with patch("sys.stdin", stdin_bytes(listing)), patch("runner.TaggerRunner") as runner, \
                    contextlib.redirect_stdout(output):
                runner.return_value.run.return_value = RunStats(total=3)
                code = command_tag(args)
        self.assertEqual(code, 0)
        files, _ = runner.return_value.run.call_args.args
        # 缺失文件保留给 runner 报告 unreadable；tag 忽略给定哈希
        self.assertEqual(files, [listed, vanished, nested])
        self.assertFalse(runner.return_value.run.call_args.kwargs["write_captions"])
        self.assertIsNone(runner.return_value.run.call_args.kwargs["on_result"])
        self.assertIn("完成：共 3 张", output.getvalue())  # 未加 --progress-json/--emit-results：人类可读输出

    def test_inputs_and_inputs_file_are_mutually_exclusive_and_required(self) -> None:
        import contextlib
        import io

        for argv in (["tag", "--models", "wd-vit-v3"],
                     ["tag", "--models", "wd-vit-v3", "--inputs", "a.png", "--inputs-file", "-"],
                     ["compose", "--models", "wd-vit-v3"]):
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    build_parser().parse_args(argv)

    def test_emit_results_streams_one_ascii_line_per_image_then_done(self) -> None:
        from unittest.mock import patch
        from runner import ImageResult, RunStats

        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp) / "画像.png"
            image.write_bytes(b"x")
            args = parse("tag", "--models", "wd-vit-v3", "--inputs", str(image), "--emit-results",
                         "--keep-underscores", "--escape-parens", "--cache", str(Path(tmp) / "c.sqlite3"))

            def fake_run(files, policy, **kwargs):
                tags = [{"name": "long_hair", "text": "long_hair", "category": "general",
                         "score": 0.912345678, "model": "wd-vit-v3"}]
                kwargs["on_result"](ImageResult(files[0], "cd" * 32, "ok", tags))
                return RunStats(total=1)

            with patch("runner.TaggerRunner") as runner:
                runner.return_value.run.side_effect = fake_run
                code, lines = captured_lines(command_tag, args)
        self.assertEqual(code, 0)
        kwargs = runner.return_value.run.call_args.kwargs
        self.assertFalse(kwargs["underscore_to_space"])
        self.assertTrue(kwargs["escape_parens"])
        result, done = lines
        self.assertEqual(result, {
            "type": "result", "path": str(image), "sha256": "cd" * 32, "status": "ok", "missing_models": [],
            "tags": [{"name": "long_hair", "text": "long_hair", "category": "general",
                      "score": 0.91235, "model": "wd-vit-v3"}],
            "caption": "long_hair",
        })
        self.assertEqual((done["type"], done["command"], done["unreadable"]), ("done", "tag", []))


class FakeQueryAdapter:
    """按真实 spec key 构造、只 describe() 的假适配器。"""

    def __init__(self, spec, model_dir):
        import numpy as np
        from vocabulary import Vocabulary

        self.spec = spec
        self.vocabulary = Vocabulary(["general", "sensitive", "long_hair", "hero"],
                                     ["rating", "rating", "general", "character"])
        self.scores = np.array([0.02, 0.6, 0.4, 0.9], dtype=np.float32)
        self.fingerprint = ""

    def describe(self) -> None:
        self.fingerprint = f"fake-{self.spec.key}"

    def load(self) -> None:
        raise AssertionError("只读查询不应加载权重")

    def close(self) -> None:
        return None


class QueryCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        from cache import TaggerCache
        from runner import file_sha256

        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.image = self.root / "a.png"
        self.image.write_bytes(b"image-a")
        self.cache_path = self.root / "cache.sqlite3"
        cache = TaggerCache(self.cache_path)
        import numpy as np
        cache.put_scores("fake-wd-vit-v3", [(file_sha256(self.image), np.array([0.02, 0.6, 0.4, 0.9], dtype=np.float32))])
        cache.close()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_candidates_command_streams_header_rows_and_done(self) -> None:
        from cli import command_candidates

        args = parse("--model-dir", str(self.root / "models"), "candidates", "--models", "wd-vit-v3",
                     "--inputs", str(self.image), "--cache", str(self.cache_path), "--floor", "0.5")
        code, lines = captured_lines(command_candidates, args, adapter_factory=FakeQueryAdapter)
        self.assertEqual(code, 0)
        header, row, done = lines
        self.assertEqual((header["type"], header["floor"], header["models"][0]["key"]), ("models", 0.5, "wd-vit-v3"))
        self.assertEqual(row["models"]["wd-vit-v3"], [
            ["general", "rating", 0.019999999552965164],
            ["sensitive", "rating", 0.6000000238418579],
            ["hero", "character", 0.8999999761581421],
        ])
        self.assertEqual((done["type"], done["ok"]), ("done", 1))

    def test_compose_command_applies_thresholds_and_format(self) -> None:
        from cli import command_compose

        args = parse("compose", "--models", "wd-vit-v3", "--inputs", str(self.image), "--cache", str(self.cache_path),
                     "--model-threshold", "wd-vit-v3", "general", "0.3", "--keep-underscores")
        code, lines = captured_lines(command_compose, args, adapter_factory=FakeQueryAdapter)
        self.assertEqual(code, 0)
        _, result, done = lines
        self.assertEqual(result["caption"], "sensitive, long_hair, hero")
        self.assertEqual(done["command"], "compose")

    def test_invalid_arguments_and_unavailable_models(self) -> None:
        import contextlib
        import io
        from cli import command_candidates, command_compose

        base = ["--inputs", str(self.image), "--cache", str(self.cache_path)]
        cases = [
            (command_candidates, parse("candidates", "--models", "wd-vit-v3", *base, "--floor", "1.5"), 2),
            (command_candidates, parse("candidates", "--models", "nope", *base), 2),
            (command_compose, parse("compose", "--models", "wd-vit-v3", *base,
                                    "--model-threshold", "wd-vit-v3", "style", "0.4"), 2),
            (command_compose, parse("compose", "--models", "wd-vit-v3", "--inputs", str(self.root / "none"),
                                    "--cache", str(self.cache_path)), 1),
            # 真实适配器 + 空模型目录：describe() 报未安装，退出码 4 且不输出数据行
            (command_candidates, parse("--model-dir", str(self.root / "empty"), "candidates",
                                       "--models", "wd-vit-v3", *base), 4),
        ]
        for function, args, expected in cases:
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()):
                code, lines = captured_lines(function, args)
                self.assertEqual(code, expected)
                self.assertEqual(lines, [])

    def test_cli_help_lists_new_subcommands(self) -> None:
        import subprocess

        result = subprocess.run([sys.executable, "-I", "-B", str(ROOT / "tagger" / "cli.py"), "--help"],
                                capture_output=True, text=True, check=True)
        for command in ("prepare", "tag", "candidates", "compose"):
            self.assertIn(command, result.stdout)


if __name__ == "__main__":
    unittest.main()
