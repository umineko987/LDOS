from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Callable, Literal

from fastapi import APIRouter, Depends

from ..discovery import (
    DiscoveryError,
    canonical_gallery_address,
    danbooru_alias_terms,
    discovery_addresses,
    exhentai_tag_facets,
    merge_alias_search_results,
    search_site,
    search_site_catalog,
    validate_discovery_args,
)
from ..redaction import redact_text
from ..schemas import SearchRequest
from .dependencies import get_service
from .errors import ApiError
from .request_inputs import allowed_request_files, managed_request_credentials
from .validation import validate_network_target

_ALIAS_LOOKUP_WAIT_SECONDS = 30.0
_search_logger = logging.getLogger("gdl_backend.search")

_DESKTOP_SEARCH_SOURCE_LIMIT = 5
_DESKTOP_SEARCH_CANDIDATE_LIMIT = 1_000
_DESKTOP_SEARCH_CANDIDATE_BYTES = 8 * 1024 * 1024
_DESKTOP_SEARCH_RELATED_PROFILE_LIMIT = 80
_DESKTOP_SEARCH_RELATED_PROFILE_BYTES = 512 * 1024
_DESKTOP_SEARCH_FACET_LIMIT = 32
_DESKTOP_SEARCH_FACET_BYTES = 1024 * 1024


@dataclass(frozen=True)
class SearchExecutionPlan:
    execution_sites: tuple[str, ...]
    implicit_danbooru: bool
    alias_search_sites: frozenset[str]
    needs_artist_directory: bool
    options: dict[str, dict[str, Any]]


def _effective_search_options(body: SearchRequest, site: str) -> dict[str, Any]:
    """Project one source's effective options without mutating the request."""

    canonical_options: dict[str, Any] = {}
    for key, value in body.source_options.items():
        canonical = search_site(key).site
        if canonical in canonical_options:
            raise ValueError(f"source_options 重复配置来源: {canonical}")
        canonical_options[canonical] = value
    specific = canonical_options.get(site)

    def choose(name: str):
        if specific is not None and name in specific.model_fields_set:
            return getattr(specific, name)
        return getattr(body, name)

    return {
        "proxy_mode": choose("proxy_mode"),
        "credentials_ref": choose("credentials_ref"),
        "cookies_file": choose("cookies_file"),
        "config_file": choose("config_file"),
        "search_extra_args": [
            *body.search_extra_args,
            *(specific.search_extra_args if specific is not None else []),
        ],
        "timeout_seconds": choose("timeout_seconds"),
    }


def _build_search_plan(body: SearchRequest) -> SearchExecutionPlan:
    """Canonicalize requested sites and derive the deterministic execution plan."""

    sites: list[str] = []
    for value in body.sites:
        canonical = search_site(value).site
        if canonical not in sites:
            sites.append(canonical)
    execution_sites = list(sites)
    implicit_danbooru = (
        "danbooru" not in execution_sites
        and any(site in {"twitter", "pixiv"} for site in execution_sites)
    )
    if implicit_danbooru:
        execution_sites.insert(0, "danbooru")
    alias_search_sites = frozenset({"exhentai", "pawchive"})
    needs_artist_directory = "danbooru" in execution_sites or any(
        site in alias_search_sites for site in execution_sites
    )
    option_sites = list(execution_sites)
    if needs_artist_directory and "danbooru" not in option_sites:
        option_sites.append("danbooru")
    options = {
        site: _effective_search_options(body, site) for site in option_sites
    }
    return SearchExecutionPlan(
        execution_sites=tuple(execution_sites),
        implicit_danbooru=implicit_danbooru,
        alias_search_sites=alias_search_sites,
        needs_artist_directory=needs_artist_directory,
        options=options,
    )


