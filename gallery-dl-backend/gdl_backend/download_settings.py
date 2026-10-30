"""统一的模型下载设置：HF 镜像、下载代理、HF token。

- 镜像和代理模式存在 runtime 目录下的 `download-settings.json`（0600）；
- HF token 单独存 `hf-token`（0600），只写不读：对外只给 `token_set`
  和末四位提示，不进日志、不进任何响应；
- 代理模式 `pool` 在每次下载时向代理池租一个节点，下载结束后归还。
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from .file_security import reject_symlink_path, write_private_text
from .model_setup import normalize_download_proxy
from .redaction import redact_text

DownloadProxyMode = Literal["none", "pool", "custom"]
DOWNLOAD_PROXY_MODES: tuple[str, ...] = ("none", "pool", "custom")
MAX_HF_TOKEN_LENGTH = 8192
SETTINGS_FILENAME = "download-settings.json"
TOKEN_FILENAME = "hf-token"


class DownloadSettingsError(ValueError):
    """设置值不合法；message 可直接展示，不含 token。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class DownloadProxyUnavailable(RuntimeError):
    """模式为 pool 但代理池当前租不到节点。"""


def normalize_hf_mirror(value: str | None) -> str | None:
    """HF 镜像地址：HTTP(S)，不能带凭据、查询参数或片段；空值表示官方源。"""

    if value is None or not value.strip():
        return None
    value = value.strip().rstrip("/")
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError as error:
        raise ValueError("镜像地址格式无效") from error
    if (
        len(value) > 300
        or parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or any(ord(character) <= 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("镜像地址必须是 HTTP(S) URL，不能包含凭据、查询参数或片段")
    return value


def _normalize_token(value: str) -> str:
    token = value.strip()
    if not token:
        raise DownloadSettingsError("invalid_hf_token", "HF token 不能为空")
    if len(token) > MAX_HF_TOKEN_LENGTH or any(
        ord(character) <= 32 or ord(character) == 127 for character in token
    ):
        raise DownloadSettingsError("invalid_hf_token", "HF token 格式无效")
    return token


@dataclass(frozen=True, slots=True)
class DownloadSettings:
    hf_mirror: str | None = None
    proxy_mode: DownloadProxyMode = "none"
    custom_proxy: str | None = None


@dataclass(frozen=True, slots=True)
class DownloadEnvironment:
    """一次下载实际使用的设置；token 只给子进程 stdin，不放进环境变量。"""

    hf_endpoint: str | None
    proxy: str | None
    token: str | None = field(repr=False)
    proxy_source: Literal["none", "pool", "custom"]
    lease_owner: str | None = None


_UNSET: Any = object()


class DownloadSettingsStore:
    def __init__(self, runtime_dir: Path, *, proxy: Any | None = None) -> None:
        self._settings_path = Path(runtime_dir) / SETTINGS_FILENAME
        self._token_path = Path(runtime_dir) / TOKEN_FILENAME
        self._proxy = proxy
        self._lock = threading.Lock()

    # ---- 读取 ----

    def load(self) -> DownloadSettings:
        with self._lock:
            return self._load_locked()

    def _load_locked(self) -> DownloadSettings:
        try:
            raw = json.loads(self._settings_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return DownloadSettings()
        except (OSError, ValueError):
            # 文件损坏时退回默认值，下次保存会整体重写。
            return DownloadSettings()
        if not isinstance(raw, dict):
            return DownloadSettings()
        try:
            mirror = normalize_hf_mirror(raw.get("hf_mirror")) if isinstance(raw.get("hf_mirror"), str) else None
        except ValueError:
            mirror = None
        mode = raw.get("proxy_mode") if raw.get("proxy_mode") in DOWNLOAD_PROXY_MODES else "none"
        try:
            custom = normalize_download_proxy(raw.get("custom_proxy")) if isinstance(raw.get("custom_proxy"), str) else None
        except ValueError:
            custom = None
        if mode == "custom" and custom is None:
            mode = "none"
        return DownloadSettings(hf_mirror=mirror, proxy_mode=mode, custom_proxy=custom)

    def token(self) -> str | None:
        """只供后端启动下载子进程使用；绝不出现在响应里。"""

        with self._lock:
            return self._read_token_locked()

    def _read_token_locked(self) -> str | None:
        try:
            reject_symlink_path(self._token_path)
            value = self._token_path.read_text(encoding="utf-8").strip()
        except (FileNotFoundError, ValueError):
            return None
        except OSError:
            return None
        return value or None

    def view(self) -> dict[str, Any]:
        with self._lock:
            settings = self._load_locked()
            token = self._read_token_locked()
        return {
            "hf_mirror": settings.hf_mirror,
            "proxy_mode": settings.proxy_mode,
            # 自定义代理可能带用户名密码，对外只给打码后的地址。
            "custom_proxy": redact_text(settings.custom_proxy) if settings.custom_proxy else None,
            "custom_proxy_has_credentials": _has_credentials(settings.custom_proxy),
            "token_set": token is not None,
        }

    # ---- 写入 ----

    def update(
        self,
        *,
        hf_mirror: str | None = _UNSET,
        proxy_mode: str = _UNSET,
        custom_proxy: str | None = _UNSET,
        hf_token: str | None = _UNSET,
    ) -> dict[str, Any]:
        """hf_token：字符串=保存，None=清除，不传=不变。"""

        with self._lock:
            current = self._load_locked()
            mirror = current.hf_mirror
            mode = current.proxy_mode
            custom = current.custom_proxy
            if hf_mirror is not _UNSET:
                try:
                    mirror = normalize_hf_mirror(hf_mirror)
                except ValueError as error:
                    raise DownloadSettingsError("invalid_hf_mirror", str(error)) from error
            if custom_proxy is not _UNSET:
                try:
                    custom = normalize_download_proxy(custom_proxy)
                except ValueError as error:
                    raise DownloadSettingsError("invalid_download_proxy", str(error)) from error
            if proxy_mode is not _UNSET:
                if proxy_mode not in DOWNLOAD_PROXY_MODES:
                    raise DownloadSettingsError("invalid_download_proxy_mode", "下载代理模式无效")
                mode = proxy_mode  # type: ignore[assignment]
            if mode == "custom" and custom is None:
                raise DownloadSettingsError("invalid_download_proxy", "自定义下载代理需要填写带端口的 HTTP(S) 地址")
            token_value = _UNSET
            if hf_token is not _UNSET and hf_token is not None:
                token_value = _normalize_token(hf_token)
            payload = {"hf_mirror": mirror, "proxy_mode": mode, "custom_proxy": custom}
            write_private_text(self._settings_path, json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
            if hf_token is None:
                self._clear_token_locked()
            elif token_value is not _UNSET:
                write_private_text(self._token_path, token_value + "\n")
        return self.view()

    def _clear_token_locked(self) -> None:
        try:
            reject_symlink_path(self._token_path)
            os.unlink(self._token_path)
        except FileNotFoundError:
            pass

    # ---- 解析一次下载要用的环境 ----

    def resolve(
        self,
        owner: str,
        *,
        token: str | None = _UNSET,
        hf_mirror: str | None = _UNSET,
        proxy: str | None = _UNSET,
    ) -> DownloadEnvironment:
        """显式传入的项原样使用（包括 None：旧接口明确不用镜像/代理/token），
        没传的项取统一设置。

        pool 模式会向代理池租一个节点（可能阻塞，调用方放到线程里），
        下载结束后必须调用 release(environment) 归还。
        """

        settings = self.load()
        lease_owner: str | None = None
        source: Literal["none", "pool", "custom"]
        if proxy is not _UNSET:
            resolved_proxy, source = proxy, "custom" if proxy else "none"
        elif settings.proxy_mode == "custom":
            resolved_proxy, source = settings.custom_proxy, "custom"
        elif settings.proxy_mode == "pool":
            resolved_proxy = self._lease(owner)
            lease_owner, source = owner, "pool"
        else:
            resolved_proxy, source = None, "none"
        return DownloadEnvironment(
            hf_endpoint=settings.hf_mirror if hf_mirror is _UNSET else hf_mirror,
            proxy=resolved_proxy,
            token=self.token() if token is _UNSET else token,
            proxy_source=source,
            lease_owner=lease_owner,
        )

    def release(self, environment: DownloadEnvironment) -> None:
        if environment.lease_owner is not None:
            self._release(environment.lease_owner)

    def _lease(self, owner: str) -> str:
        if self._proxy is None:
            raise DownloadProxyUnavailable("代理池不可用")
        try:
            lease = self._proxy.acquire(owner)
        except Exception as error:
            raise DownloadProxyUnavailable(redact_text(error, limit=300)) from error
        endpoint = str(getattr(lease, "endpoint", "") or "") if lease is not None else ""
        if not endpoint:
            if lease is not None:
                self._release(owner)
            raise DownloadProxyUnavailable("代理池当前没有可租用的节点，请先启动代理池或改用其他下载代理")
        return endpoint

    def _release(self, owner: str) -> None:
        if self._proxy is None:
            return
        try:
            self._proxy.release(owner, proxy_fault=False, reason="model_download_finished")
        except Exception:
            pass


def _has_credentials(value: str | None) -> bool:
    if not value:
        return False
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return parsed.username is not None or parsed.password is not None
