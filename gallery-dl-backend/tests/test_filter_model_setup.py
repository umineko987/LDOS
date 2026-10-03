from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from gdl_backend import review_filters
from gdl_backend.model_setup import ModelSetupManager
from gdl_backend.review_filter_models import MODEL_FILES, model_paths
from gdl_backend.runtime_config import RuntimeConfigStore
from gdl_backend.schemas import ModelInstallRequest
from tests.helpers import make_settings
from tests.test_model_setup import _FakeProcess


def capabilities(available):
    return {name: {"available": available and name != "filter_sketch", "reason": "" if available and name != "filter_sketch" else "not ready"}
            for name in review_filters.FILTER_BLOCKERS}


class FilterCapabilityTests(unittest.TestCase):
    def test_probe_in_configured_python_validates_exact_shape_and_never_loads_onnx_in_api(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python = root / "dedup-python"
            python.write_bytes(b"python")
            for name in MODEL_FILES:
                for path, entry in zip(model_paths(root, name), MODEL_FILES[name]):
                    path.parent.mkdir(exist_ok=True)
                    with path.open("wb") as handle:
                        handle.truncate(entry[1])  # Sparse placeholders; subprocess response mocked.
            valid = {name: {"available": True, "reason": ""} for name in MODEL_FILES}
            probe = mock.Mock(return_value=SimpleNamespace(returncode=0, stdout=json.dumps(valid)))
            with mock.patch.object(review_filters.subprocess, "run", probe):
                status = review_filters.filter_capabilities(root, python, refresh=True)
                self.assertTrue(status["filter_monochrome"]["available"])
                self.assertTrue(status["filter_character"]["available"])
                self.assertFalse(status["filter_sketch"]["available"])
                self.assertEqual(probe.call_args.args[0][0], str(python))
                self.assertEqual(set(status), set(review_filters.FILTER_BLOCKERS))
                self.assertTrue(all(set(item) == {"available", "reason"} for item in status.values()))
                review_filters.filter_capabilities(root, python)
                self.assertEqual(probe.call_count, 1)
                for bad in ({}, {"monochrome": {"available": True, "reason": ""}},
                            {**valid, "ccip": {"available": "yes", "reason": ""}},
                            {**valid, "ccip": {"available": False, "reason": ""}}):
                    probe.return_value = SimpleNamespace(returncode=0, stdout=json.dumps(bad))
                    status = review_filters.filter_capabilities(root, python, refresh=True)
                    self.assertFalse(status["filter_character"]["available"])
                probe.side_effect = subprocess.TimeoutExpired("model check", 60)
                self.assertFalse(review_filters.filter_capabilities(root, python, refresh=True)["filter_monochrome"]["available"])
            model_paths(root, "monochrome")[0].write_bytes(b"corrupt")
            with mock.patch.object(review_filters.subprocess, "run") as probe:
                status = review_filters.filter_capabilities(root, python, selected=["monochrome"], refresh=True)
                self.assertFalse(status["filter_monochrome"]["available"])
                probe.assert_not_called()

    def test_setup_request_old_call_and_only_known_model_selection(self):
        self.assertEqual(ModelInstallRequest.model_validate({"proxy_url": ""}).models, ["dedup"])
        self.assertEqual(ModelInstallRequest.model_validate({"models": ["ccip"]}).models, ["ccip"])
        for bad in ([], ["sketch"], ["/tmp/model"], ["monochrome", "ccip", "dedup", "ccip"]):
            with self.assertRaises(ValueError):
                ModelInstallRequest.model_validate({"models": bad})
        with self.assertRaises(ValueError):
            ModelInstallRequest.model_validate({"models": ["ccip"], "model_dir": "/tmp"})


class SelectiveModelInstallTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.settings = make_settings(self.root)
        self.settings.dedup.model_dir = self.root / "models"
        self.settings.dedup.python_executable = self.root / "configured-python"
        self.settings.dedup.core_script = self.root / "dedup_core.py"
        self.callback = mock.AsyncMock()
        self.manager = ModelSetupManager(self.settings, RuntimeConfigStore(self.settings.config_path), self.callback)

    async def asyncTearDown(self):
        await self.manager.close()
        self.temporary.cleanup()

    async def test_filter_only_uses_configured_dedup_environment_and_does_not_reinstall_or_enable_base(self):
        async def run():
            return b"", b"", 0
        launch = mock.AsyncMock(return_value=_FakeProcess(run))
        with mock.patch("gdl_backend.model_setup.asyncio.create_subprocess_exec", launch), \
             mock.patch("gdl_backend.model_setup.filter_capabilities", return_value=capabilities(True)):
            await self.manager.install("http://proxy.example:8080", ["ccip", "monochrome"])
            await self.manager._task
            status = self.manager.status()
        command = launch.call_args.args
        self.assertEqual(command[0], str(self.settings.dedup.python_executable))
        self.assertTrue(command[1].endswith("review_filter_models.py"))
        self.assertNotIn("--prepare-models", command)
        self.assertEqual(command[-2:], ("ccip", "monochrome"))
        self.assertEqual(status["phase"], "ready")
        self.assertFalse(status["enabled"])
        self.assertEqual(status["requested_models"], ["ccip", "monochrome"])
        self.assertEqual(status["expected_bytes"], 167_072_328)
        self.callback.assert_not_awaited()
        self.assertFalse(self.settings.config_path.exists())

    async def test_zero_exit_but_missing_runtime_or_failed_install_does_not_mark_filter_ready(self):
        for returncode in (0, 1):
            async def run():
                return b"", b"secret proxy error", returncode
            with mock.patch("gdl_backend.model_setup.asyncio.create_subprocess_exec", mock.AsyncMock(return_value=_FakeProcess(run))), \
                 mock.patch("gdl_backend.model_setup.filter_capabilities", return_value=capabilities(False)):
                await self.manager.install(models=["monochrome"])
                await self.manager._task
                status = self.manager.status()
            self.assertEqual(status["phase"], "failed")
            self.assertFalse(status["models"]["monochrome"]["installed"])
            self.assertFalse(status["review_filters"]["filter_monochrome"]["available"])
            self.assertNotIn("secret", status["message"])
            self.assertFalse(self.settings.dedup.enabled)

    async def test_bad_selection_and_sketch_never_launch_install(self):
        with mock.patch("gdl_backend.model_setup.asyncio.create_subprocess_exec") as launch:
            for bad in ([], ["sketch"], ["unknown"]):
                with self.assertRaises(ValueError):
                    await self.manager.install(models=bad)
            launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
