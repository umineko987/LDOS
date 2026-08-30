import base64
import csv
import hashlib
import importlib.util
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "frontend_artifacts.py"
SPEC = importlib.util.spec_from_file_location("frontend_artifacts", SCRIPT_PATH)
FRONTEND_ARTIFACTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FRONTEND_ARTIFACTS)


def record_digest(content: bytes) -> str:
    encoded = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode("ascii")
    return f"sha256={encoded}"


class FrontendWheelArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.backend = self.root / "webui_dist"
        self.files = {
            "assets/app.js": b"console.log('app');\n",
            "frontend-manifest.json": b'{"schema_version":1}\n',
            "index.html": b"<!doctype html>\n",
        }
        for relative, content in self.files.items():
            path = self.backend / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        self.expected = tuple(sorted(self.files))
        self.backend_patch = patch.object(FRONTEND_ARTIFACTS, "BACKEND_ROOT", self.backend)
        self.backend_patch.start()

    def tearDown(self):
        self.backend_patch.stop()
        self.temporary.cleanup()

    def write_wheel(self, name: str, *, corrupt_record: str = "") -> Path:
        wheel_path = self.root / name
        members = {
            f"gdl_backend/webui_dist/{relative}": content
            for relative, content in self.files.items()
        }
        record_name = "ldos_backend-0.dist-info/RECORD"
        output = io.StringIO(newline="")
        writer = csv.writer(output, lineterminator="\n")
        for member, content in sorted(members.items()):
            digest = (
                "sha256=invalid"
                if corrupt_record and member.endswith(corrupt_record)
                else record_digest(content)
            )
            writer.writerow((member, digest, len(content)))
        writer.writerow((record_name, "", ""))
        with zipfile.ZipFile(wheel_path, "w") as wheel:
            for member, content in members.items():
                wheel.writestr(member, content)
            wheel.writestr(record_name, output.getvalue())
        return wheel_path

    def test_accepts_matching_frontend_bytes_and_record(self):
        FRONTEND_ARTIFACTS._verify_wheel(self.write_wheel("valid.whl"), self.expected)

    def test_rejects_frontend_record_hash_mismatch(self):
        with self.assertRaisesRegex(FRONTEND_ARTIFACTS.ArtifactError, "wheel_record_mismatch:index.html"):
            FRONTEND_ARTIFACTS._verify_wheel(
                self.write_wheel("invalid-record.whl", corrupt_record="index.html"),
                self.expected,
            )



if __name__ == "__main__":
    unittest.main()
