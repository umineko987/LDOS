from __future__ import annotations

import asyncio
import json
import os
import shutil
import sqlite3
import sys
import time
import uuid
from contextlib import closing
from dataclasses import dataclass, field
from http.cookiejar import MozillaCookieJar
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .auth_adapters import (
    BrowserHost as ManagedBrowserHost,
    BrowserOrchestrator,
    BrowserOrchestratorError,
    BrowserRuntimeAdapter,
    GalleryDlPixivOAuthAdapter,
)
from .auth_projection import (
    SUPPORTED_AUTH_SITES,
    VAULT_RESPONSE_PROFILE,
    chrome_proxy_server,
    vault_safe_browser_profile,
    vault_safe_proxy_status,
    vault_safe_session,
    vault_safe_status,
    vault_safe_statuses,
)
from .config import AppSettings, normalize_authorization_proxy
from .file_security import (
    ensure_private_directory,
    reject_symlink_path,
    secure_private_path,
    secure_sqlite_files,
    write_private_text,
)
from .managed_browser import (
    MANAGED_BROWSER_SITES,
    allocate_debug_port,
    capture_pixiv_oauth_callback,
    close_browser,
    close_target,
    discover_chrome_executable,
    get_site_cookies,
    managed_login_ready,
    open_login_target,
    read_browser_websocket,
    write_netscape_cookies,
)
from .pixiv_oauth_protocol import (
    MAX_PIXIV_CACHE_VALUE_BYTES as _MAX_PIXIV_CACHE_VALUE_BYTES,
    PIXIV_LOGIN_URL_RE,
    PixivCacheTokenUnpickler as _PixivCacheTokenUnpickler,
    decode_pixiv_cache_token as _decode_pixiv_cache_token,
    extract_pixiv_oauth_code,
    find_pixiv_login_url,
)
from .process_control import terminate_process
from .proxy_runtime import mask_proxy


COOKIE_REQUIREMENTS: dict[str, tuple[str, ...]] = {
    "twitter": ("auth_token", "ct0"),
    "exhentai": ("ipb_member_id", "ipb_pass_hash"),
}
COOKIE_LABELS = {
    "twitter": "X 导出凭证",
    "exhentai": "EH 导出凭证",
}
# auth-metadata.json 以站点名为键；下划线前缀保证与 SUPPORTED_AUTH_SITES 永不冲突。
AUTH_PROXY_METADATA_KEY = "_authorization_proxy"
MAX_AUTH_PROXY_REQUEST_BYTES = 1_024


class AuthError(RuntimeError):
    def __init__(self, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


@dataclass(slots=True)
class PixivOAuthSession:
    id: str
    process: asyncio.subprocess.Process
    created_at: float
    cache_file: Path
    authorization_url: str = ""
    state: str = "starting"
    message: str = "正在启动 Pixiv 登录授权。"
    error: str = ""
    completion_claimed: bool = False
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    reader_task: asyncio.Task[None] | None = None
    browser_websocket_url: str = ""
    browser_target_id: str = ""
    browser_task: asyncio.Task[None] | None = None

    def public_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.id,
            "state": self.state,
            "message": self.message,
            "authorization_url": self.authorization_url or None,
            "created_at": self.created_at,
            "expires_at": self.created_at + 600,
            "error": self.error or None,
            "browser": "project_chrome",
            "profile": "shared",
            "automatic_callback": True,
        }


@dataclass(slots=True)
class ManagedBrowserLoginSession:
    id: str
    site: str
    created_at: float
    expires_at: float
    state: str = "starting"
    message: str = "正在启动项目专属登录窗口。"
    error: str = ""
    websocket_url: str = ""
    target_id: str = ""
    cookie_count: int = 0
    recommended_missing: list[str] = field(default_factory=list)
    monitor_task: asyncio.Task[None] | None = None

    def public_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.id,
            "site": self.site,
            "state": self.state,
            "message": self.message,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "cookie_count": self.cookie_count,
            "recommended_missing": list(self.recommended_missing),
            "error": self.error or None,
        }


