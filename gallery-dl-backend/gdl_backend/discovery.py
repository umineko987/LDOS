from __future__ import annotations

import asyncio
import shutil
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

import requests
from curl_cffi import requests as curl_requests

from .classifier import FailureDecision, classify_result
from .discovery_adapters.danbooru import (
    DanbooruApiRequestError,
    DanbooruDiscoveryAdapter,
    is_cloudflare_challenge,
)
from .discovery_adapters.exhentai import ExHentaiDiscoveryAdapter
from .discovery_contracts import DiscoveryError
from .discovery_transport import DiscoveryHttpSession, DiscoveryTransport
from .discovery_transforms import (
    _DANBOORU_TAG_CATEGORY_NAMES,
    _DNS_ERROR_CODES,
    _danbooru_artist_queue,
    _danbooru_candidate,
    _exhentai_directory_candidate,
    _integer,
    _pixiv_first_media_args,
    _tag_key,
    _text,
    SearchSiteSpec,
    SITE_SPECS,
    EXHENTAI_TAG_NAMESPACES,
    canonical_gallery_address,
    classify_external_profile,
    danbooru_alias_terms,
    discovery_addresses,
    exhentai_tag_facets,
    merge_alias_search_results,
    parse_discovery_output,
    search_site,
    search_site_catalog,
    validate_discovery_args,
)
from .encrypted_dns import EncryptedDNSError, NetworkTargetValidator
from .gallery import GalleryRunner
from .proxy import ProxyLease, ProxyPoolAdapter, ProxyPoolUnavailable
from .redaction import redact_text
from .schemas import ProxyMode, SitePolicy


# Private aliases are retained for tests and downstream diagnostics that patch
# the historical seam; all source orchestration lives in DanbooruDiscoveryAdapter.
_DanbooruApiRequestError = DanbooruApiRequestError


_is_cloudflare_challenge = is_cloudflare_challenge


def _danbooru_json_request(
    url: str,
    *,
    params: dict[str, Any],
    proxy_url: str | None,
    timeout: float,
) -> Any:
    """Read Danbooru JSON with gallery-dl-backend's own honest User-Agent.

    Danbooru's API policy forbids impersonating a browser, so this request
    identifies the backend honestly, matching upstream gallery-dl whose Danbooru
    extractor queries ``posts.json`` with its ``gallery-dl/<version>``
    User-Agent (``DanbooruExtractor.useragent = util.USERAGENT_GALLERYDL``).
    The ordinary gallery-dl/requests path remains the primary path; this request
    is the backend-owned fallback that still uses the selected pool lease when
    one is present.
    """

    with DiscoveryHttpSession(
        lambda: curl_requests.Session(trust_env=False),
        backend="curl",
        proxy_url=proxy_url,
    ) as session:
        response = session.request_json(
            "get",
            url,
            params=params,
            timeout=timeout,
            default_status_code=0,
        )
    status_code = response.status_code
    if 300 <= status_code < 400:
        raise _DanbooruApiRequestError(
            f"Danbooru API 返回了未接受的重定向 (HTTP {status_code})",
            status_code=status_code,
        )
    if status_code >= 400:
        challenge = _is_cloudflare_challenge(status_code, response.text)
        retryable = challenge or status_code in {408, 425, 429} or status_code >= 500
        raise _DanbooruApiRequestError(
            (
                f"Danbooru API 遇到 Cloudflare 检查 (HTTP {status_code})"
                if challenge
                else f"Danbooru API 返回 HTTP {status_code}"
            ),
            status_code=status_code,
            retryable=retryable,
            proxy_fault=challenge or status_code == 429,
        )
    if response.json_error is not None:
        challenge = _is_cloudflare_challenge(status_code, response.text)
        raise _DanbooruApiRequestError(
            "Danbooru API 返回了无效 JSON",
            status_code=status_code,
            retryable=challenge,
            proxy_fault=challenge,
        ) from response.json_error
    return response.payload


