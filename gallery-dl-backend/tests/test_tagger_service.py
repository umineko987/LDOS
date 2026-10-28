from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from gdl_backend.events import EventBus, JobRegistry
from gdl_backend.tagger_service import TaggerService
from tests.helpers import make_settings


class TaggerServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.settings = make_settings(self.root)
        self.settings.tagger.python_executable = Path(sys.executable)
        self.settings.tagger.cli_script = self.root / "cli.py"
        self.settings.tagger.model_dir = self.root / "models"
        self.settings.tagger.cache_path = self.root / "cache.sqlite3"
        self.settings.tagger.shutdown_grace_seconds = 0.1
        self.service = TaggerService(self.settings)

    async def asyncTearDown(self) -> None:
        await self.service.close()
        self._tmp.cleanup()

    def script(self, body: str) -> None:
        self.settings.tagger.cli_script.write_text(body, encoding="utf-8")

    async def finish(self) -> None:
        await asyncio.wait_for(asyncio.shield(self.service._task), timeout=5)
        self.assertIsNone(self.service._process)

    async def test_multiple_inputs_and_all_thresholds_reach_cli_parser(self) -> None:
        tagger_root = Path(__file__).resolve().parents[2] / "tagger"
        self.script(f"""
import json, sys
sys.path.insert(0, {str(tagger_root)!r})
from cli import build_parser
args = build_parser().parse_args()
print(json.dumps({{'type': 'done', 'inputs': args.inputs, 'categories': args.categories,
    'thresholds': args.model_threshold}}), flush=True)
""")
        thresholds = {"wd-vit-v3": {"general": 0.4}, "pixai-tagger-v1": {"general": 0.2, "style": 0.15}}
        await self.service.tag(list(thresholds), ["/first path", "/second"], thresholds=thresholds)
        await self.finish()
        self.assertEqual(self.service.state.phase, "idle")
        self.assertEqual(self.service.state.last_result["inputs"], ["/first path", "/second"])
        self.assertEqual(self.service.state.last_result["thresholds"], [
            ["wd-vit-v3", "general", "0.4"], ["pixai-tagger-v1", "general", "0.2"], ["pixai-tagger-v1", "style", "0.15"],
        ])
        self.assertEqual(self.service.state.last_result["categories"], "")

    async def test_large_stderr_does_not_block_stdout_or_completion(self) -> None:
        self.script("""
import json, sys
sys.stderr.write('x' * 2_000_000 + '\\nfinal-error\\n')
sys.stderr.flush()
print(json.dumps({'type': 'progress', 'stage': 'inferring', 'done': 1, 'total': 1}), flush=True)
raise SystemExit(7)
""")
        await self.service.tag(["wd-vit-v3"], ["/first"])
        await self.finish()
        self.assertEqual(self.service.state.phase, "failed")
        self.assertEqual(self.service.state.done, 1)
        self.assertIn("final-error", self.service.state.message)
        self.assertLessEqual(len(self.service.state.message), 500)

    async def test_missing_cli_and_python_fail_cleanly_and_allow_retry(self) -> None:
        with self.assertRaises(FileNotFoundError):
            await self.service.prepare(["wd-vit-v3"])
        self.assertEqual(self.service.state.phase, "failed")
        self.assertIsNone(self.service._process)
        self.script("print('{\"type\": \"done\"}', flush=True)")
        self.settings.tagger.python_executable = self.root / "missing-python"
        with self.assertRaises(FileNotFoundError):
            await self.service.tag(["wd-vit-v3"], ["/first"])
        self.assertEqual(self.service.state.phase, "failed")
        self.assertIsNone(self.service._process)
        self.settings.tagger.python_executable = Path(sys.executable)
        await self.service.tag(["wd-vit-v3"], ["/first"])
        await self.finish()
        self.assertEqual(self.service.state.phase, "idle")

    async def test_prepare_sends_token_only_via_stdin_and_forwards_mirror(self) -> None:
        token = "test-token-not-a-real-secret"
        self.script("""
import json, os, sys
received = sys.stdin.readline().strip()
print(json.dumps({'type': 'done', 'received_token': bool(received),
    'mirror': os.environ.get('HF_ENDPOINT'), 'args': sys.argv[1:]}), flush=True)
""")
        await self.service.prepare(["cl-tagger-v2"], token, accept_license=True, proxy_url="https://mirror.example")
        await self.finish()
        result = self.service.state.last_result
        self.assertTrue(result["received_token"])
        self.assertEqual(result["mirror"], "https://mirror.example")
        self.assertNotIn(token, str(self.service.status()))
        self.assertIn("--accept-license", result["args"])

    async def test_download_proxy_is_scoped_to_prepare_and_overrides_environment(self) -> None:
        names = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy", "HF_ENDPOINT")
        inherited = dict.fromkeys(names, "inherited")
        self.script(f"""
import json, os, sys
print(json.dumps({{'type': 'done', 'env': {{key: os.environ.get(key) for key in {names!r}}},
    'args': sys.argv[1:]}}), flush=True)
""")
        proxy = "http://127.0.0.1:7890"
        with patch.dict(os.environ, inherited):
            await self.service.prepare(["wd-vit-v3"], proxy_url="https://mirror.example", download_proxy=proxy)
            await self.finish()
            result = self.service.state.last_result
            self.assertEqual(result["env"], {**dict.fromkeys(names[:4], proxy), "NO_PROXY": "", "no_proxy": "", "HF_ENDPOINT": "https://mirror.example"})
            self.assertNotIn(proxy, str(result["args"]))
            self.assertEqual({key: os.environ[key] for key in names}, inherited)
            await self.service.prepare(["wd-vit-v3"])
            await self.finish()
            self.assertEqual(self.service.state.last_result["env"], inherited)
            await self.service.tag(["wd-vit-v3"], ["/first"])
            await self.finish()
            self.assertEqual(self.service.state.last_result["env"], inherited)

    async def test_download_proxy_credentials_are_redacted_from_failures(self) -> None:
        self.script("""
import os, sys
print('Proxy failed: ' + os.environ['HTTPS_PROXY'], file=sys.stderr)
raise SystemExit(1)
""")
        await self.service.prepare(["wd-vit-v3"], download_proxy="http://test-user:test-password@127.0.0.1:7890")
        await self.finish()
        self.assertEqual(self.service.state.phase, "failed")
        self.assertIn("http://***:***@127.0.0.1:7890", self.service.state.message)
        self.assertNotIn("test-user", str(self.service.status()))
        self.assertNotIn("test-password", str(self.service.status()))

    async def test_prepare_bundle_download_really_uses_proxy_and_mirror(self) -> None:
        requests: list[str] = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                payload = b"proxied-model-file"
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        tagger_root = Path(__file__).resolve().parents[2] / "tagger"
        self.script(f"""
import json, sys
from pathlib import Path
sys.path.insert(0, {str(tagger_root)!r})
from bundle import install
from specs import RemoteFile, TaggerModelSpec
spec = TaggerModelSpec(key='proxy-test', repo='test/repo', revision='r1', adapter='wd_onnx',
    files=(RemoteFile('model.onnx'), RemoteFile('tags.csv')), default_thresholds={{}}, license='test')
install(spec, Path({str(self.settings.tagger.model_dir)!r}))
print(json.dumps({{'type': 'done'}}), flush=True)
""")
        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.dict(os.environ, {"NO_PROXY": "*", "no_proxy": "*"}):
                    await self.service.prepare(["wd-vit-v3"], proxy_url="http://mirror.invalid",
                                               download_proxy=f"http://127.0.0.1:{server.server_port}")
                    await self.finish()
            finally:
                await asyncio.to_thread(server.shutdown)
                thread.join()
        self.assertEqual(self.service.state.phase, "idle", self.service.state.message)
        self.assertEqual(requests, ["http://mirror.invalid/test/repo/resolve/r1/model.onnx",
                                    "http://mirror.invalid/test/repo/resolve/r1/tags.csv"])
        self.assertEqual((self.settings.tagger.model_dir / "proxy-test/model.onnx").read_bytes(), b"proxied-model-file")

    @unittest.skipUnless(os.name == "posix", "SIGTERM ignore is POSIX-specific")
    async def test_cancel_kills_stubborn_child_and_drains_before_retry(self) -> None:
        self.script("""
import json, signal, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
print(json.dumps({'type': 'progress', 'stage': 'inferring', 'done': 0, 'total': 1}), flush=True)
time.sleep(30)
""")
        await self.service.tag(["wd-vit-v3"], ["/first"])
        async with asyncio.timeout(5):
            while self.service.state.stage != "inferring":
                await asyncio.sleep(0.01)
        with self.assertRaisesRegex(RuntimeError, "已有打标任务"):
            await self.service.prepare(["wd-vit-v3"])
        process = self.service._process
        await self.service.cancel()
        self.assertIsNotNone(process.returncode)
        self.assertIsNone(self.service._process)
        self.assertTrue(self.service._task.done())
        self.assertFalse(self.service._task.cancelled())
        self.assertEqual(self.service.state.message, "已取消")
        self.script("print('{\"type\": \"done\"}', flush=True)")
        await self.service.tag(["wd-vit-v3"], ["/second"])
        await self.finish()
        self.assertEqual(self.service.state.phase, "idle")


