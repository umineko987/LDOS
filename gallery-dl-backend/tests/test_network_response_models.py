"""代理池 / 站点授权 / 站点设置的响应模型只进 OpenAPI，不改写负载。"""

from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from pydantic import TypeAdapter

from gdl_backend.api_routes import network_models as models
from gdl_backend.api_routes.proxy import _desktop_proxy_operation, _desktop_proxy_sources, _desktop_proxy_status
from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.auth_projection import (
    vault_safe_browser_profile,
    vault_safe_browser_runtime,
    vault_safe_proxy_status,
    vault_safe_session,
    vault_safe_status,
    vault_safe_statuses,
)
from gdl_backend.policy_view import policy_view_item, policy_view_snapshot
from tests.helpers import local_test_client, make_settings
from tests.test_app_routing_contract import _included_api_routes


SESSION_ID = "0123456789abcdef0123456789abcdef"
POLICY = {"max_concurrency": 4, "retry_limit": 2, "backoff_base_seconds": 2.5, "proxy_mode": "prefer"}


def roundtrip(model, payload):
    adapter = TypeAdapter(model)
    return adapter.dump_python(adapter.validate_python(payload), mode="json", exclude_unset=True)


def legacy_status_sample() -> dict:
    return {
        "enabled": True, "engine": "builtin", "managed_by_backend": True, "auto_start": False,
        "executable_required": False, "running": True, "configured_revision": "r2", "active_revision": "r1",
        "reload_required": True, "total": 1, "healthy": 1, "retry_eligible": 0, "leases": 1,
        "last_error": "dial http://user:pass@10.0.0.1:8080 failed",
        "transport_core": {"enabled": True, "running": True, "pid": 42, "listeners": 2, "last_error": ""},
        "sources": {"subscriptions": 1, "source_nodes": 3, "pool_nodes": 1, "core_candidates": 2,
                    "core_nodes": 2, "skipped_nodes": 1, "warnings": ["节点 x 不支持"]},
        "probe_cache": {"entries": 0, "ttl_seconds": 300.0},
        "nodes": [{
            "id": "n1", "name": "Tokyo 01", "protocol": "http", "endpoint": "http://***@10.0.0.1:8080",
            "healthy": True, "retry_eligible": False, "ref_count": 1, "success_count": 3, "fail_count": 0,
            "last_latency_ms": 12.5, "cooldown_until": 1_700_000_000.0, "last_error": "", "tags": ["jp"],
        }],
        "health_loop": {"consecutive_failures": 0},
    }


def sources_sample() -> dict:
    return {
        "source": "runtime", "has_runtime_override": True, "runtime_override_valid": True,
        "configured_revision": "r2", "active_revision": None, "reload_required": True,
        "subscriptions": [{"id": "sub-1", "source": "runtime", "scheme": "https", "host": "sub.example",
                           "port": 443, "display_url": "https://sub.example/…", "credentials_redacted": False,
                           "sensitive_parts_redacted": True}],
        "node_file": {"configured": True, "source": "runtime", "display_path": "nodes.txt"},
        "inline_nodes": [{"id": "node-1", "source": "runtime", "scheme": "vmess", "name": "hk", "host": "1.2.3.4",
                          "port": 443, "requires_transport_core": True, "display_endpoint": "vmess://…"}],
        "counts": {"subscriptions": 1, "node_file": 1, "inline_nodes": 1, "total": 3},
    }


def raw_auth_statuses() -> dict:
    login = {"session_id": SESSION_ID, "site": "twitter", "state": "awaiting_login", "message": "请登录",
             "created_at": 1_700_000_000.0, "expires_at": 1_700_000_600.0, "cookie_count": 0,
             "recommended_missing": [], "error": None}
    return {
        "items": [
            {"site": "danbooru", "label": "Danbooru", "method": "anonymous", "state": "ready", "authorized": True,
             "summary": "x", "actions": []},
            {"site": "twitter", "label": "X", "method": "managed_browser", "state": "authorizing",
             "authorized": False, "summary": "x", "updated_at": 1_700_000_000.0, "invalidated_at": None,
             "cookies": {"present": True, "valid": False, "cookie_count": 3, "updated_at": 1_699_999_999},
             "login": login, "actions": ["managed_browser_login", "clear"]},
            {"site": "pixiv", "label": "Pixiv", "method": "oauth", "state": "required", "authorized": False,
             "summary": "x", "updated_at": None, "oauth": None, "actions": ["oauth", "clear"]},
        ],
        "browser_profile": {"shared": True, "present": True, "running": False, "resetting": False},
        "authorization_proxy": {"proxy_url": "http://u:p@127.0.0.1:7890", "source": "runtime",
                                "credentials_redacted": True, "browser_running": False, "restart_pending": False,
                                "updated_at": 1_700_000_000},
        "managed": True,
        "secrets_exposed": False,
    }


