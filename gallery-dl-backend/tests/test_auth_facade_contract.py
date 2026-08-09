from __future__ import annotations

import asyncio
import inspect
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from gdl_backend import auth as auth_module
from gdl_backend.auth import (
    AuthManager,
    ManagedBrowserLoginSession,
    PixivOAuthSession,
)

from tests.helpers import make_settings


def _signature_shape(callable_object) -> list[tuple[str, inspect._ParameterKind, object]]:
    return [
        (name, parameter.kind, parameter.default)
        for name, parameter in inspect.signature(callable_object).parameters.items()
    ]


class AuthFacadeContractTests(unittest.TestCase):
    """Characterize the facade before moving its external-I/O collaborators."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temporary.name))
        self.auth = AuthManager(self.settings)

    def tearDown(self) -> None:
        asyncio.run(self.auth.stop())
        self.temporary.cleanup()

    def test_public_method_signatures_and_async_shape_are_stable(self):
        positional = inspect.Parameter.POSITIONAL_OR_KEYWORD
        keyword_only = inspect.Parameter.KEYWORD_ONLY
        empty = inspect.Parameter.empty
        expected = {
            "__init__": [("self", positional, empty), ("settings", positional, empty)],
            "status": [("self", positional, empty), ("site", positional, empty)],
            "statuses": [("self", positional, empty)],
            "credentials_for": [("self", positional, empty), ("site", positional, empty)],
            "browser_profile_status": [("self", positional, empty)],
            "authorization_proxy": [("self", positional, empty)],
            "proxy_status": [("self", positional, empty)],
            "browser_login_session": [
                ("self", positional, empty),
                ("site", positional, empty),
                ("session_id", positional, empty),
            ],
            "managed_credentials_available": [
                ("self", positional, empty),
                ("site", positional, empty),
                ("cookies_file", positional, empty),
            ],
            "set_authorization_proxy": [
                ("self", positional, empty),
                ("value", positional, empty),
            ],
            "clear_authorization_proxy": [("self", positional, empty)],
            "start_browser_login": [
                ("self", positional, empty),
                ("site", positional, empty),
            ],
            "cancel_browser_login": [
                ("self", positional, empty),
                ("site", positional, empty),
                ("session_id", positional, empty),
            ],
            "invalidate_if_managed": [
                ("self", positional, empty),
                ("site", positional, empty),
                ("cookies_file", positional, empty),
                ("message", positional, empty),
            ],
            "start_pixiv_oauth": [("self", positional, empty)],
            "clear": [("self", positional, empty), ("site", positional, empty)],
            "cancel_pixiv_oauth": [("self", positional, empty)],
            "clear_browser_profile": [("self", positional, empty)],
            "stop": [("self", positional, empty)],
        }
        del keyword_only  # Documents that the public auth facade has no keyword-only arguments.
        async_methods = {
            "set_authorization_proxy",
            "clear_authorization_proxy",
            "start_browser_login",
            "cancel_browser_login",
            "invalidate_if_managed",
            "start_pixiv_oauth",
            "clear",
            "cancel_pixiv_oauth",
            "clear_browser_profile",
            "stop",
        }
        for name, shape in expected.items():
            with self.subTest(method=name):
                method = getattr(AuthManager, name)
                self.assertEqual(_signature_shape(method), shape)
                self.assertEqual(inspect.iscoroutinefunction(method), name in async_methods)

    def test_legacy_status_and_credential_dtos_keep_exact_key_allowlists(self):
        payload = self.auth.statuses()
        self.assertEqual(
            set(payload),
            {
                "items",
                "browser_profile",
                "authorization_proxy",
                "managed",
                "secrets_exposed",
            },
        )
        self.assertEqual(
            set(payload["browser_profile"]),
            {"shared", "present", "running", "resetting", "sites"},
        )
        self.assertEqual(
            set(payload["authorization_proxy"]),
            {
                "proxy_url",
                "source",
                "config_proxy_url",
                "credentials_redacted",
                "browser_running",
                "browser_proxy_url",
                "restart_pending",
                "updated_at",
            },
        )
        by_site = {item["site"]: item for item in payload["items"]}
        self.assertEqual(
            set(by_site["danbooru"]),
            {"site", "label", "method", "state", "authorized", "summary", "actions"},
        )
        self.assertEqual(set(by_site["pawchive"]), set(by_site["danbooru"]))
        self.assertEqual(
            set(by_site["pixiv"]),
            {
                "site",
                "label",
                "method",
                "state",
                "authorized",
                "summary",
                "browser",
                "profile",
                "updated_at",
                "oauth",
                "actions",
            },
        )
        for site in ("twitter", "exhentai"):
            self.assertEqual(
                set(by_site[site]),
                {
                    "site",
                    "label",
                    "method",
                    "state",
                    "authorized",
                    "summary",
                    "cookies",
                    "browser",
                    "profile",
                    "updated_at",
                    "invalidated_at",
                    "invalid_reason",
                    "login",
                    "actions",
                },
            )
            self.assertEqual(
                set(by_site[site]["cookies"]),
                {
                    "present",
                    "valid",
                    "cookie_count",
                    "required_present",
                    "missing",
                    "updated_at",
                },
            )
        self.assertEqual(
            self.auth.credentials_for("unknown"),
            {"cookies_file": None, "config_file": None, "credentials_ref": None},
        )

    def test_managed_browser_writes_private_cookie_before_metadata_then_disposes(self):
        events: list[str] = []
        original_cookie_writer = auth_module.write_netscape_cookies
        original_update_metadata = self.auth._update_metadata

        class BrowserProcess:
            def __init__(self) -> None:
                self.returncode = None

            async def wait(self) -> int:
                events.append("process.wait")
                self.returncode = 0
                return 0

        cookies = [
            {
                "domain": ".x.com",
                "path": "/",
                "secure": True,
                "expires": time.time() + 3600,
                "name": "auth_token",
                "value": "AUTH_CONTRACT_SECRET",
            },
            {
                "domain": ".x.com",
                "path": "/",
                "secure": True,
                "expires": time.time() + 3600,
                "name": "ct0",
                "value": "CSRF_CONTRACT_SECRET",
            },
        ]

        def write_cookie(path: Path, values) -> None:
            events.append("credential.write")
            original_cookie_writer(path, values)

        def update_metadata(site: str, value) -> None:
            events.append("metadata.write")
            self.assertTrue(self.auth._cookie_path(site).is_file())
            original_update_metadata(site, value)

        async def release_authorization(session_id: str) -> None:
            events.append("authorization.release")
            if self.auth._active_authorization_id == session_id:
                self.auth._active_authorization_id = ""

        async def run() -> str:
            spawn = AsyncMock(side_effect=lambda *_args, **_kwargs: BrowserProcess())
            with (
                patch("gdl_backend.auth.discover_chrome_executable", return_value=Path("chrome")),
                patch("gdl_backend.auth.allocate_debug_port", return_value=32123),
                patch("gdl_backend.auth.asyncio.create_subprocess_exec", new=spawn),
                patch("gdl_backend.auth.read_browser_websocket", return_value=(32123, "ws://browser")),
                patch("gdl_backend.auth.open_login_target", side_effect=lambda *_: events.append("target.open") or "twitter-target"),
                patch("gdl_backend.auth.get_site_cookies", side_effect=lambda *_: events.append("cookies.read") or cookies),
                patch("gdl_backend.auth.managed_login_ready", side_effect=lambda *_: events.append("page.ready") or True),
                patch("gdl_backend.auth.write_netscape_cookies", side_effect=write_cookie),
                patch("gdl_backend.auth.close_target", side_effect=lambda *_: events.append("target.close")),
                patch("gdl_backend.auth.close_browser", side_effect=lambda *_: events.append("browser.close")),
                patch.object(self.auth, "_update_metadata", side_effect=update_metadata),
                patch.object(self.auth, "_release_authorization", side_effect=release_authorization),
            ):
                result = await self.auth.start_browser_login("twitter")
                session = self.auth._browser_sessions[result["session"]["session_id"]]
                await session.monitor_task
                return session.state

        self.assertEqual(asyncio.run(run()), "authorized")
        ordered = [
            events.index("target.open"),
            events.index("cookies.read"),
            events.index("page.ready"),
            events.index("credential.write"),
            events.index("metadata.write"),
            events.index("target.close"),
            events.index("browser.close"),
            events.index("process.wait"),
            events.index("authorization.release"),
        ]
        self.assertEqual(ordered, sorted(ordered), events)
        cookie_path = self.auth._cookie_path("twitter")
        self.assertTrue(cookie_path.is_file())
        if os.name != "nt":
            self.assertEqual(cookie_path.stat().st_mode & 0o777, 0o600)

    def test_pixiv_dispose_closes_target_then_process_then_cache_then_claim(self):
        events: list[str] = []

        class OAuthProcess:
            returncode = None
            stdout = None

        cache_file = self.auth.managed_dir / ".pixiv-oauth-contract.sqlite3"
        cache_file.write_bytes(b"cache")
        session = PixivOAuthSession(
            id="contract-session",
            process=OAuthProcess(),
            created_at=time.time(),
            cache_file=cache_file,
            browser_websocket_url="ws://browser",
            browser_target_id="pixiv-target",
        )
        self.auth._active_authorization_id = session.id

        async def terminate(_process, _timeout) -> None:
            events.append("process.terminate")
            _process.returncode = 0

        def cleanup(path: Path) -> None:
            events.append("cache.cleanup")
            self.assertEqual(path, cache_file)
            path.unlink(missing_ok=True)

        async def release(session_id: str) -> None:
            events.append("authorization.release")
            self.assertEqual(session_id, session.id)
            self.auth._active_authorization_id = ""

        async def run() -> None:
            with (
                patch("gdl_backend.auth.close_target", side_effect=lambda *_: events.append("target.close")),
                patch("gdl_backend.auth.terminate_process", side_effect=terminate),
                patch.object(self.auth, "_cleanup_oauth_cache", side_effect=cleanup),
                patch.object(self.auth, "_release_authorization", side_effect=release),
            ):
                await self.auth._dispose_pixiv_session(session)

        asyncio.run(run())
        self.assertEqual(
            events,
            ["target.close", "process.terminate", "cache.cleanup", "authorization.release"],
        )
        self.assertEqual(session.state, "cancelled")
        self.assertEqual(session.browser_websocket_url, "")
        self.assertEqual(session.browser_target_id, "")

    def test_site_clear_disposes_session_before_cookie_and_metadata_cleanup(self):
        cookie_path = self.auth._cookie_path("twitter")
        cookie_path.write_text("fixture", encoding="utf-8")
        session = ManagedBrowserLoginSession(
            id="clear-contract",
            site="twitter",
            created_at=time.time(),
            expires_at=time.time() + 60,
        )
        self.auth._browser_sessions[session.id] = session
        events: list[str] = []
        original_update_metadata = self.auth._update_metadata

        async def dispose(current, *, state="cancelled") -> None:
            events.append("session.dispose")
            self.assertTrue(cookie_path.exists())
            current.state = state

        def update_metadata(site: str, value) -> None:
            events.append("metadata.clear")
            self.assertEqual(site, "twitter")
            self.assertIsNone(value)
            self.assertFalse(cookie_path.exists())
            original_update_metadata(site, value)

        async def run() -> None:
            with (
                patch.object(self.auth, "_dispose_browser_session", side_effect=dispose),
                patch.object(self.auth, "_update_metadata", side_effect=update_metadata),
            ):
                await self.auth.clear("twitter")

        asyncio.run(run())
        self.assertEqual(events, ["session.dispose", "metadata.clear"])
        self.assertFalse(cookie_path.exists())

    def test_facade_delegates_monitoring_but_retains_vault_metadata_ownership(self):
        session = ManagedBrowserLoginSession(
            id="facade-monitor-contract",
            site="twitter",
            created_at=time.time(),
            expires_at=time.time() + 60,
        )
        monitor = AsyncMock()

        async def run() -> None:
            with patch.object(
                self.auth._browser_orchestrator,
                "monitor_managed_session",
                new=monitor,
            ):
                await self.auth._monitor_browser_login(session)
            kwargs = monitor.await_args.kwargs
            self.assertIs(kwargs["authorization_lock"], self.auth._authorization_lock)
            self.assertEqual(kwargs["cookie_path"], self.auth._cookie_path("twitter"))
            self.assertEqual(kwargs["ensure_host"], self.auth._ensure_browser_host)
            self.assertEqual(
                kwargs["release_authorization"],
                self.auth._release_authorization,
            )
            self.assertEqual(
                kwargs["persist_credentials"],
                self.auth._persist_browser_credentials,
            )

            saved = await kwargs["persist_credentials"](
                session,
                [{"name": "auth_token"}, {"name": "ct0"}],
                [],
            )
            self.assertTrue(saved)

        asyncio.run(run())
        metadata = self.auth._site_metadata("twitter")
        self.assertEqual(metadata["method"], "managed_browser")
        self.assertEqual(metadata["cookie_count"], 2)
        self.assertNotIn("auth_token", str(metadata))
        self.assertNotIn("ct0", str(metadata))

    def test_managed_invalidation_never_returns_raw_worker_content(self):
        secret = "RAW_AUTH_FAILURE_SECRET"
        cookie_path = self.auth._cookie_path("twitter")
        expires = int(time.time()) + 3600
        cookie_path.write_text(
            "# Netscape HTTP Cookie File\n\n"
            f".x.com\tTRUE\t/\tTRUE\t{expires}\tauth_token\tAUTH\n"
            f".x.com\tTRUE\t/\tTRUE\t{expires}\tct0\tCSRF\n",
            encoding="utf-8",
        )
        changed = asyncio.run(
            self.auth.invalidate_if_managed(
                "twitter",
                str(cookie_path),
                f"https://third-party.invalid/private/{secret} Cookie: {secret}",
            )
        )
        self.assertTrue(changed)
        status = self.auth.status("twitter")
        self.assertEqual(status["invalid_reason"], "登录凭证失效")
        self.assertNotIn(secret, str(status))
        self.assertNotIn("third-party.invalid", str(status))


if __name__ == "__main__":
    unittest.main()
