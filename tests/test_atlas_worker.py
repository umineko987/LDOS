import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np
from PIL import Image, features


ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "dedup" / "atlas_worker.py"
sys.path.insert(0, str(ROOT / "dedup"))

import atlas_worker  # noqa: E402
import dedup_models  # noqa: E402
import dedup_resources  # noqa: E402


PROFILE = SimpleNamespace(workers=2, deep_batch_size=4, model_decode_workers=1)


def clustered(sizes, dims=384, seed=7, noise=0.05):
    """sizes[i] 个点围绕第 i 个随机单位向量；返回 (L2 归一化向量, 真实标签)。"""

    rng = np.random.default_rng(seed)
    centers = atlas_worker.normalize_rows(rng.normal(size=(len(sizes), dims)))
    labels = np.repeat(np.arange(len(sizes)), sizes)
    points = centers[labels] + noise * rng.normal(size=(len(labels), dims))
    return atlas_worker.normalize_rows(points), labels


def options(**overrides):
    return {**atlas_worker.DEFAULT_OPTIONS, "iterations": 300, **overrides}


def is_partition_refinement(predicted, truth):
    """每个预测簇只含一个真实簇的成员。"""

    return all(len(set(truth[predicted == cluster])) == 1 for cluster in np.unique(predicted))


class AnalysisTests(unittest.TestCase):
    def test_clusters_are_recovered_in_labels_and_layout(self):
        vectors, truth = clustered([70, 60, 50, 40])
        result = atlas_worker.analyze(vectors, options(clusters=4), atlas_worker.Reporter())

        self.assertEqual(result["method"], "exact")
        labels = result["labels"]
        self.assertTrue(is_partition_refinement(labels, truth))
        self.assertEqual(len(set(labels)), 4)
        # 标签按簇大小降序编号
        self.assertEqual(np.bincount(labels).tolist(), [70, 60, 50, 40])

        layout = result["layout"]
        self.assertLessEqual(np.abs(layout).max(), 1.0 + 1e-9)
        centroids = np.stack([layout[truth == cluster].mean(axis=0) for cluster in range(4)])
        nearest = np.linalg.norm(layout[:, None] - centroids[None], axis=2).argmin(axis=1)
        self.assertGreaterEqual((nearest == truth).mean(), 0.98)

        # 启发式 k（round(√220) = 15）只会把真实簇再细分，不会混簇
        heuristic = atlas_worker.spherical_kmeans(vectors, atlas_worker.default_cluster_count(len(vectors)), 0)
        self.assertEqual(len(set(heuristic)), 15)
        self.assertTrue(is_partition_refinement(heuristic, truth))

    def test_outliers_get_the_highest_scores(self):
        inliers, _ = clustered([80, 80, 80])
        rng = np.random.default_rng(3)
        strays = atlas_worker.normalize_rows(rng.normal(size=(5, inliers.shape[1])))
        vectors = np.concatenate([inliers[:120], strays, inliers[120:]])
        stray_indices = set(range(120, 125))

        scores = atlas_worker.analyze(vectors, options(), atlas_worker.Reporter())["outliers"]

        self.assertEqual(set(np.argsort(-scores)[:5].tolist()), stray_indices)
        self.assertTrue(all(scores[index] >= atlas_worker.OUTLIER_THRESHOLD for index in stray_indices))
        self.assertLess(float(np.median(scores)), 0.1)
        self.assertTrue(((0.0 <= scores) & (scores < 1.0)).all())

    def test_output_is_deterministic_on_both_paths(self):
        vectors, _ = clustered([90, 80, 70])
        for exact_max in (1000, 100):
            with self.subTest(exact_max=exact_max):
                first = atlas_worker.analyze(vectors, options(exact_max=exact_max), atlas_worker.Reporter())
                second = atlas_worker.analyze(vectors, options(exact_max=exact_max), atlas_worker.Reporter())
                for key in ("layout", "labels", "outliers", "projected"):
                    np.testing.assert_array_equal(first[key], second[key])

    def test_approximate_path_is_used_above_threshold_and_keeps_clusters_apart(self):
        vectors, truth = clustered([120, 110, 100, 90])
        with mock.patch.object(atlas_worker, "exact_gradient_factory", side_effect=AssertionError("exact used")):
            result = atlas_worker.analyze(vectors, options(exact_max=200, clusters=4), atlas_worker.Reporter())

        self.assertEqual(result["method"], "approximate")
        self.assertTrue(is_partition_refinement(result["labels"], truth))
        layout = result["layout"]
        centroids = np.stack([layout[truth == cluster].mean(axis=0) for cluster in range(4)])
        nearest = np.linalg.norm(layout[:, None] - centroids[None], axis=2).argmin(axis=1)
        self.assertGreaterEqual((nearest == truth).mean(), 0.98)

        exact = atlas_worker.analyze(vectors[:150], options(exact_max=200), atlas_worker.Reporter())
        self.assertEqual(exact["method"], "exact")

    def test_tiny_inputs_use_trivial_layout(self):
        vectors, _ = clustered([2, 1])
        for count in (1, 2, 3):
            with self.subTest(count=count):
                result = atlas_worker.analyze(vectors[:count], options(), atlas_worker.Reporter())
                self.assertEqual(result["method"], "trivial")
                self.assertEqual(result["layout"].shape, (count, 2))
                self.assertTrue(np.isfinite(result["layout"]).all())
                self.assertEqual(len(result["labels"]), count)

    def test_exact_gradient_matches_reference_formula(self):
        rng = np.random.default_rng(5)
        count = 300
        joint = rng.random((count, count))
        joint = (joint + joint.T) / 2.0
        np.fill_diagonal(joint, 0.0)
        joint /= joint.sum()
        layout = rng.normal(scale=3.0, size=(count, 2))

        difference = layout[:, None] - layout[None]
        kernel = 1.0 / (1.0 + (difference ** 2).sum(axis=2))
        np.fill_diagonal(kernel, 0.0)
        weights = (4.0 * joint - kernel / kernel.sum()) * kernel
        expected = 4.0 * (weights[:, :, None] * difference).sum(axis=1)

        actual = atlas_worker.exact_gradient_factory(joint)(layout, 4.0)
        np.testing.assert_allclose(actual, expected, rtol=1e-3, atol=1e-6 * np.abs(expected).max())

    def test_grid_repulsion_approximates_exact_repulsion(self):
        rng = np.random.default_rng(11)
        layout = np.concatenate([rng.normal(loc, 2.0, size=(150, 2)) for loc in ((-15, 0), (12, 8), (0, -14))])
        difference = layout[:, None] - layout[None]
        kernel = 1.0 / (1.0 + (difference ** 2).sum(axis=2))
        np.fill_diagonal(kernel, 0.0)
        expected_force = ((kernel ** 2)[:, :, None] * difference).sum(axis=1)
        expected_normalizer = kernel.sum()

        force, normalizer = atlas_worker.GridRepulsion()(layout)

        self.assertAlmostEqual(normalizer / expected_normalizer, 1.0, delta=0.03)
        error = np.linalg.norm(force - expected_force) / np.linalg.norm(expected_force)
        self.assertLess(error, 0.05)

    def test_quantized_vectors_round_trip_within_half_a_step(self):
        rng = np.random.default_rng(2)
        vectors = rng.normal(size=(57, 32)) * np.linspace(0.1, 3.0, 32)
        vectors[:, 5] = 0.0

        encoded = atlas_worker.quantize(vectors)

        self.assertEqual((encoded["dims"], encoded["dtype"], encoded["encoding"]), (32, "int8", "base64"))
        raw = np.frombuffer(base64.b64decode(encoded["data"]), dtype=np.int8).reshape(57, 32)
        scales = np.asarray(encoded["scales"])
        decoded = raw * scales
        self.assertTrue((np.abs(decoded - vectors) <= scales / 2.0 + 1e-12).all())
        self.assertEqual(int(np.abs(raw).max()), 127)
        self.assertEqual(scales[5], 0.0)
        self.assertTrue((raw[:, 5] == 0).all())


