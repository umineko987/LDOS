#!/usr/bin/env python3
"""Assemble and verify the relocatable ImageWeave desktop Python backend."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
LOCK_PATH = ROOT / "desktop" / "release" / "runtime-lock.json"
DEFAULT_OUTPUT = ROOT / "desktop" / "src-tauri" / "release" / "backend"
RELEASE_BASE_URL = (
    "https://github.com/astral-sh/python-build-standalone/releases/download"
)
MANIFEST_NAME = "release-manifest.json"
FILES_NAME = "release-files.sha256"
LINUX_TORCHVISION_RPATH = (
    "$ORIGIN:$ORIGIN/../torchvision.libs:$ORIGIN/../torch/lib"
)
BACKEND_SOURCE = ROOT / "gallery-dl-backend" / "gdl_backend"
GALLERY_SOURCE = ROOT / "gallery-dl-codeberg"
FRONTEND_MANIFEST = (
    ROOT
    / "gallery-dl-backend"
    / "gdl_backend"
    / "webui_dist"
    / "frontend-manifest.json"
)


class ReleaseError(RuntimeError):
    pass


def run(
    command: Iterable[os.PathLike[str] | str],
    *,
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
    capture: bool = False,
) -> str:
    rendered = [os.fspath(item) for item in command]
    completed = subprocess.run(
        rendered,
        cwd=cwd,
        env=env,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if completed.returncode:
        detail = ""
        if capture:
            detail = f"\n{completed.stdout}{completed.stderr}".rstrip()
        raise ReleaseError(f"command failed ({completed.returncode}): {' '.join(rendered)}{detail}")
    return completed.stdout.strip() if capture else ""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def load_lock() -> dict[str, Any]:
    data = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    if data.get("schema_version") != 1:
        raise ReleaseError("unsupported runtime lock schema")
    for target, item in data.get("targets", {}).items():
        if not target or len(item.get("sha256", "")) != 64:
            raise ReleaseError(f"invalid runtime lock target: {target!r}")
    return data


def host_target() -> str:
    machine = platform.machine().lower()
    if machine not in {"x86_64", "amd64"}:
        raise ReleaseError(f"unsupported release host architecture: {machine}")
    if sys.platform.startswith("linux"):
        return "linux-x86_64"
    if os.name == "nt":
        return "windows-x86_64"
    raise ReleaseError(f"unsupported release host: {sys.platform}")


def default_cache_dir() -> Path:
    configured = os.environ.get("IMAGEWEAVE_RELEASE_CACHE")
    if configured:
        return Path(configured).expanduser().resolve()
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "imageweave" / "release"


def ensure_submodule() -> str:
    package = GALLERY_SOURCE / "gallery_dl" / "__init__.py"
    if not package.is_file():
        run(["git", "submodule", "update", "--init", "--recursive", "gallery-dl-codeberg"])
    expected_line = run(
        ["git", "ls-tree", "HEAD", "gallery-dl-codeberg"], capture=True
    )
    fields = expected_line.split()
    if len(fields) < 3 or fields[0] != "160000":
        raise ReleaseError("gallery-dl-codeberg is not a pinned git submodule")
    expected = fields[2]
    actual = run(["git", "rev-parse", "HEAD"], cwd=GALLERY_SOURCE, capture=True)
    dirty = run(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        cwd=GALLERY_SOURCE,
        capture=True,
    )
    if actual != expected or dirty:
        raise ReleaseError("gallery-dl-codeberg must be clean at the recorded gitlink")
    license_path = GALLERY_SOURCE / "LICENSE"
    if not license_path.is_file() or "GNU GENERAL PUBLIC LICENSE" not in license_path.read_text(
        encoding="utf-8"
    ):
        raise ReleaseError("gallery-dl GPL license evidence is missing")
    return actual


def download_runtime(lock: dict[str, Any], target: str, cache_dir: Path) -> Path:
    item = lock["targets"][target]
    archive = cache_dir / item["archive"]
    cache_dir.mkdir(parents=True, exist_ok=True)
    if archive.is_file() and sha256_file(archive) == item["sha256"]:
        return archive
    archive.unlink(missing_ok=True)
    url = f"{RELEASE_BASE_URL}/{lock['distribution']['version']}/{item['archive']}"
    temporary = archive.with_suffix(archive.suffix + ".part")
    temporary.unlink(missing_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "ImageWeave-release/1"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    actual = sha256_file(temporary)
    if actual != item["sha256"]:
        temporary.unlink(missing_ok=True)
        raise ReleaseError(
            f"runtime archive hash mismatch: expected {item['sha256']}, got {actual}"
        )
    os.replace(temporary, archive)
    return archive


def safe_extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            member_path = PurePosixPath(member.name)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise ReleaseError(f"unsafe runtime archive member: {member.name}")
            if member.issym():
                link_target = (destination / member.name).parent / member.linkname
            elif member.islnk():
                link_target = destination / member.linkname
            else:
                link_target = None
            if link_target is not None:
                resolved_link = link_target.resolve(strict=False)
                if root != resolved_link and root not in resolved_link.parents:
                    raise ReleaseError(f"unsafe runtime archive link: {member.name}")
            resolved = (destination / member.name).resolve(strict=False)
            if root != resolved and root not in resolved.parents:
                raise ReleaseError(f"runtime archive escapes destination: {member.name}")
        bundle.extractall(destination, filter="data")
    if not (destination / "python").is_dir():
        raise ReleaseError("runtime archive does not contain the expected python directory")


def controlled_env() -> dict[str, str]:
    env = dict(os.environ)
    env.pop("PYTHONHOME", None)
    env.pop("PYTHONPATH", None)
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    env["PIP_NO_INPUT"] = "1"
    return env


def install_requirements(
    python: Path, lock: dict[str, Any], staging: Path
) -> None:
    command: list[Path | str] = [
        python,
        "-I",
        "-m",
        "pip",
        "install",
        "--require-hashes",
        "--only-binary=:all:",
        "--no-cache-dir",
        "--no-compile",
    ]
    for relative in lock["requirements"]:
        command.extend(["-r", ROOT / relative])
    run(command, cwd=staging, env=controlled_env())

def make_linux_wheels_relocatable(
    runtime: Path, lock: dict[str, Any], target: str
) -> None:
    if not target.startswith("linux"):
        return
    python_version = ".".join(lock["distribution"]["python_version"].split(".")[:2])
    site_packages = runtime / "python" / "lib" / f"python{python_version}" / "site-packages"
    extensions = [site_packages / "torchvision" / name for name in ("_C.so", "image.so")]
    for extension in extensions:
        if not extension.is_file():
            raise ReleaseError(f"required torchvision extension is missing: {extension}")
        run(["patchelf", "--set-rpath", LINUX_TORCHVISION_RPATH, extension])
        actual = run(["patchelf", "--print-rpath", extension], capture=True)
        if actual != LINUX_TORCHVISION_RPATH:
            raise ReleaseError(f"failed to make torchvision extension relocatable: {extension}")


def remove_generated_launchers(runtime: Path, target: str) -> None:
    if target.startswith("linux"):
        bin_dir = runtime / "python" / "bin"
        keep = {"python", "python3", "python3.13"}
        for item in bin_dir.iterdir():
            if item.name not in keep:
                if item.is_dir() and not item.is_symlink():
                    shutil.rmtree(item)
                else:
                    item.unlink()
    else:
        shutil.rmtree(runtime / "python" / "Scripts", ignore_errors=True)


def remove_bytecode(root: Path) -> None:
    for path in root.rglob("*.pyc"):
        path.unlink()
    for path in sorted(root.rglob("__pycache__"), reverse=True):
        path.rmdir()


def tracked_files(repository: Path, pathspec: str) -> list[str]:
    output = subprocess.run(
        ["git", "ls-files", "-z", pathspec],
        cwd=repository,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    return [item.decode("utf-8") for item in output.split(b"\0") if item]


def copy_backend_sources(app: Path) -> None:
    destination = app / "gdl_backend"
    for relative in tracked_files(ROOT, "gallery-dl-backend/gdl_backend"):
        source = ROOT / relative
        package_relative = Path(relative).relative_to("gallery-dl-backend")
        if "webui_dist" in package_relative.parts:
            continue
        target = app / package_relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    if not (destination / "__main__.py").is_file():
        raise ReleaseError("backend source projection is incomplete")
    if (destination / "webui_dist").exists():
        raise ReleaseError("desktop backend must not contain a second frontend")


def copy_application_scripts(app: Path, lock: dict[str, Any]) -> None:
    for relative in lock["application_scripts"]:
        source = ROOT / relative
        if not source.is_file():
            raise ReleaseError(f"required application script is missing: {relative}")
        shutil.copy2(source, app / source.name)


def copy_gallery_source(app: Path) -> None:
    destination = app / "gallery-dl-codeberg"
    for relative in tracked_files(GALLERY_SOURCE, "gallery_dl") + ["LICENSE"]:
        source = GALLERY_SOURCE / relative
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    if not (destination / "gallery_dl" / "__init__.py").is_file():
        raise ReleaseError("gallery-dl source projection is incomplete")


def distribution_inventory(python: Path, app: Path) -> list[dict[str, str]]:
    code = """