class ProjectionModelTests(unittest.TestCase):
    """投影必须落在精确模型上，而不是悄悄退到宽松的 legacy 模型。"""

    def assert_exact(self, model, payload) -> None:
        self.assertEqual(roundtrip(model, payload), payload)

    def test_desktop_proxy_projections_match_precise_models(self) -> None:
        self.assert_exact(models.DesktopProxyStatus, _desktop_proxy_status(legacy_status_sample()))
        self.assert_exact(models.DesktopProxyStatus, _desktop_proxy_status({}))
        self.assert_exact(models.DesktopProxySources, _desktop_proxy_sources(sources_sample()))
        self.assert_exact(models.DesktopProxySources, _desktop_proxy_sources({}))
        self.assert_exact(models.DesktopProxyOperation, _desktop_proxy_operation())

    def test_vault_projections_match_precise_models(self) -> None:
        raw = raw_auth_statuses()
        statuses = vault_safe_statuses(raw)
        self.assertEqual(len(statuses["items"]), 3)
        self.assert_exact(models.VaultStatuses, statuses)
        for item in raw["items"]:
            self.assert_exact(models.VaultSiteStatus, vault_safe_status(item))
        self.assert_exact(models.VaultProxyStatus, vault_safe_proxy_status(raw["authorization_proxy"]))
        self.assert_exact(models.VaultBrowserProfile, vault_safe_browser_profile(raw["browser_profile"]))
        for runtime in ({"available": True, "name": "Chromium", "source": "auto"}, {}):
            self.assert_exact(models.VaultBrowserRuntime, vault_safe_browser_runtime(runtime))
        session = vault_safe_session(raw["items"][1]["login"], site="twitter")
        self.assert_exact(models.VaultSession, session)
        status = vault_safe_status(raw["items"][1])
        self.assert_exact(models.VaultBrowserResult, {"session": session, "status": status})
        self.assert_exact(models.VaultBrowserResult, {"session": None, "status": status})
        self.assert_exact(models.VaultBrowserProfileReset,
                          {"browser_profile": vault_safe_browser_profile({}), "auth": statuses})

    def test_policy_projections_match_precise_models(self) -> None:
        stored = [{"site": "pixiv", "policy": POLICY, "updated_at": 1_700_000_000.5},
                  {"site": "twitter", "policy": {"bogus": 1}, "updated_at": 1},
                  {"site": "unknown", "policy": POLICY, "updated_at": 2}]
        snapshot = policy_view_snapshot(POLICY, stored)
        self.assertEqual(snapshot["unknown_override_count"], 1)
        self.assert_exact(models.PolicyViewSnapshot, snapshot)
        self.assert_exact(models.PolicyViewSnapshot, policy_view_snapshot({"bogus": True}, []))
        self.assert_exact(models.PolicyViewItem, policy_view_item("danbooru", POLICY, inherited=True))
        self.assert_exact(models.SitePolicyDeleted, {"response_profile": "policy", "deleted": True, "site": "pixiv"})

    def test_legacy_payloads_pass_through_unions(self) -> None:
        cases = (
            (models.ProxyStatusResponse, legacy_status_sample()),
            (models.ProxyLifecycleResponse, legacy_status_sample()),
            (models.ProxySourcesResponse, sources_sample()),
            (models.ProxySourceChangeResponse, sources_sample()),
            (models.ProxyProbeResponse, {"total": 1, "healthy": 0, "cached": True, "age_seconds": 3,
                                         "target": "https://example.com/", "results": [{"id": "n1", "healthy": False,
                                                                                         "error": "timeout"}]}),
            (models.AuthStatusesResponse, raw_auth_statuses()),
            (models.AuthSiteResponse, raw_auth_statuses()["items"][1]),
            (models.AuthSiteResponse, {**raw_auth_statuses()["items"][1], "updated_at": "2024-01-01",
                                       "invalid_reason": None}),
            (models.AuthProxyResponse, {**raw_auth_statuses()["authorization_proxy"], "config_proxy_url": None,
                                        "browser_proxy_url": None, "updated_at": "odd"}),
            (models.AuthBrowserRuntimeResponse, {"available": False, "name": None, "source": "none", "message": "x"}),
            (models.AuthBrowserLoginResponse, {"session": raw_auth_statuses()["items"][1]["login"],
                                               "status": raw_auth_statuses()["items"][1]}),
            (models.AuthPixivStartResponse, {"session_id": SESSION_ID, "state": "starting", "message": "",
                                             "authorization_url": None, "created_at": 1.0, "expires_at": 601.0,
                                             "error": None, "browser": "project_chrome", "profile": "shared",
                                             "automatic_callback": True}),
            (models.AuthPixivStartResponse, None),
            (models.AuthBrowserProfileResetResponse, {"browser_profile": {"present": False},
                                                      "auth": raw_auth_statuses()}),
            (models.SitePoliciesResponse, {"default": POLICY, "items": [
                {"site": "pixiv", "policy": POLICY, "updated_at": 1_700_000_000.5}]}),
            (models.SitePolicyResponse, {"site": "pixiv", "policy": POLICY, "inherited": True}),
            (models.SitePolicyResponse, {"site": "pixiv", "policy": POLICY, "updated_at": 3}),
            (models.SitePolicyDeleted, {"deleted": True, "site": "pixiv"}),
        )
        for model, payload in cases:
            with self.subTest(model=model, keys=sorted(payload) if isinstance(payload, dict) else payload):
                self.assertEqual(roundtrip(model, payload), payload)

    def test_values_are_not_coerced(self) -> None:
        payload = {**legacy_status_sample(), "total": 1, "probe_cache": {"entries": 0, "ttl_seconds": 300}}
        dumped = roundtrip(models.ProxyStatusResponse, payload)
        self.assertIsInstance(dumped["probe_cache"]["ttl_seconds"], int)
        self.assertIsInstance(dumped["nodes"][0]["last_latency_ms"], float)
        policy = roundtrip(models.SitePolicyResponse, {"site": "x", "policy": {**POLICY, "backoff_base_seconds": 2}})
        self.assertIsInstance(policy["policy"]["backoff_base_seconds"], int)


