from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from fastapi.routing import APIRoute

from gdl_backend.api_routes.discovery import (
    _aggregate_search_result,
    _build_search_plan,
)
from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.schemas import SearchRequest
from tests.helpers import local_test_client, make_settings


# This is the public route/OpenAPI surface before the phase-5A router move.  Keep
# operation IDs as well as paths and methods stable: generated clients use them.
_EXPECTED_OPENAPI_OPERATIONS = {
    ("GET", "/"): ("root__get", ("200",)),
    ("GET", "/healthz"): ("healthz_healthz_get", ("200",)),
    ("GET", "/readyz"): ("readyz_readyz_get", ("200",)),
    ("GET", "/api/v1/config"): ("public_config_api_v1_config_get", ("200", "422")),
    ("GET", "/api/v1/auth"): ("auth_statuses_api_v1_auth_get", ("200", "422")),
    ("GET", "/api/v1/auth/proxy"): ("auth_proxy_status_api_v1_auth_proxy_get", ("200", "422")),
    ("PUT", "/api/v1/auth/proxy"): ("auth_set_proxy_api_v1_auth_proxy_put", ("200", "422")),
    ("DELETE", "/api/v1/auth/proxy"): ("auth_reset_proxy_api_v1_auth_proxy_delete", ("200", "422")),
    ("GET", "/api/v1/auth/{site}"): ("auth_status_api_v1_auth__site__get", ("200", "422")),
    ("DELETE", "/api/v1/auth/{site}"): ("auth_clear_api_v1_auth__site__delete", ("200", "422")),
    ("POST", "/api/v1/auth/{site}/login/start"): ("auth_start_browser_login_api_v1_auth__site__login_start_post", ("202", "422")),
    ("GET", "/api/v1/auth/{site}/login/{session_id}"): ("auth_browser_login_session_api_v1_auth__site__login__session_id__get", ("200", "422")),
    ("DELETE", "/api/v1/auth/{site}/login/{session_id}"): ("auth_cancel_browser_login_api_v1_auth__site__login__session_id__delete", ("200", "422")),
    ("POST", "/api/v1/auth/pixiv/oauth/start"): ("auth_start_pixiv_api_v1_auth_pixiv_oauth_start_post", ("200", "422")),
    ("DELETE", "/api/v1/auth/pixiv/oauth/session"): ("auth_cancel_pixiv_api_v1_auth_pixiv_oauth_session_delete", ("200", "422")),
    ("DELETE", "/api/v1/auth/browser-profile"): ("auth_clear_browser_profile_api_v1_auth_browser_profile_delete", ("200", "422")),
    ("GET", "/api/v1/gallery/sources"): ("list_gallery_sources_api_v1_gallery_sources_get", ("200", "422")),
    ("GET", "/api/v1/gallery/sources/{source_id}"): ("get_gallery_source_api_v1_gallery_sources__source_id__get", ("200", "422")),
    ("POST", "/api/v1/gallery/imports"): ("import_gallery_source_api_v1_gallery_imports_post", ("201", "422")),
    ("PATCH", "/api/v1/gallery/sources/{source_id}"): ("patch_gallery_source_api_v1_gallery_sources__source_id__patch", ("200", "422")),
    ("DELETE", "/api/v1/gallery/sources/{source_id}"): ("delete_gallery_source_api_v1_gallery_sources__source_id__delete", ("200", "422")),
    ("POST", "/api/v1/gallery/sources/{source_id}/relink"): ("relink_gallery_source_api_v1_gallery_sources__source_id__relink_post", ("200", "422")),
    ("POST", "/api/v1/gallery/sources/{source_id}/scan"): ("start_gallery_scan_api_v1_gallery_sources__source_id__scan_post", ("202", "422")),
    ("GET", "/api/v1/gallery/sources/{source_id}/scan"): ("get_gallery_scan_api_v1_gallery_sources__source_id__scan_get", ("200", "422")),
    ("POST", "/api/v1/gallery/sources/{source_id}/reconciliation/retry"): ("retry_gallery_reconciliation_api_v1_gallery_sources__source_id__reconciliation_retry_post", ("202", "422")),
    ("GET", "/api/v1/gallery/directories/{directory_id}/entries"): ("list_gallery_directory_entries_api_v1_gallery_directories__directory_id__entries_get", ("200", "422")),
    ("GET", "/api/v1/gallery/search"): ("search_gallery_assets_api_v1_gallery_search_get", ("200", "422")),
    ("GET", "/api/v1/gallery/assets/{asset_id}"): ("get_gallery_asset_api_v1_gallery_assets__asset_id__get", ("200", "422")),
    ("GET", "/api/v1/gallery/assets/{asset_id}/content"): ("get_gallery_asset_content_api_v1_gallery_assets__asset_id__content_get", ("200", "422")),
    ("GET", "/api/v1/gallery/assets/{asset_id}/thumbnail"): ("get_gallery_asset_thumbnail_api_v1_gallery_assets__asset_id__thumbnail_get", ("200", "422")),
    ("GET", "/api/v1/gallery/assets/{asset_id}/annotation"): ("get_gallery_asset_annotation_api_v1_gallery_assets__asset_id__annotation_get", ("200", "422")),
    ("PUT", "/api/v1/gallery/assets/{asset_id}/annotation"): ("put_gallery_asset_annotation_api_v1_gallery_assets__asset_id__annotation_put", ("200", "422")),
    ("POST", "/api/v1/gallery/assets/{asset_id}/rename"): ("rename_asset_api_v1_gallery_assets__asset_id__rename_post", ("200", "422")),
    ("POST", "/api/v1/gallery/file-operations/trash"): ("trash_assets_api_v1_gallery_file_operations_trash_post", ("200", "422")),
    ("POST", "/api/v1/gallery/file-operations/{operation_id}/undo"): ("undo_trash_api_v1_gallery_file_operations__operation_id__undo_post", ("200", "422")),
    ("GET", "/api/v1/gallery/trash"): ("list_trash_api_v1_gallery_trash_get", ("200", "422")),
    ("POST", "/api/v1/gallery/trash/{operation_id}/restore"): ("restore_trash_api_v1_gallery_trash__operation_id__restore_post", ("200", "422")),
    ("DELETE", "/api/v1/gallery/trash/{operation_id}"): ("purge_trash_api_v1_gallery_trash__operation_id__delete", ("200", "422")),
    ("DELETE", "/api/v1/gallery/trash"): ("purge_all_trash_api_v1_gallery_trash_delete", ("200", "422")),
    ("POST", "/api/v1/gallery/directory-exports"): ("start_gallery_directory_export_api_v1_gallery_directory_exports_post", ("202", "422")),
    ("GET", "/api/v1/gallery/directory-exports/{operation_id}"): ("get_gallery_directory_export_api_v1_gallery_directory_exports__operation_id__get", ("200", "422")),
    ("DELETE", "/api/v1/gallery/directory-exports/{operation_id}"): ("cancel_gallery_directory_export_api_v1_gallery_directory_exports__operation_id__delete", ("200", "422")),
    ("POST", "/api/v1/tasks"): ("create_task_api_v1_tasks_post", ("200", "422")),
    ("GET", "/api/v1/tasks"): ("list_tasks_api_v1_tasks_get", ("200", "422")),
    ("GET", "/api/v1/tasks/{task_id}"): ("get_task_api_v1_tasks__task_id__get", ("200", "422")),
    ("POST", "/api/v1/tasks/{task_id}/cancel"): ("cancel_task_api_v1_tasks__task_id__cancel_post", ("200", "422")),
    ("POST", "/api/v1/tasks/{task_id}/retry"): ("retry_task_api_v1_tasks__task_id__retry_post", ("202", "422")),
    ("GET", "/api/v1/tasks/{task_id}/logs"): ("task_logs_api_v1_tasks__task_id__logs_get", ("200", "422")),
    ("GET", "/api/v1/tasks/{task_id}/events"): ("task_events_api_v1_tasks__task_id__events_get", ("200", "422")),
    ("GET", "/api/v1/tasks/{task_id}/files"): ("list_task_files_api_v1_tasks__task_id__files_get", ("200", "422")),
    ("GET", "/api/v1/tasks/{task_id}/files/{relative_path}"): ("download_task_file_api_v1_tasks__task_id__files__relative_path__get", ("200", "422")),
    ("GET", "/api/v1/search/sites"): ("supported_search_sites_api_v1_search_sites_get", ("200",)),
    ("GET", "/api/v1/search/autocomplete"): ("search_autocomplete_api_v1_search_autocomplete_get", ("200", "422")),
    ("POST", "/api/v1/search"): ("search_candidates_api_v1_search_post", ("200", "422")),
    ("POST", "/api/v1/crawls"): ("create_crawl_api_v1_crawls_post", ("200", "422")),
    ("GET", "/api/v1/crawls"): ("list_crawls_api_v1_crawls_get", ("200", "422")),
    ("GET", "/api/v1/crawls/{batch_id}"): ("get_crawl_api_v1_crawls__batch_id__get", ("200", "422")),
    ("GET", "/api/v1/crawls/{batch_id}/tasks"): ("list_crawl_tasks_api_v1_crawls__batch_id__tasks_get", ("200", "422")),
    ("GET", "/api/v1/crawls/{batch_id}/review"): ("get_crawl_review_api_v1_crawls__batch_id__review_get", ("200", "422")),
    ("POST", "/api/v1/crawls/{batch_id}/review/start"): ("start_crawl_review_api_v1_crawls__batch_id__review_start_post", ("202", "422")),
    ("PUT", "/api/v1/crawls/{batch_id}/review/decisions"): ("update_crawl_review_decisions_api_v1_crawls__batch_id__review_decisions_put", ("200", "422")),
    ("POST", "/api/v1/crawls/{batch_id}/review/apply"): ("apply_crawl_review_api_v1_crawls__batch_id__review_apply_post", ("200", "422")),
    ("POST", "/api/v1/crawls/{batch_id}/review/retry"): ("retry_crawl_review_api_v1_crawls__batch_id__review_retry_post", ("202", "422")),
    ("GET", "/api/v1/crawls/{batch_id}/review/images/{image_id}"): ("get_crawl_review_image_api_v1_crawls__batch_id__review_images__image_id__get", ("200", "422")),
    ("POST", "/api/v1/crawls/{batch_id}/cancel"): ("cancel_crawl_api_v1_crawls__batch_id__cancel_post", ("200", "422")),
    ("POST", "/api/v1/crawls/{batch_id}/retry"): ("retry_crawl_failed_api_v1_crawls__batch_id__retry_post", ("202", "422")),
    ("POST", "/api/v1/crawls/{batch_id}/rerun"): ("rerun_crawl_api_v1_crawls__batch_id__rerun_post", ("202", "422")),
    ("GET", "/api/v1/sites/policies"): ("site_policies_api_v1_sites_policies_get", ("200", "422")),
    ("GET", "/api/v1/sites/policies/{site}"): ("get_site_policy_api_v1_sites_policies__site__get", ("200", "422")),
    ("PUT", "/api/v1/sites/policies/{site}"): ("put_site_policy_api_v1_sites_policies__site__put", ("200", "422")),
    ("DELETE", "/api/v1/sites/policies/{site}"): ("delete_site_policy_api_v1_sites_policies__site__delete", ("200", "422")),
    ("GET", "/api/v1/proxy/sources"): ("proxy_sources_api_v1_proxy_sources_get", ("200", "422")),
    ("POST", "/api/v1/proxy/sources/subscriptions"): ("add_proxy_subscription_api_v1_proxy_sources_subscriptions_post", ("200", "422")),
    ("PUT", "/api/v1/proxy/sources/subscriptions/{source_id}"): ("replace_proxy_subscription_api_v1_proxy_sources_subscriptions__source_id__put", ("200", "422")),
    ("DELETE", "/api/v1/proxy/sources/subscriptions/{source_id}"): ("delete_proxy_subscription_api_v1_proxy_sources_subscriptions__source_id__delete", ("200", "422")),
    ("PUT", "/api/v1/proxy/sources/node-file"): ("set_proxy_node_file_api_v1_proxy_sources_node_file_put", ("200", "422")),
    ("DELETE", "/api/v1/proxy/sources/node-file"): ("clear_proxy_node_file_api_v1_proxy_sources_node_file_delete", ("200", "422")),
    ("POST", "/api/v1/proxy/sources/inline-nodes"): ("add_proxy_inline_nodes_api_v1_proxy_sources_inline_nodes_post", ("200", "422")),
    ("PUT", "/api/v1/proxy/sources/inline-nodes/{source_id}"): ("replace_proxy_inline_node_api_v1_proxy_sources_inline_nodes__source_id__put", ("200", "422")),
    ("DELETE", "/api/v1/proxy/sources/inline-nodes/{source_id}"): ("delete_proxy_inline_node_api_v1_proxy_sources_inline_nodes__source_id__delete", ("200", "422")),
    ("DELETE", "/api/v1/proxy/sources/override"): ("reset_proxy_sources_override_api_v1_proxy_sources_override_delete", ("200", "422")),
    ("GET", "/api/v1/proxy/status"): ("proxy_status_api_v1_proxy_status_get", ("200", "422")),
    ("POST", "/api/v1/proxy/start"): ("proxy_start_api_v1_proxy_start_post", ("200", "422")),
    ("POST", "/api/v1/proxy/reload"): ("proxy_reload_api_v1_proxy_reload_post", ("200", "422")),
    ("POST", "/api/v1/proxy/stop"): ("proxy_stop_api_v1_proxy_stop_post", ("200", "422")),
    ("POST", "/api/v1/proxy/probe"): ("proxy_probe_api_v1_proxy_probe_post", ("200", "422")),
    ("GET", "/api/v1/scheduler/status"): ("scheduler_status_api_v1_scheduler_status_get", ("200", "422")),
}


