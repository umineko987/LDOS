#!/usr/bin/env python3
"""Generate and verify target-specific third-party notices for desktop bundles."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
NOTICE_JSON = Path("licenses/third-party-components.json")
NOTICE_MD = Path("licenses/THIRD-PARTY-NOTICES.md")
LICENSE_NAMES = re.compile(
    r"^(license|licence|copying|notice)([._-].*)?$", re.IGNORECASE
)
TARGET_TRIPLES = {
    "linux-x86_64": "x86_64-unknown-linux-gnu",
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


def _go_components(tree: Path) -> list[dict[str, Any]]:
    modules: dict[tuple[str, str], dict[str, Any]] = {}
    decoder = json.JSONDecoder()
    for project, package in ((ROOT / "backend", "./cmd/ldos-backend"), (ROOT / "desktop", "./src-mygo")):
        output = _run(["go", "list", "-deps", "-json", package], cwd=project)
        while output.strip():
            entry, end = decoder.raw_decode(output.lstrip())
            output = output.lstrip()[end:]
            module = entry.get("Module")
            if not module or module.get("Main"):
                continue
            if module.get("Replace"):
                raise NoticeError(f"release Go module uses a replacement: {module['Path']}")
            modules[(module["Path"], module["Version"])] = module
    components = []
    for (name, version), module in sorted(modules.items()):
        destination = tree / "licenses" / "go" / _slug(f"{name}-{version}")
        files = _copy_license_files(Path(module["Dir"]), destination)
        if not files:
            raise NoticeError(f"Go module has no bundled license file: {name}@{version}")
        components.append({
            "ecosystem": "go", "name": name, "version": version,
            "license": "See bundled license files",
            "source": f"https://pkg.go.dev/{name}@{version}",
            "license_files": _relative_files(files, tree),
        })
    version = _run(["go", "env", "GOVERSION"], cwd=ROOT)
    goroot = Path(_run(["go", "env", "GOROOT"], cwd=ROOT))
    files = _copy_license_files(goroot, tree / "licenses" / "go" / version)
    if not files:
        raise NoticeError("Go standard-library license evidence is missing")
    components.append({
        "ecosystem": "runtime", "name": "Go standard library", "version": version,
        "license": "BSD-3-Clause", "source": f"https://go.dev/dl/#{version}",
        "license_files": _relative_files(files, tree),
    })
    return components


def _npm_components(tree: Path) -> list[dict[str, Any]]:
    lock = json.loads(
        (ROOT / "desktop" / "package-lock.json").read_text(encoding="utf-8")
    )
    package_paths = ("node_modules/mygo-runtime", "node_modules/svelte")
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
        "# LDOS desktop third-party notices",
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
    shutil.rmtree(licenses / "go", ignore_errors=True)
    shutil.rmtree(licenses / "npm", ignore_errors=True)
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
    mihomo = distribution.get("mihomo")
    if isinstance(mihomo, dict):
        components.append(
            {
                "ecosystem": "bundled-tool",
                "name": "Mihomo",
                "version": mihomo["version"],
                "license": mihomo["license"],
                "source": mihomo["source"],
                "artifact_sha256": mihomo["artifact_sha256"],
                "license_files": [mihomo["license_file"]],
            }
        )
    components.extend(_go_components(tree))
    components.extend(_npm_components(tree))
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
