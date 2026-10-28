from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path


WORKSPACE = Path(__file__).resolve().parents[2]
SCRIPT = WORKSPACE / "scripts" / "export_openapi.py"


def _load_exporter():
    spec = importlib.util.spec_from_file_location("ldos_export_openapi", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OpenApiSnapshotTests(unittest.TestCase):
    """前端类型由提交的快照生成；路由一变而快照没跟上，就在这里失败。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.exporter = _load_exporter()
        cls.rendered = cls.exporter.render(cls.exporter.build_document())

    def test_committed_snapshot_matches_current_routes(self) -> None:
        snapshot = self.exporter.SNAPSHOT_PATH
        self.assertTrue(snapshot.is_file(), f"缺少 OpenAPI 快照；请运行 {self.exporter.REGENERATE_HINT}")
        self.assertEqual(
            snapshot.read_text(encoding="utf-8"),
            self.rendered,
            f"OpenAPI 快照已过期；请运行 {self.exporter.REGENERATE_HINT}",
        )

    def test_rendering_is_deterministic(self) -> None:
        again = self.exporter.render(self.exporter.build_document())
        self.assertEqual(again, self.rendered)
        self.assertTrue(self.rendered.endswith("}\n"))
        document = json.loads(self.rendered)
        self.assertEqual(list(document), sorted(document))

    def test_check_mode_reports_stale_snapshot(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as temporary:
            stale = Path(temporary) / "openapi.json"
            stale.write_text("{}\n", encoding="utf-8")
            self.assertEqual(self.exporter.main(["--check", "--output", str(stale)]), 1)
            self.assertEqual(self.exporter.main(["--output", str(stale)]), 0)
            self.assertEqual(self.exporter.main(["--check", "--output", str(stale)]), 0)
            self.assertEqual(stale.read_text(encoding="utf-8"), self.rendered)


if __name__ == "__main__":
    unittest.main()
