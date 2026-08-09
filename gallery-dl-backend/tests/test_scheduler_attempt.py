from __future__ import annotations

import inspect
import tempfile
import unittest
from pathlib import Path

from gdl_backend._scheduler_attempt import AttemptExecutor
from gdl_backend.database import Database
from gdl_backend.gallery import GalleryRunResult
from gdl_backend.log_writer import TaskLogWriter

from tests.helpers import make_settings
from tests.test_scheduler import FakeProxy, values


class InjectedArtifactCatalog:
    def __init__(self, artifact: Path, size: int):
        self.artifact = artifact
        self.artifact_size = size
        self.calls: list[tuple[str, object]] = []

    def scan(self, output_dir: str) -> tuple[int, int]:
        self.calls.append(("scan", output_dir))
        return 1, self.artifact_size

    def from_output(self, line: str, output_dir: str) -> Path | None:
        self.calls.append(("from_output", (line, output_dir)))
        return self.artifact

    def totals(self, paths) -> tuple[int, int]:
        materialized = tuple(paths)
        self.calls.append(("totals", materialized))
        return len(materialized), self.artifact_size

    def size(self, path: Path) -> int | None:
        self.calls.append(("size", path))
        return self.artifact_size


class EmittingGallery:
    def __init__(self):
        self.calls: list[dict] = []

    async def run(self, task_id: str, **kwargs):
        self.calls.append({"task_id": task_id, **kwargs})
        await kwargs["on_started"](321, "marker-task-1")
        await kwargs["on_line"]("stdout", "/virtual/output/image.jpg")
        return GalleryRunResult(0, "done", False, "marker-task-1", 321)


class AttemptExecutorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.settings = make_settings(self.root)
        self.db = Database(self.settings.database_path)
        self.log_writer = TaskLogWriter(self.db)

    async def asyncTearDown(self):
        await self.log_writer.stop()
        self.db.close()
        self.temp.cleanup()

    async def test_executor_uses_injected_boundaries_but_leaves_final_state_uncommitted(self):
        self.db.create_task(values(self.root, proxy_mode="direct", attempts=1))
        self.assertTrue(self.db.claim_task("task-1"))
        artifact = Path("/virtual/output/image.jpg")
        artifact_catalog = InjectedArtifactCatalog(artifact, size=17)
        gallery = EmittingGallery()
        executor = AttemptExecutor(
            self.db,
            gallery,
            FakeProxy(),
            self.log_writer,
            artifact_catalog=artifact_catalog,
            auth_failure_callback=None,
            is_stopping=lambda: False,
            monotonic_clock=lambda: 10.0,
        )

        result = await executor.execute("task-1")

        task = self.db.get_task("task-1")
        self.assertEqual(result.decision.error_class, "success")
        self.assertEqual(result.attempt_no, 1)
        self.assertEqual(task["status"], "running")
        self.assertEqual(task["latest_attempt"]["status"], "succeeded")
        self.assertEqual(task["artifact_count"], 1)
        self.assertEqual(task["artifact_bytes"], 17)
        self.assertEqual(len(gallery.calls), 1)
        self.assertIn(("size", artifact), artifact_catalog.calls)
        self.assertIn(("totals", (artifact,)), artifact_catalog.calls)

    def test_executor_contract_excludes_scheduler_ownership(self):
        parameters = inspect.signature(AttemptExecutor).parameters
        self.assertEqual(
            tuple(parameters),
            (
                "database",
                "gallery",
                "proxy",
                "log_writer",
                "artifact_catalog",
                "auth_failure_callback",
                "is_stopping",
                "monotonic_clock",
            ),
        )
        source = inspect.getsource(AttemptExecutor)
        for forbidden in (
            "claim_task(",
            "complete_task(",
            "requeue_task(",
            "_active",
            "_wake",
            "create_task(",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