import importlib.metadata as metadata, json
items = []
for dist in metadata.distributions():
    name = dist.metadata.get('Name')
    if name:
        items.append({'name': name, 'version': dist.version})
print(json.dumps(sorted(items, key=lambda x: x['name'].lower()), separators=(',', ':')))
"""
    env = controlled_env()
    result = run([python, "-I", "-B", "-c", code], cwd=app, env=env, capture=True)
    return json.loads(result)


def relative_entries(root: Path) -> list[Path]:
    return sorted(
        (
            path
            for path in root.rglob("*")
            if path.name not in {MANIFEST_NAME, FILES_NAME}
            and (path.is_symlink() or not path.is_dir())
        ),
        key=lambda value: value.relative_to(root).as_posix(),
    )


def entry_digest(path: Path, root: Path) -> tuple[str, str]:
    if path.is_symlink():
        target = os.readlink(path)
        parsed = PurePosixPath(target.replace(os.sep, "/"))
        resolved = (path.parent / target).resolve(strict=False)
        trusted_root = root.resolve()
        if parsed.is_absolute() or (
            trusted_root != resolved and trusted_root not in resolved.parents
        ):
            raise ReleaseError(f"unsafe release symlink: {path} -> {target}")
        return "L", sha256_bytes(target.encode("utf-8"))
    if not path.is_file():
        raise ReleaseError(f"unsupported release tree entry: {path}")
    return "F", sha256_file(path)


def write_file_manifest(root: Path) -> tuple[int, str]:
    lines: list[str] = []
    for path in relative_entries(root):
        kind, digest = entry_digest(path, root)
        relative = path.relative_to(root).as_posix()
        if "\n" in relative or "\t" in relative:
            raise ReleaseError(f"unsupported release path: {relative!r}")
        lines.append(f"{digest}\t{kind}\t{relative}\n")
    payload = "".join(lines).encode("utf-8")
    (root / FILES_NAME).write_bytes(payload)
    return len(lines), sha256_bytes(payload)


def source_commit() -> str:
    return run(["git", "rev-parse", "HEAD"], capture=True)


def ensure_clean_tracked_checkout() -> None:
    status = run(
        ["git", "status", "--porcelain", "--untracked-files=no"], capture=True
    )
    if status:
        raise ReleaseError("desktop release assembly requires a clean tracked checkout")


def write_release_manifest(
    staging: Path,
    lock: dict[str, Any],
    target: str,
    gallery_commit: str,
    archive: Path,
) -> None:
    python_relative = lock["targets"][target]["python"]
    python = staging / python_relative
    requirements = {
        relative: sha256_file(ROOT / relative) for relative in lock["requirements"]
    }
    packages = distribution_inventory(python, staging / "app")
    count, files_hash = write_file_manifest(staging)
    manifest = {
        "schema_version": 1,
        "source_commit": source_commit(),
        "target": target,
        "tauri_target": lock["targets"][target]["tauri_target"],
        "runtime": {
            **lock["distribution"],
            "archive": archive.name,
            "archive_sha256": sha256_file(archive),
            "python": python_relative,
        },
        "python_packages": packages,
        "requirements_sha256": requirements,
        "gallery_dl": {
            "source": "https://codeberg.org/mikf/gallery-dl",
            "commit": gallery_commit,
            "license": "GPL-2.0-only",
            "license_sha256": sha256_file(GALLERY_SOURCE / "LICENSE"),
        },
        "application": {
            "backend": "app/gdl_backend",
            "worker": "-m gdl_backend.worker_entry",
            "dedup_worker": "app/dedup_review_worker.py",
            "dedup_core": "app/dedup_core.py",
        },
        "optional_resources": lock["optional_resources"],
        "files": {
            "path": FILES_NAME,
            "count": count,
            "sha256": files_hash,
        },
    }
    (staging / MANIFEST_NAME).write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def scan_for_local_paths(root: Path, forbidden: Iterable[Path]) -> None:
    needles = {os.fspath(path.resolve()).encode() for path in forbidden}
    needles.update(
        {
            b"-----BEGIN PRIVATE KEY-----",
            b"-----BEGIN OPENSSH PRIVATE KEY-----",
        }
    )
    secret_patterns = (
        re.compile(rb"aws_access_key_id[\"'\s:=]+AKIA[0-9A-Z]{16}", re.IGNORECASE),
        re.compile(rb"ghp_[A-Za-z0-9]{36}"),
        re.compile(rb"github_pat_[A-Za-z0-9_]{50,}"),
    )
    for path in relative_entries(root) + [root / MANIFEST_NAME, root / FILES_NAME]:
        if path.is_symlink() or path.stat().st_size > 16 * 1024 * 1024:
            continue
        data = path.read_bytes()
        for needle in needles:
            if needle and needle in data:
                raise ReleaseError(f"forbidden local path or private key in {path.relative_to(root)}")
        if any(pattern.search(data) for pattern in secret_patterns):
            raise ReleaseError(f"possible credential in {path.relative_to(root)}")


def verify_tree(root: Path, *, forbidden_paths: Iterable[Path] = ()) -> dict[str, Any]:
    manifest_path = root / MANIFEST_NAME
    files_path = root / FILES_NAME
    if not manifest_path.is_file() or not files_path.is_file():
        raise ReleaseError("release manifest is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected_files_hash = manifest["files"]["sha256"]
    if sha256_file(files_path) != expected_files_hash:
        raise ReleaseError("release file manifest hash mismatch")
    seen: set[str] = set()
    for line in files_path.read_text(encoding="utf-8").splitlines():
        fields = line.split("\t", 2)
        if len(fields) != 3:
            raise ReleaseError("malformed release file manifest")
        expected, kind, relative = fields
        parsed = PurePosixPath(relative)
        if parsed.is_absolute() or ".." in parsed.parts or relative in seen:
            raise ReleaseError(f"unsafe or duplicate manifest path: {relative}")
        seen.add(relative)
        path = root.joinpath(*parsed.parts)
        actual_kind, actual = entry_digest(path, root)
        if kind != actual_kind or expected != actual:
            raise ReleaseError(f"release file mismatch: {relative}")
    actual_entries = {
        path.relative_to(root).as_posix() for path in relative_entries(root)
    }
    if actual_entries != seen:
        difference = sorted(actual_entries.symmetric_difference(seen))[:5]
        raise ReleaseError(f"unmanifested release entries: {difference}")
    if len(seen) != manifest["files"]["count"]:
        raise ReleaseError("release file count mismatch")
    python = root / manifest["runtime"]["python"]
    if not python.is_file():
        raise ReleaseError("controlled Python executable is missing")
    app = root / "app"
    if not (app / "gdl_backend" / "worker_entry.py").is_file():
        raise ReleaseError("backend worker package is missing")
    if not (app / "dedup_review_worker.py").is_file():
        raise ReleaseError("dedup worker is missing")
    if (app / "gdl_backend" / "webui_dist").exists():
        raise ReleaseError("release tree contains a second frontend")
    forbidden_suffixes = {".pt", ".onnx", ".ckpt", ".safetensors"}
    if any(
        path.suffix.lower() in forbidden_suffixes
        for path in app.rglob("*")
    ):
        raise ReleaseError("unlocked application model resource found in release tree")
    forbidden_names = {"mihomo", "mihomo.exe", "chrome", "chrome.exe"}
    if any(path.name.lower() in forbidden_names for path in root.rglob("*")):
        raise ReleaseError("unlocked optional binary found in release tree")
    scan_for_local_paths(root, forbidden_paths)
    return manifest


def verify_release_identity(manifest: dict[str, Any]) -> None:
    lock = load_lock()
    target = manifest.get("target")
    if target not in lock["targets"]:
        raise ReleaseError("release manifest target is not locked")
    expected_target = lock["targets"][target]
    runtime = manifest.get("runtime", {})
    if (
        manifest.get("source_commit") != source_commit()
        or manifest.get("tauri_target") != expected_target["tauri_target"]
        or runtime.get("archive") != expected_target["archive"]
        or runtime.get("archive_sha256") != expected_target["sha256"]
        or runtime.get("python") != expected_target["python"]
    ):
        raise ReleaseError("release manifest does not match the tracked source and runtime lock")
    expected_requirements = {
        relative: sha256_file(ROOT / relative) for relative in lock["requirements"]
    }
    if manifest.get("requirements_sha256") != expected_requirements:
        raise ReleaseError("release requirements no longer match the assembled tree")
    gitlink = run(
        ["git", "ls-tree", "HEAD", "gallery-dl-codeberg"], capture=True
    ).split()
    if (
        len(gitlink) < 3
        or gitlink[0] != "160000"
        or manifest.get("gallery_dl", {}).get("commit") != gitlink[2]
    ):
        raise ReleaseError("release gallery-dl source no longer matches the tracked gitlink")


def _runtime_environment(root: Path, data_root: Path, python: Path) -> dict[str, str]:
    env = controlled_env()
    env.update(
        {
            "IMAGEWEAVE_DESKTOP_DISTRIBUTION": "1",
            "IMAGEWEAVE_DESKTOP_RESOURCE_ROOT": os.fspath(root),
            "IMAGEWEAVE_DESKTOP_DATA_ROOT": os.fspath(data_root),
            "IMAGEWEAVE_DESKTOP_PYTHON": os.fspath(python),
        }
    )
    return env


def _free_loopback_port() -> int:
    family = socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _http_json(
    opener: urllib.request.OpenerDirector, url: str, accepted: set[int]
) -> tuple[int, dict[str, Any]]:
    try:
        response = opener.open(url, timeout=1)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        status = int(response.status)
        payload = json.loads(response.read().decode("utf-8"))
    if status not in accepted or not isinstance(payload, dict):
        raise ReleaseError(f"unexpected HTTP response from {url}: {status}")
    return status, payload


def verify_runtime(root: Path) -> dict[str, Any]:
    root = root.resolve()
    manifest = verify_tree(root, forbidden_paths=[ROOT, Path.home()])
    verify_release_identity(manifest)
    python = root / manifest["runtime"]["python"]
    app = root / "app"
    with tempfile.TemporaryDirectory(prefix="imageweave-runtime-smoke-") as temporary:
        temporary_root = Path(temporary)
        data_root = temporary_root / "data"
        config_root = temporary_root / "config"
        data_root.mkdir()
        config_root.mkdir()
        env = _runtime_environment(root, data_root, python)
        import_code = """
