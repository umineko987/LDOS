from __future__ import annotations

import asyncio
import os
import urllib.parse
from pathlib import Path
from typing import Any, Awaitable, Callable

from .config import AppSettings
from .runtime_config import RuntimeConfigStore
from .review_filters import filter_capabilities

from .review_filter_models import MODEL_FILES, model_paths
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
        self._selected_models = ["dedup"]

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

    def _filter_downloaded_bytes(self, name: str) -> int:
        return sum(min(entry[1], max(self._file_size(path), self._file_size(path.with_suffix(path.suffix + ".part"))))
                   for path, entry in zip(model_paths(self._settings.dedup.model_dir, name), MODEL_FILES[name]))

    def _progress(self) -> tuple[int, int]:
        downloaded = self._downloaded_bytes() if "dedup" in self._selected_models else 0
        expected = EXPECTED_DOWNLOAD_BYTES if "dedup" in self._selected_models else 0
        if "dedup" in self._selected_models:
            sscd, dino, repository = self._paths()
            if self._file_size(sscd) > 0 and self._file_size(dino) > 0 and repository.is_file():
                downloaded = EXPECTED_DOWNLOAD_BYTES
        for name in self._selected_models:
            if name in MODEL_FILES:
                downloaded += self._filter_downloaded_bytes(name)
                expected += sum(entry[1] for entry in MODEL_FILES[name])
        return downloaded, expected

    def status(self) -> dict[str, Any]:
        sscd, dino, repository = self._paths()
        sscd_installed = self._file_size(sscd) > 0
        dino_installed = self._file_size(dino) > 0 and repository.is_file()
        installed = sscd_installed and dino_installed
        phase = self._phase
        if phase == "idle" and installed and self._settings.dedup.enabled:
            phase = "ready"
        downloaded, expected = self._progress()
        capabilities = filter_capabilities(self._settings.dedup.model_dir, self._settings.dedup.python_executable)
        return {
            "phase": phase,
            "enabled": self._settings.dedup.enabled,
            "installed": installed,
            "using_proxy": self._using_proxy if phase == "installing" else False,
            "downloaded_bytes": downloaded,
            "expected_bytes": expected,
            "message": self._message,
            "requested_models": list(self._selected_models),
            "review_filters": capabilities,
            "models": {
                "sscd": {"installed": sscd_installed},
                "dino": {"installed": dino_installed},
                **{name: {
                    "installed": capabilities[option]["available"],
                    "downloaded_bytes": self._filter_downloaded_bytes(name),
                    "expected_bytes": sum(entry[1] for entry in MODEL_FILES[name]),
                } for option, name in (("filter_monochrome", "monochrome"), ("filter_character", "ccip"))},
            },
        }

    async def install(self, proxy: str | None = None, models: list[str] | None = None) -> dict[str, Any]:
        normalized_proxy = normalize_download_proxy(proxy)
        selected = list(dict.fromkeys(models if models is not None else ["dedup"]))
        if not selected or any(name not in {"dedup", *MODEL_FILES} for name in selected):
            raise ValueError("模型选择无效")
        async with self._lock:
            if self._task is not None and not self._task.done():
                return await asyncio.to_thread(self.status)
            self._selected_models = selected
            self._phase = "installing"
            self._message = "正在准备模型"
            self._using_proxy = normalized_proxy is not None
            self._task = asyncio.create_task(self._run_install(normalized_proxy))
        return await asyncio.to_thread(self.status)

    async def _run_install(self, proxy: str | None) -> None:
        environment = os.environ.copy()
        if proxy:
            environment.update({"HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "http_proxy": proxy, "https_proxy": proxy})
        commands = []
        if "dedup" in self._selected_models:
            commands.append([
                str(self._settings.dedup.core_script), "--prepare-models",
                "--model-dir", str(self._settings.dedup.model_dir), "--device", self._settings.dedup.device,
            ])
        filters = [name for name in self._selected_models if name in MODEL_FILES]
        if filters:
            commands.append([
                str(Path(__file__).with_name("review_filter_models.py")), "--prepare",
                "--dedup-dir", str(self._settings.dedup.core_script.parent),
                "--model-dir", str(self._settings.dedup.model_dir), "--models", *filters,
            ])
        repaired_python: Path | None = None
        saving_settings = False
        try:
            for arguments in commands:
                command = [str(self._settings.dedup.python_executable), *arguments]
                try:
                    self._process = await asyncio.create_subprocess_exec(
                        *command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, env=environment,
                    )
                except FileNotFoundError:
                    fallback = self._source_python_fallback()
                    if fallback is None or os.path.normcase(os.fspath(fallback)) == os.path.normcase(command[0]):
                        raise
                    command[0] = str(fallback)
                    self._process = await asyncio.create_subprocess_exec(
                        *command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, env=environment,
                    )
                    self._settings.dedup.python_executable = fallback
                    repaired_python = fallback
                waiting = asyncio.create_task(self._process.wait())
                while not waiting.done():
                    downloaded, expected = self._progress()
                    self._message = "正在下载并检查模型" if downloaded < expected else "正在加载模型"
                    await asyncio.wait({waiting}, timeout=0.5)
                if await waiting:
                    raise RuntimeError("模型准备进程失败")
            if "dedup" in self._selected_models:
                sscd, dino, repository = self._paths()
                if not (self._file_size(sscd) > 0 and self._file_size(dino) > 0 and repository.is_file()):
                    raise RuntimeError("模型准备完成，但模型文件不完整")
            if filters:
                capabilities = await asyncio.to_thread(
                    filter_capabilities, self._settings.dedup.model_dir, self._settings.dedup.python_executable,
                    selected=filters, refresh=True,
                )
                if any(not capabilities[option]["available"] for option, name in
                       (("filter_monochrome", "monochrome"), ("filter_character", "ccip")) if name in filters):
                    raise RuntimeError("过滤模型离线推理校验失败")
            updates: dict[str, Any] = {}
            if "dedup" in self._selected_models:
                updates["enabled"] = True
            if repaired_python is not None:
                updates["python_executable"] = str(repaired_python)
            if updates:
                saving_settings = True
                await self._runtime_config.update_section("dedup", updates)
            if "dedup" in self._selected_models:
                self._settings.dedup.enabled = True
                if self._on_enabled is not None:
                    await self._on_enabled()
            self._phase = "ready"
            self._message = "模型已安装并启用" if "dedup" in self._selected_models else "过滤模型已准备并通过 CPU 推理校验"
        except asyncio.CancelledError:
            if self._process is not None and self._process.returncode is None:
                self._process.kill()
                await self._process.wait()
            raise
        except FileNotFoundError:
            self._phase = "failed"
            self._message = "模型组件缺失，请检查去重 Python 或重新安装 LDOS"
        except Exception:
            self._phase = "failed"
            self._message = ("模型已下载，但启用设置保存失败，请重试" if saving_settings else
                             "模型下载或校验失败，请检查去重 ONNX 依赖、网络或本次代理后重试")
        finally:
            self._process = None
            self._using_proxy = False

    async def close(self) -> None:
        task = self._task
        if task is None or task.done():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
