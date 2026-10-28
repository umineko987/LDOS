import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tagger"))

import numpy as np
from PIL import Image

from cache import TaggerCache
from postprocess import SelectionPolicy
from runner import TaggerRunner
from specs import TaggerModelSpec
from vocabulary import Vocabulary


def make_spec(key: str, thresholds: dict[str, float] | None = None) -> TaggerModelSpec:
    return TaggerModelSpec(
        key=key,
        repo="fake/repo",
        revision=f"rev-{key}",
        adapter="wd_onnx",
        files=(),
        default_thresholds=thresholds or {"general": 0.35, "character": 0.85},
        license="test",
    )


class FakeAdapter:
    """确定性假适配器：分数与图片内容无关，只验证 runner 的编排逻辑。"""

    SCORES = np.array([0.9, 0.34, 0.9], dtype=np.float32)
    vocabulary = Vocabulary(["solo", "long_hair", "hero"], ["general", "general", "character"])

    def __init__(self, spec: TaggerModelSpec, model_dir: Path):
        self.spec = spec
        self.fingerprint = ""
        self.calls = 0
        self.loads = 0
        self.batch_sizes: list[int] = []

    def describe(self) -> None:
        self.fingerprint = f"fake-{self.spec.key}-{self.spec.revision}"

    def load(self) -> None:
        self.describe()
        self.loads += 1

    def infer_scores(self, images) -> np.ndarray:
        self.calls += 1
        self.batch_sizes.append(len(images))
        return np.tile(self.SCORES, (len(images), 1))

    def close(self) -> None:
        return None


def factory(spec: TaggerModelSpec, model_dir: Path) -> FakeAdapter:
    return FakeAdapter(spec, model_dir)


class TaggerRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.images = self.root / "images"
        self.images.mkdir()
        for name, color in (("a.png", (120, 40, 200)), ("b.png", (10, 200, 90)), ("c.png", (200, 200, 10))):
            Image.new("RGB", (8, 8), color).save(self.images / name)
        self.cache = TaggerCache(self.root / "tags.sqlite3")
        self.specs = [make_spec("model-a"), make_spec("model-b", {"general": 0.5, "character": 0.85})]
        self.policy = SelectionPolicy(thresholds={}, categories=("general", "character"))
        self.adapters: list[FakeAdapter] = []

        original_factory = factory

        def collecting(spec, model_dir):
            adapter = original_factory(spec, model_dir)
            self.adapters.append(adapter)
            return adapter

        self.runner = TaggerRunner(
            self.root, self.cache, self.specs,
            adapter_factory=collecting, batch_size=2, decode_workers=2,
        )

    def tearDown(self) -> None:
        self.cache.close()
        self._tmp.cleanup()

    def files(self) -> list[Path]:
        return sorted(self.images.glob("*.png"))

    def test_first_run_writes_captions_and_cache(self) -> None:
        stats = self.runner.run(self.files(), self.policy)
        self.assertEqual(stats.total, 3)
        self.assertEqual(stats.decode_errors, [])
        for spec in self.specs:
            self.assertEqual(stats.per_model[spec.key].inferred, 3)
            self.assertEqual(stats.per_model[spec.key].score_cache_hits, 0)
        self.assertEqual(stats.captions_written, 3)  # 每图只写一个合并后的 txt
        self.assertEqual((self.images / "a.txt").read_text(encoding="utf-8"), "solo, hero")
        self.assertEqual(sorted(path.name for path in self.images.glob("*.txt")), ["a.txt", "b.txt", "c.txt"])
        # 分数已入缓存
        from runner import file_sha256
        digest = file_sha256(self.images / "a.png")
        self.assertIsNotNone(self.cache.get_scores(self.adapters[0].fingerprint, digest))

    def test_merge_preserves_model_order_and_appends_only_new_tags_with_cache(self) -> None:
        def differing_models(spec, model_dir):
            adapter = FakeAdapter(spec, model_dir)
            names = ["solo", "blue_hair", "hero"] if spec.key == "model-a" else ["blue hair", "smile", "hero"]
            adapter.vocabulary = Vocabulary(names, ["general", "general", "character"])
            adapter.SCORES = np.full(3, 0.9, dtype=np.float32)
            return adapter

        self.runner.adapter_factory = differing_models
        stats = self.runner.run(self.files(), self.policy)
        self.assertEqual(stats.captions_written, 3)
        self.assertEqual((self.images / "a.txt").read_text(), "solo, blue hair, hero, smile")

        # 调换模型顺序仅改变合并顺序，分数和独立筛选缓存仍复用。
        self.runner.specs.reverse()
        stats = self.runner.run(self.files(), self.policy, overwrite_captions=True)
        self.assertEqual((self.images / "a.txt").read_text(), "blue hair, smile, hero, solo")
        for model in stats.per_model.values():
            self.assertEqual(model.inferred, 0)
            self.assertEqual(model.selected_cache_hits, 3)

    def test_existing_caption_is_skipped_or_replaced_not_appended(self) -> None:
        caption = self.images / "a.txt"
        caption.write_text("manual tag, solo", encoding="utf-8")
        old_sidecar = self.images / "a.model-b.txt"
        old_sidecar.write_text("old model tags", encoding="utf-8")

        stats = self.runner.run(self.files(), self.policy)
        self.assertEqual(stats.captions_written, 2)
        self.assertEqual(stats.captions_skipped, 1)
        self.assertEqual(caption.read_text(), "manual tag, solo")
        self.assertEqual(old_sidecar.read_text(), "old model tags")

        stats = self.runner.run(self.files(), self.policy, overwrite_captions=True)
        self.assertEqual(stats.captions_written, 3)
        self.assertEqual(stats.captions_skipped, 0)
        self.assertEqual(caption.read_text(), "solo, hero")
        self.assertEqual(old_sidecar.read_text(), "old model tags")
        self.assertFalse((self.images / "b.model-b.txt").exists())

    def test_no_captions_still_selects_each_model_without_writing_files(self) -> None:
        stats = self.runner.run(self.files(), self.policy, write_captions=False)
        self.assertEqual(stats.captions_written, 0)
        self.assertEqual(stats.captions_skipped, 0)
        self.assertEqual(list(self.images.glob("*.txt")), [])
        cached = self.runner.run(self.files(), self.policy, write_captions=False)
        self.assertTrue(all(model.selected_cache_hits == 3 for model in cached.per_model.values()))

    def test_single_model_caption_is_unchanged(self) -> None:
        self.runner.specs = self.specs[:1]
        stats = self.runner.run(self.files()[:1], self.policy)
        self.assertEqual(stats.captions_written, 1)
        self.assertEqual((self.images / "a.txt").read_text(), "solo, hero")

    def test_batch_size_and_each_models_missing_subset(self) -> None:
        first, second, third = self.files()
        from runner import file_sha256
        self.cache.put_scores(f"fake-{self.specs[0].key}-{self.specs[0].revision}", [(file_sha256(first), FakeAdapter.SCORES)])
        self.cache.put_scores(f"fake-{self.specs[1].key}-{self.specs[1].revision}", [(file_sha256(third), FakeAdapter.SCORES)])
        stats = self.runner.run([first, second, third], self.policy)
        self.assertEqual(self.adapters[0].batch_sizes, [1, 1])
        self.assertEqual(self.adapters[1].batch_sizes, [2])
        for spec in self.specs:
            self.assertEqual(stats.per_model[spec.key].inferred, 2)
            self.assertEqual(stats.per_model[spec.key].score_cache_hits, 1)

    def test_configured_batch_size_is_used_with_partial_tail(self) -> None:
        self.runner.batch_size = 2
        self.runner.run(self.files(), self.policy)
        self.assertEqual([adapter.batch_sizes for adapter in self.adapters], [[2, 1], [2, 1]])

    def test_second_run_hits_score_cache_and_selected(self) -> None:
        self.runner.run(self.files(), self.policy)
        self.adapters.clear()
        stats = self.runner.run(self.files(), self.policy)
        for spec in self.specs:
            self.assertEqual(stats.per_model[spec.key].inferred, 0)
            self.assertEqual(stats.per_model[spec.key].score_cache_hits, 3)
            self.assertEqual(stats.per_model[spec.key].selected_cache_hits, 3)
        # 默认不覆盖已有 caption
        self.assertEqual(stats.captions_written, 0)
        self.assertEqual(stats.captions_skipped, 3)

    def test_policy_change_reselects_without_inference(self) -> None:
        self.runner.run(self.files(), self.policy)
        self.adapters.clear()
        # 阈值降低：long_hair(0.34) 进入 general 结果
        looser = SelectionPolicy(thresholds={"general": 0.3}, categories=("general", "character"))
        stats = self.runner.run(self.files(), looser, overwrite_captions=True)
        for spec in self.specs:
            self.assertEqual(stats.per_model[spec.key].inferred, 0)  # 未重新推理
            self.assertEqual(stats.per_model[spec.key].selected_cache_hits, 0)
        self.assertEqual((self.images / "a.txt").read_text(encoding="utf-8"), "solo, long hair, hero")

    def test_model_thresholds_are_independent_and_only_reselect_changed_model(self) -> None:
        self.runner.run(self.files(), self.policy)
        overrides = {"model-a": {"general": 0.3}}
        stats = self.runner.run(self.files(), self.policy, model_thresholds=overrides, overwrite_captions=True)
        self.assertEqual((self.images / "a.txt").read_text(), "solo, long hair, hero")
        from runner import file_sha256
        model_b = self.adapters[1]
        effective = self.runner._effective_policy(model_b.spec, self.policy, {})
        cached = self.cache.get_selected(model_b.fingerprint, effective.fingerprint, file_sha256(self.files()[0]))
        self.assertEqual([list(category) for category in cached], [["solo"], ["hero"]])
        self.assertEqual(stats.per_model["model-a"].selected_cache_hits, 0)
        self.assertEqual(stats.per_model["model-b"].selected_cache_hits, 3)
        self.assertTrue(all(model.inferred == 0 for model in stats.per_model.values()))

        stats = self.runner.run(self.files(), self.policy, model_thresholds=overrides)
        self.assertTrue(all(model.selected_cache_hits == 3 for model in stats.per_model.values()))
        # 清空覆盖后恢复各自默认值，且仍不重新推理。
        stats = self.runner.run(self.files(), self.policy, overwrite_captions=True)
        self.assertEqual((self.images / "a.txt").read_text(), "solo, hero")
        self.assertTrue(all(model.inferred == 0 for model in stats.per_model.values()))

    def test_model_threshold_takes_precedence_over_cli_global_threshold(self) -> None:
        policy = SelectionPolicy(thresholds={"general": 0.3})
        self.runner.run(self.files(), policy, model_thresholds={"model-a": {"general": 0.95}})
        self.assertEqual((self.images / "a.txt").read_text(), "hero, solo, long hair")
        self.assertFalse((self.images / "a.model-b.txt").exists())

    def test_same_content_different_path_reuses_scores(self) -> None:
        self.runner.run(self.files(), self.policy)
        duplicate = self.images / "copy.png"
        (self.images / "a.png").replace(duplicate)
        self.adapters.clear()
        Image.new("RGB", (8, 8), (5, 5, 5)).save(self.images / "a.png")  # 内容不同
        stats = self.runner.run(self.files(), self.policy)
        # copy.png 与历史内容相同 → 命中；新的 a.png 需要推理；b/c 命中
        for spec in self.specs:
            self.assertEqual(stats.per_model[spec.key].inferred, 1)
            self.assertEqual(stats.per_model[spec.key].score_cache_hits, 3)

    def test_decode_error_continues(self) -> None:
        files = self.files()
        broken = self.images / "broken.png"
        broken.write_bytes(b"not a png at all")
        stats = self.runner.run([*files, broken], self.policy)
        self.assertEqual(len(stats.decode_errors), 1)
        for spec in self.specs:
            self.assertEqual(stats.per_model[spec.key].inferred, 3)
        self.assertFalse((self.images / "broken.txt").exists())

    def test_fully_cached_run_never_loads_weights(self) -> None:
        self.runner.run(self.files(), self.policy, write_captions=False)
        self.assertEqual([adapter.loads for adapter in self.adapters], [1, 1])
        self.adapters.clear()
        stats = self.runner.run(self.files(), self.policy, write_captions=False)
        self.assertEqual([adapter.loads for adapter in self.adapters], [0, 0])
        self.assertFalse(any(model.loaded for model in stats.per_model.values()))

    def test_only_models_missing_scores_load_weights(self) -> None:
        from runner import file_sha256
        fingerprint = f"fake-{self.specs[0].key}-{self.specs[0].revision}"
        self.cache.put_scores(fingerprint, [(file_sha256(path), FakeAdapter.SCORES) for path in self.files()])
        stats = self.runner.run(self.files(), self.policy, write_captions=False)
        self.assertEqual([adapter.loads for adapter in self.adapters], [0, 1])
        self.assertEqual([adapter.calls for adapter in self.adapters], [0, 2])
        self.assertFalse(stats.per_model["model-a"].loaded)
        self.assertTrue(stats.per_model["model-b"].loaded)

    def test_load_fingerprint_must_match_describe(self) -> None:
        from adapters import TaggerAdapterError

        class DriftingAdapter(FakeAdapter):
            def load(self) -> None:
                self.fingerprint = "different"

        self.runner.adapter_factory = DriftingAdapter
        with self.assertRaises(TaggerAdapterError):
            self.runner.run(self.files(), self.policy)

    def test_on_result_reports_structured_tags_without_writing_files(self) -> None:
        from runner import file_sha256

        results = []
        self.runner.run(self.files(), self.policy, write_captions=False, on_result=results.append)
        self.assertEqual(list(self.images.glob("*.txt")), [])
        self.assertEqual([result.path for result in results], self.files())
        first = results[0]
        self.assertEqual(first.status, "ok")
        self.assertEqual(first.sha256, file_sha256(self.files()[0]))
        self.assertEqual(first.caption, "solo, hero")
        self.assertEqual(
            [(tag["name"], tag["category"], tag["model"]) for tag in first.tags],
            [("solo", "general", "model-a"), ("hero", "character", "model-a")],
        )
        payload = first.to_payload()
        self.assertEqual(payload["type"], "result")
        self.assertEqual(payload["tags"][0]["score"], 0.9)  # 展示用 5 位小数

    def test_on_result_matches_written_caption_and_format_flags(self) -> None:
        looser = SelectionPolicy(thresholds={"general": 0.3}, categories=("general", "character"))
        results = []
        self.runner.run(self.files()[:1], looser, underscore_to_space=False, on_result=results.append)
        self.assertEqual(results[0].caption, "solo, long_hair, hero")
        self.assertEqual((self.images / "a.txt").read_text(), "solo, long_hair, hero")

    def test_unreadable_and_undecodable_files_are_reported_not_fatal(self) -> None:
        files = self.files()
        broken = self.images / "broken.png"
        broken.write_bytes(b"not a png")
        vanished = self.images / "vanished.png"
        results = []
        stats = self.runner.run([*files, broken, vanished], self.policy, on_result=results.append)
        self.assertEqual(stats.unreadable, [str(vanished)])
        self.assertEqual(stats.decode_errors, [str(broken)])
        by_name = {result.path.name: result for result in results}
        self.assertEqual(by_name["vanished.png"].status, "unreadable")
        self.assertIsNone(by_name["vanished.png"].sha256)
        self.assertEqual(by_name["broken.png"].status, "decode_error")
        self.assertEqual(by_name["a.png"].status, "ok")
        self.assertEqual(stats.captions_written, 3)


