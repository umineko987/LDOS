from __future__ import annotations

import asyncio
import os
import subprocess
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .auth_projection import chrome_proxy_server
from .file_security import ensure_private_directory


class AsyncProcess(Protocol):
    returncode: int | None
    stdin: Any
    stdout: Any

    async def wait(self) -> int: ...


@dataclass(slots=True)
class BrowserHost:
    process: AsyncProcess
    profile_dir: Path
    debug_port: int
    websocket_url: str
    proxy_url: str = field(default="", repr=False)


@dataclass(frozen=True, slots=True)
class BrowserRuntimeAdapter:
    """Explicit boundary around Chromium process, CDP and cookie file I/O."""

    discover_chrome: Callable[[str], Path]
    allocate_debug_port: Callable[[], int]
    spawn_process: Callable[..., Awaitable[AsyncProcess]]
    read_browser_websocket: Callable[[int], tuple[int, str] | None]
    open_login_target: Callable[[str, str], str]
    capture_pixiv_callback: Callable[..., str]
    get_site_cookies: Callable[[str, Any], list[dict[str, Any]]]
    managed_login_ready: Callable[[str, Any, str], bool]
    close_target: Callable[[str, str], None]
    close_browser: Callable[[str], None]
    write_netscape_cookies: Callable[[Path, list[dict[str, Any]]], None]
    terminate_process: Callable[[AsyncProcess, float], Awaitable[None]]


class BrowserOrchestratorError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class BrowserOrchestrator:
    """Own one Chromium host and all CDP target/cookie external operations."""

    def __init__(
        self,
        *,
        profile_dir: Path,
        chrome_executable: str,
        login_timeout_seconds: float,
        proxy_provider: Callable[[], str],
        runtime: BrowserRuntimeAdapter,
    ) -> None:
        self.profile_dir = Path(profile_dir)
        self.chrome_executable = str(chrome_executable or "")
        self.login_timeout_seconds = float(login_timeout_seconds)
        self._proxy_provider = proxy_provider
        self._runtime = runtime
        self._host_lock = asyncio.Lock()
        self._host: BrowserHost | None = None

    @property
    def host(self) -> BrowserHost | None:
        return self._host

    @host.setter
    def host(self, value: BrowserHost | None) -> None:
        # A narrow migration seam for AuthManager's historical private attribute.
        self._host = value

    @property
    def host_lock(self) -> asyncio.Lock:
        return self._host_lock

    def profile_status(self, *, resetting: bool) -> dict[str, Any]:
        host = self._host
        return {
            "shared": True,
            "present": self.profile_dir.is_dir(),
            "running": bool(host and host.process.returncode is None),
            "resetting": bool(resetting),
            "sites": ["twitter", "pixiv", "exhentai"],
        }

    async def close_host_instance(self, host: BrowserHost) -> None:
        if host.websocket_url:
            await asyncio.to_thread(self._runtime.close_browser, host.websocket_url)
        if host.process.returncode is None:
            try:
                await asyncio.wait_for(host.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                await self._runtime.terminate_process(host.process, 2)

    async def stop(self) -> None:
        async with self._host_lock:
            host = self._host
            self._host = None
        if host is not None:
            await self.close_host_instance(host)

    async def ensure_host(self) -> BrowserHost:
        async with self._host_lock:
            proxy_url = self._proxy_provider()
            host = self._host
            # Chrome's proxy can only be selected at process startup.
            if (
                host is not None
                and host.process.returncode is None
                and host.proxy_url == proxy_url
            ):
                endpoint = await asyncio.to_thread(
                    self._runtime.read_browser_websocket,
                    host.debug_port,
                )
                if endpoint:
                    host.websocket_url = endpoint[1]
                    return host
            if host is not None:
                self._host = None
                await self.close_host_instance(host)

            try:
                chrome = await asyncio.to_thread(
                    self._runtime.discover_chrome,
                    self.chrome_executable,
                )
            except FileNotFoundError as exc:
                raise BrowserOrchestratorError(
                    "chrome_not_found",
                    "没有找到 Chrome 或 Chromium，请配置 auth.chrome_executable",
                ) from exc

            ensure_private_directory(self.profile_dir)
            try:
                (self.profile_dir / "DevToolsActivePort").unlink()
            except FileNotFoundError:
                pass
            except OSError as exc:
                raise BrowserOrchestratorError(
                    "browser_profile_busy",
                    "共享授权浏览器配置正在使用中",
                ) from exc

            debug_port = self._runtime.allocate_debug_port()
            command = [
                str(chrome),
                f"--user-data-dir={self.profile_dir}",
                "--profile-directory=Default",
                f"--remote-debugging-port={debug_port}",
                "--remote-debugging-address=127.0.0.1",
                "--start-maximized",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-default-apps",
            ]
            if proxy_url:
                command.append(f"--proxy-server={chrome_proxy_server(proxy_url)}")
            command.append("about:blank")
            kwargs: dict[str, Any] = {
                "stdout": asyncio.subprocess.DEVNULL,
                "stderr": asyncio.subprocess.DEVNULL,
            }
            if os.name == "nt":
                kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                kwargs["start_new_session"] = True
            try:
                process = await self._runtime.spawn_process(*command, **kwargs)
            except (OSError, RuntimeError) as exc:
                raise BrowserOrchestratorError(
                    "browser_login_start_failed",
                    "共享授权浏览器启动失败",
                ) from exc

            deadline = time.time() + min(
                15.0,
                self.login_timeout_seconds,
            )
            websocket_url = ""
            while time.time() < deadline:
                if process.returncode is not None:
                    break
                endpoint = await asyncio.to_thread(
                    self._runtime.read_browser_websocket,
                    debug_port,
                )
                if endpoint:
                    websocket_url = endpoint[1]
                    break
                await asyncio.sleep(0.1)
            if not websocket_url:
                if process.returncode is None:
                    await self._runtime.terminate_process(process, 2)
                raise BrowserOrchestratorError(
                    "browser_login_start_failed",
                    "共享授权浏览器启动超时",
                )

            host = BrowserHost(
                process=process,
                profile_dir=self.profile_dir,
                debug_port=debug_port,
                websocket_url=websocket_url,
                proxy_url=proxy_url,
            )
            self._host = host
            return host

    async def open_target(self, websocket_url: str, login_url: str) -> str:
        return await asyncio.to_thread(
            self._runtime.open_login_target,
            websocket_url,
            login_url,
        )

    async def close_target(self, websocket_url: str, target_id: str) -> None:
        if websocket_url and target_id:
            await asyncio.to_thread(self._runtime.close_target, websocket_url, target_id)

    async def site_cookies(self, websocket_url: str, spec: Any) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._runtime.get_site_cookies, websocket_url, spec)

    async def login_ready(self, websocket_url: str, spec: Any, target_id: str) -> bool:
        return bool(
            await asyncio.to_thread(
                self._runtime.managed_login_ready,
                websocket_url,
                spec,
                target_id,
            )
        )

    async def write_cookies(self, path: Path, cookies: list[dict[str, Any]]) -> None:
        await asyncio.to_thread(self._runtime.write_netscape_cookies, path, cookies)

    async def capture_pixiv_callback(
        self,
        websocket_url: str,
        target_id: str,
        authorization_url: str,
        *,
        timeout: float,
    ) -> str:
        return await asyncio.to_thread(
            self._runtime.capture_pixiv_callback,
            websocket_url,
            target_id,
            authorization_url,
            timeout=timeout,
        )


