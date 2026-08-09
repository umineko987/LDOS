from __future__ import annotations

import copy
import re
from collections.abc import Collection, Iterable
from dataclasses import dataclass, field
from typing import Any, Protocol, TypeVar
from urllib.parse import urlsplit

from .redaction import redact_text


@dataclass(slots=True)
class ProxyLease:
    task_id: str
    node_id: str
    endpoint: str
    name: str
    protocol: str
    tags: list[str]
    acquired_at: float
    pool_endpoint: str = field(default="", repr=False)
    pool_token: str = field(default="", repr=False)
    forwarder_key: str = field(default="", repr=False)


@dataclass(slots=True)
class ProxyNodeRecord:
    id: str
    name: str
    protocol: str
    endpoint: str = field(repr=False)
    tags: list[str] = field(default_factory=list)
    healthy: bool = False
    success_count: int = 0
    fail_count: int = 0
    last_latency_ms: float | None = None
    cooldown_until: float = 0.0
    last_error: str = ""


class LeaseCandidate(Protocol):
    id: str
    tags: list[str]
    healthy: bool


CandidateT = TypeVar("CandidateT", bound=LeaseCandidate)
ProbeCacheKey = tuple[str, str, int]


class ProbeTargetViolation(ValueError):
    """A parsed target violates the HTTPS probe policy."""


# Tuple-of-tuples is deliberately immutable: policy results never depend on
# runtime settings, process state, filesystem state or a mutable module registry.
_REGION_ALIASES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("jp", ("jp", "japan", "日本", "东京", "大阪", "🇯🇵")),
    ("hk", ("hk", "hong kong", "香港", "🇭🇰")),
    ("tw", ("tw", "taiwan", "台湾", "台北", "🇹🇼")),
    ("sg", ("sg", "singapore", "新加坡", "狮城", "🇸🇬")),
    ("us", ("us", "usa", "united states", "美国", "洛杉矶", "圣何塞", "🇺🇸")),
    ("kr", ("kr", "korea", "韩国", "首尔", "🇰🇷")),
    ("de", ("de", "germany", "德国", "🇩🇪")),
    ("gb", ("gb", "uk", "united kingdom", "英国", "🇬🇧")),
    ("fr", ("fr", "france", "法国", "🇫🇷")),
    ("ca", ("ca", "canada", "加拿大", "🇨🇦")),
    ("au", ("au", "australia", "澳大利亚", "澳洲", "🇦🇺")),
)
_TOKEN_RE = re.compile(r"[a-z][a-z0-9_-]{1,20}")


def node_tags(name: str, protocol: str, host: str) -> list[str]:
    combined = " ".join([name, protocol, host]).lower()
    tokens = set(_TOKEN_RE.findall(combined))
    tags: set[str] = {protocol.lower(), *tokens}
    for canonical, aliases in _REGION_ALIASES:
        for alias in aliases:
            value = alias.lower()
            if re.fullmatch(r"[a-z][a-z0-9_-]*", value):
                matched = value in tokens
            else:
                matched = value in combined
            if matched:
                tags.add(canonical)
                break
    return sorted(tags)


def probe_cache_key(url: str) -> ProbeCacheKey:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise ValueError("探活地址无法解析") from exc
    scheme = (parsed.scheme or "").lower()
    hostname = parsed.hostname
    if not scheme or not hostname:
        raise ValueError("探活地址必须包含协议和主机名")
    if port is None:
        if scheme == "https":
            port = 443
        elif scheme == "http":
            port = 80
        else:
            raise ValueError("探活地址需要显式端口")
    if not 1 <= port <= 65535:
        raise ValueError("探活端口超出范围")
    return scheme, hostname.lower(), port


def probe_parts(url: str) -> tuple[str, int]:
    parsed = urlsplit(url)
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise ProbeTargetViolation("探活地址必须是带主机名的 https:// URL")
    if parsed.username or parsed.password:
        raise ProbeTargetViolation("探活地址不接受 URL 凭据")
    port = int(parsed.port or 443)
    if not 1 <= port <= 65535:
        raise ProbeTargetViolation("探活端口超出范围")
    return parsed.hostname, port


def public_probe_target(url: str) -> str:
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    port = f":{parsed.port}" if parsed.port and parsed.port != 443 else ""
    return f"https://{host}{port}{parsed.path or '/'}"


def mask_proxy(endpoint: str) -> str:
    try:
        parsed = urlsplit(endpoint)
        host = parsed.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        port = f":{parsed.port}" if parsed.port else ""
        auth = "***@" if parsed.username or parsed.password else ""
        return f"{parsed.scheme}://{auth}{host}{port}"
    except Exception:
        return "[REDACTED_PROXY]"


def safe_source_warning(warning: object, subscription_urls: Iterable[str]) -> str:
    text = str(warning or "")
    for index, url in enumerate(subscription_urls, start=1):
        text = text.replace(url, f"SUBSCRIPTION_URL_{index}")
    return redact_text(text, limit=500)


