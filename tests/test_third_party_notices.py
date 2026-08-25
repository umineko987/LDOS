from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from third_party_notices import NoticeError, verify


class ThirdPartyNoticesTests(unittest.TestCase):
    def make_tree(self) -> Path:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        tree = Path(temporary.name)
        license_path = tree / "licenses" / "example" / "LICENSE"
        license_path.parent.mkdir(parents=True)
        license_path.write_text("license text\n", encoding="utf-8")
        (tree / "licenses" / "THIRD-PARTY-NOTICES.md").write_text(
            "# notices\n", encoding="utf-8"
        )
        (tree / "licenses" / "third-party-components.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "target": "linux-x86_64",
                    "components": [
                        {
                            "ecosystem": "example",
                            "name": "dependency",
                            "version": "1.0.0",
                            "license": "MIT",
                            "source": "https://example.invalid/dependency/1.0.0",
                            "license_files": ["licenses/example/LICENSE"],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        return tree

    def test_verifies_complete_target_inventory(self) -> None:
        tree = self.make_tree()

        self.assertEqual(
            verify(tree, "linux-x86_64"),
            {"target": "linux-x86_64", "components": 1},
        )

    def test_rejects_missing_license_file(self) -> None:
        tree = self.make_tree()
        (tree / "licenses" / "example" / "LICENSE").unlink()

        with self.assertRaisesRegex(NoticeError, "invalid third-party license path"):
            verify(tree, "linux-x86_64")

    def test_rejects_license_path_outside_tree(self) -> None:
        tree = self.make_tree()
        outside = tree.parent / f"{tree.name}-outside-license"
        outside.write_text("license\n", encoding="utf-8")
        self.addCleanup(outside.unlink, missing_ok=True)
        inventory = tree / "licenses" / "third-party-components.json"
        payload = json.loads(inventory.read_text(encoding="utf-8"))
        payload["components"][0]["license_files"] = [f"../{outside.name}"]
        inventory.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(NoticeError, "invalid third-party license path"):
            verify(tree, "linux-x86_64")

    def test_rejects_target_mismatch(self) -> None:
        tree = self.make_tree()

        with self.assertRaisesRegex(NoticeError, "target mismatch"):
            verify(tree, "windows-x86_64")


if __name__ == "__main__":
    unittest.main()