class DiscoveryService:
    def __init__(
        self,
        gallery: GalleryRunner,
        proxy: ProxyPoolAdapter,
        runtime_dir: Path,
        *,
        network_validator: NetworkTargetValidator | None = None,
        auth_failure_callback: Callable[[str, str | None, str], Awaitable[bool]] | None = None,
    ) -> None:
        self.transport = DiscoveryTransport(
            gallery,
            proxy,
            runtime_dir,
            network_validator=network_validator,
            auth_failure_callback=auth_failure_callback,
            requests_session_factory=lambda: requests.Session(),
            curl_session_factory=lambda: curl_requests.Session(trust_env=False),
        )
        # Compatibility attributes remain aliases of the injected transport;
        # adapters receive the transport itself and never reconstruct them.
        self.gallery = self.transport.gallery
        self.proxy = self.transport.proxy
        self.runtime_dir = self.transport.runtime_dir
        self.network_validator = self.transport.network_validator
        self.auth_failure_callback = self.transport.auth_failure_callback
        self._danbooru_adapter = DanbooruDiscoveryAdapter(
            self.transport,
            gallery_discover=self._discover_gallery_url,
            api_request=lambda *args, **kwargs: _danbooru_json_request(
                *args,
                **kwargs,
            ),
        )
        self._exhentai_adapter = ExHentaiDiscoveryAdapter(
            self.transport,
            gallery_discover=self._discover_gallery_url,
        )

    @staticmethod
    def _proxy_metadata(mode: ProxyMode, lease: ProxyLease | None) -> dict[str, Any]:
        return DiscoveryTransport.proxy_metadata(mode, lease)

    def _network_error(
        self,
        error: EncryptedDNSError,
        *,
        mode: ProxyMode,
        lease: ProxyLease | None,
        attempts: int,
    ) -> DiscoveryError:
        return self.transport.network_error(
            error,
            mode=mode,
            lease=lease,
            attempts=attempts,
        )

    async def validate_direct(self, url: str) -> tuple[str, ...]:
        return await self.transport.validate_direct(url)

    async def validate_proxy(
        self,
        url: str,
        lease: ProxyLease,
    ) -> tuple[str, ...]:
        return await self.transport.validate_proxy(url, lease)

    def _danbooru_node_tags(self, policy: SitePolicy) -> list[str]:
        return self._danbooru_adapter._node_tags(policy)

    async def _danbooru_api_json(
        self,
        url: str,
        *,
        params: dict[str, Any],
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        secure_search: bool = True,
    ) -> tuple[Any, dict[str, Any], int]:
        return await self._danbooru_adapter.api_json(
            url,
            params=params,
            policy=policy,
            proxy_mode=proxy_mode,
            secure_search=secure_search,
        )

    async def _search_danbooru_posts_api(
        self,
        *,
        keyword: str,
        limit: int,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        secure_search: bool = True,
    ) -> dict[str, Any]:
        return await self._danbooru_adapter.search_posts_api(
            keyword=keyword,
            limit=limit,
            policy=policy,
            proxy_mode=proxy_mode,
            secure_search=secure_search,
        )

    async def _search_danbooru_artists_api(
        self,
        *,
        keyword: str,
        limit: int,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
    ) -> dict[str, Any]:
        return await self._danbooru_adapter.search_artists_api(
            keyword=keyword,
            limit=limit,
            policy=policy,
            proxy_mode=proxy_mode,
        )

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
        if spec.site == "danbooru":
            return await self._danbooru_adapter.search(
                keyword=keyword,
                limit=limit,
                policy=policy,
                proxy_mode=proxy_mode,
                credentials_ref=credentials_ref,
                cookies_file=cookies_file,
                config_file=config_file,
                extra_args=extra_args,
                timeout_seconds=timeout_seconds,
                posts_search=self._search_danbooru_posts_api,
            )
        if spec.site == "exhentai":
            return await self._exhentai_adapter.search(
                keyword=keyword,
                limit=limit,
                policy=policy,
                proxy_mode=proxy_mode,
                credentials_ref=credentials_ref,
                cookies_file=cookies_file,
                config_file=config_file,
                extra_args=extra_args,
                timeout_seconds=timeout_seconds,
            )
        return await self._discover_gallery_url(
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

    @staticmethod
    async def _bounded_search_fallback(
        coro: Awaitable[dict[str, Any]],
        timeout_seconds: float,
        message: str,
    ) -> dict[str, Any]:
        return await DanbooruDiscoveryAdapter.bounded_search_fallback(
            coro,
            timeout_seconds,
            message,
        )

    async def enrich_exhentai_previews(
        self,
        result: dict[str, Any],
        *,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        return await self._exhentai_adapter.enrich_previews(
            result,
            policy=policy,
            proxy_mode=proxy_mode,
            timeout_seconds=timeout_seconds,
        )

    async def danbooru_autocomplete(
        self,
        query: str,
        *,
        limit: int = 10,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
    ) -> dict[str, Any]:
        return await self._danbooru_adapter.autocomplete(
            query,
            limit=limit,
            policy=policy,
            proxy_mode=proxy_mode,
            api_json=self._danbooru_api_json,
        )

    async def search_danbooru_artists(
        self,
        *,
        keyword: str,
        limit: int,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        credentials_ref: str | None,
        cookies_file: str | None,
        config_file: str | None,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        return await self._danbooru_adapter.search_artists(
            keyword=keyword,
            limit=limit,
            policy=policy,
            proxy_mode=proxy_mode,
            credentials_ref=credentials_ref,
            cookies_file=cookies_file,
            config_file=config_file,
            timeout_seconds=timeout_seconds,
            artists_search=self._search_danbooru_artists_api,
        )

    async def danbooru_artist_profiles(
        self,
        names: list[str],
        *,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        limit: int = 20,
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        return await self._danbooru_adapter.artist_profiles(
            names,
            policy=policy,
            proxy_mode=proxy_mode,
            limit=limit,
        )

    async def _danbooru_artist_profile(
        self,
        name: str,
        *,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
    ) -> dict[str, Any] | None:
        return await self._danbooru_adapter.artist_profile(
            name,
            policy=policy,
            proxy_mode=proxy_mode,
        )

    async def discover_url(
        self,
        *,
        site: str,
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
        spec = search_site(site)
        if spec.site == "danbooru":
            return await self._danbooru_adapter.discover_url(
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
                posts_search=self._search_danbooru_posts_api,
            )
        if spec.site == "exhentai":
            return await self._exhentai_adapter.discover_url(
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
        return await self._discover_gallery_url(
            site=spec.site,
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

    async def _discover_gallery_url(
        self,
        *,
        site: str,
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
        spec = search_site(site)
        values = validate_discovery_args(extra_args)
        if spec.site == "pixiv":
            values = _pixiv_first_media_args(values)
        if range_kind is None:
            if spec.site == "pawchive" and not urlsplit(url).path.startswith(
                "/artists"
            ):
                # Creator/post/listing addresses enumerate one Directory per
                # post; only the /artists creator search yields Queue children.
                range_kind = "post"
            else:
                range_kind = spec.search_range
        range_option = {
            "file": "--range",
            "post": "--post-range",
            "child": "--child-range",
        }[range_kind]
        range_limit = limit
        if spec.site == "pawchive" and range_kind == "child":
            # The creator directory is ~80% kemono-synced stubs that rank high
            # on the shared favorited sort but 404 locally; the parser drops
            # them (ever_imported=false), so widen the enumeration window to
            # keep `limit` real candidates reachable. Queue messages are pure
            # in-process output — no extra site requests.
            range_limit = limit * 10
        protocol_args = ["--dump-json", range_option, f"1-{range_limit}", *values]
        mode: ProxyMode = proxy_mode or policy.proxy_mode
        secure_search = keyword is not None
        attempts = max(1, policy.retry_limit + 1)
        attempt_count = 0
        tried: set[str] = set()
        last_message = "搜索任务没有返回结果"
        last_auth_context = ""
        last_decision = FailureDecision("backend_error", False, False, last_message)
        last_proxy = self._proxy_metadata(mode, None)
        last_dns_error: EncryptedDNSError | None = None

        if secure_search and mode == "direct":
            await self.validate_direct(url)

        for attempt in range(1, attempts + 1):
            operation_id = f"discover-{uuid.uuid4().hex}"
            last_dns_error = None
            operation_dir = self.runtime_dir / operation_id
            lease: ProxyLease | None = None
            decision = FailureDecision("backend_error", False, False, last_message)
            dns_error: EncryptedDNSError | None = None
            try:
                if mode != "direct":
                    try:
                        lease = await asyncio.to_thread(
                            self.proxy.acquire,
                            operation_id,
                            node_tags=policy.node_tags,
                            exclude_ids=tried,
                            allowed_ids=getattr(policy, "allowed_proxy_ids", None),
                            probe_before_use=policy.probe_before_use,
                            probe_url=policy.probe_url,
                        )
                    except ProxyPoolUnavailable as exc:
                        raise DiscoveryError(
                            "proxy_unavailable",
                            "代理不可用，已终止（不会回退直连）",
                            details={"attempts": attempt, "proxy": last_proxy},
                        ) from exc
                    except Exception as exc:
                        if secure_search or mode == "required":
                            raise DiscoveryError(
                                "proxy_unavailable",
                                "代理租约获取失败，已拒绝回退直连",
                                details={"attempts": attempt, "proxy": last_proxy},
                            ) from exc
                    if lease is None and secure_search:
                        raise DiscoveryError(
                            "proxy_dns_failed",
                            "当前没有可用于代理 DNS 校验的健康节点，已拒绝回退直连",
                            details={"attempts": attempt, "proxy": last_proxy},
                        )
                    if lease is None and mode == "required":
                        raise DiscoveryError(
                            "proxy_unavailable",
                            "当前没有符合站点策略的健康代理节点",
                            details={"attempts": attempt, "proxy": last_proxy},
                        )

                last_proxy = self._proxy_metadata(mode, lease)
                attempt_count += 1
                if secure_search and lease is not None:
                    await self.validate_proxy(url, lease)
                result = await self.gallery.capture(
                    operation_id,
                    url=url,
                    output_dir=str(operation_dir),
                    proxy_url=lease.endpoint if lease else None,
                    http_timeout=policy.http_timeout,
                    gallery_retries=policy.gallery_retries,
                    task_timeout=timeout_seconds,
                    cookies_file=cookies_file,
                    config_file=config_file,
                    credentials_ref=credentials_ref,
                    extra_args=protocol_args,
                )
                decision = classify_result(
                    result.exit_code,
                    result.stderr,
                    cancelled=False,
                    timed_out=result.timed_out,
                )
                last_auth_context = result.stderr
                if decision.error_class == "success":
                    try:
                        candidates, authors = parse_discovery_output(
                            spec.site,
                            result.stdout,
                            source_url=url,
                            limit=limit,
                        )
                    except DiscoveryError as exc:
                        safe_message = redact_text(exc.message, limit=1000)
                        decision = classify_result(1, f"{result.stderr}\n{safe_message}")
                        last_message = safe_message
                        if not decision.retryable:
                            details = {
                                "attempts": attempt_count,
                                "message": safe_message,
                                "proxy": last_proxy,
                            }
                            if isinstance(exc.details, dict):
                                errors = exc.details.get("errors")
                                if isinstance(errors, list):
                                    details["errors"] = [
                                        redact_text(item, limit=500) for item in errors[:5]
                                    ]
                            raise DiscoveryError(
                                exc.code,
                                safe_message,
                                details=details,
                            ) from exc
                    else:
                        return {
                            "site": spec.site,
                            "keyword": keyword,
                            "search_url": url,
                            "candidate_count": len(candidates),
                            "author_count": len(authors),
                            "candidates": candidates,
                            "authors": authors,
                            "proxy": last_proxy,
                            "attempts": attempt_count,
                        }
                else:
                    last_message = decision.message
            except EncryptedDNSError as exc:
                dns_error = last_dns_error = exc
                last_message = exc.message
                decision = FailureDecision(
                    "proxy_error" if exc.proxy_fault else "network_target",
                    exc.retryable,
                    bool(lease is not None and exc.proxy_fault),
                    exc.message,
                )
                if not decision.proxy_fault:
                    raise self._network_error(
                        exc,
                        mode=mode,
                        lease=lease,
                        attempts=attempt_count,
                    ) from exc
            except DiscoveryError:
                raise
            except (FileNotFoundError, ValueError) as exc:
                raise DiscoveryError(
                    "discovery_configuration",
                    redact_text(exc, limit=1000),
                ) from exc
            except Exception as exc:
                last_message = redact_text(exc, limit=1000)
                decision = classify_result(1, last_message)
            finally:
                if lease is not None:
                    if decision.proxy_fault:
                        tried.add(lease.node_id)
                    try:
                        await asyncio.to_thread(
                            self.proxy.release,
                            operation_id,
                            proxy_fault=decision.proxy_fault,
                            reason=decision.message,
                        )
                    except Exception:
                        pass
                if (
                    operation_dir.parent == self.runtime_dir
                    and operation_dir.name.startswith("discover-")
                ):
                    shutil.rmtree(operation_dir, ignore_errors=True)

            last_decision = decision
            if not decision.retryable or attempt >= attempts:
                if dns_error is not None:
                    raise self._network_error(
                        dns_error,
                        mode=mode,
                        lease=lease,
                        attempts=attempt_count,
                    ) from dns_error
                break
            delay = policy.backoff_base_seconds * (2 ** max(0, attempt - 1))
            if delay:
                await asyncio.sleep(min(delay, 10.0))

        if last_dns_error is not None:
            raise self._network_error(
                last_dns_error,
                mode=mode,
                lease=None,
                attempts=attempt_count,
            ) from last_dns_error
        if decision.error_class == "authentication" and self.auth_failure_callback is not None:
            try:
                await self.auth_failure_callback(
                    spec.site,
                    cookies_file,
                    last_auth_context or last_message,
                )
            except Exception:
                pass
        safe_message = redact_text(last_message, limit=1000)
        raise DiscoveryError(
            "authentication" if decision.error_class == "authentication" else "discovery_failed",
            safe_message,
            details={
                "attempts": attempt_count,
                "message": safe_message,
                "proxy": last_proxy,
            },
        )
