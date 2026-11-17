"""Exercise the packaged Go lifecycle without downloading a release runtime."""
from __future__ import annotations

import json
from pathlib import Path
import shlex
import shutil
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
EXECUTOR_PYTHON = ROOT / "gallery-dl-backend/.venv/bin/python"
sys.path.insert(0, str(ROOT / "scripts"))
import desktop_release as release


class NativeReleaseRuntimeTests(unittest.TestCase):
    @unittest.skipUnless(
        (ROOT / "backend/build/ldos-backend").is_file() and EXECUTOR_PYTHON.is_file(),
        "prepare the native backend and gallery executor environment before running packaged lifecycle integration",
    )
    def test_native_service_initializes_private_state_before_doctor(self) -> None:
        # Artifact contents have their own tests. Here only heavyweight executor
        # checks are faked; the Go service, HTTP, doctor and parent pipe are real.
        with tempfile.TemporaryDirectory(prefix="ldos-native-release-test-") as temporary:
            root = Path(temporary)
            binary = root / "bin/ldos-backend"
            binary.parent.mkdir()
            binary.symlink_to(ROOT / "backend/build/ldos-backend")
            app = root / "app"
            shutil.copytree(ROOT / "backend/executors/ldos_gallery", app / "executors/ldos_gallery")
            gallery = app / "gallery-dl-codeberg/gallery_dl"
            gallery.mkdir(parents=True)
            (gallery / "__init__.py").write_text("", encoding="utf-8")
            python = root / "runtime/python/bin/python3.13"
            python.parent.mkdir(parents=True)
            python.write_text(f"#!/bin/sh\nexec {shlex.quote(str(EXECUTOR_PYTHON))} \"$@\"\n", encoding="utf-8")
            python.chmod(0o700)
            mihomo = app / "bin/mihomo"
            mihomo.parent.mkdir()
            mihomo.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            mihomo.chmod(0o700)
            manifest = {
                "target": "linux-x86_64",
                "runtime": {"python": "runtime/python/bin/python3.13"},
                "bundled_resources": {"mihomo": {"binary": "app/bin/mihomo", "version": "fixture"}},
                "files": {"sha256": "artifact-validation-is-tested-separately"},
            }
            original_run = release.run
            doctors: list[Path] = []

            def run_fixture(command, *, cwd, env=None, capture=False):
                if Path(command[0]) == binary:
                    self.assertIn("--doctor", command)
                    config = Path(command[command.index("--config") + 1])
                    self.assertEqual(config.stat().st_mode & 0o777, 0o600)
                    settings = json.loads(config.read_text(encoding="utf-8"))
                    self.assertFalse(settings["gallery"]["migrate_default_auth"])
                    data = Path(env["LDOS_DESKTOP_DATA_ROOT"])
                    self.assertTrue((data / "runtime/backend.sqlite3").is_file())
                    self.assertEqual((data / "runtime").stat().st_mode & 0o777, 0o700)
                    doctors.append(config)
                    return original_run(command, cwd=cwd, env=env, capture=capture)
                if "-c" in command:
                    return json.dumps({"python": "fixture", "torch": "fixture+cpu", "torchvision": "fixture", "cuda": False})
                if Path(command[0]) == mihomo:
                    return "Mihomo fixture"
                return "fixture executor"

            with (
                mock.patch.object(release, "verify_tree", return_value=manifest),
                mock.patch.object(release, "verify_release_identity"),
                mock.patch.object(release, "run", side_effect=run_fixture),
            ):
                result = release.verify_runtime(root)
            self.assertEqual(len(doctors), 1)
            self.assertEqual(result["readyz_status"], 200)


if __name__ == "__main__":
    unittest.main()
