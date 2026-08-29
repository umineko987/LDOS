#!/usr/bin/env python3
"""Generate and verify target-specific third-party notices for desktop bundles."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tomllib
import urllib.parse
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TAURI = ROOT / "desktop" / "src-tauri"
NOTICE_JSON = Path("licenses/third-party-components.json")
NOTICE_MD = Path("licenses/THIRD-PARTY-NOTICES.md")
LICENSE_NAMES = re.compile(
    r"^(license|licence|copying|notice)([._-].*)?$", re.IGNORECASE
)
TARGET_TRIPLES = {
    "linux-x86_64": "x86_64-unknown-linux-gnu",
    "windows-x86_64": "x86_64-pc-windows-msvc",
}


class NoticeError(RuntimeError):
    """Raised when notice evidence is missing or inconsistent."""


def _run(command: list[str], *, cwd: Path) -> str:
    result = subprocess.run(
        command, cwd=cwd, text=True, capture_output=True, check=False
    )
    if result.returncode:
        raise NoticeError(
            f"command failed ({result.returncode}): {' '.join(command)}\n{result.stdout}{result.stderr}"
        )
    return result.stdout.strip()


def _slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._+-]+", "_", value)


def _copy_license_files(source: Path, destination: Path) -> list[Path]:
    files = sorted(
        path
        for path in source.iterdir()
        if path.is_file() and LICENSE_NAMES.match(path.name)
    )
    copied: list[Path] = []
    for path in files:
        destination.mkdir(parents=True, exist_ok=True)
        target = destination / path.name
        shutil.copyfile(path, target)
        copied.append(target)
    return copied


def _relative_files(files: list[Path], tree: Path) -> list[str]:
    return [path.relative_to(tree).as_posix() for path in files]


def _cargo_components(tree: Path, target: str) -> list[dict[str, Any]]:
    triple = TARGET_TRIPLES[target]
    metadata = json.loads(
        _run(
            [
                "cargo",
                "metadata",
                "--locked",
                "--format-version",
                "1",
                "--filter-platform",
                triple,
            ],
            cwd=TAURI,
        )
    )
    packages = {package["id"]: package for package in metadata["packages"]}
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    root_id = metadata["resolve"]["root"]
    pending = [root_id]
    included: set[str] = set()
    while pending:
        package_id = pending.pop()
        if package_id in included:
            continue
        included.add(package_id)
        for dependency in nodes[package_id]["deps"]:
            if any(kind["kind"] != "dev" for kind in dependency["dep_kinds"]):
                pending.append(dependency["pkg"])

    cargo_lock = tomllib.loads((TAURI / "Cargo.lock").read_text(encoding="utf-8"))
    checksums = {
        (item["name"], item["version"], item.get("source")): item.get("checksum")
        for item in cargo_lock["package"]
    }
    components: list[dict[str, Any]] = []
    for package_id in sorted(included):
        package = packages[package_id]
        if package_id == root_id:
            continue
        license_name = package.get("license")
        source = package.get("source")
        if not license_name or not source:
            raise NoticeError(
                f"Cargo package lacks license/source metadata: {package_id}"
            )
        if source.startswith("registry+"):
            source_url = (
                "https://crates.io/crates/"
                f"{urllib.parse.quote(package['name'])}/{urllib.parse.quote(package['version'])}"
            )
        elif source.startswith("git+"):
            source_url = source.removeprefix("git+").split("#", 1)[0]
        else:
            raise NoticeError(f"unsupported Cargo source: {source}")
        source_dir = Path(package["manifest_path"]).parent
        destination = (
            tree
            / "licenses"
            / "cargo"
            / _slug(f"{package['name']}-{package['version']}")
        )
        license_files = _copy_license_files(source_dir, destination)
        if not license_files:
            destination.mkdir(parents=True, exist_ok=True)
            metadata_notice = destination / "DECLARED-LICENSE.txt"
            metadata_notice.write_text(
                "This crate archive has no standalone license file.\n"
                f"Declared Cargo license: {license_name}\n"
                f"Locked source: {source_url}\n",
                encoding="utf-8",
                newline="\n",
            )
            license_files = [metadata_notice]
        components.append(
            {
                "ecosystem": "cargo",
                "name": package["name"],
                "version": package["version"],
                "license": license_name,
                "source": source_url,
                "artifact_sha256": checksums.get(
                    (package["name"], package["version"], source)
                ),
                "license_files": _relative_files(license_files, tree),
            }
        )
    return components


def _rust_component(tree: Path) -> dict[str, Any]:
    toolchain = tomllib.loads(
        (ROOT / "rust-toolchain.toml").read_text(encoding="utf-8")
    )
    version = toolchain["toolchain"]["channel"]
    actual = _run(["rustc", "--version"], cwd=ROOT)
    if not actual.startswith(f"rustc {version} "):
        raise NoticeError(f"locked Rust {version} is not active: {actual}")
    sysroot = Path(_run(["rustc", "--print", "sysroot"], cwd=ROOT))
    source_files = [
        sysroot / "share" / "doc" / "rust" / "COPYRIGHT.html",
        sysroot / "share" / "doc" / "rust" / "COPYRIGHT-library.html",
    ]
    if not all(path.is_file() for path in source_files):
        raise NoticeError("Rust standard-library license evidence is missing")
    destination = tree / "licenses" / "rust" / f"rust-{version}"
    destination.mkdir(parents=True, exist_ok=True)
    copied = []
    for path in source_files:
        target = destination / path.name
        shutil.copyfile(path, target)
        copied.append(target)
    return {
        "ecosystem": "runtime",
        "name": "Rust standard library",
        "version": version,
        "license": "Apache-2.0 OR MIT",
        "source": f"https://github.com/rust-lang/rust/tree/{version}",
        "license_files": _relative_files(copied, tree),
    }


def _npm_components(tree: Path) -> list[dict[str, Any]]:
    lock = json.loads(
        (ROOT / "desktop" / "package-lock.json").read_text(encoding="utf-8")
    )
    package_paths = ("node_modules/@tauri-apps/api", "node_modules/svelte")
    components: list[dict[str, Any]] = []
    for package_path in package_paths:
        item = lock["packages"][package_path]
        name = package_path.removeprefix("node_modules/")
        license_name = item.get("license")
        source = item.get("resolved")
        integrity = item.get("integrity")
        if not license_name or not source or not integrity:
            raise NoticeError(f"npm package lacks locked notice evidence: {name}")
        source_dir = ROOT / "desktop" / package_path
        if not source_dir.is_dir():
            raise NoticeError(
                "desktop/node_modules is missing; run npm ci before assembly"
            )
        destination = tree / "licenses" / "npm" / _slug(f"{name}-{item['version']}")
        license_files = _copy_license_files(source_dir, destination)
        if not license_files:
            raise NoticeError(f"npm package has no bundled license file: {name}")
        components.append(
            {
                "ecosystem": "npm",
                "name": name,
                "version": item["version"],
                "license": license_name,
                "source": source,
                "artifact_integrity": integrity,
                "license_files": _relative_files(license_files, tree),
            }
        )
    return components


def _python_components(tree: Path, python: Path) -> list[dict[str, Any]]:
    program = r"""
