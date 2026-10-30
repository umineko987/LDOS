"""打标后端服务：子进程托管 tagger CLI。

- prepare / tag 两条命令各自启动一个 CLI 子进程（同一时刻至多一个）；
- stdout 逐行解析 JSON 事件（--progress-json 协议），更新轮询状态；
- stderr 只保留尾部若干行用于失败诊断；
- token 只写子进程 stdin，不进日志；CLI 把它回显到 stderr 时，失败消息里打码；
- tag 的图片列表经 stdin 传给 `--inputs-file -`，不受命令行长度限制；
- candidates / compose 是只读缓存的查询，用 `query()` 一次性收集数据行，
  不占用 prepare / tag 的运行槽。
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .config import AppSettings
from .redaction import redact_text

if TYPE_CHECKING:
    from .events import JobRegistry

logger = logging.getLogger(__name__)

# 一次运行结束后的回调：参数是 {"status", "message", "last_result"}。
FinishedCallback = Callable[[dict[str, Any]], Awaitable[None] | None]


class TaggerQueryError(RuntimeError):
    """candidates / compose 查询失败；exit_code 是 CLI 退出码（-1 表示超时或启动失败）。"""

    def __init__(self, exit_code: int, message: str) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def encode_input_lines(lines: Sequence[str]) -> bytes:
    """`--inputs-file -` 的 stdin 载荷：一行一个条目，surrogate 原样往返。"""
    return "".join(f"{line}\n" for line in lines).encode("utf-8", "surrogateescape")


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
    def __init__(self, settings: AppSettings, *, jobs: JobRegistry | None = None):
        self._settings = settings
        self._lock = asyncio.Lock()
        self._process: asyncio.subprocess.Process | None = None
        self._task: asyncio.Task[None] | None = None
        self.state = TaggerTaskState()
        # 活动中心：每次 prepare/tag 登记一个 Job，进度随 CLI 事件推送。
        self._jobs = jobs
        self._job_id: str | None = None
        self._cancelling = False
        # 最近一次 prepare 涉及的模型（统一模型表用它判断「安装中/失败」）。
        self.prepare_models: tuple[str, ...] = ()
        self._on_finished: FinishedCallback | None = None
        # 当前子进程拿到的 token（只有 prepare 有）：CLI 回显到 stderr 时，状态、Job 和查询错误里都打码。
        self._secrets: tuple[str, ...] = ()
        # 每次 tag 运行结束（不论成败，推理可能已写入部分分数）都加一；
        # 候选分数的缓存键用它判断打标缓存是否变过。
        self.cache_generation = 0

    @property
    def current_job_id(self) -> str | None:
        return self._job_id

    @property
    def running_task(self) -> asyncio.Task[None] | None:
        """当前子进程的收尾任务；为 None 或已完成表示空闲。"""

        return self._task if self._process is not None else None

    def _job_start(self, kind: str, title: str, *, total: int | None, ref: Mapping[str, Any]) -> None:
        self._job_id = None
        if self._jobs is not None:
            self._job_id = self._jobs.start(kind, title, total=total, ref=ref)["id"]

    def _job_update(self, **changes: Any) -> None:
        if self._jobs is not None and self._job_id is not None:
            self._jobs.update(self._job_id, **changes)

    def _job_finish(self, status: str, message: str = "") -> None:
        if self._jobs is not None and self._job_id is not None:
            self._jobs.finish(self._job_id, status, message=message)  # type: ignore[arg-type]
        self._job_id = None

    # ---- 状态查询 ----

    def _import_tagger(self, module: str):
        import importlib
        import sys

        root_path = Path(__file__).resolve().parent.parent
        if not (root_path / "tagger").is_dir():
            root_path = root_path.parent
        root = str(root_path / "tagger")
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

    def installed_bytes(self, key: str) -> int:
        """已安装 bundle 的文件总大小；未安装或不可读返回 0。"""

        spec = self._import_tagger("specs").SPECS.get(key)
        if spec is None:
            return 0
        path = self._import_tagger("bundle").bundle_path(self._settings.tagger.model_dir, key)
        total = 0
        for remote in spec.files:
            try:
                candidate = path / remote.name
                if candidate.is_file() and not candidate.is_symlink():
                    total += candidate.stat().st_size
            except OSError:
                continue
        return total

    # ---- 子进程管理 ----

    async def _create_process(
        self, args: Sequence[str], *, stdin: bool, env: dict[str, str] | None = None
    ) -> asyncio.subprocess.Process:
        cli = self._settings.tagger.cli_script
        if not cli.is_file():
            raise FileNotFoundError(f"tagger CLI 不存在: {cli}")
        process_env = os.environ.copy()
        if env:
            process_env.update(env)
        return await asyncio.create_subprocess_exec(
            str(self._settings.tagger.python_executable),
            str(cli),
            "--model-dir", str(self._settings.tagger.model_dir),
            *args,
            stdin=asyncio.subprocess.PIPE if stdin else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=process_env,
        )

    @staticmethod
    async def _feed_stdin(process: asyncio.subprocess.Process, data: bytes | None) -> None:
        if data is None or process.stdin is None:
            return
        try:
            process.stdin.write(data)
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            # 子进程提前退出：退出码和 stderr 会说明原因。
            pass
        finally:
            try:
                process.stdin.close()
            except (BrokenPipeError, ConnectionResetError):
                pass

    async def _spawn(
        self,
        args: list[str],
        stdin_data: bytes | None,
        env: dict[str, str] | None = None,
        *,
        on_finished: FinishedCallback | None = None,
    ) -> None:
        try:
            process = await self._create_process(args, stdin=stdin_data is not None, env=env)
        except Exception as error:
            self.state.phase = "failed"
            self.state.message = self._redact(error)
            self._secrets = ()
            self._job_finish("failed", self.state.message)
            raise
        self._process = process
        self._on_finished = on_finished
        self._task = asyncio.create_task(self._drain("idle", stdin_data))

    async def _drain(self, phase_on_done: str, stdin_data: bytes | None = None) -> None:
        process = self._process
        assert process is not None and process.stdout is not None and process.stderr is not None
        stderr_tail = b""

        async def read_stdout() -> None:
            async for raw in process.stdout:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line.startswith("{"):
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                self._apply_event(event)

        async def read_stderr() -> None:
            nonlocal stderr_tail
            while raw := await process.stderr.read(8192):
                stderr_tail = (stderr_tail + raw)[-4096:]

        try:
            await asyncio.gather(read_stdout(), read_stderr(), self._feed_stdin(process, stdin_data))
            return_code = await process.wait()
            if return_code == 0:
                self.state.phase = phase_on_done
                self.state.message = ""
            else:
                self.state.phase = "failed"
                tail = stderr_tail.decode("utf-8", errors="replace").splitlines()[-8:]
                self.state.message = self._redact("；".join(tail)) or f"子进程退出码 {return_code}"
        except Exception as error:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()
            self.state.phase = "failed"
            self.state.message = self._redact(error)
        finally:
            self._process = None
            self._secrets = ()
            if self.state.phase == "failed":
                status = "cancelled" if self._cancelling else "failed"
                self._job_finish(status, "" if self._cancelling else self.state.message)
            else:
                status = "succeeded"
                self._job_finish(status)
            callback, self._on_finished = self._on_finished, None
            if callback is not None:
                await self._notify_finished(callback, status)

    def _redact(self, value: object) -> str:
        return redact_text(value, secrets=self._secrets)[-500:]

    async def _notify_finished(self, callback: FinishedCallback, status: str) -> None:
        summary = {
            "status": status,
            "message": "" if status == "succeeded" else self.state.message,
            "last_result": dict(self.state.last_result),
        }
        try:
            outcome = callback(summary)
            if inspect.isawaitable(outcome):
                await outcome
        except Exception:
            logger.exception("tagger finished callback failed")

    def _apply_event(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "install_start":
            self.state.message = f"下载 {event.get('model')}"
            self._job_update(message=self.state.message)
        elif kind == "download":
            model = str(event.get("model") or "")
            entry = {"file": event.get("file"), "done": event.get("done", 0), "total": event.get("total", 0)}
            downloads = dict(self.state.download)
            downloads[model] = entry
            self.state.download = downloads
            self._job_update(
                current=entry["done"], total=entry["total"] or None,
                message=f"{model} · {entry['file'] or ''}".rstrip(" ·"),
            )
        elif kind == "installed":
            downloads = dict(self.state.download)
            downloads.pop(str(event.get("model") or ""), None)
            self.state.download = downloads
            self.state.message = f"{event.get('model')} 就绪"
            self._job_update(message=self.state.message)
        elif kind == "progress":
            self.state.stage = str(event.get("stage") or "")
            self.state.done = int(event.get("done") or 0)
            self.state.total = int(event.get("total") or 0)
            self._job_update(current=self.state.done, total=self.state.total or None, message=self.state.stage)
        elif kind == "done":
            self.state.last_result = dict(event)
            self.state.stage = ""
            self.state.download = {}

    # ---- 对外操作 ----

    async def prepare(
        self, models: list[str], token: str | None = None, *, accept_license: bool = False,
        proxy_url: str | None = None, download_proxy: str | None = None,
        job_ref: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        async with self._lock:
            if self._process is not None:
                raise RuntimeError("已有打标任务在运行")
            self.state = TaggerTaskState(phase="preparing", message="准备下载")
            self.prepare_models = tuple(models)
            self._job_start(
                "tagger.prepare", "下载打标模型", total=None,
                ref={"models": ",".join(models), **(job_ref or {})},
            )
            args = ["prepare", "--progress-json", "--models", ",".join(models)]
            if token:
                args += ["--token-file", "-"]
            if accept_license:
                args += ["--accept-license"]
            env = {"HF_ENDPOINT": proxy_url} if proxy_url else {}
            if download_proxy:
                env.update({
                    "HTTP_PROXY": download_proxy, "HTTPS_PROXY": download_proxy,
                    "http_proxy": download_proxy, "https_proxy": download_proxy,
                    "NO_PROXY": "", "no_proxy": "",
                })
            stdin_data = token.encode("utf-8") + b"\n" if token else None
            self._secrets = (token,) if token else ()
            await self._spawn(args, stdin_data, env=env or None)
            return {"phase": "preparing", "models": models}

    async def tag(
        self,
        models: list[str],
        inputs: list[str],
        *,
        thresholds: dict[str, dict[str, float]] | None = None,
        categories: list[str] | None = None,
        batch_size: int = 8,
        job_ref: Mapping[str, Any] | None = None,
        on_finished: FinishedCallback | None = None,
    ) -> dict[str, Any]:
        """启动一次打标；inputs 经 stdin 交给 `--inputs-file -`。

        on_finished 在子进程结束、Job 收尾之后调用（取消和失败也调用）。
        """
        async with self._lock:
            if self._process is not None:
                raise RuntimeError("已有打标任务在运行")
            self.state = TaggerTaskState(phase="tagging", message="")
            self.prepare_models = ()
            self._job_start(
                "tagger.tag", f"打标 {len(inputs)} 张", total=len(inputs),
                ref={"models": ",".join(models), **(job_ref or {})},
            )
            args = [
                "tag", "--progress-json",
                "--models", ",".join(models),
                "--cache", str(self._settings.tagger.cache_path),
                "--batch-size", str(batch_size),
            ]
            # 只算分写进缓存，从不直接写 .txt：caption 一律经数据集的 caption 批次（可撤销、更新图库索引）。
            args += ["--inputs-file", "-", "--no-captions"]
            for model, overrides in (thresholds or {}).items():
                for category, value in overrides.items():
                    args += ["--model-threshold", model, category, str(value)]
            if categories:
                args += ["--categories", ",".join(categories)]
            job_id = self._job_id
            await self._spawn(
                args, encode_input_lines(inputs), env=None,
                on_finished=self._bump_cache_generation(on_finished),
            )
            return {"phase": "tagging", "models": models, "inputs": inputs, "job_id": job_id}

    def _bump_cache_generation(self, on_finished: FinishedCallback | None) -> FinishedCallback:
        async def finished(summary: dict[str, Any]) -> None:
            self.cache_generation += 1
            if on_finished is not None:
                outcome = on_finished(summary)
                if inspect.isawaitable(outcome):
                    await outcome

        return finished

    async def query(
        self,
        command: str,
        models: Sequence[str],
        input_lines: Sequence[str],
        extra_args: Sequence[str] = (),
        *,
        timeout: float = 600.0,
    ) -> list[dict[str, Any]]:
        """运行只读缓存的 candidates / compose，返回全部 JSON 数据行（含 models 头和 done）。

        不经过运行槽：和正在进行的 tag 并行也安全（SQLite 缓存自己管并发）。
        非零退出码抛 TaggerQueryError（带 stderr 尾部）。
        """
        if command not in {"candidates", "compose"}:
            raise ValueError(f"unsupported tagger query: {command}")
        args = [
            command,
            "--models", ",".join(models),
            "--cache", str(self._settings.tagger.cache_path),
            "--inputs-file", "-",
            *extra_args,
        ]
        try:
            process = await self._create_process(args, stdin=True)
        except OSError as error:
            raise TaggerQueryError(-1, self._redact(error)) from error
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(encode_input_lines(input_lines)), timeout=timeout
            )
        except BaseException as error:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                await process.wait()
            if isinstance(error, asyncio.TimeoutError):
                raise TaggerQueryError(-1, "打标查询超时") from None
            raise
        if process.returncode != 0:
            tail = stderr.decode("utf-8", errors="replace").splitlines()[-8:]
            message = self._redact("；".join(tail)) or f"子进程退出码 {process.returncode}"
            raise TaggerQueryError(int(process.returncode or 0), message)
        lines: list[dict[str, Any]] = []
        for raw in stdout.splitlines():
            if not raw.startswith(b"{"):
                continue
            try:
                event = json.loads(raw)
            except ValueError:
                continue
            if isinstance(event, dict) and event.get("type") != "progress":
                lines.append(event)
        return lines

    async def cancel(self) -> dict[str, Any]:
        async with self._lock:
            process = self._process
            if process is None:
                return {"phase": self.state.phase, "message": "没有运行中的任务"}
            self._cancelling = True
            try:
                process.terminate()
            except ProcessLookupError:
                pass
            try:
                if self._task:
                    try:
                        await asyncio.wait_for(asyncio.shield(self._task), timeout=self._settings.tagger.shutdown_grace_seconds)
                    except asyncio.TimeoutError:
                        try:
                            process.kill()
                        except ProcessLookupError:
                            pass
                        await self._task
            finally:
                self._cancelling = False
            self.state.phase = "failed"
            self.state.message = "已取消"
            return {"phase": self.state.phase}

    async def close(self) -> None:
        if self._process is not None:
            await self.cancel()