class SpriteTests(unittest.TestCase):
    def test_sheets_are_filled_in_order_and_split_at_capacity(self):
        def colour(index):
            return (index % 251, (index * 7) % 253, (index // 4) % 256)

        with tempfile.TemporaryDirectory() as directory:
            writer = atlas_worker.SpriteWriter(Path(directory), "png")
            positions = [writer.add(Image.new("RGB", (64, 64), colour(index))) for index in range(1030)]
            writer.close()

            self.assertEqual(positions[0], (0, 0))
            self.assertEqual(positions[1023], (0, 1023))
            self.assertEqual(positions[1024], (1, 0))
            self.assertEqual(positions[1029], (1, 5))
            described = writer.describe()
            self.assertEqual(described, {
                "format": "png",
                "sheet_size": 2048,
                "cell_size": 64,
                "columns": 32,
                "per_sheet": 1024,
                "sheets": ["sprites/sheet-0000.png", "sprites/sheet-0001.png"],
            })
            with Image.open(Path(directory) / "sheet-0000.png") as first:
                self.assertEqual(first.size, (2048, 2048))
                for index in (0, 33, 1023):
                    x = (index % 32) * 64
                    y = (index // 32) * 64
                    self.assertEqual(first.getpixel((x + 1, y + 1)), colour(index))
                    self.assertEqual(first.getpixel((x + 62, y + 62)), colour(index))
            with Image.open(Path(directory) / "sheet-0001.png") as second:
                self.assertEqual(second.getpixel((5 * 64 + 10, 10)), colour(1029))
                # 未用的格子保持底色
                self.assertEqual(second.getpixel((6 * 64 + 10, 10)), atlas_worker.SPRITE_BACKGROUND)

    @unittest.skipUnless(features.check("webp"), "Pillow 未编译 WebP 支持")
    def test_webp_sheets(self):
        with tempfile.TemporaryDirectory() as directory:
            writer = atlas_worker.SpriteWriter(Path(directory), "webp")
            writer.add(Image.new("RGB", (64, 64), (200, 30, 30)))
            writer.close()
            path = Path(directory) / "sheet-0000.webp"
            data = path.read_bytes()
            self.assertEqual((data[:4], data[8:12]), (b"RIFF", b"WEBP"))
            with Image.open(path) as sheet:
                self.assertEqual(sheet.size, (2048, 2048))
                red, green, blue = sheet.convert("RGB").getpixel((32, 32))
                self.assertGreater(red, 170)
                self.assertLess(max(green, blue), 70)

    def test_cells_are_cover_cropped_and_transparency_uses_background(self):
        image = Image.new("RGBA", (200, 100), (0, 0, 0, 0))
        image.paste((250, 250, 250, 255), (100, 0, 200, 100))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "wide.png"
            image.save(path)
            cell = atlas_worker.make_cell(path)
        self.assertEqual((cell.size, cell.mode), ((64, 64), "RGB"))
        self.assertEqual(cell.getpixel((2, 32)), atlas_worker.SPRITE_BACKGROUND)
        self.assertEqual(cell.getpixel((61, 32)), (250, 250, 250))


class JobParsingTests(unittest.TestCase):
    def job(self, **changes):
        payload = {
            "output_dir": "/tmp/atlas-out",
            "items": [{"asset_id": "a", "path": "/tmp/a.png", "sha256": "A" * 64}],
        }
        payload.update(changes)
        return payload

    def test_valid_job_gets_defaults_and_normalised_hash(self):
        job = atlas_worker.parse_job(self.job(options={"seed": 3}))
        self.assertEqual(job["items"][0]["sha256"], "a" * 64)
        self.assertIsNone(job["items"][0]["thumbnail_path"])
        self.assertEqual(job["options"]["seed"], 3)
        self.assertEqual(job["options"]["exact_max"], atlas_worker.DEFAULT_OPTIONS["exact_max"])
        self.assertEqual(atlas_worker.parse_job(self.job(), output_dir="/srv/x")["output_dir"], "/srv/x")

    def test_invalid_jobs_are_rejected(self):
        item = {"asset_id": "a", "path": "/tmp/a.png", "sha256": None}
        cases = {
            "relative path": self.job(items=[{**item, "path": "a.png"}]),
            "bad hash": self.job(items=[{**item, "sha256": "z" * 64}]),
            "duplicate": self.job(items=[item, dict(item)]),
            "unknown option": self.job(options={"colour": 1}),
            "exact_max too large": self.job(options={"exact_max": atlas_worker.EXACT_LIMIT + 1}),
            "fractional int": self.job(options={"iterations": 300.5}),
            "bool as number": self.job(options={"knn": True}),
            "relative output": self.job(output_dir="out"),
            "version": self.job(schema_version=2),
        }
        for name, payload in cases.items():
            with self.subTest(name), self.assertRaises(atlas_worker.JobError):
                atlas_worker.parse_job(payload)


class RunJobTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.model_dir = self.root / "models"
        self.output_dir = self.root / "out"
        self.vectors, self.truth = clustered([12, 10, 8])

    def tearDown(self):
        self.temporary.cleanup()

    def write_image(self, name, colour):
        path = self.root / "images" / name
        path.parent.mkdir(exist_ok=True)
        Image.new("RGB", (40, 24), colour).save(path)
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def good_items(self):
        items = []
        for index in range(len(self.vectors)):
            path, sha256 = self.write_image(f"{index:03d}.png", (index * 8, 255 - index * 8, 90))
            items.append({"asset_id": f"asset-{index:03d}", "path": str(path), "sha256": sha256})
        return items

    def fill_cache(self, items):
        cache = dedup_models.EmbeddingCache(dedup_models.model_root(self.model_dir) / "embeddings.sqlite3")
        try:
            cache.put_many(dedup_models.DINO_CACHE_KEY, [
                (item["sha256"], self.vectors[index]) for index, item in enumerate(items)
            ])
        finally:
            cache.close()

    def run_job(self, items, **job_options):
        job = atlas_worker.parse_job({
            "output_dir": str(self.output_dir),
            "items": items,
            "options": {"iterations": 200, "sprite_format": "png", **job_options},
        })
        return atlas_worker.run_job(job, model_dir=self.model_dir, device="cpu", profile=PROFILE)

    def test_cached_embeddings_skip_model_and_bad_items_are_reported(self):
        items = self.good_items()
        self.fill_cache(items)
        corrupt = self.root / "images" / "corrupt.png"
        corrupt.write_bytes(b"not an image at all")
        stale_path, _ = self.write_image("stale.png", (1, 2, 3))
        bad = [
            {"asset_id": "corrupt", "path": str(corrupt), "sha256": None},
            {"asset_id": "gone", "path": str(self.root / "images" / "gone.png"), "sha256": None},
            {"asset_id": "stale", "path": str(stale_path), "sha256": "0" * 64},
        ]
        mixed = items[:5] + bad[:1] + items[5:20] + bad[1:] + items[20:]

        with mock.patch.object(dedup_models, "DeepEmbeddingExtractor", side_effect=AssertionError("model loaded")):
            atlas = self.run_job(mixed, clusters=3)

        on_disk = json.loads((self.output_dir / "atlas.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk["input_digest"], atlas["input_digest"])
        self.assertEqual(atlas["schema_version"], 1)
        self.assertEqual(atlas["method"], "exact")
        self.assertEqual(atlas["counts"], {
            "input": 33, "items": 30, "skipped": 3, "clusters": 3, "outliers": atlas["counts"]["outliers"],
        })
        self.assertEqual(atlas["skipped"], [
            {"asset_id": "corrupt", "reason": "unreadable"},
            {"asset_id": "gone", "reason": "missing"},
            {"asset_id": "stale", "reason": "changed"},
        ])
        self.assertEqual([item["asset_id"] for item in atlas["items"]], [item["asset_id"] for item in items])
        self.assertEqual([item["sprite"] for item in atlas["items"]], [[0, index] for index in range(30)])
        self.assertTrue(all(-1.0 <= item["x"] <= 1.0 and -1.0 <= item["y"] <= 1.0 for item in atlas["items"]))

        clusters = {item["asset_id"]: item["cluster"] for item in atlas["items"]}
        self.assertTrue(is_partition_refinement(np.array(list(clusters.values())), self.truth))
        self.assertEqual([cluster["size"] for cluster in atlas["clusters"]], [12, 10, 8])
        self.assertAlmostEqual(sum(cluster["share"] for cluster in atlas["clusters"]), 1.0, places=5)
        for cluster in atlas["clusters"]:
            self.assertEqual(clusters[cluster["medoid_asset_id"]], cluster["id"])

        self.assertEqual(atlas["vectors"]["order"], "items")
        self.assertEqual(len(base64.b64decode(atlas["vectors"]["data"])), 30 * 32)
        self.assertEqual(atlas["sprites"]["sheets"], ["sprites/sheet-0000.png"])
        with Image.open(self.output_dir / "sprites" / "sheet-0000.png") as sheet:
            self.assertEqual(sheet.getpixel((32, 32)), (0, 255, 90))
        self.assertFalse(any(name.endswith(".tmp") for name in os.listdir(self.output_dir)))

    def test_missing_embeddings_are_computed_once_per_hash_and_failures_skipped(self):
        items = self.good_items()
        self.fill_cache(items[:10])
        duplicate = dict(items[12], asset_id="copy-of-12")
        corrupt = self.root / "images" / "corrupt.png"
        corrupt.write_bytes(b"\x89PNG broken")
        failing = {"asset_id": "corrupt", "path": str(corrupt), "sha256": None}
        by_path = {item["path"]: index for index, item in enumerate(items)}
        vectors = self.vectors
        encoded = []

        class FakeExtractor:
            def __init__(self, root, **kwargs):
                self.kwargs = kwargs

            def encode_all(self, infos, names):
                if any(info["path"] == str(corrupt) for info in infos):
                    raise OSError("cannot decode")
                encoded.extend(info["file_hash"] for info in infos)
                return {"dino": np.stack([vectors[by_path[info["path"]]] for info in infos])}

            def close(self):
                pass

        with mock.patch.object(dedup_models, "DeepEmbeddingExtractor", FakeExtractor), \
                mock.patch.object(dedup_resources, "configure_process_resources") as configure:
            atlas = self.run_job(items + [duplicate, failing], sprites=False, clusters=3)

        configure.assert_called_once_with(PROFILE)
        self.assertEqual(sorted(encoded), sorted(item["sha256"] for item in items[10:]))
        self.assertEqual(atlas["skipped"], [{"asset_id": "corrupt", "reason": "unreadable"}])
        self.assertEqual(atlas["counts"]["items"], 31)
        self.assertIsNone(atlas["sprites"])
        self.assertTrue(all(item["sprite"] is None for item in atlas["items"]))
        positions = {item["asset_id"]: (item["x"], item["y"], item["cluster"]) for item in atlas["items"]}
        self.assertEqual(positions["copy-of-12"][2], positions[items[12]["asset_id"]][2])

    def test_model_failure_is_reported_as_model_unavailable(self):
        items = self.good_items()[:4]
        # 上一次的结果与雪碧图不能留下来冒充本次结果
        (self.output_dir / "sprites").mkdir(parents=True)
        (self.output_dir / "atlas.json").write_text("{}", encoding="utf-8")
        (self.output_dir / "sprites" / "sheet-0000.webp").write_bytes(b"old")
        with mock.patch.object(dedup_models, "DeepEmbeddingExtractor", side_effect=RuntimeError("offline")), \
                mock.patch.object(dedup_resources, "configure_process_resources"):
            with self.assertRaises(atlas_worker.WorkerError) as raised:
                self.run_job(items)
        self.assertEqual(raised.exception.code, "model_unavailable")
        self.assertFalse((self.output_dir / "atlas.json").exists())
        self.assertFalse((self.output_dir / "sprites" / "sheet-0000.webp").exists())

    def test_job_without_usable_items_writes_empty_atlas(self):
        atlas = self.run_job([{"asset_id": "gone", "path": str(self.root / "gone.png"), "sha256": None}])
        self.assertEqual(atlas["items"], [])
        self.assertEqual(atlas["clusters"], [])
        self.assertEqual(atlas["counts"]["skipped"], 1)
        self.assertEqual(atlas["vectors"]["data"], "")
        self.assertEqual(atlas["sprites"]["sheets"], [])


class CommandLineTests(unittest.TestCase):
    def run_worker(self, *args, stdin=""):
        return subprocess.run(
            [sys.executable, "-B", str(WORKER), *args],
            input=stdin, capture_output=True, text=True, timeout=120, check=False,
        )

    def test_help_does_not_need_dedup_modules(self):
        result = subprocess.run(
            [sys.executable, "-I", "-B", str(WORKER), "--help"],
            capture_output=True, text=True, timeout=60, check=False, cwd=tempfile.gettempdir(),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--job", result.stdout)

    def test_job_from_stdin_emits_json_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vectors, _ = clustered([6, 6])
            items = []
            pairs = []
            for index, vector in enumerate(vectors):
                path = root / f"{index}.png"
                Image.new("RGB", (16, 16), (index * 20, 40, 40)).save(path)
                sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
                items.append({"asset_id": str(index), "path": str(path), "sha256": sha256})
                pairs.append((sha256, vector))
            cache = dedup_models.EmbeddingCache(dedup_models.model_root(root / "models") / "embeddings.sqlite3")
            cache.put_many(dedup_models.DINO_CACHE_KEY, pairs)
            cache.close()
            job = {"items": items, "options": {"iterations": 100}}

            result = self.run_worker(
                "--job", "-", "--output-dir", str(root / "out"), "--model-dir", str(root / "models"),
                "--device", "cpu", "--workers", "2", stdin=json.dumps(job),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            events = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(events[0], {"type": "start", "items": 12})
            self.assertEqual(events[-1]["type"], "done")
            self.assertEqual(events[-1]["items"], 12)
            self.assertEqual(Path(events[-1]["output"]), root / "out" / "atlas.json")
            self.assertIn({"type": "progress", "stage": "layout", "done": 100, "total": 100}, events)
            atlas = json.loads((root / "out" / "atlas.json").read_text(encoding="utf-8"))
            self.assertEqual(len(atlas["items"]), 12)

    def test_invalid_job_exits_with_code_2(self):
        result = self.run_worker("--job", "-", stdin='{"items": "nope", "output_dir": "/tmp/x"}')
        self.assertEqual(result.returncode, 2)
        event = json.loads(result.stdout.splitlines()[-1])
        self.assertEqual(event["type"], "error")
        self.assertEqual(event["code"], "invalid_job")

        result = self.run_worker("--job", "-", stdin="not json")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout.splitlines()[-1])["code"], "invalid_job")


if __name__ == "__main__":
    unittest.main()
