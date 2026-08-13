#!/usr/bin/env python3
"""Run WebUI behavior tests with Node's built-in V8 coverage."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "gallery-dl-backend"
SOURCE_WEBUI = BACKEND / "gdl_backend" / "webui"
SOURCE_TESTS = (
    BACKEND / "tests" / "webui_modules.test.mjs",
    BACKEND / "tests" / "webui_phase2_contract.test.mjs",
    BACKEND / "tests" / "webui_glass_target.test.mjs",
    BACKEND / "tests" / "webui_stage3_crawl_contract.test.mjs",
    BACKEND / "tests" / "webui_stage4_real_apps_contract.test.mjs",
    BACKEND / "tests" / "webui_stage4_diagnostics_contract.test.mjs",
    BACKEND / "tests" / "webui_stage4_personalization_contract.test.mjs",
    BACKEND / "tests" / "webui_stage4_review_contract.test.mjs",
    BACKEND / "tests" / "webui_stage5_preview_apps_contract.test.mjs",
)
BASELINES_PATH = ROOT / "scripts" / "coverage-baselines.json"
SUMMARY_SCRIPT = ROOT / "scripts" / "summarize-node-coverage.cjs"
GROUPS = ("core", "apps", "components")
METRICS = ("line", "branch", "function")


def _display_command(arguments: list[str]) -> str:
    if os.name == "nt":
        return subprocess.list2cmdline(arguments)
    return shlex.join(arguments)


def _node_version(node: str) -> str:
    completed = subprocess.run(
        [node, "--version"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if completed.returncode != 0:
        raise SystemExit(f"无法执行 Node.js: {completed.stderr.strip()}")
    return completed.stdout.strip()


def _prepare_tree(root: Path) -> None:
    shutil.copytree(SOURCE_WEBUI / "js", root / "gdl_backend" / "webui" / "js")
    shutil.copytree(SOURCE_WEBUI / "styles", root / "gdl_backend" / "webui" / "styles")
    shutil.copy2(SOURCE_WEBUI / "index.html", root / "gdl_backend" / "webui" / "index.html")
    (root / "tests").mkdir()
    for source_test in SOURCE_TESTS:
        shutil.copy2(source_test, root / "tests" / source_test.name)
    (root / "package.json").write_text(
        '{"type":"module","private":true}\n',
        encoding="utf-8",
    )


def _run_node_tests(node: str, *, coverage: bool, root: Path, raw: Path | None):
    command = [node, "--test"]
    if coverage:
        command.extend(
            [
                "--experimental-test-coverage",
                "--test-coverage-include=gdl_backend/webui/js/**/*.js",
            ]
        )
    command.extend(f"tests/{source_test.name}" for source_test in SOURCE_TESTS)
    environment = os.environ.copy()
    if coverage:
        assert raw is not None
        raw.mkdir()
        environment["NODE_V8_COVERAGE"] = str(raw)
    completed = subprocess.run(
        command,
        cwd=root,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=90,
        check=False,
    )
    return command, completed


def _test_counts(output: str) -> dict:
    def value(label: str):
        match = re.search(rf"^[ℹ#]\s+{label}\s+(\d+)\s*$", output, flags=re.MULTILINE)
        return int(match.group(1)) if match else None

    return {
        "tests": value("tests"),
        "passed": value("pass"),
        "failed": value("fail"),
        "skipped": value("skipped"),
    }


def _metric_counts(group_report: dict, metric: str) -> dict:
    title = metric.capitalize()
    totals = group_report["totals"]
    covered = totals[f"covered{title}Count"]
    total = totals[f"total{title}Count"]
    return {
        "covered": covered,
        "total": total,
        "percent": 100.0 if total == 0 else covered * 100.0 / total,
    }


def _passes(actual: dict, minimum: dict) -> bool:
    if actual["total"] == 0:
        return minimum["total"] == 0
    if minimum["total"] == 0:
        return True
    return (
        actual["covered"] * minimum["total"]
        >= minimum["covered"] * actual["total"]
    )


def _write_summary(output: Path, result: dict) -> str:
    lines = [
        "## WebUI Node behavior coverage",
        "",
        f"- Node: {result['node']}",
        (
            f"- tests: {result['tests']['tests']}; passed: {result['tests']['passed']}; "
            f"failed: {result['tests']['failed']}; skipped: {result['tests']['skipped']}"
        ),
    ]
    for group in GROUPS:
        lines.append(f"- **{group}**")
        for metric in METRICS:
            actual = result["groups"][group][metric]
            minimum = result["minimum"][group][metric]
            lines.append(
                f"  - {metric}: {actual['covered']}/{actual['total']} = "
                f"{actual['percent']:.6f}% (minimum "
                f"{minimum['covered']}/{minimum['total']} = {minimum['percent']:.6f}%)"
            )
    lines.extend(
        [
            f"- gate: **{result['status']}**",
            "- source assertions in Python are excluded; only executions from "
            "all authoritative tests in SOURCE_TESTS contribute",
        ]
    )
    for omission in result["explicit_omissions"]:
        lines.append(f"  - explicit omission: {omission}")
    text = "\n".join(lines) + "\n"
    (output / "summary.md").write_text(text, encoding="utf-8")
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with Path(step_summary).open("a", encoding="utf-8") as handle:
            handle.write(text + "\n")
    print(text, end="")
    return text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", default=shutil.which("node") or "node")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--test-only", action="store_true")
    parser.add_argument("--measure-only", action="store_true")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="imageweave-webui-") as temporary:
        temporary_root = Path(temporary).resolve()
        _prepare_tree(temporary_root)
        raw = temporary_root / "v8-raw" if not args.test_only else None
        command, completed = _run_node_tests(
            args.node,
            coverage=not args.test_only,
            root=temporary_root,
            raw=raw,
        )
        combined_output = completed.stdout + completed.stderr
        if args.test_only:
            if completed.returncode != 0:
                print(combined_output, file=sys.stderr)
            return completed.returncode

        output = args.output or ROOT / "artifacts" / "coverage" / "webui"
        if not output.is_absolute():
            output = ROOT / output
        output.mkdir(parents=True, exist_ok=True)
        (output / "node-tests.log").write_text(combined_output, encoding="utf-8")
        print(f"coverage command: {_display_command(command)}")
        counts = _test_counts(combined_output)
        print(
            "Node tests: "
            f"tests={counts['tests']} pass={counts['passed']} "
            f"fail={counts['failed']} skipped={counts['skipped']}"
        )
        if completed.returncode != 0:
            print(combined_output, file=sys.stderr)
            return completed.returncode

        coverage_json = output / "coverage.json"
        parser_command = [
            args.node,
            "--expose-internals",
            str(SUMMARY_SCRIPT),
            str(raw),
            str(temporary_root),
            str(SOURCE_WEBUI / "js"),
            str(coverage_json),
        ]
        parser_environment = os.environ.copy()
        parser_environment.pop("NODE_V8_COVERAGE", None)
        parsed = subprocess.run(
            parser_command,
            cwd=ROOT,
            env=parser_environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
        if parsed.returncode != 0:
            print(parsed.stdout + parsed.stderr, file=sys.stderr)
            return parsed.returncode
        report = json.loads(coverage_json.read_text(encoding="utf-8"))

    baselines = json.loads(BASELINES_PATH.read_text(encoding="utf-8"))["webui"]
    actual_node = _node_version(args.node)
    expected_node = baselines["node"]
    if actual_node != expected_node:
        raise SystemExit(
            f"WebUI coverage requires fixed Node {expected_node}, got {actual_node}"
        )

    groups = {
        group: {
            metric: _metric_counts(report["groups"][group], metric)
            for metric in METRICS
        }
        for group in GROUPS
    }
    minimum = {}
    failed = []
    for group in GROUPS:
        configured = baselines.get("groups", {}).get(group, {}).get("minimum", {})
        minimum[group] = {}
        for metric in METRICS:
            value = dict(configured.get(metric, {"covered": 0, "total": 0}))
            value["percent"] = (
                100.0
                if value["total"] == 0
                else value["covered"] * 100.0 / value["total"]
            )
            minimum[group][metric] = value
            if not args.measure_only and not _passes(groups[group][metric], value):
                failed.append(f"{group}.{metric}")

    result = {
        "schema_version": 1,
        "provider": report["provider"],
        "node": actual_node,
        "command": _display_command(command),
        "parser_command": _display_command(parser_command),
        "behavior_tests": [
            str(source_test.relative_to(ROOT)) for source_test in SOURCE_TESTS
        ],
        "tests": counts,
        "groups": groups,
        "minimum": minimum,
        "explicit_omissions": report["explicitOmissions"],
        "status": "MEASURED" if args.measure_only else ("FAIL" if failed else "PASS"),
        "failed_metrics": failed,
    }
    (output / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    _write_summary(output, result)
    if failed:
        print("WebUI coverage regression: " + ", ".join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