def _aggregate_search_result(
    *,
    keyword: str,
    sources: list[dict[str, Any]],
    related_profiles: list[dict[str, Any]],
    enrichment_errors: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build the public search response from already ordered source results."""

    return {
        "keyword": keyword,
        "source_count": len(sources),
        "address_count": sum(len(source["addresses"]) for source in sources),
        "weak_evidence_count": sum(
            len(source["weak_evidence"]) for source in sources
        ),
        "sources": sources,
        "related_profiles": related_profiles,
        "enrichment_errors": enrichment_errors,
        "selection_contract": {
            "field": "sources[].addresses[]",
            "weak_evidence_field": "sources[].weak_evidence[]",
            "default_visibility": "addresses_only",
            "execution_order": "source_then_address",
            "address_execution": "media_parallel",
        },
        "tag_filter_contract": {
            "source": "exhentai",
            "facets_field": "sources[].tag_facets[]",
            "tags_field": "sources[].addresses[].metadata.tags[]",
            "same_namespace": "or",
            "across_namespaces": "and",
            "exclusions": "take_precedence",
        },
    }


async def _perform_search(body: SearchRequest, container: Any) -> dict[str, Any]:
    try:
        plan = _build_search_plan(body)
    except ValueError as exc:
        raise ApiError(422, "invalid_search", str(exc)) from exc

    execution_sites = list(plan.execution_sites)
    implicit_danbooru = plan.implicit_danbooru
    alias_search_sites = plan.alias_search_sites
    needs_artist_directory = plan.needs_artist_directory
    options = plan.options

    # One artist-directory lookup shared by the danbooru source (author
    # merging) and the EH/Pawchive alias expansion below.
    artist_directory_task: asyncio.Task | None = None
    if needs_artist_directory:

        async def _artist_directory_lookup() -> dict[str, Any]:
            option = options["danbooru"]
            credentials_ref, cookies_value, config_value = managed_request_credentials(
                container,
                "danbooru",
                credentials_ref=option["credentials_ref"],
                cookies_file=option["cookies_file"],
                config_file=option["config_file"],
            )
            cookies, config_file = allowed_request_files(
                container,
                cookies_file=cookies_value,
                config_file=config_value,
            )
            return await container.discovery.search_danbooru_artists(
                keyword=body.keyword,
                limit=body.limit,
                policy=container.policy_for("danbooru"),
                proxy_mode=option["proxy_mode"],
                credentials_ref=credentials_ref,
                cookies_file=str(cookies) if cookies else None,
                config_file=str(config_file) if config_file else None,
                timeout_seconds=option["timeout_seconds"],
            )

        artist_directory_task = asyncio.create_task(_artist_directory_lookup())

    async def run_source(order: int, site: str) -> dict[str, Any]:
        spec = search_site(site)
        option = options[site]
        if site in {"twitter", "pixiv"}:
            # Account discovery for X and Pixiv is intentionally sourced from
            # Danbooru's curated artist URLs. Their native searches are
            # work-oriented / unstable and create false negatives here.
            return {
                "order": order,
                "site": site,
                "status": "succeeded",
                "search_url": None,
                "search_strategy": "danbooru_artist_urls",
                "evidence_count": 0,
                "preview_count": 0,
                "preview_missing_count": 0,
                "address_count": 0,
                "addresses": [],
                "weak_evidence_count": 0,
                "weak_evidence": [],
                "tag_facets": [],
                "proxy": None,
                "attempts": 0,
                "error": None,
                "enrichment_errors": [],
                "auth": container.auth.status(site),
            }
        try:
            search_url = spec.search_url(body.keyword)
            policy = container.policy_for(site)
            mode = option["proxy_mode"] or policy.proxy_mode
            container.network_validator.validate_static(search_url)
            if mode == "direct":
                await asyncio.to_thread(
                    validate_network_target,
                    search_url,
                    container.settings.server.allow_private_targets,
                    strict=container.settings.server.strict_target_dns,
                )
            credentials_ref, cookies_value, config_value = managed_request_credentials(
                container,
                site,
                credentials_ref=option["credentials_ref"],
                cookies_file=option["cookies_file"],
                config_file=option["config_file"],
            )
            cookies, config_file = allowed_request_files(
                container,
                cookies_file=cookies_value,
                config_file=config_value,
            )
            validate_discovery_args(option["search_extra_args"])
            container.gallery.validate_args(option["search_extra_args"])
            source_enrichment_errors: list[dict[str, str]] = []

            async def _search_term(term: str) -> dict[str, Any]:
                return await container.discovery.search(
                    site=site,
                    keyword=term,
                    limit=body.limit,
                    policy=policy,
                    proxy_mode=option["proxy_mode"],
                    credentials_ref=credentials_ref,
                    cookies_file=str(cookies) if cookies else None,
                    config_file=str(config_file) if config_file else None,
                    extra_args=option["search_extra_args"],
                    timeout_seconds=option["timeout_seconds"],
                )

            # Start the primary query before waiting for alias enrichment so
            # the optional directory lookup never delays native search.
            primary_task = asyncio.create_task(_search_term(body.keyword))

            alias_terms: list[str] = []
            if site in alias_search_sites and artist_directory_task is not None:
                try:
                    artist_result = await asyncio.wait_for(
                        asyncio.shield(artist_directory_task),
                        timeout=_ALIAS_LOOKUP_WAIT_SECONDS,
                    )
                    alias_terms = danbooru_alias_terms(artist_result, body.keyword)
                except asyncio.TimeoutError:
                    source_enrichment_errors.append(
                        {
                            "stage": "danbooru_alias_lookup",
                            "message": (
                                "Danbooru 画师目录查询超过 "
                                f"{_ALIAS_LOOKUP_WAIT_SECONDS:g}s，已跳过别名扩搜"
                            ),
                        }
                    )
                except Exception as exc:
                    source_enrichment_errors.append(
                        {
                            "stage": "danbooru_alias_lookup",
                            "message": redact_text(
                                exc.message
                                if isinstance(exc, DiscoveryError)
                                else exc,
                                limit=1000,
                            ),
                        }
                    )

            alias_outcomes = await asyncio.gather(
                *(_search_term(term) for term in alias_terms),
                return_exceptions=True,
            )
            result = await primary_task
            if alias_terms:
                alias_results: list[tuple[str, dict[str, Any]]] = []
                for term, outcome in zip(alias_terms, alias_outcomes):
                    if isinstance(outcome, BaseException):
                        source_enrichment_errors.append(
                            {
                                "stage": "danbooru_alias_search",
                                "message": redact_text(
                                    f"{term}: "
                                    + str(
                                        outcome.message
                                        if isinstance(outcome, DiscoveryError)
                                        else outcome
                                    ),
                                    limit=1000,
                                ),
                            }
                        )
                    else:
                        alias_results.append((term, outcome))
                result = merge_alias_search_results(
                    body.keyword,
                    result,
                    alias_results,
                    limit=body.limit,
                )
            if site == "exhentai":
                try:
                    result = await container.discovery.enrich_exhentai_previews(
                        result,
                        policy=container.policy_for(site),
                        proxy_mode=option["proxy_mode"],
                        timeout_seconds=option["timeout_seconds"],
                    )
                except Exception as exc:
                    result["preview_count"] = int(result.get("preview_count") or 0)
                    result["preview_missing_count"] = max(
                        0,
                        int(
                            result.get("candidate_count")
                            or len(result.get("candidates") or [])
                        )
                        - result["preview_count"],
                    )
                    source_enrichment_errors.append(
                        {
                            "stage": "exhentai_gallery_previews",
                            "message": redact_text(
                                exc.message if isinstance(exc, DiscoveryError) else exc,
                                limit=1000,
                            ),
                        }
                    )
            if site == "danbooru" and artist_directory_task is not None:
                try:
                    artist_result = await artist_directory_task
                    merged_authors = list(result.get("authors") or [])
                    author_by_key = {
                        str(
                            author.get("works_url")
                            or author.get("url")
                            or author.get("name")
                        ): author
                        for author in merged_authors
                    }
                    for author in artist_result.get("authors") or []:
                        key = str(
                            author.get("works_url")
                            or author.get("url")
                            or author.get("name")
                        )
                        existing = author_by_key.get(key)
                        if existing is None:
                            merged_authors.append(author)
                            author_by_key[key] = author
                            continue
                        # Prefer the structured directory identity over a
                        # post-derived author with the same works URL.
                        for field in (
                            "id",
                            "name",
                            "display_name",
                            "url",
                            "works_url",
                            "other_names",
                            "group_name",
                            "origin",
                        ):
                            value = author.get(field)
                            if value not in (None, "", []):
                                existing[field] = value
                    result["authors"] = merged_authors
                except Exception as exc:
                    source_enrichment_errors.append(
                        {
                            "stage": "danbooru_artist_directory",
                            "message": redact_text(
                                exc.message if isinstance(exc, DiscoveryError) else exc,
                                limit=1000,
                            ),
                        }
                    )
            discovered_addresses = discovery_addresses(
                site,
                result,
                keyword=body.keyword,
                limit=body.limit,
            )
            addresses = [
                address
                for address in discovered_addresses
                if address.get("confidence") != "weak_evidence"
            ]
            weak_evidence = [
                address
                for address in discovered_addresses
                if address.get("confidence") == "weak_evidence"
            ]
            tag_facets = (
                exhentai_tag_facets(discovered_addresses)
                if site == "exhentai"
                else []
            )
            return {
                "order": order,
                "site": site,
                "status": "partial" if source_enrichment_errors else "succeeded",
                "search_url": result.get("search_url"),
                "alias_keywords": list(result.get("alias_keywords") or []),
                "evidence_count": result.get("candidate_count", 0),
                "preview_count": result.get("preview_count", 0),
                "preview_missing_count": result.get("preview_missing_count", 0),
                "address_count": len(addresses),
                "addresses": addresses,
                "weak_evidence_count": len(weak_evidence),
                "weak_evidence": weak_evidence,
                "tag_facets": tag_facets,
                "proxy": result.get("proxy"),
                "attempts": result.get("attempts", 0),
                "error": None,
                "enrichment_errors": source_enrichment_errors,
                "auth": container.auth.status(site),
            }
        except Exception as exc:
            code = exc.code if isinstance(exc, DiscoveryError) else "invalid_search_source"
            message = exc.message if isinstance(exc, DiscoveryError) else str(exc)
            details = (
                exc.details
                if isinstance(exc, DiscoveryError) and isinstance(exc.details, dict)
                else {}
            )
            return {
                "order": order,
                "site": site,
                "status": "failed",
                "search_url": spec.search_url(body.keyword),
                "evidence_count": 0,
                "preview_count": 0,
                "preview_missing_count": 0,
                "address_count": 0,
                "addresses": [],
                "weak_evidence_count": 0,
                "weak_evidence": [],
                "tag_facets": [],
                "proxy": details.get("proxy"),
                "attempts": int(details.get("attempts") or 0),
                "error": {
                    "code": code,
                    "message": redact_text(message, limit=1000),
                },
                "auth": container.auth.status(site),
            }

    sources = list(
        await asyncio.gather(
            *(run_source(order, site) for order, site in enumerate(execution_sites))
        )
    )
    if artist_directory_task is not None:
        # Retrieve or cancel the shared task after all guarded consumers so a
        # timed-out run never leaves an unretrieved exception behind.
        if not artist_directory_task.done():
            artist_directory_task.cancel()
        try:
            await artist_directory_task
        except (Exception, asyncio.CancelledError):
            pass
    source_by_site = {source["site"]: source for source in sources}
    related_profiles: list[dict[str, Any]] = []
    enrichment_errors: list[dict[str, Any]] = [
        {"source": source["site"], **error}
        for source in sources
        for error in source.get("enrichment_errors") or []
    ]
    danbooru = source_by_site.get("danbooru")
    if danbooru is not None and (danbooru["addresses"] or danbooru["weak_evidence"]):
        artist_names = [
            str(address.get("tag") or "")
            for address in [*danbooru["addresses"], *danbooru["weak_evidence"]]
            if address.get("address_type") == "artist_tag"
        ]
        if artist_names:
            try:
                profiles, profile_errors = (
                    await container.discovery.danbooru_artist_profiles(
                        artist_names,
                        policy=container.policy_for("danbooru"),
                        proxy_mode=options["danbooru"]["proxy_mode"],
                        limit=body.limit,
                    )
                )
                enrichment_errors.extend(
                    {"source": "danbooru", **error} for error in profile_errors
                )
            except Exception as exc:
                profiles = []
                enrichment_errors.append(
                    {
                        "source": "danbooru",
                        "artist": "*",
                        "message": redact_text(
                            exc.message if isinstance(exc, DiscoveryError) else exc,
                            limit=1000,
                        ),
                    }
                )
            danbooru_errors = [
                error
                for error in enrichment_errors
                if error.get("source") == "danbooru"
            ]
            if danbooru_errors:
                danbooru["status"] = "partial"
                danbooru["enrichment_errors"] = danbooru_errors
            profile_by_name = {
                str(profile["name"]): profile for profile in profiles
            }
            for address in [*danbooru["addresses"], *danbooru["weak_evidence"]]:
                profile = profile_by_name.get(str(address.get("tag") or ""))
                if profile is None:
                    continue
                address["danbooru_artist"] = {
                    key: profile.get(key)
                    for key in (
                        "id",
                        "name",
                        "other_names",
                        "group_name",
                        "profile_url",
                    )
                }
                address["related_profiles"] = profile["related_profiles"]
                for related in profile["related_profiles"]:
                    item = {
                        **related,
                        "artist_id": profile["id"],
                        "artist_name": profile["name"],
                        "origin": "danbooru_artist_url",
                    }
                    related_profiles.append(item)
                    crawl_site = related.get("crawl_site")
                    crawl_url = related.get("crawl_url")
                    if (
                        not related.get("active", True)
                        or crawl_site not in source_by_site
                        or not crawl_url
                    ):
                        continue
                    crawl_url = canonical_gallery_address(crawl_site, crawl_url)
                    target = source_by_site[crawl_site]
                    existing = next(
                        (
                            candidate
                            for candidate in target["addresses"]
                            if canonical_gallery_address(
                                crawl_site,
                                candidate.get("url") or "",
                            )
                            == crawl_url
                        ),
                        None,
                    )
                    weak_existing = next(
                        (
                            candidate
                            for candidate in target["weak_evidence"]
                            if canonical_gallery_address(
                                crawl_site,
                                candidate.get("url") or "",
                            )
                            == crawl_url
                        ),
                        None,
                    )
                    if existing is not None:
                        origins = list(
                            existing.get("origins")
                            or [existing.get("origin", "site_search")]
                        )
                        if "danbooru_artist_url" not in origins:
                            origins.append("danbooru_artist_url")
                        existing["origins"] = origins
                        existing["confidence"] = "verified"
                        reasons = list(existing.get("evidence_reasons") or [])
                        if "danbooru_artist_url" not in reasons:
                            reasons.append("danbooru_artist_url")
                        existing["evidence_reasons"] = reasons
                        related_artists = existing.setdefault("related_artists", [])
                        if profile["name"] not in related_artists:
                            related_artists.append(profile["name"])
                        continue
                    if weak_existing is not None:
                        target["weak_evidence"].remove(weak_existing)
                        prior_origin = weak_existing.get("origin", "site_search")
                        weak_existing["origin"] = "danbooru_artist_url"
                        weak_existing["origins"] = list(
                            dict.fromkeys([prior_origin, "danbooru_artist_url"])
                        )
                        weak_existing["confidence"] = "verified"
                        reasons = list(weak_existing.get("evidence_reasons") or [])
                        if "danbooru_artist_url" not in reasons:
                            reasons.append("danbooru_artist_url")
                        weak_existing["evidence_reasons"] = reasons
                        weak_existing["related_artists"] = list(
                            dict.fromkeys(
                                [
                                    *weak_existing.get("related_artists", []),
                                    profile["name"],
                                ]
                            )
                        )
                        target["addresses"].append(weak_existing)
                        if target["status"] == "failed":
                            target["status"] = "partial"
                        continue
                    if len(target["addresses"]) >= body.limit:
                        continue
                    target["addresses"].append(
                        {
                            "id": (
                                f"{crawl_site}:danbooru:{profile['id']}:"
                                f"{len(target['addresses']) + 1}"
                            ),
                            "source": crawl_site,
                            "address_type": "account",
                            "label": profile["name"],
                            "url": crawl_url,
                            "profile_url": related["url"],
                            "origin": "danbooru_artist_url",
                            "confidence": "verified",
                            "evidence_reasons": ["danbooru_artist_url"],
                            "related_artists": [profile["name"]],
                        }
                    )
                    if target["status"] == "failed":
                        target["status"] = "partial"
            for source in sources:
                source["address_count"] = len(source["addresses"])
                source["weak_evidence_count"] = len(source["weak_evidence"])

    # X/Pixiv discovery is wholly dependent on the Danbooru artist entry. An
    # upstream failure must be surfaced as partial rather than a clean empty
    # result for either affected source.
    danbooru_upstream_errors = [
        error for error in enrichment_errors if error.get("source") == "danbooru"
    ]
    if danbooru is not None and danbooru.get("status") == "failed":
        danbooru_upstream_errors.append(
            {
                "source": "danbooru",
                "stage": "danbooru_search",
                "message": ((danbooru.get("error") or {}).get("message"))
                or "Danbooru 搜索失败",
            }
        )
    if danbooru_upstream_errors:
        detail = "; ".join(
            str(error.get("message") or error.get("stage") or "")[:200]
            for error in danbooru_upstream_errors[:3]
        )
        for affected in ("twitter", "pixiv"):
            target = source_by_site.get(affected)
            if target is None or target["addresses"]:
                continue
            if target["status"] == "succeeded":
                target["status"] = "partial"
            target["enrichment_errors"] = [
                *(target.get("enrichment_errors") or []),
                {
                    "stage": "danbooru_account_discovery",
                    "message": (
                        "Danbooru 画师条目查询失败，本次未完成账号发现"
                        "（通常重试搜索即可恢复）：" + detail
                    ),
                },
            ]

    if implicit_danbooru:
        sources = [source for source in sources if source["site"] != "danbooru"]
    for order, source in enumerate(sources):
        source["order"] = order
    for source in sources:
        if source.get("status") == "succeeded":
            continue
        _search_logger.warning(
            "search source issue site=%s status=%s error_code=%s enrichment_stages=[%s]",
            source.get("site"),
            source.get("status"),
            (source.get("error") or {}).get("code"),
            ",".join(
                str(item.get("stage") or "unknown")[:64]
                for item in source.get("enrichment_errors") or []
            ),
        )

    return _aggregate_search_result(
        keyword=body.keyword,
        sources=sources,
        related_profiles=related_profiles,
        enrichment_errors=enrichment_errors,
    )


def _bounded_desktop_rows(
    values: list[Any],
    projector: Callable[[Any], dict[str, Any]],
    *,
    maximum_count: int,
    maximum_bytes: int,
) -> tuple[list[dict[str, Any]], int, bool]:
    rows: list[dict[str, Any]] = []
    used_bytes = 0
    for value in values:
        if len(rows) >= maximum_count:
            break
        row = projector(value)
        row_bytes = len(
            json.dumps(
                row,
                ensure_ascii=True,
                separators=(",", ":"),
            ).encode("ascii")
        ) + 1
        if used_bytes + row_bytes > maximum_bytes:
            break
        rows.append(row)
        used_bytes += row_bytes
    return rows, used_bytes, len(rows) < len(values)


def _desktop_search_candidate(value: Any) -> dict[str, Any]:
    candidate = value if isinstance(value, dict) else {}
    projected: dict[str, Any] = {}
    limits = {
        "id": 200,
        "url": 8192,
        "address_type": 100,
        "label": 200,
        "tag": 200,
        "title": 200,
        "confidence": 32,
        "origin": 64,
        "thumbnail_url": 2048,
    }
    for key, limit in limits.items():
        field = candidate.get(key)
        if field is not None:
            projected[key] = str(field)[:limit]
    if isinstance(candidate.get("media_count"), int):
        projected["media_count"] = max(0, candidate["media_count"])
    reasons = candidate.get("evidence_reasons")
    projected["evidence_reasons"] = [
        str(item)[:80] for item in reasons[:12] if item is not None
    ] if isinstance(reasons, list) else []
    profiles = candidate.get("related_profiles")
    projected["related_profile_count"] = (
        min(len(profiles), 1_000) if isinstance(profiles, list) else 0
    )
    metadata = candidate.get("metadata")
    tags = metadata.get("tags") if isinstance(metadata, dict) else None
    projected["metadata"] = {
        "tags": [str(item)[:180] for item in tags[:160] if item is not None]
        if isinstance(tags, list) else []
    }
    return projected


def _desktop_search_facet(value: Any) -> dict[str, Any]:
    facet = value if isinstance(value, dict) else {}
    tags = facet.get("tags")
    return {
        "namespace": str(facet.get("namespace") or "")[:80],
        "label": str(facet.get("label") or "")[:80],
        "gallery_count": (
            facet.get("gallery_count")
            if isinstance(facet.get("gallery_count"), int)
            else 0
        ),
        "tags": [
            {
                "tag": str(item.get("tag") or "")[:180],
                "count": item.get("count") if isinstance(item.get("count"), int) else 0,
            }
            for item in tags[:160]
            if isinstance(item, dict)
        ],
    }


def _desktop_search_profile(value: Any) -> dict[str, Any]:
    profile = value if isinstance(value, dict) else {}
    return {
        "artist_name": str(profile.get("artist_name") or "")[:100],
        "platform": str(profile.get("platform") or "")[:40],
        "url": str(profile.get("url") or "")[:2048],
    }


def _desktop_search_response(value: dict[str, Any]) -> dict[str, Any]:
    projected_sources: list[dict[str, Any]] = []
    sources = value.get("sources")
    source_rows = (
        sources[:_DESKTOP_SEARCH_SOURCE_LIMIT] if isinstance(sources, list) else []
    )
    projection_truncated = (
        isinstance(sources, list) and len(sources) > _DESKTOP_SEARCH_SOURCE_LIMIT
    )
    remaining_candidates = _DESKTOP_SEARCH_CANDIDATE_LIMIT
    remaining_candidate_bytes = _DESKTOP_SEARCH_CANDIDATE_BYTES
    remaining_facets = _DESKTOP_SEARCH_FACET_LIMIT
    remaining_facet_bytes = _DESKTOP_SEARCH_FACET_BYTES
    for raw_source in source_rows:
        source = raw_source if isinstance(raw_source, dict) else {}
        error = source.get("error") if isinstance(source.get("error"), dict) else {}
        auth = source.get("auth") if isinstance(source.get("auth"), dict) else {}
        aliases = source.get("alias_keywords")
        facets = source.get("tag_facets")
        enrichment_errors = source.get("enrichment_errors")
        address_values = source.get("addresses")
        address_rows = address_values if isinstance(address_values, list) else []
        projected_addresses, address_bytes, addresses_truncated = _bounded_desktop_rows(
            address_rows,
            _desktop_search_candidate,
            maximum_count=remaining_candidates,
            maximum_bytes=remaining_candidate_bytes,
        )
        remaining_candidates -= len(projected_addresses)
        remaining_candidate_bytes -= address_bytes
        weak_values = source.get("weak_evidence")
        weak_rows = weak_values if isinstance(weak_values, list) else []
        projected_weak, weak_bytes, weak_truncated = _bounded_desktop_rows(
            weak_rows,
            _desktop_search_candidate,
            maximum_count=remaining_candidates,
            maximum_bytes=remaining_candidate_bytes,
        )
        remaining_candidates -= len(projected_weak)
        remaining_candidate_bytes -= weak_bytes
        facet_rows = facets if isinstance(facets, list) else []
        projected_facets, facet_bytes, facets_truncated = _bounded_desktop_rows(
            facet_rows,
            _desktop_search_facet,
            maximum_count=remaining_facets,
            maximum_bytes=remaining_facet_bytes,
        )
        remaining_facets -= len(projected_facets)
        remaining_facet_bytes -= facet_bytes
        projection_truncated = projection_truncated or any(
            (addresses_truncated, weak_truncated, facets_truncated)
        )
        projected_sources.append({
            "site": str(source.get("site") or "")[:128],
            "status": str(source.get("status") or "failed")[:32],
            "evidence_count": (
                source.get("evidence_count")
                if isinstance(source.get("evidence_count"), int)
                else 0
            ),
            "preview_count": (
                source.get("preview_count")
                if isinstance(source.get("preview_count"), int)
                else 0
            ),
            "attempts": (
                source.get("attempts")
                if isinstance(source.get("attempts"), int)
                else 0
            ),
            "alias_keywords": [
                str(item)[:80] for item in aliases[:8] if item is not None
            ] if isinstance(aliases, list) else [],
            "error": {
                "code": str(error.get("code") or "")[:128],
                "message": redact_text(error.get("message") or "", limit=500),
            },
            "enrichment_error_count": (
                min(len(enrichment_errors), 1_000)
                if isinstance(enrichment_errors, list)
                else 0
            ),
            "auth": {
                "state": str(auth.get("state") or "unknown")[:32],
                "authorized": auth.get("authorized") is True,
            },
            "tag_facets": projected_facets,
            "addresses": projected_addresses,
            "weak_evidence": projected_weak,
        })
    profiles = value.get("related_profiles")
    profile_rows = (
        [item for item in profiles if isinstance(item, dict)]
        if isinstance(profiles, list)
        else []
    )
    projected_profiles, _, profiles_truncated = _bounded_desktop_rows(
        profile_rows,
        _desktop_search_profile,
        maximum_count=_DESKTOP_SEARCH_RELATED_PROFILE_LIMIT,
        maximum_bytes=_DESKTOP_SEARCH_RELATED_PROFILE_BYTES,
    )
    projection_truncated = projection_truncated or profiles_truncated
    return {
        "response_profile": "desktop",
        "projection_truncated": projection_truncated,
        "candidate_limit": _DESKTOP_SEARCH_CANDIDATE_LIMIT,
        "sources": projected_sources,
        "related_profiles": projected_profiles,
    }


def create_discovery_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    @router.get("/search/sites")
    async def supported_search_sites():
        return {"items": search_site_catalog()}

    @router.get("/search/autocomplete")
    async def search_autocomplete(
        q: str,
        limit: int = 10,
        container: Any = Depends(get_service),
    ):
        # Prefix suggestions let the user resolve aliases explicitly; they do
        # not feed the subsequent search silently.
        query = str(q or "").strip()
        if not query:
            raise ApiError(422, "invalid_autocomplete", "补全关键词不能为空")
        if len(query) > 200:
            raise ApiError(422, "invalid_autocomplete", "补全关键词过长")
        try:
            result = await container.discovery.danbooru_autocomplete(
                query,
                limit=min(max(1, int(limit)), 20),
                policy=container.policy_for("danbooru"),
                proxy_mode=None,
            )
        except DiscoveryError as exc:
            raise ApiError(502, exc.code, exc.message) from exc
        return {
            "query": result["query"],
            "source": "danbooru",
            "items": result["items"],
        }

    @router.post("/search")
    async def search_candidates(
        body: SearchRequest,
        view: Literal["legacy", "desktop"] = "legacy",
        container: Any = Depends(get_service),
    ):
        response = await _perform_search(body, container)
        return _desktop_search_response(response) if view == "desktop" else response

    return router
