from __future__ import annotations

import asyncio
import os
import urllib.parse
from pathlib import Path
from typing import Any, Awaitable, Callable

from .config import AppSettings
from .runtime_config import RuntimeConfigStore
from .review_filters import filter_capabilities

SSCD_BYTES = 98_791_638
DINO_BYTES = 88_283_115
EXPECTED_DOWNLOAD_BYTES = SSCD_BYTES + DINO_BYTES


def normalize_download_proxy(value: str | None) -> str | None:
    candidate = (value or "").strip()
    if not candidate:
        return None
    if len(candidate) > 300 or any(
        ord(character) <= 32 or ord(character) == 127 for character in candidate
    ):
        raise ValueError("代理地址格式无效")
    try:
        parsed = urllib.parse.urlsplit(candidate)
        port = parsed.port
    except ValueError as error:
        raise ValueError("代理地址格式无效") from error
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or port is None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("代理地址需为带端口的 HTTP 或 HTTPS 地址")
    return urllib.parse.urlunsplit((parsed.scheme.lower(), parsed.netloc, "", "", ""))


class ModelSetupManager:
    def __init__(
        self,
        settings: AppSettings,
        runtime_config: RuntimeConfigStore,
        on_enabled: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._settings = settings
        self._on_enabled = on_enabled
        self._runtime_config = runtime_config
        self._lock = asyncio.Lock()
        self._task: asyncio.Task[None] | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._phase = "idle"
        self._message = ""
        self._using_proxy = False

    def _paths(self) -> tuple[Path, Path, Path]:
        root = self._settings.dedup.model_dir
        return (
            root / "sscd_disc_mixup.torchscript.pt",
            root / "torch" / "hub" / "checkpoints" / "dinov2_vits14_pretrain.pth",
            root
            / "torch"
            / "hub"
            / "facebookresearch_dinov2_7764ea0f912e53c92e82eb78a2a1631e92725fc8"
            / "hubconf.py",
        )

    @staticmethod
    def _file_size(path: Path) -> int:
        try:
            return path.stat().st_size if path.is_file() else 0
        except OSError:
            return 0

    def _source_python_fallback(self) -> Path | None:
        relative = Path("Scripts/python.exe") if os.name == "nt" else Path("bin/python")
        candidate = self._settings.dedup.core_script.parent / ".venv" / relative
        try:
            available = candidate.is_file() and (
                os.name == "nt" or os.access(candidate, os.X_OK)
            )
        except OSError:
            available = False
        return candidate if available else None

    def _downloaded_bytes(self) -> int:
        sscd, dino, _repository = self._paths()
        sscd_bytes = max(
            self._file_size(sscd),
            self._file_size(sscd.with_suffix(sscd.suffix + ".part")),
        )
        dino_bytes = self._file_size(dino)
        checkpoint_dir = dino.parent
        if checkpoint_dir.is_dir() and not dino_bytes:
            try:
                dino_bytes = max(
                    (self._file_size(path) for path in checkpoint_dir.glob("*dinov2_vits14*")),
                    default=0,
                )
            except OSError:
                dino_bytes = 0
        return min(SSCD_BYTES, sscd_bytes) + min(DINO_BYTES, dino_bytes)

    def status(self) -> dict[str, Any]:
        sscd, dino, repository = self._paths()
        sscd_installed = self._file_size(sscd) > 0
        dino_installed = self._file_size(dino) > 0 and repository.is_file()
        installed = sscd_installed and dino_installed
        phase = self._phase
        if phase == "idle" and installed and self._settings.dedup.enabled:
            phase = "ready"
        downloaded = EXPECTED_DOWNLOAD_BYTES if installed else self._downloaded_bytes()
        return {
            "phase": phase,
            "enabled": self._settings.dedup.enabled,
            "installed": installed,
            "using_proxy": self._using_proxy if phase == "installing" else False,
            "downloaded_bytes": downloaded,
            "expected_bytes": EXPECTED_DOWNLOAD_BYTES,
            "message": self._message,
            "review_filters": filter_capabilities(),
            "models": {
                "sscd": {"installed": sscd_installed},
                "dino": {"installed": dino_installed},
            },
        }

    async def install(self, proxy: str | None = None) -> dict[str, Any]:
        normalized_proxy = normalize_download_proxy(proxy)
        async with self._lock:
            if self._task is not None and not self._task.done():
                return self.status()
            self._phase = "installing"
            self._message = "正在准备模型"
            self._using_proxy = normalized_proxy is not None
            self._task = asyncio.create_task(self._run_install(normalized_proxy))
        return self.status()

    async def _run_install(self, proxy: str | None) -> None:
        environment = os.environ.copy()
        if proxy:
            environment.update(
                {
                    "HTTP_PROXY": proxy,
                    "HTTPS_PROXY": proxy,
                    "http_proxy": proxy,
                    "https_proxy": proxy,
                }
            )
        command = [
            str(self._settings.dedup.python_executable),
            str(self._settings.dedup.core_script),
            "--prepare-models",
            "--model-dir",
            str(self._settings.dedup.model_dir),
            "--device",
            self._settings.dedup.device,
        ]
        repaired_python: Path | None = None
        try:
            try:
                self._process = await asyncio.create_subprocess_exec(
                    *command,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    env=environment,
                )
            except FileNotFoundError:
                fallback = self._source_python_fallback()
                if fallback is None:
                    raise
                configured = os.path.normcase(
                    os.fspath(self._settings.dedup.python_executable)
                )
                if os.path.normcase(os.fspath(fallback)) == configured:
                    raise
                command[0] = str(fallback)
                self._process = await asyncio.create_subprocess_exec(
                    *command,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    env=environment,
                )
                self._settings.dedup.python_executable = fallback
                repaired_python = fallback
            waiting = asyncio.create_task(self._process.wait())
            while not waiting.done():
                downloaded = self._downloaded_bytes()
                self._message = (
                    "正在下载并检查模型"
                    if downloaded < EXPECTED_DOWNLOAD_BYTES
                    else "正在加载模型"
                )
                await asyncio.wait({waiting}, timeout=0.5)
            returncode = await waiting
            if returncode:
                raise RuntimeError("模型准备进程失败")
            sscd, dino, repository = self._paths()
            if not (
                self._file_size(sscd) > 0
                and self._file_size(dino) > 0
                and repository.is_file()
            ):
                raise RuntimeError("模型准备完成，但模型文件不完整")
            updates: dict[str, Any] = {"enabled": True}
            if repaired_python is not None:
                updates["python_executable"] = str(repaired_python)
            await self._runtime_config.update_section("dedup", updates)
            self._settings.dedup.enabled = True
            if self._on_enabled is not None:
                await self._on_enabled()
            self._phase = "ready"
            self._message = "模型已安装并启用"
        except asyncio.CancelledError:
            if self._process is not None and self._process.returncode is None:
                self._process.kill()
                await self._process.wait()
            raise
        except FileNotFoundError:
            self._phase = "failed"
            self._message = "模型组件缺失，请重新安装 LDOS"
        except PermissionError:
            self._phase = "failed"
            self._message = (
                "模型已下载，但无法保存启用设置"
                if self.status()["installed"]
                else "无法写入模型目录，请检查目录权限"
            )
        except Exception:
            self._phase = "failed"
            self._message = (
                "模型已下载，但启用设置保存失败，请重试"
                if self.status()["installed"]
                else "模型下载或检查失败，请确认网络或本次代理后重试"
            )
        finally:
            self._process = None
            self._using_proxy = False

    async def close(self) -> None:
        task = self._task
        if task is None or task.done():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
