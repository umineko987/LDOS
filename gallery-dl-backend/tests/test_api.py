from __future__ import annotations

import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from fastapi.staticfiles import StaticFiles

from gdl_backend.app import ServiceContainer, _validate_network_target, create_app
from gdl_backend.auth import AuthError, AuthManager
from gdl_backend.crawl import CrawlUnit
from gdl_backend.discovery import DiscoveryError
from gdl_backend.encrypted_dns import EncryptedDNSError, NetworkTargetValidator
from gdl_backend.proxy import ProxyLease
from gdl_backend.site import SiteInfo

from tests.helpers import local_test_client, make_settings


def _json_strings(value: object):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from _json_strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _json_strings(item)


class _FakeMonotonicClock:
    def __init__(self, now: float = 0.0) -> None:
        self.now = float(now)

    def __call__(self) -> float:
        return self.now



class NetworkTargetValidationTests(unittest.TestCase):
    @staticmethod
    def _dns_entry(address: str):
        return (None, None, None, None, (address, 443))

    def test_strict_rejects_mixed_global_and_loopback(self):
        url = "https://example.com/gallery/123"
        addresses = [
            self._dns_entry("1.1.1.1"),
            self._dns_entry("127.0.0.1"),
        ]
        with patch("gdl_backend.app.socket.getaddrinfo", return_value=addresses):
            with self.assertRaisesRegex(
                ValueError, r"IPv4: 127\.0\.0\.1"
            ) as caught:
                _validate_network_target(url, False)

        self.assertNotIn(url, str(caught.exception))

    def test_strict_rejects_mixed_global_and_private_v6(self):
        url = "https://example.com/gallery/456"
        addresses = [
            self._dns_entry("1.1.1.1"),
            self._dns_entry("fd00::1"),
        ]
        with patch("gdl_backend.app.socket.getaddrinfo", return_value=addresses):
            with self.assertRaisesRegex(ValueError, r"IPv6: fd00::1") as caught:
                _validate_network_target(url, False)

        self.assertNotIn(url, str(caught.exception))

    def test_strict_rejects_unparsable_entry(self):
        url = "https://example.com/gallery/789"
        addresses = [self._dns_entry("not-an-ip-address")]
        with patch("gdl_backend.app.socket.getaddrinfo", return_value=addresses):
            with self.assertRaisesRegex(ValueError, "无法识别") as caught:
                _validate_network_target(url, False)

        self.assertNotIn(url, str(caught.exception))

    def test_strict_allows_all_global(self):
        addresses = [
            self._dns_entry("1.1.1.1"),
            self._dns_entry("2001:4860:4860::8888"),
        ]
        with patch("gdl_backend.app.socket.getaddrinfo", return_value=addresses):
            _validate_network_target("https://example.com/gallery", False)

    def test_non_strict_restores_legacy_behaviour(self):
        addresses = [
            self._dns_entry("1.1.1.1"),
            self._dns_entry("127.0.0.1"),
        ]
        with patch("gdl_backend.app.socket.getaddrinfo", return_value=addresses):
            _validate_network_target(
                "https://example.com/gallery",
                False,
                strict=False,
            )

    def test_allow_private_short_circuits(self):
        getaddrinfo = Mock(side_effect=AssertionError("不应执行 DNS 解析"))
        with patch("gdl_backend.app.socket.getaddrinfo", getaddrinfo):
            _validate_network_target("http://127.0.0.1:8080/a", True)

        getaddrinfo.assert_not_called()

    def test_strict_rejects_empty_dns_result(self):
        with patch("gdl_backend.app.socket.getaddrinfo", return_value=[]):
            with self.assertRaisesRegex(ValueError, "DNS 未返回任何地址"):
                _validate_network_target("https://example.com/gallery", False)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temp.name))
        self.container = ServiceContainer(self.settings)
        self.app = create_app(self.settings, container=self.container, start_background=False)
        self.client_context = local_test_client(self.app, self.settings)
        self.client = self.client_context.__enter__()
        self.headers = {}

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.temp.cleanup()

    def _configure_strict_crawl_network(self) -> None:
        self.container.settings.server.allow_private_targets = False
        self.container.settings.server.strict_target_dns = True
        self.container.network_validator.allow_private_targets = False
        self.container.network_validator.strict_target_dns = True
        self.container.resolver.resolve = Mock(
            return_value=SiteInfo(
                "danbooru",
                "",
                "DanbooruPostExtractor",
                True,
                "danbooru.donmai.us",
            )
        )

    def _prime_danbooru_proxy_cache(
        self,
        *,
        validator: NetworkTargetValidator | None = None,
    ) -> Mock:
        self._configure_strict_crawl_network()
        validator = validator or self.container.network_validator
        doh = Mock()
        doh.resolve.return_value = ("1.1.1.1", "2606:4700:4700::1111")
        validator.encrypted_dns = doh
        lease = ProxyLease(
            task_id="search-29077",
            node_id="node-29077",
            endpoint="http://127.0.0.1:29077",
            name="fixture-29077",
            protocol="http",
            tags=["fixture"],
            acquired_at=1.0,
        )
        validator.validate_proxy(
            "https://danbooru.donmai.us/posts?tags=fixture",
            lease,
        )
        self.assertTrue(
            validator.validate_proxy_cache_fallback(
                "https://danbooru.donmai.us/posts/123"
            )
        )
        return doh

    @staticmethod
    def _danbooru_crawl_payload(
        *,
        body_mode: str | None = None,
        source_mode: str | None = None,
        url: str = "https://danbooru.donmai.us/posts/123",
    ) -> dict:
        source = {
            "site": "danbooru",
            "addresses": [{"url": url}],
        }
        if source_mode is not None:
            source["proxy_mode"] = source_mode
        payload = {"sources": [source]}
        if body_mode is not None:
            payload["proxy_mode"] = body_mode
        return payload

    @staticmethod
    def _mixed_dns_entries() -> list[tuple[None, None, None, None, tuple[str, int]]]:
        return [
            (None, None, None, None, ("1.1.1.1", 443)),
            (None, None, None, None, ("2001::4a56:cac", 443)),
        ]

    def _prepare_chunk_plan(self, count: int):
        batch_id = "batch-chunks"
        address_id = "address-chunks"
        self.container.db.create_crawl_batch(
            {
                "id": batch_id,
                "output_dir": str(self.settings.default_output_root / batch_id),
                "concurrency": 7,
                "max_tasks": count + 10,
            },
            [
                {
                    "id": address_id,
                    "site": "example.com",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://example.com/gallery/chunks",
                    "proxy_mode": "direct",
                    "max_attempts": 4,
                    "priority": 3,
                }
            ],
        )
        batch = self.container.db.get_crawl_batch(batch_id)
        address = batch["sources"][0]["addresses"][0]
        units = [
            CrawlUnit(
                url=f"https://example.com/media/{index}",
                site="example.com",
                kind="media",
                source_id=f"example:{index}",
                extra_args=["--range", str(index)],
                source_key=f"example:{index}",
                source_url=f"https://source.example/{index}",
            )
            for index in range(1, count + 1)
        ]
        return batch, address, units

    def test_health_ready_and_local_api(self):
        health = self.client.get("/healthz")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["components"]["database"]["status"], "ok")
        ready = self.client.get("/readyz")
        self.assertEqual(ready.status_code, 200, ready.text)
        self.assertTrue(ready.json()["ready"])
        self.assertEqual(ready.json()["components"]["dedup"]["status"], "disabled")
        self.assertEqual(
            ready.json()["components"]["project_proxy"]["status"], "disabled"
        )
        self.assertEqual(self.client.get("/api/v1/tasks").status_code, 200)

    def test_manual_probe_endpoint_bypasses_cache(self):
        expected = {
            "total": 1,
            "healthy": 1,
            "results": [{"id": "node-a", "healthy": True}],
            "cached": False,
        }
        real_probe = Mock(return_value=expected)
        cached_probe = Mock(
            return_value={**expected, "cached": True, "age_seconds": 1.0}
        )
        self.container.proxy.probe = real_probe
        self.container.proxy.probe_for_target = cached_probe

        response = self.client.post(
            "/api/v1/proxy/probe",
            headers=self.headers,
            json={},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), expected)
        real_probe.assert_called_once_with(target_url=None, node_id=None)
        cached_probe.assert_not_called()

    def test_diagnostics_profiles_are_minimal_and_legacy_compatible(self):
        legacy_config = self.client.get("/api/v1/config")
        self.assertEqual(legacy_config.status_code, 200, legacy_config.text)
        legacy_payload = legacy_config.json()
        self.assertIn("runtime_dir", legacy_payload)
        self.assertEqual(legacy_payload["runtime_dir"], str(self.settings.runtime_dir))

        safe_config = self.client.get("/api/v1/config?view=diagnostics")
        self.assertEqual(safe_config.status_code, 200, safe_config.text)
        safe_payload = safe_config.json()
        self.assertEqual(safe_payload["response_profile"], "diagnostics")
        self.assertFalse(safe_payload["secrets_exposed"])
        self.assertTrue(safe_payload["server"]["loopback_only"])
        safe_strings = tuple(_json_strings(safe_payload))
        for forbidden in (
            str(self.settings.runtime_dir),
            str(self.settings.database_path),
            str(self.settings.gallery.repo_path),
            "runtime_dir",
            "database_path",
            "python_executable",
            "authorization_proxy",
            "subscription_urls",
        ):
            self.assertFalse(
                any(forbidden in value for value in safe_strings),
                forbidden,
            )

        legacy_scheduler = self.client.get("/api/v1/scheduler/status")
        self.assertEqual(legacy_scheduler.status_code, 200, legacy_scheduler.text)
        self.assertEqual(set(legacy_scheduler.json()), {"tasks", "ordered_crawls"})
        safe_scheduler = self.client.get(
            "/api/v1/scheduler/status?view=diagnostics"
        )
        self.assertEqual(safe_scheduler.status_code, 200, safe_scheduler.text)
        self.assertEqual(safe_scheduler.json()["response_profile"], "diagnostics")
        self.assertFalse(safe_scheduler.json()["secrets_exposed"])
        self.assertEqual(
            set(safe_scheduler.json()["tasks"]),
            {
                "running",
                "active",
                "max_concurrent",
                "active_site_count",
                "dispatch_loop",
            },
        )
        self.assertNotIn("sites", safe_scheduler.json()["tasks"])
        self.assertEqual(
            set(safe_scheduler.json()["tasks"]["dispatch_loop"]),
            {
                "state",
                "running",
                "operational",
                "consecutive_failures",
                "last_error_category",
                "last_error_at",
                "last_success_at",
                "last_recovery_at",
            },
        )

    def test_scheduler_loop_diagnostics_whitelist_fault_and_recovery_facts(self):
        sensitive = (
            "token=scheduler-diag-token-29080 Cookie=scheduler-diag-cookie-29080 "
            "proxy=http://proxy-user-29080:proxy-pass-29080@127.0.0.1:29080 "
            f"path={Path(self.temp.name) / 'private' / 'scheduler.json'} "
            "task=https://tasks.example.invalid/gallery/29080 "
            "subscription=https://subscription.example.invalid/raw/29080 "
            "response=<html>third-party-raw-29080</html>"
        )
        summary = {
            "running": True,
            "active": 2,
            "max_concurrent": 20,
            "sites": {"example.com": 2},
            "dispatch_loop": {
                "state": "running",
                "running": True,
                "operational": True,
                "consecutive_failures": 0,
                "last_error_category": "runtime_error",
                "last_error_at": 10.25,
                "last_success_at": 11.5,
                "last_recovery_at": 11.5,
                "raw_exception": sensitive,
            },
            "raw_exception": sensitive,
        }

        with patch.object(
            self.container.scheduler,
            "active_summary",
            return_value=summary,
        ):
            response = self.client.get(
                "/api/v1/scheduler/status?view=diagnostics"
            )

        self.assertEqual(response.status_code, 200, response.text)
        loop = response.json()["tasks"]["dispatch_loop"]
        self.assertEqual(loop["state"], "running")
        self.assertTrue(loop["running"])
        self.assertTrue(loop["operational"])
        self.assertEqual(loop["consecutive_failures"], 0)
        self.assertEqual(loop["last_error_category"], "runtime_error")
        self.assertEqual(loop["last_error_at"], 10.25)
        self.assertEqual(loop["last_success_at"], 11.5)
        self.assertEqual(loop["last_recovery_at"], 11.5)
        self.assertNotIn("raw_exception", loop)
        safe_strings = tuple(_json_strings(response.json()))
        for forbidden in (
            "scheduler-diag-token-29080",
            "scheduler-diag-cookie-29080",
            "proxy-user-29080",
            "proxy-pass-29080",
            str(Path(self.temp.name)),
            "tasks.example.invalid",
            "subscription.example.invalid",
            "third-party-raw-29080",
        ):
            self.assertFalse(any(forbidden in value for value in safe_strings))

    def test_scheduler_readiness_only_fails_after_unexpected_loop_exit(self):
        def summary(
            state: str,
            *,
            operational: bool,
            consecutive_failures: int,
            recovered: bool = False,
        ) -> dict:
            return {
                "running": state in {"running", "degraded"},
                "active": 0,
                "max_concurrent": 20,
                "sites": {},
                "dispatch_loop": {
                    "state": state,
                    "running": state in {"running", "degraded"},
                    "operational": operational,
                    "consecutive_failures": consecutive_failures,
                    "last_error_category": "runtime_error",
                    "last_error_at": 10.0,
                    "last_success_at": 11.0 if recovered else None,
                    "last_recovery_at": 11.0 if recovered else None,
                },
            }

        cases = (
            ("degraded", summary("degraded", operational=True, consecutive_failures=1), 200),
            (
                "recovered",
                summary(
                    "running",
                    operational=True,
                    consecutive_failures=0,
                    recovered=True,
                ),
                200,
            ),
            (
                "unexpected_exit",
                summary(
                    "unexpected_exit",
                    operational=False,
                    consecutive_failures=0,
                ),
                503,
            ),
        )
        for label, scheduler_summary, expected_status in cases:
            with self.subTest(label=label), patch.object(
                self.container.scheduler,
                "active_summary",
                return_value=scheduler_summary,
            ):
                response = self.client.get("/readyz")
            self.assertEqual(response.status_code, expected_status, response.text)
            self.assertEqual(
                response.json()["components"]["scheduler"]["status"],
                "error" if expected_status == 503 else "ok",
            )

    def test_proxy_health_diagnostics_are_safe_and_only_exit_breaks_readiness(self):
        self.settings.proxy.enabled = True
        self.settings.proxy.auto_start = False
        self.settings.proxy.transport_core_enabled = False
        self.settings.proxy.inline_nodes = [
            "http://proxy-user-29081:proxy-pass-29081@127.0.0.1:29081"
        ]
        sensitive = (
            "token=proxy-diag-token-29081 Cookie=proxy-diag-cookie-29081 "
            f"path={Path(self.temp.name) / 'private' / 'proxy.json'} "
            "task=https://tasks.example.invalid/gallery/29081 "
            "subscription=https://subscription.example.invalid/raw/29081 "
            "response=<html>third-party-raw-29081</html>"
        )
        normal_scheduler = {
            "running": True,
            "active": 0,
            "max_concurrent": 20,
            "sites": {},
            "dispatch_loop": {
                "state": "running",
                "running": True,
                "operational": True,
                "consecutive_failures": 0,
                "last_error_category": None,
                "last_error_at": None,
                "last_success_at": 12.0,
                "last_recovery_at": None,
            },
        }
        degraded_health = {
            "state": "degraded",
            "running": True,
            "operational": True,
            "consecutive_failures": 2,
            "last_error_category": "runtime_error",
            "last_error_at": 10.0,
            "last_success_at": 9.0,
            "last_recovery_at": None,
            "raw_exception": sensitive,
        }
        self.container.proxy.status = Mock(
            return_value={"running": False, "healthy": 0}
        )

        with (
            patch.object(
                self.container.scheduler,
                "active_summary",
                return_value=normal_scheduler,
            ),
            patch.object(
                self.container,
                "proxy_health_summary",
                return_value=degraded_health,
            ),
        ):
            proxy_status = self.client.get("/api/v1/proxy/status")
            degraded = self.client.get("/readyz")

        self.assertEqual(proxy_status.status_code, 200, proxy_status.text)
        self.assertEqual(
            proxy_status.json()["health_loop"],
            {
                "state": "degraded",
                "running": True,
                "operational": True,
                "consecutive_failures": 2,
                "last_error_category": "runtime_error",
                "last_error_at": 10.0,
                "last_success_at": 9.0,
                "last_recovery_at": None,
            },
        )
        self.assertEqual(degraded.status_code, 200, degraded.text)
        proxy_component = degraded.json()["components"]["project_proxy"]
        self.assertEqual(proxy_component["status"], "ok")
        health_loop = proxy_component["health_loop"]
        self.assertEqual(health_loop["state"], "degraded")
        self.assertEqual(health_loop["consecutive_failures"], 2)
        self.assertEqual(health_loop["last_error_category"], "runtime_error")
        self.assertNotIn("raw_exception", health_loop)
        safe_strings = tuple(
            _json_strings({"proxy": proxy_status.json(), "ready": degraded.json()})
        )
        for forbidden in (
            "proxy-diag-token-29081",
            "proxy-diag-cookie-29081",
            "proxy-user-29081",
            "proxy-pass-29081",
            str(Path(self.temp.name)),
            "tasks.example.invalid",
            "subscription.example.invalid",
            "third-party-raw-29081",
        ):
            self.assertFalse(any(forbidden in value for value in safe_strings))

        unexpected_health = {
            **degraded_health,
            "state": "unexpected_exit",
            "running": False,
            "operational": False,
            "consecutive_failures": 0,
        }
        with (
            patch.object(
                self.container.scheduler,
                "active_summary",
                return_value=normal_scheduler,
            ),
            patch.object(
                self.container,
                "proxy_health_summary",
                return_value=unexpected_health,
            ),
        ):
            unavailable = self.client.get("/readyz")
        self.assertEqual(unavailable.status_code, 503, unavailable.text)
        self.assertEqual(
            unavailable.json()["components"]["project_proxy"]["status"],
            "error",
        )

    def test_ready_fails_when_enabled_dedup_python_is_missing(self):
        self.settings.dedup.enabled = True
        self.settings.dedup.python_executable = Path(self.temp.name) / "missing-python"
        ready = self.client.get("/readyz")
        self.assertEqual(ready.status_code, 503, ready.text)
        self.assertFalse(ready.json()["ready"])
        self.assertEqual(
            ready.json()["components"]["dedup_python"]["status"], "error"
        )

    def test_authorization_proxy_api_roundtrip(self):
        # 路由顺序回归：/auth/proxy 不能被 /auth/{site} 当成站点名吃掉（那会 404）
        initial = self.client.get("/api/v1/auth/proxy")
        self.assertEqual(initial.status_code, 200, initial.text)
        self.assertIsNone(initial.json()["proxy_url"])
        self.assertEqual(initial.json()["source"], "none")

        updated = self.client.put(
            "/api/v1/auth/proxy", json={"proxy_url": "http://127.0.0.1:7890"}
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["proxy_url"], "http://127.0.0.1:7890")
        self.assertEqual(updated.json()["source"], "runtime")

        listing = self.client.get("/api/v1/auth")
        self.assertEqual(
            listing.json()["authorization_proxy"]["proxy_url"], "http://127.0.0.1:7890"
        )

        invalid = self.client.put(
            "/api/v1/auth/proxy", json={"proxy_url": "ftp://127.0.0.1:21"}
        )
        self.assertEqual(invalid.status_code, 422, invalid.text)
        self.assertEqual(invalid.json()["error"]["code"], "invalid_authorization_proxy")

        unknown_field = self.client.put(
            "/api/v1/auth/proxy", json={"proxy_url": "", "surprise": True}
        )
        self.assertEqual(unknown_field.status_code, 422)

        direct = self.client.put("/api/v1/auth/proxy", json={"proxy_url": ""})
        self.assertEqual(direct.status_code, 200, direct.text)
        self.assertIsNone(direct.json()["proxy_url"])
        self.assertEqual(direct.json()["source"], "runtime")

        reset = self.client.delete("/api/v1/auth/proxy")
        self.assertEqual(reset.status_code, 200, reset.text)
        self.assertIsNone(reset.json()["proxy_url"])
        self.assertEqual(reset.json()["source"], "none")

    def test_browser_runtime_api_roundtrip(self):
        executable = Path(self.temp.name) / (
            "msedge.exe" if os.name == "nt" else "msedge"
        )
        executable.write_bytes(b"fixture-browser")
        if os.name != "nt":
            executable.chmod(0o700)

        updated = self.client.put(
            "/api/v1/auth/browser", json={"path": str(executable)}
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertTrue(updated.json()["available"])
        self.assertEqual(updated.json()["name"], "Microsoft Edge")
        self.assertEqual(updated.json()["source"], "configured")
        self.assertNotIn("path", updated.json())

        current = self.client.get("/api/v1/auth/browser")
        self.assertEqual(current.status_code, 200, current.text)
        self.assertEqual(current.json(), updated.json())

        invalid = self.client.put(
            "/api/v1/auth/browser",
            json={"path": str(executable), "surprise": True},
        )
        self.assertEqual(invalid.status_code, 422, invalid.text)

        with patch(
            "gdl_backend.auth.discover_chrome_executable",
            side_effect=FileNotFoundError,
        ):
            reset = self.client.delete("/api/v1/auth/browser")
        self.assertEqual(reset.status_code, 200, reset.text)
        self.assertFalse(reset.json()["available"])
        self.assertEqual(reset.json()["source"], "none")

    def test_vault_auth_projection_and_sensitive_write_errors_are_redacted(self):
        secret = "VAULT_API_SECRET_7f3c1a"
        raw = self.container.auth.statuses()
        pixiv = next(item for item in raw["items"] if item["site"] == "pixiv")
        pixiv.update(
            {
                "state": "authorizing",
                "summary": f"token={secret} /home/private/{secret}",
                "oauth": {
                    "session_id": "a" * 32,
                    "state": "awaiting_login",
                    "created_at": 1,
                    "expires_at": 601,
                    "authorization_url": (
                        "https://app-api.pixiv.net/web/v1/login"
                        f"?state={secret}&code_challenge={secret}"
                    ),
                    "message": f"Cookie={secret}",
                    "error": f"/home/private/{secret}",
                },
            }
        )
        twitter = next(item for item in raw["items"] if item["site"] == "twitter")
        twitter["invalid_reason"] = f"Authorization: Bearer {secret}"
        raw["browser_profile"]["path"] = f"/home/private/{secret}"
        self.container.auth.statuses = Mock(return_value=raw)

        legacy = self.client.get("/api/v1/auth")
        self.assertEqual(legacy.status_code, 200, legacy.text)
        self.assertIn(secret, legacy.text)

        safe = self.client.get("/api/v1/auth?view=vault")
        self.assertEqual(safe.status_code, 200, safe.text)
        payload = safe.json()
        self.assertEqual(payload["response_profile"], "vault")
        self.assertFalse(payload["secrets_exposed"])
        safe_pixiv = next(item for item in payload["items"] if item["site"] == "pixiv")
        self.assertEqual(safe_pixiv["oauth"]["session_id"], "a" * 32)
        for forbidden in (
            secret,
            "authorization_url",
            "invalid_reason",
            "/home/private",
            "code_challenge",
            "Bearer ",
        ):
            self.assertNotIn(forbidden, safe.text)

        # 恢复真实方法，验证写接口失败不覆盖已保存代理且错误 envelope 不回显输入。
        self.container.auth.statuses = AuthManager.statuses.__get__(
            self.container.auth, AuthManager
        )
        original_start = self.container.auth.start_browser_login

        async def fail_browser_start(site: str):
            raise AuthError(
                "controlled_raw_error",
                f"Cookie: {secret} /home/private/auth.log",
                {"raw_detail": f"token={secret}"},
            )

        self.container.auth.start_browser_login = fail_browser_start
        try:
            safe_error = self.client.post(
                "/api/v1/auth/twitter/login/start?view=vault"
            )
            legacy_error = self.client.post("/api/v1/auth/twitter/login/start")
        finally:
            self.container.auth.start_browser_login = original_start
        self.assertEqual(safe_error.status_code, 409)
        self.assertEqual(
            safe_error.json()["error"]["code"],
            "authorization_operation_failed",
        )
        self.assertNotIn(secret, safe_error.text)
        self.assertNotIn("/home/private", safe_error.text)
        self.assertNotIn("raw_detail", safe_error.text)
        self.assertEqual(legacy_error.status_code, 409)
        self.assertIn(secret, legacy_error.text)
        self.assertIn("/home/private", legacy_error.text)

        configured = "http://vault-user:vault-pass@127.0.0.1:7890"
        saved = self.client.put(
            "/api/v1/auth/proxy?view=vault", json={"proxy_url": configured}
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["proxy_url"], "http://***@127.0.0.1:7890")
        self.assertNotIn("vault-user", saved.text)
        self.assertNotIn("vault-pass", saved.text)

        overlong = f"http://user:{secret}{'x' * 400}@127.0.0.1:7890"
        rejected = self.client.put(
            "/api/v1/auth/proxy", json={"proxy_url": overlong}
        )
        self.assertEqual(rejected.status_code, 422, rejected.text)
        self.assertEqual(
            rejected.json()["error"]["code"], "invalid_authorization_proxy"
        )
        self.assertNotIn(secret, rejected.text)
        self.assertNotIn("input", rejected.text)
        self.assertEqual(self.container.auth.authorization_proxy(), configured)

        wrong_type = self.client.put(
            "/api/v1/auth/proxy", json={"proxy_url": {"token": secret}}
        )
        self.assertEqual(wrong_type.status_code, 422, wrong_type.text)
        self.assertNotIn(secret, wrong_type.text)
        self.assertNotIn("input", wrong_type.text)
        self.assertEqual(self.container.auth.authorization_proxy(), configured)

        too_large = self.client.put(
            "/api/v1/auth/proxy",
            content=b'{"proxy_url":""}',
            headers={"Content-Type": "application/json", "Content-Length": "2048"},
        )
        self.assertEqual(too_large.status_code, 413, too_large.text)
        self.assertEqual(too_large.json()["error"]["code"], "auth_request_too_large")
        self.assertTrue(too_large.json()["error"]["request_id"])
        self.assertEqual(self.container.auth.authorization_proxy(), configured)

    def test_managed_auth_api_contract(self):
        listing = self.client.get("/api/v1/auth")
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertEqual(
            [item["site"] for item in listing.json()["items"]],
            ["danbooru", "twitter", "pixiv", "exhentai", "pawchive"],
        )
        self.assertFalse(listing.json()["secrets_exposed"])
        self.assertTrue(listing.json()["browser_profile"]["shared"])
        unknown = self.client.get("/api/v1/auth/unknown", headers=self.headers)
        self.assertEqual(unknown.status_code, 404)

        browser_status = {
            "site": "twitter",
            "label": "X / Twitter",
            "method": "managed_browser",
            "state": "authorizing",
            "authorized": False,
            "summary": "项目专属浏览器已打开。",
            "actions": ["managed_browser_login", "clear"],
        }
        browser_session = {
            "session_id": "b" * 32,
            "site": "twitter",
            "state": "awaiting_login",
            "message": "请完成登录。",
            "created_at": 1,
            "expires_at": 901,
            "cookie_count": 0,
            "recommended_missing": [],
            "error": None,
        }
        browser_result = {"status": browser_status, "session": browser_session}
        self.container.auth.start_browser_login = AsyncMock(return_value=browser_result)
        started_browser = self.client.post(
            "/api/v1/auth/twitter/login/start",
            headers=self.headers,
        )
        self.assertEqual(started_browser.status_code, 202, started_browser.text)
        self.assertEqual(started_browser.json()["session"]["session_id"], "b" * 32)
        self.container.auth.start_browser_login.assert_awaited_once_with("twitter")

        self.container.auth.browser_login_session = Mock(return_value=browser_result)
        polled = self.client.get(
            f"/api/v1/auth/twitter/login/{'b' * 32}",
            headers=self.headers,
        )
        self.assertEqual(polled.status_code, 200, polled.text)
        self.container.auth.browser_login_session.assert_called_once_with("twitter", "b" * 32)

        self.container.auth.cancel_browser_login = AsyncMock(return_value=browser_result)
        closed = self.client.delete(
            f"/api/v1/auth/twitter/login/{'b' * 32}",
            headers=self.headers,
        )
        self.assertEqual(closed.status_code, 200, closed.text)
        self.container.auth.cancel_browser_login.assert_awaited_once_with("twitter", "b" * 32)
        self.assertEqual(
            self.client.post("/api/v1/auth/twitter/browser", headers=self.headers, json={}).status_code,
            404,
        )

        session = {
            "session_id": "a" * 32,
            "state": "awaiting_code",
            "authorization_url": "https://app-api.pixiv.net/web/v1/login?state=test",
            "created_at": 1,
            "expires_at": 601,
            "error": None,
        }
        self.container.auth.start_pixiv_oauth = AsyncMock(return_value=session)
        started = self.client.post("/api/v1/auth/pixiv/oauth/start", headers=self.headers)
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(started.json()["session_id"], "a" * 32)

        pixiv_status = {
            "site": "pixiv",
            "label": "Pixiv",
            "method": "oauth",
            "state": "authorized",
            "authorized": True,
            "summary": "Pixiv 登录授权有效。",
            "actions": ["oauth", "clear"],
        }
        completed = self.client.post(
            "/api/v1/auth/pixiv/oauth/complete",
            headers=self.headers,
            json={"session_id": "a" * 32, "callback": "https://callback/?code=VALUE"},
        )
        self.assertEqual(completed.status_code, 404, completed.text)
        self.assertNotIn(
            "/api/v1/auth/pixiv/oauth/complete",
            self.client.get("/openapi.json").json()["paths"],
        )

        self.container.auth.cancel_pixiv_oauth = AsyncMock(return_value=pixiv_status)
        cancelled = self.client.delete(
            "/api/v1/auth/pixiv/oauth/session",
            headers=self.headers,
        )
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.container.auth.cancel_pixiv_oauth.assert_awaited_once()

        self.container.auth.clear = AsyncMock(return_value={**pixiv_status, "authorized": False})
        cleared = self.client.delete("/api/v1/auth/pixiv", headers=self.headers)
        self.assertEqual(cleared.status_code, 200, cleared.text)

        profile_result = {
            "browser_profile": {"shared": True, "present": False, "running": False},
            "auth": {"items": []},
        }
        self.container.auth.clear_browser_profile = AsyncMock(return_value=profile_result)
        profile_cleared = self.client.delete(
            "/api/v1/auth/browser-profile",
            headers=self.headers,
        )
        self.assertEqual(profile_cleared.status_code, 200, profile_cleared.text)
        self.container.auth.clear_browser_profile.assert_awaited_once()

    def test_task_idempotency_cancel_logs_and_files(self):
        body = {"url": "https://www.pixiv.net/artworks/123456", "proxy_mode": "direct"}
        headers = {**self.headers, "Idempotency-Key": "same-request"}
        first = self.client.post("/api/v1/tasks", headers=headers, json=body)
        self.assertEqual(first.status_code, 202, first.text)
        second = self.client.post("/api/v1/tasks", headers=headers, json=body)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json()["id"], second.json()["id"])
        task_id = first.json()["id"]
        cancelled = self.client.post(f"/api/v1/tasks/{task_id}/cancel", headers=self.headers)
        self.assertEqual(cancelled.json()["status"], "cancelled")
        self.assertEqual(self.client.get(f"/api/v1/tasks/{task_id}/logs", headers=self.headers).status_code, 200)
        self.assertEqual(self.client.get(f"/api/v1/tasks/{task_id}/files", headers=self.headers).status_code, 200)

    def test_task_automatically_uses_managed_site_login(self):
        cookie_path = self.container.auth.managed_dir / "twitter.cookies.txt"
        cookie_path.write_text(
            "# Netscape HTTP Cookie File\n\n"
            ".x.com\tTRUE\t/\tTRUE\t4102444800\tauth_token\tSECRET\n"
            ".x.com\tTRUE\t/\tTRUE\t4102444800\tct0\tSECRET2\n",
            encoding="utf-8",
        )
        response = self.client.post(
            "/api/v1/tasks",
            headers=self.headers,
            json={"url": "https://x.com/example/status/123456", "proxy_mode": "direct"},
        )
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["cookies_file"], str(cookie_path.resolve()))

    def _policy_view_payload(self, **overrides):
        payload = {
            "max_concurrency": 20,
            "retry_limit": 2,
            "backoff_base_seconds": 2,
            "proxy_mode": "prefer",
        }
        payload.update(overrides)
        return payload

    def test_site_policy_crud_and_proxy_status(self):
        policy = self._policy_view_payload(
            max_concurrency=1,
            retry_limit=1,
            backoff_base_seconds=0,
            proxy_mode="required",
        )
        response = self.client.put(
            "/api/v1/sites/policies/pixiv",
            headers=self.headers,
            json=policy,
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["policy"], policy)
        status = self.client.get("/api/v1/proxy/status", headers=self.headers)
        self.assertEqual(status.status_code, 200)
        self.assertFalse(status.json()["running"])
        self.assertTrue(status.json()["managed_by_backend"])
        self.assertFalse(status.json()["auto_start"])
        self.assertEqual(status.json()["engine"], "native")
        self.assertFalse(status.json()["executable_required"])


    def test_desktop_proxy_status_caps_and_projects_node_rows(self):
        nodes = [
            {
                "id": f"node-{index}",
                "name": f"Proxy {index}",
                "protocol": "http",
                "endpoint": "http://***@proxy.invalid:8080",
                "tags": ["general"],
                "healthy": True,
                "retry_eligible": True,
                "ref_count": 0,
                "success_count": 0,
                "fail_count": 0,
                "last_latency_ms": 10,
                "cooldown_until": 0,
                "last_error": "upstream failure " + ("x" * 10_000),
                "private_config": "x" * 10_000,
            }
            for index in range(600)
        ]
        status = {
            "enabled": True,
            "engine": "native",
            "managed_by_backend": True,
            "auto_start": False,
            "running": True,
            "total": 600,
            "healthy": 600,
            "retry_eligible": 600,
            "leases": 0,
            "last_error": "",
            "configured_revision": "a" * 64,
            "active_revision": "a" * 64,
            "reload_required": False,
            "transport_core": {},
            "sources": {},
            "nodes": nodes,
        }
        with patch.object(self.container.proxy, "status", return_value=status):
            legacy = self.client.get("/api/v1/proxy/status", headers=self.headers)
            desktop = self.client.get(
                "/api/v1/proxy/status?view=desktop", headers=self.headers
            )

        self.assertGreater(len(legacy.content), 10_000_000)
        self.assertEqual(desktop.status_code, 200, desktop.text)
        self.assertLess(len(desktop.content), 1_048_576)
        payload = desktop.json()
        self.assertEqual(payload["response_profile"], "desktop-proxy-v1")
        self.assertEqual(payload["total"], 600)
        self.assertEqual(len(payload["nodes"]), 500)
        self.assertEqual(payload["node_rows_total"], 600)
        self.assertTrue(payload["node_rows_truncated"])
        self.assertLessEqual(len(payload["nodes"][0]["last_error"]), 300)
        self.assertNotIn("private_config", payload["nodes"][0])


    def test_desktop_high_volume_routes_expose_bounded_view_contracts(self):
        contracts = {
            ("/api/v1/search", "post"): "desktop",
            ("/api/v1/crawls", "get"): "desktop",
            ("/api/v1/crawls", "post"): "desktop",
            ("/api/v1/crawls/{batch_id}", "get"): "desktop",
            ("/api/v1/crawls/{batch_id}/tasks", "get"): "tasks",
            ("/api/v1/crawls/{batch_id}/cancel", "post"): "desktop",
            ("/api/v1/crawls/{batch_id}/retry", "post"): "desktop",
            ("/api/v1/crawls/{batch_id}/rerun", "post"): "desktop",
            ("/api/v1/crawls/{batch_id}/review", "get"): "desktop",
            ("/api/v1/crawls/{batch_id}/review/start", "post"): "desktop",
            ("/api/v1/crawls/{batch_id}/review/decisions", "put"): "desktop",
            ("/api/v1/crawls/{batch_id}/review/apply", "post"): "desktop",
            ("/api/v1/crawls/{batch_id}/review/retry", "post"): "desktop",
            ("/api/v1/proxy/status", "get"): "desktop",
            ("/api/v1/proxy/start", "post"): "desktop",
            ("/api/v1/proxy/reload", "post"): "desktop",
            ("/api/v1/proxy/stop", "post"): "desktop",
            ("/api/v1/proxy/probe", "post"): "desktop",
            ("/api/v1/proxy/sources/subscriptions", "post"): "desktop",
            ("/api/v1/proxy/sources/subscriptions/{source_id}", "put"): "desktop",
            ("/api/v1/proxy/sources/subscriptions/{source_id}", "delete"): "desktop",
            ("/api/v1/proxy/sources/node-file", "put"): "desktop",
            ("/api/v1/proxy/sources/node-file", "delete"): "desktop",
            ("/api/v1/proxy/sources/inline-nodes", "post"): "desktop",
            ("/api/v1/proxy/sources/inline-nodes/{source_id}", "put"): "desktop",
            ("/api/v1/proxy/sources/inline-nodes/{source_id}", "delete"): "desktop",
            ("/api/v1/proxy/sources/override", "delete"): "desktop",
            ("/api/v1/auth", "get"): "vault",
            ("/api/v1/auth/{site}", "get"): "vault",
            ("/api/v1/auth/{site}/login/{session_id}", "get"): "vault",
            ("/api/v1/auth/proxy", "put"): "vault",
            ("/api/v1/auth/proxy", "delete"): "vault",
            ("/api/v1/auth/{site}/login/start", "post"): "vault",
            ("/api/v1/auth/{site}/login/{session_id}", "delete"): "vault",
            ("/api/v1/auth/pixiv/oauth/start", "post"): "vault",
            ("/api/v1/auth/pixiv/oauth/session", "delete"): "vault",
            ("/api/v1/auth/browser-profile", "delete"): "vault",
            ("/api/v1/auth/{site}", "delete"): "vault",
            ("/api/v1/sites/policies", "get"): "policy",
            ("/api/v1/sites/policies/{site}", "get"): "policy",
            ("/api/v1/sites/policies/{site}", "put"): "policy",
            ("/api/v1/sites/policies/{site}", "delete"): "policy",
            ("/api/v1/config", "get"): "diagnostics",
            ("/api/v1/scheduler/status", "get"): "diagnostics",
        }
        paths = self.client.get("/openapi.json").json()["paths"]
        for (path, method), expected_view in contracts.items():
            operation = paths[path][method]
            view_parameter = next(
                parameter
                for parameter in operation.get("parameters", [])
                if parameter.get("name") == "view" and parameter.get("in") == "query"
            )
            schema = view_parameter["schema"]
            values = set(schema.get("enum", []))
            for option in schema.get("anyOf", []):
                values.update(option.get("enum", []))
                if option.get("const") is not None:
                    values.add(option["const"])
            self.assertIn(expected_view, values, f"{method.upper()} {path}")

    def test_policy_view_four_field_roundtrip_builds_fixed_runtime_policy(self):
        legacy = self.client.get("/api/v1/sites/policies")
        self.assertEqual(legacy.status_code, 200, legacy.text)
        self.assertEqual(set(legacy.json()), {"default", "items"})
        self.assertEqual(legacy.json()["default"], self._policy_view_payload())
        self.assertNotIn("response_profile", legacy.json())

        listing = self.client.get("/api/v1/sites/policies?view=policy")
        self.assertEqual(listing.status_code, 200, listing.text)
        snapshot = listing.json()
        self.assertEqual(snapshot["response_profile"], "policy")
        self.assertFalse(snapshot["secrets_exposed"])
        self.assertEqual(snapshot["effect_scope"], "new_requests_and_tasks")
        self.assertEqual(
            [item["site"] for item in snapshot["items"]],
            ["danbooru", "twitter", "pixiv", "exhentai", "pawchive"],
        )
        self.assertTrue(
            all(set(item["policy"]) == set(self._policy_view_payload()) for item in snapshot["items"])
        )

        old_snapshot = self.container.policy_for("pixiv")
        payload = self._policy_view_payload(
            max_concurrency=7,
            retry_limit=3,
            backoff_base_seconds=0.5,
            proxy_mode="required",
        )
        saved = self.client.put(
            "/api/v1/sites/policies/pixiv?view=policy",
            json=payload,
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        item = saved.json()
        self.assertTrue(item["has_override"])
        self.assertFalse(item["inherited"])
        self.assertEqual(item["policy"], payload)
        self.assertEqual(
            self.container.db.get_site_policy("pixiv")["policy"],
            payload,
        )
        current = self.container.policy_for("pixiv")
        self.assertEqual(
            current.model_dump(),
            {
                **payload,
                "probe_url": None,
                "probe_before_use": True,
                "node_tags": [],
                "http_timeout": 60.0,
                "gallery_retries": 2,
                "task_timeout_seconds": 7200.0,
                "download_stall_timeout_seconds": 300.0,
                "eh_download": None,
                "extra_args": [],
            },
        )
        self.assertEqual(old_snapshot.max_concurrency, 20)

        authoritative = self.client.get("/api/v1/sites/policies?view=policy").json()
        pixiv = next(entry for entry in authoritative["items"] if entry["site"] == "pixiv")
        self.assertEqual(pixiv["policy"], payload)
        reset = self.client.delete("/api/v1/sites/policies/pixiv?view=policy")
        self.assertEqual(reset.status_code, 200, reset.text)
        self.assertEqual(
            reset.json(),
            {"response_profile": "policy", "deleted": True, "site": "pixiv"},
        )
        inherited = self.client.get("/api/v1/sites/policies/pixiv?view=policy")
        self.assertEqual(inherited.status_code, 200, inherited.text)
        self.assertTrue(inherited.json()["inherited"])
        self.assertFalse(inherited.json()["has_override"])
        self.assertEqual(inherited.json()["policy"], self._policy_view_payload())

    def test_request_level_eh_args_and_proxy_still_override_fixed_site_runtime(self):
        saved = self.client.put(
            "/api/v1/sites/policies/exhentai?view=policy",
            json=self._policy_view_payload(
                retry_limit=4,
                proxy_mode="required",
            ),
        )
        self.assertEqual(saved.status_code, 200, saved.text)

        created = self.client.post(
            "/api/v1/tasks",
            json={
                "url": "https://e-hentai.org/g/123/cccccccccc/",
                "proxy_mode": "direct",
                "eh_download": {
                    "image_mode": "original",
                    "gp_policy": "stop",
                },
                "extra_args": ["--no-mtime"],
            },
        )
        self.assertEqual(created.status_code, 202, created.text)
        task = created.json()
        self.assertEqual(task["proxy_mode"], "direct")
        self.assertEqual(task["max_attempts"], 5)
        self.assertEqual(task["extra_args"], ["--no-mtime"])
        self.assertEqual(task["policy"]["extra_args"], [])
        self.assertEqual(
            task["policy"]["eh_download"],
            {"image_mode": "original", "gp_policy": "stop"},
        )
        self.assertEqual(task["policy"]["http_timeout"], 60.0)
        self.assertEqual(task["policy"]["task_timeout_seconds"], 7200.0)
        self.assertEqual(task["policy"]["download_stall_timeout_seconds"], 300.0)

    def test_policy_view_projects_loaded_four_field_default_without_hot_reload(self):
        self.settings.default_site_policy.update(
            {
                "max_concurrency": 11,
                "proxy_mode": "direct",
            }
        )
        first = self.client.get("/api/v1/sites/policies?view=policy")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["default"]["policy"]["max_concurrency"], 11)
        self.assertEqual(first.json()["default"]["policy"]["proxy_mode"], "direct")
        self.assertEqual(
            set(first.json()["default"]["policy"]),
            set(self._policy_view_payload()),
        )
        self.assertTrue(all(item["inherited"] for item in first.json()["items"]))
        self.assertTrue(
            all(item["policy"] == first.json()["default"]["policy"] for item in first.json()["items"])
        )

        # 外部文件变化不会改变当前进程已经加载的统一默认。
        (Path(self.temp.name) / "missing-config.json").write_text(
            '{"default_site_policy":{"max_concurrency":99}}',
            encoding="utf-8",
        )
        second = self.client.get("/api/v1/sites/policies?view=policy")
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["default"]["policy"]["max_concurrency"], 11)

    def test_policy_storage_rejects_symlink_database_without_touching_target(self):
        if not hasattr(os, "symlink"):
            self.skipTest("当前平台不支持符号链接")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            settings = make_settings(root)
            target = root / "outside.sqlite3"
            sentinel = b"POLICY-SYMLINK-SENTINEL"
            target.write_bytes(sentinel)
            try:
                settings.database_path.symlink_to(target)
            except OSError as exc:
                self.skipTest(f"当前环境不能创建符号链接：{exc}")
            with self.assertRaisesRegex(ValueError, "符号链接"):
                ServiceContainer(settings)
            self.assertEqual(target.read_bytes(), sentinel)

    def test_policy_views_never_expose_malformed_or_unknown_database_rows(self):
        secret = "POLICY_API_SECRET_83b1"
        with self.container.db._transaction() as connection:
            connection.execute(
                """
                INSERT INTO site_policies(site, policy_json, updated_at)
                VALUES (?, ?, ?)
                """,
                (
                    "twitter",
                    '{"max_concurrency":3,"retry_limit":1,'
                    '"backoff_base_seconds":1,"proxy_mode":"prefer",'
                    f'"extra_args":["token={secret}"]}}',
                    1.0,
                ),
            )
            connection.execute(
                """
                INSERT INTO site_policies(site, policy_json, updated_at)
                VALUES (?, ?, ?)
                """,
                (
                    "unknown-private-source",
                    f'{{"path":"/home/private/{secret}"}}',
                    1.0,
                ),
            )
        runtime = self.container.policy_for("twitter")
        self.assertEqual(runtime.max_concurrency, 3)
        self.assertEqual(runtime.http_timeout, 60.0)
        self.assertEqual(runtime.extra_args, [])

        projected = self.client.get("/api/v1/sites/policies?view=policy")
        self.assertEqual(projected.status_code, 200, projected.text)
        self.assertNotIn(secret, projected.text)
        self.assertNotIn("/home/private", projected.text)
        self.assertNotIn("unknown-private-source", projected.text)
        self.assertEqual(projected.json()["unknown_override_count"], 1)
        twitter = next(
            item for item in projected.json()["items"] if item["site"] == "twitter"
        )
        self.assertFalse(twitter["editable"])
        self.assertEqual(twitter["reason"], "unsafe_stored_policy")
        self.assertIsNone(twitter["policy"])
        self.assertTrue(twitter["has_override"])

        legacy = self.client.get("/api/v1/sites/policies")
        self.assertEqual(legacy.status_code, 503, legacy.text)
        self.assertNotIn(secret, legacy.text)
        self.assertNotIn("/home/private", legacy.text)

    def test_policy_writes_accept_exactly_four_fields_with_safe_boundaries(self):
        payload = self._policy_view_payload()
        for method, path in (
            ("get", "/api/v1/sites/policies/unknown?view=policy"),
            ("put", "/api/v1/sites/policies/unknown?view=policy"),
            ("delete", "/api/v1/sites/policies/unknown?view=policy"),
            ("put", "/api/v1/sites/policies/unknown"),
        ):
            response = getattr(self.client, method)(
                path,
                **({"json": payload} if method == "put" else {}),
            )
            self.assertEqual(response.status_code, 422, response.text)
            self.assertEqual(response.json()["error"]["code"], "unsupported_policy_site")

        secret = "POLICY_INVALID_SECRET_51ca"
        invalid_payloads = [
            self._policy_view_payload(proxy_mode="automatic"),
            self._policy_view_payload(max_concurrency=0),
            self._policy_view_payload(max_concurrency=129),
            self._policy_view_payload(max_concurrency=True),
            self._policy_view_payload(max_concurrency="3"),
            self._policy_view_payload(retry_limit=-1),
            self._policy_view_payload(retry_limit=21),
            self._policy_view_payload(retry_limit=False),
            self._policy_view_payload(backoff_base_seconds=-0.1),
            self._policy_view_payload(backoff_base_seconds=3600.1),
            self._policy_view_payload(backoff_base_seconds="2"),
            {**self._policy_view_payload(), "probe_url": f"https://{secret}.invalid/"},
            {**self._policy_view_payload(), "probe_before_use": False},
            {**self._policy_view_payload(), "node_tags": [secret]},
            {**self._policy_view_payload(), "http_timeout": 1},
            {**self._policy_view_payload(), "gallery_retries": 50},
            {**self._policy_view_payload(), "task_timeout_seconds": 0},
            {**self._policy_view_payload(), "download_stall_timeout_seconds": 0},
            {
                **self._policy_view_payload(),
                "eh_download": {"image_mode": "resample", "gp_policy": "resized"},
            },
            {**self._policy_view_payload(), "extra_args": [f"token={secret}"]},
            {**self._policy_view_payload(), "unknown_secret": secret},
        ]
        for suffix in ("?view=policy", ""):
            for invalid in invalid_payloads:
                response = self.client.put(
                    f"/api/v1/sites/policies/pixiv{suffix}",
                    json=invalid,
                )
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(response.json()["error"]["code"], "invalid_policy")
                self.assertNotIn(secret, response.text)
                self.assertNotIn('"input"', response.text)
                self.assertIsNone(self.container.db.get_site_policy("pixiv"))

        missing_field = self._policy_view_payload()
        missing_field.pop("retry_limit")
        missing = self.client.put(
            "/api/v1/sites/policies/pixiv?view=policy",
            json=missing_field,
        )
        self.assertEqual(missing.status_code, 422, missing.text)
        self.assertEqual(
            missing.json()["error"]["details"],
            {"field": "retry_limit", "reason": "missing_field"},
        )

        openapi = self.client.get("/openapi.json").json()
        editable_schema = openapi["components"]["schemas"]["EditableSitePolicy"]
        self.assertEqual(
            set(editable_schema["properties"]),
            {"max_concurrency", "retry_limit", "backoff_base_seconds", "proxy_mode"},
        )
        self.assertFalse(editable_schema.get("additionalProperties", True))

        for suffix in ("?view=policy", ""):
            too_large = self.client.put(
                f"/api/v1/sites/policies/pixiv{suffix}",
                content=b"{}",
                headers={
                    "Content-Type": "application/json",
                    "Content-Length": str(32 * 1024),
                },
            )
            self.assertEqual(too_large.status_code, 413, too_large.text)
            self.assertEqual(
                too_large.json()["error"]["code"],
                "policy_request_too_large",
            )

        understated_large = self.client.put(
            "/api/v1/sites/policies/pixiv?view=policy",
            content=b'{"padding":"' + (b"x" * (17 * 1024)) + b'"}',
            headers={
                "Content-Type": "application/json",
                "Content-Length": "2",
            },
        )
        self.assertEqual(understated_large.status_code, 413, understated_large.text)
        self.assertEqual(
            understated_large.json()["error"]["code"],
            "policy_request_too_large",
        )
        self.assertIsNone(self.container.db.get_site_policy("pixiv"))

    def test_policy_view_sqlite_failure_is_atomic_and_error_is_safe(self):
        first = self._policy_view_payload(max_concurrency=3)
        saved = self.client.put(
            "/api/v1/sites/policies/pixiv?view=policy",
            json=first,
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        with self.container.db._lock:
            self.container.db._conn.execute(
                """
                CREATE TRIGGER fail_policy_update BEFORE UPDATE ON site_policies
                WHEN NEW.site='pixiv'
                BEGIN SELECT RAISE(ABORT, '/home/private/POLICY_DB_SECRET'); END
                """
            )
        failed = self.client.put(
            "/api/v1/sites/policies/pixiv?view=policy",
            json=self._policy_view_payload(max_concurrency=9),
        )
        self.assertEqual(failed.status_code, 503, failed.text)
        self.assertEqual(failed.json()["error"]["code"], "policy_store_error")
        self.assertNotIn("POLICY_DB_SECRET", failed.text)
        self.assertNotIn("/home/private", failed.text)
        self.assertEqual(
            self.container.db.get_site_policy("pixiv")["policy"]["max_concurrency"],
            3,
        )
        with self.container.db._lock:
            self.container.db._conn.execute("DROP TRIGGER fail_policy_update")
            self.container.db._conn.execute(
                """
                CREATE TRIGGER fail_policy_delete BEFORE DELETE ON site_policies
                WHEN OLD.site='pixiv'
                BEGIN SELECT RAISE(ABORT, '/home/private/POLICY_DELETE_SECRET'); END
                """
            )
        failed_delete = self.client.delete(
            "/api/v1/sites/policies/pixiv?view=policy",
        )
        self.assertEqual(failed_delete.status_code, 503, failed_delete.text)
        self.assertEqual(failed_delete.json()["error"]["code"], "policy_store_error")
        self.assertNotIn("POLICY_DELETE_SECRET", failed_delete.text)
        self.assertNotIn("/home/private", failed_delete.text)
        self.assertEqual(
            self.container.db.get_site_policy("pixiv")["policy"]["max_concurrency"],
            3,
        )
        with self.container.db._lock:
            self.container.db._conn.execute("DROP TRIGGER fail_policy_delete")
        if os.name != "nt":
            self.assertEqual(self.container.db.path.stat().st_mode & 0o777, 0o600)

        with self.container.db._transaction() as connection:
            connection.execute(
                "UPDATE site_policies SET policy_json=? WHERE site='pixiv'",
                ("{broken-private-path:/home/private/POLICY_DB_SECRET",),
            )
        corrupt = self.client.get("/api/v1/sites/policies?view=policy")
        self.assertEqual(corrupt.status_code, 503, corrupt.text)
        self.assertEqual(corrupt.json()["error"]["code"], "policy_store_error")
        self.assertNotIn("POLICY_DB_SECRET", corrupt.text)
        self.assertNotIn("/home/private", corrupt.text)

    def test_private_target_guard(self):
        with self.assertRaises(ValueError):
            _validate_network_target("http://127.0.0.1:8080/a", False)
        _validate_network_target("http://127.0.0.1:8080/a", True)
        mixed = [
            (None, None, None, None, ("127.0.0.1", 443)),
            (None, None, None, None, ("1.1.1.1", 443)),
        ]
        with patch("gdl_backend.app.socket.getaddrinfo", return_value=mixed):
            with self.assertRaises(ValueError):
                _validate_network_target("https://example.com/a", False)

    def test_known_site_must_match_extractor(self):
        response = self.client.post(
            "/api/v1/tasks",
            headers=self.headers,
            json={
                "url": "https://www.pixiv.net/artworks/123456",
                "site": "twitter",
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["error"]["code"], "invalid_task")

    def test_non_loopback_bind_is_rejected(self):
        self.settings.server.host = "0.0.0.0"
        with self.assertRaisesRegex(ValueError, "回环"):
            self.settings.validate()

    def test_search_sites_and_grouped_source_addresses(self):
        sites = self.client.get("/api/v1/search/sites", headers=self.headers)
        self.assertEqual(sites.status_code, 200)
        self.assertEqual(
            {item["site"] for item in sites.json()["items"]},
            {"twitter", "pixiv", "danbooru", "exhentai", "pawchive"},
        )
        eh_catalog = next(
            item for item in sites.json()["items"] if item["site"] == "exhentai"
        )
        self.assertEqual(
            {item["namespace"] for item in eh_catalog["tag_namespaces"]},
            {
                "artist",
                "character",
                "cosplayer",
                "female",
                "group",
                "language",
                "location",
                "male",
                "mixed",
                "other",
                "parody",
                "reclass",
                "temp",
            },
        )
        expected = {
            "site": "twitter",
            "keyword": "clover days",
            "search_url": "https://x.com/search?q=clover+days",
            "candidate_count": 1,
            "author_count": 1,
            "candidates": [
                {
                    "id": "123",
                    "site": "twitter",
                    "kind": "work",
                    "url": "https://x.com/artist/status/123",
                    "download_url": "https://x.com/artist/status/123",
                    "media_count": 1,
                    "author": {"id": "42"},
                }
            ],
            "authors": [
                {
                    "id": "42",
                    "site": "twitter",
                    "kind": "author",
                    "name": "artist",
                    "display_name": "clover days",
                    "url": "https://x.com/artist",
                    "works_url": "https://x.com/artist/media",
                }
            ],
            "proxy": {"mode": "direct", "used": False},
            "attempts": 1,
        }
        self.container.discovery.search = AsyncMock(return_value=expected)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["x"],
                "keyword": "clover days",
                "limit": 10,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["source_count"], 1)
        self.assertEqual(payload["address_count"], 0)
        self.assertEqual(payload["weak_evidence_count"], 0)
        self.assertEqual(payload["sources"][0]["site"], "twitter")
        self.assertEqual(payload["sources"][0]["addresses"], [])
        self.assertEqual(
            payload["sources"][0]["search_strategy"],
            "danbooru_artist_urls",
        )
        self.assertEqual(payload["sources"][0]["weak_evidence"], [])
        self.assertEqual(payload["selection_contract"]["execution_order"], "source_then_address")
        self.assertEqual(payload["selection_contract"]["default_visibility"], "addresses_only")
        self.assertEqual(self.container.discovery.search.await_args.kwargs["site"], "danbooru")

    def test_desktop_search_view_projects_only_crawl_workspace_fields(self):
        raw = {
            "sources": [{
                "site": "danbooru",
                "status": "partial",
                "evidence_count": 1,
                "preview_count": 1,
                "attempts": 2,
                "alias_keywords": ["artist"],
                "error": {"code": "partial", "message": "retry"},
                "enrichment_errors": [{"private": "x"}] * 7,
                "auth": {"state": "authorized", "authorized": True, "private": "x"},
                "tag_facets": [],
                "addresses": [{
                    "id": "123",
                    "url": "https://danbooru.donmai.us/posts?tags=artist",
                    "title": "Artist",
                    "address_type": "artist_tag",
                    "media_count": 3,
                    "related_profiles": [{"private": "x"}] * 9,
                    "metadata": {"tags": ["artist:name"], "private": "x"},
                    "download_url": "https://private.invalid/download",
                    "private": "x" * 100_000,
                }],
                "weak_evidence": [],
                "private": "x" * 100_000,
            }],
            "related_profiles": [{
                "artist_name": "Artist",
                "platform": "twitter",
                "url": "https://x.com/artist",
                "private": "x" * 100_000,
            }],
            "private": "x" * 100_000,
        }
        candidate = raw["sources"][0]["addresses"][0]
        raw["sources"][0]["addresses"] = [candidate] * 250
        raw["sources"][0]["weak_evidence"] = [candidate] * 100
        raw["sources"][0]["tag_facets"] = [{
            "namespace": "x" * 1_000,
            "label": "x" * 1_000,
            "gallery_count": 1,
            "tags": [{"tag": "x" * 1_000, "count": 1}] * 160,
        }] * 10
        raw["related_profiles"] *= 50
        with patch(
            "gdl_backend.api_routes.discovery._perform_search",
            new=AsyncMock(return_value=raw),
        ):
            response = self.client.post(
                "/api/v1/search?view=desktop",
                headers=self.headers,
                json={"sites": ["danbooru"], "keyword": "artist", "limit": 20},
            )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["response_profile"], "desktop")
        self.assertFalse(payload["projection_truncated"])
        self.assertEqual(len(payload["sources"][0]["addresses"]), 250)
        self.assertEqual(len(payload["sources"][0]["weak_evidence"]), 100)
        self.assertEqual(len(payload["sources"][0]["tag_facets"]), 10)
        self.assertEqual(len(payload["related_profiles"]), 50)
        source = payload["sources"][0]
        self.assertEqual(source["enrichment_error_count"], 7)
        self.assertEqual(source["addresses"][0]["related_profile_count"], 9)
        self.assertNotIn("download_url", source["addresses"][0])
        self.assertNotIn("private", response.text)
        self.assertLess(len(response.content), 1_048_576)

    def test_desktop_search_view_enforces_encoded_byte_budget(self):
        control_text = "\x01" * 10_000
        candidate = {
            "id": control_text,
            "url": "https://example.invalid/" + ("x" * 10_000),
            "address_type": control_text,
            "label": control_text,
            "tag": control_text,
            "title": control_text,
            "confidence": control_text,
            "origin": control_text,
            "thumbnail_url": "https://example.invalid/" + ("y" * 10_000),
            "media_count": 1,
            "evidence_reasons": [control_text] * 20,
            "related_profiles": [{}] * 1_000,
            "metadata": {"tags": [control_text] * 20},
        }
        source = {
            "site": "danbooru",
            "status": "succeeded",
            "tag_facets": [],
            "addresses": [candidate] * 1_000,
            "weak_evidence": [candidate] * 1_000,
        }
        raw = {
            "sources": [source] * 5,
            "related_profiles": [
                {
                    "artist_name": control_text,
                    "platform": control_text,
                    "url": control_text,
                }
            ] * 1_000,
        }
        with patch(
            "gdl_backend.api_routes.discovery._perform_search",
            new=AsyncMock(return_value=raw),
        ):
            response = self.client.post(
                "/api/v1/search?view=desktop",
                headers=self.headers,
                json={"sites": ["danbooru"], "keyword": "artist", "limit": 200},
            )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        projected_candidates = sum(
            len(source["addresses"]) + len(source["weak_evidence"])
            for source in payload["sources"]
        )
        self.assertGreater(projected_candidates, 0)
        self.assertLess(projected_candidates, 1_000)
        self.assertTrue(payload["projection_truncated"])
        self.assertLess(len(response.content), 16 * 1024 * 1024)

    def test_desktop_search_view_preserves_eh_filter_tags_consistently(self):
        tags = [f"artist:name-{index}" for index in range(200)]
        raw = {
            "sources": [
                {
                    "site": "exhentai",
                    "status": "succeeded",
                    "addresses": [
                        {
                            "id": "gallery-1",
                            "url": "https://e-hentai.org/g/1/aaaaaaaaaa/",
                            "metadata": {"tags": tags},
                        }
                    ],
                    "weak_evidence": [],
                    "tag_facets": [
                        {
                            "namespace": "artist",
                            "label": "画师",
                            "gallery_count": 1,
                            "tags": [{"tag": tag, "count": 1} for tag in tags],
                        }
                    ],
                }
            ],
            "related_profiles": [],
        }
        with patch(
            "gdl_backend.api_routes.discovery._perform_search",
            new=AsyncMock(return_value=raw),
        ):
            response = self.client.post(
                "/api/v1/search?view=desktop",
                headers=self.headers,
                json={"sites": ["exhentai"], "keyword": "artist", "limit": 200},
            )
        self.assertEqual(response.status_code, 200, response.text)
        source = response.json()["sources"][0]
        self.assertEqual(source["addresses"][0]["metadata"]["tags"], tags[:160])
        self.assertEqual(
            [tag["tag"] for tag in source["tag_facets"][0]["tags"]],
            tags[:160],
        )

    def test_desktop_search_view_preserves_all_five_normal_source_pages(self):
        sites = ("danbooru", "twitter", "pixiv", "exhentai", "pawchive")
        raw = {
            "sources": [
                {
                    "site": site,
                    "status": "succeeded",
                    "addresses": [
                        {
                            "id": f"{site}-{index}",
                            "url": f"https://example.invalid/{site}/{index}",
                            "label": f"{site} {index}",
                            "metadata": {"tags": []},
                        }
                        for index in range(200)
                    ],
                    "weak_evidence": [],
                    "tag_facets": [],
                }
                for site in sites
            ],
            "related_profiles": [],
        }
        with patch(
            "gdl_backend.api_routes.discovery._perform_search",
            new=AsyncMock(return_value=raw),
        ):
            response = self.client.post(
                "/api/v1/search?view=desktop",
                headers=self.headers,
                json={"sites": ["danbooru"], "keyword": "artist", "limit": 200},
            )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertFalse(payload["projection_truncated"])
        self.assertEqual(payload["candidate_limit"], 1_000)
        self.assertEqual(
            sum(len(source["addresses"]) for source in payload["sources"]),
            1_000,
        )
        self.assertLess(len(response.content), 16 * 1024 * 1024)

    def test_proxy_backed_search_skips_local_strict_dns_and_calls_discovery(self):
        self.container.settings.server.allow_private_targets = False
        result = {
            "site": "danbooru",
            "keyword": "proxy-branch-fixture",
            "search_url": "https://danbooru.donmai.us/posts?tags=proxy-branch-fixture",
            "candidate_count": 0,
            "author_count": 0,
            "candidates": [],
            "authors": [],
            "proxy": {"mode": "required", "used": True, "node_id": "node-2"},
            "attempts": 2,
        }
        self.container.discovery.search = AsyncMock(return_value=result)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        getaddrinfo = Mock(
            return_value=[(None, None, None, None, ("2001::4a56:cac", 443))]
        )

        with patch("gdl_backend.app.socket.getaddrinfo", getaddrinfo):
            response = self.client.post(
                "/api/v1/search",
                headers=self.headers,
                json={
                    "sites": ["danbooru"],
                    "keyword": "proxy-branch-fixture",
                    "limit": 5,
                    "proxy_mode": "required",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        source = response.json()["sources"][0]
        self.assertEqual(source["status"], "succeeded")
        self.assertIsNone(source["error"])
        self.assertNotEqual((source.get("error") or {}).get("code"), "invalid_search_source")
        self.assertEqual(source["attempts"], 2)
        self.container.discovery.search.assert_awaited_once()
        self.assertEqual(
            self.container.discovery.search.await_args.kwargs["proxy_mode"],
            "required",
        )
        getaddrinfo.assert_not_called()

    def test_direct_search_uses_local_strict_dns_and_rejects_teredo(self):
        self.container.settings.server.allow_private_targets = False
        self.container.discovery.search = AsyncMock()
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        getaddrinfo = Mock(
            return_value=[(None, None, None, None, ("2001::4a56:cac", 443))]
        )

        with patch("gdl_backend.app.socket.getaddrinfo", getaddrinfo):
            response = self.client.post(
                "/api/v1/search",
                headers=self.headers,
                json={
                    "sites": ["danbooru"],
                    "keyword": "direct-branch-fixture",
                    "limit": 5,
                    "proxy_mode": "direct",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        source = response.json()["sources"][0]
        self.assertEqual(source["status"], "failed")
        self.assertEqual(source["error"]["code"], "invalid_search_source")
        self.assertEqual(source["address_count"], 0)
        getaddrinfo.assert_called_once()
        self.container.discovery.search.assert_not_awaited()

    def test_encrypted_dns_source_error_projection_is_redacted(self):
        private_keyword = "PRIVATE_API_KEYWORD_8c4f2a"
        endpoint = "http://127.0.0.1:29077"
        raw_secret = "RAW_TLS_RESPONSE_SECRET"
        lease = ProxyLease(
            task_id="fixture-task",
            node_id="node-private",
            endpoint=endpoint,
            name="fixture-node",
            protocol="http",
            tags=[],
            acquired_at=1.0,
        )
        dns_error = EncryptedDNSError(
            "encrypted_dns_unavailable",
            "代理节点的加密 DNS TLS 连接失败",
            retryable=True,
            proxy_fault=True,
        )
        dns_error.__cause__ = RuntimeError(raw_secret)
        projected = self.container.discovery._network_error(
            dns_error,
            mode="required",
            lease=lease,
            attempts=2,
        )
        self.container.discovery.search = AsyncMock(side_effect=projected)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )

        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["danbooru"],
                "keyword": private_keyword,
                "limit": 5,
                "proxy_mode": "required",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        source = response.json()["sources"][0]
        self.assertEqual(source["status"], "failed")
        self.assertEqual(source["error"]["code"], "encrypted_dns_unavailable")
        self.assertEqual(source["attempts"], 2)
        rendered = str({"error": source["error"], "proxy": source["proxy"]})
        for secret in (
            endpoint,
            "127.0.0.1",
            "29077",
            "danbooru.donmai.us",
            private_keyword,
            raw_secret,
        ):
            self.assertNotIn(secret, rendered)
        self.assertNotIn("endpoint", source["proxy"])

    def test_proxy_doh_cache_allows_required_crawl_without_rewriting_url(self):
        doh = self._prime_danbooru_proxy_cache()
        proxy_acquire = Mock(side_effect=AssertionError("创建批次不应申请代理租约"))
        self.container.proxy.acquire = proxy_acquire
        expected_url = "https://danbooru.donmai.us/posts/123"

        with patch(
            "gdl_backend.app.socket.getaddrinfo",
            return_value=self._mixed_dns_entries(),
        ):
            response = self.client.post(
                "/api/v1/crawls",
                headers=self.headers,
                json=self._danbooru_crawl_payload(body_mode="required"),
            )

        self.assertEqual(response.status_code, 202, response.text)
        batch = self.container.db.get_crawl_batch(response.json()["id"])
        address = batch["sources"][0]["addresses"][0]
        self.assertEqual(address["url"], expected_url)
        self.assertEqual(address["proxy_mode"], "required")
        self.assertNotIn("1.1.1.1", address["url"])
        self.assertEqual(doh.resolve.call_count, 1)
        proxy_acquire.assert_not_called()

    def test_cached_proxy_doh_result_does_not_bypass_direct_crawl_dns_failure(self):
        doh = self._prime_danbooru_proxy_cache()
        original_create = self.container.db.create_crawl_batch

        with (
            patch(
                "gdl_backend.app.socket.getaddrinfo",
                return_value=self._mixed_dns_entries(),
            ),
            patch.object(
                self.container.db,
                "create_crawl_batch",
                wraps=original_create,
            ) as create_batch,
        ):
            response = self.client.post(
                "/api/v1/crawls",
                headers=self.headers,
                json=self._danbooru_crawl_payload(body_mode="direct"),
            )

        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["error"]["code"], "invalid_crawl")
        self.assertIn("2001::4a56:cac", response.json()["error"]["message"])
        create_batch.assert_not_called()
        self.assertEqual(doh.resolve.call_count, 1)

    def test_non_direct_cache_miss_keeps_original_422_without_database_write(self):
        self._configure_strict_crawl_network()
        doh = Mock()
        self.container.network_validator.encrypted_dns = doh
        original_create = self.container.db.create_crawl_batch

        with (
            patch(
                "gdl_backend.app.socket.getaddrinfo",
                return_value=self._mixed_dns_entries(),
            ),
            patch.object(
                self.container.db,
                "create_crawl_batch",
                wraps=original_create,
            ) as create_batch,
        ):
            response = self.client.post(
                "/api/v1/crawls",
                headers=self.headers,
                json=self._danbooru_crawl_payload(body_mode="prefer"),
            )

        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["error"]["code"], "invalid_crawl")
        self.assertIn("2001::4a56:cac", response.json()["error"]["message"])
        create_batch.assert_not_called()
        doh.resolve.assert_not_called()

    def test_expired_proxy_doh_cache_keeps_original_422_without_database_write(self):
        clock = _FakeMonotonicClock()
        validator = NetworkTargetValidator(
            allow_private_targets=False,
            strict_target_dns=True,
            encrypted_dns=Mock(),
            proxy_doh_cache_ttl_seconds=1.0,
            monotonic_clock=clock,
        )
        self.container.network_validator = validator
        doh = self._prime_danbooru_proxy_cache(validator=validator)
        clock.now = 1.0
        original_create = self.container.db.create_crawl_batch

        with (
            patch(
                "gdl_backend.app.socket.getaddrinfo",
                return_value=self._mixed_dns_entries(),
            ),
            patch.object(
                self.container.db,
                "create_crawl_batch",
                wraps=original_create,
            ) as create_batch,
        ):
            response = self.client.post(
                "/api/v1/crawls",
                headers=self.headers,
                json=self._danbooru_crawl_payload(body_mode="required"),
            )

        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["error"]["code"], "invalid_crawl")
        self.assertIn("2001::4a56:cac", response.json()["error"]["message"])
        create_batch.assert_not_called()
        self.assertEqual(doh.resolve.call_count, 1)

    def test_malformed_private_and_non_exact_hostnames_cannot_borrow_proxy_cache(self):
        doh = self._prime_danbooru_proxy_cache()
        original_create = self.container.db.create_crawl_batch
        rejected = {
            "malformed": "https:///missing-host",
            "private_literal": "https://127.0.0.1/posts/123",
            "different_subdomain": "https://sub.danbooru.donmai.us/posts/123",
        }

        with (
            patch(
                "gdl_backend.app.socket.getaddrinfo",
                return_value=self._mixed_dns_entries(),
            ),
            patch.object(
                self.container.db,
                "create_crawl_batch",
                wraps=original_create,
            ) as create_batch,
        ):
            for name, url in rejected.items():
                with self.subTest(name=name):
                    response = self.client.post(
                        "/api/v1/crawls",
                        headers=self.headers,
                        json=self._danbooru_crawl_payload(
                            body_mode="required",
                            url=url,
                        ),
                    )
                    self.assertEqual(response.status_code, 422, response.text)

        create_batch.assert_not_called()
        self.assertEqual(doh.resolve.call_count, 1)

    def test_crawl_cache_fallback_uses_source_body_and_policy_effective_proxy_mode(self):
        doh = self._prime_danbooru_proxy_cache()
        self.container.db.put_site_policy(
            "danbooru",
            self._policy_view_payload(proxy_mode="prefer"),
        )

        with patch(
            "gdl_backend.app.socket.getaddrinfo",
            return_value=self._mixed_dns_entries(),
        ):
            policy_response = self.client.post(
                "/api/v1/crawls",
                headers=self.headers,
                json=self._danbooru_crawl_payload(),
            )
            source_response = self.client.post(
                "/api/v1/crawls",
                headers=self.headers,
                json=self._danbooru_crawl_payload(
                    body_mode="direct",
                    source_mode="required",
                ),
            )
            body_response = self.client.post(
                "/api/v1/crawls",
                headers=self.headers,
                json=self._danbooru_crawl_payload(body_mode="direct"),
            )

        self.assertEqual(policy_response.status_code, 202, policy_response.text)
        self.assertEqual(
            policy_response.json()["sources"][0]["addresses"][0]["proxy_mode"],
            "prefer",
        )
        self.assertEqual(source_response.status_code, 202, source_response.text)
        self.assertEqual(
            source_response.json()["sources"][0]["addresses"][0]["proxy_mode"],
            "required",
        )
        self.assertEqual(body_response.status_code, 422, body_response.text)
        self.assertIn(
            "2001::4a56:cac",
            body_response.json()["error"]["message"],
        )
        self.assertEqual(doh.resolve.call_count, 1)

    def test_exhentai_search_returns_selectable_galleries_with_previews(self):
        raw = {
            "site": "exhentai",
            "keyword": "ogipote",
            "search_url": "https://e-hentai.org/?f_search=ogipote",
            "candidate_count": 1,
            "author_count": 0,
            "candidates": [
                {
                    "id": "3079340",
                    "site": "exhentai",
                    "kind": "gallery",
                    "title": "Gallery 3079340",
                    "url": "https://e-hentai.org/g/3079340/991425f1c4/",
                    "download_url": "https://e-hentai.org/g/3079340/991425f1c4/",
                    "thumbnail_url": None,
                    "media_count": None,
                    "metadata": {"gallery_token": "991425f1c4"},
                }
            ],
            "authors": [],
            "proxy": {"used": False},
            "attempts": 1,
        }
        enriched = {
            **raw,
            "preview_count": 1,
            "preview_missing_count": 0,
            "candidates": [
                {
                    **raw["candidates"][0],
                    "title": "(C104) Catchy & Punk",
                    "thumbnail_url": "https://ehgt.org/w/cover.webp",
                    "media_count": 13,
                    "metadata": {
                        "gallery_token": "991425f1c4",
                        "tags": ["artist:ogipote"],
                    },
                }
            ],
        }
        self.container.discovery.search = AsyncMock(return_value=raw)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        self.container.discovery.enrich_exhentai_previews = AsyncMock(
            return_value=enriched
        )

        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["eh"],
                "keyword": "ogipote",
                "limit": 20,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        source = response.json()["sources"][0]
        self.assertEqual(source["address_count"], 1)
        self.assertEqual(source["weak_evidence_count"], 0)
        self.assertEqual(source["preview_count"], 1)
        self.assertEqual(source["preview_missing_count"], 0)
        gallery = source["addresses"][0]
        self.assertEqual(gallery["confidence"], "site_search")
        self.assertEqual(gallery["label"], "(C104) Catchy & Punk")
        self.assertEqual(gallery["thumbnail_url"], "https://ehgt.org/w/cover.webp")
        self.assertEqual(gallery["media_count"], 13)
        self.assertEqual(gallery["metadata"]["tags"], ["artist:ogipote"])
        self.assertEqual(source["tag_facets"][0]["namespace"], "artist")
        self.assertEqual(source["tag_facets"][0]["tags"][0]["tag"], "artist:ogipote")
        self.assertEqual(source["weak_evidence"], [])
        self.assertEqual(
            response.json()["tag_filter_contract"]["same_namespace"],
            "or",
        )
        self.container.discovery.enrich_exhentai_previews.assert_awaited_once()

    def test_exhentai_preview_failure_keeps_all_galleries_selectable(self):
        raw = {
            "site": "exhentai",
            "keyword": "ogipote",
            "search_url": "https://e-hentai.org/?f_search=ogipote",
            "candidate_count": 1,
            "author_count": 0,
            "candidates": [
                {
                    "id": "3079340",
                    "site": "exhentai",
                    "kind": "gallery",
                    "title": "Gallery 3079340",
                    "url": "https://e-hentai.org/g/3079340/991425f1c4/",
                    "download_url": "https://e-hentai.org/g/3079340/991425f1c4/",
                    "thumbnail_url": None,
                    "media_count": None,
                    "metadata": {"gallery_token": "991425f1c4"},
                }
            ],
            "authors": [],
            "proxy": {"used": False},
            "attempts": 1,
        }
        self.container.discovery.search = AsyncMock(return_value=raw)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        self.container.discovery.enrich_exhentai_previews = AsyncMock(
            side_effect=DiscoveryError("exhentai_preview_lookup_failed", "temporary")
        )

        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["eh"],
                "keyword": "ogipote",
                "limit": 20,
                "proxy_mode": "direct",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        source = response.json()["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertEqual(source["address_count"], 1)
        self.assertEqual(source["weak_evidence_count"], 0)
        self.assertEqual(source["preview_count"], 0)
        self.assertEqual(source["preview_missing_count"], 1)
        self.assertEqual(source["addresses"][0]["confidence"], "site_search")
        self.assertEqual(
            source["enrichment_errors"][0]["stage"],
            "exhentai_gallery_previews",
        )

    def test_exhentai_search_expands_danbooru_aliases(self):
        def gallery(gid: str, token: str) -> dict:
            url = f"https://e-hentai.org/g/{gid}/{token}/"
            return {
                "id": gid,
                "site": "exhentai",
                "kind": "gallery",
                "title": f"Gallery {gid}",
                "url": url,
                "download_url": url,
                "thumbnail_url": None,
                "media_count": None,
                "metadata": {},
            }

        async def search_side_effect(*, site, keyword, **kwargs):
            self.assertEqual(site, "exhentai")
            candidates = {
                "wlop": [gallery("100", "aaaaaaaaaa")],
                "王凌": [gallery("100", "aaaaaaaaaa"), gallery("200", "bbbbbbbbbb")],
                "wlopwangling": [],
            }[keyword]
            return {
                "site": site,
                "keyword": keyword,
                "search_url": "https://e-hentai.org/?f_search=wlop",
                "candidate_count": len(candidates),
                "author_count": 0,
                "candidates": candidates,
                "authors": [],
                "proxy": {"used": False},
                "attempts": 1,
            }

        self.container.discovery.search = AsyncMock(side_effect=search_side_effect)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={
                "authors": [
                    {
                        "name": "wlop",
                        "other_names": ["王凌", "wlopwangling"],
                        "origin": "danbooru_artist_directory",
                    }
                ]
            }
        )
        self.container.discovery.enrich_exhentai_previews = AsyncMock(
            side_effect=lambda result, **kwargs: result
        )

        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["eh"],
                "keyword": "wlop",
                "limit": 20,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        source = response.json()["sources"][0]
        self.assertEqual(source["status"], "succeeded")
        self.assertEqual(source["alias_keywords"], ["王凌", "wlopwangling"])
        self.assertEqual(source["address_count"], 2)
        by_label = {item["label"]: item for item in source["addresses"]}
        self.assertEqual(
            by_label["Gallery 100"]["evidence_reasons"],
            ["keyword_gallery_search", "danbooru_alias_search"],
        )
        self.assertEqual(
            by_label["Gallery 200"]["evidence_reasons"],
            ["danbooru_alias_search"],
        )
        self.assertEqual(by_label["Gallery 200"]["matched_keywords"], ["王凌"])
        searched = sorted(
            call.kwargs["keyword"]
            for call in self.container.discovery.search.await_args_list
        )
        self.assertEqual(searched, sorted(["wlop", "王凌", "wlopwangling"]))
        self.container.discovery.search_danbooru_artists.assert_awaited_once()

    def test_exhentai_alias_lookup_failure_degrades_to_plain_search(self):
        raw = {
            "site": "exhentai",
            "keyword": "wlop",
            "search_url": "https://e-hentai.org/?f_search=wlop",
            "candidate_count": 1,
            "author_count": 0,
            "candidates": [
                {
                    "id": "100",
                    "site": "exhentai",
                    "kind": "gallery",
                    "title": "Gallery 100",
                    "url": "https://e-hentai.org/g/100/aaaaaaaaaa/",
                    "download_url": "https://e-hentai.org/g/100/aaaaaaaaaa/",
                    "thumbnail_url": None,
                    "media_count": None,
                    "metadata": {},
                }
            ],
            "authors": [],
            "proxy": {"used": False},
            "attempts": 1,
        }
        self.container.discovery.search = AsyncMock(return_value=raw)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            side_effect=DiscoveryError("danbooru_api_protocol", "directory down")
        )
        self.container.discovery.enrich_exhentai_previews = AsyncMock(
            side_effect=lambda result, **kwargs: result
        )

        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["eh"],
                "keyword": "wlop",
                "limit": 20,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        source = response.json()["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertEqual(source["alias_keywords"], [])
        self.assertEqual(source["address_count"], 1)
        self.assertEqual(
            source["enrichment_errors"][0]["stage"], "danbooru_alias_lookup"
        )
        self.assertEqual(
            source["addresses"][0]["evidence_reasons"], ["keyword_gallery_search"]
        )
        self.container.discovery.search.assert_awaited_once()

    def test_search_failure_log_does_not_persist_user_query(self):
        private_query = "PRIVATE_USER_QUERY_8c4f2a"
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        self.container.discovery.search = AsyncMock(
            side_effect=DiscoveryError("fixture_search_failed", "受控上游失败")
        )
        with self.assertLogs("gdl_backend.search", level="WARNING") as captured:
            response = self.client.post(
                "/api/v1/search",
                json={
                    "sites": ["pawchive"],
                    "keyword": private_query,
                    "limit": 5,
                    "proxy_mode": "direct",
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["sources"][0]["status"], "failed")
        logs = "\n".join(captured.output)
        self.assertNotIn(private_query, logs)
        self.assertNotIn("受控上游失败", logs)
        self.assertIn("site=pawchive", logs)
        self.assertIn("error_code=fixture_search_failed", logs)

    def test_search_autocomplete_endpoint(self):
        self.container.discovery.danbooru_autocomplete = AsyncMock(
            return_value={
                "query": "柠檬静",
                "items": [
                    {
                        "value": "ningmeng_jing_jing_jing_jing",
                        "label": "ningmeng jing jing jing jing",
                        "match_type": "tag-other-name",
                        "antecedent": "柠檬静静静静",
                        "category": "artist",
                        "post_count": 255,
                    }
                ],
                "proxy": {"used": False},
                "attempts": 1,
            }
        )
        response = self.client.get(
            "/api/v1/search/autocomplete",
            headers=self.headers,
            params={"q": "柠檬静"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["source"], "danbooru")
        self.assertEqual(payload["query"], "柠檬静")
        self.assertEqual(
            payload["items"][0]["value"], "ningmeng_jing_jing_jing_jing"
        )
        self.assertEqual(payload["items"][0]["antecedent"], "柠檬静静静静")
        call = self.container.discovery.danbooru_autocomplete.await_args
        self.assertEqual(call.args[0], "柠檬静")
        self.assertEqual(call.kwargs["limit"], 10)

        blank = self.client.get(
            "/api/v1/search/autocomplete", headers=self.headers, params={"q": "  "}
        )
        self.assertEqual(blank.status_code, 422)

        self.container.discovery.danbooru_autocomplete = AsyncMock(
            side_effect=DiscoveryError("danbooru_api_protocol", "bad upstream")
        )
        failed = self.client.get(
            "/api/v1/search/autocomplete", headers=self.headers, params={"q": "abc"}
        )
        self.assertEqual(failed.status_code, 502)

    def test_cross_source_search_uses_danbooru_curated_profiles(self):
        async def search_side_effect(*, site, keyword, **kwargs):
            if site == "danbooru":
                return {
                    "site": site,
                    "keyword": keyword,
                    "search_url": "https://danbooru.donmai.us/posts?tags=artist_name",
                    "candidate_count": 1,
                    "author_count": 1,
                    "candidates": [
                        {
                            "id": "10",
                            "site": "danbooru",
                            "kind": "post",
                            "metadata": {
                                "artists": ["artist_name"],
                                "characters": ["character_name"],
                            },
                        }
                    ],
                    "authors": [
                        {
                            "name": "artist_name",
                            "url": "https://danbooru.donmai.us/artists?search[name]=artist_name",
                            "works_url": "https://danbooru.donmai.us/posts?tags=artist_name",
                        }
                    ],
                    "proxy": {"used": False},
                    "attempts": 1,
                }
            return {
                "site": site,
                "keyword": keyword,
                "search_url": "https://example.invalid/search",
                "candidate_count": 0,
                "author_count": 0,
                "candidates": [],
                "authors": [],
                "proxy": {"used": False},
                "attempts": 1,
            }

        self.container.discovery.search = AsyncMock(side_effect=search_side_effect)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        self.container.discovery.danbooru_artist_profiles = AsyncMock(
            return_value=(
                [
                    {
                        "id": "55",
                        "name": "artist_name",
                        "other_names": ["Artist Name"],
                        "group_name": None,
                        "profile_url": "https://danbooru.donmai.us/artists/55",
                        "related_profiles": [
                            {
                                "url": "https://x.com/artist_name",
                                "platform": "twitter",
                                "crawl_site": "twitter",
                                "crawl_url": "https://x.com/artist_name/media",
                                "active": True,
                            },
                            {
                                "url": "https://www.pixiv.net/users/77",
                                "platform": "pixiv",
                                "crawl_site": "pixiv",
                                "crawl_url": "https://www.pixiv.net/users/77/artworks",
                                "active": True,
                            },
                            {
                                "url": "https://x.com/artist_alt",
                                "platform": "twitter",
                                "crawl_site": "twitter",
                                "crawl_url": "https://x.com/artist_alt/media",
                                "active": True,
                            },
                        ],
                    }
                ],
                [],
            )
        )
        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["danbooru", "x", "pixiv"],
                "keyword": "artist name",
                "limit": 2,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            [item["site"] for item in response.json()["sources"]],
            ["danbooru", "twitter", "pixiv"],
        )
        sources = {item["site"]: item for item in response.json()["sources"]}
        dan_types = {item["address_type"] for item in sources["danbooru"]["addresses"]}
        self.assertEqual(dan_types, {"artist_tag"})
        self.assertNotIn(
            "character_name",
            {item.get("tag") for item in sources["danbooru"]["addresses"]},
        )
        self.assertEqual(sources["twitter"]["addresses"][0]["url"], "https://x.com/artist_name/media")
        self.assertEqual(sources["pixiv"]["addresses"][0]["url"], "https://www.pixiv.net/users/77/artworks")
        self.assertEqual(sources["twitter"]["addresses"][0]["origin"], "danbooru_artist_url")
        self.assertEqual(sources["pixiv"]["addresses"][0]["confidence"], "verified")
        self.assertEqual(sources["pixiv"]["addresses"][0]["origin"], "danbooru_artist_url")
        self.assertIn(
            "danbooru_artist_url",
            sources["pixiv"]["addresses"][0]["evidence_reasons"],
        )
        self.assertEqual(sources["pixiv"]["weak_evidence_count"], 0)
        self.assertEqual(len(sources["twitter"]["addresses"]), 2)
        self.assertEqual(response.json()["weak_evidence_count"], 0)
        self.assertEqual(len(response.json()["related_profiles"]), 3)
        searched_sites = [call.kwargs["site"] for call in self.container.discovery.search.await_args_list]
        self.assertEqual(searched_sites, ["danbooru"])
        self.assertEqual(sources["twitter"]["search_strategy"], "danbooru_artist_urls")
        self.assertEqual(sources["pixiv"]["search_strategy"], "danbooru_artist_urls")

    def test_account_discovery_failure_marks_x_pixiv_partial(self):
        async def search_side_effect(*, site, keyword, **kwargs):
            self.assertEqual(site, "danbooru")
            return {
                "site": site,
                "keyword": keyword,
                "search_url": "https://danbooru.donmai.us/posts?tags=artist_name",
                "candidate_count": 1,
                "author_count": 0,
                "candidates": [
                    {
                        "id": "10",
                        "site": "danbooru",
                        "kind": "post",
                        "metadata": {"artists": ["artist_name"]},
                    }
                ],
                "authors": [],
                "proxy": {"used": False},
                "attempts": 1,
            }

        self.container.discovery.search = AsyncMock(side_effect=search_side_effect)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        self.container.discovery.danbooru_artist_profiles = AsyncMock(
            side_effect=DiscoveryError("discovery_failed", "proxy node flaked")
        )
        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={
                "sites": ["danbooru", "x", "pixiv"],
                "keyword": "artist_name",
                "limit": 5,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        sources = {item["site"]: item for item in response.json()["sources"]}
        self.assertEqual(sources["danbooru"]["status"], "partial")
        for affected in ("twitter", "pixiv"):
            self.assertEqual(sources[affected]["status"], "partial")
            self.assertEqual(sources[affected]["addresses"], [])
            stages = [
                item["stage"] for item in sources[affected]["enrichment_errors"]
            ]
            self.assertIn("danbooru_account_discovery", stages)
            self.assertIn(
                "proxy node flaked",
                sources[affected]["enrichment_errors"][-1]["message"],
            )

    def test_cross_source_search_skips_native_account_lookups(self):
        async def search_side_effect(*, site, keyword, **kwargs):
            self.assertEqual(site, "danbooru")
            return {
                "site": site,
                "keyword": keyword,
                "search_url": "https://x.com/search?q=artist",
                "candidate_count": 0,
                "author_count": 0,
                "candidates": [],
                "authors": [],
                "proxy": {"used": False},
                "attempts": 1,
            }

        self.container.discovery.search = AsyncMock(side_effect=search_side_effect)
        self.container.discovery.search_danbooru_artists = AsyncMock(
            return_value={"authors": []}
        )
        response = self.client.post(
            "/api/v1/search",
            headers=self.headers,
            json={"keyword": "artist", "sites": ["pixiv", "x"], "proxy_mode": "direct"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            [source["site"] for source in response.json()["sources"]],
            ["pixiv", "twitter"],
        )
        self.assertEqual(response.json()["sources"][0]["status"], "succeeded")
        self.assertEqual(response.json()["sources"][1]["status"], "succeeded")
        self.assertEqual(
            [call.kwargs["site"] for call in self.container.discovery.search.await_args_list],
            ["danbooru"],
        )
        self.container.discovery.search_danbooru_artists.assert_awaited_once()

    def test_ordered_crawl_sequence_and_batch_idempotency(self):
        async def discover_side_effect(*, site, url, **kwargs):
            count = 2 if url.endswith("artist-a/media") else 1
            work_id = "1" if "artist-a" in url else "2"
            work_url = (
                f"https://x.com/example/status/{work_id}"
                if site == "twitter"
                else f"https://www.pixiv.net/artworks/{work_id}"
            )
            candidate = {
                "id": work_id,
                "site": site,
                "kind": "work",
                "url": work_url,
                "media_count": count,
            }
            if site == "twitter":
                candidate["media_urls"] = [
                    f"https://pbs.twimg.com/media/sample-{work_id}-{index}?format=jpg&name=orig"
                    for index in range(1, count + 1)
                ]
            return {"candidates": [candidate]}

        self.container.discovery.discover_url = AsyncMock(side_effect=discover_side_effect)
        cookie_path = self.container.auth.managed_dir / "twitter.cookies.txt"
        cookie_path.write_text(
            "# Netscape HTTP Cookie File\n\n"
            ".x.com\tTRUE\t/\tTRUE\t4102444800\tauth_token\tSECRET\n"
            ".x.com\tTRUE\t/\tTRUE\t4102444800\tct0\tSECRET2\n",
            encoding="utf-8",
        )
        body = {
            "sources": [
                {
                    "site": "x",
                    "addresses": [
                        {"url": "https://x.com/artist-a/media", "label": "A"},
                        {"url": "https://x.com/artist-b/media", "label": "B"},
                    ],
                    "extra_args": ["--filter", "favorite_count >= 0"],
                },
                {
                    "site": "pixiv",
                    "addresses": [
                        {"url": "https://www.pixiv.net/users/77/artworks", "label": "P"}
                    ],
                },
            ],
            "concurrency": 20,
            "proxy_mode": "direct",
            "extra_args": ["--sleep", "0"],
        }
        headers = {**self.headers, "Idempotency-Key": "ordered-batch"}
        first = self.client.post("/api/v1/crawls", headers=headers, json=body)
        self.assertEqual(first.status_code, 202, first.text)
        batch_id = first.json()["id"]
        self.assertEqual(first.json()["task_count"], 0)
        self.assertEqual(first.json()["execution_order"], "source_then_address")

        second = self.client.post("/api/v1/crawls", headers=headers, json=body)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["id"], batch_id)

        import asyncio

        asyncio.run(self.container.ordered_crawls.run_once())
        active = self.container.db.get_crawl_batch(batch_id)
        first_address = active["sources"][0]["addresses"][0]
        self.assertEqual(first_address["status"], "running")
        self.assertEqual(first_address["planned_task_count"], 2)
        self.assertEqual(active["sources"][0]["addresses"][1]["status"], "pending")
        self.assertEqual(active["sources"][1]["addresses"][0]["status"], "pending")
        tasks = self.container.db.list_crawl_tasks(batch_id)
        self.assertEqual(len(tasks), 2)
        self.assertTrue(all(task["address_order"] == 0 for task in tasks))
        self.assertEqual(
            [task["url"] for task in tasks],
            [
                "https://pbs.twimg.com/media/sample-1-1?format=jpg&name=orig",
                "https://pbs.twimg.com/media/sample-1-2?format=jpg&name=orig",
            ],
        )
        self.assertTrue(all(task["cookies_file"] is None for task in tasks))
        self.assertTrue(all("--range" not in task["extra_args"] for task in tasks))
        self.assertEqual(tasks[0]["policy"]["max_concurrency"], 20)
        self.assertEqual(
            tasks[0]["extra_args"][:4],
            ["--sleep", "0", "--filter", "favorite_count >= 0"],
        )
        listing = self.client.get("/api/v1/crawls?limit=1", headers=self.headers)
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertEqual(listing.json()["items"][0]["id"], batch_id)
        detail = self.client.get(f"/api/v1/crawls/{batch_id}", headers=self.headers)
        self.assertEqual(detail.status_code, 200, detail.text)
        task_page = self.client.get(
            f"/api/v1/crawls/{batch_id}/tasks?limit=1",
            headers=self.headers,
        )
        self.assertEqual(task_page.status_code, 200, task_page.text)
        self.assertEqual(len(task_page.json()["items"]), 1)
        missing = self.client.get("/api/v1/crawls/missing", headers=self.headers)
        self.assertEqual(missing.status_code, 404)

        for task in tasks:
            self.container.db.complete_task(task["id"], "succeeded")
        asyncio.run(self.container.ordered_crawls.run_once())
        asyncio.run(self.container.ordered_crawls.run_once())
        progressed = self.container.db.get_crawl_batch(batch_id)
        self.assertEqual(progressed["sources"][0]["addresses"][0]["status"], "succeeded")
        self.assertEqual(progressed["sources"][0]["addresses"][1]["status"], "running")
        self.assertEqual(progressed["sources"][1]["addresses"][0]["status"], "pending")
        self.assertEqual(len(self.container.db.list_crawl_tasks(batch_id)), 3)

    def test_crawl_task_tasks_view_projects_a_full_desktop_page(self):
        batch_id = "batch-task-view"
        tasks = [
            {
                "id": f"task-{index}",
                "site": "danbooru",
                "status": "queued",
                "source_order": 0,
                "address_order": 0,
                "sequence_no": index + 1,
                "attempt_count": 0,
                "max_attempts": 3,
                "crawl_address_id": "address-task-view",
                "artifact_count": 0,
                "artifact_bytes": 0,
                "last_error_class": "",
                "url": f"https://danbooru.donmai.us/posts/{index}",
                "output_dir": "/private/output/" + ("x" * 512),
                "last_error": "private upstream response " + ("x" * 1_024),
                "policy": {"private": "x" * 512},
            }
            for index in range(100)
        ]
        with (
            patch.object(
                self.container.db,
                "get_crawl_batch",
                return_value={"id": batch_id},
            ),
            patch.object(self.container.db, "list_crawl_tasks", return_value=tasks),
        ):
            legacy = self.client.get(
                f"/api/v1/crawls/{batch_id}/tasks?limit=100",
                headers=self.headers,
            )
            response = self.client.get(
                f"/api/v1/crawls/{batch_id}/tasks?limit=100&view=tasks",
                headers=self.headers,
            )

        self.assertEqual(legacy.status_code, 200, legacy.text)
        self.assertGreater(len(legacy.text), 65_536)
        self.assertEqual(legacy.json()["items"][0]["url"], tasks[0]["url"])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertLess(len(response.text), 65_536)
        payload = response.json()
        self.assertEqual(payload["limit"], 100)
        self.assertEqual(payload["offset"], 0)
        self.assertEqual(len(payload["items"]), 100)
        self.assertEqual(
            set(payload["items"][0]),
            {
                "id",
                "site",
                "status",
                "source_order",
                "address_order",
                "sequence_no",
                "attempt_count",
                "max_attempts",
                "crawl_address_id",
                "artifact_count",
                "artifact_bytes",
                "last_error_class",
            },
        )
        self.assertNotIn("url", payload["items"][0])
        self.assertNotIn("output_dir", payload["items"][0])
        self.assertNotIn("policy", payload["items"][0])
        self.assertNotIn("last_error", payload["items"][0])


    def test_desktop_crawl_views_project_recent_and_authority_payloads(self):
        batch_id = "batch-desktop-view"
        private = "private-credential-" + ("x" * 70_000)
        batch = {
            "id": batch_id,
            "status": "running",
            "created_at": 1.0,
            "updated_at": 2.0,
            "finished_at": None,
            "cancel_requested": False,
            "concurrency": 4,
            "max_tasks": 10_000,
            "task_count": 2,
            "succeeded_task_count": 1,
            "failed_task_count": 0,
            "cancelled_task_count": 0,
            "pre_dedup_skipped_count": 0,
            "resumable": False,
            "current": None,
            "output_dir": private,
            "sources": [{
                "order": 0,
                "site": "danbooru",
                "status": "running",
                "pre_dedup_skipped_count": 0,
                "addresses": [{
                    "id": "address-desktop-view",
                    "address_order": 0,
                    "label": "artist",
                    "address_type": "artist_tag",
                    "status": "running",
                    "planned_task_count": 2,
                    "succeeded_task_count": 1,
                    "failed_task_count": 0,
                    "cancelled_task_count": 0,
                    "pre_dedup_skipped_count": 0,
                    "probed_proxy_count": 4,
                    "healthy_proxy_count": 3,
                    "url": private,
                    "cookies_file": private,
                    "planning_error": private,
                }],
            }],
            "review": None,
        }
        with (
            patch.object(self.container.db, "get_crawl_batch", return_value=batch),
            patch.object(self.container.db, "list_crawl_batches", return_value=[batch]),
        ):
            legacy = self.client.get(
                f"/api/v1/crawls/{batch_id}", headers=self.headers
            )
            detail = self.client.get(
                f"/api/v1/crawls/{batch_id}?view=desktop", headers=self.headers
            )
            recent = self.client.get(
                "/api/v1/crawls?limit=30&view=desktop", headers=self.headers
            )

        self.assertGreater(len(legacy.text), 65_536)
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertLess(len(detail.text), 65_536)
        payload = detail.json()
        self.assertEqual(payload["response_profile"], "desktop-crawl-v1")
        address = payload["sources"][0]["addresses"][0]
        self.assertNotIn("url", address)
        self.assertNotIn("cookies_file", address)
        self.assertEqual(address["planning_error"], private[:499] + "…")
        self.assertNotIn(private, detail.text)
        self.assertEqual(
            recent.json()["items"],
            [{"id": batch_id, "status": "running", "created_at": 1.0}],
        )
        from gdl_backend.api_routes.crawls import _desktop_batch_crawl
        large_address = {
            **batch["sources"][0]["addresses"][0],
            "label": "l" * 5_000,
        }
        large_addresses = [large_address] * 500
        large_batch = {
            **batch,
            "sources": [
                {**batch["sources"][0], "order": index, "addresses": large_addresses}
                for index in range(20)
            ],
        }
        bounded = _desktop_batch_crawl(large_batch)
        self.assertTrue(bounded["address_rows_truncated"])
        self.assertEqual(
            sum(len(source["addresses"]) for source in bounded["sources"]),
            2_000,
        )
        self.assertLess(
            len(json.dumps(bounded, ensure_ascii=False).encode("utf-8")),
            4 * 1024 * 1024,
        )

    def test_desktop_crawls_hide_terminal_batches_with_missing_directories(self):
        output_dir = Path(self.temp.name) / "terminal-output"
        output_dir.mkdir()
        terminal = {
            "id": "batch-terminal-output",
            "status": "succeeded",
            "created_at": 2.0,
            "output_dir": str(output_dir),
        }
        running = {
            "id": "batch-running-output",
            "status": "running",
            "created_at": 1.0,
            "output_dir": str(Path(self.temp.name) / "missing-running-output"),
        }
        batches = [terminal, running]

        def list_batches(*, limit: int, offset: int):
            return batches[offset : offset + limit]

        with (
            patch.object(
                self.container.db, "list_crawl_batches", side_effect=list_batches
            ),
            patch.object(
                self.container.db, "get_crawl_batch", return_value=terminal
            ),
        ):
            before = self.client.get(
                "/api/v1/crawls?limit=1&view=desktop", headers=self.headers
            )
            output_dir.rmdir()
            after = self.client.get(
                "/api/v1/crawls?limit=1&view=desktop", headers=self.headers
            )
            after_offset = self.client.get(
                "/api/v1/crawls?limit=1&offset=1&view=desktop",
                headers=self.headers,
            )
            legacy = self.client.get(
                "/api/v1/crawls?limit=1", headers=self.headers
            )
            missing_detail = self.client.get(
                f"/api/v1/crawls/{terminal['id']}?view=desktop",
                headers=self.headers,
            )
            legacy_detail = self.client.get(
                f"/api/v1/crawls/{terminal['id']}", headers=self.headers
            )

        self.assertEqual(
            [item["id"] for item in before.json()["items"]],
            [terminal["id"]],
        )
        self.assertEqual(
            [item["id"] for item in after.json()["items"]],
            [running["id"]],
        )
        self.assertEqual(after_offset.json()["items"], [])
        self.assertEqual(legacy.json()["items"][0]["id"], terminal["id"])
        self.assertEqual(missing_detail.status_code, 404, missing_detail.text)
        self.assertEqual(legacy_detail.status_code, 200, legacy_detail.text)

    def test_ordered_crawl_probes_each_new_address_for_its_site(self):
        import asyncio

        events: list[tuple[str, str]] = []

        def probe(target_url):
            events.append(("probe", target_url))
            return {
                "total": 3,
                "healthy": 2,
                "target": target_url,
                "results": [
                    {"id": "node-a", "healthy": True},
                    {"id": "node-b", "healthy": True},
                    {"id": "node-c", "healthy": False},
                ],
            }

        async def discover(*, site, url, **_kwargs):
            events.append(("discover", site))
            work_url = (
                "https://x.com/example/status/1"
                if site == "twitter"
                else "https://www.pixiv.net/artworks/2"
            )
            return {
                "candidates": [
                    {
                        "id": site,
                        "site": site,
                        "kind": "work",
                        "url": work_url,
                        "media_count": 1,
                    }
                ]
            }

        self.container.proxy.probe_for_target = Mock(side_effect=probe)
        self.container.discovery.discover_url = AsyncMock(side_effect=discover)
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "x",
                        "addresses": [{"url": "https://x.com/artist/media"}],
                    },
                    {
                        "site": "pixiv",
                        "addresses": [
                            {"url": "https://www.pixiv.net/users/77/artworks"}
                        ],
                    },
                ],
                "proxy_mode": "required",
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        batch_id = response.json()["id"]

        asyncio.run(self.container.ordered_crawls.run_once())
        batch = self.container.db.get_crawl_batch(batch_id)
        first_address = batch["sources"][0]["addresses"][0]
        self.assertEqual(events, [("probe", "https://x.com/"), ("discover", "twitter")])
        self.assertEqual(first_address["healthy_proxy_count"], 2)
        self.assertEqual(first_address["probed_proxy_count"], 3)
        first_task = self.container.db.list_crawl_tasks(batch_id)[0]
        self.assertEqual(first_task["policy"]["proxy_probe_scope"], first_address["id"])
        self.assertEqual(first_task["policy"]["probe_url"], "https://x.com/")
        self.assertNotIn("allowed_proxy_ids", first_task["policy"])
        self.assertEqual(
            self.container.db.get_crawl_address_proxy_probe(first_address["id"])["node_ids"],
            ["node-a", "node-b"],
        )

        self.container.db.complete_task(first_task["id"], "succeeded")
        asyncio.run(self.container.ordered_crawls.run_once())
        asyncio.run(self.container.ordered_crawls.run_once())
        self.assertEqual(
            events,
            [
                ("probe", "https://x.com/"),
                ("discover", "twitter"),
                ("probe", "https://www.pixiv.net/"),
                ("discover", "pixiv"),
            ],
        )

    def test_ordered_crawl_pre_deduplicates_pixiv_and_twitter_from_danbooru(self):
        import asyncio

        discovery_limits = []

        async def discover(*, site, **_kwargs):
            limit = int(_kwargs["limit"])
            discovery_limits.append((site, limit))
            if site == "danbooru":
                candidates = [
                    {
                        "id": "10",
                        "site": "danbooru",
                        "kind": "post",
                        "url": "https://danbooru.donmai.us/posts/10",
                        "source_url": (
                            "https://www.pixiv.net/member_illust.php?"
                            "mode=medium&illust_id=100"
                        ),
                        "media_count": 1,
                    },
                    {
                        "id": "11",
                        "site": "danbooru",
                        "kind": "post",
                        "url": "https://danbooru.donmai.us/posts/11",
                        "source_url": "https://www.pixiv.net/artworks/101",
                        "media_count": 1,
                    },
                    {
                        "id": "12",
                        "site": "danbooru",
                        "kind": "post",
                        "url": "https://danbooru.donmai.us/posts/12",
                        "source_url": (
                            "https://i.pximg.net/img-original/img/2026/01/02/"
                            "03/04/05/102_p0.png"
                        ),
                        "media_count": 1,
                    },
                    {
                        "id": "13",
                        "site": "danbooru",
                        "kind": "post",
                        "url": "https://danbooru.donmai.us/posts/13",
                        "source_url": "https://twitter.com/artist/status/200",
                        "media_count": 1,
                    },
                ]
                return {"candidates": candidates[:limit]}
            if site == "pixiv":
                candidates = [
                    {
                        "id": "100",
                        "site": "pixiv",
                        "kind": "work",
                        "url": "https://www.pixiv.net/artworks/100",
                        "media_count": 2,
                    },
                    {
                        "id": "101",
                        "site": "pixiv",
                        "kind": "work",
                        "url": "https://www.pixiv.net/artworks/101",
                        "media_count": 1,
                    },
                    {
                        "id": "102",
                        "site": "pixiv",
                        "kind": "work",
                        "url": "https://www.pixiv.net/artworks/102",
                        "media_count": 1,
                    },
                    {
                        "id": "103",
                        "site": "pixiv",
                        "kind": "work",
                        "url": "https://www.pixiv.net/artworks/103",
                        "media_count": 1,
                    },
                ]
                return {"candidates": candidates[:limit]}
            candidates = [
                {
                    "id": "200",
                    "site": "twitter",
                    "kind": "work",
                    "url": "https://x.com/artist/status/200",
                    "media_count": 1,
                }
            ]
            return {"candidates": candidates[:limit]}

        self.container.discovery.discover_url = AsyncMock(side_effect=discover)
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "danbooru",
                        "addresses": [
                            {"url": "https://danbooru.donmai.us/posts?tags=artist"}
                        ],
                    },
                    {
                        "site": "pixiv",
                        "addresses": [
                            {"url": "https://www.pixiv.net/users/1/artworks"}
                        ],
                    },
                    {
                        "site": "twitter",
                        "addresses": [{"url": "https://x.com/artist/media"}],
                    },
                ],
                "max_tasks": 6,
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        batch_id = response.json()["id"]

        asyncio.run(self.container.ordered_crawls.run_once())
        danbooru_tasks = self.container.db.list_crawl_tasks(batch_id)
        self.assertEqual(len(danbooru_tasks), 4)
        for task in danbooru_tasks:
            self.container.db.complete_task(task["id"], "succeeded")

        asyncio.run(self.container.ordered_crawls.run_once())
        asyncio.run(self.container.ordered_crawls.run_once())
        batch = self.container.db.get_crawl_batch(batch_id)
        pixiv = batch["sources"][1]["addresses"][0]
        self.assertEqual(pixiv["status"], "running")
        self.assertEqual(pixiv["planned_task_count"], 1)
        self.assertEqual(pixiv["pre_dedup_skipped_count"], 4)
        tasks = self.container.db.list_crawl_tasks(batch_id)
        self.assertEqual(len(tasks), 5)
        self.assertEqual(tasks[-1]["url"], "https://www.pixiv.net/artworks/103")
        self.container.db.complete_task(tasks[-1]["id"], "succeeded")

        asyncio.run(self.container.ordered_crawls.run_once())
        asyncio.run(self.container.ordered_crawls.run_once())
        batch = self.container.db.get_crawl_batch(batch_id)
        twitter = batch["sources"][2]["addresses"][0]
        self.assertEqual(batch["status"], "succeeded")
        self.assertEqual(batch["task_count"], 5)
        self.assertEqual(batch["pre_dedup_skipped_count"], 5)
        self.assertEqual(twitter["status"], "succeeded")
        self.assertEqual(twitter["planned_task_count"], 0)
        self.assertEqual(twitter["pre_dedup_skipped_count"], 1)
        self.assertEqual(
            discovery_limits,
            [("danbooru", 7), ("pixiv", 6), ("twitter", 3)],
        )

    def test_required_crawl_stops_before_planning_when_site_probe_has_no_nodes(self):
        import asyncio

        self.container.proxy.probe_for_target = Mock(
            return_value={"total": 2, "healthy": 0, "results": []}
        )
        self.container.discovery.discover_url = AsyncMock()
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "x",
                        "addresses": [{"url": "https://x.com/artist/media"}],
                    }
                ],
                "proxy_mode": "required",
            },
        )
        batch_id = response.json()["id"]

        asyncio.run(self.container.ordered_crawls.run_once())
        batch = self.container.db.get_crawl_batch(batch_id)
        address = batch["sources"][0]["addresses"][0]
        self.assertEqual(address["status"], "failed")
        self.assertEqual(address["healthy_proxy_count"], 0)
        self.assertEqual(address["probed_proxy_count"], 2)
        self.assertIn("图站探活后没有可用代理节点", address["last_error"])
        self.assertEqual(batch["task_count"], 0)
        self.container.discovery.discover_url.assert_not_awaited()

    def test_crawl_contract_rejects_legacy_modes_and_non_gallery_eh_address(self):
        legacy = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "items": [{"url": "https://x.com/artist/media"}],
                "fanout": "media",
            },
        )
        self.assertEqual(legacy.status_code, 422)

        invalid_eh = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "eh",
                        "addresses": [{"url": "https://e-hentai.org/?f_search=tag"}],
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(invalid_eh.status_code, 422, invalid_eh.text)
        self.assertEqual(invalid_eh.json()["error"]["code"], "invalid_crawl")

    def test_eh_download_options_are_persisted_and_reach_media_tasks(self):
        import asyncio

        self.container.crawl_planner.plan_media = AsyncMock(
            return_value=(
                [
                    CrawlUnit(
                        "https://e-hentai.org/s/aaaaaaaaaa/123-1",
                        "exhentai",
                        "media",
                        "123:1",
                        ["--range", "1"],
                    )
                ],
                [],
            )
        )
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "eh",
                        "addresses": [
                            {"url": "https://e-hentai.org/g/123/cccccccccc/"}
                        ],
                        "eh_download": {
                            "image_mode": "original",
                            "gp_policy": "stop",
                        },
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        batch_id = response.json()["id"]
        address = response.json()["sources"][0]["addresses"][0]
        self.assertEqual(
            address["download_options"],
            {"eh": {"image_mode": "original", "gp_policy": "stop"}},
        )

        asyncio.run(self.container.ordered_crawls.run_once())
        tasks = self.container.db.list_crawl_tasks(batch_id)
        self.assertEqual(len(tasks), 1)
        self.assertEqual(
            tasks[0]["policy"]["eh_download"],
            {"image_mode": "original", "gp_policy": "stop"},
        )
        self.assertEqual(tasks[0]["extra_args"], ["--range", "1"])

        wrong_site = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "twitter",
                        "addresses": [{"url": "https://x.com/example/media"}],
                        "eh_download": {"image_mode": "original"},
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(wrong_site.status_code, 422, wrong_site.text)
        self.assertEqual(wrong_site.json()["error"]["code"], "invalid_crawl")

        invalid_mode = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "eh",
                        "addresses": [
                            {"url": "https://e-hentai.org/g/123/cccccccccc/"}
                        ],
                        "eh_download": {"image_mode": "archive"},
                    }
                ]
            },
        )
        self.assertEqual(invalid_mode.status_code, 422, invalid_mode.text)

    def test_resolver_called_once_per_chunk(self):
        import asyncio

        batch, address, units = self._prepare_chunk_plan(120)
        real_to_thread = asyncio.to_thread
        original_create = self.container.db.create_crawl_media_tasks
        original_cancel_check = self.container.db.crawl_batch_cancel_requested
        resolver_workers = 0
        write_calls = 0
        cancel_checks = 0

        async def tracked_to_thread(func, /, *args, **kwargs):
            nonlocal resolver_workers
            if getattr(func, "__name__", "") == "_build_task_rows":
                resolver_workers += 1
            return await real_to_thread(func, *args, **kwargs)

        def tracked_create(address_id, items):
            nonlocal write_calls
            write_calls += 1
            return original_create(address_id, items)

        def tracked_cancel_check(batch_id):
            nonlocal cancel_checks
            cancel_checks += 1
            return original_cancel_check(batch_id)

        with (
            patch.object(
                self.container.ordered_crawls,
                "_plan_address",
                new=AsyncMock(return_value=(units, 0)),
            ),
            patch("gdl_backend.app.asyncio.to_thread", new=tracked_to_thread),
            patch.object(
                self.container.db,
                "create_crawl_media_tasks",
                new=tracked_create,
            ),
            patch.object(
                self.container.db,
                "crawl_batch_cancel_requested",
                new=tracked_cancel_check,
            ),
        ):
            asyncio.run(
                self.container.ordered_crawls._activate_address(batch, address)
            )

        self.assertEqual(resolver_workers, 3)
        self.assertEqual(write_calls, 3)
        self.assertEqual(cancel_checks, 3)
        self.assertEqual(self.container.db.crawl_address_task_count(address["id"]), 120)

    def test_cancel_between_chunks_stops_enqueue(self):
        import asyncio

        batch, address, units = self._prepare_chunk_plan(120)
        original_enqueue = self.container.ordered_crawls._enqueue
        calls = 0

        async def cancelling_enqueue(bodies, keys, concurrency):
            nonlocal calls
            calls += 1
            results = await original_enqueue(bodies, keys, concurrency)
            if calls == 1:
                self.container.db.request_cancel_crawl_batch(batch["id"])
            return results

        self.container.ordered_crawls.set_enqueue(cancelling_enqueue)
        try:
            with patch.object(
                self.container.ordered_crawls,
                "_plan_address",
                new=AsyncMock(return_value=(units, 0)),
            ):
                asyncio.run(
                    self.container.ordered_crawls._activate_address(batch, address)
                )
        finally:
            self.container.ordered_crawls.set_enqueue(original_enqueue)

        linked = self.container.db.crawl_address_tasks(address["id"])
        self.assertEqual(calls, 1)
        self.assertEqual(len(linked), 50)
        self.assertTrue(all(task["status"] == "cancelled" for task in linked))
        self.assertEqual(len(self.container.db.list_tasks(limit=500)), 50)

    def test_cancel_race_does_not_append_a_late_chunk(self):
        import asyncio

        batch, address, units = self._prepare_chunk_plan(120)
        original_create = self.container.db.create_crawl_media_tasks
        calls = 0

        def cancel_before_write(address_id, items):
            nonlocal calls
            calls += 1
            if calls == 1:
                self.container.db.request_cancel_crawl_batch(batch["id"])
            return original_create(address_id, items)

        with (
            patch.object(
                self.container.ordered_crawls,
                "_plan_address",
                new=AsyncMock(return_value=(units, 0)),
            ),
            patch.object(
                self.container.db,
                "create_crawl_media_tasks",
                new=cancel_before_write,
            ),
        ):
            asyncio.run(
                self.container.ordered_crawls._activate_address(batch, address)
            )

        linked = self.container.db.crawl_address_tasks(address["id"])
        self.assertEqual(calls, 1)
        self.assertEqual(linked, [])
        self.assertEqual(self.container.db.list_tasks(limit=500), [])
        self.assertTrue(self.container.db.finish_crawl_batch_if_ready(batch["id"]))
        self.assertEqual(
            self.container.db.get_crawl_batch(batch["id"])["status"],
            "cancelled",
        )

    def test_event_loop_yields_between_chunks(self):
        import asyncio

        batch, address, units = self._prepare_chunk_plan(200)
        real_sleep = asyncio.sleep
        chunk_yields = 0
        ticker_runs = 0
        stop_ticker = False

        async def tracked_sleep(delay, *args, **kwargs):
            nonlocal chunk_yields
            if delay == 0:
                chunk_yields += 1
            return await real_sleep(delay, *args, **kwargs)

        async def scenario():
            nonlocal ticker_runs, stop_ticker

            async def ticker():
                nonlocal ticker_runs
                while not stop_ticker:
                    await real_sleep(0)
                    ticker_runs += 1

            ticker_task = asyncio.create_task(ticker())
            try:
                await self.container.ordered_crawls._activate_address(batch, address)
            finally:
                stop_ticker = True
                await ticker_task

        with (
            patch.object(
                self.container.ordered_crawls,
                "_plan_address",
                new=AsyncMock(return_value=(units, 0)),
            ),
            patch("gdl_backend.ordered_crawl.asyncio.sleep", new=tracked_sleep),
        ):
            asyncio.run(scenario())

        self.assertEqual(chunk_yields, 4)
        self.assertGreaterEqual(ticker_runs, 4)
        self.assertEqual(self.container.db.crawl_address_task_count(address["id"]), 200)

    def test_chunked_enqueue_keeps_existing_task_validation(self):
        import asyncio

        batch, address, units = self._prepare_chunk_plan(2)
        validation_calls = 0

        def validate_args(_args):
            nonlocal validation_calls
            validation_calls += 1
            if validation_calls == 2:
                raise ValueError("测试注入的参数拒绝")

        with (
            patch.object(
                self.container.ordered_crawls,
                "_plan_address",
                new=AsyncMock(return_value=(units, 0)),
            ),
            patch.object(self.container.gallery, "validate_args", new=validate_args),
        ):
            asyncio.run(
                self.container.ordered_crawls._activate_address(batch, address)
            )

        self.assertEqual(validation_calls, 2)
        self.assertEqual(self.container.db.crawl_address_task_count(address["id"]), 0)
        failed = self.container.db.get_crawl_batch(batch["id"])
        self.assertEqual(failed["sources"][0]["addresses"][0]["status"], "failed")

    def test_cancel_during_chunk_write_keeps_committed_tasks_visible(self):
        import asyncio
        import threading

        batch, address, units = self._prepare_chunk_plan(2)
        original_create = self.container.db.create_crawl_media_tasks
        committed = threading.Event()
        release_result = threading.Event()

        def delayed_result(address_id, items):
            results = original_create(address_id, items)
            committed.set()
            release_result.wait()
            return results

        async def scenario():
            worker = asyncio.create_task(
                self.container.ordered_crawls._activate_address(batch, address)
            )
            try:
                ready = await asyncio.wait_for(
                    asyncio.to_thread(committed.wait),
                    timeout=2,
                )
                self.assertTrue(ready)
                worker.cancel()
                release_result.set()
                with self.assertRaises(asyncio.CancelledError):
                    await worker
            finally:
                release_result.set()
                if not worker.done():
                    worker.cancel()
                    await asyncio.gather(worker, return_exceptions=True)

        with (
            patch.object(
                self.container.ordered_crawls,
                "_plan_address",
                new=AsyncMock(return_value=(units, 0)),
            ),
            patch.object(
                self.container.db,
                "create_crawl_media_tasks",
                new=delayed_result,
            ),
        ):
            asyncio.run(scenario())

        current = self.container.db.get_crawl_batch(batch["id"])
        current_address = current["sources"][0]["addresses"][0]
        linked = self.container.db.crawl_address_tasks(address["id"])
        self.assertEqual(current_address["status"], "running")
        self.assertEqual(current_address["planned_task_count"], 2)
        self.assertEqual(len(linked), 2)
        self.assertTrue(all(task["status"] == "cancelled" for task in linked))

    def test_partial_enqueue_drains_current_address_before_next_address(self):
        import asyncio

        self.container.discovery.discover_url = AsyncMock(
            return_value={
                "candidates": [
                    {
                        "id": "1",
                        "site": "twitter",
                        "kind": "work",
                        "url": "https://x.com/artist/status/1",
                        "media_count": 51,
                    }
                ]
            }
        )
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "twitter",
                        "addresses": [
                            {"url": "https://x.com/artist/media"},
                            {"url": "https://x.com/artist2/media"},
                        ],
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        batch_id = response.json()["id"]
        original_enqueue = self.container.ordered_crawls._enqueue
        calls = 0

        async def flaky_enqueue(bodies, keys, concurrency):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("injected enqueue failure")
            return await original_enqueue(bodies, keys, concurrency)

        self.container.ordered_crawls.set_enqueue(flaky_enqueue)
        asyncio.run(self.container.ordered_crawls.run_once())
        batch = self.container.db.get_crawl_batch(batch_id)
        self.assertEqual(batch["sources"][0]["addresses"][0]["status"], "running")
        self.assertEqual(batch["sources"][0]["addresses"][1]["status"], "pending")

        asyncio.run(self.container.ordered_crawls.run_once())
        batch = self.container.db.get_crawl_batch(batch_id)
        self.assertEqual(batch["sources"][0]["addresses"][0]["status"], "failed")
        self.assertEqual(batch["sources"][0]["addresses"][1]["status"], "pending")
        self.container.ordered_crawls.set_enqueue(original_enqueue)

    def test_manager_cancellation_drains_linked_tasks_without_replanning(self):
        import asyncio

        self.container.discovery.discover_url = AsyncMock(
            return_value={
                "candidates": [
                    {
                        "id": "1",
                        "site": "twitter",
                        "kind": "work",
                        "url": "https://x.com/artist/status/1",
                        "media_count": 51,
                    }
                ]
            }
        )
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "twitter",
                        "addresses": [
                            {"url": "https://x.com/artist/media"},
                            {"url": "https://x.com/artist2/media"},
                        ],
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        batch_id = response.json()["id"]
        original_enqueue = self.container.ordered_crawls._enqueue

        async def scenario():
            second_enqueue = asyncio.Event()
            calls = 0

            async def blocking_enqueue(bodies, keys, concurrency):
                nonlocal calls
                calls += 1
                if calls == 2:
                    second_enqueue.set()
                    await asyncio.Event().wait()
                return await original_enqueue(bodies, keys, concurrency)

            self.container.ordered_crawls.set_enqueue(blocking_enqueue)
            worker = asyncio.create_task(self.container.ordered_crawls.run_once())
            await asyncio.wait_for(second_enqueue.wait(), timeout=1)
            worker.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await worker

        try:
            asyncio.run(scenario())
            batch = self.container.db.get_crawl_batch(batch_id)
            first = batch["sources"][0]["addresses"][0]
            self.assertEqual(first["status"], "running")
            self.assertEqual(first["planned_task_count"], 50)
            self.assertEqual(batch["sources"][0]["addresses"][1]["status"], "pending")
            linked = self.container.db.crawl_address_tasks(first["id"])
            self.assertEqual(len(linked), 50)
            self.assertTrue(all(task["status"] == "cancelled" for task in linked))

            asyncio.run(self.container.ordered_crawls.run_once())
            batch = self.container.db.get_crawl_batch(batch_id)
            self.assertEqual(batch["sources"][0]["addresses"][0]["status"], "failed")
            self.assertEqual(batch["sources"][0]["addresses"][1]["status"], "pending")
        finally:
            self.container.ordered_crawls.set_enqueue(original_enqueue)

    def test_cancel_queued_ordered_crawl(self):
        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "danbooru",
                        "addresses": [
                            {"url": "https://danbooru.donmai.us/posts?tags=artist_name"}
                        ],
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        batch_id = response.json()["id"]
        cancelled = self.client.post(f"/api/v1/crawls/{batch_id}/cancel", headers=self.headers)
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.assertEqual(cancelled.json()["status"], "cancelled")
        self.assertEqual(cancelled.json()["sources"][0]["addresses"][0]["status"], "cancelled")

    def test_retry_replans_batch_with_only_planning_failures(self):
        # A finished batch whose only defect is a planning failure (0 media tasks) must
        # still be resumable and its /retry endpoint must NOT 409.
        batch_id, _ = self.container.db.create_crawl_batch(
            {
                "id": "batch-api-replan",
                "output_dir": str(Path(self.temp.name) / "batch-api-replan"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "address-api-replan",
                    "site": "exhentai",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://e-hentai.org/g/12/TOKEN/",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertTrue(self.container.db.begin_crawl_address_planning("address-api-replan"))
        self.container.db.fail_crawl_address("address-api-replan", "planning blew up")
        self.assertTrue(self.container.db.finish_crawl_batch_if_ready(batch_id))

        detail = self.client.get(f"/api/v1/crawls/{batch_id}", headers=self.headers)
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["failed_task_count"], 0)
        self.assertTrue(detail.json()["resumable"])

        retry = self.client.post(
            f"/api/v1/crawls/{batch_id}/retry",
            headers=self.headers,
            json={"additional_attempts": 1},
        )
        self.assertEqual(retry.status_code, 202, retry.text)
        payload = retry.json()
        self.assertEqual(payload["retried_count"], 0)
        self.assertEqual(payload["replanned_address_count"], 1)
        self.assertEqual(payload["replanned_address_ids"], ["address-api-replan"])
        self.assertEqual(payload["batch"]["status"], "running")
        replanned = payload["batch"]["sources"][0]["addresses"][0]
        self.assertEqual(replanned["status"], "pending")
        self.assertEqual(replanned["planning_error"], "")

    def test_replan_returns_address_own_linked_tasks_to_budget(self):
        # Re-planning a large partially-planned address must not trip crawl_plan_too_large:
        # its already-linked tasks are counted by crawl_batch_task_count but re-enqueue
        # idempotently (no new budget), so `remaining` must add that count back. Here
        # max_tasks=10, another address holds 2 tasks, this address holds 5 partial tasks;
        # the fixed remaining is 10-2=8 (the old formula gave 10-7=3 and would raise).
        import asyncio

        root = Path(self.temp.name)

        def task_row(task_id):
            return {
                "id": task_id,
                "url": "https://danbooru.donmai.us/posts/1",
                "site": "danbooru",
                "subcategory": "post",
                "extractor": "DanbooruExtractor",
                "output_dir": str(root / "out"),
                "proxy_mode": "direct",
                "max_attempts": 3,
                "policy": {"max_concurrency": 1},
                "extra_args": [],
            }

        batch_id, _ = self.container.db.create_crawl_batch(
            {
                "id": "batch-budget",
                "output_dir": str(self.settings.default_output_root / "batch-budget"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "addr-A",
                    "site": "danbooru",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=a",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                },
                {
                    "id": "addr-B",
                    "site": "danbooru",
                    "source_order": 1,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=b",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                },
            ],
        )
        # Address B contributes 2 tasks to the batch budget (other addresses' work).
        for i in range(2):
            self.container.db.create_task(task_row(f"b-task-{i}"))
            self.container.db.link_crawl_task("addr-B", f"b-task-{i}", i + 1)
        # Address A already holds 5 partially-planned tasks still linked (re-plan keeps them).
        for i in range(5):
            self.container.db.create_task(task_row(f"a-task-{i}"))
            self.container.db.link_crawl_task("addr-A", f"a-task-{i}", i + 1)

        self.assertEqual(self.container.db.crawl_address_task_count("addr-A"), 5)
        self.assertEqual(self.container.db.crawl_batch_task_count(batch_id), 7)

        captured = {}
        units = [
            CrawlUnit(
                url=f"https://danbooru.donmai.us/posts/{100 + i}",
                site="danbooru",
                kind="post",
                source_id=f"danbooru:{100 + i}",
            )
            for i in range(4)  # old remaining 3 would raise; fixed remaining 8 allows it
        ]

        async def fake_plan(address, *, batch_id, policy, max_tasks):
            captured["max_tasks"] = max_tasks
            return units, 0

        batch = self.container.db.get_crawl_batch(batch_id)
        address = batch["sources"][0]["addresses"][0]
        self.assertEqual(address["id"], "addr-A")
        with patch.object(self.container.ordered_crawls, "_plan_address", new=fake_plan):
            asyncio.run(self.container.ordered_crawls._activate_address(batch, address))

        # remaining passed to the planner adds addr-A's own 5 linked tasks back:
        # 10 - crawl_batch_task_count(7) + crawl_address_task_count(5) = 8.
        self.assertEqual(captured["max_tasks"], 8)
        replanned = self.container.db.get_crawl_batch(batch_id)["sources"][0]["addresses"][0]
        # Guard did NOT raise (the old formula would have driven addr-A to 'failed').
        self.assertEqual(replanned["status"], "running", replanned.get("last_error"))

    def test_rerun_endpoint_reopens_terminal_batch(self):
        root = Path(self.temp.name)
        batch_id, _ = self.container.db.create_crawl_batch(
            {
                "id": "batch-api-rerun",
                "output_dir": str(root / "batch-api-rerun"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "address-api-rerun",
                    "site": "danbooru",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://danbooru.donmai.us/posts?tags=a",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertTrue(self.container.db.begin_crawl_address_planning("address-api-rerun"))
        self.container.db.create_task(
            {
                "id": "api-rerun-task",
                "url": "https://danbooru.donmai.us/posts/1",
                "site": "danbooru",
                "output_dir": str(root / "out"),
                "proxy_mode": "direct",
                "max_attempts": 3,
                "policy": {"max_concurrency": 1},
                "extra_args": [],
            }
        )
        self.container.db.link_crawl_task("address-api-rerun", "api-rerun-task", 1)
        self.assertTrue(self.container.db.mark_crawl_address_running("address-api-rerun"))
        self.container.db.complete_task("api-rerun-task", "succeeded")
        self.assertTrue(
            self.container.db.finish_crawl_address_if_terminal("address-api-rerun")
        )
        self.assertTrue(self.container.db.finish_crawl_batch_if_ready(batch_id))

        detail = self.client.get(f"/api/v1/crawls/{batch_id}", headers=self.headers)
        self.assertEqual(detail.json()["status"], "succeeded")

        rerun = self.client.post(
            f"/api/v1/crawls/{batch_id}/rerun", headers=self.headers, json={}
        )
        self.assertEqual(rerun.status_code, 202, rerun.text)
        payload = rerun.json()
        self.assertEqual(payload["requeued_task_count"], 0)
        self.assertEqual(payload["replanned_address_count"], 1)
        self.assertFalse(payload["requeue_succeeded"])
        self.assertEqual(payload["batch"]["status"], "running")
        self.assertEqual(
            payload["batch"]["sources"][0]["addresses"][0]["status"], "pending"
        )
        # Succeeded task untouched -> idempotent re-planning will skip it (no re-download).
        self.assertEqual(
            self.container.db.get_task("api-rerun-task")["status"], "succeeded"
        )

    def test_rerun_endpoint_rejects_running_and_missing_batch(self):
        missing = self.client.post(
            "/api/v1/crawls/does-not-exist/rerun", headers=self.headers, json={}
        )
        self.assertEqual(missing.status_code, 404, missing.text)
        self.assertEqual(missing.json()["error"]["code"], "crawl_not_found")

        response = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "danbooru",
                        "addresses": [
                            {"url": "https://danbooru.donmai.us/posts?tags=artist_name"}
                        ],
                    }
                ],
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        batch_id = response.json()["id"]
        rerun = self.client.post(
            f"/api/v1/crawls/{batch_id}/rerun", headers=self.headers, json={}
        )
        self.assertEqual(rerun.status_code, 409, rerun.text)
        self.assertEqual(rerun.json()["error"]["code"], "crawl_not_finished")

    def test_rerun_endpoint_blocks_in_flight_review_only(self):
        root = Path(self.temp.name)
        batch_id, _ = self.container.db.create_crawl_batch(
            {
                "id": "batch-api-rerun-review",
                "output_dir": str(root / "batch-api-rerun-review"),
                "concurrency": 1,
                "max_tasks": 10,
            },
            [
                {
                    "id": "address-api-rerun-review",
                    "site": "exhentai",
                    "source_order": 0,
                    "address_order": 0,
                    "url": "https://e-hentai.org/g/13/TOKEN/",
                    "proxy_mode": "direct",
                    "max_attempts": 3,
                }
            ],
        )
        self.assertTrue(
            self.container.db.begin_crawl_address_planning("address-api-rerun-review")
        )
        self.container.db.fail_crawl_address("address-api-rerun-review", "planning blew up")
        self.assertTrue(self.container.db.finish_crawl_batch_if_ready(batch_id))

        # A review whose analysis is running actively scans the batch dir; re-crawling
        # would race it, so the endpoint must block with 409 review_in_progress.
        with self.container.db._transaction() as conn:
            conn.execute(
                """
                INSERT INTO crawl_reviews(batch_id, status, created_at, updated_at)
                VALUES (?, 'analyzing', 1, 1)
                """,
                (batch_id,),
            )
        blocked = self.client.post(
            f"/api/v1/crawls/{batch_id}/rerun", headers=self.headers, json={}
        )
        self.assertEqual(blocked.status_code, 409, blocked.text)
        self.assertEqual(blocked.json()["error"]["code"], "review_in_progress")

        # A stale finished review (ready) does not touch files and must not block.
        with self.container.db._transaction() as conn:
            conn.execute(
                "UPDATE crawl_reviews SET status='ready' WHERE batch_id=?",
                (batch_id,),
            )
        allowed = self.client.post(
            f"/api/v1/crawls/{batch_id}/rerun", headers=self.headers, json={}
        )
        self.assertEqual(allowed.status_code, 202, allowed.text)
        self.assertEqual(allowed.json()["batch"]["status"], "running")

    def test_rerun_incremental_replan_skips_succeeded_and_links_new_unit(self):
        import asyncio

        plan_state = {"units": []}

        async def fake_plan(address, *, batch_id, policy, max_tasks):
            return list(plan_state["units"]), 0

        unit_a = CrawlUnit(
            url="https://danbooru.donmai.us/posts/1",
            site="danbooru",
            kind="post",
            source_id="danbooru:1",
        )
        unit_new = CrawlUnit(
            url="https://danbooru.donmai.us/posts/2",
            site="danbooru",
            kind="post",
            source_id="danbooru:2",
        )

        create = self.client.post(
            "/api/v1/crawls",
            headers=self.headers,
            json={
                "sources": [
                    {
                        "site": "danbooru",
                        "addresses": [{"url": "https://danbooru.donmai.us/posts?tags=a"}],
                    }
                ],
                "proxy_mode": "direct",
                "max_tasks": 10,
            },
        )
        self.assertEqual(create.status_code, 202, create.text)
        batch_id = create.json()["id"]

        with patch.object(self.container.ordered_crawls, "_plan_address", new=fake_plan):
            # Initial crawl: one unit -> one task, which succeeds.
            plan_state["units"] = [unit_a]
            asyncio.run(self.container.ordered_crawls.run_once())
            tasks = self.container.db.list_crawl_tasks(batch_id)
            self.assertEqual(len(tasks), 1)
            task_a_id = tasks[0]["id"]
            self.container.db.complete_task(task_a_id, "succeeded")
            asyncio.run(self.container.ordered_crawls.run_once())
            asyncio.run(self.container.ordered_crawls.run_once())
            self.assertEqual(
                self.container.db.get_crawl_batch(batch_id)["status"], "succeeded"
            )
            address_id = self.container.db.get_crawl_batch(batch_id)["sources"][0][
                "addresses"
            ][0]["id"]

            # (a) Rerun re-discovering the SAME unit: idempotent skip, zero new tasks and
            # zero requeued; the succeeded task stays succeeded.
            rerun_a = self.client.post(
                f"/api/v1/crawls/{batch_id}/rerun", headers=self.headers, json={}
            )
            self.assertEqual(rerun_a.status_code, 202, rerun_a.text)
            self.assertEqual(rerun_a.json()["requeued_task_count"], 0)
            plan_state["units"] = [unit_a]
            asyncio.run(self.container.ordered_crawls.run_once())
            asyncio.run(self.container.ordered_crawls.run_once())
            after_a = self.container.db.get_crawl_batch(batch_id)
            self.assertEqual(after_a["status"], "succeeded")
            self.assertEqual(
                after_a["sources"][0]["addresses"][0]["status"], "succeeded"
            )
            self.assertEqual(len(self.container.db.list_crawl_tasks(batch_id)), 1)
            self.assertEqual(
                self.container.db.get_task(task_a_id)["status"], "succeeded"
            )

            # (b) Rerun re-discovering a SUPERSET with a NEW unit PREPENDED. The new unit
            # requests sequence_no=1, already owned by the succeeded task, forcing the
            # collision the Part 1 fix handles: exactly one new task is created AND linked
            # (INSERT OR IGNORE would have silently dropped it).
            rerun_b = self.client.post(
                f"/api/v1/crawls/{batch_id}/rerun", headers=self.headers, json={}
            )
            self.assertEqual(rerun_b.status_code, 202, rerun_b.text)
            plan_state["units"] = [unit_new, unit_a]
            asyncio.run(self.container.ordered_crawls.run_once())
            linked = self.container.db.crawl_address_tasks(address_id)
            self.assertEqual(len(linked), 2)
            new_ids = [task["id"] for task in linked if task["id"] != task_a_id]
            self.assertEqual(len(new_ids), 1)
            new_task_id = new_ids[0]
            self.assertEqual(
                self.container.db.get_task(new_task_id)["url"],
                "https://danbooru.donmai.us/posts/2",
            )

            # The address completes once the single new task finishes.
            self.container.db.complete_task(new_task_id, "succeeded")
            asyncio.run(self.container.ordered_crawls.run_once())
            asyncio.run(self.container.ordered_crawls.run_once())
            final = self.container.db.get_crawl_batch(batch_id)
            self.assertEqual(final["status"], "succeeded")
            self.assertEqual(final["sources"][0]["addresses"][0]["status"], "succeeded")
            self.assertEqual(final["task_count"], 2)


if __name__ == "__main__":
    unittest.main()
