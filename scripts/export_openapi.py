#!/usr/bin/env python3
"""导出后端 OpenAPI 快照，供桌面前端生成类型。

用法（需后端虚拟环境）：

    gallery-dl-backend/.venv/bin/python scripts/export_openapi.py          # 写入快照
    gallery-dl-backend/.venv/bin/python scripts/export_openapi.py --check  # 快照过期时退出码 1

快照只由路由声明决定：应用在临时 runtime 目录里构建，不启动任何后台服务，
输出按键排序、缩进 2、末尾换行，保证同一份代码总是生成同一份字节。
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "gallery-dl-backend"
SNAPSHOT_PATH = ROOT / "desktop" / "src" / "lib" / "api" / "openapi.json"
REGENERATE_HINT = "gallery-dl-backend/.venv/bin/python scripts/export_openapi.py"


def build_document() -> dict[str, Any]:
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    from gdl_backend.app import ServiceContainer, create_app
    from gdl_backend.config import AppSettings

    with tempfile.TemporaryDirectory(prefix="ldos-openapi-") as temporary:
        root = Path(temporary)
        # 不读取用户 config.json：快照不能随本机配置变化。
        settings = AppSettings.load(root / "missing-config.json")
        settings.runtime_dir = root / "runtime"
        settings.database_path = settings.runtime_dir / "backend.sqlite3"
        settings.default_output_root = settings.runtime_dir / "downloads"
        settings.allowed_output_roots = [settings.default_output_root]
        settings.allowed_config_roots = [root / "credentials"]
        settings.allowed_cookie_roots = [root / "credentials"]
        settings.gallery.cache_file = root / "credentials" / "managed" / "gallery-dl-cache.sqlite3"
        settings.gallery.migrate_default_auth = False
        settings.proxy.enabled = False
        settings.proxy.auto_start = False
        settings.dedup.enabled = False
        settings.ensure_directories()
        container = ServiceContainer(settings)
        try:
            app = create_app(settings, container=container, start_background=False)
            return app.openapi()
        finally:
            container.db.close()


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
