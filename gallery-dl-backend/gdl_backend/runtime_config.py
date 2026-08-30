from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from typing import Any, Mapping

from .file_security import write_private_text

_CONFIG_WRITE_LOCK = threading.Lock()


class RuntimeConfigStore:
    """Persist small desktop-owned runtime settings without exposing the config file."""

    def __init__(self, path: Path) -> None:
        self._path = path

    async def update_section(self, section: str, values: Mapping[str, Any]) -> None:
        await asyncio.to_thread(self._update_section_locked, section, dict(values))

    def _update_section_locked(self, section: str, values: dict[str, Any]) -> None:
        with _CONFIG_WRITE_LOCK:
            self._update_section(section, values)

    def _update_section(self, section: str, values: dict[str, Any]) -> None:
        document: dict[str, Any] = {}
        if self._path.is_file():
            loaded = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict):
                raise ValueError("runtime configuration must be a JSON object")
            document = loaded
        current = document.get(section)
        if not isinstance(current, dict):
            current = {}
        current.update(values)
        document[section] = current

        payload = json.dumps(document, indent=2, ensure_ascii=False) + "\n"
        write_private_text(self._path, payload)