class ScoreQueryTests(unittest.TestCase):
    """candidates/compose：只读缓存，只 describe() 不加载权重。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.images = self.root / "images"
        self.images.mkdir()
        for name, color in (("a.png", (120, 40, 200)), ("b.png", (10, 200, 90))):
            Image.new("RGB", (8, 8), color).save(self.images / name)
        self.cache = TaggerCache(self.root / "tags.sqlite3")
        self.specs = [make_spec("model-a"), make_spec("model-b", {"general": 0.5, "character": 0.85})]
        self.adapters: list[FakeAdapter] = []
        self.files = sorted(self.images.glob("*.png"))
        TaggerRunner(self.root, self.cache, self.specs, adapter_factory=self.factory).run(
            self.files, SelectionPolicy(thresholds={}), write_captions=False,
        )
        self.adapters.clear()

    def tearDown(self) -> None:
        self.cache.close()
        self._tmp.cleanup()

    def factory(self, spec, model_dir):
        adapter = FakeAdapter(spec, model_dir)
        self.adapters.append(adapter)
        return adapter

    def inputs(self, *paths):
        from runner import LookupInput
        return [LookupInput(path) for path in (paths or self.files)]

    def candidates(self, inputs, **kwargs) -> list[dict]:
        from runner import run_candidates
        return list(run_candidates(self.root, self.cache, self.specs, inputs, adapter_factory=self.factory, **kwargs))

    def test_candidates_stream_header_lines_and_done_without_loading(self) -> None:
        lines = self.candidates(self.inputs())
        header, first, second, done = lines
        self.assertEqual(header["type"], "models")
        self.assertEqual(header["floor"], 0.05)
        self.assertEqual([model["key"] for model in header["models"]], ["model-a", "model-b"])
        self.assertEqual(header["models"][0]["fingerprint"], "fake-model-a-rev-model-a")
        self.assertEqual(header["models"][0]["categories"], ["general", "character"])
        self.assertEqual(header["models"][1]["default_thresholds"], {"general": 0.5, "character": 0.85})
        self.assertEqual(first["type"], "candidates")
        self.assertEqual(first["status"], "ok")
        self.assertEqual(first["path"], str(self.files[0]))
        expected = [["solo", "general", float(np.float32(0.9))], ["long_hair", "general", float(np.float32(0.34))],
                    ["hero", "character", float(np.float32(0.9))]]
        self.assertEqual(first["models"]["model-a"], expected)
        self.assertEqual(second["models"]["model-b"], expected)
        self.assertEqual(done, {"type": "done", "command": "candidates", "total": 2, "ok": 2,
                                "missing_scores": 0, "decode_error": 0, "unreadable": 0, "inferred": {}})
        self.assertEqual([adapter.loads for adapter in self.adapters], [0, 0])

    def test_floor_drops_low_scores_but_keeps_every_rating_tag(self) -> None:
        from runner import sparse_candidates

        vocab = Vocabulary(["general", "solo", "sensitive", "hat"], ["rating", "general", "rating", "general"])
        scores = np.array([0.01, 0.9, 0.02, 0.049], dtype=np.float32)
        self.assertEqual(
            [entry[0] for entry in sparse_candidates(scores, vocab, 0.05)],
            ["general", "solo", "sensitive"],
        )
        self.assertEqual(len(sparse_candidates(scores, vocab, 0.0)), 4)

    def test_known_hash_is_trusted_and_unknown_files_are_unreadable(self) -> None:
        from runner import LookupInput, file_sha256

        moved = LookupInput(self.root / "gone.png", file_sha256(self.files[0]))
        missing = LookupInput(self.root / "missing.png")
        _, trusted, unreadable, done = self.candidates([moved, missing])
        self.assertEqual(trusted["status"], "ok")
        self.assertEqual(unreadable["status"], "unreadable")
        self.assertEqual(unreadable["missing_models"], ["model-a", "model-b"])
        self.assertEqual((done["ok"], done["unreadable"]), (1, 1))

    def test_uncached_image_is_missing_until_computed(self) -> None:
        fresh = self.images / "fresh.png"
        Image.new("RGB", (8, 8), (1, 2, 3)).save(fresh)
        _, line, done = self.candidates(self.inputs(fresh))
        self.assertEqual(line["status"], "missing_scores")
        self.assertEqual(line["missing_models"], ["model-a", "model-b"])
        self.assertEqual(line["models"], {})
        self.assertEqual(done["missing_scores"], 1)

        computed = self.candidates(self.inputs(fresh, *self.files), compute=True)
        self.assertEqual([line["status"] for line in computed[1:-1]], ["ok", "ok", "ok"])
        self.assertEqual(computed[-1]["inferred"], {"model-a": 1, "model-b": 1})  # 只推理缺的那张
        again = self.candidates(self.inputs(fresh), compute=True)
        self.assertEqual(again[-1]["inferred"], {})  # 已入库，不再推理

    def test_compute_reports_inferred_counts_and_decode_errors(self) -> None:
        fresh = self.images / "fresh.png"
        Image.new("RGB", (8, 8), (1, 2, 3)).save(fresh)
        broken = self.images / "broken.png"
        broken.write_bytes(b"nope")
        lines = self.candidates(self.inputs(fresh, broken, self.files[0]), compute=True)
        self.assertEqual([line["status"] for line in lines[1:-1]], ["ok", "decode_error", "ok"])
        self.assertEqual(lines[-1]["inferred"], {"model-a": 1, "model-b": 1})
        self.assertEqual(lines[-1]["decode_error"], 1)

    def compose(self, inputs, policy, **kwargs) -> list[dict]:
        from runner import run_compose
        return list(run_compose(self.root, self.cache, self.specs, inputs, policy,
                                adapter_factory=self.factory, **kwargs))

    def test_compose_matches_tag_run_results_and_writes_nothing(self) -> None:
        policy = SelectionPolicy(thresholds={}, categories=("general", "character"))
        overrides = {"model-b": {"general": 0.3}}
        lines = self.compose(self.inputs(), policy, model_thresholds=overrides)
        header, first, _, done = lines
        self.assertEqual(header["models"][1]["thresholds"], {"general": 0.3, "character": 0.85})
        self.assertEqual(header["models"][0]["selected_categories"], ["general", "character"])
        self.assertEqual(first["caption"], "solo, hero, long hair")
        self.assertEqual(first["tags"][2]["model"], "model-b")
        self.assertEqual((done["command"], done["total"], done["ok"]), ("compose", 2, 2))
        self.assertEqual(list(self.images.glob("*.txt")), [])

        tagged = []
        TaggerRunner(self.root, self.cache, self.specs, adapter_factory=self.factory).run(
            self.files, policy, model_thresholds=overrides, write_captions=False, on_result=tagged.append,
        )
        self.assertEqual([result.to_payload() for result in tagged], lines[1:-1])
        self.assertTrue(all(adapter.loads == 0 for adapter in self.adapters))

    def test_compose_format_flags_and_missing_scores(self) -> None:
        fresh = self.images / "fresh.png"
        Image.new("RGB", (8, 8), (9, 9, 9)).save(fresh)
        policy = SelectionPolicy(thresholds={"general": 0.3})
        _, cached, uncached, done = self.compose(self.inputs(self.files[0], fresh), policy, underscore_to_space=False)
        self.assertEqual(cached["caption"], "solo, long_hair, hero")
        self.assertEqual(uncached["status"], "missing_scores")
        self.assertEqual(uncached["caption"], "")
        self.assertEqual(done["missing_scores"], 1)

    def test_describe_failure_is_raised_before_any_output(self) -> None:
        from adapters import TaggerAdapterError
        from runner import run_compose

        class NotInstalled(FakeAdapter):
            def describe(self) -> None:
                raise TaggerAdapterError("模型未安装")

        lines = run_compose(self.root, self.cache, self.specs, self.inputs(), SelectionPolicy(thresholds={}),
                            adapter_factory=NotInstalled)
        with self.assertRaises(TaggerAdapterError):
            next(lines)


if __name__ == "__main__":
    unittest.main()
