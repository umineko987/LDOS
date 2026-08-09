from __future__ import annotations

from typing import Any


class DiscoveryError(RuntimeError):
    """Stable internal error contract projected by the discovery facade and API."""

    def __init__(self, code: str, message: str, *, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details
