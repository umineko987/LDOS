"""统一模型表：去重/过滤模型（ModelSetupManager）与打标模型（TaggerService）。

一张表列出所有模型的状态、大小、许可和用途；安装统一走
`install(keys)`，按家族分派到原有安装器，并套用统一下载设置
（镜像 / 下载代理 / HF token）。进度沿用两套安装器已有的 Job：

- 去重家族：`models:dedup`（JobSampler 按 1 Hz 采样 ModelSetupManager）；
- 打标家族：TaggerService 自己登记的 `tagger:<uuid>`。

代理池模式下租到的节点在对应安装器任务结束后归还。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from typing import Any, Literal

from .download_settings import DownloadEnvironment, DownloadProxyUnavailable, DownloadSettingsStore
from .model_setup import DINO_BYTES, SSCD_BYTES
from .redaction import redact_text
from .review_filter_models import MODEL_FILES

logger = logging.getLogger(__name__)

ModelFamily = Literal["dedup", "tagger"]
ModelStatus = Literal["installed", "missing", "installing", "failed", "needs_license", "disabled"]

DEDUP_JOB_ID = "models:dedup"


@dataclass(frozen=True, slots=True)
class DedupModelEntry:
    key: str
    display_name: str
    installer_name: str  # ModelSetupManager 的选择名：dedup / completeness / ccip
    size_bytes: int
    license: str | None
    source_url: str
    used_by: tuple[str, ...]


DEDUP_MODELS: tuple[DedupModelEntry, ...] = (
    DedupModelEntry(
        "sscd", "SSCD 拷贝检测", "dedup", SSCD_BYTES, "MIT",
        "https://github.com/facebookresearch/sscd-copy-detection", ("dedup",),
    ),
    DedupModelEntry(
        "dino", "DINOv2 ViT-S/14", "dedup", DINO_BYTES, "Apache-2.0",
        "https://github.com/facebookresearch/dinov2", ("dedup", "atlas"),
    ),
    DedupModelEntry(
        "completeness", "画面完整度（anime_completeness）", "completeness",
        sum(entry[1] for entry in MODEL_FILES["completeness"]), None,
        "https://huggingface.co/deepghs/anime_completeness", ("clean",),
    ),
    DedupModelEntry(
        "ccip", "角色一致性（CCIP）", "ccip",
        sum(entry[1] for entry in MODEL_FILES["ccip"]), None,
        "https://huggingface.co/deepghs/ccip_onnx", ("clean",),
    ),
)
_DEDUP_BY_KEY = {entry.key: entry for entry in DEDUP_MODELS}

_TAGGER_DISPLAY_NAMES = {
    "wd-vit-v3": "WD ViT v3",
    "wd-convnext-v3": "WD ConvNeXt v3",
    "wd-swinv2-v3": "WD SwinV2 v3",
    "wd-vit-large-v3": "WD ViT-Large v3",
    "wd-eva02-large-v3": "WD EVA02-Large v3",
    "wd-eva02-2026-canary": "WD EVA02 2026 Canary",
    "pixai-tagger-v1": "PixAI Tagger v1.0",
    "cl-tagger-v2": "CL Tagger v2",
}


class ModelsError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class ModelsService:
    def __init__(
        self,
        settings: Any,
        model_setup: Any,
        tagger: Any,
        downloads: DownloadSettingsStore,
    ) -> None:
        self._settings = settings
        self._model_setup = model_setup
        self._tagger = tagger
        self._downloads = downloads
        self._watchers: set[asyncio.Task[None]] = set()

    # ---- 列表 ----

    def list_models(self) -> dict[str, Any]:
        items = [*self._dedup_items(), *self._tagger_items()]
        return {"items": items}

    def _dedup_items(self) -> list[dict[str, Any]]:
        status = self._model_setup.status()
        installed = {
            key: bool((status.get("models") or {}).get(key, {}).get("installed"))
            for key in _DEDUP_BY_KEY
        }
        phase = str(status.get("phase") or "")
        requested = set(status.get("requested_models") or [])
        message = str(status.get("message") or "")
        models_status = status.get("models") or {}
        items: list[dict[str, Any]] = []
        for entry in DEDUP_MODELS:
            involved = entry.installer_name in requested
            if phase == "installing" and involved:
                state: ModelStatus = "installing"
            elif installed[entry.key]:
                state = "installed"
            elif phase == "failed" and involved:
                state = "failed"
            else:
                state = "missing"
            progress = None
            if state == "installing":
                if entry.installer_name == "dedup":
                    progress = {
                        "current": int(status.get("downloaded_bytes") or 0),
                        "total": int(status.get("expected_bytes") or 0),
                    }
                else:
                    detail = models_status.get(entry.key) or {}
                    progress = {
                        "current": int(detail.get("downloaded_bytes") or 0),
                        "total": int(detail.get("expected_bytes") or entry.size_bytes),
                    }
            items.append({
                "key": entry.key,
                "family": "dedup",
                "display_name": entry.display_name,
                "status": state,
                "size_bytes": entry.size_bytes,
                "installed_bytes": entry.size_bytes if installed[entry.key] else 0,
                "license": entry.license,
                "gated": False,
                "source_url": entry.source_url,
                "used_by": list(entry.used_by),
                "installs_with": [
                    other.key for other in DEDUP_MODELS
                    if other.installer_name == entry.installer_name and other.key != entry.key
                ],
                "message": redact_text(message, limit=300) if state in ("installing", "failed") else "",
                "progress": progress,
                "job_id": DEDUP_JOB_ID if state == "installing" else None,
            })
        return items

    def _tagger_items(self) -> list[dict[str, Any]]:
        enabled = bool(self._settings.tagger.enabled)
        try:
            catalog = self._tagger_catalog()
        except ModelsError:
            catalog = []
        token = self._downloads.token()
        secrets = (token,) if token else ()
        state = self._tagger.state
        preparing = set(getattr(self._tagger, "prepare_models", ()) or ())
        items: list[dict[str, Any]] = []
        for entry in catalog:
            key = str(entry["key"])
            installed = bool(entry.get("installed"))
            gated = bool(entry.get("gated"))
            if not enabled:
                status: ModelStatus = "disabled"
            elif state.phase == "preparing" and key in preparing:
                status = "installing"
            elif installed:
                status = "installed"
            elif state.phase == "failed" and key in preparing:
                status = "failed"
            elif gated:
                status = "needs_license"
            else:
                status = "missing"
            progress = None
            if status == "installing":
                download = (state.download or {}).get(key) or {}
                if download:
                    progress = {
                        "current": int(download.get("done") or 0),
                        "total": int(download.get("total") or 0),
                    }
            items.append({
                "key": key,
                "family": "tagger",
                "display_name": _TAGGER_DISPLAY_NAMES.get(key, key),
                "status": status,
                "size_bytes": None,
                "installed_bytes": self._tagger.installed_bytes(key) if installed else 0,
                "license": str(entry.get("license") or "") or None,
                "gated": gated,
                "source_url": f"https://huggingface.co/{entry.get('repo')}",
                "used_by": ["tag"],
                "installs_with": [],
                "message": (
                    redact_text(state.message, secrets=secrets, limit=300)
                    if status in ("installing", "failed") else ""
                ),
                "progress": progress,
                "job_id": self._tagger.current_job_id if status == "installing" else None,
            })
        return items

    # ---- 安装 ----

    async def install(self, keys: list[str], *, accept_license: bool = False) -> dict[str, Any]:
        wanted = list(dict.fromkeys(keys))
        if not wanted:
            raise ModelsError(422, "invalid_model_selection", "请至少选择一个模型")
        dedup_keys = [key for key in wanted if key in _DEDUP_BY_KEY]
        tagger_keys = [key for key in wanted if key not in _DEDUP_BY_KEY]
        if tagger_keys:
            catalog = {entry["key"]: entry for entry in self._tagger_catalog()}
            unknown = [key for key in tagger_keys if key not in catalog]
            if unknown:
                raise ModelsError(422, "unknown_model", f"未登记的模型: {', '.join(unknown)}")
            if not self._settings.tagger.enabled:
                raise ModelsError(409, "tagger_disabled", "打标功能未启用")
            gated = [key for key in tagger_keys if catalog[key].get("gated")]
            if gated and not accept_license:
                raise ModelsError(
                    422, "model_license_required",
                    f"模型受自定义许可约束，需要先同意许可：{', '.join(gated)}",
                )
        if dedup_keys and self._model_setup.running_task is not None:
            raise ModelsError(409, "models_busy", "已有去重模型在安装")
        if tagger_keys and self._tagger.running_task is not None:
            raise ModelsError(409, "tagger_busy", "已有打标任务在运行")

        started: list[dict[str, Any]] = []
        # 打标先启动：它更可能启动失败（CLI 缺失），失败时什么都还没开始。
        if tagger_keys:
            _result, environment = await self._start_tagger(tagger_keys, accept_license=accept_license)
            started.append({
                "family": "tagger", "keys": tagger_keys, "job_id": self._tagger.current_job_id,
                "proxy_source": environment.proxy_source,
            })
        if dedup_keys:
            started.append(await self._start_dedup(dedup_keys))
        listing = await asyncio.to_thread(self.list_models)
        return {"started": started, **listing}

    async def prepare_tagger(
        self, keys: list[str], *, accept_license: bool, overrides: dict[str, Any],
    ) -> dict[str, Any]:
        """旧 /tagger/models/prepare：请求里显式给出的 token/镜像/代理原样使用，
        没给的取统一下载设置。返回 TaggerService.prepare 的原始结果。"""

        result, _environment = await self._start_tagger(keys, accept_license=accept_license, overrides=overrides)
        return result

    def _tagger_catalog(self) -> list[dict[str, Any]]:
        try:
            return self._tagger.model_catalog()
        except Exception as error:
            logger.warning("tagger model catalog unavailable: %s", redact_text(error, limit=300))
            raise ModelsError(503, "tagger_unavailable", "打标模型登记表不可用") from error

    async def _resolve(self, owner: str, overrides: dict[str, Any] | None = None) -> DownloadEnvironment:
        try:
            return await asyncio.to_thread(self._downloads.resolve, owner, **(overrides or {}))
        except DownloadProxyUnavailable as error:
            raise ModelsError(409, "download_proxy_unavailable", str(error)) from error

    async def _start_dedup(self, keys: list[str]) -> dict[str, Any]:
        selection = list(dict.fromkeys(_DEDUP_BY_KEY[key].installer_name for key in keys))
        environment = await self._resolve(f"models:dedup:{uuid.uuid4().hex}")
        try:
            await self._model_setup.install(environment.proxy, selection, hf_endpoint=environment.hf_endpoint)
        except ValueError as error:
            await asyncio.to_thread(self._downloads.release, environment)
            raise ModelsError(422, "invalid_download_proxy", str(error)) from error
        except BaseException:
            await asyncio.to_thread(self._downloads.release, environment)
            raise
        self._watch(self._model_setup.running_task, environment)
        covered = [entry.key for entry in DEDUP_MODELS if entry.installer_name in selection]
        return {"family": "dedup", "keys": covered, "job_id": DEDUP_JOB_ID, "proxy_source": environment.proxy_source}

    async def _start_tagger(
        self, keys: list[str], *, accept_license: bool, overrides: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], DownloadEnvironment]:
        environment = await self._resolve(f"models:tagger:{uuid.uuid4().hex}", overrides)
        secrets = (environment.token,) if environment.token else ()
        try:
            result = await self._tagger.prepare(
                keys, environment.token, accept_license=accept_license,
                proxy_url=environment.hf_endpoint, download_proxy=environment.proxy,
            )
        except OSError as error:
            await asyncio.to_thread(self._downloads.release, environment)
            raise ModelsError(503, "tagger_start_failed", redact_text(error, secrets=secrets, limit=300)) from error
        except RuntimeError as error:
            await asyncio.to_thread(self._downloads.release, environment)
            raise ModelsError(409, "tagger_busy", redact_text(error, secrets=secrets, limit=300)) from error
        except BaseException:
            await asyncio.to_thread(self._downloads.release, environment)
            raise
        self._watch(self._tagger.running_task, environment)
        return result, environment

    def _watch(self, task: asyncio.Task[Any] | None, environment: DownloadEnvironment) -> None:
        """安装器任务结束后归还代理池租约；没有租约就不必等。"""

        if environment.lease_owner is None:
            return
        if task is None:
            self._downloads.release(environment)
            return

        async def release_when_done() -> None:
            try:
                await asyncio.gather(task, return_exceptions=True)
            finally:
                await asyncio.to_thread(self._downloads.release, environment)

        watcher = asyncio.create_task(release_when_done(), name="models-download-lease")
        self._watchers.add(watcher)
        watcher.add_done_callback(self._watchers.discard)

    async def close(self) -> None:
        watchers = list(self._watchers)
        for watcher in watchers:
            watcher.cancel()
        if watchers:
            await asyncio.gather(*watchers, return_exceptions=True)
