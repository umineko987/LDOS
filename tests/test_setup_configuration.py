"""Execute the installer's configuration step without installing dependencies."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class SetupConfigurationTests(unittest.TestCase):
    def run_config_step(self, backend: Path) -> subprocess.CompletedProcess[str]:
        # Execute the shipped shell block itself. Copying its defaults into a
        # fixture would miss the disabled-proxy regression this guards against.
        script = (ROOT / "scripts/setup-linux.sh").read_text(encoding="utf-8")
        start = script.index('config_path="$backend_dir/config.json"')
        end = script.index('if [[ $skip_models -eq 0 ]]; then', start)
        env = dict(os.environ, backend_dir=str(backend), backend_python=sys.executable,
                   dedup_python=sys.executable, device="cpu")
        return subprocess.run(
            ["bash", "-s"], input="set -euo pipefail\nstage_failed() { exit 1; }\n" + script[start:end],
            text=True, capture_output=True, env=env, timeout=10, check=False,
        )

    def test_fresh_install_allows_manual_proxy_start_without_auto_start(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            backend = Path(tmp)
            shutil.copyfile(ROOT / "gallery-dl-backend/config.example.json", backend / "config.example.json")
            result = self.run_config_step(backend)
            self.assertEqual(result.returncode, 0, result.stderr)
            path = backend / "config.json"
            settings = json.loads(path.read_text(encoding="utf-8"))
            self.assertIs(settings["proxy"]["enabled"], True)
            self.assertIs(settings["proxy"]["auto_start"], False)
            self.assertEqual(settings["gallery"]["python_executable"], os.path.abspath(sys.executable))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_reinstall_preserves_existing_user_proxy_and_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            backend = Path(tmp)
            path = backend / "config.json"
            original = '{"proxy":{"enabled":false,"auto_start":true,"subscription_urls":["https://fixture.invalid/private-sub"]},"auth":{"authorization_proxy":"http://fixture:secret@127.0.0.1:7890"}}\n'
            path.write_text(original, encoding="utf-8")
            result = self.run_config_step(backend)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(path.read_text(encoding="utf-8"), original)
            self.assertNotIn("private-sub", result.stdout + result.stderr)
            self.assertNotIn("fixture:secret", result.stdout + result.stderr)

    def test_config_symlink_does_not_modify_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            backend = Path(tmp)
            target = backend / "target.json"
            target.write_text("fixture", encoding="utf-8")
            target.chmod(0o644)
            (backend / "config.json").symlink_to(target)
            result = self.run_config_step(backend)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(target.read_text(encoding="utf-8"), "fixture")
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)


if __name__ == "__main__":
    unittest.main()
