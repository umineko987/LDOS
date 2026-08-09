"""FastAPI router factories used by the application composition root."""

from .auth import create_auth_router
from .diagnostics import create_diagnostics_router
from .proxy import create_proxy_router

__all__ = ["create_auth_router", "create_diagnostics_router", "create_proxy_router"]