import importlib.metadata as metadata
import json

def license_name(item):
    value = item.metadata.get("License-Expression") or item.metadata.get("License")
    if value:
        return value.strip()
    classifiers = item.metadata.get_all("Classifier") or []
    values = [value.rsplit(" :: ", 1)[-1] for value in classifiers if value.startswith("License :: ")]
    return " OR ".join(values)

def source(item):
    urls = item.metadata.get_all("Project-URL") or []
    for preferred in ("source", "repository", "code", "homepage"):
        for value in urls:
            label, separator, url = value.partition(",")
            if separator and preferred in label.strip().lower():
                return url.strip()
    return item.metadata.get("Home-page") or f"https://pypi.org/project/{item.metadata['Name']}/{item.version}/"

result = []
for item in metadata.distributions():
    files = []
    for path in item.files or []:
        if any(part.lower() == "licenses" for part in path.parts) or path.name.lower().startswith(("license", "licence", "copying", "notice")):
            located = item.locate_file(path)
            if located.is_file():
                files.append(str(located))
    result.append({
        "name": item.metadata["Name"],
        "version": item.version,
        "license": license_name(item),
        "source": source(item),
        "license_files": sorted(set(files)),
    })
print(json.dumps(result, sort_keys=True))
"""
    output = _run([str(python), "-I", "-B", "-c", program], cwd=tree)
    raw_components = json.loads(output)
    components: list[dict[str, Any]] = []
    for item in raw_components:
        if not item["license"] or not item["source"]:
            raise NoticeError(
                f"Python distribution lacks license/source metadata: {item['name']}"
            )
        files = [Path(path) for path in item["license_files"]]
        if not files:
            raise NoticeError(
                f"Python distribution has no bundled license file: {item['name']}"
            )
        try:
            relative = _relative_files(files, tree)
        except ValueError as error:
            raise NoticeError(
                f"Python license escaped release tree: {item['name']}"
            ) from error
        components.append(
            {
                "ecosystem": "python",
                "name": item["name"],
                "version": item["version"],
                "license": item["license"],
                "source": item["source"],
                "license_files": relative,
            }
        )
    return components


def _runtime_components(
    tree: Path, target: str, distribution: dict[str, Any]
) -> list[dict[str, Any]]:
    metadata_root = tree / "runtime" / "metadata" / "python-build-standalone"
    metadata_path = metadata_root / "PYTHON.json"
    if not metadata_path.is_file():
        raise NoticeError("python-build-standalone metadata is missing")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if (
        metadata.get("python_version") != distribution["python_version"]
        or metadata.get("target_triple") != TARGET_TRIPLES[target]
    ):
        raise NoticeError("python-build-standalone metadata target/version mismatch")

    def license_files(paths: list[str]) -> list[str]:
        files: list[Path] = []
        root = metadata_root.resolve()
        for relative in paths:
            path = (metadata_root / relative).resolve()
            if root not in path.parents or not path.is_file():
                continue
            files.append(path)
        # files 全部经过 resolve()（长路径/符号链接规范形）；基准必须同样规范形，
        # 否则 Windows 8.3 短路径（RUNNER~1）或 macOS /tmp 符号链接会让 relative_to 失败。
        return _relative_files(sorted(set(files)), tree.resolve())

    artifact_source = (
        "https://github.com/astral-sh/python-build-standalone/releases/download/"
        f"{distribution['version']}/{distribution['metadata_archive']}"
    )
    cpython_files = license_files([metadata["license_path"]])
    if not cpython_files:
        raise NoticeError("CPython metadata license file is missing")
    components = [
        {
            "ecosystem": "runtime",
            "name": "CPython",
            "version": metadata["python_version"],
            "license": " AND ".join(metadata["licenses"]),
            "source": f"https://github.com/python/cpython/tree/v{metadata['python_version']}",
            "artifact_sha256": distribution["metadata_artifact_sha256"],
            "license_files": cpython_files,
        }
    ]

    extensions: dict[str, dict[str, Any]] = {}
    for name, variants in metadata.get("build_info", {}).get("extensions", {}).items():
        for variant in variants:
            licenses = set(variant.get("licenses") or [])
            public_domain = bool(variant.get("license_public_domain"))
            if not licenses and not public_domain:
                continue
            entry = extensions.setdefault(
                name, {"licenses": set(), "public_domain": False, "paths": set()}
            )
            entry["licenses"].update(licenses)
            entry["public_domain"] |= public_domain
            entry["paths"].update(variant.get("license_paths") or [])

    for name, evidence in sorted(extensions.items()):
        declared = sorted(evidence["licenses"])
        if evidence["public_domain"]:
            declared.append("Public Domain")
        files = license_files(sorted(evidence["paths"]))
        if not files:
            raise NoticeError(f"runtime extension license evidence is missing: {name}")
        components.append(
            {
                "ecosystem": "runtime-extension",
                "name": f"CPython extension {name}",
                "version": metadata["python_version"],
                "license": " AND ".join(declared),
                "source": artifact_source,
                "artifact_sha256": distribution["metadata_artifact_sha256"],
                "license_files": files,
            }
        )
    return components


def _write_markdown(
    target: str, components: list[dict[str, Any]], destination: Path
) -> None:
    lines = [
        "# ImageWeave desktop third-party notices",
        "",
        f"Target: `{target}`",
        "",
        "This target-specific inventory is generated from the locked release inputs. License and notice files listed below are included in the same backend distribution tree.",
        "",
        "| Ecosystem | Component | Version | License | Source | License files |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for item in components:
        files = "<br>".join(f"`{path}`" for path in item["license_files"])
        license_text = item["license"].replace("|", "\\|")
        lines.append(
            f"| {item['ecosystem']} | `{item['name']}` | `{item['version']}` | "
            f"{license_text} | {item['source']} | {files} |"
        )
    lines.append("")
    destination.write_text("\n".join(lines), encoding="utf-8", newline="\n")


def generate(
    tree: Path, target: str, distribution: dict[str, Any], python: Path
) -> dict[str, Any]:
    if target not in TARGET_TRIPLES:
        raise NoticeError(f"unsupported notice target: {target}")
    licenses = tree / "licenses"
    shutil.rmtree(licenses / "cargo", ignore_errors=True)
    shutil.rmtree(licenses / "npm", ignore_errors=True)
    shutil.rmtree(licenses / "rust", ignore_errors=True)
    components = [
        {
            "ecosystem": "build-provenance",
            "name": f"{distribution['name']} build configuration",
            "version": distribution["version"],
            "license": distribution["license"],
            "source": distribution["source"],
            "artifact_sha256": distribution["artifact_sha256"],
            "license_files": [distribution["license_file"]],
        },
        {
            "ecosystem": "python-source",
            "name": "gallery-dl",
            "version": distribution["gallery_version"],
            "license": "GPL-2.0-only",
            "source": distribution["gallery_source"],
            "license_files": ["licenses/gallery-dl-GPL-2.0.txt"],
        },
    ]
    components.extend(_runtime_components(tree, target, distribution))
    components.append(_rust_component(tree))
    components.extend(_npm_components(tree))
    components.extend(_cargo_components(tree, target))
    components.extend(_python_components(tree, python))
    components.sort(
        key=lambda item: (item["ecosystem"], item["name"].lower(), item["version"])
    )
    payload = {"schema_version": 1, "target": target, "components": components}
    notice_json = tree / NOTICE_JSON
    notice_json.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    _write_markdown(target, components, tree / NOTICE_MD)
    return payload


def verify(tree: Path, target: str | None = None) -> dict[str, Any]:
    path = tree / NOTICE_JSON
    if not path.is_file():
        raise NoticeError(f"third-party component inventory is missing: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != 1 or not isinstance(
        payload.get("components"), list
    ):
        raise NoticeError("invalid third-party component inventory")
    if target is not None and payload.get("target") != target:
        raise NoticeError("third-party component target mismatch")
    keys: set[tuple[str, str, str]] = set()
    for item in payload["components"]:
        key = (item.get("ecosystem"), item.get("name"), item.get("version"))
        if not all(isinstance(value, str) and value for value in key):
            raise NoticeError("third-party component identity is incomplete")
        if key in keys:
            raise NoticeError(f"duplicate third-party component: {key}")
        keys.add(key)
        if not isinstance(item.get("license"), str) or not item["license"].strip():
            raise NoticeError(f"third-party license is missing: {key}")
        if not isinstance(item.get("source"), str) or not item["source"].startswith(
            "https://"
        ):
            raise NoticeError(f"third-party source is not HTTPS: {key}")
        files = item.get("license_files")
        if not isinstance(files, list) or not files:
            raise NoticeError(f"third-party license files are missing: {key}")
        for relative in files:
            if not isinstance(relative, str):
                raise NoticeError(
                    f"invalid third-party license path: {key}: {relative}"
                )
            relative_path = Path(relative)
            path = (tree / relative_path).resolve(strict=False)
            root = tree.resolve()
            if (
                relative_path.is_absolute()
                or ".." in relative_path.parts
                or (path != root and root not in path.parents)
                or not path.is_file()
            ):
                raise NoticeError(
                    f"invalid third-party license path: {key}: {relative}"
                )
    if not (tree / NOTICE_MD).is_file():
        raise NoticeError("third-party Markdown notice is missing")
    return {"target": payload["target"], "components": len(payload["components"])}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tree", type=Path, required=True)
    parser.add_argument("--target")
    args = parser.parse_args(argv)
    try:
        result = verify(args.tree.resolve(), args.target)
    except (NoticeError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"third-party notices: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
