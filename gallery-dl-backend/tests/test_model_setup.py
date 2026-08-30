from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from gdl_backend.model_setup import (
    EXPECTED_DOWNLOAD_BYTES,
    ModelSetupManager,
    normalize_download_proxy,
)
from gdl_backend.runtime_config import RuntimeConfigStore
from tests.helpers import make_settings


class _FakeProcess:
    def __init__(self, run) -> None:
        self.returncode: int | None = None
        self._run = run

    def kill(self) -> None:
        self.returncode = -9

    async def wait(self) -> int:
        if self.returncode is None:
            _stdout, _stderr, returncode = await self._run()
            if self.returncode is None:
                self.returncode = returncode
        return int(self.returncode)


class ModelSetupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.settings = make_settings(self.root)
        self.settings.dedup.model_dir = self.root / "models"
        self.settings.dedup.python_executable = self.root / "python"
        self.settings.dedup.core_script = self.root / "dedup_core.py"
        self.on_enabled = mock.AsyncMock()
        self.manager = ModelSetupManager(
            self.settings,
            RuntimeConfigStore(self.settings.config_path),
            self.on_enabled,
        )

    async def asyncTearDown(self) -> None:
        await self.manager.close()
        self.temporary.cleanup()

    def _write_models(self) -> None:
        sscd, dino, repository = self.manager._paths()
        sscd.parent.mkdir(parents=True, exist_ok=True)
        dino.parent.mkdir(parents=True, exist_ok=True)
        repository.parent.mkdir(parents=True, exist_ok=True)
        sscd.write_bytes(b"sscd")
        dino.write_bytes(b"dino")
        repository.write_text("# hub", encoding="utf-8")

    async def test_install_is_idempotent_enables_dedup_and_does_not_save_proxy(self) -> None:
        started = asyncio.Event()
        finish = asyncio.Event()

        async def run():
            started.set()
            await finish.wait()
            self._write_models()
            return b"prepared", b"", 0

        process = _FakeProcess(run)
        launch = mock.AsyncMock(return_value=process)
        proxy = "https://user:secret@proxy.example:8443"
        with mock.patch("gdl_backend.model_setup.asyncio.create_subprocess_exec", launch):
            first = await self.manager.install(proxy)
            await started.wait()
            second = await self.manager.install(proxy)
            self.assertEqual(first["phase"], "installing")
            self.assertEqual(second["phase"], "installing")
            self.assertEqual(launch.await_count, 1)
            finish.set()
            assert self.manager._task is not None
            await self.manager._task

        status = self.manager.status()
        self.assertEqual(status["phase"], "ready")
        self.assertTrue(status["enabled"])
        self.assertTrue(status["installed"])
        self.assertEqual(status["downloaded_bytes"], EXPECTED_DOWNLOAD_BYTES)
        self.assertTrue(self.settings.dedup.enabled)
        self.on_enabled.assert_awaited_once_with()
        environment = launch.await_args.kwargs["env"]
        self.assertEqual(environment["HTTPS_PROXY"], proxy)
        saved = self.settings.config_path.read_text(encoding="utf-8")
        self.assertNotIn(proxy, saved)
        self.assertTrue(json.loads(saved)["dedup"]["enabled"])

    async def test_missing_configured_python_uses_workspace_venv(self) -> None:
        relative = Path("Scripts/python.exe") if os.name == "nt" else Path("bin/python")
        fallback = self.root / ".venv" / relative
        fallback.parent.mkdir(parents=True)
        fallback.write_bytes(b"fixture-python")
        if os.name != "nt":
            fallback.chmod(0o700)
        configured = self.root / "old-checkout" / ".venv" / relative
        self.settings.dedup.python_executable = configured

        async def run():
            self._write_models()
            return b"prepared", b"", 0

        launch = mock.AsyncMock(
            side_effect=[FileNotFoundError(), _FakeProcess(run)],
        )
        with mock.patch("gdl_backend.model_setup.asyncio.create_subprocess_exec", launch):
            await self.manager.install()
            assert self.manager._task is not None
            await self.manager._task

        self.assertEqual(self.manager.status()["phase"], "ready")
        self.assertEqual(launch.await_count, 2)
        self.assertEqual(launch.await_args_list[0].args[0], str(configured))
        self.assertEqual(launch.await_args_list[1].args[0], str(fallback))
        self.assertEqual(self.settings.dedup.python_executable, fallback)
        saved = json.loads(self.settings.config_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["dedup"]["python_executable"], str(fallback))

    async def test_failed_process_does_not_expose_proxy_or_enable_dedup(self) -> None:
        proxy = "http://user:secret@proxy.example:8080"

        async def run():
            return b"", f"download failed through {proxy}".encode(), 1

        with mock.patch(
            "gdl_backend.model_setup.asyncio.create_subprocess_exec",
            mock.AsyncMock(return_value=_FakeProcess(run)),
        ):
            await self.manager.install(proxy)
            assert self.manager._task is not None
            await self.manager._task

        status = self.manager.status()
        self.assertEqual(status["phase"], "failed")
        self.assertNotIn("secret", status["message"])
        self.assertFalse(self.settings.dedup.enabled)
        self.assertFalse(self.settings.config_path.exists())
        self.on_enabled.assert_not_awaited()

    async def test_runtime_config_stores_merge_independent_sections(self) -> None:
        path = self.root / "shared.json"
        browser_store = RuntimeConfigStore(path)
        model_store = RuntimeConfigStore(path)
        await asyncio.gather(
            browser_store.update_section("auth", {"chrome_executable": "/browser"}),
            model_store.update_section("dedup", {"enabled": True}),
        )
        self.assertEqual(
            json.loads(path.read_text(encoding="utf-8")),
            {
                "auth": {"chrome_executable": "/browser"},
                "dedup": {"enabled": True},
            },
        )

    def test_download_proxy_accepts_only_http_endpoints_with_ports(self) -> None:
        self.assertIsNone(normalize_download_proxy(""))
        self.assertEqual(
            normalize_download_proxy(" HTTPS://proxy.example:8443/ "),
            "https://proxy.example:8443",
        )
        for value in (
            "http://proxy .example:8080",
            "socks5://proxy.example:1080",
            "https://proxy.example",
            "https://proxy.example:8443/path",
            "https://proxy.example:8443/?token=secret",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_download_proxy(value)
