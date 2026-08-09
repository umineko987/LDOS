from __future__ import annotations

import json
import pickle
import unittest

from gdl_backend import auth as auth_facade
from gdl_backend.auth_projection import (
    chrome_proxy_server,
    vault_safe_session,
    vault_safe_statuses,
)
from gdl_backend.pixiv_oauth_protocol import (
    MAX_PIXIV_CACHE_VALUE_BYTES,
    decode_pixiv_cache_token,
    extract_pixiv_oauth_code,
    find_pixiv_login_url,
    pixiv_login_url_is_valid,
    pixiv_oauth_callback_is_valid,
)


class AuthProjectionProtocolTests(unittest.TestCase):
    def test_auth_module_keeps_compatibility_exports(self):
        self.assertIs(auth_facade.vault_safe_statuses, vault_safe_statuses)
        self.assertIs(auth_facade.chrome_proxy_server, chrome_proxy_server)
        self.assertIs(auth_facade._decode_pixiv_cache_token, decode_pixiv_cache_token)

    def test_projection_is_a_strict_deterministic_allowlist(self):
        secret = "AUTH_PROTOCOL_SECRET"
        projected = vault_safe_statuses(
            {
                "items": [
                    {
                        "site": "pixiv",
                        "state": "authorizing",
                        "authorized": False,
                        "updated_at": 10,
                        "oauth": {
                            "session_id": "a" * 32,
                            "state": "awaiting_login",
                            "created_at": 10,
                            "expires_at": 20,
                            "authorization_url": f"https://example.invalid/{secret}",
                            "message": secret,
                            "error": secret,
                        },
                        "raw": secret,
                    }
                ],
                "browser_profile": {"shared": True, "path": f"/home/{secret}"},
                "authorization_proxy": {
                    "proxy_url": f"http://user:{secret}@127.0.0.1:7890",
                    "config_proxy_url": f"http://{secret}",
                    "source": "runtime",
                    "credentials_redacted": True,
                },
                "managed": True,
                "raw": secret,
            }
        )
        self.assertEqual(
            set(projected),
            {
                "items",
                "browser_profile",
                "authorization_proxy",
                "managed",
                "secrets_exposed",
                "response_profile",
            },
        )
        self.assertEqual(
            set(projected["items"][0]["oauth"]),
            {"session_id", "state", "created_at", "expires_at", "site"},
        )
        rendered = json.dumps(projected)
        self.assertNotIn(secret, rendered)
        self.assertNotIn("authorization_url", rendered)
        self.assertNotIn("config_proxy_url", rendered)

    def test_session_projection_rejects_noncanonical_ids_and_states(self):
        self.assertIsNone(vault_safe_session({"session_id": "A" * 32, "state": "starting"}))
        self.assertIsNone(vault_safe_session({"session_id": "a" * 31, "state": "starting"}))
        self.assertIsNone(vault_safe_session({"session_id": "a" * 32, "state": "raw-secret"}))

    def test_restricted_cache_protocol_preserves_only_supported_forms(self):
        token = "pixiv-protocol-token"
        self.assertEqual(decode_pixiv_cache_token(token), token)
        self.assertEqual(decode_pixiv_cache_token(pickle.dumps(token)), token)
        self.assertIsNone(decode_pixiv_cache_token(pickle.dumps(None)))
        self.assertIsNone(decode_pixiv_cache_token(pickle.dumps({"token": token})))
        self.assertIsNone(decode_pixiv_cache_token(pickle.dumps(token) + b"tail"))
        self.assertIsNone(decode_pixiv_cache_token(b"legacy-blob-token"))
        self.assertIsNone(decode_pixiv_cache_token("x" * (MAX_PIXIV_CACHE_VALUE_BYTES + 1)))

    def test_login_and_callback_parsers_keep_exact_protocol_boundaries(self):
        login = (
            "https://app-api.pixiv.net/web/v1/login?client=pixiv-android"
            "&code_challenge=CHALLENGE"
        )
        callback = (
            "https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback"
            "?state=STATE&code=CODE%2BVALUE"
        )
        self.assertEqual(find_pixiv_login_url(f"prefix {login}\nsuffix"), login)
        self.assertTrue(pixiv_login_url_is_valid(login))
        self.assertFalse(pixiv_login_url_is_valid("http://app-api.pixiv.net/web/v1/login?x=1"))
        self.assertTrue(pixiv_oauth_callback_is_valid(callback))
        self.assertFalse(pixiv_oauth_callback_is_valid(callback.replace("state=STATE&", "")))
        self.assertFalse(pixiv_oauth_callback_is_valid(callback.replace("code=CODE%2BVALUE", "code=")))
        self.assertFalse(
            pixiv_oauth_callback_is_valid(
                callback.replace("state=STATE", "state=ONE&state=TWO")
            )
        )
        self.assertEqual(extract_pixiv_oauth_code(callback), "CODE+VALUE")
        self.assertEqual(extract_pixiv_oauth_code("code=RAW"), "RAW")
        self.assertEqual(extract_pixiv_oauth_code("RAW-CODE"), "RAW-CODE")


if __name__ == "__main__":
    unittest.main()
