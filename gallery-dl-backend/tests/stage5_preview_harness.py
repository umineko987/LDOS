#!/usr/bin/env python3
"""Tests-only static host for Stage 5 preview Chromium acceptance.

Production ``/ui/`` is mounted by the real ``create_app`` composition. This
module only adds explicit tests-only static mounts for a standalone fixture
host and the production WebUI module tree. It does not add a production API or
inject fixtures into the production registry.
"""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path

import uvicorn
from fastapi.staticfiles import StaticFiles

from gdl_backend.app import ServiceContainer, create_app
from tests.helpers import make_settings


BACKEND_ROOT = Path(__file__).resolve().parents[1]
WEBUI_ROOT = BACKEND_ROOT / "gdl_backend" / "webui"
FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "webui"


def build_harness(root: Path, port: int):
    settings = make_settings(root)
    settings.server.port = port
    container = ServiceContainer(settings)
    app = create_app(settings, container=container, start_background=False)
    app.mount(
        "/__webui__",
        StaticFiles(directory=str(WEBUI_ROOT), html=False),
        name="stage5-production-webui-modules-tests-only",
    )
    app.mount(
        "/__stage5__",
        StaticFiles(directory=str(FIXTURE_ROOT), html=True),
        name="stage5-preview-fixtures-tests-only",
    )
    return app


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18855)
    parser.add_argument("--root", type=Path)
    args = parser.parse_args()
    temporary = None
    if args.root is None:
        temporary = tempfile.TemporaryDirectory(prefix="imageweave-stage5-harness-")
        root = Path(temporary.name)
    else:
        root = args.root
        root.mkdir(parents=True, exist_ok=True)
    try:
        uvicorn.run(build_harness(root, args.port), host="127.0.0.1", port=args.port, log_level="warning")
    finally:
        if temporary is not None:
            temporary.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
