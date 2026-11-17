#!/usr/bin/env python3
"""Refresh the frozen API migration contract from the reference route models.

Development-only: the Go server embeds the resulting JSON and never imports or
launches the reference API. This command constructs routes, not service state;
it opens no application database and starts no background tasks.
"""
from __future__ import annotations

import importlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "gallery-dl-backend"))


def main() -> None:
    from fastapi import FastAPI

    app = FastAPI(title="LDOS API", version="0.1.0", description="Native Go business service; isolated gallery-dl and inference executors.")
    modules = (
        "diagnostics", "auth", "tasks", "discovery", "crawls", "review",
        "setup", "tagger", "policies", "gallery", "datasets", "atlas",
        "settings", "models", "captions", "dataset_stages", "dataset_exports",
        "proxy", "scheduler", "jobs",
    )
    for name in modules:
        module = importlib.import_module(f"gdl_backend.api_routes.{name}")
        factory = getattr(module, f"create_{name}_router")
        router = factory(None) if name == "diagnostics" else factory()
        app.include_router(router)
    destination = ROOT / "backend/internal/httpapi/openapi.json"
    destination.write_text(json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(app.openapi()['paths'])} API paths to {destination.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
