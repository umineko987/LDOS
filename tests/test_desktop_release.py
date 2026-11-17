from __future__ import annotations

import gzip
import importlib.util
import io
import json
import os
import shlex
import struct
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
    python = root / "runtime" / "python" / "bin" / "python3.13"
    python.parent.mkdir(parents=True)
    python.write_bytes(b"python")
    app = root / "app"
    (app / "executors" / "ldos_gallery").mkdir(parents=True)
    (app / "executors" / "ldos_gallery" / "worker_entry.py").write_text("", encoding="utf-8")
    backend = root / "bin" / "ldos-backend"
    backend.parent.mkdir()
    backend.write_bytes(b"native")
    backend.chmod(0o755)
    (app / "dedup_review_worker.py").write_text("", encoding="utf-8")
    (app / "atlas_worker.py").write_text("", encoding="utf-8")
    (app / "tagger").mkdir()
    (app / "tagger" / "cli.py").write_text("", encoding="utf-8")
    mihomo = app / "bin" / "mihomo"
    mihomo.parent.mkdir()
    mihomo.write_bytes(b"mihomo")
    mihomo.chmod(0o755)
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
            "python": "runtime/python/bin/python3.13",
            "archive_sha256": "1" * 64,
        },
        "application": {"backend": "bin/ldos-backend", "executors": "app/executors", "worker": "-m ldos_gallery.worker_entry"},
        "bundled_resources": {
            "mihomo": {
                "binary": "app/bin/mihomo",
                "binary_sha256": release.sha256_file(mihomo),
            }
        },
        "optional_resources": {"mihomo": True},
        "files": {"path": release.FILES_NAME, "count": count, "sha256": digest},
    }
    (root / release.MANIFEST_NAME).write_text(
        json.dumps(manifest), encoding="utf-8"
    )
    return manifest


