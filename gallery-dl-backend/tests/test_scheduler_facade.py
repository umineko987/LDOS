from __future__ import annotations

import ast
import inspect
import tempfile
import textwrap
import unittest
from pathlib import Path

from gdl_backend._scheduler_attempt import AttemptResult
from gdl_backend.classifier import FailureDecision
from gdl_backend.database import Database
from gdl_backend.log_writer import TaskLogWriter
from gdl_backend.scheduler import TaskScheduler

from tests.helpers import make_settings
from tests.test_scheduler import FakeGallery, FakeProxy, values


class StubAttemptExecutor:
    def __init__(self, result: AttemptResult):
        self.result = result
        self.calls: list[str] = []

    async def execute(self, task_id: str) -> AttemptResult:
        self.calls.append(task_id)
        return self.result


class SchedulerFacadeTests(unittest.IsolatedAsyncioTestCase):
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

    async def test_execute_facade_delegates_but_scheduler_commits_final_state(self):
        self.db.create_task(values(self.root, proxy_mode="direct", attempts=1))
        self.assertTrue(self.db.claim_task("task-1"))
        stub = StubAttemptExecutor(
            AttemptResult(
                attempt_id="",
                attempt_no=0,
                task=None,
                policy=None,
                decision=FailureDecision(
                    "backend_error",
                    True,
                    False,
                    "controlled failure",
                ),
                exit_code=None,
                proxy_node_id=None,
            )
        )
        scheduler = TaskScheduler(
            self.db,
            FakeGallery([]),
            FakeProxy(),
            self.settings.scheduler,
            self.log_writer,
        )
        scheduler._attempt_executor = stub

        await scheduler._execute("task-1")

        self.assertEqual(stub.calls, ["task-1"])
        task = self.db.get_task("task-1")
        self.assertEqual(task["status"], "failed")
        self.assertEqual(task["last_error_class"], "backend_error")
        self.assertEqual(scheduler._active, {})

    def test_private_execute_facade_stays_thin_and_ownership_stays_local(self):
        execute_source = textwrap.dedent(inspect.getsource(TaskScheduler._execute))
        execute_node = ast.parse(execute_source).body[0]
        self.assertIsInstance(execute_node, ast.AsyncFunctionDef)
        self.assertEqual(len(execute_node.body), 2)
        self.assertIn("_attempt_executor.execute", execute_source)
        self.assertIn("_commit_attempt_result", execute_source)
        for forbidden in ("complete_task(", "requeue_task(", "finish_attempt("):
            self.assertNotIn(forbidden, execute_source)

        owner_source = inspect.getsource(TaskScheduler)
        for required in (
            "self._active",
            "self._wake",
            "claim_task(",
            "complete_task(",
            "requeue_task(",
            "asyncio.create_task(",
        ):
            with self.subTest(required=required):
                self.assertIn(required, owner_source)


if __name__ == "__main__":
    unittest.main()