def select_lease_candidates(
    records: Iterable[CandidateT],
    *,
    node_tags_filter: list[str] | None,
    exclude_ids: set[str] | None,
    allowed_ids: Collection[str] | None,
    probe_before_use: bool,
) -> list[CandidateT]:
    excluded = set(exclude_ids or set())
    allowed_node_ids = (
        None if allowed_ids is None else {str(node_id) for node_id in allowed_ids}
    )
    wanted = {
        str(tag).strip().lower()
        for tag in (node_tags_filter or [])
        if str(tag).strip()
    }
    return [
        record
        for record in records
        if record.id not in excluded
        and (allowed_node_ids is None or record.id in allowed_node_ids)
        and (not wanted or wanted.intersection(record.tags))
        and (probe_before_use or record.healthy)
    ]


def cached_probe_projection(
    cached: tuple[float, dict[str, Any]],
    *,
    now: float,
    ttl_seconds: float,
) -> dict[str, Any] | None:
    if ttl_seconds <= 0:
        return None
    timestamp, probe_result = cached
    age = max(0.0, float(now) - float(timestamp))
    if age >= ttl_seconds:
        return None
    result = copy.deepcopy(probe_result)
    result["cached"] = True
    result["age_seconds"] = age
    return result


def stored_probe_projection(probe_result: dict[str, Any]) -> dict[str, Any]:
    stored = copy.deepcopy(probe_result)
    stored["cached"] = False
    stored.pop("age_seconds", None)
    return stored


def merge_single_probe_projection(
    probe_result: dict[str, Any],
    *,
    node_id: str,
    node_result: dict[str, Any],
) -> dict[str, Any] | None:
    merged = copy.deepcopy(probe_result)
    results = merged.get("results")
    if not isinstance(results, list):
        return None
    matched = False
    for index, item in enumerate(results):
        if isinstance(item, dict) and str(item.get("id") or "") == node_id:
            results[index] = copy.deepcopy(node_result)
            matched = True
    if not matched:
        return None
    merged["total"] = len(results)
    merged["healthy"] = sum(
        1 for item in results if isinstance(item, dict) and item.get("healthy")
    )
    if not merged["healthy"]:
        return None
    merged["cached"] = False
    merged.pop("age_seconds", None)
    return merged


def mark_cached_node_unhealthy(
    probe_result: dict[str, Any],
    *,
    node_id: str,
) -> dict[str, Any] | None:
    updated = copy.deepcopy(probe_result)
    results = updated.get("results")
    if not isinstance(results, list):
        return updated
    matched = False
    for item in results:
        if isinstance(item, dict) and str(item.get("id") or "") == node_id:
            item["healthy"] = False
            matched = True
    if not matched:
        return updated
    updated["healthy"] = sum(
        1 for item in results if isinstance(item, dict) and item.get("healthy")
    )
    return updated if updated["healthy"] else None


def project_node_row(
    record: ProxyNodeRecord,
    *,
    pool_status: dict[str, object],
    running: bool,
    now: float,
) -> dict[str, Any]:
    cooldown_left = float(pool_status.get("cooldown_left") or 0.0)
    eligible = bool(
        running
        and record.healthy
        and cooldown_left <= 0
        and not pool_status.get("leased")
    )
    return {
        "id": record.id,
        "name": record.name,
        "protocol": record.protocol,
        "endpoint": mask_proxy(record.endpoint),
        "healthy": bool(running and record.healthy),
        "retry_eligible": eligible,
        "ref_count": 1 if pool_status.get("leased") else 0,
        "success_count": record.success_count,
        "fail_count": record.fail_count,
        "last_latency_ms": record.last_latency_ms,
        "cooldown_until": now + cooldown_left,
        "last_error": redact_text(record.last_error, limit=300),
        "tags": list(record.tags),
    }


def project_probe_result(
    *,
    node_id: str,
    healthy: bool,
    latency_ms: float,
    error: str,
    endpoint: str,
    target_url: str,
) -> dict[str, Any]:
    return {
        "id": node_id,
        "healthy": bool(healthy),
        "latency_ms": latency_ms if healthy else None,
        "error": error,
        "endpoint": mask_proxy(endpoint),
        "target": public_probe_target(target_url),
    }


def project_pool_status(
    *,
    enabled: bool,
    engine: str,
    auto_start: bool,
    running: bool,
    configured_revision: str,
    active_revision: str | None,
    nodes: list[dict[str, Any]],
    lease_count: int,
    last_error: str,
    transport_core: dict[str, Any],
    source_summary: dict[str, Any],
    probe_cache_entries: int,
    probe_cache_ttl_seconds: float,
) -> dict[str, Any]:
    return {
        "enabled": bool(enabled),
        "engine": engine,
        "managed_by_backend": True,
        "auto_start": bool(auto_start),
        "executable_required": False,
        "running": bool(running),
        "configured_revision": configured_revision,
        "active_revision": active_revision,
        "reload_required": configured_revision != active_revision,
        "total": len(nodes),
        "healthy": sum(1 for node in nodes if node["healthy"]),
        "retry_eligible": sum(1 for node in nodes if node["retry_eligible"]),
        "leases": int(lease_count),
        "last_error": last_error,
        "transport_core": dict(transport_core),
        "sources": dict(source_summary),
        "probe_cache": {
            "entries": int(probe_cache_entries),
            "ttl_seconds": float(probe_cache_ttl_seconds),
        },
        "nodes": nodes,
    }
