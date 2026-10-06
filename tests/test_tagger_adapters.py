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
from adapters import TaggerAdapterError, TimmCanaryAdapter, WdOnnxAdapter
from bundle import install
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
