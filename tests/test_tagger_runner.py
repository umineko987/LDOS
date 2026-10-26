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
        self.fingerprint = f"fake-{spec.key}-{spec.revision}"
        self.calls = 0
        self.batch_sizes: list[int] = []

    def load(self) -> None:
        return None

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


if __name__ == "__main__":
    unittest.main()
