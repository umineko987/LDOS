from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace

from gdl_backend.events import EventBus, JobRegistry
from gdl_backend.job_sampler import (
    CrawlBatchSource,
    DirectoryExportSource,
    JobSampler,
    ModelInstallSource,
    ReviewSource,
    default_job_sources,
)


class FakeCrawlDb:
    def __init__(self) -> None:
        self.batches: dict[str, dict] = {}
        self.queries = 0

    def active_crawl_batch_ids(self) -> list[str]:
        self.queries += 1
        return [
            batch_id
            for batch_id, batch in self.batches.items()
            if batch["status"] in {"queued", "running", "cancelling"}
        ]

    def list_crawl_batches(self, *, limit: int = 50, offset: int = 0) -> list[dict]:
        return list(self.batches.values())[:limit]

    def get_crawl_batch(self, batch_id: str) -> dict | None:
        return self.batches.get(batch_id)


def _batch(batch_id: str, status: str, *, total: int = 4, succeeded: int = 0, failed: int = 0) -> dict:
    return {
        "id": batch_id,
        "status": status,
        "task_count": total,
        "succeeded_task_count": succeeded,
        "failed_task_count": failed,
        "cancelled_task_count": 0,
        "last_error": "",
    }


class CountingSource:
    name = "counting"

    def __init__(self, active: bool) -> None:
        self.active = active
        self.samples = 0

    def is_active(self) -> bool:
        return self.active

    def sample(self, jobs: JobRegistry) -> None:
        self.samples += 1


class JobSamplerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.bus = EventBus(epoch="e1")
        self.jobs = JobRegistry(self.bus, min_publish_interval=0.0)

    async def test_tick_requires_a_connected_client_and_an_active_source(self) -> None:
        idle, busy = CountingSource(False), CountingSource(True)
        sampler = JobSampler(self.bus, self.jobs, [idle, busy])
        self.assertFalse(await sampler.tick())
        self.assertEqual(busy.samples, 0)

        stream = self.bus.stream()
        await anext(stream)
        self.assertTrue(await sampler.tick())
        self.assertEqual((idle.samples, busy.samples), (0, 1))
        busy.active = False
        self.assertFalse(await sampler.tick())
        self.assertEqual(busy.samples, 1)
        await stream.aclose()

    async def test_refresh_samples_without_clients_and_flushes_throttled_progress(self) -> None:
        jobs = JobRegistry(self.bus, min_publish_interval=60.0)
        jobs.start("tagger.tag", "打标", job_id="tagger:1", total=10)
        jobs.update("tagger:1", current=3)
        busy = CountingSource(True)
        sampler = JobSampler(self.bus, jobs, [busy])
        await sampler.refresh()
        self.assertEqual(busy.samples, 1)
        self.assertFalse(jobs.has_pending_publish())

    async def test_failing_source_does_not_stop_other_sources(self) -> None:
        class Broken(CountingSource):
            def sample(self, jobs: JobRegistry) -> None:
                raise RuntimeError("boom")

        ok = CountingSource(True)
        sampler = JobSampler(self.bus, self.jobs, [Broken(True), ok])
        with self.assertLogs("gdl_backend.job_sampler", level="WARNING"):
            await sampler.refresh()
        self.assertEqual(ok.samples, 1)

    async def test_loop_starts_and_stops(self) -> None:
        busy = CountingSource(True)
        sampler = JobSampler(self.bus, self.jobs, [busy], interval=0.05)
        stream = self.bus.stream()
        await anext(stream)
        sampler.start()
        for _ in range(100):
            if busy.samples >= 2:
                break
            await asyncio.sleep(0.01)
        await sampler.stop()
        self.assertGreaterEqual(busy.samples, 2)
        await stream.aclose()


class CrawlBatchSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.jobs = JobRegistry(EventBus(epoch="e1"), min_publish_interval=0.0)
        self.db = FakeCrawlDb()
        self.scheduler = SimpleNamespace(_active={})
        self.ordered = SimpleNamespace(_batch_tasks={})
        self.source = CrawlBatchSource(self.db, self.scheduler, self.ordered)

    def test_activity_is_read_from_memory_only(self) -> None:
        self.assertFalse(self.source.is_active())
        self.assertEqual(self.db.queries, 0)
        self.ordered._batch_tasks["b1"] = object()
        self.assertTrue(self.source.is_active())

    def test_batches_map_to_jobs_and_are_finalized_when_they_leave_the_active_set(self) -> None:
        self.db.batches["b1"] = _batch("b1", "running", total=4, succeeded=1)
        self.source.sample(self.jobs)
        job = self.jobs.get("crawl:b1")
        self.assertEqual((job["kind"], job["status"], job["current"], job["total"]), ("crawl.batch", "running", 1, 4))
        self.assertEqual(job["ref"], {"batch_id": "b1"})

        self.db.batches["b1"] = _batch("b1", "completed_with_errors", total=4, succeeded=3, failed=1)
        self.assertTrue(self.source.is_active())  # 仍有未收尾的 Job
        self.source.sample(self.jobs)
        job = self.jobs.get("crawl:b1")
        self.assertEqual((job["status"], job["current"], job["message"]), ("failed", 4, "1 个任务失败"))
        self.assertFalse(self.source.is_active())

    def test_deleted_batch_is_cancelled(self) -> None:
        self.db.batches["b2"] = _batch("b2", "queued")
        self.source.sample(self.jobs)
        self.assertEqual(self.jobs.get("crawl:b2")["status"], "queued")
        del self.db.batches["b2"]
        self.source.sample(self.jobs)
        self.assertEqual(self.jobs.get("crawl:b2")["status"], "cancelled")


