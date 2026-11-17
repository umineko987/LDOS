import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import torch  # noqa: F401  预热模块缓存：避免 patch.dict 恢复时移除 torch 导致二次初始化崩溃

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tagger"))

import numpy as np
from PIL import Image

import adapters
from adapters import ClOnnxAdapter, TaggerAdapterError, TimmCanaryAdapter, WdOnnxAdapter
from bundle import bundle_path, install, read_manifest
from specs import RemoteFile, TaggerModelSpec

CSV_ROWS = "tag_id,name,category,count\n0,solo,0,1\n1,1girl,0,1\n2,chara_a,4,1\n3,general,9,1\n"
N_TAGS = 4


class FakeNode:
    def __init__(self, name: str, shape: list):
        self.name = name
        self.shape = shape


class FakeSession:
    sessions: list["FakeSession"] = []

    def __init__(self, path: str, providers=None):
        self.providers = providers or []
        self.calls: list[np.ndarray] = []
        self.inputs = [FakeNode("input", ["None", 32, 32, 3])]
        self.outputs = [FakeNode("probs", ["None", N_TAGS])]
        FakeSession.sessions.append(self)

    def get_providers(self):
        return ["CPUExecutionProvider"]

    def get_inputs(self):
        return self.inputs

    def get_outputs(self):
        return self.outputs

    def run(self, _, feeds):
        batch = feeds["input"]
        self.calls.append(batch)
        # 确定性输出：每标签分数 = batch 内像素均值微扰，与批大小无关
        means = batch.reshape(batch.shape[0], -1).mean(axis=1)
        result = (means[:, None] * np.arange(1, N_TAGS + 1, dtype=np.float32)[None, :]) / 255.0
        return [result]


def make_bundle(root: Path, csv_text: str = CSV_ROWS) -> tuple[Path, TaggerModelSpec]:
    source = root / "source"
    source.mkdir(parents=True, exist_ok=True)
    (source / "model.onnx").write_bytes(b"fake")
    (source / "selected_tags.csv").write_text(csv_text, encoding="utf-8")

    class LocalUrlSpec(TaggerModelSpec):
        def url_for(self, remote_file: RemoteFile) -> str:
            return (source / remote_file.name).as_uri()

    spec = LocalUrlSpec(
        key="test-wd",
        repo=source,
        revision="rev1",
        adapter="wd_onnx",
        files=(RemoteFile("model.onnx"), RemoteFile("selected_tags.csv")),
        default_thresholds={"general": 0.35},
        license="test",
    )
    return install(spec, root / "models"), spec


def make_timm_bundle(root: Path, num_classes: int = N_TAGS,
                     config_classes: int | None = None,
                     key: str = "test-canary") -> tuple[Path, TaggerModelSpec]:
    source = root / "timm-source"
    source.mkdir(parents=True, exist_ok=True)
    (source / "model.safetensors").write_bytes(b"fake-safetensors")
    (source / "selected_tags.csv").write_text(
        f"tag_id,name,category,count\n"
        + "".join(f"{i},tag{i},0,1\n" for i in range(num_classes)),
        encoding="utf-8",
    )
    (source / "config.json").write_text(
        json.dumps({
            "architecture": "eva02_large_patch14_448",
            "num_classes": config_classes if config_classes is not None else num_classes,
            "model_args": {"img_size": 32, "ref_feat_shape": [2, 2]},
        }),
        encoding="utf-8",
    )

    class LocalUrlSpec(TaggerModelSpec):
        def url_for(self, remote_file: RemoteFile) -> str:
            return (source / remote_file.name).as_uri()

    spec = LocalUrlSpec(
        key=key,
        repo=source,
        revision="rev1",
        adapter="timm_canary",
        files=(
            RemoteFile("model.safetensors"),
            RemoteFile("selected_tags.csv"),
            RemoteFile("config.json"),
        ),
        default_thresholds={"general": 0.6094},
        license="test",
    )
    return install(spec, root / "models"), spec


class AdapterRegistryTests(unittest.TestCase):
    def test_every_registered_model_has_a_concrete_adapter(self) -> None:
        from specs import SPECS
        for spec in SPECS.values():
            with self.subTest(model=spec.key):
                adapter = adapters.ADAPTERS[spec.adapter](spec, Path("unused-models"))
                self.assertEqual(adapter.spec, spec)
                self.assertIsNone(adapter.vocabulary)
                self.assertEqual(adapter.fingerprint, "")


class WdOnnxAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        _, self.spec = make_bundle(self.root)
        self.model_dir = self.root / "models"
        FakeSession.sessions.clear()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _load(self) -> WdOnnxAdapter:
        adapter = WdOnnxAdapter(self.spec, self.model_dir)
        with mock.patch("onnxruntime.InferenceSession", FakeSession):
            adapter.load()
        return adapter

    def test_load_reads_size_and_fingerprint(self) -> None:
        adapter = self._load()
        self.assertEqual(adapter._input_size, 32)
        self.assertEqual(adapter._max_batch, 0)  # 动态 batch
        self.assertEqual(len(adapter.vocabulary), N_TAGS)
        self.assertTrue(adapter.fingerprint)

    def test_infer_dynamic_batch_single_call(self) -> None:
        adapter = self._load()
        images = [Image.new("RGB", (10, 20), (i, i, i)) for i in range(3)]
        scores = adapter.infer_scores(images)
        self.assertEqual(scores.shape, (3, N_TAGS))
        session = FakeSession.sessions[-1]
        self.assertEqual(len(session.calls), 1)
        self.assertEqual(session.calls[0].shape, (3, 32, 32, 3))

    def test_infer_static_batch_splits(self) -> None:
        adapter = WdOnnxAdapter(self.spec, self.model_dir)

        class StaticSession(FakeSession):
            def __init__(self, path, providers=None):
                super().__init__(path, providers)
                self.inputs = [FakeNode("input", [1, 32, 32, 3])]

        with mock.patch("onnxruntime.InferenceSession", StaticSession):
            adapter.load()
        self.assertEqual(adapter._max_batch, 1)
        images = [Image.new("RGB", (10, 10), (5, 5, 5)) for _ in range(3)]
        scores = adapter.infer_scores(images)
        self.assertEqual(scores.shape, (3, N_TAGS))
        session = FakeSession.sessions[-1]
        self.assertEqual(len(session.calls), 3)

    def test_static_batch_pads_partial_tail_and_trims_results(self) -> None:
        class StaticSession(FakeSession):
            def __init__(self, path, providers=None):
                super().__init__(path, providers)
                self.inputs = [FakeNode("input", [2, 32, 32, 3])]

            def run(self, outputs, feeds):
                assert feeds["input"].shape[0] == 2
                return super().run(outputs, feeds)

        adapter = WdOnnxAdapter(self.spec, self.model_dir)
        with mock.patch("onnxruntime.InferenceSession", StaticSession):
            adapter.load()
        images = [Image.new("RGB", (10, 10), (i * 20, 10, 10)) for i in range(3)]
        scores = adapter.infer_scores(images)
        self.assertEqual(scores.shape, (3, N_TAGS))
        self.assertEqual([len(batch) for batch in FakeSession.sessions[-1].calls], [2, 2])
        single = adapter.infer_scores([images[-1]])
        np.testing.assert_allclose(scores[-1], single[0])

    def test_output_dim_mismatch_rejected(self) -> None:
        adapter = WdOnnxAdapter(self.spec, self.model_dir)

        class WrongOutputSession(FakeSession):
            def __init__(self, path, providers=None):
                super().__init__(path, providers)
                self.outputs = [FakeNode("probs", ["None", 999])]

        with mock.patch("onnxruntime.InferenceSession", WrongOutputSession):
            with self.assertRaises(TaggerAdapterError):
                adapter.load()

    def test_nchw_input_rejected(self) -> None:
        adapter = WdOnnxAdapter(self.spec, self.model_dir)

        class NchwSession(FakeSession):
            def __init__(self, path, providers=None):
                super().__init__(path, providers)
                self.inputs = [FakeNode("input", ["None", 3, 32, 32])]

        with mock.patch("onnxruntime.InferenceSession", NchwSession):
            with self.assertRaises(TaggerAdapterError):
                adapter.load()

    def test_requires_install(self) -> None:
        adapter = WdOnnxAdapter(self.spec, self.root / "empty")
        with self.assertRaises(TaggerAdapterError):
            adapter.load()


if __name__ == "__main__":
    unittest.main()


