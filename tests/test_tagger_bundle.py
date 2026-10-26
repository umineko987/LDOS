import sys
import tempfile
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tagger"))

import bundle
from bundle import install, install_by_key, installed, read_manifest
from specs import RemoteFile, TaggerModelSpec


class FileUrlSpec(TaggerModelSpec):
    """测试用 spec：url 指向本地 file://，避免网络。"""

    def url_for(self, remote_file: RemoteFile) -> str:
        return (self.repo / remote_file.name).as_uri()


def make_source(root: Path) -> Path:
    source = root / "source"
    source.mkdir()
    (source / "model.onnx").write_bytes(b"fake-onnx-weights")
    (source / "selected_tags.csv").write_bytes(b"name,category\ntest,0\n")
    return source


def make_spec(source: Path, key: str = "test-model", revision: str = "r1") -> TaggerModelSpec:
    return FileUrlSpec(
        key=key,
        repo=source,
        revision=revision,
        adapter="wd_onnx",
        files=(RemoteFile("model.onnx"), RemoteFile("selected_tags.csv")),
        default_thresholds={"general": 0.35},
        license="test",
    )


class TaggerBundleTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.source = make_source(self.root)
        self.model_dir = self.root / "models"
        self.spec = make_spec(self.source)

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
        self.assertEqual(manifest["files"], ["model.onnx", "selected_tags.csv"])

    def test_installed_requires_manifest_and_files(self) -> None:
        self.assertFalse(installed(self.spec, self.model_dir))
        install(self.spec, self.model_dir)
        self.assertTrue(installed(self.spec, self.model_dir))
        # 文件缺失后不再视为已安装
        target = bundle.bundle_path(self.model_dir, self.spec.key)
        (target / "model.onnx").unlink()
        self.assertFalse(installed(self.spec, self.model_dir))

    def test_failed_download_cleans_staging(self) -> None:
        # 指向不存在的源文件：下载失败后暂存目录必须清空
        (self.source / "selected_tags.csv").unlink()
        with self.assertRaises(Exception):
            install(self.spec, self.model_dir)
        self.assertFalse(list(self.model_dir.glob(".staging-*")))
        self.assertFalse(list(self.model_dir.glob(".part")))
        self.assertFalse((self.model_dir / self.spec.key).exists())

    def test_reinstall_skips_download(self) -> None:
        install(self.spec, self.model_dir)
        for name in ("model.onnx", "selected_tags.csv"):
            (self.source / name).unlink()
        path = install(self.spec, self.model_dir)
        self.assertTrue((path / "model.onnx").is_file())

    def test_revision_change_reinstalls(self) -> None:
        install(self.spec, self.model_dir)
        (self.source / "model.onnx").write_bytes(b"updated-weights")
        spec2 = make_spec(self.source, revision="r2")
        self.assertFalse(installed(spec2, self.model_dir))
        install(spec2, self.model_dir)
        target = bundle.bundle_path(self.model_dir, "test-model")
        self.assertEqual((target / "model.onnx").read_bytes(), b"updated-weights")
        self.assertTrue(installed(spec2, self.model_dir))
        self.assertFalse(list(self.model_dir.glob(".trash-*")))
        self.assertFalse(list(self.model_dir.glob(".staging-*")))

    def test_install_uses_mirror_endpoint_for_actual_downloads(self) -> None:
        requests: list[str] = []
        files = {"model.onnx": b"mirror-weights", "selected_tags.csv": b"name,category\ntest,0\n"}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                payload = files[self.path.rsplit("/", 1)[-1]]
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        spec = TaggerModelSpec(
            key="mirror-test", repo="test/repo", revision="r1", adapter="wd_onnx",
            files=(RemoteFile("model.onnx"), RemoteFile("selected_tags.csv")),
            default_thresholds={"general": 0.35}, license="test",
        )
        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.dict(os.environ, {"HF_ENDPOINT": f"http://127.0.0.1:{server.server_port}/"}):
                    target = install(spec, self.model_dir)
            finally:
                server.shutdown()
                thread.join()
        self.assertEqual(requests, ["/test/repo/resolve/r1/model.onnx", "/test/repo/resolve/r1/selected_tags.csv"])
        self.assertEqual((target / "model.onnx").read_bytes(), b"mirror-weights")
        self.assertTrue(installed(spec, self.model_dir))

    def test_unknown_key_rejected(self) -> None:
        with self.assertRaises(KeyError):
            install_by_key("no-such-model", self.model_dir)


if __name__ == "__main__":
    unittest.main()