import json, os, sys
import cv2, fastapi, PIL, torch, torchvision, uvicorn
import dedup_core, dedup_review_worker, gdl_backend
expected = os.environ['IMAGEWEAVE_DESKTOP_PYTHON']
if not os.path.samefile(sys.executable, expected):
    raise SystemExit('unexpected runtime interpreter')
print(json.dumps({
    'python': sys.version.split()[0],
    'torch': torch.__version__,
    'torchvision': torchvision.__version__,
    'cuda': bool(torch.cuda.is_available()),
}, sort_keys=True))
"""
        import_result = json.loads(
            run(
                [python, "-B", "-c", import_code],
                cwd=app,
                env=env,
                capture=True,
            )
        )
        if import_result["cuda"]:
            raise ReleaseError("controlled CPU runtime unexpectedly exposes CUDA")
        gallery_version = run(
            [
                python,
                "-B",
                "-m",
                "gdl_backend.worker_entry",
                "--marker",
                "release-smoke",
                "--gallery-root",
                app / "gallery-dl-codeberg",
                "--",
                "--version",
            ],
            cwd=app,
            env=env,
            capture=True,
        )
        run(
            [python, "-B", app / "dedup_review_worker.py", "--help"],
            cwd=app,
            env=env,
            capture=True,
        )

        port = _free_loopback_port()
        config_path = config_root / "backend.json"
        config_path.write_text(
            json.dumps(
                {
                    "runtime_dir": "/stale/runtime",
                    "database_path": "/stale/backend.sqlite3",
                    "server": {"host": "127.0.0.1", "port": port},
                    "gallery": {"python_executable": "/stale/python"},
                    "proxy": {"enabled": False, "auto_start": False},
                    "dedup": {"enabled": False, "python_executable": "/stale/python"},
                }
            )
            + "\n",
            encoding="utf-8",
        )
        env["GDL_BACKEND_PARENT_PIPE"] = "1"
        log_path = temporary_root / "backend.log"
        with log_path.open("w+b") as log:
            process = subprocess.Popen(
                [python, "-B", "-m", "gdl_backend", "--config", config_path],
                cwd=app,
                env=env,
                stdin=subprocess.PIPE,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            try:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                deadline = time.monotonic() + 30
                health: dict[str, Any] | None = None
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        break
                    try:
                        _, health = _http_json(
                            opener, f"http://127.0.0.1:{port}/healthz", {200}
                        )
                        break
                    except (
                        OSError,
                        UnicodeError,
                        json.JSONDecodeError,
                        ReleaseError,
                    ):
                        time.sleep(0.1)
                if health is None or health.get("ok") is not True:
                    raise ReleaseError("packaged FastAPI did not reach healthz")
                ready_status, _ = _http_json(
                    opener, f"http://127.0.0.1:{port}/readyz", {200, 503}
                )
                _, root_payload = _http_json(
                    opener, f"http://127.0.0.1:{port}/", {200}
                )
                if root_payload.get("ui", "missing") is not None:
                    raise ReleaseError("desktop backend exposed a second frontend")
                try:
                    opener.open(f"http://127.0.0.1:{port}/ui/", timeout=1)
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
                else:
                    raise ReleaseError("desktop backend mounted /ui unexpectedly")
            except Exception as error:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=10)
                log.flush()
                detail = log_path.read_text(encoding="utf-8", errors="replace")
                raise ReleaseError(f"packaged FastAPI smoke failed: {error}\n{detail}") from error
            if process.stdin is None:
                raise ReleaseError("parent pipe was not created")
            process.stdin.close()
            try:
                return_code = process.wait(timeout=20)
            except subprocess.TimeoutExpired as error:
                process.kill()
                process.wait(timeout=10)
                raise ReleaseError("packaged FastAPI ignored parent-pipe shutdown") from error
            if return_code != 0:
                log.flush()
                detail = log_path.read_text(encoding="utf-8", errors="replace")
                raise ReleaseError(f"packaged FastAPI shutdown failed ({return_code})\n{detail}")
    return {
        "target": manifest["target"],
        "python_sha256": sha256_file(python),
        "python_version": import_result["python"],
        "torch_version": import_result["torch"],
        "torchvision_version": import_result["torchvision"],
        "gallery_version": gallery_version.strip(),
        "readyz_status": ready_status,
        "files_sha256": manifest["files"]["sha256"],
    }


def extract_bundle(bundle: Path, destination: Path) -> Path:
    bundle = bundle.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    lower_name = bundle.name.lower()
    if lower_name.endswith(".deb"):
        run(["dpkg-deb", "-x", bundle, destination])
    elif lower_name.endswith(".appimage"):
        if os.name == "nt":
            raise ReleaseError("AppImage extraction requires Linux")
        bundle.chmod(bundle.stat().st_mode | stat.S_IXUSR)
        run([bundle, "--appimage-extract"], cwd=destination, capture=True)
    elif lower_name.endswith(".exe"):
        seven_zip = shutil.which("7z") or shutil.which("7z.exe")
        if seven_zip is None:
            raise ReleaseError("7z is required to inspect an NSIS installer")
        run([seven_zip, "x", "-y", f"-o{destination}", bundle], capture=True)
        nested_archives = sorted(destination.rglob("*.7z"))
        for index, archive in enumerate(nested_archives):
            nested = destination / f"nested-{index}"
            run([seven_zip, "x", "-y", f"-o{nested}", archive], capture=True)
    else:
        raise ReleaseError(f"unsupported desktop bundle: {bundle.name}")
    return destination


def verify_bundle_tree(extracted: Path) -> dict[str, Any]:
    release_manifests = sorted(extracted.rglob(MANIFEST_NAME))
    if len(release_manifests) != 1:
        raise ReleaseError(
            f"bundle must contain one backend release manifest, found {len(release_manifests)}"
        )
    backend = release_manifests[0].parent
    manifest = verify_tree(backend, forbidden_paths=[ROOT, Path.home()])
    verify_release_identity(manifest)
    frontend_manifests = sorted(extracted.rglob(FRONTEND_MANIFEST.name))
    if len(frontend_manifests) != 1:
        raise ReleaseError(
            f"bundle must contain one frontend manifest, found {len(frontend_manifests)}"
        )
    canonical_frontend = FRONTEND_MANIFEST.read_bytes()
    if frontend_manifests[0].read_bytes() != canonical_frontend:
        raise ReleaseError("bundled frontend manifest differs from the canonical Svelte build")
    if any(path.name == "webui_dist" for path in extracted.rglob("webui_dist")):
        raise ReleaseError("bundle contains a second frontend tree")
    runtime_roots = [path for path in extracted.rglob("runtime") if path.parent == backend]
    if runtime_roots != [backend / "runtime"]:
        raise ReleaseError("bundle does not contain exactly one controlled Python runtime")
    return {
        "target": manifest["target"],
        "backend_relative": backend.relative_to(extracted).as_posix(),
        "frontend_manifest_relative": frontend_manifests[0]
        .relative_to(extracted)
        .as_posix(),
        "frontend_manifest_sha256": sha256_bytes(canonical_frontend),
        "files_sha256": manifest["files"]["sha256"],
    }


def verify_bundle(bundle: Path) -> dict[str, Any]:
    if not bundle.is_file():
        raise ReleaseError(f"desktop bundle is missing: {bundle}")
    with tempfile.TemporaryDirectory(prefix="imageweave-bundle-") as temporary:
        extracted = extract_bundle(bundle, Path(temporary))
        result = verify_bundle_tree(extracted)
    result["bundle"] = bundle.name
    result["bundle_sha256"] = sha256_file(bundle)
    return result

def assemble(target: str, output: Path, cache_dir: Path) -> dict[str, Any]:
    ensure_clean_tracked_checkout()
    lock = load_lock()
    if target not in lock["targets"]:
        raise ReleaseError(f"unknown target: {target}")
    if target != host_target():
        raise ReleaseError(f"{target} runtime assembly must run on a matching host")
    gallery_commit = ensure_submodule()
    archive = download_runtime(lock, target, cache_dir)
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.{target}.", dir=output.parent))
    try:
        safe_extract(archive, staging / "runtime")
        python = staging / lock["targets"][target]["python"]
        if not python.is_file():
            raise ReleaseError(f"runtime Python is missing: {python}")
        if os.name != "nt":
            python.chmod(python.stat().st_mode | stat.S_IXUSR)
        install_requirements(python, lock, staging)
        make_linux_wheels_relocatable(staging / "runtime", lock, target)
        remove_generated_launchers(staging / "runtime", target)
        remove_bytecode(staging / "runtime")
        app = staging / "app"
        app.mkdir()
        copy_backend_sources(app)
        copy_application_scripts(app, lock)
        copy_gallery_source(app)
        licenses = staging / "licenses"
        licenses.mkdir()
        shutil.copy2(ROOT / "LICENSE", licenses / "ImageWeave-MIT.txt")
        shutil.copy2(GALLERY_SOURCE / "LICENSE", licenses / "gallery-dl-GPL-2.0.txt")
        write_release_manifest(staging, lock, target, gallery_commit, archive)
        staged_manifest = verify_tree(
            staging, forbidden_paths=[ROOT, staging, Path.home()]
        )
        verify_release_identity(staged_manifest)
        if output.exists():
            shutil.rmtree(output)
        os.replace(staging, output)
        output_manifest = verify_tree(
            output, forbidden_paths=[ROOT, staging, Path.home()]
        )
        verify_release_identity(output_manifest)
        return output_manifest
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def build_release(cache_dir: Path) -> dict[str, Any]:
    ensure_clean_tracked_checkout()
    desktop = ROOT / "desktop"
    npm = "npm.cmd" if os.name == "nt" else "npm"
    run([npm, "ci"], cwd=desktop)
    run([npm, "run", "build"], cwd=desktop)
    run([npm, "run", "verify:artifacts"], cwd=desktop)
    target = host_target()
    assemble(target, DEFAULT_OUTPUT, cache_dir)
    runtime_result = verify_runtime(DEFAULT_OUTPUT)
    tauri = desktop / "src-tauri"
    run(["cargo", "fmt", "--check"], cwd=tauri)
    run(["cargo", "test"], cwd=tauri)
    run([npm, "run", "tauri", "--", "build", "--ci"], cwd=desktop)
    bundle_root = tauri / "target" / "release" / "bundle"
    patterns = (
        ("deb/*.deb", "appimage/*.AppImage")
        if target == "linux-x86_64"
        else ("nsis/*.exe",)
    )
    bundles: list[Path] = []
    for pattern in patterns:
        matches = sorted(bundle_root.glob(pattern))
        if len(matches) != 1:
            raise ReleaseError(
                f"expected one {pattern} bundle, found {len(matches)}"
            )
        bundles.extend(matches)
    bundle_results = [verify_bundle(bundle) for bundle in bundles]
    ensure_clean_tracked_checkout()
    return {
        "target": target,
        "runtime": runtime_result,
        "bundles": bundle_results,
    }

def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    assemble_parser = subparsers.add_parser("assemble")
    assemble_parser.add_argument("--target", default=host_target())
    assemble_parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    assemble_parser.add_argument("--cache-dir", type=Path, default=default_cache_dir())
    build_parser = subparsers.add_parser("build")
    build_parser.add_argument("--cache-dir", type=Path, default=default_cache_dir())
    verify_parser = subparsers.add_parser("verify-tree")
    verify_parser.add_argument("--tree", type=Path, default=DEFAULT_OUTPUT)
    runtime_parser = subparsers.add_parser("verify-runtime")
    runtime_parser.add_argument("--tree", type=Path, default=DEFAULT_OUTPUT)
    bundle_parser = subparsers.add_parser("verify-bundle")
    bundle_parser.add_argument("--bundle", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        if args.command not in {"assemble", "build"}:
            ensure_clean_tracked_checkout()
        if args.command == "assemble":
            manifest = assemble(args.target, args.output, args.cache_dir)
            result = {
                "target": manifest["target"],
                "source_commit": manifest["source_commit"],
                "runtime_archive_sha256": manifest["runtime"]["archive_sha256"],
                "files_sha256": manifest["files"]["sha256"],
            }
        elif args.command == "build":
            result = build_release(args.cache_dir)
        elif args.command == "verify-tree":
            manifest = verify_tree(
                args.tree.resolve(), forbidden_paths=[ROOT, Path.home()]
            )
            verify_release_identity(manifest)
            result = {
                "target": manifest["target"],
                "source_commit": manifest["source_commit"],
                "runtime_archive_sha256": manifest["runtime"]["archive_sha256"],
                "files_sha256": manifest["files"]["sha256"],
            }
        elif args.command == "verify-runtime":
            result = verify_runtime(args.tree)
        else:
            result = verify_bundle(args.bundle)
    except (OSError, ValueError, KeyError, ReleaseError, subprocess.SubprocessError) as exc:
        print(f"desktop release error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"status": "ok", **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
