from __future__ import annotations

import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from gdl_backend.auth_adapters import (
    BrowserHost,
    BrowserOrchestrator,
    BrowserRuntimeAdapter,
    GalleryDlPixivOAuthAdapter,
)


class AuthAdapterTests(unittest.TestCase):
    def test_browser_orchestrator_owns_exact_argv_target_and_dispose_order(self):
        events: list[str] = []

        class Process:
            def __init__(self) -> None:
                self.returncode = None

            async def wait(self) -> int:
                events.append("process.wait")
                self.returncode = 0
                return 0

        async def spawn(*args, **kwargs):
            events.append("browser.spawn")
            self.spawn_args = args
            self.spawn_kwargs = kwargs
            return Process()

        async def terminate(process, timeout):
            events.append("browser.terminate")
            process.returncode = -1

        runtime = BrowserRuntimeAdapter(
            discover_chrome=lambda _explicit: Path("/fixture/chrome"),
            allocate_debug_port=lambda: 32123,
            spawn_process=spawn,
            read_browser_websocket=lambda _port: (32123, "ws://127.0.0.1:32123/devtools/browser/id"),
            open_login_target=lambda *_args: events.append("target.open") or "target-id",
            capture_pixiv_callback=lambda *_args, **_kwargs: events.append("callback.capture") or "callback",
            get_site_cookies=lambda *_args: events.append("cookies.read") or [{"name": "fixture"}],
            managed_login_ready=lambda *_args: events.append("login.ready") or True,
            close_target=lambda *_args: events.append("target.close"),
            close_browser=lambda *_args: events.append("browser.close"),
            write_netscape_cookies=lambda *_args: events.append("cookies.write"),
            terminate_process=terminate,
        )

        async def run(profile: Path) -> None:
            orchestrator = BrowserOrchestrator(
                profile_dir=profile,
                chrome_executable="",
                login_timeout_seconds=30,
                proxy_provider=lambda: "http://user:secret@127.0.0.1:7890",
                runtime=runtime,
            )
            host = await orchestrator.ensure_host()
            self.assertIs(host, orchestrator.host)
            self.assertNotIn("secret", repr(host))
            self.assertIn("--user-data-dir=" + str(profile), self.spawn_args)
            self.assertIn("--remote-debugging-port=32123", self.spawn_args)
            self.assertIn("--proxy-server=http://127.0.0.1:7890", self.spawn_args)
            self.assertNotIn("secret", " ".join(map(str, self.spawn_args)))
            self.assertEqual(self.spawn_args[-1], "about:blank")
            target = await orchestrator.open_target(host.websocket_url, "https://x.com/i/flow/login")
            await orchestrator.site_cookies(host.websocket_url, object())
            await orchestrator.login_ready(host.websocket_url, object(), target)
            await orchestrator.write_cookies(profile / "cookies.txt", [])
            await orchestrator.capture_pixiv_callback(
                host.websocket_url,
                target,
                "https://app-api.pixiv.net/web/v1/login?x=1",
                timeout=10,
            )
            await orchestrator.close_target(host.websocket_url, target)
            await orchestrator.stop()
            self.assertIsNone(orchestrator.host)

        with tempfile.TemporaryDirectory() as temporary:
            asyncio.run(run(Path(temporary) / "profile"))
        self.assertEqual(
            events,
            [
                "browser.spawn",
                "target.open",
                "cookies.read",
                "login.ready",
                "cookies.write",
                "callback.capture",
                "target.close",
                "browser.close",
                "process.wait",
            ],
        )

    def test_browser_monitor_never_projects_raw_third_party_failures(self):
        secret = "RAW_BROWSER_ADAPTER_SECRET"

        class Process:
            returncode = None

            async def wait(self) -> int:
                self.returncode = 0
                return 0

        process = Process()
        runtime = BrowserRuntimeAdapter(
            discover_chrome=lambda _explicit: Path("/fixture/chrome"),
            allocate_debug_port=lambda: 32123,
            spawn_process=AsyncMock(return_value=process),
            read_browser_websocket=lambda _port: (32123, "ws://browser"),
            open_login_target=lambda *_args: "target-id",
            capture_pixiv_callback=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                RuntimeError(
                    f"https://third-party.invalid/private/{secret} token={secret}"
                )
            ),
            get_site_cookies=lambda *_args: [],
            managed_login_ready=lambda *_args: False,
            close_target=lambda *_args: None,
            close_browser=lambda *_args: None,
            write_netscape_cookies=lambda *_args: None,
            terminate_process=AsyncMock(),
        )
        orchestrator = BrowserOrchestrator(
            profile_dir=Path("/unused/profile"),
            chrome_executable="",
            login_timeout_seconds=30,
            proxy_provider=lambda: "",
            runtime=runtime,
        )
        host = BrowserHost(
            process=process,
            profile_dir=Path("/unused/profile"),
            debug_port=32123,
            websocket_url="ws://browser",
        )
        session = SimpleNamespace(
            id="pixiv-adapter-failure",
            process=SimpleNamespace(returncode=None),
            created_at=time.time(),
            cache_file=Path("/unused/cache.sqlite3"),
            authorization_url="https://app-api.pixiv.net/web/v1/login?state=STATE",
            state="starting_browser",
            message="",
            error="",
            browser_websocket_url="",
            browser_target_id="",
        )

        async def run() -> None:
            await orchestrator.monitor_pixiv_session(
                session,
                login_timeout_seconds=30,
                authorization_lock=asyncio.Lock(),
                ensure_host=AsyncMock(return_value=host),
                is_current=lambda _session: True,
                complete_oauth=AsyncMock(),
                stop_oauth_process=AsyncMock(),
                cleanup_oauth_cache=lambda _path: None,
                controlled_error_message=lambda _exc: None,
                release_authorization=AsyncMock(),
            )

        asyncio.run(run())
        self.assertEqual(session.state, "failed")
        self.assertEqual(session.error, "Pixiv 共享浏览器授权失败")
        self.assertNotIn(secret, session.error)
        self.assertNotIn("third-party.invalid", session.error)

    def test_gallery_dl_oauth_adapter_owns_argv_pipes_output_and_code(self):
        class Stream:
            def __init__(self) -> None:
                self.values = [b"login-url", b""]

            async def read(self, size: int) -> bytes:
                self.read_size = size
                return self.values.pop(0)

        class Stdin:
            def __init__(self) -> None:
                self.value = b""
                self.closed = False

            def write(self, value: bytes) -> None:
                self.value += value

            async def drain(self) -> None:
                pass

            def close(self) -> None:
                self.closed = True

        class Process:
            def __init__(self) -> None:
                self.returncode = None
                self.stdout = Stream()
                self.stdin = Stdin()

            async def wait(self) -> int:
                self.returncode = 0
                return 0

        process = Process()
        spawn = AsyncMock(return_value=process)
        terminate = AsyncMock()
        adapter = GalleryDlPixivOAuthAdapter(
            python_executable="/fixture/python",
            repo_path=Path("/fixture/gallery-dl"),
            spawn_process=spawn,
            terminate_process=terminate,
        )

        async def run() -> None:
            returned = await adapter.start(
                Path("/private/oauth.sqlite3"),
                proxy_url="http://user:secret@127.0.0.1:7890",
            )
            self.assertIs(returned, process)
            chunks = [chunk async for chunk in adapter.output_chunks(process)]
            self.assertEqual(chunks, [b"login-url"])
            await adapter.submit_code(process, "CALLBACK-CODE")
            self.assertEqual(process.stdin.value, b"CALLBACK-CODE\n")
            self.assertTrue(process.stdin.closed)
            self.assertEqual(await adapter.wait(process, timeout=1), 0)
            await adapter.stop(process)

        asyncio.run(run())
        command = spawn.await_args.args
        self.assertEqual(command[:3], ("/fixture/python", "-m", "gallery_dl"))
        self.assertIn("--config-ignore", command)
        self.assertIn("extractor.oauth.browser=false", command)
        self.assertIn("extractor.oauth.input=true", command)
        self.assertIn("proxy=http://user:secret@127.0.0.1:7890", command)
        self.assertEqual(command[-1], "oauth:pixiv")
        self.assertEqual(spawn.await_args.kwargs["cwd"], "/fixture/gallery-dl")
        self.assertEqual(
            spawn.await_args.kwargs["env"]["PYTHONPATH"].split(__import__("os").pathsep)[0],
            "/fixture/gallery-dl",
        )
        terminate.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