class GalleryDlPixivOAuthAdapter:
    """Own gallery-dl OAuth argv/environment, pipes and process termination."""

    def __init__(
        self,
        *,
        python_executable: str,
        repo_path: Path,
        spawn_process: Callable[..., Awaitable[AsyncProcess]],
        terminate_process: Callable[[AsyncProcess, float], Awaitable[None]],
    ) -> None:
        self.python_executable = str(python_executable)
        self.repo_path = Path(repo_path)
        self._spawn_process = spawn_process
        self._terminate_process = terminate_process

    async def start(self, cache_file: Path, *, proxy_url: str) -> AsyncProcess:
        command = [
            self.python_executable,
            "-m",
            "gallery_dl",
            "--config-ignore",
            "--cache-file",
            str(cache_file),
            "-o",
            "extractor.oauth.browser=false",
            "-o",
            "extractor.oauth.input=true",
        ]
        if proxy_url:
            command += ["-o", f"proxy={proxy_url}"]
        command.append("oauth:pixiv")
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        pythonpath = [str(self.repo_path)]
        if env.get("PYTHONPATH"):
            pythonpath.append(env["PYTHONPATH"])
        env["PYTHONPATH"] = os.pathsep.join(pythonpath)
        kwargs: dict[str, Any] = {
            "cwd": str(self.repo_path),
            "env": env,
            "stdin": asyncio.subprocess.PIPE,
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.STDOUT,
        }
        if os.name == "nt":
            kwargs["creationflags"] = (
                subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
            )
        else:
            kwargs["start_new_session"] = True
        return await self._spawn_process(*command, **kwargs)

    async def output_chunks(
        self,
        process: AsyncProcess,
        *,
        size: int = 2048,
    ) -> AsyncIterator[bytes]:
        stream = process.stdout
        if stream is None:
            return
        while True:
            chunk = await stream.read(size)
            if not chunk:
                return
            yield bytes(chunk)

    async def submit_code(self, process: AsyncProcess, code: str) -> None:
        stdin = process.stdin
        if stdin is None:
            raise BrokenPipeError("Pixiv OAuth stdin is closed")
        stdin.write((code + "\n").encode("utf-8"))
        await stdin.drain()
        stdin.close()

    @staticmethod
    async def wait(process: AsyncProcess, *, timeout: float | None = None) -> int:
        if timeout is None:
            return int(await process.wait())
        return int(await asyncio.wait_for(process.wait(), timeout=timeout))

    async def stop(self, process: AsyncProcess) -> None:
        if process.returncode is None:
            await self._terminate_process(process, 2)
