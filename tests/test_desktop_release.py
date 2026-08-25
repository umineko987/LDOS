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


def test_extract_deb_reads_data_archive_without_system_tools(tmp_path: Path) -> None:
    tar_payload = io.BytesIO()
    with tarfile.open(fileobj=tar_payload, mode="w:gz") as archive:
        content = b"canonical"
        member = tarfile.TarInfo("./usr/lib/imageweave/probe")
        member.size = len(content)
        archive.addfile(member, io.BytesIO(content))

    def ar_member(name: str, payload: bytes) -> bytes:
        header = (
            f"{name + '/':<16}{0:<12}{0:<6}{0:<6}"
            f"{'100644':<8}{len(payload):<10}`\n"
        ).encode("ascii")
        assert len(header) == 60
        return header + payload + (b"\n" if len(payload) % 2 else b"")

    bundle = tmp_path / "ImageWeave.deb"
    bundle.write_bytes(
        b"!<arch>\n"
        + ar_member("debian-binary", b"2.0\n")
        + ar_member("data.tar.gz", tar_payload.getvalue())
    )
    destination = tmp_path / "extracted"
    release.extract_deb(bundle, destination)

    assert (destination / "usr/lib/imageweave/probe").read_bytes() == b"canonical"


def test_linux_bundle_env_disables_linuxdeploy_strip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("NO_STRIP", raising=False)
    assert release.tauri_bundle_env("linux-x86_64")["NO_STRIP"] == "1"


def test_linux_wheel_libraries_get_relative_runtime_rpaths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock = release.load_lock()
    site_packages = tmp_path / "python" / "lib" / "python3.13" / "site-packages"
    torchvision = site_packages / "torchvision"
    torchvision.mkdir(parents=True)
    extensions = [torchvision / "_C.so", torchvision / "image.so"]
    for extension in extensions:
        extension.write_bytes(b"elf")
    libraries = []
    for name in ("opencv_python_headless.libs", "pillow.libs"):
        directory = site_packages / name
        directory.mkdir()
        library = directory / "library.so.1"
        library.write_bytes(b"elf")
        libraries.append(library)
    tkinter = site_packages.parent / "lib-dynload" / "_tkinter.cpython-313.so"
    tkinter.parent.mkdir()
    tkinter.write_bytes(b"elf")

    commands: list[list[str]] = []
    rpaths: dict[str, str] = {}

    def fake_run(command: object, **_kwargs: object) -> str:
        rendered = [os.fspath(item) for item in command]  # type: ignore[arg-type]
        commands.append(rendered)
        if rendered[1] == "--set-rpath":
            rpaths[rendered[3]] = rendered[2]
            return ""
        return rpaths.get(rendered[2], "")

    monkeypatch.setattr(release, "run", fake_run)
    release.make_linux_wheels_relocatable(tmp_path, lock, "linux-x86_64")

    expected: list[list[str]] = []
    for library in libraries:
        expected.extend(
            [
                ["patchelf", "--print-rpath", os.fspath(library)],
                ["patchelf", "--set-rpath", "$ORIGIN", os.fspath(library)],
                ["patchelf", "--print-rpath", os.fspath(library)],
            ]
        )
    expected.extend(
        [
            ["patchelf", "--set-rpath", "$ORIGIN/../..", os.fspath(tkinter)],
            ["patchelf", "--print-rpath", os.fspath(tkinter)],
        ]
    )
    for extension in extensions:
        expected.extend(
            [
                [
                    "patchelf",
                    "--set-rpath",
                    release.LINUX_TORCHVISION_RPATH,
                    os.fspath(extension),
                ],
                ["patchelf", "--print-rpath", os.fspath(extension)],
            ]
        )
    assert commands == expected

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


def test_bundle_tree_accepts_tauri_materialized_symlinks(tmp_path: Path) -> None:
    if os.name == "nt":
        pytest.skip("symlink creation is not guaranteed on Windows")
    minimal_tree(tmp_path)
    target = tmp_path / "runtime" / "alias-target"
    target.write_bytes(b"target bytes")
    link = tmp_path / "runtime" / "alias"
    os.symlink("alias-target", link)
    count, digest = release.write_file_manifest(tmp_path)
    manifest_path = tmp_path / release.MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"] = {"path": release.FILES_NAME, "count": count, "sha256": digest}
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    link.unlink()
    link.write_bytes(target.read_bytes())

    with pytest.raises(release.ReleaseError, match="release file mismatch"):
        release.verify_tree(tmp_path)
    release.verify_tree(tmp_path, allow_materialized_symlinks=True)


def use_test_frontend_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> bytes:
    canonical = tmp_path.parent / f"{tmp_path.name}-source" / "frontend-manifest.json"
    canonical.parent.mkdir()
    payload = b'{"schema_version":1}\n'
    canonical.write_bytes(payload)
    monkeypatch.setattr(release, "FRONTEND_MANIFEST", canonical)
    return payload


def test_bundle_tree_requires_one_runtime_and_canonical_frontend(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    frontend_payload = use_test_frontend_manifest(tmp_path, monkeypatch)
    backend = tmp_path / "usr" / "lib" / "imageweave" / "backend"
    backend.mkdir(parents=True)
    minimal_tree(backend)
    frontend = tmp_path / "usr" / "lib" / "imageweave" / "frontend-manifest.json"
    frontend.write_bytes(frontend_payload)
    monkeypatch.setattr(release, "verify_release_identity", lambda _manifest: None)

    result = release.verify_bundle_tree(tmp_path)

    assert result["backend_relative"] == "usr/lib/imageweave/backend"
    assert result["frontend_manifest_relative"] == (
        "usr/lib/imageweave/frontend-manifest.json"
    )


def test_bundle_tree_rejects_a_second_frontend(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    frontend_payload = use_test_frontend_manifest(tmp_path, monkeypatch)
    backend = tmp_path / "backend"
    backend.mkdir()
    minimal_tree(backend)
    (tmp_path / "frontend-manifest.json").write_bytes(frontend_payload)
    (tmp_path / "webui_dist").mkdir()
    monkeypatch.setattr(release, "verify_release_identity", lambda _manifest: None)

    with pytest.raises(release.ReleaseError, match="second frontend"):
        release.verify_bundle_tree(tmp_path)


def test_clean_checkout_guard_rejects_tracked_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(release, "run", lambda *_args, **_kwargs: " M tracked.py")

    with pytest.raises(release.ReleaseError, match="clean tracked checkout"):
        release.ensure_clean_tracked_checkout()
