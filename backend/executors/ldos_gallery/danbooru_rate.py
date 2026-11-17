"""One Danbooru metadata request per second, shared with the Go runtime."""
from __future__ import annotations

from contextlib import contextmanager
from email.utils import parsedate_to_datetime
import fcntl
import os
from pathlib import PurePosixPath
import time
from urllib.parse import urlsplit


ENVIRONMENT = "GDL_DANBOORU_RATE_FILE"
INTERVAL_NS = 1_000_000_000
_MEDIA_SUFFIXES = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".jxl", ".webm",
    ".mp4", ".zip", ".swf", ".css", ".js", ".woff", ".woff2", ".ico",
}


class RateLimitError(RuntimeError):
    """Local limiter configuration/state error, never a proxy failure."""


_last_activity = 0.0


def _touch_activity():
    global _last_activity
    now = time.monotonic()
    if now - _last_activity < 1.0:
        return
    _last_activity = now
    path = os.environ.get("GDL_ACTIVITY_FILE")
    if path:
        try:
            # Only refresh an existing transfer heartbeat, never its started marker.
            os.utime(path, None)
        except OSError:
            pass


def _sleep(seconds):
    until = time.monotonic() + seconds
    while True:
        _touch_activity()
        remaining = until - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 1.0))


def _patch_extractor_waits():
    # gallery-dl can also wait locally after a 429. Keep its logging and retry
    # semantics, while bridging the same watchdog during those Danbooru waits.
    from gallery_dl.extractor.common import Extractor
    from functools import wraps
    from threading import Event, Thread

    def wrap(original):
        @wraps(original)
        def wrapped(self, *args, **kwargs):
            if self.category != "danbooru" or not os.environ.get("GDL_ACTIVITY_FILE"):
                return original(self, *args, **kwargs)
            stop = Event()

            def heartbeat():
                while not stop.is_set():
                    _touch_activity()
                    stop.wait(1.0)

            thread = Thread(target=heartbeat, daemon=True)
            thread.start()
            try:
                return original(self, *args, **kwargs)
            finally:
                stop.set()
                thread.join()

        return wrapped

    Extractor.wait = wrap(Extractor.wait)
    Extractor.sleep = wrap(Extractor.sleep)


@contextmanager
def _locked(path):
    try:
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(fd, "r+b") as state:
            while True:
                try:
                    fcntl.flock(state, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    # No flock is held while waiting. SIGTERM from the parent
                    # cancels both lock contention and cooldown sleeps.
                    _sleep(0.025)
            try:
                yield state
            finally:
                fcntl.flock(state, fcntl.LOCK_UN)
    except (OSError, ValueError) as exc:
        raise RateLimitError("Danbooru local throttle configuration error") from exc


def _read_next(state):
    raw = state.read(64).strip()
    return int(raw) if raw else 0


def _write_next(state, next_ns):
    state.seek(0)
    state.write(f"{next_ns}\n".encode("ascii"))
    state.truncate()
    state.flush()


def wait(path):
    while True:
        with _locked(path) as state:
            next_ns = _read_next(state)
            now_ns = time.time_ns()
            delay_ns = next_ns - now_ns
            if delay_ns <= 0:
                _write_next(state, now_ns + INTERVAL_NS)
        if delay_ns <= 0:
            return
        _sleep(delay_ns / INTERVAL_NS)


def retry_after(value, now_ns):
    value = (value or "").strip()
    try:
        seconds = int(value)
        if 0 <= seconds <= (2**63 - 1) // INTERVAL_NS:
            return now_ns + max(INTERVAL_NS, seconds * INTERVAL_NS)
    except ValueError:
        pass
    try:
        until = int(parsedate_to_datetime(value).timestamp() * INTERVAL_NS)
        return max(now_ns + INTERVAL_NS, until)
    except (ValueError, TypeError, OverflowError):
        return now_ns + INTERVAL_NS


def cooldown(path, value):
    until = retry_after(value, time.time_ns())
    with _locked(path) as state:
        _write_next(state, max(_read_next(state), until))


def is_metadata_url(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or parsed.hostname != "danbooru.donmai.us":
        return False
    path = parsed.path.lower()
    if path.startswith(("/data/", "/assets/", "/original/", "/sample/", "/preview/")):
        return False
    return PurePosixPath(path).suffix not in _MEDIA_SUFFIXES


def apply_patch():
    path = os.environ.get(ENVIRONMENT)
    if not path:
        return False
    from requests import Session
    from gallery_dl.exception import InputError

    original = Session.send
    if getattr(original, "_ldos_danbooru_rate", False):
        return True

    def send(self, request, **kwargs):
        try:
            limited = is_metadata_url(request.url)
            if limited:
                wait(path)
            response = original(self, request, **kwargs)
            # Session.send may follow a redirect to a CDN. Only a response from
            # Danbooru metadata/API may extend the shared cooldown.
            if limited and response.status_code == 429 and is_metadata_url(response.url):
                cooldown(path, response.headers.get("Retry-After", ""))
            return response
        except RateLimitError as exc:
            # Exit bit 32 gives the parent an explicit nonretryable local
            # configuration failure, even if earlier output mentioned a 429.
            raise InputError(str(exc)) from None

    send._ldos_danbooru_rate = True
    Session.send = send
    _patch_extractor_waits()
    return True
