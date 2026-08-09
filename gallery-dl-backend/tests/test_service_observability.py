from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from gdl_backend.app import ServiceContainer

from tests.helpers import make_settings


class ServiceContainerObservabilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.settings = make_settings(self.root)
        self.container = ServiceContainer(self.settings)

    async def asyncTearDown(self) -> None:
        health_task = self.container._health_task
        if health_task is not None and not health_task.done():
            self.container._stopping = True
            health_task.cancel()
            await asyncio.gather(health_task, return_exceptions=True)
        self.container._health_task = None
        self.container.db.close()
        self.temporary.cleanup()

    async def test_proxy_health_loop_rate_limits_failures_and_records_recovery(self) -> None:
        entered = [asyncio.Event() for _ in range(5)]
        releases = [asyncio.Event() for _ in range(4)]
        blocked = asyncio.Event()
        intervals: list[float] = []
        status_calls = 0
        sensitive_error = (
            "token=proxy-health-token-29078 Cookie=proxy-health-cookie-29078 "
            "proxy=http://proxy-user-29078:proxy-pass-29078@127.0.0.1:29078 "
            f"path={self.root / 'private' / 'proxy-sources.json'} "
            "task=https://tasks.example.invalid/gallery/29078 "
            "subscription=https://subscription.example.invalid/raw/29078 "
            "response=<html>third-party-raw-29078</html>"
        )
        real_sleep = asyncio.sleep

        async def controlled_sleep(delay: float) -> None:
            index = len(intervals)
            intervals.append(delay)
            if index < len(entered):
                entered[index].set()
            if index < len(releases):
                await releases[index].wait()
            else:
                await blocked.wait()
            await real_sleep(0)

        def flaky_status() -> dict[str, object]:
            nonlocal status_calls
            status_calls += 1
            if status_calls <= 3:
                raise RuntimeError(sensitive_error)
            return {"running": True}

        self.container.proxy.status = flaky_status
        self.container.proxy.probe = Mock(return_value={"healthy": 1})
        self.container._started = True
        self.container._stopping = False

        with (
            patch("gdl_backend.app.asyncio.sleep", new=controlled_sleep),
            self.assertLogs("gdl_backend.app", level="INFO") as captured,
        ):
            health_task = asyncio.create_task(self.container._proxy_health_loop())
            self.container._health_task = health_task
            try:
                await asyncio.wait_for(entered[0].wait(), timeout=1.0)
                releases[0].set()
                await asyncio.wait_for(entered[1].wait(), timeout=1.0)
                first = self.container.proxy_health_summary()
                self.assertEqual(first["state"], "degraded")
                self.assertTrue(first["running"])
                self.assertTrue(first["operational"])
                self.assertEqual(first["consecutive_failures"], 1)
                self.assertEqual(first["last_error_category"], "runtime_error")
                self.assertIsNotNone(first["last_error_at"])

                releases[1].set()
                await asyncio.wait_for(entered[2].wait(), timeout=1.0)
                releases[2].set()
                await asyncio.wait_for(entered[3].wait(), timeout=1.0)
                repeated = self.container.proxy_health_summary()
                self.assertEqual(repeated["consecutive_failures"], 3)

                releases[3].set()
                await asyncio.wait_for(entered[4].wait(), timeout=1.0)
                restored = self.container.proxy_health_summary()
                self.assertEqual(restored["state"], "running")
                self.assertEqual(restored["consecutive_failures"], 0)
                self.assertEqual(restored["last_error_category"], "runtime_error")
                self.assertIsNotNone(restored["last_error_at"])
                self.assertIsNotNone(restored["last_success_at"])
                self.assertIsNotNone(restored["last_recovery_at"])
            finally:
                self.container._stopping = True
                health_task.cancel()
                await asyncio.gather(health_task, return_exceptions=True)
                self.container._health_task = None

        self.assertEqual(intervals, [5.0] * 5)
        self.container.proxy.probe.assert_called_once_with()
        warnings = [line for line in captured.output if ":WARNING:" in line]
        recoveries = [line for line in captured.output if ":INFO:" in line]
        self.assertEqual(len(warnings), 1, captured.output)
        self.assertEqual(len(recoveries), 1, captured.output)
        serialized_logs = "\n".join(captured.output)
        for forbidden in (
            "proxy-health-token-29078",
            "proxy-health-cookie-29078",
            "proxy-user-29078",
            "proxy-pass-29078",
            str(self.root),
            "tasks.example.invalid",
            "subscription.example.invalid",
            "third-party-raw-29078",
        ):
            self.assertNotIn(forbidden, serialized_logs)

    async def test_proxy_health_loop_normal_stop_does_not_record_failure(self) -> None:
        entered = asyncio.Event()
        blocked = asyncio.Event()

        async def blocked_sleep(_delay: float) -> None:
            entered.set()
            await blocked.wait()

        self.container._started = True
        self.container._stopping = False
        with (
            patch("gdl_backend.app.asyncio.sleep", new=blocked_sleep),
            self.assertNoLogs("gdl_backend.app", level="WARNING"),
        ):
            health_task = asyncio.create_task(self.container._proxy_health_loop())
            self.container._health_task = health_task
            await asyncio.wait_for(entered.wait(), timeout=1.0)
            self.container._stopping = True
            health_task.cancel()
            await asyncio.gather(health_task, return_exceptions=True)
            self.container._health_task = None

        health = self.container.proxy_health_summary()
        self.assertEqual(health["state"], "stopped")
        self.assertFalse(health["running"])
        self.assertTrue(health["operational"])
        self.assertEqual(health["consecutive_failures"], 0)
        self.assertIsNone(health["last_error_category"])
        self.assertIsNone(health["last_error_at"])
        self.assertIsNone(health["last_recovery_at"])

    async def test_proxy_stop_failure_warns_safely_and_shutdown_continues(self) -> None:
        health_started = asyncio.Event()

        async def health_worker() -> None:
            health_started.set()
            await asyncio.Event().wait()

        health_task = asyncio.create_task(health_worker())
        await asyncio.wait_for(health_started.wait(), timeout=1.0)
        self.container._health_task = health_task
        self.container._started = True
        self.container.reviews.stop = AsyncMock()
        self.container.ordered_crawls.stop = AsyncMock()
        self.container.scheduler.stop = AsyncMock()
        self.container.auth.stop = AsyncMock()
        real_close = self.container.db.close
        self.container.db.close = Mock(wraps=real_close)
        sensitive_error = (
            "token=proxy-stop-token-29079 Cookie=proxy-stop-cookie-29079 "
            "proxy=http://proxy-user-29079:proxy-pass-29079@127.0.0.1:29079 "
            f"path={self.root / 'private' / 'shutdown.log'} "
            "task=https://tasks.example.invalid/gallery/29079 "
            "subscription=https://subscription.example.invalid/raw/29079 "
            "response=<html>third-party-raw-29079</html>"
        )
        self.container.proxy.stop = Mock(side_effect=RuntimeError(sensitive_error))

        with self.assertLogs("gdl_backend.app", level="WARNING") as captured:
            await self.container.stop()

        self.container.reviews.stop.assert_awaited_once_with()
        self.container.ordered_crawls.stop.assert_awaited_once_with()
        self.container.scheduler.stop.assert_awaited_once_with()
        self.container.auth.stop.assert_awaited_once_with()
        self.container.proxy.stop.assert_called_once_with(force=True)
        self.container.db.close.assert_called_once_with()
        self.assertFalse(self.container._started)
        self.assertIsNone(self.container._health_task)
        self.assertTrue(health_task.done())
        self.assertEqual(len(captured.output), 1, captured.output)
        warning = captured.output[0]
        self.assertIn("runtime_error", warning)
        for forbidden in (
            "proxy-stop-token-29079",
            "proxy-stop-cookie-29079",
            "proxy-user-29079",
            "proxy-pass-29079",
            str(self.root),
            "tasks.example.invalid",
            "subscription.example.invalid",
            "third-party-raw-29079",
        ):
            self.assertNotIn(forbidden, warning)


if __name__ == "__main__":
    unittest.main()
