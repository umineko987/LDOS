"""把后端的 OpenAPI 文档写成 src/lib/api/openapi.json（键排序、缩进 2）。

用法：npm run api:snapshot
后端解释器默认是 ../gallery-dl-backend/.venv/bin/python，可用 LDOS_BACKEND_PYTHON 覆盖。
应用在临时目录里构建，不启动后台任务，也不读用户配置。
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

DESKTOP = Path(__file__).resolve().parent.parent
BACKEND = DESKTOP.parent / "gallery-dl-backend"
OUTPUT = DESKTOP / "src" / "lib" / "api" / "openapi.json"

sys.path.insert(0, str(BACKEND))

from gdl_backend.app import ServiceContainer, create_app  # noqa: E402
from gdl_backend.config import AppSettings  # noqa: E402


def build_document(root: Path) -> dict:
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
    settings.ensure_directories()
    (root / "credentials").mkdir(parents=True, exist_ok=True)
    app = create_app(settings, container=ServiceContainer(settings), start_background=False)
    return app.openapi()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="ldos-openapi-") as temp:
        document = build_document(Path(temp))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(document, sort_keys=True, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"openapi-snapshot: {len(document.get('paths', {}))} paths -> {OUTPUT.relative_to(DESKTOP)}")


if __name__ == "__main__":
    main()
