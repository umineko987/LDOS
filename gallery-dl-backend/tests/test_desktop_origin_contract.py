from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gdl_backend.app import create_app
from gdl_backend.config import AppSettings
from tests.helpers import local_test_client, make_settings


TAURI_ORIGIN = "tauri://localhost"
WINDOWS_TAURI_ORIGIN = "http://tauri.localhost"
VITE_ORIGIN = "http://localhost:1420"


class DesktopOriginConfigTests(unittest.TestCase):
    def test_only_exact_tauri_and_loopback_vite_origins_are_normalized(self) -> None:
        settings = AppSettings()
        settings.server.cors_origins = [
            f" {TAURI_ORIGIN}/ ",
            WINDOWS_TAURI_ORIGIN,
            VITE_ORIGIN,
            "http://[::1]:1420/",
            TAURI_ORIGIN,
        ]

        settings.validate()

        self.assertEqual(
            settings.server.cors_origins,
            [
                TAURI_ORIGIN,
                WINDOWS_TAURI_ORIGIN,
                VITE_ORIGIN,
                "http://[::1]:1420",
            ],
        )

    def test_supervised_desktop_origin_augments_legacy_config_safely(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.json"
            config_path.write_text(
                json.dumps({"server": {"cors_origins": []}}),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {"LDOS_DESKTOP_ORIGIN": VITE_ORIGIN},
            ):
                settings = AppSettings.load(config_path)

            self.assertEqual(settings.server.cors_origins, [VITE_ORIGIN])

            with patch.dict(
                os.environ,
                {"LDOS_DESKTOP_ORIGIN": "https://evil.example.com"},
            ):
                with self.assertRaisesRegex(ValueError, r"server\.cors_origins"):
                    AppSettings.load(config_path)

    def test_wildcards_remote_origins_and_non_origin_values_are_rejected(self) -> None:
        invalid_values = (
            "*",
            "null",
            "https://evil.example.com",
            "tauri://evil.example.com",
            "http://localhost",
            "http://localhost:1420/path",
            "http://user:secret@localhost:1420",
            "http://localhost:1420?token=secret",
            "file://localhost/app",
            42,
        )
        for value in invalid_values:
            with self.subTest(value=value):
                settings = AppSettings()
                settings.server.cors_origins = [value]  # type: ignore[list-item]
                with self.assertRaisesRegex(ValueError, r"server\.cors_origins"):
                    settings.validate()

        settings = AppSettings()
        settings.server.cors_origins = TAURI_ORIGIN  # type: ignore[assignment]
        with self.assertRaisesRegex(ValueError, "必须是 origin 列表"):
            settings.validate()


class DesktopOriginHttpContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.settings = make_settings(self.root)
        self.settings.server.port = 19091
        self.settings.server.cors_origins = [
            TAURI_ORIGIN,
            WINDOWS_TAURI_ORIGIN,
            VITE_ORIGIN,
        ]
        self.app = create_app(self.settings, start_background=False)
        self.client_context = local_test_client(self.app, self.settings)
        self.client = self.client_context.__enter__()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.temporary.cleanup()

    @staticmethod
    def cross_origin_headers(origin: str = TAURI_ORIGIN) -> dict[str, str]:
        return {
            "Origin": origin,
            "Sec-Fetch-Site": "cross-site",
        }

    def test_exact_configured_tauri_and_vite_origins_reach_healthz(self) -> None:
        for origin, fetch_site in (
            (TAURI_ORIGIN, "cross-site"),
            (WINDOWS_TAURI_ORIGIN, "cross-site"),
            (VITE_ORIGIN, "same-site"),
        ):
            with self.subTest(origin=origin):
                response = self.client.get(
                    "/healthz",
                    headers={"Origin": origin, "Sec-Fetch-Site": fetch_site},
                )
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.headers["Access-Control-Allow-Origin"], origin)
                self.assertEqual(
                    response.headers["Access-Control-Expose-Headers"],
                    "X-Request-ID",
                )
                self.assertTrue(response.headers["X-Request-ID"])

    def test_same_origin_browser_requests_remain_allowed(self) -> None:
        origin = f"http://127.0.0.1:{self.settings.server.port}"
        response = self.client.get(
            "/healthz",
            headers={"Origin": origin, "Sec-Fetch-Site": "same-origin"},
        )
        self.assertEqual(response.status_code, 200, response.text)

        no_origin = self.client.get("/healthz", headers={"Sec-Fetch-Site": "none"})
        self.assertEqual(no_origin.status_code, 200, no_origin.text)

    def test_every_other_cross_origin_remains_forbidden(self) -> None:
        cases = (
            {"Origin": "https://evil.example.com", "Sec-Fetch-Site": "cross-site"},
            {"Origin": "https://evil.example.com", "Sec-Fetch-Site": "same-site"},
            {"Origin": "https://evil.example.com"},
            {"Sec-Fetch-Site": "cross-site"},
        )
        for headers in cases:
            with self.subTest(headers=headers):
                response = self.client.get("/healthz", headers=headers)
                self.assertEqual(response.status_code, 403, response.text)
                self.assertEqual(
                    response.json()["error"]["code"],
                    "forbidden_cross_site",
                )
                self.assertNotIn("Access-Control-Allow-Origin", response.headers)

    def test_preflight_allows_only_used_methods_and_headers(self) -> None:
        response = self.client.options(
            "/api/v1/auth/proxy",
            headers={
                **self.cross_origin_headers(VITE_ORIGIN),
                "Access-Control-Request-Method": "PUT",
                "Access-Control-Request-Headers": (
                    "accept,content-type,idempotency-key,x-request-id"
                ),
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], VITE_ORIGIN)
        self.assertEqual(
            response.headers["Access-Control-Allow-Methods"],
            "GET, POST, PUT, DELETE",
        )
        allowed_headers = {
            value.strip().lower()
            for value in response.headers["Access-Control-Allow-Headers"].split(",")
        }
        self.assertTrue(
            {"accept", "content-type", "idempotency-key", "x-request-id"}
            <= allowed_headers
        )
        self.assertNotIn("authorization", allowed_headers)

        denied = self.client.options(
            "/api/v1/auth/proxy",
            headers={
                **self.cross_origin_headers(VITE_ORIGIN),
                "Access-Control-Request-Method": "PUT",
                "Access-Control-Request-Headers": "authorization",
            },
        )
        self.assertEqual(denied.status_code, 400, denied.text)

    def test_cross_origin_write_keeps_request_id_and_error_envelope_contract(self) -> None:
        request_id = "desktop-write-contract"
        response = self.client.put(
            "/api/v1/auth/proxy",
            json={"proxy_url": ""},
            headers={
                **self.cross_origin_headers(),
                "Idempotency-Key": "desktop-write-0001",
                "X-Request-ID": request_id,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], TAURI_ORIGIN)
        self.assertEqual(response.headers["X-Request-ID"], request_id)
        self.assertNotIn("error", response.json())

        missing = self.client.delete(
            "/api/v1/auth/not-supported",
            headers={
                **self.cross_origin_headers(),
                "X-Request-ID": request_id,
            },
        )
        self.assertEqual(missing.status_code, 404, missing.text)
        self.assertEqual(
            set(missing.json()["error"]),
            {"code", "message", "details", "request_id"},
        )
        self.assertEqual(missing.json()["error"]["request_id"], request_id)
        self.assertEqual(missing.headers["Access-Control-Allow-Origin"], TAURI_ORIGIN)

    def test_cross_origin_media_and_static_images_are_canvas_safe(self) -> None:
        created = self.client.post(
            "/api/v1/tasks",
            json={
                "url": "https://www.pixiv.net/artworks/123456",
                "proxy_mode": "direct",
            },
        )
        self.assertEqual(created.status_code, 202, created.text)
        task = created.json()
        image_path = Path(task["output_dir"]) / "pixel.png"
        image_path.parent.mkdir(parents=True, exist_ok=True)
        image_path.write_bytes(b"\x89PNG\r\n\x1a\ncontract")

        media = self.client.get(
            f"/api/v1/tasks/{task['id']}/files/pixel.png",
            headers=self.cross_origin_headers(),
        )
        self.assertEqual(media.status_code, 200, media.text)
        self.assertEqual(media.headers["Content-Type"], "image/png")
        self.assertEqual(media.headers["Access-Control-Allow-Origin"], TAURI_ORIGIN)
        self.assertEqual(
            media.headers["Cross-Origin-Resource-Policy"],
            "cross-origin",
        )


if __name__ == "__main__":
    unittest.main()
