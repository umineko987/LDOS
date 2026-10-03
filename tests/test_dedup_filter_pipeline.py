from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dedup"))
sys.path.insert(0, str(ROOT / "gallery-dl-backend"))

from PIL import Image
from gdl_backend import review_filters
from gdl_backend.gallery_safe_paths import SafeSourceRoot
import dedup_review_worker as worker
import test_dedup_review_worker as fixtures

CORE = fixtures.CORE
ARRAY_KEYS = {
    "gray_medium", "color_small", "alpha_medium", "edge_medium",
    "sscd_embedding", "dino_embedding", "_sift_keypoints", "_sift_descriptors",
}


def config(**changes):
    return {"preset_name": "test", "options": {
        "basic_dedup": True, "filter_monochrome": False, "filter_sketch": False,
        "filter_character": False, "similarity_groups": True, "reference_asset_ids": [], **changes}}


def args(root):
    return CORE.build_argument_parser().parse_args([str(root), "--workers", "1", "--no-sscd", "--no-dino"])


class FilterPipelineTests(unittest.TestCase):
    def test_independent_basic_and_similarity_switches_keep_exact_inputs_when_disabled(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [root / f"{n}.png" for n in range(2)]
            for path in paths:
                Image.new("RGB", (32, 32), "red").save(path)
            for basic in (False, True):
                for similarity in (False, True):
                    with self.subTest(basic=basic, similarity=similarity):
                        infos = [CORE.get_image_info(str(path)) for path in paths]
                        automatic, candidates, filtered = worker.analyze_with_filters(
                            CORE, infos, args(root), config(basic_dedup=basic, similarity_groups=similarity), [])
                        manifest = worker.build_manifest(root, [str(p) for p in paths], infos, automatic, candidates, CORE,
                                                         filtered_items=filtered)
                        self.assertEqual(manifest["counts"]["automatic_rejected_images"], int(basic))
                        self.assertEqual(manifest["counts"]["review_images"], 2 - int(basic))
                        self.assertEqual(manifest["counts"]["duplicate_groups"], int(similarity and not basic))
                        self.assertTrue(all(path.is_file() for path in paths))
                        self.assertTrue(all(ARRAY_KEYS.isdisjoint(info) for info in infos))

    def test_unfiltered_switches_extract_once_or_not_at_all(self):
        import dedup_models
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [root / f"{n}.png" for n in range(3)]
            for path, color in zip(paths, ("red", "red", "blue")):
                image = Image.new("RGB", (32, 32), color)
                image.paste("white", (8, 8, 24, 24))
                image.save(path)
            for basic, similarity in ((True, True), (True, False), (False, True), (False, False)):
                with self.subTest(basic=basic, similarity=similarity):
                    infos = [CORE.get_image_info(str(path)) for path in paths]
                    core_args = CORE.build_argument_parser().parse_args(
                        [str(root), "--workers", "1", "--device", "cpu", "--neighbor-block-size", "256", "--deep-batch-size", "4"])
                    def embeddings(selected):
                        vectors = CORE.np.tile(CORE.np.array([1.0, 0.0], dtype=CORE.np.float32), (len(selected), 1))
                        return {"sscd": vectors, "dino": vectors}
                    with mock.patch.object(dedup_models, "DeepEmbeddingExtractor") as extractor, \
                         mock.patch.object(CORE, "calculate_geometric_similarity", wraps=CORE.calculate_geometric_similarity) as geometry:
                        extractor.return_value.encode_all.side_effect = embeddings
                        automatic, candidates, filtered = worker.analyze_with_filters(
                            CORE, infos, core_args, config(basic_dedup=basic, similarity_groups=similarity), [object()])
                    if basic or similarity:
                        extractor.assert_called_once()
                        extractor.return_value.encode_all.assert_called_once()
                        self.assertEqual(extractor.call_args.kwargs["use_dino"], similarity)
                    else:
                        extractor.assert_not_called()
                    if not similarity:
                        geometry.assert_not_called()
                    self.assertFalse(core_args.no_dino)  # Switches must not mutate caller arguments.
                    self.assertTrue(all(ARRAY_KEYS.isdisjoint(info) for info in infos))
                    manifest = worker.build_manifest(root, [str(p) for p in paths], infos, automatic, candidates, CORE,
                                                     filtered_items=filtered)
                    self.assertEqual(manifest["counts"]["automatic_rejected_images"], int(basic))
                    self.assertEqual(manifest["counts"]["duplicate_groups"], int(similarity))
                    json.dumps(manifest)

    def test_sscd_disabled_config_keeps_strict_gate_without_changing_legacy_requests(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [root / f"{size}.png" for size in (32, 64)]
            for path, size in zip(paths, (32, 64)):
                Image.new("RGB", (size, size), "red").save(path)
            core_args = args(root)
            for settings, expected_automatic in ((config(), 0), (None, 1)):
                infos = [CORE.get_image_info(str(path)) for path in paths]
                automatic, candidates, _ = worker.analyze_with_filters(CORE, infos, core_args, settings, [])
                self.assertEqual(len(automatic), expected_automatic)
                self.assertEqual(len(candidates), 1 - expected_automatic)
                self.assertTrue(all(ARRAY_KEYS.isdisjoint(info) for info in infos))
            self.assertFalse(core_args.no_auto_compression)

    def test_filtered_paths_release_arrays_even_without_a_second_stage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [root / f"{n}.png" for n in range(3)]
            for path, color in zip(paths, ("red", "red", "blue")):
                Image.new("RGB", (32, 32), color).save(path)
            for similarity, exclude_all in ((False, False), (True, True), (True, False)):
                with self.subTest(similarity=similarity, exclude_all=exclude_all):
                    infos = [CORE.get_image_info(str(path)) for path in paths]
                    def exclude(selected, options, references, **kwargs):
                        return [{"image": info, "reason": "filter_monochrome"}
                                for info in (selected if exclude_all else selected[:1])]
                    with mock.patch.object(review_filters, "require_filter_capabilities"), \
                         mock.patch.object(review_filters, "filter_images", side_effect=exclude):
                        automatic, candidates, filtered = worker.analyze_with_filters(
                            CORE, infos, args(root), config(filter_monochrome=True, similarity_groups=similarity), [])
                    self.assertTrue(all(ARRAY_KEYS.isdisjoint(info) for info in infos))
                    manifest = worker.build_manifest(root, [str(p) for p in paths], infos, automatic, candidates, CORE,
                                                     filtered_items=filtered)
                    self.assertEqual(manifest["counts"]["automatic_rejected_images"], 3 if exclude_all else 2)
                    json.dumps(manifest)

    def test_fixed_stage_order_filters_only_survivors_then_groups_with_no_automatic_deletion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [root / f"{n}.png" for n in range(4)]
            infos = [fixtures.image_info(path, n) for n, path in enumerate(paths)]
            calls = []
            def analyze(selected, core_args, **flags):
                calls.append((list(selected), flags))
                if len(calls) == 1:
                    self.assertFalse(flags["similarity_groups"])
                    self.assertTrue(core_args.no_auto_compression)  # SSCD off never widens strict auto gate.
                    return [{"kind": "exact", "winner": infos[1], "members": infos[:2]}], []
                self.assertFalse(flags["basic_dedup"])
                self.assertEqual(selected, infos[2:])
                return [], [selected]
            core = SimpleNamespace(analyze_images=analyze, release_image_arrays=CORE.release_image_arrays)
            reference = object()
            def exclude(selected, options, references, **kwargs):
                self.assertEqual(selected, infos[1:])
                self.assertEqual(references, [])  # References cannot affect non-character filtering.
                return [{"image": infos[1], "reason": "filter_monochrome"}]
            with mock.patch.object(review_filters, "require_filter_capabilities"), mock.patch.object(review_filters, "filter_images", side_effect=exclude):
                automatic, candidates, filtered = worker.analyze_with_filters(
                    core, infos, args(root), config(filter_monochrome=True), [reference])
            self.assertEqual(len(calls), 2)
            manifest = worker.build_manifest(root, [str(p) for p in paths], infos, automatic, candidates, CORE,
                                             filtered_items=filtered)
            self.assertEqual(manifest["counts"]["automatic_rejected_images"], 2)
            self.assertEqual(manifest["counts"]["filtered_images"], 1)
            emitted = [i["id"] for g in manifest["groups"] for i in g["items"]]
            emitted += [i["id"] for g in manifest["auto_groups"] for i in g["rejected_items"]]
            emitted += [i["id"] for i in manifest["filtered_items"]]
            self.assertEqual(len(emitted), len(set(emitted)))
            self.assertEqual(len(emitted), 4)
            with self.assertRaises(ValueError):
                worker.build_manifest(root, [str(p) for p in paths], infos, automatic, candidates, CORE,
                                      filtered_items=[{"image": infos[0], "reason": "filter_monochrome"}])

    def test_worker_decodes_frozen_references_without_expanding_inputs_on_proc_and_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            selected = []
            for n, color in enumerate(("red", "blue")):
                source = root / str(n)
                source.mkdir()
                Image.new("RGB", (16, 16), color).save(source / "image.png")
                with SafeSourceRoot(source) as safe:
                    selected.append({"asset_id": str(n), "source_id": str(n), "relative_path": "image.png",
                                     "root_path": str(source), "root_identity": list(safe.root_identity()),
                                     "disk_version": safe.disk_version("image.png")})
            settings = config(basic_dedup=False, similarity_groups=False, filter_character=True, reference_asset_ids=["1"])
            input_path, output = root / "input.json", root / "output.json"
            payload = {"review_id": "r", "filter_config": settings, "images": selected[:1], "references": selected[1:]}
            input_path.write_text(json.dumps(payload))
            def exclude(infos, options, references, **kwargs):
                self.assertEqual(len(infos), 1)
                self.assertEqual(references[0].getpixel((0, 0)), (0, 0, 255))
                return [{"image": infos[0], "reason": "filter_character"}]
            arguments = ["worker", "--input", str(input_path), "--output", str(output), "--device", "cpu", "--no-sscd", "--no-dino"]
            original_is_dir = Path.is_dir
            for use_proc in (True, False):
                def is_dir(path):
                    return False if not use_proc and str(path) == "/proc/self/fd" else original_is_dir(path)
                with mock.patch.object(Path, "is_dir", is_dir), mock.patch.object(sys, "argv", arguments), \
                     mock.patch.object(review_filters, "require_filter_capabilities"), \
                     mock.patch.object(review_filters, "filter_images", side_effect=exclude):
                    self.assertEqual(worker.main(), 0)
                manifest = json.loads(output.read_text())
                self.assertEqual(manifest["filter_config"], settings)
                self.assertEqual(manifest["counts"]["images"], 1)
                self.assertEqual(manifest["filtered_items"][0]["id"], "0")
                self.assertEqual(manifest["groups"], [])
                self.assertEqual(manifest["auto_groups"], [])
            (Path(selected[1]["root_path"]) / "image.png").write_bytes(b"changed")
            with mock.patch.object(sys, "argv", arguments), self.assertRaisesRegex(ValueError, "已变化"):
                worker.main()

    def test_missing_reference_or_unavailable_filter_never_silently_skips(self):
        core = mock.Mock()
        with self.assertRaisesRegex(review_filters.FilterConfigurationError, "参考图"):
            worker.analyze_with_filters(core, [], SimpleNamespace(), config(filter_character=True), [])
        for flag in ("filter_monochrome", "filter_sketch", "filter_character"):
            with self.subTest(flag=flag), self.assertRaises(review_filters.FilterConfigurationError) as caught:
                worker.analyze_with_filters(core, [], SimpleNamespace(), config(**{flag: True}), [object()])
            self.assertEqual(caught.exception.code, "review_filter_unavailable")
            self.assertEqual(caught.exception.details["filters"][0]["option"], flag)
        core.analyze_images.assert_not_called()
