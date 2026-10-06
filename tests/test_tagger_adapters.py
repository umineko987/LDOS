import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tagger"))

import numpy as np
from PIL import Image

import adapters
from adapters import TaggerAdapterError, WdOnnxAdapter
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
    import hashlib

    source = root / "source"
    source.mkdir(parents=True, exist_ok=True)
    (source / "model.onnx").write_bytes(b"fake")
    (source / "selected_tags.csv").write_text(csv_text, encoding="utf-8")

    def remote(name: str) -> RemoteFile:
        data = (source / name).read_bytes()
        return RemoteFile(name, hashlib.sha256(data).hexdigest(), len(data))

    class LocalUrlSpec(TaggerModelSpec):
        def url_for(self, remote_file: RemoteFile) -> str:
            return (source / remote_file.name).as_uri()

    spec = LocalUrlSpec(
        key="test-wd",
        repo=source,
        revision="rev1",
        adapter="wd_onnx",
        files=(remote("model.onnx"), remote("selected_tags.csv")),
        default_thresholds={"general": 0.35},
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
