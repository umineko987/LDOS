from __future__ import annotations

import hashlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "gallery-dl-backend"))
from gdl_backend import review_filters as filters
from gdl_backend import review_filter_models as models


def options(**changes):
    return {"filter_monochrome": False, "filter_sketch": False, "filter_character": False, **changes}


class FilterInferenceTests(unittest.TestCase):
    def image_infos(self, root, colors):
        infos = []
        for index, color in enumerate(colors):
            path = root / f"{index}.png"
            Image.new("RGB", (12, 12), color).save(path)
            infos.append({"path": str(path), "frames": 1})
        return infos

    def test_trained_monochrome_score_threshold_retains_boundary_and_color(self):
        with tempfile.TemporaryDirectory() as directory:
            infos = self.image_infos(Path(directory), ["red", "blue", "gray", "black"])
            runtime = mock.Mock()
            runtime.monochrome_score.side_effect = [0.02, 0.7999, 0.8, 0.99]
            result = filters.filter_images(infos, options(filter_monochrome=True), [object()], models=runtime)
            self.assertEqual(result, [{"image": info, "reason": "filter_monochrome"} for info in infos[2:]])
            runtime.feature.assert_not_called()
            runtime.distances.assert_not_called()

    def test_ccip_any_reference_and_conservative_band_keep_only_strong_nonmatch_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            infos = self.image_infos(Path(directory), ["red", "blue", "green", "yellow"])
            runtime = mock.Mock()
            runtime.feature.side_effect = lambda image: image.getpixel((0, 0))
            runtime.distances.side_effect = [np.array([0.6, 0.17]), np.array([0.21, 0.7]),
                                             np.array([0.35, 0.8]), np.array([0.351, 0.9])]
            result = filters.filter_images(infos, options(filter_character=True),
                [Image.new("RGB", (12, 12), "red"), Image.new("RGB", (12, 12), "purple")], models=runtime)
            self.assertEqual(result, [{"image": infos[-1], "reason": "filter_character"}])
            # Four selected + two references, but selected red reuses the reference feature.
            self.assertEqual(runtime.feature.call_count, 5)
            self.assertEqual(runtime.distances.call_count, 4)

    def test_combined_filters_exclude_once_skip_unreliable_inputs_and_never_open_mutable_path(self):
        with tempfile.TemporaryDirectory() as directory:
            infos = self.image_infos(Path(directory), ["red", "blue", "green"])
            infos += [{"path": "multi", "frames": 2}, {"path": "bad", "frames": 1}]
            held = io.BytesIO()
            Image.new("RGB", (12, 12), "red").save(held, format="PNG")
            infos[0]["path"] = "original-now-replaced"
            calls = []
            def open_held(path):
                calls.append(path)
                return Image.open(io.BytesIO(held.getvalue())) if path == infos[0]["path"] else Image.open(path)
            runtime = mock.Mock()
            runtime.monochrome_score.side_effect = [0.95, 0.1, 0.1]
            runtime.feature.return_value = np.ones(768, dtype=np.float32)
            runtime.distances.side_effect = [np.array([0.8]), np.array([0.2])]
            result = filters.filter_images(infos, options(filter_monochrome=True, filter_character=True),
                [Image.new("RGB", (12, 12), "purple")], models=runtime, open_image=open_held)
            self.assertEqual([entry["reason"] for entry in result], ["filter_monochrome", "filter_character"])
            self.assertEqual([entry["image"] for entry in result], infos[:2])
            self.assertNotIn("multi", calls)
            self.assertEqual(runtime.feature.call_count, 3)  # Reference + two color survivors only.

    def test_only_enabled_models_load_once_and_disabled_filters_never_touch_references(self):
        with mock.patch.object(filters, "FilterModels", return_value=mock.sentinel.runtime) as load:
            self.assertIsNone(filters.require_filter_capabilities(options(), Path("missing")))
            self.assertEqual(filters.filter_images([], options(), [object()]), [])
            load.assert_not_called()
            self.assertIs(filters.require_filter_capabilities(options(filter_character=True), Path("models")), mock.sentinel.runtime)
            load.assert_called_once_with(Path("models"), ["ccip"])
        for error in (ImportError("dependency missing"), RuntimeError("corrupt model")):
            with mock.patch.object(filters, "FilterModels", side_effect=error), self.assertRaises(filters.FilterConfigurationError):
                filters.require_filter_capabilities(options(filter_monochrome=True), Path("models"))

    def test_monochrome_and_ccip_preprocessing_white_alpha_and_exact_normalization(self):
        transparent = Image.new("RGBA", (4, 6), (255, 0, 0, 0))
        monochrome = models.encode_image(transparent)
        self.assertEqual(monochrome.shape, (3, 384, 384))
        self.assertEqual(monochrome.dtype, np.float32)
        np.testing.assert_allclose(monochrome, 1)
        ccip = models.encode_image(Image.new("RGB", (4, 6), "red"), ccip=True)
        expected = (np.array([1, 0, 0]) - [0.48145466, 0.4578275, 0.40821073]) / [0.26862954, 0.26130258, 0.27577711]
        np.testing.assert_allclose(ccip[:, 0, 0], expected, rtol=1e-6)

    def test_pinned_weights_missing_corrupt_same_size_and_links_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = b"model fixture"
            files = {"monochrome": (("monochrome.onnx", len(data), hashlib.sha256(data).hexdigest(), "https://fixed"),)}
            with mock.patch.object(models, "MODEL_FILES", files):
                with self.assertRaisesRegex(RuntimeError, "缺少"):
                    models.verify_weights(root, "monochrome")
                path = models.model_paths(root, "monochrome")[0]
                path.parent.mkdir()
                path.write_bytes(b"x" * len(data))
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    models.verify_weights(root, "monochrome")
                path.write_bytes(data)
                models.verify_weights(root, "monochrome")
                path.unlink()
                other = root / "other"
                other.write_bytes(data)
                path.symlink_to(other)
                with self.assertRaisesRegex(RuntimeError, "链接"):
                    models.verify_weights(root, "monochrome")

    def test_runtime_uses_official_metric_and_rejects_invalid_model_outputs(self):
        runtime = models.FilterModels.__new__(models.FilterModels)
        runtime.np = np
        mono, feat, metric = mock.Mock(), mock.Mock(), mock.Mock()
        runtime.sessions = {"monochrome": mono, "ccip_feat": feat, "ccip_metric": metric}
        image = Image.new("RGB", (4, 4), "red")
        mono.run.return_value = [np.array([[0.9, 0.1]], dtype=np.float32)]
        self.assertAlmostEqual(runtime.monochrome_score(image), 0.9)
        for bad in (np.array([[np.nan, 0.1]]), np.array([[1.2, 0.1]]), np.zeros((1, 3))):
            mono.run.return_value = [bad]
            with self.assertRaises(RuntimeError):
                runtime.monochrome_score(image)
        feat.run.return_value = [np.ones((1, 768), dtype=np.float32)]
        feature = runtime.feature(image)
        metric.run.return_value = [np.array([[0, 0.42], [0.42, 0]], dtype=np.float32)]
        self.assertAlmostEqual(float(runtime.distances(feature, [feature])[0]), 0.42)
        self.assertEqual(metric.run.call_args.args[0], ["output"])
        self.assertEqual(metric.run.call_args.args[1]["input"].shape, (2, 768))
        metric.run.return_value = [np.full((2, 2), np.nan)]
        with self.assertRaises(RuntimeError):
            runtime.distances(feature, [feature])
        feat.run.return_value = [np.zeros((1, 768))]
        with self.assertRaises(RuntimeError):
            runtime.feature(image)

    def test_explicit_prepare_only_downloads_requested_pinned_models_and_offline_checks_never_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # The same downloader used by SSCD/DINO, but no deep extractor is loaded.
            sys.path.insert(0, str(ROOT / "dedup"))
            import dedup_models
            checks = {"monochrome": {"available": True, "reason": ""}}
            command = ["check", "--model-dir", str(root), "--models", "monochrome"]
            with mock.patch.object(sys, "argv", command), mock.patch.object(models, "check_models", return_value=checks), \
                 mock.patch.object(dedup_models, "download_file") as download:
                self.assertEqual(models.main(), 0)
                download.assert_not_called()
                with mock.patch.object(sys, "argv", command + ["--prepare", "--dedup-dir", str(ROOT / "dedup")]):
                    self.assertEqual(models.main(), 0)
                entry = models.MODEL_FILES["monochrome"][0]
                download.assert_called_once_with(entry[3], models.model_paths(root, "monochrome")[0], entry[2])


if __name__ == "__main__":
    unittest.main()
