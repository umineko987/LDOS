from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dedup"))

import dedup_review_worker as worker
import review_filter_models as models
from review_filters import FilterConfigurationError
from review_safe_paths import SafeSourceRoot, held_file_disk_version


class StandaloneReviewWorkerTests(unittest.TestCase):
    def test_filter_inference_and_reference_errors_use_local_helpers(self):
        import numpy as np
        import onnxruntime as ort
        from PIL import Image

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected_path = root / "selected.png"
            reference_path = root / "reference.png"
            Image.new("RGB", (32, 32), "red").save(selected_path)
            Image.new("RGB", (32, 32), "purple").save(reference_path)

            def snapshot(path):
                with SafeSourceRoot(root) as safe, safe.open_binary(path.name) as handle:
                    return {"asset_id": path.stem, "source_id": "source", "root_path": str(root),
                            "relative_path": path.name, "root_identity": list(safe.root_identity()),
                            "disk_version": held_file_disk_version(handle)}

            selection = {"review_id": "standalone", "images": [snapshot(selected_path)],
                         "references": [snapshot(reference_path)], "filter_config": {"options": {
                             "basic_dedup": True, "similarity_groups": True, "filter_monochrome": True,
                             "filter_sketch": True, "filter_character": True,
                         }}}
            input_path = root / "selection.json"
            output_path = root / "manifest.json"
            input_path.write_text(json.dumps(selection), encoding="utf-8")
            arguments = ["worker", "--input", str(input_path), "--output", str(output_path),
                         "--model-dir", str(root / "absent-models"), "--device", "cpu", "--no-sscd", "--no-dino"]
            original_is_dir = Path.is_dir
            for without_proc in (False, True):
                with self.subTest(without_proc=without_proc):
                    completeness, feature, metric = mock.Mock(), mock.Mock(), mock.Mock()
                    completeness.run.return_value = [np.array([[0.1, 0.8, 0.1]], dtype=np.float32)]
                    feature.run.return_value = [np.ones((1, 768), dtype=np.float32)]
                    metric.run.return_value = [np.array([[0, 0.8], [0.8, 0]], dtype=np.float32)]
                    sessions = {"completeness_mobilenetv3_v2.2_dist": completeness,
                                "ccip_feat": feature, "ccip_metric": metric}
                    create_session = mock.Mock(side_effect=lambda path, **kwargs: sessions[Path(path).stem])
                    def is_dir(path):
                        return False if without_proc and str(path) == "/proc/self/fd" else original_is_dir(path)
                    with mock.patch.object(ort, "SessionOptions", SimpleNamespace), \
                         mock.patch.object(ort, "InferenceSession", create_session), \
                         mock.patch.object(models, "verify_weights") as verify, \
                         mock.patch.object(Path, "is_dir", is_dir), mock.patch.object(sys, "argv", arguments):
                        self.assertEqual(worker.main(), 0)
                    self.assertEqual([call.args[1] for call in verify.call_args_list], ["completeness", "ccip"])
                    self.assertEqual(create_session.call_count, 3)
                    for call in create_session.call_args_list:
                        self.assertEqual(call.kwargs["providers"], ["CPUExecutionProvider"])
                        self.assertEqual(call.kwargs["sess_options"].inter_op_num_threads, 1)
                    # Warm-up plus the selected input; references also run the real encoder.
                    self.assertEqual(completeness.run.call_count, 2)
                    self.assertEqual(feature.run.call_count, 3)
                    self.assertEqual(metric.run.call_count, 2)
                    self.assertEqual(feature.run.call_args.args[1]["input"].shape, (1, 3, 384, 384))
                    manifest = json.loads(output_path.read_text(encoding="utf-8"))
                    self.assertEqual(manifest["schema_version"], 3)
                    self.assertEqual(manifest["counts"]["images"], 1)
                    self.assertEqual(manifest["counts"]["filtered_images"], 1)
                    self.assertEqual(manifest["groups"], [])
                    rejected = manifest["filtered_items"][0]
                    self.assertEqual(rejected["id"], "selected")
                    self.assertEqual(rejected["reason"], "filter_character")
                    self.assertEqual(rejected["metadata"]["classification"], "rough")
                    self.assertFalse((root / "absent-models").exists())

            animated = root / "animated.gif"
            Image.new("RGB", (16, 16), "red").save(animated, save_all=True,
                append_images=[Image.new("RGB", (16, 16), "blue")], duration=100, loop=0)
            selection["references"] = [snapshot(animated)]
            input_path.write_text(json.dumps(selection), encoding="utf-8")
            with mock.patch.object(sys, "argv", arguments), self.assertRaises(FilterConfigurationError) as caught:
                worker.main()
            self.assertEqual(caught.exception.code, "filter_reference_invalid")

            selection["references"] = []
            for field, stale in (("root_identity", [0, 0]), ("disk_version", "stale")):
                with self.subTest(stale=field):
                    selection["images"] = [{**snapshot(selected_path), field: stale}]
                    input_path.write_text(json.dumps(selection), encoding="utf-8")
                    with mock.patch.object(sys, "argv", arguments), self.assertRaisesRegex(ValueError, "已变化"):
                        worker.main()

    def test_fresh_worker_process_cannot_import_gdl_backend(self):
        script = textwrap.dedent("""\
            import importlib.abc
            import socket
            import sys
            import unittest
            from pathlib import Path

            attempted = []
            class BlockBackend(importlib.abc.MetaPathFinder):
                def find_spec(self, fullname, path=None, target=None):
                    if fullname == "gdl_backend" or fullname.startswith("gdl_backend."):
                        attempted.append(fullname)
                        raise AssertionError("legacy backend import attempted: " + fullname)

            sys.meta_path.insert(0, BlockBackend())
            def no_network(*args, **kwargs):
                raise AssertionError("offline inference test attempted network access")
            socket.socket.connect = no_network
            root = Path(sys.argv[1])
            sys.path[:0] = [str(root / "dedup"), str(root / "tests")]
            suite = unittest.defaultTestLoader.loadTestsFromName(
                "test_review_worker_standalone.StandaloneReviewWorkerTests."
                "test_filter_inference_and_reference_errors_use_local_helpers")
            result = unittest.TextTestRunner(verbosity=2).run(suite)
            assert not attempted, attempted
            assert not any(name == "gdl_backend" or name.startswith("gdl_backend.") for name in sys.modules)
            raise SystemExit(0 if result.wasSuccessful() else 1)
            """)
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, "-I", "-c", script, str(ROOT)], cwd=directory,
                                    capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