class AuthManager:
    """Manage local site authorization without exposing credential values to API clients."""

    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self.managed_dir = Path(
            os.path.abspath(os.fspath(settings.allowed_cookie_roots[0] / "managed"))
        )
        ensure_private_directory(self.managed_dir)
        self.browser_profiles_dir = self.managed_dir / "browser-profiles"
        ensure_private_directory(self.browser_profiles_dir)
        self.browser_profile_dir = self.browser_profiles_dir / "shared"
        self.cache_file = Path(os.path.abspath(os.fspath(settings.gallery.cache_file)))
        ensure_private_directory(
            self.cache_file.parent,
            repair_existing=settings.is_dedicated_credentials_directory(
                self.cache_file.parent
            ),
        )
        self.metadata_file = self.managed_dir / "auth-metadata.json"
        self._lock = asyncio.Lock()
        self._authorization_lock = asyncio.Lock()
        browser_runtime = BrowserRuntimeAdapter(
            # These late-bound lambdas intentionally preserve auth.py's historical
            # patch seams while routing production I/O through an explicit adapter.
            discover_chrome=lambda configured: discover_chrome_executable(configured),
            allocate_debug_port=lambda: allocate_debug_port(),
            spawn_process=lambda *command, **kwargs: asyncio.create_subprocess_exec(
                *command,
                **kwargs,
            ),
            read_browser_websocket=lambda port: read_browser_websocket(port),
            open_login_target=lambda websocket, url: open_login_target(websocket, url),
            capture_pixiv_callback=lambda websocket, target, url, **kwargs: (
                capture_pixiv_oauth_callback(websocket, target, url, **kwargs)
            ),
            get_site_cookies=lambda websocket, spec: get_site_cookies(websocket, spec),
            managed_login_ready=lambda websocket, spec, target: managed_login_ready(
                websocket,
                spec,
                target,
            ),
            close_target=lambda websocket, target: close_target(websocket, target),
            close_browser=lambda websocket: close_browser(websocket),
            write_netscape_cookies=lambda path, cookies: write_netscape_cookies(
                path,
                cookies,
            ),
            terminate_process=lambda process, timeout: terminate_process(process, timeout),
        )
        self._browser_orchestrator = BrowserOrchestrator(
            profile_dir=self.browser_profile_dir,
            chrome_executable=settings.auth.chrome_executable,
            login_timeout_seconds=settings.auth.browser_login_timeout_seconds,
            proxy_provider=self.authorization_proxy,
            runtime=browser_runtime,
        )
        # Private lock/host names remain as the thinnest compatibility surface for
        # tests and internal callers that patched auth.py before the adapter split.
        self._host_lock = self._browser_orchestrator.host_lock
        self._pixiv_oauth_adapter = GalleryDlPixivOAuthAdapter(
            python_executable=settings.gallery.python_executable or sys.executable,
            repo_path=settings.gallery.repo_path,
            spawn_process=lambda *command, **kwargs: asyncio.create_subprocess_exec(
                *command,
                **kwargs,
            ),
            terminate_process=lambda process, timeout: terminate_process(process, timeout),
        )
        self._pixiv_session: PixivOAuthSession | None = None
        self._browser_sessions: dict[str, ManagedBrowserLoginSession] = {}
        self._active_authorization_id = ""
        self._profile_resetting = False
        # mtime-keyed memo for _cookie_status: the scheduler calls managed_credentials_available
        # for up to 200 queued tasks every 0.5s poll, and each call parsed the cookie jar from
        # disk on the event loop. Cache by file mtime so an unchanged jar is parsed once.
        self._cookie_status_cache: dict[str, tuple[float | None, dict[str, Any]]] = {}
        self._ensure_cache()
        if settings.gallery.migrate_default_auth:
            self._migrate_default_pixiv_cache()
        for path in (
            self.metadata_file,
            *(self._cookie_path(site) for site in COOKIE_REQUIREMENTS),
        ):
            secure_private_path(path)

    @property
    def _browser_host(self) -> ManagedBrowserHost | None:
        """Compatibility facade; BrowserOrchestrator owns the actual host."""

        return self._browser_orchestrator.host

    @_browser_host.setter
    def _browser_host(self, value: ManagedBrowserHost | None) -> None:
        self._browser_orchestrator.host = value

    @staticmethod
    def _default_gallery_cache() -> Path:
        if os.name == "nt":
            base = Path(os.environ.get("APPDATA") or "~").expanduser()
        else:
            base = Path(os.environ.get("XDG_CACHE_HOME") or "~/.cache").expanduser()
        return (base / "gallery-dl" / "cache.sqlite3").resolve()

    def _ensure_cache(self, cache_file: Path | None = None) -> None:
        cache_file = Path(os.path.abspath(os.fspath(cache_file or self.cache_file)))
        try:
            private_parent = (
                self.settings.is_dedicated_credentials_directory(cache_file.parent)
                or self.settings._lexically_inside(cache_file.parent, self.managed_dir)
            )
            ensure_private_directory(
                cache_file.parent,
                repair_existing=private_parent,
            )
            secure_sqlite_files(cache_file)
            flags = os.O_CREAT | os.O_RDONLY | int(getattr(os, "O_NOFOLLOW", 0))
            os.close(os.open(cache_file, flags, 0o600))
            with closing(sqlite3.connect(cache_file)) as db:
                db.execute(
                    "CREATE TABLE IF NOT EXISTS data "
                    "(key TEXT PRIMARY KEY, value TEXT, expires INTEGER)"
                )
                db.commit()
            secure_sqlite_files(cache_file)
        except (OSError, PermissionError, ValueError) as exc:
            raise RuntimeError(f"初始化 gallery-dl 授权缓存失败: {exc}") from exc

    def _migrate_default_pixiv_cache(self) -> None:
        source = self._default_gallery_cache()
        if source == self.cache_file or not source.is_file() or self._pixiv_token_cached():
            return
        try:
            with closing(sqlite3.connect(source)) as source_db:
                rows = source_db.execute(
                    "SELECT key, value, expires FROM data "
                    "WHERE key LIKE 'gallery_dl.extractor.pixiv.%'"
                ).fetchall()
            if not rows:
                return
            with closing(sqlite3.connect(self.cache_file)) as target_db:
                target_db.executemany(
                    "INSERT OR REPLACE INTO data (key, value, expires) VALUES (?, ?, ?)",
                    rows,
                )
                target_db.commit()
        except (OSError, sqlite3.Error):
            return

    def _pixiv_token_cached(self, cache_file: Path | None = None) -> bool:
        cache_file = cache_file or self.cache_file
        now = int(time.time())
        try:
            with closing(sqlite3.connect(cache_file)) as db:
                rows = db.execute(
                    "SELECT value FROM data WHERE "
                    "key LIKE 'gallery_dl.extractor.pixiv._refresh_token_cache-%' "
                    "AND value IS NOT NULL AND (expires = 0 OR expires > ?)",
                    (now,),
                ).fetchall()
        except sqlite3.Error:
            return False
        # A cache miss for pixiv (no refresh token) is not empty: upstream's cache
        # decorator stores the func's return value, and `_refresh_token_cache` returns
        # None, so gallery-dl writes pickle.dumps(None) — a 4-byte blob with expires=0.
        # Decode each row through the Pixiv-specific restricted path and require an
        # actual non-empty string token. SQLite TEXT remains a legacy compatibility
        # format; malformed BLOBs are never retried as text.
        for (value,) in rows:
            token = _decode_pixiv_cache_token(value)
            if isinstance(token, str) and token.strip():
                return True
        return False

    @staticmethod
    def _cleanup_oauth_cache(cache_file: Path) -> None:
        for suffix in ("", "-journal", "-wal", "-shm"):
            try:
                Path(f"{cache_file}{suffix}").unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass

    def browser_profile_status(self) -> dict[str, Any]:
        return self._browser_orchestrator.profile_status(
            resetting=self._profile_resetting,
        )

    def _authorization_proxy_override(self) -> dict[str, Any] | None:
        value = self._metadata().get(AUTH_PROXY_METADATA_KEY)
        return value if isinstance(value, dict) and "url" in value else None

    def authorization_proxy(self) -> str:
        """当前生效的授权专用代理；界面保存的运行时值优先于 config.json。"""
        override = self._authorization_proxy_override()
        if override is not None:
            try:
                return normalize_authorization_proxy(override.get("url"))
            except ValueError:
                # 手改 metadata 导致的坏值不让授权流程崩掉，退回配置文件。
                override = None
        try:
            return normalize_authorization_proxy(self.settings.auth.authorization_proxy)
        except ValueError:
            return ""

    def proxy_status(self) -> dict[str, Any]:
        override = self._authorization_proxy_override()
        if override is not None:
            try:
                normalize_authorization_proxy(override.get("url"))
            except ValueError:
                override = None
        try:
            config_proxy = normalize_authorization_proxy(self.settings.auth.authorization_proxy)
        except ValueError:
            config_proxy = ""
        effective = normalize_authorization_proxy(override.get("url")) if override else config_proxy
        if override is not None:
            source = "runtime"
        elif config_proxy:
            source = "config"
        else:
            source = "none"
        host = self._browser_host
        browser_running = bool(host and host.process.returncode is None)
        effective_has_credentials = bool(
            effective
            and (urlsplit(effective).username is not None or urlsplit(effective).password is not None)
        )
        return {
            # 状态接口和 WebUI 只接收脱敏地址；完整值仅由 authorization_proxy()
            # 在进程内部交给 Chrome/gallery-dl，避免凭据进入页面、日志或 API 响应。
            "proxy_url": mask_proxy(effective) if effective else None,
            "source": source,
            "config_proxy_url": mask_proxy(config_proxy) if config_proxy else None,
            "credentials_redacted": effective_has_credentials,
            "browser_running": browser_running,
            "browser_proxy_url": (
                mask_proxy(host.proxy_url) if browser_running and host.proxy_url else None
            ),
            "restart_pending": bool(browser_running and host.proxy_url != effective),
            "updated_at": override.get("updated_at") if override else None,
        }

    async def set_authorization_proxy(self, value: str) -> dict[str, Any]:
        try:
            normalized = normalize_authorization_proxy(value)
        except ValueError as exc:
            raise AuthError("invalid_authorization_proxy", f"授权专用代理地址无效: {exc}") from exc
        async with self._lock:
            self._update_metadata(
                AUTH_PROXY_METADATA_KEY,
                {"url": normalized, "updated_at": time.time()},
            )
        return self.proxy_status()

    async def clear_authorization_proxy(self) -> dict[str, Any]:
        async with self._lock:
            self._update_metadata(AUTH_PROXY_METADATA_KEY, None)
        return self.proxy_status()

    async def _close_browser_host_instance(self, host: ManagedBrowserHost) -> None:
        """Compatibility facade for the former auth.py process helper."""

        await self._browser_orchestrator.close_host_instance(host)

    async def _stop_browser_host(self) -> None:
        """Compatibility facade; the orchestrator owns Chromium disposal."""

        await self._browser_orchestrator.stop()

    async def _ensure_browser_host(self) -> ManagedBrowserHost:
        """Compatibility facade preserving AuthError codes and auth.py patch seams."""

        try:
            return await self._browser_orchestrator.ensure_host()
        except BrowserOrchestratorError as exc:
            raise AuthError(exc.code, exc.message) from exc

    async def _close_pixiv_target(self, session: PixivOAuthSession) -> None:
        websocket_url = session.browser_websocket_url
        target_id = session.browser_target_id
        session.browser_websocket_url = ""
        session.browser_target_id = ""
        await self._browser_orchestrator.close_target(websocket_url, target_id)

    async def _release_authorization(self, session_id: str) -> None:
        async with self._lock:
            if self._active_authorization_id == session_id:
                self._active_authorization_id = ""

    async def _stop_pixiv_process(self, session: PixivOAuthSession) -> None:
        await self._pixiv_oauth_adapter.stop(session.process)
        if session.reader_task and not session.reader_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(session.reader_task), timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                session.reader_task.cancel()
                await asyncio.gather(session.reader_task, return_exceptions=True)

    async def _dispose_pixiv_session(
        self,
        session: PixivOAuthSession,
        *,
        state: str = "cancelled",
    ) -> None:
        session.state = state
        session.message = "Pixiv 登录窗口已关闭。"
        await self._browser_orchestrator.dispose_pixiv_browser(session)
        await self._stop_pixiv_process(session)
        self._cleanup_oauth_cache(session.cache_file)
        await self._release_authorization(session.id)

    def _cookie_path(self, site: str) -> Path:
        return self.managed_dir / f"{site}.cookies.txt"

    def _site_metadata(self, site: str) -> dict[str, Any]:
        value = self._metadata().get(site)
        return value if isinstance(value, dict) else {}

    def _is_invalidated(self, site: str) -> bool:
        return bool(self._site_metadata(site).get("invalidated_at"))

    def _latest_browser_session(self, site: str) -> ManagedBrowserLoginSession | None:
        sessions = [session for session in self._browser_sessions.values() if session.site == site]
        return max(sessions, key=lambda session: session.created_at) if sessions else None

    def _cookie_status(self, site: str) -> dict[str, Any]:
        path = self._cookie_path(site)
        try:
            mtime = path.stat().st_mtime if path.is_file() else None
        except OSError:
            mtime = None
        cached = self._cookie_status_cache.get(site)
        if cached is not None and cached[0] == mtime:
            return cached[1]
        result = self._compute_cookie_status(site, path)
        self._cookie_status_cache[site] = (mtime, result)
        return result

    def _compute_cookie_status(self, site: str, path: Path) -> dict[str, Any]:
        required = set(COOKIE_REQUIREMENTS.get(site, ()))
        if not path.is_file():
            return {
                "present": False,
                "valid": False,
                "cookie_count": 0,
                "required_present": [],
                "missing": sorted(required),
                "updated_at": None,
            }
        try:
            jar = MozillaCookieJar(str(path))
            jar.load(ignore_discard=True, ignore_expires=True)
            stored = list(jar)
            names = {str(cookie.name) for cookie in stored}
        except Exception:
            return {
                "present": True,
                "valid": False,
                "cookie_count": 0,
                "required_present": [],
                "missing": sorted(required),
                "updated_at": path.stat().st_mtime,
            }
        return {
            "present": True,
            "valid": required.issubset(names),
            "cookie_count": len(stored),
            "required_present": sorted(required & names),
            "missing": sorted(required - names),
            "updated_at": path.stat().st_mtime,
        }

    def _metadata(self) -> dict[str, Any]:
        try:
            value = json.loads(self.metadata_file.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def _update_metadata(self, site: str, value: dict[str, Any] | None) -> None:
        metadata = self._metadata()
        if value is None:
            metadata.pop(site, None)
        else:
            metadata[site] = value
        write_private_text(
            self.metadata_file,
            json.dumps(metadata, ensure_ascii=False, indent=2),
        )

    def _normalize_site(self, site: str) -> str:
        value = str(site).strip().lower()
        aliases = {"x": "twitter", "eh": "exhentai", "e-hentai": "exhentai"}
        value = aliases.get(value, value)
        if value not in SUPPORTED_AUTH_SITES:
            raise AuthError("unsupported_auth_site", f"不支持的授权来源: {site}")
        return value

    def status(self, site: str) -> dict[str, Any]:
        site = self._normalize_site(site)
        metadata = self._site_metadata(site)
        if site == "danbooru":
            return {
                "site": site,
                "label": "Danbooru",
                "method": "anonymous",
                "state": "ready",
                "authorized": True,
                "summary": "公开 API 已就绪，画师和角色标签抓取无需登录。",
                "actions": [],
            }

        if site == "pawchive":
            return {
                "site": site,
                "label": "Pawchive",
                "method": "anonymous",
                "state": "ready",
                "authorized": True,
                "summary": "公开 API 与文件下载已就绪，画师搜索和抓取无需登录。",
                "actions": [],
            }

        if site == "pixiv":
            token = self._pixiv_token_cached()
            session = self._pixiv_session
            session_state = session.state if session else ""
            session_active = session_state in {
                "starting",
                "starting_browser",
                "awaiting_login",
                "awaiting_code",
                "exchanging",
            }
            if session_active:
                state = "authorizing"
                summary = session.message or "Pixiv 共享授权浏览器流程正在进行。"
            elif token:
                state = "authorized"
                summary = "Pixiv 登录授权有效；gallery-dl 会自动使用托管 Token。"
            elif session and session.error:
                state = "required"
                summary = session.error
            else:
                state = "required"
                summary = "完成一次 Pixiv 登录授权后即可搜索和抓取画师作品。"
            return {
                "site": site,
                "label": "Pixiv",
                "method": "oauth",
                "state": state,
                "authorized": token,
                "summary": summary,
                "browser": "project_chrome",
                "profile": "shared",
                "updated_at": metadata.get("updated_at"),
                "oauth": session.public_dict() if session else None,
                "actions": ["oauth", "clear"],
            }

        cookie = self._cookie_status(site)
        invalidated = bool(metadata.get("invalidated_at"))
        session = self._latest_browser_session(site)
        session_active = bool(session and session.state in {"starting", "awaiting_login"})
        authorized = bool(cookie["valid"] and not invalidated)
        if session_active:
            state = "authorizing"
            summary = "共享授权浏览器已打开；请在标签页内完成登录。"
        elif authorized:
            state = "authorized"
            summary = f"{COOKIE_LABELS[site]}已保存；共享浏览器登录状态继续保留。"
        elif invalidated:
            state = "required"
            summary = "登录凭证在实际访问中失效，请重新授权。"
        else:
            state = "required"
            summary = "在共享授权浏览器中完成登录后会自动导出凭证。"
        return {
            "site": site,
            "label": MANAGED_BROWSER_SITES[site].label,
            "method": "managed_browser",
            "state": state,
            "authorized": authorized,
            "summary": summary,
            "cookies": cookie,
            "browser": "project_chrome",
            "profile": "shared",
            "updated_at": metadata.get("updated_at") or cookie.get("updated_at"),
            "invalidated_at": metadata.get("invalidated_at"),
            "invalid_reason": metadata.get("invalid_reason") if invalidated else None,
            "login": session.public_dict() if session else None,
            "actions": ["managed_browser_login", "clear"],
        }

    def statuses(self) -> dict[str, Any]:
        return {
            "items": [self.status(site) for site in SUPPORTED_AUTH_SITES],
            "browser_profile": self.browser_profile_status(),
            "authorization_proxy": self.proxy_status(),
            "managed": True,
            "secrets_exposed": False,
        }

    def credentials_for(self, site: str) -> dict[str, str | None]:
        value = str(site).strip().lower()
        site = {"x": "twitter", "eh": "exhentai", "e-hentai": "exhentai"}.get(value, value)
        if site not in SUPPORTED_AUTH_SITES:
            return {"cookies_file": None, "config_file": None, "credentials_ref": None}
        cookie_status = self._cookie_status(site) if site in COOKIE_REQUIREMENTS else None
        return {
            "cookies_file": (
                str(self._cookie_path(site))
                if cookie_status and cookie_status.get("valid") and not self._is_invalidated(site)
                else None
            ),
            "config_file": None,
            "credentials_ref": None,
        }

    async def _close_browser_target(self, session: ManagedBrowserLoginSession) -> None:
        websocket_url = session.websocket_url
        target_id = session.target_id
        session.websocket_url = ""
        session.target_id = ""
        await self._browser_orchestrator.close_target(websocket_url, target_id)

    async def _dispose_browser_session(
        self,
        session: ManagedBrowserLoginSession,
        *,
        state: str = "cancelled",
    ) -> None:
        """Compatibility facade; the orchestrator disposes the CDP session."""

        await self._browser_orchestrator.dispose_managed_session(
            session,
            state=state,
            release_authorization=self._release_authorization,
        )

    async def _persist_browser_credentials(
        self,
        session: ManagedBrowserLoginSession,
        cookies: list[dict[str, Any]],
        recommended_missing: list[str],
    ) -> bool:
        """AuthManager retains credential-vault and metadata write ownership."""

        async with self._lock:
            if session.state == "cancelled":
                return False
            self._update_metadata(
                session.site,
                {
                    "method": "managed_browser",
                    "browser": "shared_project_chrome",
                    "updated_at": time.time(),
                    "cookie_count": len(cookies),
                    "recommended_missing": recommended_missing,
                },
            )
        return True

    async def _monitor_browser_login(self, session: ManagedBrowserLoginSession) -> None:
        """Compatibility task entry; BrowserOrchestrator owns monitoring/disposal."""

        await self._browser_orchestrator.monitor_managed_session(
            session,
            spec=MANAGED_BROWSER_SITES[session.site],
            poll_seconds=self.settings.auth.browser_poll_interval_seconds,
            authorization_lock=self._authorization_lock,
            ensure_host=self._ensure_browser_host,
            cookie_path=self._cookie_path(session.site),
            persist_credentials=self._persist_browser_credentials,
            release_authorization=self._release_authorization,
        )

    async def start_browser_login(self, site: str) -> dict[str, Any]:
        site = self._normalize_site(site)
        if site not in MANAGED_BROWSER_SITES:
            raise AuthError("managed_browser_unsupported", f"{site} 使用其他登录授权方式")
        async with self._lock:
            if self._active_authorization_id or self._profile_resetting:
                raise AuthError(
                    "shared_browser_busy",
                    "共享授权浏览器正在执行其他授权或清空操作，请稍候。",
                )
            self._browser_sessions = {
                session_id: session
                for session_id, session in self._browser_sessions.items()
                if session.site != site
            }
            created_at = time.time()
            session = ManagedBrowserLoginSession(
                id=uuid.uuid4().hex,
                site=site,
                created_at=created_at,
                expires_at=created_at + self.settings.auth.browser_login_timeout_seconds,
            )
            self._active_authorization_id = session.id
            self._browser_sessions[session.id] = session
            session.monitor_task = asyncio.create_task(
                self._monitor_browser_login(session),
                name=f"managed-browser-{site}-{session.id}",
            )
        return {"session": session.public_dict(), "status": self.status(site)}

    def browser_login_session(self, site: str, session_id: str) -> dict[str, Any]:
        site = self._normalize_site(site)
        session = self._browser_sessions.get(str(session_id))
        if session is None or session.site != site:
            raise AuthError("browser_login_session_not_found", "项目专属浏览器登录会话不存在")
        return {"session": session.public_dict(), "status": self.status(site)}

    async def cancel_browser_login(self, site: str, session_id: str) -> dict[str, Any]:
        site = self._normalize_site(site)
        async with self._lock:
            session = self._browser_sessions.get(str(session_id))
            if session is None or session.site != site:
                raise AuthError("browser_login_session_not_found", "项目专属浏览器登录会话不存在")
        await self._dispose_browser_session(session)
        return {"session": session.public_dict(), "status": self.status(site)}

    def managed_credentials_available(self, site: str, cookies_file: str | None) -> bool:
        value = {"x": "twitter", "eh": "exhentai", "e-hentai": "exhentai"}.get(
            str(site).strip().lower(),
            str(site).strip().lower(),
        )
        if value not in MANAGED_BROWSER_SITES or not cookies_file:
            return True
        try:
            supplied = Path(cookies_file).resolve()
        except OSError:
            return True
        if supplied != self._cookie_path(value).resolve():
            return True
        return self._cookie_status(value).get("valid", False) and not self._is_invalidated(value)

    async def invalidate_if_managed(
        self,
        site: str,
        cookies_file: str | None,
        message: str,
    ) -> bool:
        value = {"x": "twitter", "eh": "exhentai", "e-hentai": "exhentai"}.get(
            str(site).strip().lower(),
            str(site).strip().lower(),
        )
        if value not in MANAGED_BROWSER_SITES or not cookies_file:
            return False
        try:
            supplied = Path(cookies_file).resolve()
        except OSError:
            return False
        if supplied != self._cookie_path(value).resolve():
            return False
        lower = str(message or "").lower()
        noncredential_markers = (
            "tweets are protected",
            "has blocked your account",
            "blocked your account",
            "insufficient privileges to access this endpoint",
            "temporarily banned",
            "gallery not available",
        )
        if any(marker in lower for marker in noncredential_markers):
            return False
        async with self._lock:
            metadata = self._site_metadata(value)
            # Worker output is an untrusted third-party boundary. Keep only the
            # invalidation fact; never persist or return its raw URL/token text.
            metadata.update(
                {
                    "method": "managed_browser",
                    "browser": "project_chrome",
                    "invalidated_at": time.time(),
                    "invalid_reason": "登录凭证失效",
                }
            )
            self._update_metadata(value, metadata)
        return True

    async def _read_pixiv_oauth(self, session: PixivOAuthSession) -> None:
        pending = ""
        async for chunk in self._pixiv_oauth_adapter.output_chunks(session.process):
            text = chunk.decode("utf-8", "replace")
            if not session.authorization_url:
                pending = (pending + text)[-16384:]
                authorization_url = find_pixiv_login_url(pending)
                if authorization_url:
                    session.authorization_url = authorization_url
                    session.state = "awaiting_code"
                    session.message = "正在打开共享授权浏览器。"
                    session.ready.set()
                    pending = ""
            lower = text.lower()
            if "expired, try again" in lower or "invalid_grant" in lower:
                session.error = "授权码已过期，请重新开始 Pixiv 授权。"
        returncode = await self._pixiv_oauth_adapter.wait(session.process)
        if session.state in {"cancelled", "failed", "timed_out"}:
            pass
        elif returncode == 0 and self._pixiv_token_cached(session.cache_file):
            session.state = "token_ready"
            session.message = "Pixiv 授权码交换完成，正在保存登录状态。"
            session.error = ""
        else:
            session.state = "failed"
            session.error = session.error or "Pixiv 授权没有写入登录状态。"
            session.message = session.error
        session.ready.set()

    async def _start_pixiv_browser(self, session: PixivOAuthSession) -> None:
        session.state = "starting_browser"
        session.message = "正在共享授权浏览器中打开 Pixiv。"
        session.browser_task = asyncio.create_task(
            self._monitor_pixiv_browser(session),
            name=f"pixiv-browser-{session.id}",
        )

    async def _monitor_pixiv_browser(self, session: PixivOAuthSession) -> None:
        """Compatibility task entry; BrowserOrchestrator owns CDP monitoring."""

        await self._browser_orchestrator.monitor_pixiv_session(
            session,
            login_timeout_seconds=self.settings.auth.browser_login_timeout_seconds,
            authorization_lock=self._authorization_lock,
            ensure_host=self._ensure_browser_host,
            is_current=lambda current: self._pixiv_session is current,
            complete_oauth=self._complete_pixiv_oauth,
            stop_oauth_process=self._stop_pixiv_process,
            cleanup_oauth_cache=self._cleanup_oauth_cache,
            controlled_error_message=lambda exc: (
                exc.message if isinstance(exc, AuthError) else None
            ),
            release_authorization=self._release_authorization,
        )

    async def start_pixiv_oauth(self) -> dict[str, Any]:
        session_id = uuid.uuid4().hex
        async with self._lock:
            if self._active_authorization_id or self._profile_resetting:
                raise AuthError(
                    "shared_browser_busy",
                    "共享授权浏览器正在执行其他授权或清空操作，请稍候。",
                )
            old = self._pixiv_session
            self._pixiv_session = None
            self._active_authorization_id = session_id
        if old is not None:
            await self._dispose_pixiv_session(old)

        session_cache = self.managed_dir / f".pixiv-oauth-{session_id}.sqlite3"
        self._cleanup_oauth_cache(session_cache)
        try:
            self._ensure_cache(session_cache)
        except (OSError, RuntimeError, sqlite3.Error) as exc:
            self._cleanup_oauth_cache(session_cache)
            await self._release_authorization(session_id)
            raise AuthError("pixiv_oauth_start_failed", "启动 Pixiv 登录授权失败") from exc
        try:
            process = await self._pixiv_oauth_adapter.start(
                session_cache,
                proxy_url=self.authorization_proxy(),
            )
        except Exception as exc:
            self._cleanup_oauth_cache(session_cache)
            await self._release_authorization(session_id)
            raise AuthError("pixiv_oauth_start_failed", "启动 Pixiv 登录授权失败") from exc
        session = PixivOAuthSession(
            id=session_id,
            process=process,
            created_at=time.time(),
            cache_file=session_cache,
        )
        session.reader_task = asyncio.create_task(
            self._read_pixiv_oauth(session),
            name=f"pixiv-oauth-{session.id}",
        )
        async with self._lock:
            self._pixiv_session = session
        try:
            await asyncio.wait_for(session.ready.wait(), timeout=15)
        except asyncio.TimeoutError as exc:
            await self._dispose_pixiv_session(session, state="failed")
            session.error = "Pixiv 授权页面生成超时。"
            async with self._lock:
                if self._pixiv_session is session:
                    self._pixiv_session = None
            raise AuthError("pixiv_oauth_start_timeout", session.error) from exc
        if not session.authorization_url:
            await self._dispose_pixiv_session(session, state="failed")
            async with self._lock:
                if self._pixiv_session is session:
                    self._pixiv_session = None
            raise AuthError("pixiv_oauth_start_failed", session.error or "Pixiv 授权进程提前结束")
        try:
            await self._start_pixiv_browser(session)
        except AuthError as exc:
            await self._dispose_pixiv_session(session, state="failed")
            session.error = exc.message
            session.message = session.error
            async with self._lock:
                if self._pixiv_session is session:
                    self._pixiv_session = None
            raise
        return session.public_dict()

    @staticmethod
    def _extract_oauth_code(value: str) -> str:
        """Compatibility seam for callers that exercised the former private parser."""

        return extract_pixiv_oauth_code(value)

    async def _complete_pixiv_oauth(
        self,
        session: PixivOAuthSession,
        value: str,
    ) -> dict[str, Any]:
        code = self._extract_oauth_code(value)
        if not code or len(code) > 8192 or any(ord(char) < 32 for char in code):
            raise AuthError("invalid_pixiv_oauth_code", "Pixiv 授权回调内容格式无效")

        async with self._lock:
            if self._pixiv_session is not session:
                raise AuthError("pixiv_oauth_session_not_found", "Pixiv 授权会话已失效，请重新开始")
            if time.time() - session.created_at > 600:
                session.error = "Pixiv 授权会话已过期，请重新开始"
                session.message = session.error
                raise AuthError("pixiv_oauth_session_expired", "Pixiv 授权会话已过期，请重新开始")
            if session.completion_claimed:
                raise AuthError("pixiv_oauth_exchange_active", "Pixiv 授权正在确认，请稍候")
            if session.process.returncode is not None:
                session.error = session.error or "Pixiv 授权进程已经结束"
                session.message = session.error
                raise AuthError("pixiv_oauth_process_ended", session.error or "Pixiv 授权进程已经结束")
            if session.process.stdin is None:
                session.error = "Pixiv 授权输入通道已经关闭"
                session.message = session.error
                raise AuthError("pixiv_oauth_process_ended", "Pixiv 授权输入通道已经关闭")
            session.completion_claimed = True
            session.state = "exchanging"
            session.message = "已捕获 Pixiv 回调，正在交换授权码。"

        try:
            await self._pixiv_oauth_adapter.submit_code(session.process, code)
        except (BrokenPipeError, ConnectionError, OSError) as exc:
            session.error = "Pixiv 授权输入通道已经关闭"
            session.message = session.error
            raise AuthError("pixiv_oauth_process_ended", session.error) from exc

        try:
            await self._pixiv_oauth_adapter.wait(session.process, timeout=60)
            if session.reader_task:
                await asyncio.wait_for(asyncio.shield(session.reader_task), timeout=5)
        except asyncio.TimeoutError as exc:
            session.error = "Pixiv 授权确认超时"
            session.message = session.error
            raise AuthError("pixiv_oauth_exchange_timeout", "Pixiv 授权确认超时") from exc

        if session.process.returncode != 0 or not self._pixiv_token_cached(session.cache_file):
            async with self._lock:
                session.state = "failed"
                session.error = session.error or "Pixiv 授权确认失败"
                session.message = session.error
            self._cleanup_oauth_cache(session.cache_file)
            raise AuthError("pixiv_oauth_exchange_failed", session.error or "Pixiv 授权确认失败")

        async with self._lock:
            if self._pixiv_session is not session:
                self._cleanup_oauth_cache(session.cache_file)
                raise AuthError("pixiv_oauth_session_not_found", "Pixiv 授权会话已失效，请重新开始")
            try:
                with closing(sqlite3.connect(session.cache_file)) as source_db:
                    rows = source_db.execute(
                        "SELECT key, value, expires FROM data "
                        "WHERE key LIKE 'gallery_dl.extractor.pixiv.%'"
                    ).fetchall()
                if not rows:
                    raise sqlite3.DatabaseError("Pixiv token row missing")
                with closing(sqlite3.connect(self.cache_file)) as target_db:
                    target_db.execute(
                        "DELETE FROM data WHERE key LIKE 'gallery_dl.extractor.pixiv.%'"
                    )
                    target_db.executemany(
                        "INSERT OR REPLACE INTO data (key, value, expires) VALUES (?, ?, ?)",
                        rows,
                    )
                    target_db.commit()
                secure_private_path(self.cache_file)
            except sqlite3.Error as exc:
                session.state = "failed"
                session.error = "保存 Pixiv 登录授权失败"
                session.message = session.error
                self._cleanup_oauth_cache(session.cache_file)
                raise AuthError("pixiv_oauth_cache_failed", "保存 Pixiv 登录授权失败") from exc
            self._update_metadata("pixiv", {"method": "oauth", "updated_at": time.time()})
            session.state = "authorized"
            session.message = "Pixiv 登录授权完成。"
            self._pixiv_session = None
        self._cleanup_oauth_cache(session.cache_file)
        return self.status("pixiv")

    async def clear(self, site: str) -> dict[str, Any]:
        site = self._normalize_site(site)
        browser_sessions: list[ManagedBrowserLoginSession] = []
        pixiv_session: PixivOAuthSession | None = None
        async with self._lock:
            if site in MANAGED_BROWSER_SITES:
                browser_sessions = [
                    session for session in self._browser_sessions.values() if session.site == site
                ]
                self._browser_sessions = {
                    session_id: session
                    for session_id, session in self._browser_sessions.items()
                    if session.site != site
                }
            elif site == "pixiv":
                pixiv_session = self._pixiv_session
                self._pixiv_session = None

        for session in browser_sessions:
            await self._dispose_browser_session(session)
        if pixiv_session is not None:
            await self._dispose_pixiv_session(pixiv_session)

        if site in MANAGED_BROWSER_SITES:
            path = self._cookie_path(site)
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        async with self._lock:
            self._update_metadata(site, None)
        if site == "pixiv":
            try:
                with closing(sqlite3.connect(self.cache_file)) as db:
                    db.execute(
                        "DELETE FROM data WHERE key LIKE "
                        "'gallery_dl.extractor.pixiv.%'"
                    )
                    db.commit()
                secure_private_path(self.cache_file)
            except sqlite3.Error as exc:
                raise AuthError("auth_cache_clear_failed", "清除 Pixiv 授权缓存失败") from exc
        return self.status(site)

    async def cancel_pixiv_oauth(self) -> dict[str, Any]:
        async with self._lock:
            session = self._pixiv_session
            self._pixiv_session = None
        if session:
            await self._dispose_pixiv_session(session)
        return self.status("pixiv")

    async def clear_browser_profile(self) -> dict[str, Any]:
        async with self._lock:
            if self._profile_resetting:
                raise AuthError("browser_profile_reset_active", "共享授权浏览器正在清空。")
            self._profile_resetting = True
            browser_sessions = list(self._browser_sessions.values())
            self._browser_sessions.clear()
            pixiv_session = self._pixiv_session
            self._pixiv_session = None
        try:
            for browser_session in browser_sessions:
                await self._dispose_browser_session(browser_session)
            if pixiv_session is not None:
                await self._dispose_pixiv_session(pixiv_session)
            async with self._authorization_lock:
                await self._stop_browser_host()
                profile_dir = Path(os.path.abspath(os.fspath(self.browser_profile_dir)))
                expected = Path(os.path.abspath(os.fspath(self.browser_profiles_dir / "shared")))
                if profile_dir != expected or profile_dir.parent != self.browser_profiles_dir:
                    raise AuthError("invalid_browser_profile_path", "共享授权浏览器目录校验失败")
                try:
                    reject_symlink_path(profile_dir)
                    if profile_dir.exists():
                        await asyncio.to_thread(shutil.rmtree, profile_dir)
                except (OSError, PermissionError, ValueError) as exc:
                    raise AuthError(
                        "invalid_browser_profile_path",
                        "共享授权浏览器目录安全校验失败",
                    ) from exc
        finally:
            async with self._lock:
                self._active_authorization_id = ""
                self._profile_resetting = False
        return {
            "browser_profile": self.browser_profile_status(),
            "auth": self.statuses(),
        }

    async def stop(self) -> None:
        async with self._lock:
            sessions = list(self._browser_sessions.values())
            self._browser_sessions.clear()
            session = self._pixiv_session
            self._pixiv_session = None
            self._active_authorization_id = ""
        for browser_session in sessions:
            await self._dispose_browser_session(browser_session)
        if session:
            await self._dispose_pixiv_session(session)
        await self._stop_browser_host()