class TaggerJobReportingTests(unittest.IsolatedAsyncioTestCase):
    """每次 prepare/tag 登记为活动中心 Job，进度与终态随 CLI 事件推送。"""

    setUp = TaggerServiceTests.setUp
    asyncTearDown = TaggerServiceTests.asyncTearDown
    script = TaggerServiceTests.script
    finish = TaggerServiceTests.finish

    async def asyncSetUp(self) -> None:
        self.bus = EventBus(epoch="e1")
        self.jobs = JobRegistry(self.bus, min_publish_interval=0.0)
        self.service = TaggerService(self.settings, jobs=self.jobs)

    def only_job(self) -> dict:
        items = self.jobs.list()
        self.assertEqual(len(items), 1)
        return items[0]

    async def test_tag_progress_reaches_job_and_finishes_succeeded(self) -> None:
        self.script("""
import json
for done in (1, 2):
    print(json.dumps({'type': 'progress', 'stage': 'inferring', 'done': done, 'total': 2}), flush=True)
print(json.dumps({'type': 'done'}), flush=True)
""")
        await self.service.tag(["wd-vit-v3", "pixai-tagger-v1"], ["/a", "/b"], job_ref={"dataset_id": "ds1"})
        await self.finish()
        job = self.only_job()
        self.assertEqual(
            (job["kind"], job["title"], job["status"], job["current"], job["total"]),
            ("tagger.tag", "打标 2 张", "succeeded", 2, 2),
        )
        self.assertEqual(job["ref"], {"models": "wd-vit-v3,pixai-tagger-v1", "dataset_id": "ds1"})
        events, _ = self.bus.events_after(0)
        progress = [event.data["job"]["current"] for event in events if event.data["job"]["status"] == "running"]
        self.assertEqual(progress, [None, 1, 2])

    async def test_prepare_failure_finishes_job_failed_with_stderr_tail(self) -> None:
        self.script("""
import json, sys
print(json.dumps({'type': 'download', 'model': 'wd-vit-v3', 'file': 'model.onnx', 'done': 5, 'total': 10}), flush=True)
sys.stderr.write('network down\\n')
raise SystemExit(3)
""")
        await self.service.prepare(["wd-vit-v3"])
        await self.finish()
        job = self.only_job()
        self.assertEqual((job["kind"], job["status"]), ("tagger.prepare", "failed"))
        self.assertEqual((job["current"], job["total"]), (5, 10))
        self.assertIn("network down", job["message"])

    async def test_cancel_finishes_job_cancelled(self) -> None:
        self.script("""
import json, time
print(json.dumps({'type': 'progress', 'stage': 'inferring', 'done': 0, 'total': 1}), flush=True)
time.sleep(30)
""")
        await self.service.tag(["wd-vit-v3"], ["/a"])
        async with asyncio.timeout(5):
            while self.service.state.stage != "inferring":
                await asyncio.sleep(0.01)
        await self.service.cancel()
        job = self.only_job()
        self.assertEqual((job["status"], job["message"]), ("cancelled", ""))
        self.assertIsNotNone(job["finished_at"])

    async def test_spawn_failure_finishes_job_failed(self) -> None:
        with self.assertRaises(FileNotFoundError):
            await self.service.tag(["wd-vit-v3"], ["/a"])
        job = self.only_job()
        self.assertEqual(job["status"], "failed")
        self.assertIn("tagger CLI 不存在", job["message"])
        self.assertFalse(self.jobs.has_active())