class NetworkRoutesPayloadTests(unittest.TestCase):
    """HTTP 响应与路由函数直接返回的负载逐字段相同。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.settings = make_settings(Path(self._tmp.name))
        self.container = ServiceContainer(self.settings)
        self.app = create_app(self.settings, container=self.container, start_background=False)
        context = local_test_client(self.app, self.settings)
        self.client = context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)
        self.endpoints = {
            (method, route.path): route
            for route in _included_api_routes(self.app.router)
            for method in route.methods
        }

    def direct(self, method: str, path: str, **kwargs):
        route = self.endpoints[(method, path)]
        self.assertIsNotNone(route.response_model, path)
        return asyncio.run(route.endpoint(container=self.container, **kwargs))

    def assert_same(self, url: str, method: str, path: str, **kwargs) -> None:
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), self.direct(method, path, **kwargs), url)

    def test_proxy_get_routes(self) -> None:
        for view in ("legacy", "desktop"):
            with self.subTest(view=view):
                self.assert_same(f"/api/v1/proxy/sources?view={view}", "GET", "/api/v1/proxy/sources", view=view)
                self.assert_same(f"/api/v1/proxy/status?view={view}", "GET", "/api/v1/proxy/status", view=view)

    def test_auth_get_routes(self) -> None:
        for view in ("legacy", "vault"):
            with self.subTest(view=view):
                self.assert_same(f"/api/v1/auth?view={view}", "GET", "/api/v1/auth", view=view)
                self.assert_same(f"/api/v1/auth/proxy?view={view}", "GET", "/api/v1/auth/proxy", view=view)
                self.assert_same(f"/api/v1/auth/browser?view={view}", "GET", "/api/v1/auth/browser", view=view)
                for site in ("danbooru", "twitter", "pixiv", "exhentai", "pawchive"):
                    self.assert_same(f"/api/v1/auth/{site}?view={view}", "GET", "/api/v1/auth/{site}",
                                     site=site, view=view)

    def test_policy_routes(self) -> None:
        for view in ("legacy", "policy"):
            with self.subTest(view=view):
                self.assert_same(f"/api/v1/sites/policies?view={view}", "GET", "/api/v1/sites/policies", view=view)
                self.assert_same(f"/api/v1/sites/policies/pixiv?view={view}", "GET", "/api/v1/sites/policies/{site}",
                                 site="pixiv", view=view)
        response = self.client.put("/api/v1/sites/policies/pixiv", json=POLICY)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), self.container.db.get_site_policy("pixiv"))
        response = self.client.put("/api/v1/sites/policies/pixiv?view=policy", json=POLICY)
        stored = self.container.db.get_site_policy("pixiv")
        self.assertEqual(response.json(), policy_view_item("pixiv", stored["policy"], inherited=False,
                                                           updated_at=stored["updated_at"]))
        for view in ("legacy", "policy"):
            self.assert_same(f"/api/v1/sites/policies?view={view}", "GET", "/api/v1/sites/policies", view=view)
            self.assert_same(f"/api/v1/sites/policies/pixiv?view={view}", "GET", "/api/v1/sites/policies/{site}",
                             site="pixiv", view=view)
        self.assertEqual(self.client.delete("/api/v1/sites/policies/pixiv").json(), {"deleted": True, "site": "pixiv"})
        self.client.put("/api/v1/sites/policies/pixiv", json=POLICY)
        self.assertEqual(self.client.delete("/api/v1/sites/policies/pixiv?view=policy").json(),
                         {"response_profile": "policy", "deleted": True, "site": "pixiv"})

    def test_every_network_route_declares_a_response_model(self) -> None:
        prefixes = ("/api/v1/proxy", "/api/v1/auth", "/api/v1/sites/policies")
        routes = [route for key, route in self.endpoints.items() if key[1].startswith(prefixes)]
        self.assertGreaterEqual(len(routes), 30)
        for route in routes:
            with self.subTest(path=route.path, methods=route.methods):
                self.assertIsNotNone(route.response_model)
                self.assertTrue(route.response_model_exclude_unset)


if __name__ == "__main__":
    unittest.main()
