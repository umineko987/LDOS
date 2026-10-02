import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dedup"))
SCRIPT_PATH = ROOT / "dedup" / "dedup_core.py"
SPEC = importlib.util.spec_from_file_location("dedup_script_real", SCRIPT_PATH)
DEDUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEDUP)

FIXTURE_ROOT = ROOT / "tests" / "fixtures" / "real_variant_pairs"
PAIR_NAMES = {
    "recolored": ("recolored-sketch-a.png", "recolored-sketch-b.png"),
    "structure": ("structure-color.png", "structure-gray.png"),
}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class RealVariantPairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(
            (FIXTURE_ROOT / "manifest.json").read_text(encoding="utf-8")
        )
        cls.embedding_document = json.loads(
            (FIXTURE_ROOT / "embeddings.json").read_text(encoding="utf-8")
        )
        for name, metadata in cls.manifest["files"].items():
            path = FIXTURE_ROOT / name
            if not path.is_file():
                raise AssertionError(f"缺少可重复变体夹具: {name}")
            if path.stat().st_size != metadata["bytes"]:
                raise AssertionError(f"变体夹具体积漂移: {name}")
            if sha256(path) != metadata["sha256"]:
                raise AssertionError(f"变体夹具哈希漂移: {name}")

        names = [name for pair in PAIR_NAMES.values() for name in pair]
        cls.infos = {
            name: DEDUP.get_image_info(str(FIXTURE_ROOT / name)) for name in names
        }
        committed_vectors = cls.embedding_document["vectors"]
        vectors = committed_vectors

        real_model_mode = os.environ.get("LDOS_REAL_MODELS", "").strip()
        if real_model_mode not in {"", "0", "1"}:
            raise AssertionError("LDOS_REAL_MODELS 只接受 0、1 或未设置")
        if real_model_mode == "1":
            from dedup_models import DeepEmbeddingExtractor

            extractor = DeepEmbeddingExtractor(
                ROOT / ".models",
                device="cpu",
                batch_size=len(names),
            )
            actual = {name: {} for name in names}
            try:
                ordered_infos = [cls.infos[name] for name in names]
                for model_name, key in (
                    ("sscd", "sscd_embedding"),
                    ("dino", "dino_embedding"),
                ):
                    for name, vector in zip(
                        names,
                        extractor.encode_infos(ordered_infos, model_name),
                    ):
                        actual[name][key] = [
                            float(value) for value in np.asarray(vector, dtype=np.float32)
                        ]
            finally:
                extractor.close()

            for name in names:
                for key in ("sscd_embedding", "dino_embedding"):
                    expected = np.asarray(committed_vectors[name][key], dtype=np.float32)
                    observed = np.asarray(actual[name][key], dtype=np.float32)
                    np.testing.assert_equal(observed.shape, expected.shape)
                    cosine = float(np.dot(observed, expected))
                    if cosine < 0.9999:
                        raise AssertionError(
                            f"固定模型输出漂移: {name}/{key}, cosine={cosine:.8f}"
                        )
            vectors = actual

        for name in names:
            for key in ("sscd_embedding", "dino_embedding"):
                vector = np.asarray(vectors[name][key], dtype=np.float32)
                if vector.ndim != 1 or not np.isfinite(vector).all():
                    raise AssertionError(f"非法夹具向量: {name}/{key}")
                if not np.isclose(np.linalg.norm(vector), 1.0, atol=1e-5):
                    raise AssertionError(f"夹具向量未归一化: {name}/{key}")
                cls.infos[name][key] = vector

        cls.args = SimpleNamespace(
            no_sscd=False,
            no_dino=False,
            sscd_review_threshold=0.72,
            dino_review_threshold=0.82,
            edge_review_threshold=0.32,
            geometry_review_threshold=0.035,
            dino_phash_threshold=18,
            deep_max_aspect_delta=0.20,
            hash_threshold=12,
            compression_hash_threshold=20,
            similarity_threshold=0.88,
            compression_noise_residual_std=0.45,
            compression_noise_edge_correlation=0.05,
            compression_noise_sigma_delta=0.25,
        )

    def test_fixture_images_are_reproducible(self):
        generator_path = FIXTURE_ROOT / "generate.py"
        specification = importlib.util.spec_from_file_location(
            "real_variant_fixture_generator",
            generator_path,
        )
        generator = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(generator)
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary)
            generator.render_fixtures(destination)
            for name in generator.IMAGE_NAMES:
                generated = destination / name
                committed = FIXTURE_ROOT / name
                self.assertEqual(
                    generator.pixel_sha256(generated),
                    generator.pixel_sha256(committed),
                    name,
                )

    def test_fixture_origin_license_and_model_hashes_are_explicit(self):
        self.assertEqual(self.manifest["license"]["spdx"], "MIT")
        self.assertIn("original deterministic drawings", self.manifest["origin"])
        self.assertEqual(
            set(self.manifest["models"]),
            {"sscd", "dino"},
        )
        for model in self.manifest["models"].values():
            self.assertRegex(model["artifact_sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(model["source"])

    def test_recolored_sketch_pair_enters_l1_sscd(self):
        first, second = (self.infos[name] for name in PAIR_NAMES["recolored"])
        metrics = DEDUP.calculate_similarity_metrics(first, second)
        self.assertGreaterEqual(
            metrics["sscd_similarity"],
            self.args.sscd_review_threshold,
        )
        self.assertLess(metrics["review_score"], self.args.similarity_threshold)
        level, _score = DEDUP.classify_review_candidate(metrics, self.args)
        self.assertEqual(level, "L1-SSCD")

    def test_color_and_grayscale_structure_pair_enters_l2(self):
        first, second = (self.infos[name] for name in PAIR_NAMES["structure"])
        metrics = DEDUP.calculate_similarity_metrics(first, second)
        metrics["geometric_similarity"] = DEDUP.calculate_geometric_similarity(
            first,
            second,
        )[0]
        self.assertLess(metrics["sscd_similarity"], self.args.sscd_review_threshold)
        self.assertGreaterEqual(
            metrics["dino_similarity"],
            self.args.dino_review_threshold,
        )
        self.assertGreaterEqual(
            metrics["edge_similarity"],
            self.args.edge_review_threshold,
        )
        self.assertGreaterEqual(
            metrics["geometric_similarity"],
            self.args.geometry_review_threshold,
        )
        level, _score = DEDUP.classify_review_candidate(metrics, self.args)
        self.assertEqual(level, "L2-结构")


if __name__ == "__main__":
    unittest.main()