def _included_api_routes(router):
    for route in router.routes:
        if isinstance(route, APIRoute):
            yield route
            continue
        original = getattr(route, "original_router", None)
        if original is not None:
            yield from _included_api_routes(original)


class AppRoutingContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temp.name))
        self.container = ServiceContainer(self.settings)
        self.app = create_app(
            self.settings,
            container=self.container,
            start_background=False,
        )
        self.client_context = local_test_client(self.app, self.settings)
        self.client = self.client_context.__enter__()

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.temp.cleanup()

    def test_http_and_openapi_operation_contract_is_unchanged(self):
        actual = {}
        for path, path_item in self.app.openapi()["paths"].items():
            for method, operation in path_item.items():
                if method not in {"get", "post", "put", "delete", "patch"}:
                    continue
                actual[(method.upper(), path)] = (
                    operation["operationId"],
                    tuple(operation["responses"]),
                )

        self.assertEqual(actual, _EXPECTED_OPENAPI_OPERATIONS)
        operation_ids = [operation_id for operation_id, _responses in actual.values()]
        self.assertEqual(len(operation_ids), len(set(operation_ids)))

    def test_domain_routes_share_the_request_scoped_container_dependency(self):
        routes = {
            (next(iter(route.methods)), route.path): route
            for route in _included_api_routes(self.app.router)
        }
        service_free = {
            ("GET", "/"),
            ("GET", "/api/v1/search/sites"),
        }
        dependency_calls = set()
        for key, route in routes.items():
            if key in service_free:
                continue
            matches = [
                dependency.call
                for dependency in route.dependant.dependencies
                if getattr(dependency.call, "__name__", "") == "get_service"
            ]
            self.assertEqual(len(matches), 1, key)
            dependency_calls.add(matches[0])

        self.assertEqual(len(dependency_calls), 1)
        dependency = dependency_calls.pop()
        request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(container=self.container))
        )
        self.assertIs(dependency(request), self.container)
        self.assertIs(self.app.state.container, self.container)

        for key, route in routes.items():
            self.assertTrue(
                route.endpoint.__module__.startswith("gdl_backend.api_routes."),
                key,
            )
            closure_values = [
                cell.cell_contents for cell in (route.endpoint.__closure__ or ())
            ]
            self.assertFalse(
                any(value is self.container for value in closure_values),
                key,
            )

    def test_each_domain_is_owned_by_its_router_module(self):
        routes = {
            (next(iter(route.methods)), route.path): route
            for route in _included_api_routes(self.app.router)
        }
        expected_modules = {
            "diagnostics": "gdl_backend.api_routes.diagnostics",
            "auth": "gdl_backend.api_routes.auth",
            "tasks": "gdl_backend.api_routes.tasks",
            "discovery": "gdl_backend.api_routes.discovery",
            "crawls": "gdl_backend.api_routes.crawls",
            "review": "gdl_backend.api_routes.review",
            "gallery": "gdl_backend.api_routes.gallery",
            "policies": "gdl_backend.api_routes.policies",
            "proxy": "gdl_backend.api_routes.proxy",
            "scheduler": "gdl_backend.api_routes.scheduler",
        }

        for key, route in routes.items():
            path = route.path
            if path in {"/", "/healthz", "/readyz", "/api/v1/config"}:
                domain = "diagnostics"
            elif path.startswith("/api/v1/auth"):
                domain = "auth"
            elif path.startswith("/api/v1/tasks"):
                domain = "tasks"
            elif path.startswith("/api/v1/search"):
                domain = "discovery"
            elif "/review" in path:
                domain = "review"
            elif path.startswith("/api/v1/crawls"):
                domain = "crawls"
            elif path.startswith("/api/v1/gallery"):
                domain = "gallery"
            elif path.startswith("/api/v1/sites/policies"):
                domain = "policies"
            elif path.startswith("/api/v1/proxy"):
                domain = "proxy"
            elif path.startswith("/api/v1/scheduler"):
                domain = "scheduler"
            else:
                self.fail(f"unowned route: {key}")
            self.assertEqual(route.endpoint.__module__, expected_modules[domain], key)

    def test_search_input_plan_and_result_aggregation_are_pure(self):
        body = SearchRequest.model_validate(
            {
                "keyword": "fixture artist",
                "sites": ["twitter", "pixiv"],
                "proxy_mode": "prefer",
                "source_options": {
                    "twitter": {
                        "proxy_mode": "required",
                        "search_extra_args": ["--range", "1-3"],
                    }
                },
            }
        )
        original = body.model_dump()

        plan = _build_search_plan(body)

        self.assertEqual(
            plan.execution_sites,
            ("danbooru", "twitter", "pixiv"),
        )
        self.assertTrue(plan.implicit_danbooru)
        self.assertTrue(plan.needs_artist_directory)
        self.assertEqual(plan.options["danbooru"]["proxy_mode"], "prefer")
        self.assertEqual(plan.options["twitter"]["proxy_mode"], "required")
        self.assertEqual(
            plan.options["twitter"]["search_extra_args"],
            ["--range", "1-3"],
        )
        self.assertEqual(body.model_dump(), original)

        sources = [
            {
                "site": "twitter",
                "addresses": [{"url": "https://x.com/fixture"}],
                "weak_evidence": [],
            }
        ]
        result = _aggregate_search_result(
            keyword=body.keyword,
            sources=sources,
            related_profiles=[],
            enrichment_errors=[],
        )
        self.assertEqual(
            set(result),
            {
                "keyword",
                "source_count",
                "address_count",
                "weak_evidence_count",
                "sources",
                "related_profiles",
                "enrichment_errors",
                "selection_contract",
                "tag_filter_contract",
            },
        )
        self.assertEqual(result["source_count"], 1)
        self.assertEqual(result["address_count"], 1)
        self.assertIs(result["sources"], sources)

    def test_error_envelope_codes_statuses_and_request_id_are_stable(self):
        cases = (
            ("missing task", "get", "/api/v1/tasks/missing", None, 404, "task_not_found"),
            ("invalid list limit", "get", "/api/v1/tasks?limit=0", None, 422, "validation_error"),
            ("unsupported policy", "get", "/api/v1/sites/policies/not-supported", None, 422, "unsupported_policy_site"),
            ("missing crawl", "get", "/api/v1/crawls/missing", None, 404, "crawl_not_found"),
        )
        for label, method, path, payload, status, code in cases:
            with self.subTest(label=label):
                response = self.client.request(
                    method,
                    path,
                    json=payload,
                    headers={"X-Request-ID": "phase-5a-contract"},
                )
                self.assertEqual(response.status_code, status, response.text)
                self.assertEqual(
                    set(response.json()),
                    {"error"},
                )
                error = response.json()["error"]
                self.assertEqual(
                    set(error),
                    {"code", "message", "details", "request_id"},
                )
                self.assertEqual(error["code"], code)
                self.assertEqual(error["request_id"], "phase-5a-contract")

    def test_diagnostics_response_profiles_keep_exact_whitelists(self):
        config = self.client.get("/api/v1/config?view=diagnostics")
        self.assertEqual(config.status_code, 200, config.text)
        payload = config.json()
        self.assertEqual(
            set(payload),
            {"response_profile", "secrets_exposed", "server", "gallery", "proxy", "scheduler", "dedup"},
        )
        self.assertEqual(
            set(payload["server"]),
            {"loopback_only", "cors_enabled", "private_targets_enabled"},
        )
        self.assertEqual(set(payload["gallery"]), {"managed_auth_cache"})
        self.assertEqual(
            set(payload["proxy"]),
            {"enabled", "auto_start", "transport_core_enabled"},
        )
        self.assertEqual(set(payload["scheduler"]), {"max_concurrent_tasks"})
        self.assertEqual(
            set(payload["dedup"]),
            {"enabled", "configured_device", "sscd_enabled", "dino_enabled"},
        )

        scheduler = self.client.get("/api/v1/scheduler/status?view=diagnostics")
        self.assertEqual(scheduler.status_code, 200, scheduler.text)
        snapshot = scheduler.json()
        self.assertEqual(
            set(snapshot),
            {"response_profile", "secrets_exposed", "tasks", "ordered_crawls"},
        )
        self.assertEqual(
            set(snapshot["tasks"]),
            {"running", "active", "max_concurrent", "active_site_count", "dispatch_loop"},
        )
        self.assertEqual(
            set(snapshot["tasks"]["dispatch_loop"]),
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
        self.assertEqual(
            set(snapshot["ordered_crawls"]),
            {"running", "active_batches", "execution_order", "address_parallelism"},
        )
