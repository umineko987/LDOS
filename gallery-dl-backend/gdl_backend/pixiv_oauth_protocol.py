from __future__ import annotations

import io
import pickle
import pickletools
import re
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit


PIXIV_LOGIN_URL_RE = re.compile(r"https://app-api\.pixiv\.net/web/v1/login\?[^\s]+")
# Real refresh tokens and fixtures are tens of bytes. One KiB preserves ample
# compatibility headroom while bounding work before restricted deserialization.
MAX_PIXIV_CACHE_VALUE_BYTES = 1_024


class PixivCacheTokenUnpickler(pickle.Unpickler):
    """Pixiv-specific restricted decoder: globals and persistent IDs are forbidden."""

    def find_class(self, module: str, name: str) -> Any:
        raise pickle.UnpicklingError("Pixiv cache globals are disabled")

    def persistent_load(self, pid: object) -> Any:
        raise pickle.UnpicklingError("Pixiv cache persistent IDs are disabled")


def decode_pixiv_cache_token(value: object) -> str | None:
    """Decode only gallery-dl's pickled None/string and legacy SQLite TEXT forms."""

    if isinstance(value, str):
        if len(value) > MAX_PIXIV_CACHE_VALUE_BYTES:
            return None
        try:
            encoded_size = len(value.encode("utf-8", "strict"))
        except UnicodeError:
            return None
        return value if encoded_size <= MAX_PIXIV_CACHE_VALUE_BYTES else None

    if not isinstance(value, (bytes, bytearray)):
        return None
    if len(value) > MAX_PIXIV_CACHE_VALUE_BYTES:
        return None

    payload = bytes(value)
    try:
        stop_position = next(
            position
            for opcode, _argument, position in pickletools.genops(payload)
            if opcode.name == "STOP"
        )
        if stop_position != len(payload) - 1:
            return None

        # Unpickler can prefetch a complete FRAME past STOP, so validate both
        # pickletools' STOP position and the backing stream.
        stream = io.BytesIO(payload)
        token = PixivCacheTokenUnpickler(stream).load()
        if stream.read(1):
            return None
        if token is None:
            return None
        if not isinstance(token, str) or len(token) > MAX_PIXIV_CACHE_VALUE_BYTES:
            return None
        if len(token.encode("utf-8", "strict")) > MAX_PIXIV_CACHE_VALUE_BYTES:
            return None
        return token
    except Exception:
        # Malformed and prohibited local cache values fail closed and are never logged.
        return None


def find_pixiv_login_url(value: str) -> str:
    match = PIXIV_LOGIN_URL_RE.search(str(value or ""))
    return match.group(0) if match else ""


def pixiv_login_url_is_valid(value: str) -> bool:
    try:
        login = urlsplit(str(value or ""))
    except ValueError:
        return False
    return (
        login.scheme == "https"
        and (login.hostname or "").lower() == "app-api.pixiv.net"
        and login.path == "/web/v1/login"
    )


def pixiv_oauth_callback_is_valid(value: str) -> bool:
    """Preserve the managed-browser callback boundary: exact host/path plus state/code."""

    try:
        parsed = urlsplit(str(value or ""))
        query = parse_qs(parsed.query, keep_blank_values=True)
        codes = query.get("code", ())
        states = query.get("state", ())
        return (
            parsed.scheme == "https"
            and (parsed.hostname or "").lower() == "app-api.pixiv.net"
            and parsed.path == "/web/v1/users/auth/pixiv/callback"
            and len(codes) == 1
            and bool(codes[0].strip())
            and len(states) == 1
            and bool(states[0].strip())
        )
    except ValueError:
        return False


def extract_pixiv_oauth_code(value: str) -> str:
    """Preserve gallery-dl's accepted callback/code input forms without retaining raw input."""

    text = value.strip()
    if not text:
        return ""
    try:
        parsed = urlsplit(text)
        values = parse_qs(parsed.query).get("code")
        if values:
            return values[0].strip()
    except ValueError:
        pass
    match = re.search(r"(?:^|[?&])code=([^&\s]+)", text)
    if match:
        return unquote(match.group(1)).strip()
    return text.rpartition("=")[2].strip() if "=" in text else text
