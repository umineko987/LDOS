#!/usr/bin/env python3
"""Build artifact sync and byte-for-byte release verification for the desktop UI."""

from __future__ import annotations

import argparse
import base64
import csv
import io
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path, PurePosixPath


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DIST_ROOT = REPOSITORY_ROOT / "desktop" / "dist"
BACKEND_ROOT = REPOSITORY_ROOT / "gallery-dl-backend" / "gdl_backend" / "webui_dist"
TAURI_CONFIG = REPOSITORY_ROOT / "desktop" / "src-tauri" / "tauri.conf.json"
MANIFEST_NAME = "frontend-manifest.json"
WHEEL_PREFIX = "gdl_backend/webui_dist/"


class ArtifactError(RuntimeError):
    """Raised when canonical frontend artifacts diverge."""


def _sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _regular_files(root: Path) -> tuple[Path, ...]:
    if not root.is_dir():
        raise ArtifactError(f"missing_directory:{root.relative_to(REPOSITORY_ROOT)}")
    files: list[Path] = []
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ArtifactError(f"symlink_not_allowed:{path.relative_to(root).as_posix()}")
        if path.is_file():
            files.append(path)
    return tuple(sorted(files, key=lambda path: path.relative_to(root).as_posix()))


def _relative_files(root: Path, *, include_manifest: bool = True) -> tuple[str, ...]:
    return tuple(
        path.relative_to(root).as_posix()
        for path in _regular_files(root)
        if include_manifest or path.name != MANIFEST_NAME
    )


def _entry(root: Path, relative: str) -> dict[str, object]:
    content = (root / relative).read_bytes()
    return {
        "path": relative,
        "sha256": _sha256_bytes(content),
        "size": len(content),
    }


def _write_manifest(root: Path) -> None:
    manifest_path = root / MANIFEST_NAME
    manifest_path.unlink(missing_ok=True)
    files = _relative_files(root, include_manifest=False)
    if "index.html" not in files:
        raise ArtifactError("missing_entrypoint:index.html")
    payload = {
        "build_source": "desktop",
        "entrypoint": "index.html",
        "files": [_entry(root, relative) for relative in files],
        "schema_version": 1,
    }
    manifest_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _normalize_generated_bytes(path: Path, content: bytes) -> bytes:
    if path.suffix not in {".css", ".js"}:
        return content
    text = content.decode("utf-8")
    return "\n".join(line.rstrip() for line in text.splitlines()).encode("utf-8") + b"\n"


def _normalize_generated_files(root: Path) -> None:
    for path in _regular_files(root):
        content = path.read_bytes()
        normalized = _normalize_generated_bytes(path, content)
        if normalized != content:
            path.write_bytes(normalized)


def _load_manifest(root: Path) -> dict[str, object]:
    manifest_path = root / MANIFEST_NAME
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ArtifactError(f"invalid_manifest:{root.relative_to(REPOSITORY_ROOT)}") from error
    if not isinstance(payload, dict):
        raise ArtifactError("invalid_manifest_root")
    if payload.get("schema_version") != 1:
        raise ArtifactError("invalid_manifest_schema")
    if payload.get("build_source") != "desktop" or payload.get("entrypoint") != "index.html":
        raise ArtifactError("invalid_manifest_identity")
    return payload


def _validate_relative_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ArtifactError("invalid_manifest_path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or value != path.as_posix():
        raise ArtifactError(f"invalid_manifest_path:{value}")
    return value


def _verify_manifest(root: Path) -> tuple[str, ...]:
    payload = _load_manifest(root)
    raw_entries = payload.get("files")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise ArtifactError("invalid_manifest_files")

    expected: list[str] = []
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict):
            raise ArtifactError("invalid_manifest_entry")
        relative = _validate_relative_path(raw_entry.get("path"))
        if relative == MANIFEST_NAME or relative in expected:
            raise ArtifactError(f"duplicate_manifest_path:{relative}")
        path = root / relative
        if not path.is_file() or path.is_symlink():
            raise ArtifactError(f"missing_manifest_file:{relative}")
        content = path.read_bytes()
        if raw_entry.get("size") != len(content):
            raise ArtifactError(f"size_mismatch:{relative}")
        if raw_entry.get("sha256") != _sha256_bytes(content):
            raise ArtifactError(f"hash_mismatch:{relative}")
        expected.append(relative)

    actual = _relative_files(root, include_manifest=False)
    if tuple(expected) != actual:
        raise ArtifactError("manifest_inventory_mismatch")
    if "index.html" not in actual:
        raise ArtifactError("missing_entrypoint:index.html")
    if not any(path.endswith(".js") for path in actual):
        raise ArtifactError("missing_javascript_bundle")
    if not any(path.endswith(".css") for path in actual):
        raise ArtifactError("missing_stylesheet_bundle")
    return tuple(sorted((MANIFEST_NAME, *actual)))


