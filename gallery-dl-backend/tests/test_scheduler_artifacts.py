from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from gdl_backend._scheduler_artifacts import (
    ArtifactRecord,
    LocalArtifactCatalog,
    filter_artifact_records,
    is_complete_artifact_name,
    parse_artifact_output,
    summarize_artifact_records,
)


class SchedulerArtifactDecisionTests(unittest.TestCase):
    def test_stdout_path_parsing_is_lexical(self):
        absolute = Path(tempfile.gettempdir()).resolve() / "output" / "image.jpg"
        self.assertTrue(absolute.is_absolute())

        self.assertEqual(parse_artifact_output(str(absolute)), absolute)
        self.assertEqual(parse_artifact_output(f"# {absolute}"), absolute)
        self.assertIsNone(parse_artifact_output("relative/image.jpg"))
        self.assertIsNone(parse_artifact_output("  "))

    def test_name_and_scope_filter_uses_explicit_observations(self):
        root = Path("/resolved/output")
        records = (
            ArtifactRecord(root / "image.jpg", True, 10),
            ArtifactRecord(root / "image.jpg.part", True, 11),
            ArtifactRecord(root / ".gdl-activity-task", True, 12),
            ArtifactRecord(root / "directory", False, None),
            ArtifactRecord(Path("/resolved/other/image.jpg"), True, 13),
        )

        accepted = filter_artifact_records(records, resolved_root=root)

        self.assertEqual(accepted, (records[0],))
        self.assertTrue(is_complete_artifact_name("image.PART.jpg"))
        self.assertFalse(is_complete_artifact_name("image.JPG.PART"))
        self.assertFalse(is_complete_artifact_name(".gdl-activity-task"))

    def test_statistics_use_only_supplied_successful_file_facts(self):
        records = (
            ArtifactRecord(Path("one.jpg"), True, 3),
            ArtifactRecord(Path("two.jpg"), True, 5),
            ArtifactRecord(Path("missing.jpg"), False, None),
            ArtifactRecord(Path("stat-failed.jpg"), True, None),
        )

        self.assertEqual(summarize_artifact_records(records), (2, 8))
        self.assertEqual(records[0].size, 3)


class LocalArtifactCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.catalog = LocalArtifactCatalog()

    def tearDown(self):
        self.temp.cleanup()

    def test_filesystem_boundary_enumerates_and_filters_before_statistics(self):
        output = self.root / "output"
        nested = output / "nested"
        nested.mkdir(parents=True)
        artifact = nested / "image.jpg"
        artifact.write_bytes(b"image")
        (output / "image.jpg.part").write_bytes(b"partial")
        (output / ".gdl-activity-task").write_bytes(b"activity")

        self.assertEqual(self.catalog.scan(str(output)), (1, len(b"image")))
        self.assertEqual(
            self.catalog.from_output(f"# {artifact}", str(output)),
            artifact.resolve(),
        )
        self.assertEqual(
            self.catalog.totals((artifact.resolve(),)),
            (1, len(b"image")),
        )
        self.assertEqual(self.catalog.size(artifact.resolve()), len(b"image"))

    def test_filesystem_boundary_rejects_out_of_scope_and_missing_paths(self):
        output = self.root / "output"
        output.mkdir()
        outside = self.root / "outside.jpg"
        outside.write_bytes(b"outside")

        self.assertIsNone(self.catalog.from_output(str(outside), str(output)))
        self.assertIsNone(
            self.catalog.from_output(str(output / "missing.jpg"), str(output))
        )
        self.assertIsNone(self.catalog.from_output("relative.jpg", str(output)))
        self.assertEqual(self.catalog.scan(str(self.root / "missing")), (0, 0))


if __name__ == "__main__":
    unittest.main()
