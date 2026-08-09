from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from ..classifier import classify_result
from ..discovery_contracts import DiscoveryError
from ..discovery_transport import (
    AttemptFailure,
    AttemptsExhausted,
    DiscoveryTransport,
)
from ..discovery_transforms import (
    _pixiv_first_media_args,
    parse_discovery_output,
    search_site,
    validate_discovery_args,
)
from ..redaction import redact_text
from ..schemas import ProxyMode, SitePolicy


@dataclass(frozen=True, slots=True)
class GalleryDlDiscoveryPlan:
    site: str
    range_kind: str
    result_limit: int
    range_limit: int
    protocol_args: tuple[str, ...]


def build_gallery_dl_plan(
    *,
    site: str,
    range_kind: str | None,
    limit: int,
    range_limit: int | None,
    extra_args: list[str],
) -> GalleryDlDiscoveryPlan:
    """Build the extractor protocol without touching transport or mutable state."""
    spec = search_site(site)
    values = validate_discovery_args(extra_args)
    if spec.site == "pixiv":
        values = _pixiv_first_media_args(values)
    effective_range = range_kind or spec.search_range
    option = {
        "file": "--range",
        "post": "--post-range",
        "child": "--child-range",
    }[effective_range]
    effective_limit = int(limit)
    extractor_limit = effective_limit if range_limit is None else int(range_limit)
    return GalleryDlDiscoveryPlan(
        site=spec.site,
        range_kind=effective_range,
        result_limit=effective_limit,
        range_limit=extractor_limit,
        protocol_args=(
            "--dump-json",
            option,
            f"1-{extractor_limit}",
            *values,
        ),
    )