class ReviewSourceTests(unittest.TestCase):
    def test_current_review_runs_then_takes_repository_status(self) -> None:
        jobs = JobRegistry(EventBus(epoch="e1"), min_publish_interval=0.0)
        reviews: dict[str, dict] = {"r1": {"status": "analyzing", "total_image_count": 12, "error": ""}}
        repository = SimpleNamespace(get_crawl_review=reviews.get)
        manager = SimpleNamespace(_current_batch_id="r1", repository=repository)
        source = ReviewSource([manager, None], SimpleNamespace())
        self.assertTrue(source.is_active())
        source.sample(jobs)
        job = jobs.get("review:r1")
        self.assertEqual((job["kind"], job["status"], job["total"]), ("dedup.review", "running", 12))

        manager._current_batch_id = ""
        reviews["r1"] = {"status": "failed", "total_image_count": 12, "error": "worker crashed"}
        source.sample(jobs)
        job = jobs.get("review:r1")
        self.assertEqual((job["status"], job["message"]), ("failed", "worker crashed"))
        self.assertFalse(source.is_active())

    def test_requeued_review_stays_tracked_as_queued(self) -> None:
        jobs = JobRegistry(EventBus(epoch="e1"), min_publish_interval=0.0)
        reviews = {"r2": {"status": "analyzing", "total_image_count": 0, "error": ""}}
        manager = SimpleNamespace(_current_batch_id="r2", repository=SimpleNamespace(get_crawl_review=reviews.get))
        source = ReviewSource([manager], SimpleNamespace())
        source.sample(jobs)
        manager._current_batch_id = ""
        reviews["r2"]["status"] = "pending"
        source.sample(jobs)
        self.assertEqual(jobs.get("review:r2")["status"], "queued")
        self.assertTrue(source.is_active())
        reviews["r2"]["status"] = "ready"
        source.sample(jobs)
        self.assertEqual(jobs.get("review:r2")["status"], "succeeded")


class DirectoryExportSourceTests(unittest.TestCase):
    def test_export_progress_and_completion(self) -> None:
        jobs = JobRegistry(EventBus(epoch="e1"), min_publish_interval=0.0)
        operations = [{
            "operation_id": "op1", "state": "copying", "current_directory_name": "set-a",
            "copied_file_count": 3, "discovered_file_count": 9, "error_code": None,
        }, {
            "operation_id": "old", "state": "completed", "current_directory_name": None,
            "copied_file_count": 1, "discovered_file_count": 1, "error_code": None,
        }]
        exports = SimpleNamespace(
            has_active_operations=lambda: any(item["state"] == "copying" for item in operations),
            list_operations=lambda: [dict(item) for item in operations],
        )
        source = DirectoryExportSource(exports)
        self.assertTrue(source.is_active())
        source.sample(jobs)
        job = jobs.get("export:op1")
        self.assertEqual((job["status"], job["current"], job["total"], job["message"]), ("running", 3, 9, "set-a"))
        self.assertIsNone(jobs.get("export:old"))
        operations[0].update(state="completed", copied_file_count=9, current_directory_name=None)
        source.sample(jobs)
        self.assertEqual(jobs.get("export:op1")["status"], "succeeded")
        self.assertFalse(source.is_active())


class ModelInstallSourceTests(unittest.TestCase):
    def test_install_progress_then_failure(self) -> None:
        jobs = JobRegistry(EventBus(epoch="e1"), min_publish_interval=0.0)
        state = {"phase": "installing", "downloaded_bytes": 10, "expected_bytes": 100, "message": "下载 SSCD", "requested_models": ["sscd"]}
        setup = SimpleNamespace(_phase="installing", status=lambda: dict(state))
        source = ModelInstallSource(setup)
        self.assertTrue(source.is_active())
        source.sample(jobs)
        job = jobs.get("models:dedup")
        self.assertEqual((job["status"], job["current"], job["total"]), ("running", 10, 100))
        setup._phase = "failed"
        state.update(phase="failed", message="网络错误")
        source.sample(jobs)
        self.assertEqual((jobs.get("models:dedup")["status"], jobs.get("models:dedup")["message"]), ("failed", "网络错误"))
        self.assertFalse(source.is_active())


class DefaultSourcesTests(unittest.TestCase):
    def test_default_sources_cover_legacy_services(self) -> None:
        container = SimpleNamespace(
            db=FakeCrawlDb(),
            scheduler=SimpleNamespace(_active={}),
            ordered_crawls=SimpleNamespace(_batch_tasks={}),
            reviews=SimpleNamespace(_current_batch_id="", gallery_reviews=SimpleNamespace(_current_batch_id="")),
            gallery_directory_exports=SimpleNamespace(has_active_operations=lambda: False, list_operations=lambda: []),
            model_setup=SimpleNamespace(_phase="idle"),
        )
        sources = default_job_sources(container)
        self.assertEqual(
            [source.name for source in sources],
            ["crawl_batches", "reviews", "directory_exports", "model_setup"],
        )
        self.assertFalse(any(source.is_active() for source in sources))


if __name__ == "__main__":
    unittest.main()
