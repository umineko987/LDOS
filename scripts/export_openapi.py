#!/usr/bin/env python3
"""导出后端 OpenAPI 快照，供桌面前端生成类型。

用法（仅需 Python 标准库）：

    python3 scripts/export_openapi.py          # 写入快照
    python3 scripts/export_openapi.py --check  # 快照过期时退出码 1

从 Go HTTP 服务嵌入的契约导出，不导入旧 Python 服务，也不读取用户配置。
输出按键排序、缩进 2、末尾换行。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "backend" / "internal" / "httpapi" / "openapi.json"
SNAPSHOT_PATH = ROOT / "desktop" / "src" / "lib" / "api" / "openapi.json"
REGENERATE_HINT = "python3 scripts/export_openapi.py"


def build_document() -> dict[str, Any]:
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def render(document: dict[str, Any]) -> str:
    return json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="只比较，不写入；快照过期时退出码 1")
    parser.add_argument("--output", type=Path, default=SNAPSHOT_PATH, help="快照路径")
    args = parser.parse_args(argv)

    rendered = render(build_document())
    output: Path = args.output
    if args.check:
        current = output.read_text(encoding="utf-8") if output.is_file() else None
        if current != rendered:
            print(f"OpenAPI 快照已过期：{output}；请运行 {REGENERATE_HINT}", file=sys.stderr)
            return 1
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
