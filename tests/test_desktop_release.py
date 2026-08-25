from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tarfile
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location(
    "desktop_release", ROOT / "scripts" / "desktop_release.py"
)
assert SPEC and SPEC.loader
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


@contextmanager
def temporary_path():
    with tempfile.TemporaryDirectory() as directory:
        yield Path(directory)


def minimal_tree(root: Path) -> dict[str, object]:
    python = root / "runtime" / "python" / "bin" / "python3"
    python.parent.mkdir(parents=True)
    python.write_bytes(b"python")
    app = root / "app"
    (app / "gdl_backend").mkdir(parents=True)
    (app / "gdl_backend" / "worker_entry.py").write_text("", encoding="utf-8")
    (app / "dedup_review_worker.py").write_text("", encoding="utf-8")
    licenses = root / "licenses"
    licenses.mkdir()
    (licenses / "test-license.txt").write_text("license\n", encoding="utf-8")
    (licenses / "THIRD-PARTY-NOTICES.md").write_text(
        "# notices\n", encoding="utf-8"
    )
    (licenses / "third-party-components.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "target": "linux-x86_64",
                "components": [
                    {
                        "ecosystem": "test",
                        "name": "dependency",
                        "version": "1",
                        "license": "MIT",
                        "source": "https://example.invalid/dependency",
                        "license_files": ["licenses/test-license.txt"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
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


def use_test_frontend_manifest(tmp_path: Path) -> tuple[Path, bytes]:
    canonical = tmp_path.parent / f"{tmp_path.name}-source" / "frontend-manifest.json"
    canonical.parent.mkdir()
    payload = b'{"schema_version":1}\n'
    canonical.write_bytes(payload)
    return canonical, payload


class DesktopReleaseTests(unittest.TestCase):
    def test_runtime_lock_has_pinned_supported_assets(self) -> None:
        lock = release.load_lock()

        self.assertEqual(
            lock["distribution"],
            {
                "name": "python-build-standalone",
                "version": "20260807",
                "python_version": "3.13.15",
                "source": "https://github.com/astral-sh/python-build-standalone/releases/tag/20260807",
                "license": "MPL-2.0",
                "license_source": "https://raw.githubusercontent.com/astral-sh/python-build-standalone/20260807/LICENSE",
                "license_sha256": "1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5",
                "python_license_sha256": "78b12c3a81360b357002334f0e70ea0e92eebf7a9b358805c03c48484945f3bb",
            },
        )
        self.assertEqual(set(lock["targets"]), {"linux-x86_64", "windows-x86_64"})
        self.assertTrue(
            all(
                len(item["sha256"]) == 64 and len(item["metadata_sha256"]) == 64
                for item in lock["targets"].values()
            )
        )
        self.assertEqual(
            lock["optional_resources"],
            {
                "dedup_models": False,
                "mihomo": False,
                "browser_runtime": False,
            },
        )

    def test_backend_projection_omits_the_duplicate_frontend(self) -> None:
        with temporary_path() as tmp_path:
            app = tmp_path / "app"
            app.mkdir()

            release.copy_backend_sources(app)

            package = app / "gdl_backend"
            self.assertTrue((package / "__main__.py").is_file())
            self.assertTrue((package / "worker_entry.py").is_file())
            self.assertFalse((package / "webui_dist").exists())
            expected = {
                Path(item).relative_to("gallery-dl-backend").as_posix()
                for item in release.tracked_files(
                    ROOT, "gallery-dl-backend/gdl_backend"
                )
                if "webui_dist" not in Path(item).parts
            }
            actual = {
                item.relative_to(app).as_posix()
                for item in app.rglob("*")
                if item.is_file()
            }
            self.assertEqual(actual, expected)

    def test_record_cleanup_removes_pruned_launchers_deterministically(self) -> None:
        with temporary_path() as tmp_path:
            runtime = tmp_path / "runtime"
            site_packages = (
                runtime / "python" / "lib" / "python3.13" / "site-packages"
            )
            package = site_packages / "demo"
            package.mkdir(parents=True)
            (package / "module.py").write_text("value = 1\n", encoding="utf-8")
            record = site_packages / "demo-1.0.dist-info" / "RECORD"
            record.parent.mkdir()
            record.write_bytes(
                b"../../../bin/pruned,sha256=random,1\r\n"
                b"demo/module.py,sha256=stable,10\r\n"
                b"demo-1.0.dist-info/RECORD,,\r\n"
            )

            release.remove_stale_record_entries(runtime)
            expected = (
                b"demo/module.py,sha256=stable,10\n"
                b"demo-1.0.dist-info/RECORD,,\n"
            )
            self.assertEqual(record.read_bytes(), expected)

            release.remove_stale_record_entries(runtime)
            self.assertEqual(record.read_bytes(), expected)

            record.write_text("../../../../../outside,,\n", encoding="utf-8")
            with self.assertRaisesRegex(
                release.ReleaseError, "unsafe installed RECORD path"
            ):
                release.remove_stale_record_entries(runtime)

    def test_safe_extract_rejects_parent_traversal(self) -> None:
        with temporary_path() as tmp_path:
            archive = tmp_path / "runtime.tar.gz"
            with tarfile.open(archive, "w:gz") as bundle:
                entry = tarfile.TarInfo("../outside")
                payload = b"unsafe"
                entry.size = len(payload)
                bundle.addfile(entry, io.BytesIO(payload))

            with self.assertRaisesRegex(
                release.ReleaseError, "unsafe runtime archive member"
            ):
                release.safe_extract(archive, tmp_path / "output")

    def test_extract_deb_reads_data_archive_without_system_tools(self) -> None:
        with temporary_path() as tmp_path:
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
                self.assertEqual(len(header), 60)
                return header + payload + (b"\n" if len(payload) % 2 else b"")

            bundle = tmp_path / "ImageWeave.deb"
            bundle.write_bytes(
                b"!<arch>\n"
                + ar_member("debian-binary", b"2.0\n")
                + ar_member("data.tar.gz", tar_payload.getvalue())
            )
            destination = tmp_path / "extracted"
            release.extract_deb(bundle, destination)

            self.assertEqual(
                (destination / "usr/lib/imageweave/probe").read_bytes(),
                b"canonical",
            )

    def test_linux_bundle_env_disables_linuxdeploy_strip(self) -> None:
        with mock.patch.dict(os.environ):
            os.environ.pop("NO_STRIP", None)
            self.assertEqual(release.tauri_bundle_env("linux-x86_64")["NO_STRIP"], "1")

    def test_linux_wheel_libraries_get_relative_runtime_rpaths(self) -> None:
        with temporary_path() as tmp_path:
            lock = release.load_lock()
            site_packages = (
                tmp_path / "python" / "lib" / "python3.13" / "site-packages"
            )
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

            with mock.patch.object(release, "run", side_effect=fake_run):
                release.make_linux_wheels_relocatable(
                    tmp_path, lock, "linux-x86_64"
                )

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
            self.assertEqual(commands, expected)

    def test_tree_manifest_detects_tampering(self) -> None:
        with temporary_path() as tmp_path:
            minimal_tree(tmp_path)
            self.assertEqual(release.verify_tree(tmp_path)["target"], "linux-x86_64")

            (tmp_path / "app" / "dedup_review_worker.py").write_text(
                "changed", encoding="utf-8"
            )
            with self.assertRaisesRegex(release.ReleaseError, "release file mismatch"):
                release.verify_tree(tmp_path)

    @unittest.skipIf(os.name == "nt", "symlink creation is not guaranteed on Windows")
    def test_file_manifest_records_relative_symlinks(self) -> None:
        with temporary_path() as tmp_path:
            target = tmp_path / "runtime" / "python3.13"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"python")
            os.symlink("python3.13", tmp_path / "runtime" / "python3")

            release.write_file_manifest(tmp_path)

            lines = (tmp_path / release.FILES_NAME).read_text(encoding="utf-8")
            self.assertIn("\tL\truntime/python3\n", lines)

    @unittest.skipIf(os.name == "nt", "symlink creation is not guaranteed on Windows")
    def test_bundle_tree_accepts_tauri_materialized_symlinks(self) -> None:
        with temporary_path() as tmp_path:
            minimal_tree(tmp_path)
            target = tmp_path / "runtime" / "alias-target"
            target.write_bytes(b"target bytes")
            link = tmp_path / "runtime" / "alias"
            os.symlink("alias-target", link)
            count, digest = release.write_file_manifest(tmp_path)
            manifest_path = tmp_path / release.MANIFEST_NAME
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["files"] = {
                "path": release.FILES_NAME,
                "count": count,
                "sha256": digest,
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            link.unlink()
            link.write_bytes(target.read_bytes())

            with self.assertRaisesRegex(release.ReleaseError, "release file mismatch"):
                release.verify_tree(tmp_path)
            release.verify_tree(tmp_path, allow_materialized_symlinks=True)

    def test_bundle_tree_requires_one_runtime_and_canonical_frontend(self) -> None:
        with temporary_path() as tmp_path:
            canonical, frontend_payload = use_test_frontend_manifest(tmp_path)
            backend = tmp_path / "usr" / "lib" / "imageweave" / "backend"
            backend.mkdir(parents=True)
            minimal_tree(backend)
            frontend = (
                tmp_path
                / "usr"
                / "lib"
                / "imageweave"
                / "frontend-manifest.json"
            )
            frontend.write_bytes(frontend_payload)

            with (
                mock.patch.object(release, "FRONTEND_MANIFEST", canonical),
                mock.patch.object(release, "verify_release_identity"),
            ):
                result = release.verify_bundle_tree(tmp_path)

            self.assertEqual(
                result["backend_relative"], "usr/lib/imageweave/backend"
            )
            self.assertEqual(
                result["frontend_manifest_relative"],
                "usr/lib/imageweave/frontend-manifest.json",
            )

    def test_bundle_tree_rejects_a_second_frontend(self) -> None:
        with temporary_path() as tmp_path:
            canonical, frontend_payload = use_test_frontend_manifest(tmp_path)
            backend = tmp_path / "backend"
            backend.mkdir()
            minimal_tree(backend)
            (tmp_path / "frontend-manifest.json").write_bytes(frontend_payload)
            (tmp_path / "webui_dist").mkdir()

            with (
                mock.patch.object(release, "FRONTEND_MANIFEST", canonical),
                mock.patch.object(release, "verify_release_identity"),
                self.assertRaisesRegex(release.ReleaseError, "second frontend"),
            ):
                release.verify_bundle_tree(tmp_path)

    def test_clean_checkout_guard_rejects_tracked_changes(self) -> None:
        with (
            mock.patch.object(release, "run", return_value=" M tracked.py"),
            self.assertRaisesRegex(release.ReleaseError, "clean tracked checkout"),
        ):
            release.ensure_clean_tracked_checkout()


if __name__ == "__main__":
    unittest.main()
