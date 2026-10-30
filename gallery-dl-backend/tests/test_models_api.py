from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, PropertyMock, patch

from fastapi.testclient import TestClient

from gdl_backend.api_routes.models import ModelInstallResponse, ModelList
from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.download_settings import DownloadSettingsStore
from gdl_backend.model_setup import DINO_BYTES, ModelSetupManager, SSCD_BYTES
from gdl_backend.models_service import DEDUP_JOB_ID, ModelsService
from gdl_backend.review_filter_models import HF_OFFICIAL, mirrored_url
from gdl_backend.tagger_service import TaggerService
from tests.helpers import local_test_client, make_settings
from tests.test_download_settings import TOKEN, FakeProxyPool


DEDUP_KEYS = ["sscd", "dino", "completeness", "ccip"]
TAGGER_KEYS = [
    "wd-vit-v3", "wd-convnext-v3", "wd-swinv2-v3", "wd-vit-large-v3", "wd-eva02-large-v3",
    "wd-eva02-2026-canary", "pixai-tagger-v1", "cl-tagger-v2",
]


class ModelsApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.settings = make_settings(self.root)
        self.settings.tagger.model_dir = self.root / "tagger-models"
        self.settings.dedup.model_dir = self.root / "dedup-models"
        self.container = ServiceContainer(self.settings)
        self.app = create_app(self.settings, container=self.container, start_background=False)
        context = local_test_client(self.app, self.settings)
        self.client: TestClient = context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)

    def items(self) -> dict[str, dict]:
        response = self.client.get("/api/v1/models")
        self.assertEqual(response.status_code, 200, response.text)
        return {item["key"]: item for item in response.json()["items"]}

    def patch_setup_status(self, **overrides):
        status = self.container.model_setup.status()
        models = dict(status["models"])
        for key, value in overrides.pop("models", {}).items():
            models[key] = {**models.get(key, {}), **value}
        status.update(overrides, models=models)
        patcher = patch.object(self.container.model_setup, "status", return_value=status)
        patcher.start()
        self.addCleanup(patcher.stop)
        return patcher

    def patch_install(self):
        setup = patch.object(self.container.model_setup, "install", new_callable=AsyncMock, return_value={})
        prepare = patch.object(self.container.tagger, "prepare", new_callable=AsyncMock, return_value={"phase": "preparing"})
        install_mock = setup.start()
        prepare_mock = prepare.start()
        self.addCleanup(setup.stop)
        self.addCleanup(prepare.stop)
        return install_mock, prepare_mock

    # ---- 列表 ----

    def test_list_covers_every_model_with_metadata(self) -> None:
        items = self.items()
        self.assertEqual(list(items), DEDUP_KEYS + TAGGER_KEYS)
        for item in items.values():
            self.assertEqual(item["status"], "missing" if item["key"] != "cl-tagger-v2" else "needs_license")
            self.assertEqual(item["installed_bytes"], 0)
            self.assertIsNone(item["progress"])
            self.assertIsNone(item["job_id"])
        self.assertEqual(items["sscd"]["size_bytes"], SSCD_BYTES)
        self.assertEqual(items["dino"]["size_bytes"], DINO_BYTES)
        self.assertEqual(items["sscd"]["installs_with"], ["dino"])
        self.assertEqual(items["dino"]["used_by"], ["dedup", "atlas"])
        self.assertEqual(items["ccip"]["used_by"], ["clean"])
        self.assertEqual(items["completeness"]["family"], "dedup")
        self.assertEqual(items["wd-vit-v3"]["family"], "tagger")
        self.assertEqual(items["wd-vit-v3"]["used_by"], ["tag"])
        self.assertIsNone(items["wd-vit-v3"]["size_bytes"])
        self.assertTrue(items["cl-tagger-v2"]["gated"])
        self.assertTrue(items["cl-tagger-v2"]["license"])
        self.assertFalse(items["wd-vit-v3"]["gated"])
        self.assertTrue(items["wd-vit-v3"]["source_url"].startswith("https://huggingface.co/"))

    def test_list_reports_installed_installing_and_failed(self) -> None:
        installing = self.patch_setup_status(
            phase="installing", requested_models=["ccip"],
            models={"sscd": {"installed": True}, "dino": {"installed": True},
                    "ccip": {"installed": False, "downloaded_bytes": 1024, "expected_bytes": 4096}},
        )
        catalog = self.container.tagger.model_catalog()
        for entry in catalog:
            entry["installed"] = entry["key"] == "wd-vit-v3"
        self.container.tagger.state.phase = "preparing"
        self.container.tagger.state.download = {"wd-swinv2-v3": {"file": "model.onnx", "done": 10, "total": 100}}
        self.container.tagger.prepare_models = ("wd-swinv2-v3", "cl-tagger-v2")
        with patch.object(self.container.tagger, "model_catalog", return_value=catalog), \
                patch.object(self.container.tagger, "installed_bytes", return_value=1234), \
                patch.object(type(self.container.tagger), "current_job_id", new_callable=PropertyMock, return_value="tagger:x"):
            items = self.items()
        self.assertEqual(items["sscd"]["status"], "installed")
        self.assertEqual(items["sscd"]["installed_bytes"], SSCD_BYTES)
        self.assertEqual(items["completeness"]["status"], "missing")
        self.assertEqual(items["ccip"]["status"], "installing")
        self.assertEqual(items["ccip"]["progress"], {"current": 1024, "total": 4096})
        self.assertEqual(items["ccip"]["job_id"], DEDUP_JOB_ID)
        self.assertEqual(items["wd-vit-v3"]["status"], "installed")
        self.assertEqual(items["wd-vit-v3"]["installed_bytes"], 1234)
        self.assertEqual(items["wd-swinv2-v3"]["status"], "installing")
        self.assertEqual(items["wd-swinv2-v3"]["progress"], {"current": 10, "total": 100})
        self.assertEqual(items["wd-swinv2-v3"]["job_id"], "tagger:x")
        self.assertEqual(items["cl-tagger-v2"]["status"], "installing")
        self.assertIsNone(items["cl-tagger-v2"]["progress"])
        self.assertEqual(items["wd-convnext-v3"]["status"], "missing")

        self.container.tagger.state.phase = "failed"
        self.container.tagger.state.message = f"download failed {TOKEN}"
        self.container.download_settings.update(hf_token=TOKEN)
        installing.stop()
        self.patch_setup_status(phase="failed", requested_models=["dedup"], message="network error")
        items = self.items()
        self.assertEqual((items["sscd"]["status"], items["dino"]["status"]), ("failed", "failed"))
        self.assertEqual(items["sscd"]["message"], "network error")
        self.assertEqual(items["ccip"]["status"], "missing")
        self.assertEqual(items["wd-swinv2-v3"]["status"], "failed")
        self.assertNotIn(TOKEN, items["wd-swinv2-v3"]["message"])
        self.assertEqual(items["wd-vit-v3"]["status"], "missing")

    def test_tagger_installed_bytes_counts_spec_files_only(self) -> None:
        bundle = self.settings.tagger.model_dir / "wd-vit-v3"
        bundle.mkdir(parents=True)
        (bundle / "model.onnx").write_bytes(b"x" * 100)
        (bundle / "unrelated.bin").write_bytes(b"x" * 1000)
        outside = self.root / "outside.csv"
        outside.write_bytes(b"x" * 10_000)
        (bundle / "selected_tags.csv").symlink_to(outside)
        self.assertEqual(self.container.tagger.installed_bytes("wd-vit-v3"), 100)
        self.assertEqual(self.container.tagger.installed_bytes("no-such-model"), 0)

    def test_disabled_tagger_models_are_listed_as_disabled(self) -> None:
        self.settings.tagger.enabled = False
        items = self.items()
        self.assertEqual({items[key]["status"] for key in TAGGER_KEYS}, {"disabled"})
        self.assertEqual(items["sscd"]["status"], "missing")
        response = self.client.post("/api/v1/models/install", json={"keys": ["wd-vit-v3"]})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "tagger_disabled")

    def test_response_models_keep_payload(self) -> None:
        payload = self.container.models.list_models()
        self.assertEqual(ModelList.model_validate(payload).model_dump(mode="json"), payload)
        self.assertEqual(self.client.get("/api/v1/models").json(), payload)

    # ---- 安装分派 ----

    def test_install_dispatches_dedup_keys_to_model_setup(self) -> None:
        install, prepare = self.patch_install()
        self.container.download_settings.update(hf_mirror="https://hf-mirror.example", proxy_mode="custom",
                                                custom_proxy="http://127.0.0.1:7890")
        for keys, selection in ((["sscd"], ["dedup"]), (["dino", "sscd"], ["dedup"]),
                                (["ccip", "sscd", "completeness"], ["ccip", "dedup", "completeness"])):
            with self.subTest(keys=keys):
                install.reset_mock()
                response = self.client.post("/api/v1/models/install", json={"keys": keys})
                self.assertEqual(response.status_code, 202, response.text)
                install.assert_awaited_once_with("http://127.0.0.1:7890", selection,
                                                 hf_endpoint="https://hf-mirror.example")
                body = response.json()
                self.assertEqual(body["started"][0]["family"], "dedup")
                self.assertEqual(body["started"][0]["job_id"], DEDUP_JOB_ID)
                self.assertEqual(body["started"][0]["proxy_source"], "custom")
                self.assertEqual(len(body["items"]), len(DEDUP_KEYS + TAGGER_KEYS))
                self.assertEqual(ModelInstallResponse.model_validate(body).model_dump(mode="json"), body)
        self.assertEqual(self.client.post("/api/v1/models/install", json={"keys": ["sscd"]}).json()["started"][0]["keys"],
                         ["sscd", "dino"])
        prepare.assert_not_awaited()

    def test_install_dispatches_tagger_keys_with_unified_settings(self) -> None:
        install, prepare = self.patch_install()
        self.container.download_settings.update(hf_mirror="https://hf-mirror.example", hf_token=TOKEN)
        response = self.client.post("/api/v1/models/install",
                                    json={"keys": ["wd-vit-v3", "cl-tagger-v2", "sscd"], "accept_license": True})
        self.assertEqual(response.status_code, 202, response.text)
        prepare.assert_awaited_once_with(["wd-vit-v3", "cl-tagger-v2"], TOKEN, accept_license=True,
                                         proxy_url="https://hf-mirror.example", download_proxy=None)
        install.assert_awaited_once_with(None, ["dedup"], hf_endpoint="https://hf-mirror.example")
        self.assertEqual([entry["family"] for entry in response.json()["started"]], ["tagger", "dedup"])
        self.assertNotIn(TOKEN, response.text)
        self.assertNotIn(TOKEN, self.client.get("/api/v1/models").text)

    def test_install_validation(self) -> None:
        install, prepare = self.patch_install()
        cases = (
            ({"keys": []}, 422, "validation_error"),
            ({"keys": ["no-such-model"]}, 422, "unknown_model"),
            ({"keys": ["cl-tagger-v2"]}, 422, "model_license_required"),
            ({"keys": ["sscd"], "proxy": "x"}, 422, "validation_error"),
        )
        for payload, status_code, code in cases:
            with self.subTest(payload=payload):
                response = self.client.post("/api/v1/models/install", json=payload)
                self.assertEqual(response.status_code, status_code, response.text)
                self.assertEqual(response.json()["error"]["code"], code)
        install.assert_not_awaited()
        prepare.assert_not_awaited()

    def test_install_rejects_busy_installers(self) -> None:
        install, prepare = self.patch_install()
        busy = SimpleNamespace(done=lambda: False)
        with patch.object(type(self.container.model_setup), "running_task", new_callable=PropertyMock, return_value=busy):
            response = self.client.post("/api/v1/models/install", json={"keys": ["dino"]})
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "models_busy"))
        with patch.object(type(self.container.tagger), "running_task", new_callable=PropertyMock, return_value=busy):
            response = self.client.post("/api/v1/models/install", json={"keys": ["sscd", "wd-vit-v3"]})
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "tagger_busy"))
        install.assert_not_awaited()
        prepare.assert_not_awaited()

    def test_install_reports_unavailable_pool_and_start_failure(self) -> None:
        install, prepare = self.patch_install()
        self.container.download_settings = DownloadSettingsStore(self.settings.runtime_dir, proxy=FakeProxyPool(endpoint=None))
        self.container.models._downloads = self.container.download_settings
        self.container.download_settings.update(proxy_mode="pool")
        response = self.client.post("/api/v1/models/install", json={"keys": ["sscd"]})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "download_proxy_unavailable"))
        install.assert_not_awaited()
        self.container.download_settings.update(proxy_mode="none")
        prepare.side_effect = FileNotFoundError("tagger CLI 不存在")
        response = self.client.post("/api/v1/models/install", json={"keys": ["wd-vit-v3", "sscd"]})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (503, "tagger_start_failed"))
        # 打标先启动；它失败时去重安装还没开始
        install.assert_not_awaited()

    # ---- 旧接口 ----

    def test_legacy_setup_install_uses_unified_mirror_only(self) -> None:
        install, _prepare = self.patch_install()
        self.container.download_settings.update(hf_mirror="https://hf-mirror.example", proxy_mode="custom",
                                                custom_proxy="http://127.0.0.1:7890")
        response = self.client.post("/api/v1/setup/models/install", json={"models": ["ccip"]})
        self.assertEqual(response.status_code, 202, response.text)
        install.assert_awaited_once_with("", ["ccip"], hf_endpoint="https://hf-mirror.example")
        self.assertEqual(self.client.get("/api/v1/setup/models").status_code, 200)


class ModelsServiceLeaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.settings = make_settings(root)
        self.settings.tagger.model_dir = root / "tagger-models"
        self.settings.dedup.model_dir = root / "dedup-models"
        self.pool = FakeProxyPool()
        self.downloads = DownloadSettingsStore(self.settings.runtime_dir, proxy=self.pool)
        self.downloads.update(proxy_mode="pool")
        self.model_setup = ModelSetupManager(self.settings, SimpleNamespace())
        self.tagger = TaggerService(self.settings)
        self.service = ModelsService(self.settings, self.model_setup, self.tagger, self.downloads)
        self.addAsyncCleanup(self.service.close)

    async def test_pool_lease_is_released_when_installer_finishes(self) -> None:
        gate = asyncio.Event()
        calls = []

        async def fake_install(proxy, models, *, hf_endpoint=None):
            calls.append((proxy, models, hf_endpoint))

            async def run():
                await gate.wait()

            self.model_setup._task = asyncio.create_task(run())
            return {}

        with patch.object(self.model_setup, "install", side_effect=fake_install), \
                patch.object(self.model_setup, "status", return_value={"phase": "installing", "models": {}}):
            result = await self.service.install(["dino"])
        self.assertEqual(calls, [("http://127.0.0.1:20001", ["dedup"], None)])
        self.assertEqual(result["started"][0]["proxy_source"], "pool")
        self.assertEqual(len(self.pool.acquired), 1)
        self.assertEqual(self.pool.released, [])
        gate.set()
        for _ in range(50):
            if self.pool.released:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(self.pool.released, [(self.pool.acquired[0], False, "model_download_finished")])

    async def test_pool_lease_is_released_when_start_fails(self) -> None:
        with patch.object(self.tagger, "prepare", new_callable=AsyncMock, side_effect=OSError("boom")):
            with self.assertRaises(Exception):
                await self.service.install(["wd-vit-v3"])
        self.assertEqual(len(self.pool.released), 1)
        # 没有运行中的任务（AsyncMock 不会启动子进程）也立即归还
        with patch.object(self.tagger, "prepare", new_callable=AsyncMock, return_value={"phase": "preparing"}):
            await self.service.install(["wd-vit-v3"])
        self.assertEqual(len(self.pool.released), 2)


class MirroredUrlTests(unittest.TestCase):
    def test_only_official_hf_links_are_rewritten(self) -> None:
        url = f"{HF_OFFICIAL}/deepghs/ccip_onnx/resolve/abc/model.onnx"
        self.assertEqual(mirrored_url(url, "https://hf-mirror.example/"),
                         "https://hf-mirror.example/deepghs/ccip_onnx/resolve/abc/model.onnx")
        self.assertEqual(mirrored_url(url, ""), url)
        self.assertEqual(mirrored_url("https://example.com/model.onnx", "https://hf-mirror.example"),
                         "https://example.com/model.onnx")
        with patch.dict("os.environ", {"HF_ENDPOINT": "http://10.0.0.2:8080"}):
            self.assertEqual(mirrored_url(url), "http://10.0.0.2:8080/deepghs/ccip_onnx/resolve/abc/model.onnx")
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(mirrored_url(url), url)


if __name__ == "__main__":
    unittest.main()
