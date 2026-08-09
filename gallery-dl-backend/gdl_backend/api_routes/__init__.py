"""FastAPI router factories used by the application composition root."""

from .diagnostics import create_diagnostics_router

__all__ = ["create_diagnostics_router"]
