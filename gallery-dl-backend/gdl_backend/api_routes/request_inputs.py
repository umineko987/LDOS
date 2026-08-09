from __future__ import annotations

from pathlib import Path
from typing import Any


def allowed_request_files(
    container: Any,
    *,
    cookies_file: str | None,
    config_file: str | None,
) -> tuple[Path | None, Path | None]:
    cookies = container.settings.allowed_file(
        cookies_file,
        container.settings.allowed_cookie_roots,
        "cookies_file",
    )
    config = container.settings.allowed_file(
        config_file,
        container.settings.allowed_config_roots,
        "config_file",
    )
    return cookies, config


def managed_request_credentials(
    container: Any,
    site: str,
    *,
    credentials_ref: str | None,
    cookies_file: str | None,
    config_file: str | None,
) -> tuple[str | None, str | None, str | None]:
    managed = container.auth.credentials_for(site)
    return (
        credentials_ref or managed.get("credentials_ref"),
        cookies_file or managed.get("cookies_file"),
        config_file or managed.get("config_file"),
    )