def _tree_hash(root: Path, files: tuple[str, ...]) -> str:
    digest = hashlib.sha256()
    for relative in files:
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update((root / relative).read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _verify_tauri_input() -> None:
    try:
        config = json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))
        configured = config["build"]["frontendDist"]
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise ArtifactError("invalid_tauri_frontend_dist") from error
    if not isinstance(configured, str):
        raise ArtifactError("invalid_tauri_frontend_dist")
    resolved = (TAURI_CONFIG.parent / configured).resolve()
    if resolved != DIST_ROOT.resolve():
        raise ArtifactError("tauri_frontend_dist_is_not_desktop_dist")


def _verify_copies() -> dict[str, object]:
    _verify_tauri_input()
    dist_files = _verify_manifest(DIST_ROOT)
    backend_files = _verify_manifest(BACKEND_ROOT)
    if dist_files != backend_files:
        raise ArtifactError("frontend_inventory_mismatch")
    for relative in dist_files:
        if (DIST_ROOT / relative).read_bytes() != (BACKEND_ROOT / relative).read_bytes():
            raise ArtifactError(f"frontend_byte_mismatch:{relative}")
    return {
        "file_count": len(dist_files),
        "manifest_sha256": _sha256_bytes((DIST_ROOT / MANIFEST_NAME).read_bytes()),
        "tree_sha256": _tree_hash(DIST_ROOT, dist_files),
    }


def _wheel_record(wheel: zipfile.ZipFile, names: set[str]) -> dict[str, tuple[str, str]]:
    record_names = [name for name in names if name.endswith(".dist-info/RECORD")]
    if len(record_names) != 1:
        raise ArtifactError("invalid_wheel_record_inventory")
    try:
        text = wheel.read(record_names[0]).decode("utf-8")
        rows = tuple(csv.reader(io.StringIO(text, newline="")))
    except (KeyError, UnicodeError, csv.Error) as error:
        raise ArtifactError("invalid_wheel_record") from error
    record: dict[str, tuple[str, str]] = {}
    for row in rows:
        if len(row) != 3 or not row[0] or row[0] in record:
            raise ArtifactError("invalid_wheel_record")
        record[row[0]] = (row[1], row[2])
    return record


def _record_digest(content: bytes) -> str:
    encoded = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode("ascii")
    return f"sha256={encoded}"


def _verify_wheel(wheel_path: Path, expected_files: tuple[str, ...]) -> None:
    if not wheel_path.is_file():
        raise ArtifactError(f"missing_wheel:{wheel_path}")
    try:
        with zipfile.ZipFile(wheel_path) as wheel:
            members = wheel.namelist()
            names = set(members)
            if len(names) != len(members):
                raise ArtifactError("duplicate_wheel_member")
            wheel_files = tuple(
                sorted(name.removeprefix(WHEEL_PREFIX) for name in names if name.startswith(WHEEL_PREFIX) and not name.endswith("/"))
            )
            if wheel_files != expected_files:
                raise ArtifactError("wheel_frontend_inventory_mismatch")
            record = _wheel_record(wheel, names)
            for relative in expected_files:
                wheel_name = f"{WHEEL_PREFIX}{relative}"
                content = wheel.read(wheel_name)
                if content != (BACKEND_ROOT / relative).read_bytes():
                    raise ArtifactError(f"wheel_frontend_byte_mismatch:{relative}")
                row = record.get(wheel_name)
                if row is None:
                    raise ArtifactError(f"wheel_record_missing:{relative}")
                digest, size = row
                if digest != _record_digest(content) or size != str(len(content)):
                    raise ArtifactError(f"wheel_record_mismatch:{relative}")
    except zipfile.BadZipFile as error:
        raise ArtifactError("invalid_wheel") from error


def sync() -> dict[str, object]:
    _normalize_generated_files(DIST_ROOT)
    _write_manifest(DIST_ROOT)
    if BACKEND_ROOT.exists():
        shutil.rmtree(BACKEND_ROOT)
    shutil.copytree(DIST_ROOT, BACKEND_ROOT, copy_function=shutil.copy2)
    return _verify_copies()


def verify(wheel: Path | None = None) -> dict[str, object]:
    result = _verify_copies()
    if wheel is not None:
        expected_files = _verify_manifest(BACKEND_ROOT)
        _verify_wheel(wheel.resolve(), expected_files)
        result["wheel"] = str(wheel)
    return result


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("sync", "verify"))
    parser.add_argument("--wheel", type=Path, help="also compare a built wheel with the canonical frontend bytes")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        if args.command == "sync":
            if args.wheel is not None:
                raise ArtifactError("wheel_not_supported_for_sync")
            result = sync()
        else:
            result = verify(args.wheel)
    except ArtifactError as error:
        print(f"frontend_artifact_error:{error}", file=sys.stderr)
        return 1
    print(json.dumps({"status": "ok", **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
