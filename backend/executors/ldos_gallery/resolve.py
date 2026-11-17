from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit


def _host(value: str) -> str:
    text = value.strip()
    lower = text.lower()
    starts = [pos for scheme in ("http://", "https://") if (pos := lower.find(scheme)) >= 0]
    plain = text[min(starts) :] if starts else text
    try:
        host = (urlsplit(plain).hostname or "").lower()
    except Exception:
        host = ""
    return host[4:] if host.startswith("www.") else host


def resolve(url: str, gallery_root: Path) -> dict[str, str | bool]:
    # No gallery_dl.main/config.load, extractor iteration, login or extraction.
    from gallery_dl import extractor as module

    module_path = Path(module.__file__).resolve()
    if not module_path.is_relative_to(gallery_root):
        raise RuntimeError(f"加载到错误的 gallery-dl: {module_path}")
    host = _host(url)
    fallback = host or "unknown"
    extractor = module.find(url)
    if extractor is None:
        return dict(site=fallback, subcategory="", extractor="", supported=False, host=host)
    category = str(getattr(extractor, "category", "") or fallback).lower()
    subcategory = str(getattr(extractor, "subcategory", "") or "").lower()
    if host in {"pbs.twimg.com", "video.twimg.com"}:
        category = "twitter"
    elif category in {"generic", "directlink", "recursive"} and host:
        category = host
    return dict(site=category, subcategory=subcategory, extractor=extractor.__class__.__name__,
                supported=True, host=host)