class FakeTimmModel:
    instances: list["FakeTimmModel"] = []

    def __init__(self):
        self.kwargs = None
        self.loaded = None
        self.evaluating = False
        FakeTimmModel.instances.append(self)

    def load_state_dict(self, state_dict, strict=True):
        if state_dict != {"w": b"fake-safetensors"}:
            raise RuntimeError("state dict mismatch")
        self.loaded = state_dict

    def eval(self):
        self.evaluating = True
        return self

    def __call__(self, tensor):
        self.kwargs = tensor
        # 确定性 logits：batch 均值 * 标签下标，验证 sigmoid 与批一致性
        means = tensor.reshape(tensor.shape[0], -1).mean(dim=1)
        import torch
        return means[:, None] * torch.arange(1, N_TAGS + 1, dtype=torch.float32)[None, :]


def make_timm_session_patch():
    """伪造 timm.create_model 与 safetensors.torch.load_file。"""
    fake_timm = types.SimpleNamespace(
        create_model=lambda name, **kwargs: FakeTimmModel()
    )
    fake_safetensors = types.ModuleType("safetensors.torch")
    fake_safetensors.load_file = lambda path: {"w": b"fake-safetensors"}
    fake_safetensors_pkg = types.ModuleType("safetensors")
    fake_safetensors_pkg.torch = fake_safetensors
    return fake_timm, fake_safetensors_pkg


class TimmCanaryAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        _, self.spec = make_timm_bundle(self.root)
        self.model_dir = self.root / "models"
        FakeTimmModel.instances.clear()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _load(self) -> TimmCanaryAdapter:
        fake_timm, fake_safetensors = make_timm_session_patch()
        adapter = TimmCanaryAdapter(self.spec, self.model_dir)
        with mock.patch.dict(sys.modules, {"timm": fake_timm, "safetensors": fake_safetensors,
                                           "safetensors.torch": fake_safetensors.torch}):
            adapter.load()
        return adapter

    def test_load_uses_config_and_strict_state(self) -> None:
        adapter = self._load()
        model = FakeTimmModel.instances[-1]
        self.assertEqual(adapter._input_size, 32)
        self.assertTrue(model.evaluating)
        self.assertEqual(len(adapter.vocabulary), N_TAGS)
        self.assertTrue(adapter.fingerprint)

    def test_infer_applies_sigmoid(self) -> None:
        adapter = self._load()
        from PIL import Image

        scores = adapter.infer_scores([Image.new("RGB", (10, 10), (255, 255, 255))])
        self.assertEqual(scores.shape, (1, N_TAGS))
        # 输入全白 → canary_prepare 后接近 +1；sigmoid(正数) ∈ (0.5, 1) 且单调
        self.assertTrue(((scores > 0.5) & (scores < 1.0)).all())
        self.assertLess(scores[0, 0], scores[0, N_TAGS - 1])
        received = FakeTimmModel.instances[-1].kwargs
        self.assertEqual(tuple(received.shape), (1, 3, 32, 32))

    def test_class_count_mismatch_rejected(self) -> None:
        _, spec = make_timm_bundle(self.root, num_classes=N_TAGS, config_classes=N_TAGS + 2,
                                   key="test-canary-mismatch")
        adapter = TimmCanaryAdapter(spec, self.model_dir)
        fake_timm, fake_safetensors = make_timm_session_patch()
        with mock.patch.dict(sys.modules, {"timm": fake_timm, "safetensors": fake_safetensors,
                                           "safetensors.torch": fake_safetensors.torch}):
            with self.assertRaises(TaggerAdapterError):
                adapter.load()

    def test_wrong_adapter_type_rejected(self) -> None:
        with self.assertRaises(TaggerAdapterError):
            WdOnnxAdapter(self.spec, self.model_dir)


class ClOnnxAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _make_spec(self, *, gated: bool, accept: bool | None = None):
        import json as json_module

        source = self.root / "cl-source"
        (source / "v2_00").mkdir(parents=True, exist_ok=True)
        (source / "v2_00" / "model.onnx").write_bytes(b"fake")
        vocab = {
            "num_tags": 3,
            "idx_to_tag": {"0": "tree", "1": "sky", "2": "miku"},
            "tag_to_category": {"tree": "General", "sky": "General", "miku": "Character"},
        }
        (source / "v2_00" / "model_vocabulary.json").write_text(
            json_module.dumps(vocab), encoding="utf-8"
        )

        class LocalUrlSpec(TaggerModelSpec):
            def url_for(self, remote_file: RemoteFile) -> str:
                return (source / remote_file.name).as_uri()

        spec = LocalUrlSpec(
            key=f"test-cl-{gated}-{accept}",
            repo=source,
            revision="rev1",
            adapter="cl_onnx",
            files=(RemoteFile("v2_00/model.onnx"), RemoteFile("v2_00/model_vocabulary.json")),
            default_thresholds={"general": 0.55},
            license="test-license",
            gated=gated,
        )
        # helper 一律以接受许可的方式安装成功；拒绝路径由具体用例单独覆盖
        return install(spec, self.root / "models", accept_license=True), spec

    def test_gated_requires_accept_license(self) -> None:
        _, spec = self._make_spec(gated=True, accept=False)
        with self.assertRaises(PermissionError):
            install(spec, self.root / "models2", accept_license=False)

    def test_load_blocked_without_license_manifest(self) -> None:
        # 安装时接受了许可但 manifest 被篡改 -> 加载拒绝
        _, spec = self._make_spec(gated=True, accept=True)
        target = bundle_path(self.root / "models", spec.key)
        manifest = read_manifest(target)
        manifest["license_accepted"] = False
        (target / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

        class NchwClSession(FakeSession):
            def __init__(self, path, providers=None):
                super().__init__(path, providers)
                self.inputs = [FakeNode("input", ["None", 3, 16, 16])]
                self.outputs = [FakeNode("logits", ["None", 3])]

        adapter = ClOnnxAdapter(spec, self.root / "models")
        with mock.patch("onnxruntime.InferenceSession", NchwClSession):
            with self.assertRaises(TaggerAdapterError):
                adapter.load()

    def test_nchw_layout_and_sigmoid(self) -> None:
        _, spec = self._make_spec(gated=False, accept=False)

        class NchwClSession(FakeSession):
            def __init__(self, path, providers=None):
                super().__init__(path, providers)
                self.inputs = [FakeNode("input", ["None", 3, 16, 16])]
                self.outputs = [FakeNode("logits", ["None", 3])]

            def run(self, _, feeds):
                batch = feeds["input"]
                self.calls.append(batch)
                logits = batch.reshape(batch.shape[0], -1).mean(axis=1, keepdims=True) * 4.0
                return [np.broadcast_to(logits, (batch.shape[0], 3)).copy()]

        adapter = ClOnnxAdapter(spec, self.root / "models")
        with mock.patch("onnxruntime.InferenceSession", NchwClSession):
            adapter.load()
        self.assertTrue(adapter._channels_first)
        self.assertEqual(adapter._input_size, 16)
        scores = adapter.infer_scores([Image.new("RGB", (5, 9), (10, 200, 30))])
        self.assertEqual(scores.shape, (1, 3))
        session = FakeSession.sessions[-1]
        self.assertEqual(session.calls[0].shape, (1, 3, 16, 16))  # CHW
        # sigmoid 输出在 (0,1) 且关于 0.5 对称（logit 全同值）
        self.assertTrue(((scores > 0) & (scores < 1)).all())

    def test_fixed_cl_batch_splits_and_pads(self) -> None:
        _, spec = self._make_spec(gated=False, accept=False)

        class FixedClSession(FakeSession):
            def __init__(self, path, providers=None):
                super().__init__(path, providers)
                self.inputs = [FakeNode("input", [2, 3, 16, 16])]
                self.outputs = [FakeNode("logits", [2, 3])]

            def run(self, _, feeds):
                batch = feeds["input"]
                assert len(batch) == 2
                self.calls.append(batch)
                return [np.zeros((2, 3), dtype=np.float32)]

        adapter = ClOnnxAdapter(spec, self.root / "models")
        with mock.patch("onnxruntime.InferenceSession", FixedClSession):
            adapter.load()
        scores = adapter.infer_scores([Image.new("RGB", (8, 8)) for _ in range(3)])
        self.assertEqual(scores.shape, (3, 3))
        self.assertEqual([len(batch) for batch in FakeSession.sessions[-1].calls], [2, 2])

    def test_output_dim_mismatch_rejected(self) -> None:
        _, spec = self._make_spec(gated=False, accept=False)

        class BadDimSession(FakeSession):
            def __init__(self, path, providers=None):
                super().__init__(path, providers)
                self.inputs = [FakeNode("input", ["None", 3, 16, 16])]
                self.outputs = [FakeNode("logits", ["None", 777])]

        adapter = ClOnnxAdapter(spec, self.root / "models")
        with mock.patch("onnxruntime.InferenceSession", BadDimSession):
            with self.assertRaises(TaggerAdapterError):
                adapter.load()


def make_cl_bundle(root: Path, *, gated: bool = False) -> tuple[Path, TaggerModelSpec]:
    source = root / f"cl-describe-source-{gated}"
    (source / "v2_00").mkdir(parents=True, exist_ok=True)
    (source / "v2_00" / "model.onnx").write_bytes(b"fake")
    (source / "v2_00" / "model_vocabulary.json").write_text(json.dumps({
        "num_tags": 3,
        "idx_to_tag": {"0": "tree", "1": "miku", "2": "sky"},
        "tag_to_category": {"tree": "General", "sky": "General", "miku": "Character"},
    }), encoding="utf-8")

    class LocalUrlSpec(TaggerModelSpec):
        def url_for(self, remote_file: RemoteFile) -> str:
            return (source / remote_file.name).as_uri()

    spec = LocalUrlSpec(
        key=f"test-cl-describe-{gated}", repo=source, revision="rev-cl", adapter="cl_onnx",
        files=(RemoteFile("v2_00/model.onnx"), RemoteFile("v2_00/model_vocabulary.json")),
        default_thresholds={"general": 0.55}, license="test-license", gated=gated,
    )
    return install(spec, root / "models", accept_license=True), spec


def make_pixai_bundle(root: Path) -> tuple[Path, TaggerModelSpec]:
    source = root / "pixai-source"
    source.mkdir(parents=True, exist_ok=True)
    (source / "model.safetensors").write_bytes(b"fake")
    (source / "config.json").write_text(json.dumps({
        "tags": ["1girl", "solo", "miku", "general"],
        "tags_split": [["general", 2], ["character", 1], ["copyright", 0], ["rating", 1]],
    }), encoding="utf-8")
    (source / "preprocessor_config.json").write_text("{}", encoding="utf-8")
    (source / "tagger_pipeline.py").write_text("", encoding="utf-8")

    class LocalUrlSpec(TaggerModelSpec):
        def url_for(self, remote_file: RemoteFile) -> str:
            return (source / remote_file.name).as_uri()

    spec = LocalUrlSpec(
        key="test-pixai", repo=source, revision="rev-pixai", adapter="pixai_hf",
        files=(RemoteFile("model.safetensors"), RemoteFile("config.json"),
               RemoteFile("preprocessor_config.json"), RemoteFile("tagger_pipeline.py")),
        default_thresholds={"general": 0.17}, license="test",
    )
    return install(spec, root / "models"), spec


def fake_transformers(num_classes: int) -> types.ModuleType:
    class FakePixaiModel:
        config = types.SimpleNamespace(num_classes=num_classes)

        def eval(self):
            return self

    module = types.ModuleType("transformers")
    module.AutoModel = types.SimpleNamespace(from_pretrained=lambda *args, **kwargs: FakePixaiModel())
    module.AutoImageProcessor = types.SimpleNamespace(from_pretrained=lambda *args, **kwargs: object())
    return module


class PixaiCpuRuntimeTests(unittest.TestCase):
    def test_bounds_cpu_threads_and_restores_callers_setting(self) -> None:
        import os

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, spec = make_pixai_bundle(root)
            for threads, expected in ((16, [8, 16]), (2, [])):
                with self.subTest(threads=threads), \
                        mock.patch.dict(os.environ, {}, clear=True), \
                        mock.patch.dict(sys.modules, {"transformers": fake_transformers(4)}), \
                        mock.patch.object(torch, "get_num_threads", return_value=threads), \
                        mock.patch.object(torch, "set_num_threads") as setting:
                    adapter = adapters.PixaiHfAdapter(spec, root / "models")
                    adapter.load()
                    adapter.close()
                    adapter.close()
                    self.assertEqual(setting.call_args_list, [mock.call(value) for value in expected])

    def test_explicit_thread_environment_is_preserved(self) -> None:
        import os

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, spec = make_pixai_bundle(root)
            for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS"):
                with self.subTest(key=key), \
                        mock.patch.dict(os.environ, {key: "12"}, clear=True), \
                        mock.patch.dict(sys.modules, {"transformers": fake_transformers(4)}), \
                        mock.patch.object(torch, "set_num_threads") as setting:
                    adapter = adapters.PixaiHfAdapter(spec, root / "models")
                    adapter.load()
                    adapter.close()
                    setting.assert_not_called()


def refuse_inference_session(*args, **kwargs):
    raise AssertionError("describe() 不能创建推理 session")


# 屏蔽所有推理运行时：describe() 一旦尝试导入就会 ImportError
NO_RUNTIMES = {"timm": None, "transformers": None, "safetensors": None, "safetensors.torch": None}


class DescribeTests(unittest.TestCase):
    """describe() 只读词表即得到与 load() 完全相同的指纹与词表。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.model_dir = self.root / "models"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def described(self, spec: TaggerModelSpec):
        with mock.patch("onnxruntime.InferenceSession", refuse_inference_session), \
                mock.patch.dict(sys.modules, NO_RUNTIMES):
            return adapters.describe(spec, self.model_dir)

    def assert_matches_load(self, spec: TaggerModelSpec, loaded) -> None:
        described = self.described(spec)
        self.assertIs(type(described), type(loaded))
        self.assertTrue(described.fingerprint)
        self.assertEqual(described.fingerprint, loaded.fingerprint)
        self.assertEqual(described.vocabulary.names, loaded.vocabulary.names)
        self.assertEqual(described.vocabulary.category_of, loaded.vocabulary.category_of)
        self.assertEqual(described.vocabulary.fingerprint, loaded.vocabulary.fingerprint)

    def test_wd_onnx(self) -> None:
        _, spec = make_bundle(self.root)
        loaded = WdOnnxAdapter(spec, self.model_dir)
        with mock.patch("onnxruntime.InferenceSession", FakeSession):
            loaded.load()
        self.assert_matches_load(spec, loaded)

    def test_timm_canary(self) -> None:
        _, spec = make_timm_bundle(self.root)
        fake_timm, fake_safetensors = make_timm_session_patch()
        loaded = TimmCanaryAdapter(spec, self.model_dir)
        with mock.patch.dict(sys.modules, {"timm": fake_timm, "safetensors": fake_safetensors,
                                           "safetensors.torch": fake_safetensors.torch}):
            loaded.load()
        self.assert_matches_load(spec, loaded)

    def test_pixai_hf(self) -> None:
        _, spec = make_pixai_bundle(self.root)
        loaded = adapters.PixaiHfAdapter(spec, self.model_dir)
        with mock.patch.dict(sys.modules, {"transformers": fake_transformers(4)}):
            loaded.load()
        self.assert_matches_load(spec, loaded)

    def test_cl_onnx_including_gated(self) -> None:
        class NchwClSession(FakeSession):
            def __init__(self, path, providers=None):
                super().__init__(path, providers)
                self.inputs = [FakeNode("input", ["None", 3, 16, 16])]
                self.outputs = [FakeNode("logits", ["None", 3])]

        for gated in (False, True):
            with self.subTest(gated=gated):
                _, spec = make_cl_bundle(self.root, gated=gated)
                loaded = ClOnnxAdapter(spec, self.model_dir)
                with mock.patch("onnxruntime.InferenceSession", NchwClSession):
                    loaded.load()
                self.assert_matches_load(spec, loaded)

    def test_fingerprint_changes_with_revision_and_vocabulary(self) -> None:
        from dataclasses import replace

        _, spec = make_bundle(self.root)
        described = self.described(spec)
        moved = replace(spec, revision="rev2")
        self.assertNotEqual(
            adapters.model_fingerprint("wd_onnx", moved, described.vocabulary), described.fingerprint,
        )
        other_root = self.root / "other"
        _, other_spec = make_bundle(other_root, CSV_ROWS + "4,smile,0,1\n")
        other = adapters.describe(other_spec, other_root / "models")
        self.assertNotEqual(other.fingerprint, described.fingerprint)

    def test_requires_install_and_known_adapter(self) -> None:
        from dataclasses import replace

        _, spec = make_bundle(self.root)
        with self.assertRaises(TaggerAdapterError):
            adapters.describe(spec, self.root / "empty")
        with self.assertRaises(TaggerAdapterError):
            adapters.describe(replace(spec, adapter="unknown"), self.model_dir)

    def test_describe_then_infer_still_requires_load(self) -> None:
        _, spec = make_bundle(self.root)
        adapter = self.described(spec)
        with self.assertRaises(TaggerAdapterError):
            adapter.infer_scores([Image.new("RGB", (4, 4))])
