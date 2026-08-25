from __future__ import annotations

import importlib.util
import io
import json
import os
import tarfile
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "desktop_release", ROOT / "scripts" / "desktop_release.py"
)
assert SPEC and SPEC.loader
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def test_runtime_lock_has_pinned_supported_assets() -> None:
    lock = release.load_lock()

    assert lock["distribution"] == {
        "name": "python-build-standalone",
        "version": "20260807",
        "python_version": "3.13.15",
        "source": "https://github.com/astral-sh/python-build-standalone/releases/tag/20260807",
        "license": "MPL-2.0",
        "license_source": "https://github.com/astral-sh/python-build-standalone/blob/20260807/LICENSE",
    }
    assert set(lock["targets"]) == {"linux-x86_64", "windows-x86_64"}
    assert all(len(item["sha256"]) == 64 for item in lock["targets"].values())
    assert lock["optional_resources"] == {
        "dedup_models": False,
        "mihomo": False,
        "browser_runtime": False,
    }


def test_backend_projection_omits_the_duplicate_frontend(tmp_path: Path) -> None:
    app = tmp_path / "app"
    app.mkdir()

    release.copy_backend_sources(app)

    package = app / "gdl_backend"
    assert (package / "__main__.py").is_file()
    assert (package / "worker_entry.py").is_file()
    assert not (package / "webui_dist").exists()
    expected = {
        Path(item).relative_to("gallery-dl-backend").as_posix()
        for item in release.tracked_files(ROOT, "gallery-dl-backend/gdl_backend")
        if "webui_dist" not in Path(item).parts
    }
    actual = {
        item.relative_to(app).as_posix() for item in app.rglob("*") if item.is_file()
    }
    assert actual == expected


def test_safe_extract_rejects_parent_traversal(tmp_path: Path) -> None:
    archive = tmp_path / "runtime.tar.gz"
    with tarfile.open(archive, "w:gz") as bundle:
        entry = tarfile.TarInfo("../outside")
        payload = b"unsafe"
        entry.size = len(payload)
        bundle.addfile(entry, io.BytesIO(payload))

    with pytest.raises(release.ReleaseError, match="unsafe runtime archive member"):
        release.safe_extract(archive, tmp_path / "output")


def minimal_tree(root: Path) -> dict[str, object]:
    python = root / "runtime" / "python" / "bin" / "python3"
    python.parent.mkdir(parents=True)
    python.write_bytes(b"python")
    app = root / "app"
    (app / "gdl_backend").mkdir(parents=True)
    (app / "gdl_backend" / "worker_entry.py").write_text("", encoding="utf-8")
    (app / "dedup_review_worker.py").write_text("", encoding="utf-8")
    count, digest = release.write_file_manifest(root)
    manifest: dict[str, object] = {
        "schema_version": 1,
        "source_commit": "0" * 40,
        "target": "linux-x86_64",
        "runtime": {
            "python": "runtime/python/bin/python3",
            "archive_sha256": "1" * 64,
        },
        "files": {"path": release.FILES_NAME, "count": count, "sha256": digest},
    }
    (root / release.MANIFEST_NAME).write_text(
        json.dumps(manifest), encoding="utf-8"
    )
    return manifest


def test_tree_manifest_detects_tampering(tmp_path: Path) -> None:
    minimal_tree(tmp_path)
    assert release.verify_tree(tmp_path)["target"] == "linux-x86_64"

    (tmp_path / "app" / "dedup_review_worker.py").write_text("changed", encoding="utf-8")
    with pytest.raises(release.ReleaseError, match="release file mismatch"):
        release.verify_tree(tmp_path)


def test_file_manifest_records_relative_symlinks(tmp_path: Path) -> None:
    if os.name == "nt":
        pytest.skip("symlink creation is not guaranteed on Windows")
    target = tmp_path / "runtime" / "python3.13"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"python")
    os.symlink("python3.13", tmp_path / "runtime" / "python3")

    release.write_file_manifest(tmp_path)

    lines = (tmp_path / release.FILES_NAME).read_text(encoding="utf-8")
    assert "\tL\truntime/python3\n" in lines
