"""打标后端服务：子进程托管 tagger CLI。

- prepare / tag 两条命令各自启动一个 CLI 子进程（同一时刻至多一个）；
- stdout 逐行解析 JSON 事件（--progress-json 协议），更新轮询状态；
- stderr 只保留尾部若干行用于失败诊断；
- token 只写子进程 stdin，不进日志。
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import AppSettings


@dataclass(slots=True)
class TaggerTaskState:
    phase: str = "idle"  # idle | preparing | tagging | failed
    stage: str = ""
    done: int = 0
    total: int = 0
    message: str = ""
    download: dict[str, Any] = field(default_factory=dict)  # model -> {file, done, total}
    last_result: dict[str, Any] = field(default_factory=dict)


class TaggerService:
    def __init__(self, settings: AppSettings):
        self._settings = settings
        self._lock = asyncio.Lock()
        self._process: asyncio.subprocess.Process | None = None
        self._task: asyncio.Task[None] | None = None
        self.state = TaggerTaskState()

    # ---- 状态查询 ----

    _TAGGER_ROOT = Path(__file__).resolve().parents[2] / "tagger"

    def _import_tagger(self, module: str):
        import importlib
        import sys

        root = str(self._TAGGER_ROOT)
        if root not in sys.path:
            sys.path.insert(0, root)
        return importlib.import_module(module)

    def model_catalog(self) -> list[dict[str, Any]]:
        installed = self._import_tagger("bundle").installed
        SPECS = self._import_tagger("specs").SPECS

        result = []
        for spec in SPECS.values():
            result.append({
                "key": spec.key,
                "repo": spec.repo,
                "revision": spec.revision,
                "adapter": spec.adapter,
                "gated": spec.gated,
                "license": spec.license,
                "default_thresholds": dict(spec.default_thresholds),
                "installed": installed(spec, self._settings.tagger.model_dir),
            })
        return result

    def status(self) -> dict[str, Any]:
        state = self.state
        return {
            "phase": state.phase,
            "stage": state.stage,
            "done": state.done,
            "total": state.total,
            "message": state.message,
            "download": state.download,
            "last_result": state.last_result,
            "enabled": self._settings.tagger.enabled,
        }

    # ---- 子进程管理 ----

    async def _spawn(self, args: list[str], token: str | None) -> None:
        cli = self._settings.tagger.cli_script
        if not cli.is_file():
            raise FileNotFoundError(f"tagger CLI 不存在: {cli}")
        self._process = await asyncio.create_subprocess_exec(
            str(self._settings.tagger.python_executable),
            str(cli),
            "--model-dir", str(self._settings.tagger.model_dir),
            *args,
            stdin=asyncio.subprocess.PIPE if token else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        if token:
            self._process.stdin.write(token.encode("utf-8") + b"\n")
            self._process.stdin.close()

    async def _drain(self, phase_on_done: str) -> None:
        process = self._process
        assert process is not None and process.stdout is not None and process.stderr is not None
        stderr_tail: list[str] = []
        async for raw in process.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            self._apply_event(event)
        stderr = await process.stderr.read()
        for raw in stderr.decode("utf-8", errors="replace").splitlines()[-8:]:
            stderr_tail.append(raw)
        return_code = await process.wait()
        if return_code == 0:
            self.state.phase = phase_on_done
            self.state.message = ""
        else:
            self.state.phase = "failed"
            self.state.message = "；".join(stderr_tail)[-500:] or f"子进程退出码 {return_code}"
        self._process = None

    def _apply_event(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "install_start":
            self.state.message = f"下载 {event.get('model')}"
        elif kind == "download":
            model = str(event.get("model") or "")
            entry = {"file": event.get("file"), "done": event.get("done", 0), "total": event.get("total", 0)}
            downloads = dict(self.state.download)
            downloads[model] = entry
            self.state.download = downloads
        elif kind == "installed":
            downloads = dict(self.state.download)
            downloads.pop(str(event.get("model") or ""), None)
            self.state.download = downloads
            self.state.message = f"{event.get('model')} 就绪"
        elif kind == "progress":
            self.state.stage = str(event.get("stage") or "")
            self.state.done = int(event.get("done") or 0)
            self.state.total = int(event.get("total") or 0)
        elif kind == "done":
            self.state.last_result = dict(event)
            self.state.stage = ""
            self.state.download = {}

    # ---- 对外操作 ----

    async def prepare(self, models: list[str], token: str | None = None) -> dict[str, Any]:
        async with self._lock:
            if self.state.phase not in ("idle", "failed") and self._process:
                raise RuntimeError("已有打标任务在运行")
            self.state = TaggerTaskState(phase="preparing", message="准备下载")
            args = ["prepare", "--progress-json", "--models", ",".join(models)]
            if token:
                args += ["--token-file", "-"]
            await self._spawn(args, token if token else None)
            self._task = asyncio.create_task(self._drain("idle"))
            return {"phase": "preparing", "models": models}

    async def tag(
        self,
        models: list[str],
        inputs: list[str],
        *,
        thresholds: dict[str, float] | None = None,
        categories: list[str] | None = None,
        write_captions: bool = True,
        overwrite_captions: bool = False,
        batch_size: int = 8,
    ) -> dict[str, Any]:
        async with self._lock:
            if self.state.phase not in ("idle", "failed") and self._process:
                raise RuntimeError("已有打标任务在运行")
            self.state = TaggerTaskState(phase="tagging", message="")
            args = [
                "tag", "--progress-json",
                "--models", ",".join(models),
                "--cache", str(self._settings.tagger.cache_path),
                "--batch-size", str(batch_size),
            ]
            for item in inputs:
                args += ["--inputs", item]
            for category, value in (thresholds or {}).items():
                args += [f"--{category}-thr", str(value)]
            if categories:
                args += ["--categories", ",".join(categories)]
            if not write_captions:
                args += ["--no-captions"]
            if overwrite_captions:
                args += ["--overwrite"]
            await self._spawn(args, None)
            self._task = asyncio.create_task(self._drain("idle"))
            return {"phase": "tagging", "models": models, "inputs": inputs}

    async def cancel(self) -> dict[str, Any]:
        if self._process is None:
            return {"phase": self.state.phase, "message": "没有运行中的任务"}
        try:
            self._process.terminate()
        except ProcessLookupError:
            pass
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=self._settings.tagger.shutdown_grace_seconds)
            except asyncio.TimeoutError:
                self._process.kill()
        self.state.phase = "failed"
        self.state.message = "已取消"
        return {"phase": self.state.phase}

    async def close(self) -> None:
        if self._process is not None:
            try:
                self._process.terminate()
                await asyncio.wait_for(self._process.wait(), timeout=self._settings.tagger.shutdown_grace_seconds)
            except (ProcessLookupError, asyncio.TimeoutError):
                if self._process.returncode is None:
                    self._process.kill()
        if self._task:
            self._task.cancel()
