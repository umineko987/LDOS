from __future__ import annotations

import asyncio
import threading
import unittest

from gdl_backend.events import (
    HELLO_EVENT,
    JOB_EVENT,
    RESYNC_EVENT,
    BusEvent,
    EventBus,
    JobRegistry,
    StreamMarker,
)


class FakeClock:
    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


async def _take(stream, count: int, timeout: float = 2.0) -> list:
    items = []

    async def collect() -> None:
        async for item in stream:
            items.append(item)
            if len(items) >= count:
                return

    await asyncio.wait_for(collect(), timeout=timeout)
    return items


class EventBusTests(unittest.IsolatedAsyncioTestCase):
    async def test_fresh_subscriber_gets_hello_then_only_new_events(self) -> None:
        bus = EventBus(epoch="e1")
        bus.publish("before")
        stream = bus.stream()
        hello = await anext(stream)
        self.assertIsInstance(hello, StreamMarker)
        self.assertEqual(hello.kind, HELLO_EVENT)
        self.assertEqual(hello.id, "e1-1")
        bus.publish("after", {"n": 1})
        event = await asyncio.wait_for(anext(stream), timeout=2)
        self.assertIsInstance(event, BusEvent)
        self.assertEqual((event.kind, event.id, dict(event.data)), ("after", "e1-2", {"n": 1}))
        await stream.aclose()
        self.assertEqual(bus.subscriber_count, 0)

    async def test_publish_from_other_threads_wakes_async_subscriber_in_order(self) -> None:
        bus = EventBus(epoch="e1")
        stream = bus.stream()
        await anext(stream)  # hello
        self.assertEqual(bus.subscriber_count, 1)

        def worker(offset: int) -> None:
            for index in range(50):
                bus.publish("tick", {"worker": offset, "index": index})

        threads = [threading.Thread(target=worker, args=(n,)) for n in range(4)]
        for thread in threads:
            thread.start()
        items = await _take(stream, 200)
        for thread in threads:
            thread.join()
        sequences = [item.seq for item in items]
        self.assertEqual(sequences, list(range(1, 201)))
        for worker_id in range(4):
            indexes = [item.data["index"] for item in items if item.data["worker"] == worker_id]
            self.assertEqual(indexes, list(range(50)))
        await stream.aclose()

    async def test_replay_after_last_event_id(self) -> None:
        bus = EventBus(epoch="e1")
        for index in range(5):
            bus.publish("tick", {"index": index})
        stream = bus.stream("e1-2")
        items = await _take(stream, 3)
        self.assertEqual([item.id for item in items], ["e1-3", "e1-4", "e1-5"])
        await stream.aclose()

    async def test_overflowed_cursor_gets_resync_then_continues(self) -> None:
        bus = EventBus(epoch="e1", buffer_size=4)
        for index in range(10):
            bus.publish("tick", {"index": index})
        events, complete = bus.events_after(3)
        self.assertFalse(complete)
        self.assertEqual(events, [])
        stream = bus.stream("e1-3")
        resync = await anext(stream)
        self.assertIsInstance(resync, StreamMarker)
        self.assertEqual((resync.kind, resync.id, resync.reason), (RESYNC_EVENT, "e1-10", "buffer_overflow"))
        bus.publish("tick", {"index": 10})
        event = await asyncio.wait_for(anext(stream), timeout=2)
        self.assertEqual(event.id, "e1-11")
        await stream.aclose()

    async def test_cursor_at_buffer_edge_is_still_replayable(self) -> None:
        bus = EventBus(epoch="e1", buffer_size=4)
        for index in range(10):
            bus.publish("tick", {"index": index})
        events, complete = bus.events_after(6)
        self.assertTrue(complete)
        self.assertEqual([event.seq for event in events], [7, 8, 9, 10])

    async def test_foreign_or_future_cursor_is_resynced(self) -> None:
        bus = EventBus(epoch="e1")
        bus.publish("tick")
        for cursor in ("other-1", "e1-99", "garbage", "e1-x"):
            with self.subTest(cursor=cursor):
                stream = bus.stream(cursor)
                marker = await anext(stream)
                self.assertEqual((marker.kind, marker.reason), (RESYNC_EVENT, "unknown_cursor"))
                self.assertEqual(marker.id, "e1-1")
                await stream.aclose()

    async def test_close_ends_streams_and_drops_later_publishes(self) -> None:
        bus = EventBus(epoch="e1")
        stream = bus.stream()
        await anext(stream)

        async def drain() -> list:
            return [item async for item in stream]

        task = asyncio.create_task(drain())
        await asyncio.sleep(0.01)
        threading.Thread(target=bus.close).start()
        self.assertEqual(await asyncio.wait_for(task, timeout=2), [])
        self.assertIsNone(bus.publish("late"))
        self.assertEqual(bus.subscriber_count, 0)
        late = bus.stream()
        self.assertEqual([item async for item in late], [])
        bus.reopen()
        self.assertIsNotNone(bus.publish("again"))

    async def test_cancelled_subscriber_unregisters(self) -> None:
        bus = EventBus(epoch="e1")
        stream = bus.stream()
        await anext(stream)
        task = asyncio.create_task(anext(stream))
        await asyncio.sleep(0.01)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await stream.aclose()
        self.assertEqual(bus.subscriber_count, 0)


class JobRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        self.bus = EventBus(epoch="e1", clock=self.clock)
        self.jobs = JobRegistry(self.bus, clock=self.clock, min_publish_interval=1.0, retain_finished=2)

    def published(self) -> list[dict]:
        events, _ = self.bus.events_after(0)
        self.assertTrue(all(event.kind == JOB_EVENT for event in events))
        return [dict(event.data["job"]) for event in events]

    def test_lifecycle_publishes_job_updates_with_unified_shape(self) -> None:
        job = self.jobs.start("tagger.tag", "打标 3 张", job_id="tagger:1", total=3, ref={"dataset_id": "d1", "skip": None})
        self.assertEqual(
            set(job),
            {"id", "kind", "title", "status", "current", "total", "message", "ref", "started_at", "updated_at", "finished_at"},
        )
        self.assertEqual(job["ref"], {"dataset_id": "d1"})
        self.clock.now += 5
        self.jobs.update("tagger:1", current=1)
        self.clock.now += 5
        finished = self.jobs.finish("tagger:1", "succeeded", current=3)
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(finished["finished_at"], self.clock.now)
        self.assertEqual([item["status"] for item in self.published()], ["running", "running", "succeeded"])
        self.assertFalse(self.jobs.has_active())

    def test_progress_only_changes_are_throttled_and_flushed(self) -> None:
        self.jobs.start("gallery.export", "导出", job_id="export:1", total=100)
        self.clock.now += 0.1
        self.jobs.update("export:1", current=10)
        self.jobs.update("export:1", current=20, message="dir-a")
        self.assertEqual(len(self.published()), 1)
        self.assertTrue(self.jobs.has_pending_publish())
        self.assertEqual(self.jobs.flush(), 1)
        self.assertEqual(self.published()[-1]["current"], 20)
        self.assertFalse(self.jobs.has_pending_publish())
        # 到达总数、状态变化立即发布，不受节流。
        self.jobs.update("export:1", current=100)
        self.assertEqual(self.published()[-1]["current"], 100)
        self.jobs.update("export:1", status="failed", message="disk_full")
        self.assertEqual(self.published()[-1]["status"], "failed")

    def test_unchanged_update_does_not_publish_and_unknown_job_is_none(self) -> None:
        self.jobs.start("gallery.scan", "扫描", job_id="scan:1")
        self.clock.now += 10
        self.jobs.update("scan:1", message="")
        self.assertEqual(len(self.published()), 1)
        self.assertIsNone(self.jobs.update("missing", current=1))
        with self.assertRaises(ValueError):
            self.jobs.update("scan:1", status="exploded")  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            self.jobs.finish("scan:1", "running")  # type: ignore[arg-type]

    def test_list_puts_active_first_and_prunes_old_finished(self) -> None:
        for index in range(4):
            self.jobs.start("crawl.batch", f"b{index}", job_id=f"crawl:{index}")
            self.clock.now += 1
        for index in range(3):
            self.jobs.finish(f"crawl:{index}", "succeeded")
            self.clock.now += 1
        listed = [job["id"] for job in self.jobs.list()]
        self.assertEqual(listed, ["crawl:3", "crawl:2", "crawl:1"])
        self.assertIsNone(self.jobs.get("crawl:0"))
        self.assertEqual(self.jobs.active_ids(), {"crawl:3"})
        self.assertEqual(self.jobs.active_ids("tagger."), set())

    def test_restart_resets_terminal_job_with_same_id(self) -> None:
        self.jobs.start("models.install", "安装", job_id="models:dedup")
        self.jobs.finish("models:dedup", "failed", message="network")
        self.clock.now += 3
        restarted = self.jobs.start("models.install", "安装", job_id="models:dedup")
        self.assertEqual(restarted["status"], "running")
        self.assertIsNone(restarted["finished_at"])
        self.assertEqual(restarted["message"], "")
        self.assertEqual(restarted["started_at"], self.clock.now)


if __name__ == "__main__":
    unittest.main()
