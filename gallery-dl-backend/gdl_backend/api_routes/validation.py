from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlsplit

from ..discovery import search_site
from .errors import ApiError


def validate_site_name(site: str) -> str:
    value = site.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._:-]{0,127}", value):
        raise ApiError(422, "invalid_site", "site 格式无效")
    return value


def canonical_site_name(site: str) -> str:
    value = validate_site_name(site)
    try:
        return search_site(value).site
    except ValueError:
        return value


def validate_site_match(explicit_site: str, resolved_site: str) -> None:
    try:
        explicit = search_site(explicit_site).site
        resolved = search_site(resolved_site).site
    except ValueError:
        return
    if explicit != resolved:
        raise ValueError(f"site={explicit} 与 URL 提取器站点 {resolved} 不一致")


def validate_idempotency_key(value: str | None) -> str | None:
    if value is None:
        return None
    if len(value) > 200:
        raise ApiError(422, "invalid_idempotency_key", "Idempotency-Key 过长")
    result = value.strip()
    if not result:
        raise ApiError(422, "invalid_idempotency_key", "Idempotency-Key 为空")
    return result


def range_argument_present(args: list[str]) -> bool:
    managed = {
        "--range",
        "--file-range",
        "--image-range",
        "--post-range",
        "--child-range",
        "--chapter-range",
    }
    return any(str(value).split("=", 1)[0] in managed for value in args)


def validate_network_target(
    url: str,
    allow_private: bool,
    *,
    strict: bool = True,
) -> None:
    if allow_private:
        return
    text = url.strip()
    lower = text.lower()
    starts = [pos for pos in (lower.find("http://"), lower.find("https://")) if pos >= 0]
    if starts:
        text = text[min(starts) :]
    parsed = urlsplit(text)
    host = (parsed.hostname or "").strip().lower()
    if not host:
        raise ValueError("目标 URL 缺少主机名")
    if host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
        raise ValueError("目标 URL 指向本机或私有网络")
    try:
        addresses = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError("目标主机 DNS 解析失败") from exc
    resolved_count = 0
    has_global = False
    for entry in addresses:
        address = entry[4][0].split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError as exc:
            if strict:
                raise ValueError("目标主机解析出无法识别的地址") from exc
            continue
        if strict and not ip.is_global:
            raise ValueError(
                f"目标 URL 解析到非公网地址（IPv{ip.version}: {ip}），已拒绝"
            )
        if ip.is_global:
            has_global = True
        resolved_count += 1
    if strict:
        if not resolved_count:
            raise ValueError("目标主机 DNS 未返回任何地址")
        return
    if not has_global:
        raise ValueError("目标 URL 指向本机或私有网络")
