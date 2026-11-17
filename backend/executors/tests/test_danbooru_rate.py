from __future__ import annotations

from email.utils import formatdate
import fcntl
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import sitecustomize  # Keep executor tests offline.

EXECUTORS = Path(__file__).resolve().parents[1]
GALLERY_ROOT = EXECUTORS.parents[1] / "gallery-dl-codeberg"
sys.path[:0] = [str(EXECUTORS), str(GALLERY_ROOT)]

import requests
from gallery_dl.extractor.common import Extractor
from gallery_dl.exception import InputError
from ldos_gallery import danbooru_rate as rate, worker_patches


class StubAdapter(requests.adapters.BaseAdapter):
    def __init__(self, statuses=(200,)):
        self.statuses = list(statuses)
        self.starts = []

    def send(self, request, **kwargs):
        self.starts.append((request.url, time.monotonic()))
        status = self.statuses.pop(0) if self.statuses else 200
        response = requests.Response()
        response.status_code = status
        response.url = request.url
        response.request = request
        response._content = b"[]"
        if status == 429:
            response.headers["Retry-After"] = "2"
        return response

    def close(self):
        pass


class DanbooruRateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.path = self.root / "danbooru-rate.lock"
        self.env = {rate.ENVIRONMENT: str(self.path), "GDL_ACTIVITY_FILE": ""}
        env = patch.dict(os.environ, self.env)
        env.start()
        self.addCleanup(env.stop)
        for cls, name in ((requests.Session, "send"), (Extractor, "wait"), (Extractor, "sleep")):
            restore = patch.object(cls, name, getattr(cls, name))
            restore.start()
            self.addCleanup(restore.stop)

    def session(self, statuses=(200,)):
        session = requests.Session()
        session.trust_env = False
        adapter = StubAdapter(statuses)
        session.mount("https://", adapter)
        self.addCleanup(session.close)
        return session, adapter

    def test_patch_runs_at_session_send_and_is_idempotent(self):
        worker_patches.apply_all()
        send = requests.Session.send
        self.assertTrue(rate.apply_patch())
        self.assertIs(requests.Session.send, send)
        session, adapter = self.session()
        for url in (
            "https://danbooru.donmai.us/posts.json",
            "https://cdn.donmai.us/original/a.jpg",
            "https://danbooru.donmai.us/data/a.jpg",
            "https://other.example/posts.json",
            "https://danbooru.donmai.us/artists.json",
        ):
            session.send(requests.Request("GET", url).prepare())
        starts = adapter.starts
        self.assertLess(starts[3][1] - starts[0][1], 0.5)
        self.assertGreaterEqual(starts[4][1] - starts[0][1], 0.95)

    def test_gallery_dl_internal_retry_is_throttled(self):
        from gallery_dl import extractor

        rate.apply_patch()
        session, adapter = self.session((429, 200))
        instance = extractor.find("https://danbooru.donmai.us/posts?tags=example")
        # Initialize only upstream request options: no site login or external I/O.
        instance._init_options()
        instance._interval_retry = lambda tries: 0
        instance._interval_request = None
        instance._interval_429 = lambda tries: 0
        with patch.object(instance, "wait"), patch.object(instance, "sleep"):
            response = instance.request(
                "https://danbooru.donmai.us/posts.json", session=session,
                retries=1, interval=False,
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(adapter.starts), 2)
        self.assertGreaterEqual(adapter.starts[1][1] - adapter.starts[0][1], 1.95)

    def test_only_main_site_metadata_is_limited(self):
        for url in (
            "https://danbooru.donmai.us/posts.json?tags=example",
            "https://danbooru.donmai.us/posts/123",
            "https://danbooru.donmai.us/artists.json",
            "https://danbooru.donmai.us/autocomplete.json",
        ):
            self.assertTrue(rate.is_metadata_url(url), url)
        for url in (
            "https://cdn.donmai.us/original/a.jpg",
            "https://danbooru.donmai.us/data/a.jpg",
            "https://danbooru.donmai.us/assets/application.js",
            "https://danbooru.donmai.us/a.webp",
            "https://safebooru.donmai.us/posts.json",
            "https://example.org/posts.json",
            "https://danbooru.donmai.us.example.org/posts.json",
        ):
            self.assertFalse(rate.is_metadata_url(url), url)

    def test_retry_after_seconds_date_default_and_maximum(self):
        now = 1_800_000_000 * rate.INTERVAL_NS
        for value, seconds in (("", 1), ("bad", 1), ("-1", 1), ("0", 1), ("2", 2)):
            self.assertEqual(rate.retry_after(value, now), now + seconds * rate.INTERVAL_NS)
        self.assertEqual(rate.retry_after(formatdate(now / rate.INTERVAL_NS + 5, usegmt=True), now), now + 5 * rate.INTERVAL_NS)
        self.assertEqual(rate.retry_after(formatdate(now / rate.INTERVAL_NS - 5, usegmt=True), now), now + rate.INTERVAL_NS)
        rate.cooldown(self.path, "30")
        with self.path.open() as state:
            before = state.read()
        rate.cooldown(self.path, "")
        with self.path.open() as state:
            self.assertEqual(before, state.read())

    def test_waiting_caller_rechecks_extended_cooldown_without_holding_lock(self):
        rate.wait(self.path)
        real_sleep = rate._sleep
        extended = False

        def extend_once(seconds):
            nonlocal extended
            if not extended:
                # This must acquire immediately, proving wait released flock.
                rate.cooldown(self.path, "2")
                extended = True
            real_sleep(seconds)

        start = time.monotonic()
        with patch.object(rate, "_sleep", side_effect=extend_once):
            rate.wait(self.path)
        self.assertGreaterEqual(time.monotonic() - start, 1.95)

    def test_local_file_and_lock_errors_stop_before_http(self):
        for path in (self.root, self.root / "missing" / "state"):
            with self.subTest(path=path), self.assertRaisesRegex(rate.RateLimitError, "local throttle configuration"):
                rate.wait(path)
        self.path.write_text("invalid\n")
        with self.assertRaises(rate.RateLimitError):
            rate.cooldown(self.path, "1")
        self.path.unlink()
        rate.apply_patch()
        session, adapter = self.session()
        with patch.object(fcntl, "flock", side_effect=PermissionError("lock denied")):
            with self.assertRaisesRegex(InputError, "local throttle configuration") as failure:
                session.get("https://danbooru.donmai.us/posts.json")
        self.assertEqual(failure.exception.code, 32)
        self.assertEqual(adapter.starts, [])

    def test_shared_wait_and_upstream_retry_wait_keep_activity_alive(self):
        from gallery_dl import extractor

        activity = self.root / "activity"
        started = self.root / "started"
        activity.touch()
        os.utime(activity, (1, 1))
        os.environ["GDL_ACTIVITY_FILE"] = str(activity)
        os.environ["GDL_ACTIVITY_STARTED_FILE"] = str(started)
        rate._last_activity = 0
        rate.cooldown(self.path, "2")
        rate.wait(self.path)
        self.assertLess(time.time() - activity.stat().st_mtime, 1.2)
        self.assertFalse(started.exists())
        rate.apply_patch()
        instance = extractor.find("https://danbooru.donmai.us/posts?tags=example")
        instance.wait(seconds=1.1, adjust=0, reason=None)
        self.assertLess(time.time() - activity.stat().st_mtime, 1.2)

    def test_cancelled_worker_exits_during_cooldown_and_lock_contention(self):
        for held_lock in (False, True):
            with self.subTest(held_lock=held_lock):
                rate.cooldown(self.path, "60")
                with self.path.open("r+b") as state:
                    if held_lock:
                        fcntl.flock(state, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    env = dict(os.environ, PYTHONPATH=str(EXECUTORS), PYTHONDONTWRITEBYTECODE="1")
                    process = subprocess.Popen(
                        [sys.executable, "-c",
                         "import sys; from ldos_gallery import danbooru_rate as rate; "
                         "sleep=rate._sleep; rate._sleep=lambda seconds: "
                         "(print('waiting', flush=True), sleep(seconds))[1]; "
                         "rate.wait(sys.argv[1])", str(self.path)],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
                    )
                    self.addCleanup(lambda p=process: p.poll() is None and p.kill())
                    with selectors.DefaultSelector() as selector:
                        selector.register(process.stdout, selectors.EVENT_READ)
                        self.assertTrue(selector.select(timeout=3), "worker did not start")
                    self.assertEqual(process.stdout.readline().strip(), "waiting")
                    start = time.monotonic()
                    process.terminate()
                    _, stderr = process.communicate(timeout=2)
                    self.assertEqual(process.returncode, -signal.SIGTERM, stderr)
                    self.assertLess(time.monotonic() - start, 1)
                # The canceled worker left no flock behind.
                rate.cooldown(self.path, "1")


if __name__ == "__main__":
    unittest.main()
