import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tagger"))

import bundle
from bundle import install, install_by_key, installed, read_manifest, verify_bundle
from specs import RemoteFile, TaggerModelSpec


class FileUrlSpec(TaggerModelSpec):
    """测试用 spec：url 指向本地 file://，避免网络。"""

    def url_for(self, remote_file: RemoteFile) -> str:
        return (self.repo / remote_file.name).as_uri()


def make_source(root: Path) -> tuple[Path, RemoteFile, RemoteFile]:
    source = root / "source"
    source.mkdir()
    (source / "model.onnx").write_bytes(b"fake-onnx-weights")
    (source / "selected_tags.csv").write_bytes(b"name,category\ntest,0\n")
    import hashlib

    def remote(name: str) -> RemoteFile:
        data = (source / name).read_bytes()
        return RemoteFile(name, hashlib.sha256(data).hexdigest(), len(data))

    return source, remote("model.onnx"), remote("selected_tags.csv")


def make_spec(source: Path, onnx: RemoteFile, csv: RemoteFile, key: str = "test-model",
              revision: str = "r1") -> TaggerModelSpec:
    return FileUrlSpec(
        key=key,
        repo=source,
        revision=revision,
        adapter="wd_onnx",
        files=(onnx, csv),
        default_thresholds={"general": 0.35},
        license="test",
    )


class TaggerBundleTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.source, self.onnx, self.csv = make_source(self.root)
        self.model_dir = self.root / "models"
        self.spec = make_spec(self.source, self.onnx, self.csv)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_install_publishes_bundle(self) -> None:
        progress: list[tuple[str, int, int]] = []
        path = install(self.spec, self.model_dir, progress=lambda *args: progress.append(args))
        self.assertEqual((path / "model.onnx").read_bytes(), b"fake-onnx-weights")
        self.assertTrue((path / "manifest.json").is_file())
        self.assertFalse(list(self.model_dir.glob(".staging-*")))
        self.assertTrue(progress and progress[0][1] == 0)
        manifest = read_manifest(path)
        self.assertEqual(manifest["revision"], "r1")
        self.assertEqual(manifest["files"]["model.onnx"], self.onnx.sha256)

    def test_installed_and_verify(self) -> None:
        self.assertFalse(installed(self.spec, self.model_dir))
        install(self.spec, self.model_dir)
        self.assertTrue(installed(self.spec, self.model_dir))
        self.assertTrue(verify_bundle(self.spec, self.model_dir))
        # 文件被篡改后 installed（存在性检查）仍通过，完整校验失败
        target = bundle.bundle_path(self.model_dir, self.spec.key)
        (target / "model.onnx").write_bytes(b"tampered")
        self.assertTrue(installed(self.spec, self.model_dir))
        self.assertFalse(verify_bundle(self.spec, self.model_dir))

    def test_bad_sha_cleanup(self) -> None:
        bad = RemoteFile("model.onnx", "0" * 64, self.onnx.size)
        spec = make_spec(self.source, bad, self.csv)
        with self.assertRaises(RuntimeError):
            install(spec, self.model_dir)
        self.assertFalse(list(self.model_dir.glob(".staging-*")))
        self.assertFalse(list(self.model_dir.glob(".part")))
        self.assertFalse((self.model_dir / spec.key).exists())

    def test_reinstall_skips_download(self) -> None:
        install(self.spec, self.model_dir)
        # 源文件消失后再次安装：已安装则不触网
        for name in ("model.onnx", "selected_tags.csv"):
            (self.source / name).unlink()
        path = install(self.spec, self.model_dir)
        self.assertTrue((path / "model.onnx").is_file())

    def test_revision_change_reinstalls(self) -> None:
        install(self.spec, self.model_dir)
        (self.source / "model.onnx").write_bytes(b"updated-weights")
        import hashlib

        data = (self.source / "model.onnx").read_bytes()
        onnx2 = RemoteFile("model.onnx", hashlib.sha256(data).hexdigest(), len(data))
        spec2 = make_spec(self.source, onnx2, self.csv, revision="r2")
        self.assertFalse(installed(spec2, self.model_dir))
        install(spec2, self.model_dir)
        target = bundle.bundle_path(self.model_dir, "test-model")
        self.assertEqual((target / "model.onnx").read_bytes(), b"updated-weights")
        self.assertTrue(installed(spec2, self.model_dir))
        self.assertFalse(list(self.model_dir.glob(".trash-*")))
        self.assertFalse(list(self.model_dir.glob(".staging-*")))

    def test_unknown_key_rejected(self) -> None:
        with self.assertRaises(KeyError):
            install_by_key("no-such-model", self.model_dir)


if __name__ == "__main__":
    unittest.main()