def synthetic_elf(
    phnum: int, note_offset: int, note_size: int = 0x24, note_type: int = 7, shoff: int = 0x400
) -> bytes:
    # 64 位小端 ELF：程序头表从 64 开始，每项 56 字节；一个 .note 节，节名表在 0x300，节头表默认在 0x400。
    # shoff=0 表示没有节头表。
    names = b"\0.note\0.shstrtab\0"
    header = b"\x7fELF" + bytes([2, 1, 1]) + bytes(9)
    header += struct.pack("<HHIQQQIHHHHHH", 3, 62, 1, 0, 64, shoff, 0, 64, 56, phnum, 64, 3, 2)
    body = bytearray(header.ljust(0x400, b"\0"))
    body[0x300 : 0x300 + len(names)] = names
    sections = [
        bytes(64),
        struct.pack("<IIQQQQIIQQ", 1, note_type, 2, note_offset, note_offset, note_size, 0, 0, 4, 0),
        struct.pack("<IIQQQQIIQQ", 7, 3, 0, 0, 0x300, len(names), 0, 0, 1, 0),
    ]
    return bytes(body) + b"".join(sections)


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
            },
        )
        self.assertEqual(set(lock["targets"]), {"linux-x86_64"})
        self.assertEqual(
            lock["targets"]["linux-x86_64"]["python"],
            "runtime/python/bin/python3.13",
        )
        self.assertTrue(
            all(
                len(item["sha256"]) == 64
                and len(item["metadata_sha256"]) == 64
                and len(item["python_license_sha256"]) == 64
                and len(item["mihomo"]["sha256"]) == 64
                and len(item["mihomo"]["binary_sha256"]) == 64
                for item in lock["targets"].values()
            )
        )
        self.assertEqual(
            lock["optional_resources"],
            {
                "dedup_models": False,
                "mihomo": True,
                "browser_runtime": False,
            },
        )

    def test_release_host_rejects_windows(self) -> None:
        with (
            mock.patch.object(release.platform, "machine", return_value="AMD64"),
            mock.patch.object(release.sys, "platform", "win32"),
            mock.patch.object(release.os, "name", "nt"),
        ):
            with self.assertRaisesRegex(release.ReleaseError, "unsupported release host"):
                release.host_target()

    def test_windows_installer_is_not_supported(self) -> None:
        with temporary_path() as tmp_path:
            with self.assertRaisesRegex(release.ReleaseError, "unsupported desktop bundle"):
                release.extract_bundle(tmp_path / "LDOS-setup.exe", tmp_path / "output")

    def test_all_workflows_only_use_linux_runners(self) -> None:
        workflows = sorted((ROOT / ".github/workflows").glob("*.y*ml"))
        self.assertTrue(workflows)
        for path in workflows:
            with self.subTest(workflow=path.name):
                workflow = path.read_text(encoding="utf-8")
                runners = [line.strip() for line in workflow.splitlines()
                           if line.lstrip().startswith("runs-on:")]
                self.assertTrue(runners)
                self.assertTrue(all(line.startswith("runs-on: ubuntu-") for line in runners))
                self.assertNotIn(".ps1", workflow)

    def test_linux_runtime_keeps_only_the_locked_real_interpreter(self) -> None:
        with temporary_path() as tmp_path:
            bin_dir = tmp_path / "python" / "bin"
            bin_dir.mkdir(parents=True)
            for name in ("python", "python3", "python3.13", "pip"):
                (bin_dir / name).write_bytes(name.encode())

            release.remove_generated_launchers(tmp_path, "linux-x86_64")

            self.assertEqual(
                {path.name for path in bin_dir.iterdir()},
                {"python3.13"},
            )

    def test_mygo_build_hooks_compile_the_native_backend(self) -> None:
        config = json.loads((ROOT / "desktop/mygo.json").read_text(encoding="utf-8"))
        self.assertEqual(config["devCommand"], "npm run build:backend && npm run dev:web")
        self.assertEqual(config["buildCommand"], "npm run build:backend && npm run build:web")
        self.assertEqual(config["linux"]["formats"], [])
        self.assertEqual(release.DEFAULT_OUTPUT, ROOT / "desktop/resources/backend")
        package = json.loads((ROOT / "desktop/package.json").read_text(encoding="utf-8"))
        command = shlex.split(package["scripts"]["build"])
        self.assertEqual(command[command.index("-platform") + 1], "linux/amd64")

    def test_release_workflow_is_manual_linux_validation_without_publishing(self) -> None:
        workflow = (ROOT / ".github/workflows/desktop-release.yml").read_text(
            encoding="utf-8"
        )
        active_workflow = "\n".join(
            line for line in workflow.splitlines()
            if not line.lstrip().startswith("#")
        )
        triggers = active_workflow.split("\non:\n", maxsplit=1)[1].split(
            "\npermissions:", maxsplit=1
        )[0]
        self.assertEqual(triggers.strip(), "workflow_dispatch:")
        self.assertIn("permissions:\n  contents: read", active_workflow)
        self.assertNotRegex(active_workflow, r"(?m):\s*[\"']?write(?:-all)?[\"']?\s*$")
        self.assertNotIn("secrets.", active_workflow)

        jobs = active_workflow.split("\njobs:\n", maxsplit=1)[1]
        self.assertEqual(
            [line.strip() for line in jobs.splitlines()
             if line.startswith("  ") and not line.startswith("   ")],
            ["linux-build:"],
        )
        self.assertRegex(jobs, r"(?m)^    runs-on: ubuntu-")
        self.assertIn("run: go test ./src-mygo/...", jobs)
        self.assertIn("run: npm run build", jobs)
        self.assertIn("test -x desktop/build/linux-amd64/ldos", jobs)
        for publishing_step in (
            "upload-artifact@", "gh release", "gh api", "/releases",
            "action-gh-release@", "release-action@", "desktop_release.py build",
            "npm run tauri", "npx tauri",
        ):
            with self.subTest(publishing_step=publishing_step):
                self.assertNotIn(publishing_step, active_workflow)

        with mock.patch.object(release, "build_release", return_value={"target": "linux-x86_64"}) as native_build:
            with mock.patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(release.main(["build"]), 0)
            native_build.assert_called_once()

    def test_executor_projection_omits_business_backend_and_frontend(self) -> None:
        import ast
        with temporary_path() as tmp_path:
            app = tmp_path / "app"
            app.mkdir()
            release.copy_executor_sources(app)
            release.copy_application_scripts(app, release.load_lock())
            package = app / "executors" / "ldos_gallery"
            self.assertEqual({p.name for p in package.iterdir()}, {p.name for p in release.EXECUTORS_SOURCE.glob("*.py")})
            self.assertTrue((package / "worker_entry.py").is_file())
            self.assertFalse((app / "gdl_backend").exists())
            self.assertFalse(any(app.rglob("webui_dist")))
            for source in app.rglob("*.py"):
                for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
                    if isinstance(node, ast.Import):
                        self.assertFalse(any(alias.name == "gdl_backend" or alias.name.startswith("gdl_backend.") for alias in node.names), source)
                    elif isinstance(node, ast.ImportFrom):
                        self.assertFalse(node.module and (node.module == "gdl_backend" or node.module.startswith("gdl_backend.")), source)

    def test_application_projection_preserves_tagger_package_and_only_ships_code(self) -> None:
        import subprocess

        with temporary_path() as tmp_path:
            app = tmp_path / "app"
            app.mkdir()
            lock = json.loads((ROOT / "desktop/release/runtime-lock.json").read_text(encoding="utf-8"))
            release.copy_application_scripts(app, lock)
            self.assertTrue((app / "dedup_review_worker.py").is_file())
            self.assertTrue((app / "atlas_worker.py").is_file())
            expected = {file.name for file in (ROOT / "tagger").glob("*.py")}
            actual = {file.name for file in (app / "tagger").iterdir()}
            self.assertEqual(actual, expected)
            result = subprocess.run(
                [sys.executable, "-I", "-B", str(app / "tagger/cli.py"), "--help"],
                cwd=tmp_path, capture_output=True, text=True, check=True,
            )
            self.assertIn("prepare", result.stdout)
            result = subprocess.run(
                [sys.executable, "-I", "-B", str(app / "atlas_worker.py"), "--help"],
                cwd=tmp_path, capture_output=True, text=True, check=True,
            )
            self.assertIn("--job", result.stdout)
            self.assertFalse((app / "tagger/tags.sqlite3").exists())
            self.assertFalse((app / "tagger/.models").exists())

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

    def test_install_mihomo_extracts_locked_platform_archives(self) -> None:
        payload = b"locked mihomo executable"
        with temporary_path() as tmp_path:
            lock = release.load_lock()

            gzip_archive = tmp_path / "mihomo.gz"
            with gzip.open(gzip_archive, "wb") as archive:
                archive.write(payload)
            linux = lock["targets"]["linux-x86_64"]["mihomo"]
            linux.update(
                {
                    "archive": gzip_archive.name,
                    "sha256": release.sha256_file(gzip_archive),
                    "binary": "app/bin/mihomo",
                    "binary_sha256": release.sha256_bytes(payload),
                }
            )
            linux_output = tmp_path / "linux"
            installed = release.install_mihomo(
                gzip_archive, linux_output, lock, "linux-x86_64"
            )
            self.assertEqual(installed.read_bytes(), payload)


    def test_extract_deb_reads_data_archive_without_system_tools(self) -> None:
        with temporary_path() as tmp_path:
            tar_payload = io.BytesIO()
            with tarfile.open(fileobj=tar_payload, mode="w:gz") as archive:
                content = b"canonical"
                member = tarfile.TarInfo("./usr/lib/ldos/probe")
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))

            def ar_member(name: str, payload: bytes) -> bytes:
                header = (
                    f"{name + '/':<16}{0:<12}{0:<6}{0:<6}"
                    f"{'100644':<8}{len(payload):<10}`\n"
                ).encode("ascii")
                self.assertEqual(len(header), 60)
                return header + payload + (b"\n" if len(payload) % 2 else b"")

            bundle = tmp_path / "LDOS.deb"
            bundle.write_bytes(
                b"!<arch>\n"
                + ar_member("debian-binary", b"2.0\n")
                + ar_member("data.tar.gz", tar_payload.getvalue())
            )
            destination = tmp_path / "extracted"
            release.extract_deb(bundle, destination)

            self.assertEqual(
                (destination / "usr/lib/ldos/probe").read_bytes(),
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

    def test_file_manifest_records_relative_symlinks(self) -> None:
        with temporary_path() as tmp_path:
            target = tmp_path / "runtime" / "python3.13"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"python")
            os.symlink("python3.13", tmp_path / "runtime" / "python3")

            release.write_file_manifest(tmp_path)

            lines = (tmp_path / release.FILES_NAME).read_text(encoding="utf-8")
            self.assertIn("\tL\truntime/python3\n", lines)

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
            backend = tmp_path / "usr" / "lib" / "ldos" / "backend"
            backend.mkdir(parents=True)
            minimal_tree(backend)
            frontend = (
                tmp_path
                / "usr"
                / "lib"
                / "ldos"
                / "frontend-manifest.json"
            )
            frontend.write_bytes(frontend_payload)

            with (
                mock.patch.object(release, "FRONTEND_MANIFEST", canonical),
                mock.patch.object(release, "verify_release_identity"),
            ):
                result = release.verify_bundle_tree(tmp_path)

            self.assertEqual(
                result["backend_relative"], "usr/lib/ldos/backend"
            )
            self.assertEqual(
                result["frontend_manifest_relative"],
                "usr/lib/ldos/frontend-manifest.json",
            )

    def test_appimage_bundle_rejects_bundled_libwayland_client(self) -> None:
        # 走完整的 verify_bundle：真实的 --appimage-extract 把 AppDir 解到 squashfs-root/，
        # 守卫曾因只看解包目录的根而从未生效。
        with temporary_path() as tmp_path:
            canonical, frontend_payload = use_test_frontend_manifest(tmp_path)
            app_dir = tmp_path / "AppDir"
            backend = app_dir / "usr" / "share" / "LDOS" / "backend"
            backend.mkdir(parents=True)
            minimal_tree(backend)
            frontend = app_dir / "usr" / "lib" / "LDOS" / "frontend-manifest.json"
            frontend.parent.mkdir(parents=True)
            frontend.write_bytes(frontend_payload)
            (app_dir / "AppRun").write_text("#!/bin/sh\n", encoding="utf-8")
            bundled = app_dir / "usr" / "lib" / "libwayland-client.so.0"
            bundled.write_bytes(b"stale wayland client")
            bundle = tmp_path / "LDOS_0.0.0_amd64.AppImage"
            bundle.write_text(
                "#!/bin/sh\n"
                f'[ "$1" = --appimage-extract ] && cp -R {shlex.quote(str(app_dir))} squashfs-root\n',
                encoding="utf-8",
            )

            with (
                mock.patch.object(release, "FRONTEND_MANIFEST", canonical),
                mock.patch.object(release, "verify_release_identity"),
            ):
                with self.assertRaisesRegex(release.ReleaseError, "libwayland-client"):
                    release.verify_bundle(bundle)
                bundled.unlink()
                result = release.verify_bundle(bundle)

            self.assertEqual(result["backend_relative"], "usr/share/LDOS/backend")

    def test_program_header_table_overlapping_a_section_is_detected(self) -> None:
        with temporary_path() as tmp_path:
            # 11 项程序头正好止于 0x2a8；patchelf 加到 12 项后表尾到 0x2e0，压住 0x2a8 处的 note。
            clean = tmp_path / "clean.so"
            clean.write_bytes(synthetic_elf(11, 0x2A8))
            damaged = tmp_path / "damaged.so"
            damaged.write_bytes(synthetic_elf(12, 0x2A8))
            text = tmp_path / "loaders.cache"
            text.write_text("not an ELF file\n", encoding="utf-8")

            # 把 ELF 头和整张程序头表包在里面的节（Guile .go 的布局）、不占文件内容的 NOBITS 节、没有节头表都不算损坏。
            wrapping = tmp_path / "rnrs.go"
            wrapping.write_bytes(synthetic_elf(3, 0, note_size=0xE8))
            nobits = tmp_path / "nobits.so"
            nobits.write_bytes(synthetic_elf(12, 0x2A8, note_type=8))
            no_sections = tmp_path / "no-sections.so"
            no_sections.write_bytes(synthetic_elf(12, 0x2A8, shoff=0))

            self.assertIsNone(release.overlapping_program_header_section(clean))
            self.assertEqual(release.overlapping_program_header_section(damaged), ".note")
            self.assertIsNone(release.overlapping_program_header_section(text))
            self.assertIsNone(release.overlapping_program_header_section(wrapping))
            self.assertIsNone(release.overlapping_program_header_section(nobits))
            self.assertIsNone(release.overlapping_program_header_section(no_sections))

    def test_appimage_tree_rejects_a_library_damaged_by_patchelf(self) -> None:
        with temporary_path() as tmp_path:
            canonical, frontend_payload = use_test_frontend_manifest(tmp_path)
            backend = tmp_path / "usr" / "share" / "LDOS" / "backend"
            backend.mkdir(parents=True)
            minimal_tree(backend)
            frontend = tmp_path / "usr" / "lib" / "LDOS" / "frontend-manifest.json"
            frontend.parent.mkdir(parents=True)
            frontend.write_bytes(frontend_payload)
            (tmp_path / "AppRun").write_text("#!/bin/sh\n", encoding="utf-8")
            library = tmp_path / "usr" / "lib" / "libleancrypto.so.1.9"
            library.write_bytes(synthetic_elf(12, 0x2A8))

            with (
                mock.patch.object(release, "FRONTEND_MANIFEST", canonical),
                mock.patch.object(release, "verify_release_identity"),
            ):
                with self.assertRaisesRegex(
                    release.ReleaseError, r"usr/lib/libleancrypto\.so\.1\.9 \(\.note\)"
                ):
                    release.verify_bundle_tree(tmp_path)
                library.write_bytes(synthetic_elf(11, 0x2A8))
                release.verify_bundle_tree(tmp_path)

    def test_deb_tree_rejects_a_binary_damaged_by_patchelf(self) -> None:
        with temporary_path() as tmp_path:
            canonical, frontend_payload = use_test_frontend_manifest(tmp_path)
            backend = tmp_path / "usr" / "lib" / "LDOS" / "backend"
            backend.mkdir(parents=True)
            minimal_tree(backend)
            (tmp_path / "usr" / "lib" / "LDOS" / "frontend-manifest.json").write_bytes(
                frontend_payload
            )
            binary = tmp_path / "usr" / "bin" / "ldos-desktop"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(synthetic_elf(12, 0x2A8))
            # 指向坏文件的符号链接不重复报告。
            (tmp_path / "usr" / "bin" / "ldos").symlink_to("ldos-desktop")

            with (
                mock.patch.object(release, "FRONTEND_MANIFEST", canonical),
                mock.patch.object(release, "verify_release_identity"),
            ):
                with self.assertRaisesRegex(
                    release.ReleaseError, r"overwrite a section .*: usr/bin/ldos-desktop \(\.note\)$"
                ):
                    release.verify_bundle_tree(tmp_path)
                binary.write_bytes(synthetic_elf(11, 0x2A8))
                release.verify_bundle_tree(tmp_path)

    def test_appimage_bundle_without_an_appdir_fails_closed(self) -> None:
        with temporary_path() as tmp_path:
            bundle = tmp_path / "LDOS_0.0.0_amd64.AppImage"
            bundle.write_text("#!/bin/sh\n", encoding="utf-8")

            with self.assertRaisesRegex(release.ReleaseError, "squashfs-root/AppRun"):
                release.verify_bundle(bundle)

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

    def test_prebuilt_frontend_env_skips_rebuilding(self) -> None:
        with mock.patch.dict(os.environ, {"LDOS_PREBUILT_FRONTEND": "1"}):
            commands = release.frontend_build_commands("npm")
        self.assertEqual(commands, [])

    def test_default_frontend_path_builds(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != "LDOS_PREBUILT_FRONTEND"}
        with mock.patch.dict(os.environ, env, clear=True):
            commands = release.frontend_build_commands("npm")
        self.assertEqual(commands, [["npm", "run", "build:web"]])

    def test_scan_exempts_upstream_sbom_paths_but_not_credentials(self) -> None:
        # 用真实存在的路径作禁用针，避免 Windows 把 "/home/..." 解析成
        # 盘符相对路径导致针与内容永不匹配。
        with tempfile.TemporaryDirectory() as build_machine:
            upstream_path = os.fspath(Path(build_machine).resolve()).encode()
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / release.MANIFEST_NAME).write_text("{}", encoding="utf-8")
                (root / release.FILES_NAME).write_text("", encoding="utf-8")
                sbom_dir = root / "pydantic_core-2.46.4.dist-info" / "sboms"
                sbom_dir.mkdir(parents=True)
                (sbom_dir / "pydantic-core.cyclonedx.json").write_bytes(
                    b'{"metadata": {"path": "' + upstream_path + b'/pydantic-core"}}'
                )
                # 上游 SBOM 中的构建机路径不视为本机泄漏。
                release.scan_for_local_paths(root, [Path(build_machine)])
                # 但藏进 SBOM 的私钥仍然拦截。
                (sbom_dir / "pydantic-core.cyclonedx.json").write_bytes(
                    b"-----BEGIN PRIVATE KEY-----\n"
                )
                with self.assertRaisesRegex(
                    release.ReleaseError, "private key"
                ):
                    release.scan_for_local_paths(root, [Path(build_machine)])

    def test_scan_flags_local_path_outside_sboms(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / release.MANIFEST_NAME).write_text("{}", encoding="utf-8")
            (root / release.FILES_NAME).write_text("", encoding="utf-8")
            leak = os.fspath(Path(tmp).resolve()).encode()
            (root / "config.json").write_bytes(
                b'{"path": "' + leak + b'/secret"}'
            )
            with self.assertRaisesRegex(
                release.ReleaseError, "forbidden local path"
            ):
                release.scan_for_local_paths(root, [Path(tmp)])

    def test_scan_exempts_upstream_site_packages_but_not_our_code(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / release.MANIFEST_NAME).write_text("{}", encoding="utf-8")
            (root / release.FILES_NAME).write_text("", encoding="utf-8")
            leak = os.fspath(Path(tmp).resolve()).encode()
            # 上游 wheel（如 numpy __config__.py）内嵌的构建机路径不受本仓库控制。
            upstream = root / "runtime" / "python" / "Lib" / "site-packages" / "numpy"
            upstream.mkdir(parents=True)
            (upstream / "__config__.py").write_bytes(
                b"build_machine = r'" + leak + b"\\wheel\\numpy'")
            release.scan_for_local_paths(root, [Path(tmp)])

            ours = root / "runtime" / "python" / "Lib" / "site-packages" / "gdl_backend"
            ours.mkdir(parents=True)
            (ours / "config.py").write_bytes(b"PATH = r'" + leak + b"'")
            with self.assertRaisesRegex(
                release.ReleaseError, "forbidden local path"
            ):
                release.scan_for_local_paths(root, [Path(tmp)])

            # 凭据与私钥模式对豁免路径针的第三方文件同样生效。
            (upstream / "__config__.py").write_bytes(
                b"-----BEGIN OPENSSH PRIVATE KEY-----\nmock"
            )
            (ours / "config.py").unlink()
            with self.assertRaisesRegex(
                release.ReleaseError, "private key"
            ):
                release.scan_for_local_paths(root, [Path(tmp)])

if __name__ == "__main__":
    unittest.main()