class GalleryDlDiscoveryAdapter:
    """Shared gallery-dl subprocess adapter for ordinary discovery sources."""

    def __init__(self, transport: DiscoveryTransport) -> None:
        self.transport = transport

    async def search(
        self,
        *,
        site: str,
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
        spec = search_site(site)
        return await self.discover_url(
            site=spec.site,
            url=spec.search_url(keyword),
            keyword=keyword,
            limit=limit,
            range_kind=spec.search_range,
            range_limit=None,
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
        site: str,
        url: str,
        keyword: str | None,
        limit: int,
        range_kind: str | None,
        range_limit: int | None,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        credentials_ref: str | None,
        cookies_file: str | None,
        config_file: str | None,
        extra_args: list[str],
        timeout_seconds: float,
    ) -> dict[str, Any]:
        plan = build_gallery_dl_plan(
            site=site,
            range_kind=range_kind,
            limit=limit,
            range_limit=range_limit,
            extra_args=extra_args,
        )
        mode: ProxyMode = proxy_mode or policy.proxy_mode
        secure_search = keyword is not None

        async def capture(attempt):
            operation_dir = self.transport.operation_directory(attempt.operation_id)
            try:
                result = await self.transport.capture(
                    attempt.operation_id,
                    url=url,
                    output_dir=str(operation_dir),
                    proxy_url=attempt.lease.endpoint if attempt.lease else None,
                    http_timeout=policy.http_timeout,
                    gallery_retries=policy.gallery_retries,
                    task_timeout=timeout_seconds,
                    cookies_file=cookies_file,
                    config_file=config_file,
                    credentials_ref=credentials_ref,
                    extra_args=list(plan.protocol_args),
                )
            except (FileNotFoundError, ValueError) as exc:
                raise DiscoveryError(
                    "discovery_configuration",
                    redact_text(exc, limit=1000),
                ) from exc

            decision = classify_result(
                result.exit_code,
                result.stderr,
                cancelled=False,
                timed_out=result.timed_out,
            )
            if decision.error_class != "success":
                raise AttemptFailure(
                    decision.message,
                    error_class=decision.error_class,
                    retryable=decision.retryable,
                    proxy_fault=decision.proxy_fault,
                    auth_context=result.stderr,
                )

            try:
                candidates, authors = parse_discovery_output(
                    plan.site,
                    result.stdout,
                    source_url=url,
                    limit=plan.result_limit,
                )
            except DiscoveryError as exc:
                safe_message = redact_text(exc.message, limit=1000)
                parser_decision = classify_result(
                    1,
                    f"{result.stderr}\n{safe_message}",
                )
                details: dict[str, Any] = {"public_code": exc.code}
                if isinstance(exc.details, dict):
                    errors = exc.details.get("errors")
                    if isinstance(errors, list):
                        details["errors"] = [
                            redact_text(item, limit=500) for item in errors[:5]
                        ]
                raise AttemptFailure(
                    safe_message,
                    error_class=parser_decision.error_class,
                    retryable=parser_decision.retryable,
                    proxy_fault=parser_decision.proxy_fault,
                    auth_context=result.stderr,
                    details=details,
                ) from exc
            return candidates, authors

        def classify(exc: Exception, _attempt) -> AttemptFailure:
            message = redact_text(exc, limit=1000)
            decision = classify_result(1, message)
            return AttemptFailure(
                message,
                error_class=decision.error_class,
                retryable=decision.retryable,
                proxy_fault=decision.proxy_fault,
            )

        try:
            outcome = await self.transport.execute_with_retries(
                target_url=url,
                policy=policy,
                proxy_mode=proxy_mode,
                operation_prefix="discover",
                secure_target=secure_search,
                operation=capture,
                classify_exception=classify,
                node_tags=list(policy.node_tags),
                acquire_error_fatal=secure_search or mode == "required",
                cleanup=lambda attempt: self.transport.cleanup_operation_directory(
                    attempt.operation_id
                ),
            )
        except AttemptsExhausted as exc:
            failure = exc.failure
            public_code = failure.details.get("public_code")
            if public_code and not failure.retryable:
                details: dict[str, Any] = {
                    "attempts": exc.attempt_count,
                    "message": failure.message,
                    "proxy": exc.proxy,
                }
                if "errors" in failure.details:
                    details["errors"] = failure.details["errors"]
                raise DiscoveryError(
                    str(public_code),
                    failure.message,
                    details=details,
                ) from exc
            if failure.error_class == "authentication":
                await self.transport.notify_auth_failure(
                    plan.site,
                    cookies_file,
                    failure.auth_context or failure.message,
                )
            safe_message = redact_text(failure.message, limit=1000)
            raise DiscoveryError(
                (
                    "authentication"
                    if failure.error_class == "authentication"
                    else "discovery_failed"
                ),
                safe_message,
                details={
                    "attempts": exc.attempt_count,
                    "message": safe_message,
                    "proxy": exc.proxy,
                },
            ) from exc

        candidates, authors = outcome.value
        return {
            "site": plan.site,
            "keyword": keyword,
            "search_url": url,
            "candidate_count": len(candidates),
            "author_count": len(authors),
            "candidates": candidates,
            "authors": authors,
            "proxy": outcome.proxy,
            "attempts": outcome.attempts,
        }


class PawchiveDiscoveryAdapter:
    """Pawchive range policy layered on the common gallery-dl transport."""

    def __init__(self, gallery_dl: GalleryDlDiscoveryAdapter) -> None:
        self.gallery_dl = gallery_dl

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
        spec = search_site("pawchive")
        return await self.gallery_dl.discover_url(
            site=spec.site,
            url=spec.search_url(keyword),
            keyword=keyword,
            limit=limit,
            range_kind="child",
            range_limit=limit * 10,
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
        effective_range = range_kind
        if effective_range is None:
            effective_range = (
                "child" if urlsplit(url).path.startswith("/artists") else "post"
            )
        range_limit = limit * 10 if effective_range == "child" else limit
        return await self.gallery_dl.discover_url(
            site="pawchive",
            url=url,
            keyword=keyword,
            limit=limit,
            range_kind=effective_range,
            range_limit=range_limit,
            policy=policy,
            proxy_mode=proxy_mode,
            credentials_ref=credentials_ref,
            cookies_file=cookies_file,
            config_file=config_file,
            extra_args=extra_args,
            timeout_seconds=timeout_seconds,
        )
