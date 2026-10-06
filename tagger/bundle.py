"""模型 bundle 安装器。

流程：整个 bundle 下载进暂存目录 → 逐文件 SHA256 校验 → 写 manifest →
目录级原子发布到最终位置。任何一步失败都清空暂存目录，不会出现
"半套模型"。已安装检测只看 manifest 与文件存在性（revision 匹配），
完整校验仅安装时执行。

代理沿用去重模块的约定：调用方设置 HTTP(S)_PROXY 环境变量。
gated 模型通过 token 参数临时持有 Authorization 头，不落盘。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
import urllib.request
from pathlib import Path
from typing import Callable

from specs import RemoteFile, SPECS, TaggerModelSpec

MANIFEST_NAME = "manifest.json"
STAGING_PREFIX = ".staging-"
TRASH_PREFIX = ".trash-"

ProgressCallback = Callable[[str, int, int], None]  # (文件名, 已下载字节, 总字节)


def _private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def _reject_managed_symlink(path: Path) -> None:
    if path.is_symlink():
        raise RuntimeError(f"拒绝通过符号链接管理模型文件: {path}")


def _sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_obj:
        while chunk := file_obj.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def bundle_path(model_dir: Path, key: str) -> Path:
    return model_dir / key


def read_manifest(path: Path) -> dict | None:
    manifest_file = path / MANIFEST_NAME
    if not manifest_file.is_file() or manifest_file.is_symlink():
        return None
    try:
        data = json.loads(manifest_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def installed(spec: TaggerModelSpec, model_dir: Path) -> bool:
    """仅做存在性与 revision 检查；完整校验见 verify_bundle。"""
    path = bundle_path(model_dir, spec.key)
    if path.is_symlink():
        return False
    manifest = read_manifest(path)
    if manifest is None or manifest.get("key") != spec.key or manifest.get("revision") != spec.revision:
        return False
    return all(
        not (path / remote.name).is_symlink() and (path / remote.name).is_file()
        for remote in spec.files
    )


def verify_bundle(spec: TaggerModelSpec, model_dir: Path) -> bool:
    """逐文件完整 SHA256 校验。大模型较慢，只在显式需要时调用。"""
    path = bundle_path(model_dir, spec.key)
    if not installed(spec, model_dir):
        return False
    return all(
        _sha256_file(path / remote.name) == remote.sha256
        for remote in spec.files
    )


def _download_to(
    url: str,
    destination: Path,
    expected_sha256: str,
    token: str | None,
    progress: ProgressCallback | None,
) -> None:
    """下载单个文件到 .part，校验通过后才 rename 到目标名。"""
    part_path = destination.with_suffix(destination.suffix + ".part")
    _reject_managed_symlink(part_path)
    part_path.unlink(missing_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "ldos-tagger/1.0"})
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    part_created = False
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            total = int(response.headers.get("Content-Length", 0))
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | int(getattr(os, "O_NOFOLLOW", 0))
            descriptor = os.open(part_path, flags, 0o600)
            part_created = True
            if progress is not None:
                progress(destination.name, 0, total)
            with os.fdopen(descriptor, "wb") as file_obj:
                downloaded = 0
                while chunk := response.read(1024 * 1024):
                    file_obj.write(chunk)
                    downloaded += len(chunk)
                    if progress is not None:
                        progress(destination.name, downloaded, total)
        if _sha256_file(part_path) != expected_sha256:
            raise RuntimeError(f"模型文件校验失败: {destination.name}")
        _reject_managed_symlink(destination)
        os.replace(part_path, destination)
        part_created = False
        try:
            os.chmod(destination, 0o600)
        except OSError:
            pass
    finally:
        if part_created:
            part_path.unlink(missing_ok=True)


def _publish(staging: Path, target: Path, manifest: dict) -> None:
    manifest_file = staging / MANIFEST_NAME
    manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(manifest_file, 0o600)
    except OSError:
        pass
    _reject_managed_symlink(target)
    if target.exists():
        trash = target.parent / f"{TRASH_PREFIX}{target.name}-{int(time.time())}"
        target.rename(trash)
    else:
        trash = None
    try:
        staging.rename(target)
    except OSError:
        if trash is not None:
            trash.rename(target)
        raise
    if trash is not None:
        shutil.rmtree(trash, ignore_errors=True)


def install(
    spec: TaggerModelSpec,
    model_dir: Path,
    *,
    token: str | None = None,
    progress: ProgressCallback | None = None,
    force: bool = False,
) -> Path:
    """安装（或重装）一个模型 bundle，返回最终目录。"""
    _private_directory(model_dir)
    if not force and installed(spec, model_dir):
        return bundle_path(model_dir, spec.key)

    target = bundle_path(model_dir, spec.key)
    staging = model_dir / f"{STAGING_PREFIX}{spec.key}"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    _private_directory(staging)
    try:
        for remote in spec.files:
            _download_to(
                spec.url_for(remote),
                staging / remote.name,
                remote.sha256,
                token,
                progress,
            )
        manifest = {
            "key": spec.key,
            "repo": str(spec.repo),
            "revision": spec.revision,
            "adapter": spec.adapter,
            "files": {remote.name: remote.sha256 for remote in spec.files},
        }
        _publish(staging, target, manifest)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return target


def install_by_key(key: str, model_dir: Path, **kwargs) -> Path:
    if key not in SPECS:
        raise KeyError(f"未登记的打标模型: {key}")
    return install(SPECS[key], model_dir, **kwargs)
