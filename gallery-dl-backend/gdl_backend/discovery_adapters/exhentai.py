from __future__ import annotations

import html
import re
from typing import Any, Awaitable, Callable

import requests

from ..classifier import classify_result
from ..discovery_contracts import DiscoveryError
from ..discovery_transport import (
    AttemptFailure,
    AttemptsExhausted,
    DiscoveryTransport,
)
from ..discovery_transforms import (
    _exhentai_directory_candidate,
    _integer,
    _text,
    search_site,
)
from ..redaction import redact_text
from ..schemas import ProxyMode, SitePolicy


GalleryDiscover = Callable[..., Awaitable[dict[str, Any]]]


class ExHentaiDiscoveryAdapter:
    """E-Hentai/ExHentai gallery discovery and gdata preview enrichment."""

    def __init__(
        self,
        transport: DiscoveryTransport,
        *,
        gallery_discover: GalleryDiscover,
    ) -> None:
        self.transport = transport
        self._gallery_discover = gallery_discover

    async def search(
        self,
        *,
        keyword: str,
        limit: int,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        credentials_ref: str | None,
        cookies_file: str | None,
        config_file: str | None,
        extra_args: list[str],
        timeout_seconds: float,
    ) -> dict[str, Any]:
        spec = search_site("exhentai")
        return await self._gallery_discover(
            site=spec.site,
            url=spec.search_url(keyword),
            keyword=keyword,
            limit=limit,
            range_kind=spec.search_range,
            policy=policy,
            proxy_mode=proxy_mode,
            credentials_ref=credentials_ref,
            cookies_file=cookies_file,
            config_file=config_file,
            extra_args=extra_args,
            timeout_seconds=timeout_seconds,
        )

    async def discover_url(
        self,
        *,
        url: str,
        keyword: str | None,
        limit: int,
        range_kind: str | None,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        credentials_ref: str | None,
        cookies_file: str | None,
        config_file: str | None,
        extra_args: list[str],
        timeout_seconds: float,
    ) -> dict[str, Any]:
        if range_kind is None:
            if re.search(r"/(?:g|s|mpv)/", url):
                range_kind = "file"
                limit = 1
            else:
                range_kind = search_site("exhentai").search_range
        return await self._gallery_discover(
            site="exhentai",
            url=url,
            keyword=keyword,
            limit=limit,
            range_kind=range_kind,
            policy=policy,
            proxy_mode=proxy_mode,
            credentials_ref=credentials_ref,
            cookies_file=cookies_file,
            config_file=config_file,
            extra_args=extra_args,
            timeout_seconds=timeout_seconds,
        )

    async def enrich_previews(
        self,
        result: dict[str, Any],
        *,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        candidates = [
            item for item in result.get("candidates") or [] if isinstance(item, dict)
        ]
        pairs: list[tuple[int, str]] = []
        seen: set[int] = set()
        for candidate in candidates:
            gallery_id = _integer(candidate.get("id"))
            metadata = (
                candidate.get("metadata")
                if isinstance(candidate.get("metadata"), dict)
                else {}
            )
            token = _text(metadata.get("gallery_token"), 100)
            if gallery_id is None or not token or gallery_id in seen:
                continue
            pairs.append((gallery_id, token))
            seen.add(gallery_id)
        if not pairs:
            result["preview_count"] = 0
            result["preview_missing_count"] = len(candidates)
            return result

        mode: ProxyMode = proxy_mode or policy.proxy_mode
        request_timeout = max(
            1.0,
            min(float(policy.http_timeout), float(timeout_seconds)),
        )
        target_url = "https://api.e-hentai.org/api.php"
        direct_target_prevalidated = mode == "direct"
        if direct_target_prevalidated:
            await self.transport.validate_direct(target_url)

        async def fetch_batch(batch: list[tuple[int, str]]) -> list[dict[str, Any]]:
            async def request(attempt):
                def request_batch() -> list[dict[str, Any]]:
                    with self.transport.http_session(
                        backend="requests",
                        proxy_url=(attempt.lease.endpoint if attempt.lease else None),
                    ) as session:
                        response = session.request_json(
                            "post",
                            target_url,
                            json_body={
                                "method": "gdata",
                                "gidlist": [list(pair) for pair in batch],
                                "namespace": 1,
                            },
                            timeout=request_timeout,
                            parse_json=False,
                        )
                        if 300 <= response.status_code < 400:
                            raise ValueError(
                                "EH gdata API 返回了未接受的重定向"
                            )
                        response.raw_response.raise_for_status()
                        payload = response.raw_response.json()
                    if not isinstance(payload, dict):
                        raise ValueError("EH gdata API 返回结构无效")
                    if payload.get("error"):
                        raise ValueError(str(payload["error"]))
                    metadata = payload.get("gmetadata")
                    if not isinstance(metadata, list):
                        raise ValueError("EH gdata API 缺少 gmetadata")
                    return [item for item in metadata if isinstance(item, dict)]

                return await self.transport.run_http(request_batch)

            def classify(exc: Exception, attempt) -> AttemptFailure:
                message = redact_text(exc, limit=1000)
                decision = classify_result(1, message)
                response = getattr(exc, "response", None)
                status_code = _integer(getattr(response, "status_code", None))
                transient_request = isinstance(
                    exc,
                    (requests.Timeout, requests.ConnectionError),
                ) or bool(
                    status_code
                    and (status_code in {408, 425, 429} or status_code >= 500)
                )
                retryable = bool(
                    decision.retryable
                    or transient_request
                    or decision.proxy_fault
                )
                proxy_fault = bool(
                    attempt.lease is not None
                    and (decision.proxy_fault or transient_request)
                )
                return AttemptFailure(
                    message,
                    error_class=decision.error_class,
                    retryable=retryable,
                    proxy_fault=proxy_fault,
                )

            try:
                response = await self.transport.execute_with_retries(
                    target_url=target_url,
                    policy=policy,
                    proxy_mode=proxy_mode,
                    operation_prefix="eh-preview",
                    secure_target=True,
                    operation=request,
                    classify_exception=classify,
                    node_tags=list(policy.node_tags),
                    acquire_error_fatal=True,
                    direct_target_prevalidated=direct_target_prevalidated,
                )
            except AttemptsExhausted as exc:
                raise DiscoveryError(
                    "exhentai_preview_lookup_failed",
                    exc.failure.message,
                    details={"attempts": exc.attempts, "proxy": exc.proxy},
                ) from exc
            return response.value

        rows: list[dict[str, Any]] = []
        for offset in range(0, len(pairs), 25):
            rows.extend(await fetch_batch(pairs[offset : offset + 25]))

        row_by_id = {
            str(item.get("gid")): item
            for item in rows
            if _integer(item.get("gid")) is not None and not item.get("error")
        }
        enriched_candidates: list[dict[str, Any]] = []
        merged_authors = list(result.get("authors") or [])
        author_keys = {
            str(author.get("works_url") or author.get("url") or author.get("name"))
            for author in merged_authors
            if isinstance(author, dict)
        }
        preview_count = 0
        for candidate in candidates:
            row = row_by_id.get(str(candidate.get("id")))
            if row is None:
                enriched_candidates.append(candidate)
                continue
            normalized = dict(row)
            for field in ("title", "title_jpn", "uploader"):
                if normalized.get(field) is not None:
                    normalized[field] = html.unescape(str(normalized[field]))
            if isinstance(normalized.get("tags"), list):
                normalized["tags"] = [
                    html.unescape(str(value)) for value in normalized["tags"]
                ]
            enriched, authors = _exhentai_directory_candidate(
                normalized,
                str(candidate.get("url") or result.get("search_url") or ""),
            )
            if enriched is None:
                enriched_candidates.append(candidate)
                continue
            candidate_metadata = (
                candidate.get("metadata")
                if isinstance(candidate.get("metadata"), dict)
                else {}
            )
            enriched["metadata"]["gallery_token"] = candidate_metadata.get(
                "gallery_token"
            )
            if candidate.get("matched_keywords"):
                enriched["matched_keywords"] = candidate["matched_keywords"]
            enriched_candidates.append(enriched)
            preview_count += 1
            for author in authors:
                key = str(
                    author.get("works_url") or author.get("url") or author.get("name")
                )
                if key not in author_keys:
                    author_keys.add(key)
                    merged_authors.append(author)

        result["candidates"] = enriched_candidates
        result["authors"] = merged_authors
        result["candidate_count"] = len(enriched_candidates)
        result["author_count"] = len(merged_authors)
        result["preview_count"] = preview_count
        result["preview_missing_count"] = len(enriched_candidates) - preview_count
        return result
