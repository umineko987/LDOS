from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from .config import AUTH_PROXY_SCHEMES


SUPPORTED_AUTH_SITES = ("danbooru", "twitter", "pixiv", "exhentai", "pawchive")
VAULT_RESPONSE_PROFILE = "vault"

# Immutable copies keep the projection deterministic even if a caller mutates
# unrelated runtime settings. This module performs no file, process or network I/O.
_AUTH_PROXY_SCHEMES = frozenset(AUTH_PROXY_SCHEMES)
_VAULT_SESSION_STATES = frozenset(
    {
        "starting",
        "starting_browser",
        "awaiting_login",
        "awaiting_code",
        "exchanging",
        "authorized",
        "cancelled",
        "timed_out",
        "failed",
        "token_ready",
    }
)
_VAULT_SITE_METHODS = {
    "danbooru": ("Danbooru", "anonymous", ()),
    "twitter": ("X / Twitter", "managed_browser", ("managed_browser_login", "clear")),
    "pixiv": ("Pixiv", "oauth", ("oauth", "clear")),
    "exhentai": ("EH", "managed_browser", ("managed_browser_login", "clear")),
    "pawchive": ("Pawchive", "anonymous", ()),
}
_MANAGED_BROWSER_SITES = frozenset({"twitter", "exhentai"})
_SHARED_PROFILE_SITES = ("twitter", "pixiv", "exhentai")


def _vault_timestamp(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    numeric = float(value)
    return numeric if numeric == numeric and 0 <= numeric <= 4_102_444_800 else None


def _session_id(value: object) -> str:
    session_id = str(value or "")
    if len(session_id) != 32:
        return ""
    return session_id if all(char in "0123456789abcdef" for char in session_id) else ""


def _bounded_count(value: object) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return min(value, 100_000)
    return 0


def vault_safe_session(value: Any, *, site: str | None = None) -> dict[str, Any] | None:
    """Project only polling fields; URLs, messages and credential material are excluded."""

    if not isinstance(value, dict):
        return None
    session_id = _session_id(value.get("session_id"))
    state = str(value.get("state") or "")
    if not session_id or state not in _VAULT_SESSION_STATES:
        return None
    result: dict[str, Any] = {
        "session_id": session_id,
        "state": state,
        "created_at": _vault_timestamp(value.get("created_at")),
        "expires_at": _vault_timestamp(value.get("expires_at")),
    }
    if site in _VAULT_SITE_METHODS:
        result["site"] = site
    if site in _MANAGED_BROWSER_SITES:
        result["cookie_count"] = _bounded_count(value.get("cookie_count"))
    return result


def _vault_summary(site: str, state: str, authorized: bool, invalidated: bool) -> str:
    if site in {"danbooru", "pawchive"}:
        return "后端声明此目标使用公开访问，不需要登录材料。"
    if state == "authorizing":
        return "共享授权浏览器流程正在进行。"
    if invalidated:
        return "后端已在实际访问中判定现有授权材料失效。"
    if authorized:
        return "后端检测到托管授权材料；此状态不代表远端验证成功。"
    return "后端当前没有可供任务使用的托管授权材料。"


def vault_safe_status(value: Any) -> dict[str, Any]:
    """Strict allowlist projection for one site's vault response."""

    if not isinstance(value, dict):
        raise ValueError("授权状态不是对象")
    site = str(value.get("site") or "")
    definition = _VAULT_SITE_METHODS.get(site)
    if definition is None:
        raise ValueError("授权状态包含未知目标")
    label, method, actions = definition
    state = str(value.get("state") or "required")
    if state not in {"ready", "authorized", "authorizing", "required"}:
        state = "required"
    authorized = value.get("authorized") is True
    invalidated_at = _vault_timestamp(value.get("invalidated_at"))
    result: dict[str, Any] = {
        "site": site,
        "label": label,
        "method": method,
        "state": state,
        "authorized": authorized,
        "summary": _vault_summary(site, state, authorized, invalidated_at is not None),
        "updated_at": _vault_timestamp(value.get("updated_at")),
        "invalidated_at": invalidated_at,
        "actions": list(actions),
    }
    if method == "managed_browser":
        cookie = value.get("cookies") if isinstance(value.get("cookies"), dict) else {}
        result.update({"browser": "project_chrome", "profile": "shared"})
        result["cookies"] = {
            "present": cookie.get("present") is True,
            "valid": cookie.get("valid") is True,
            "cookie_count": _bounded_count(cookie.get("cookie_count")),
            "updated_at": _vault_timestamp(cookie.get("updated_at")),
        }
        result["login"] = vault_safe_session(value.get("login"), site=site)
    elif method == "oauth":
        result.update({"browser": "project_chrome", "profile": "shared"})
        result["oauth"] = vault_safe_session(value.get("oauth"), site=site)
    return result


def _vault_masked_proxy(value: Any) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 300:
        return None
    try:
        parsed = urlsplit(value)
        scheme = (parsed.scheme or "").lower()
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    if (
        scheme not in _AUTH_PROXY_SCHEMES
        or not hostname
        or port is None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or any(ord(char) <= 32 or ord(char) == 127 for char in value)
    ):
        return None
    host = f"[{hostname}]" if ":" in hostname else hostname
    credentials = "***@" if parsed.username is not None or parsed.password is not None else ""
    return f"{scheme}://{credentials}{host}:{port}"


def vault_safe_proxy_status(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("授权代理状态不是对象")
    source = value.get("source") if value.get("source") in {"runtime", "config", "none"} else "none"
    return {
        "proxy_url": _vault_masked_proxy(value.get("proxy_url")),
        "source": source,
        "credentials_redacted": value.get("credentials_redacted") is True,
        "browser_running": value.get("browser_running") is True,
        "restart_pending": value.get("restart_pending") is True,
        "updated_at": _vault_timestamp(value.get("updated_at")),
    }


def vault_safe_browser_profile(value: Any) -> dict[str, Any]:
    profile = value if isinstance(value, dict) else {}
    return {
        "shared": profile.get("shared") is True,
        "present": profile.get("present") is True,
        "running": profile.get("running") is True,
        "resetting": profile.get("resetting") is True,
        "sites": list(_SHARED_PROFILE_SITES),
    }


def vault_safe_statuses(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("授权状态快照不是对象")
    raw_items = value.get("items") if isinstance(value.get("items"), list) else []
    by_site: dict[str, dict[str, Any]] = {}
    for item in raw_items[: len(SUPPORTED_AUTH_SITES) * 2]:
        try:
            projected = vault_safe_status(item)
        except ValueError:
            continue
        by_site.setdefault(projected["site"], projected)
    return {
        "items": [by_site[site] for site in SUPPORTED_AUTH_SITES if site in by_site],
        "browser_profile": vault_safe_browser_profile(value.get("browser_profile")),
        "authorization_proxy": vault_safe_proxy_status(value.get("authorization_proxy")),
        "managed": value.get("managed") is True,
        "secrets_exposed": False,
        "response_profile": VAULT_RESPONSE_PROFILE,
    }


def chrome_proxy_server(proxy_url: str) -> str:
    """Return Chrome's credential-free --proxy-server value."""

    parsed = urlsplit(proxy_url)
    scheme = (parsed.scheme or "").lower()
    scheme = {"socks5h": "socks5", "socks4a": "socks4"}.get(scheme, scheme)
    hostname = parsed.hostname or ""
    host = f"[{hostname}]" if ":" in hostname else hostname
    port = parsed.port
    return f"{scheme}://{host}:{port}" if port is not None else f"{scheme}://{host}"
