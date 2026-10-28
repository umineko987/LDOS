from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode

from gdl_backend.app import ServiceContainer, create_app
from tests.helpers import local_test_client, make_settings

DESKTOP_ORIGIN = "http://127.0.0.1:5173"


class SseConnection:
    """直接驱动 ASGI 应用读取 SSE 流（TestClient 会把整个流缓冲到结束）。"""

    def __init__(self, app, port: int, *, query: dict[str, str] | None = None, headers: dict[str, str] | None = None):
        request_headers = {"host": f"127.0.0.1:{port}", "accept": "text/event-stream", **(headers or {})}
        self.scope = {
            "type": "http",
            # 与 uvicorn 一致：2.3 时 Starlette 并发监听 http.disconnect。
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/api/v1/events",
            "raw_path": b"/api/v1/events",
            "query_string": urlencode(query or {}).encode(),
            "root_path": "",
            "headers": [(key.lower().encode(), value.encode()) for key, value in request_headers.items()],
            "client": ("127.0.0.1", 50000),
            "server": ("127.0.0.1", port),
        }
        self.app = app
        self.status: int | None = None
        self.headers: dict[str, str] = {}
        self.ended = False
        self._buffer = ""
        self._chunks: asyncio.Queue[str | None] = asyncio.Queue()
        self._disconnect = asyncio.Event()
        self._request_sent = False
        self._task: asyncio.Task | None = None

    async def _receive(self):
        if not self._request_sent:
            self._request_sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await self._disconnect.wait()
        return {"type": "http.disconnect"}

    async def _send(self, message) -> None:
        if message["type"] == "http.response.start":
            self.status = message["status"]
            self.headers = {key.decode().lower(): value.decode() for key, value in message["headers"]}
        elif message["type"] == "http.response.body":
            if message.get("body"):
                await self._chunks.put(message["body"].decode())
            if not message.get("more_body", False):
                await self._chunks.put(None)

    async def __aenter__(self) -> SseConnection:
        self._task = asyncio.create_task(self.app(self.scope, self._receive, self._send))
        return self

    async def __aexit__(self, *exc) -> None:
        self._disconnect.set()
        await asyncio.wait_for(self._task, timeout=5)

    async def next_event(self, timeout: float = 5.0) -> dict | None:
        """下一个完整事件；流结束返回 None。跳过 keepalive 注释。"""

        async with asyncio.timeout(timeout):
            while True:
                if "\n\n" in self._buffer:
                    block, self._buffer = self._buffer.split("\n\n", 1)
                    event: dict = {}
                    for line in block.splitlines():
                        if line.startswith(":"):
                            continue
                        field, _, value = line.partition(":")
                        event[field] = value[1:] if value.startswith(" ") else value
                    if not event:
                        continue
                    if "data" in event:
                        event["data"] = json.loads(event["data"])
                    return event
                if self.ended:
                    return None
                chunk = await self._chunks.get()
                if chunk is None:
                    self.ended = True
                else:
                    self._buffer += chunk

    async def disconnect(self) -> None:
        self._disconnect.set()
        await asyncio.wait_for(self._task, timeout=5)


class JobsApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temp.name))
        self.settings.server.cors_origins = [DESKTOP_ORIGIN]
        self.container = ServiceContainer(self.settings)
        self.app = create_app(self.settings, container=self.container, start_background=False)
        self.port = self.settings.server.port

    async def asyncTearDown(self) -> None:
        self.container.events.close()
        await self.container.job_sampler.stop()
        await self.container.tagger.close()
        self.container.db.close()
        self.temp.cleanup()

    def connect(self, **kwargs) -> SseConnection:
        return SseConnection(self.app, self.port, **kwargs)

    async def wait_for_subscribers(self, count: int) -> None:
        async with asyncio.timeout(5):
            while self.container.events.subscriber_count != count:
                await asyncio.sleep(0.01)

    def test_jobs_endpoint_lists_jobs_with_cursor(self) -> None:
        self.container.jobs.start("tagger.tag", "打标 3 张", job_id="tagger:a", total=3, ref={"dataset_id": "ds1"})
        self.container.jobs.start("gallery.scan", "扫描 A", job_id="scan:s1")
        self.container.jobs.finish("scan:s1", "succeeded", message="1 张图片")
        with local_test_client(self.app, self.settings) as client:
            response = client.get("/api/v1/jobs")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["last_event_id"], self.container.events.last_event_id)
        self.assertEqual([item["id"] for item in payload["items"]], ["tagger:a", "scan:s1"])
        first = payload["items"][0]
        self.assertEqual(
            set(first),
            {"id", "kind", "title", "status", "current", "total", "message", "ref",
             "started_at", "updated_at", "finished_at"},
        )
        self.assertEqual((first["status"], first["total"], first["ref"]), ("running", 3, {"dataset_id": "ds1"}))
        self.assertEqual(payload["items"][1]["status"], "succeeded")

    async def test_stream_says_hello_then_delivers_job_updates(self) -> None:
        async with self.connect() as sse:
            hello = await sse.next_event()
            self.assertEqual(sse.status, 200)
            self.assertTrue(sse.headers["content-type"].startswith("text/event-stream"))
            self.assertEqual(sse.headers["cache-control"], "no-cache")
            self.assertEqual(hello["event"], "hello")
            self.assertEqual(hello["retry"], "2000")
            self.assertEqual(hello["data"], {"last_event_id": hello["id"], "reason": ""})
            self.assertEqual(hello["id"], self.container.events.last_event_id)

            await asyncio.to_thread(self.container.jobs.start, "tagger.tag", "打标", job_id="tagger:x")
            update = await sse.next_event()
            self.assertEqual(update["event"], "job.updated")
            self.assertEqual(update["data"]["job"]["id"], "tagger:x")
            self.assertEqual(update["id"], self.container.events.last_event_id)

    async def test_last_event_id_header_replays_missed_events(self) -> None:
        cursor = self.container.events.last_event_id
        self.container.jobs.start("tagger.tag", "打标", job_id="tagger:1")
        self.container.events.publish("dataset.updated", {"dataset_id": "ds1"})
        async with self.connect(headers={"Last-Event-ID": cursor}) as sse:
            first = await sse.next_event()
            second = await sse.next_event()
        self.assertEqual((first["event"], second["event"]), ("job.updated", "dataset.updated"))
        self.assertEqual(second["data"], {"dataset_id": "ds1"})
        self.assertEqual(second["id"], self.container.events.last_event_id)

    async def test_query_cursor_from_jobs_list_and_header_takes_precedence(self) -> None:
        cursor = self.container.events.last_event_id
        self.container.events.publish("dataset.updated", {"dataset_id": "ds1"})
        newer = self.container.events.last_event_id
        self.container.events.publish("dataset.updated", {"dataset_id": "ds2"})
        async with self.connect(query={"last_event_id": cursor}) as sse:
            self.assertEqual((await sse.next_event())["data"], {"dataset_id": "ds1"})
        async with self.connect(query={"last_event_id": cursor}, headers={"Last-Event-ID": newer}) as sse:
            self.assertEqual((await sse.next_event())["data"], {"dataset_id": "ds2"})

    async def test_foreign_cursor_asks_client_to_resync(self) -> None:
        async with self.connect(headers={"Last-Event-ID": "previous-process-42"}) as sse:
            event = await sse.next_event()
        self.assertEqual(event["event"], "resync")
        self.assertEqual(event["data"], {"last_event_id": self.container.events.last_event_id, "reason": "unknown_cursor"})

    async def test_stream_ends_promptly_when_bus_closes(self) -> None:
        async with self.connect() as sse:
            await sse.next_event()
            self.container.events.close()
            self.assertIsNone(await sse.next_event(timeout=2))
            self.assertTrue(sse.ended)
        self.assertEqual(self.container.events.subscriber_count, 0)

    async def test_client_disconnect_unregisters_subscriber(self) -> None:
        sse = self.connect()
        await sse.__aenter__()
        await sse.next_event()
        await self.wait_for_subscribers(1)
        await sse.disconnect()
        await self.wait_for_subscribers(0)

    async def test_desktop_origin_event_source_gets_cors_header(self) -> None:
        headers = {"Origin": DESKTOP_ORIGIN, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors"}
        async with self.connect(headers=headers) as sse:
            await sse.next_event()
        self.assertEqual(sse.status, 200)
        self.assertEqual(sse.headers["access-control-allow-origin"], DESKTOP_ORIGIN)

    async def test_unknown_origin_is_rejected(self) -> None:
        headers = {"Origin": "http://evil.example", "Sec-Fetch-Site": "cross-site"}
        async with self.connect(headers=headers) as sse:
            self.assertIsNone(await sse.next_event())
        self.assertEqual(sse.status, 403)


if __name__ == "__main__":
    unittest.main()
