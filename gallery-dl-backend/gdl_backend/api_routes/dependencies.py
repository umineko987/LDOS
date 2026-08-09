from __future__ import annotations

from typing import Any

from fastapi import Request


def get_service(request: Request) -> Any:
    """Resolve the app-owned ServiceContainer for one request."""

    return request.app.state.container
