#!/usr/bin/env python3
"""Run one Python component's tests and enforce its measured coverage floor."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COVERAGE_CONFIG = ROOT / "gallery-dl-backend" / "pyproject.toml"
BASELINES_PATH = ROOT / "scripts" / "coverage-baselines.json"

COMPONENTS = {
    "backend": {
        "cwd": ROOT / "gallery-dl-backend",
        "coverage_args": ["--source=gdl_backend"],
        "report_args": [],
        "test_args": ["-m", "unittest", "discover", "-s", "tests", "-v"],
        "source_description": "all Python files under gallery-dl-backend/gdl_backend",
        "omissions": [],
    },
    "dedup": {
        "cwd": ROOT,
        "coverage_args": ["--include=dedup_*.py"],
        "report_args": ["--include=dedup_*.py"],
        "test_args": ["-m", "unittest", "discover", "-s", "tests", "-v"],
        "source_description": "all repository-root dedup_*.py files",
        "omissions": [],
    },
    "proxy": {
        "cwd": ROOT / "Proxy_pool",
        "coverage_args": [
            "--source=.",
            "--omit=*/tests/*,*/.venv/*,*/scripts/demo_pool.py",
        ],
        "report_args": [],
        "test_args": ["-m", "unittest", "discover", "-s", "tests", "-v"],
        "source_description": "all top-level Proxy_pool library modules",
        "omissions": [
            "Proxy_pool/tests (test code)",
            "Proxy_pool/.venv (generated dependency environment)",
            "Proxy_pool/scripts/demo_pool.py (manual demo CLI; not a library module)",
        ],
    },
}


def _display_command(arguments: list[str]) -> str:
    if os.name == "nt":
        return subprocess.list2cmdline(arguments)
    return shlex.join(arguments)


def _run_logged(arguments: list[str], *, cwd: Path, log_path: Path) -> int:
    with log_path.open("w", encoding="utf-8", newline="") as log:
        process = subprocess.Popen(
            arguments,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert process.stdout is not None
        for line in process.stdout:
            sys.stdout.write(line)
            log.write(line)
        return process.wait()


def _run_checked(arguments: list[str], *, cwd: Path) -> None:
    completed = subprocess.run(arguments, cwd=cwd, check=False)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


def _expected_sources(component: str) -> set[str]:
    if component == "backend":
        base = ROOT / "gallery-dl-backend"
        return {
            path.relative_to(base).as_posix()
            for path in (base / "gdl_backend").rglob("*.py")
        }
    if component == "dedup":
        return {path.name for path in ROOT.glob("dedup_*.py")}
    return {path.name for path in (ROOT / "Proxy_pool").glob("*.py")}


def _normalized_report_sources(report: dict, cwd: Path) -> set[str]:
    result = set()
    for value in report["files"]:
        path = Path(value)
        if path.is_absolute():
            try:
                path = path.relative_to(cwd)
            except ValueError:
                pass
        result.add(path.as_posix())
    return result


def _test_summary(log_text: str) -> dict:
    count_match = re.search(r"^Ran (\d+) tests? in ", log_text, flags=re.MULTILINE)
    skipped_match = re.search(r"^OK(?: \([^\n]*skipped=(\d+)[^\n]*\))?", log_text, flags=re.MULTILINE)
    reasons = sorted(
        set(re.findall(r"\.\.\. skipped ['\"](.+?)['\"]\s*$", log_text, flags=re.MULTILINE))
    )
    return {
        "count": int(count_match.group(1)) if count_match else None,
        "skipped": int(skipped_match.group(1)) if skipped_match and skipped_match.group(1) else 0,
        "skip_reasons": reasons,
    }


def _metric(covered: int, total: int) -> dict:
    percent = 100.0 if total == 0 else covered * 100.0 / total
    return {"covered": covered, "total": total, "percent": percent}


def _passes(actual: dict, minimum: dict) -> bool:
    if actual["total"] == 0:
        return minimum["total"] == 0
    if minimum["total"] == 0:
        return True
    return (
        actual["covered"] * minimum["total"]
        >= minimum["covered"] * actual["total"]
    )


def _write_summary(path: Path, result: dict) -> str:
    lines = [
        f"## {result['component']} Python coverage",
        "",
        f"- tests: {result['tests']['count']}; skipped: {result['tests']['skipped']}",
    ]
    for reason in result["tests"]["skip_reasons"]:
        lines.append(f"  - skip: {reason}")
    for name in ("line", "branch"):
        actual = result["metrics"][name]
        minimum = result["minimum"][name]
        lines.append(
            f"- {name}: {actual['covered']}/{actual['total']} = "
            f"{actual['percent']:.6f}% (minimum "
            f"{minimum['covered']}/{minimum['total']} = {minimum['percent']:.6f}%)"
        )
    lines.extend(
        [
            f"- branch mode: {str(result['branch_coverage']).lower()}",
            f"- gate: **{result['status']}**",
            f"- source: {result['source']}",
        ]
    )
    for omission in result["omissions"]:
        lines.append(f"  - explicit omission: {omission}")
    text = "\n".join(lines) + "\n"
    path.write_text(text, encoding="utf-8")
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with Path(step_summary).open("a", encoding="utf-8") as handle:
            handle.write(text + "\n")
    print("\n" + text, end="")
    return text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("component", choices=sorted(COMPONENTS))
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--measure-only",
        action="store_true",
        help="produce reports without enforcing the recorded floor",
    )
    args = parser.parse_args()

    component = args.component
    specification = COMPONENTS[component]
    output = args.output or ROOT / "artifacts" / "coverage" / component
    if not output.is_absolute():
        output = ROOT / output
    output.mkdir(parents=True, exist_ok=True)
    data_path = output / ".coverage"
    data_path.unlink(missing_ok=True)
    coverage_json = output / "coverage.json"
    coverage_json.unlink(missing_ok=True)
    test_log = output / "tests.log"

    coverage_base = [
        sys.executable,
        "-m",
        "coverage",
    ]
    test_command = [
        *coverage_base,
        "run",
        f"--rcfile={COVERAGE_CONFIG}",
        f"--data-file={data_path}",
        *specification["coverage_args"],
        *specification["test_args"],
    ]
    print(f"coverage command: {_display_command(test_command)}")
    returncode = _run_logged(
        test_command,
        cwd=specification["cwd"],
        log_path=test_log,
    )
    if returncode != 0:
        raise SystemExit(returncode)

    json_command = [
        *coverage_base,
        "json",
        f"--rcfile={COVERAGE_CONFIG}",
        f"--data-file={data_path}",
        "-o",
        str(coverage_json),
        *specification["report_args"],
    ]
    print(f"report command: {_display_command(json_command)}")
    _run_checked(json_command, cwd=specification["cwd"])

    report = json.loads(coverage_json.read_text(encoding="utf-8"))
    if not report["meta"].get("branch_coverage"):
        raise SystemExit("coverage report did not enable branch coverage")
    expected = _expected_sources(component)
    measured = _normalized_report_sources(report, specification["cwd"])
    if measured != expected:
        missing = sorted(expected - measured)
        unexpected = sorted(measured - expected)
        raise SystemExit(
            "coverage source boundary mismatch: "
            f"missing={missing!r}, unexpected={unexpected!r}"
        )

    baselines = json.loads(BASELINES_PATH.read_text(encoding="utf-8"))
    minimum = baselines["python"][component]["minimum"]
    totals = report["totals"]
    metrics = {
        "line": _metric(totals["covered_lines"], totals["num_statements"]),
        "branch": _metric(totals["covered_branches"], totals["num_branches"]),
    }
    for value in minimum.values():
        value["percent"] = (
            100.0 if value["total"] == 0 else value["covered"] * 100.0 / value["total"]
        )
    failed = [name for name in ("line", "branch") if not _passes(metrics[name], minimum[name])]
    tests = _test_summary(test_log.read_text(encoding="utf-8"))
    result = {
        "schema_version": 1,
        "component": component,
        "python": sys.version.split()[0],
        "coverage_version": report["meta"]["version"],
        "branch_coverage": report["meta"]["branch_coverage"],
        "command": _display_command(test_command),
        "report_command": _display_command(json_command),
        "source": specification["source_description"],
        "omissions": specification["omissions"],
        "source_files": sorted(measured),
        "tests": tests,
        "metrics": metrics,
        "minimum": minimum,
        "status": "MEASURED" if args.measure_only else ("FAIL" if failed else "PASS"),
        "failed_metrics": failed,
    }
    (output / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    _write_summary(output / "summary.md", result)
    if failed and not args.measure_only:
        print("coverage regression: " + ", ".join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
