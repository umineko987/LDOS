import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "run-python-coverage.py"
WEBUI_SCRIPT_PATH = ROOT / "scripts" / "run-webui-coverage.py"
SPEC = importlib.util.spec_from_file_location("run_python_coverage", SCRIPT_PATH)
COVERAGE_RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COVERAGE_RUNNER)
WEBUI_SPEC = importlib.util.spec_from_file_location(
    "run_webui_coverage", WEBUI_SCRIPT_PATH
)
WEBUI_COVERAGE_RUNNER = importlib.util.module_from_spec(WEBUI_SPEC)
WEBUI_SPEC.loader.exec_module(WEBUI_COVERAGE_RUNNER)
BASELINES = json.loads(
    (ROOT / "scripts" / "coverage-baselines.json").read_text(encoding="utf-8")
)


class CoverageMinimumProfileTests(unittest.TestCase):
    def test_windows_python_311_uses_its_measured_proxy_floor(self):
        minimum, profile = COVERAGE_RUNNER._minimum_for_environment(
            BASELINES["python"]["proxy"],
            system_name="Windows",
            python_version=(3, 11),
        )

        self.assertEqual(profile, "Windows-py3.11")
        self.assertEqual(minimum["line"], {"covered": 1662, "total": 2869})
        self.assertEqual(minimum["branch"], {"covered": 424, "total": 1096})

    def test_windows_python_314_uses_its_measured_proxy_floor(self):
        minimum, profile = COVERAGE_RUNNER._minimum_for_environment(
            BASELINES["python"]["proxy"],
            system_name="Windows",
            python_version=(3, 14),
        )

        self.assertEqual(profile, "Windows-py3.14")
        self.assertEqual(minimum["line"], {"covered": 1660, "total": 2869})
        self.assertEqual(minimum["branch"], {"covered": 424, "total": 1096})

    def test_linux_and_unmeasured_environments_keep_the_default_floor(self):
        for system_name, python_version in (
            ("Linux", (3, 11)),
            ("Linux", (3, 14)),
            ("Windows", (3, 12)),
        ):
            with self.subTest(system_name=system_name, python_version=python_version):
                minimum, profile = COVERAGE_RUNNER._minimum_for_environment(
                    BASELINES["python"]["proxy"],
                    system_name=system_name,
                    python_version=python_version,
                )
                self.assertEqual(profile, "default")
                self.assertEqual(
                    minimum,
                    BASELINES["python"]["proxy"]["minimum"],
                )

    def test_selected_minimum_is_a_defensive_copy(self):
        component = BASELINES["python"]["proxy"]
        minimum, _profile = COVERAGE_RUNNER._minimum_for_environment(
            component,
            system_name="Windows",
            python_version=(3, 11),
        )

        minimum["line"]["covered"] = 0

        self.assertEqual(
            component["minimum_by_environment"]["Windows-py3.11"]["minimum"]["line"]["covered"],
            1662,
        )

    def test_webui_staging_copies_only_release_docs_assets_and_stage5_fixtures(self):
        with tempfile.TemporaryDirectory() as temporary:
            staged = Path(temporary)
            WEBUI_COVERAGE_RUNNER._prepare_tree(staged)

            self.assertEqual(
                sorted(path.name for path in (staged / "docs").iterdir()),
                ["ARCHITECTURE.md", "gallery-dl-backend.md"],
            )
            self.assertEqual(
                sorted(path.name for path in (staged / "assets").iterdir()),
                ["example.json", "example.png"],
            )
            self.assertEqual(
                sorted(
                    str(path.relative_to(staged / "tests" / "fixtures" / "webui"))
                    for path in (staged / "tests" / "fixtures" / "webui").rglob("*")
                    if path.is_file()
                ),
                sorted(
                    str(path.relative_to(ROOT / "gallery-dl-backend" / "tests" / "fixtures" / "webui"))
                    for path in (ROOT / "gallery-dl-backend" / "tests" / "fixtures" / "webui").rglob("*")
                    if path.is_file()
                ),
            )
            self.assertEqual(
                sorted(path.name for path in (staged / "tests").glob("*.mjs")),
                sorted(
                    path.name
                    for path in (
                        *WEBUI_COVERAGE_RUNNER.SOURCE_TESTS,
                        *WEBUI_COVERAGE_RUNNER.SOURCE_TEST_SUPPORT,
                    )
                ),
            )


if __name__ == "__main__":
    unittest.main()
