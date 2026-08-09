from __future__ import annotations

import asyncio
import html
import re
import shutil
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import parse_qs, urlencode, urlsplit

import requests
from curl_cffi import requests as curl_requests

from .classifier import FailureDecision, classify_result
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


class _DanbooruApiRequestError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        retryable: bool = False,
        proxy_fault: bool = False,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable
        self.proxy_fault = proxy_fault


def _is_cloudflare_challenge(status_code: int | None, body: str) -> bool:
    lower = str(body or "").lower()
    return bool(
        status_code == 403
        and (
            "cloudflare" in lower
            or "just a moment" in lower
            or "cf-mitigated" in lower
            or "正在进行安全验证" in lower
        )
    )


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
        if policy.node_tags:
            return list(policy.node_tags)
        try:
            nodes = self.proxy.status().get("nodes") or []
        except Exception:
            return []
        # Cloudflare currently admits the US exits in common airport pools more
        # consistently.  This is only a preference discovered from the pool's
        # normalized region tags; if none exist, acquisition falls back to the
        # whole pool below.
        if any(
            isinstance(node, dict)
            and node.get("healthy")
            and "us" in (node.get("tags") or [])
            for node in nodes
        ):
            return ["us"]
        return []

    async def _danbooru_api_json(
        self,
        url: str,
        *,
        params: dict[str, Any],
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        secure_search: bool = True,
    ) -> tuple[Any, dict[str, Any], int]:
        mode: ProxyMode = proxy_mode or policy.proxy_mode
        attempts = max(1, policy.retry_limit + 1)
        tried: set[str] = set()
        preferred_tags = self._danbooru_node_tags(policy)
        last_error = "Danbooru API 请求失败"
        last_status: int | None = None
        last_proxy = self._proxy_metadata(mode, None)
        last_dns_error: EncryptedDNSError | None = None

        if secure_search and mode == "direct":
            await self.validate_direct(url)

        for attempt in range(1, attempts + 1):
            operation_id = f"dan-api-{uuid.uuid4().hex}"
            last_dns_error = None
            lease: ProxyLease | None = None
            proxy_fault = False
            retryable = True
            dns_error: EncryptedDNSError | None = None
            try:
                if mode != "direct":
                    try:
                        lease = await asyncio.to_thread(
                            self.proxy.acquire,
                            operation_id,
                            node_tags=preferred_tags,
                            exclude_ids=tried,
                            allowed_ids=getattr(policy, "allowed_proxy_ids", None),
                            probe_before_use=policy.probe_before_use,
                            probe_url=policy.probe_url,
                        )
                        if lease is None and preferred_tags and not policy.node_tags:
                            lease = await asyncio.to_thread(
                                self.proxy.acquire,
                                operation_id,
                                node_tags=[],
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
                            "当前没有符合 Danbooru API 查询策略的健康代理节点",
                            details={"attempts": attempt, "proxy": last_proxy},
                        )
                    last_proxy = self._proxy_metadata(mode, lease)
                    if secure_search and lease is not None:
                        await self.validate_proxy(url, lease)

                payload = await asyncio.to_thread(
                    _danbooru_json_request,
                    url,
                    params=params,
                    proxy_url=lease.endpoint if lease else None,
                    timeout=policy.http_timeout,
                )
                return payload, self._proxy_metadata(mode, lease), attempt
            except EncryptedDNSError as exc:
                dns_error = last_dns_error = exc
                last_error = exc.message
                retryable = exc.retryable
                proxy_fault = bool(lease is not None and exc.proxy_fault)
                if not proxy_fault:
                    raise self._network_error(
                        exc,
                        mode=mode,
                        lease=lease,
                        attempts=attempt,
                    ) from exc
            except DiscoveryError:
                raise
            except _DanbooruApiRequestError as exc:
                last_error = redact_text(exc, limit=1000)
                last_status = exc.status_code
                retryable = exc.retryable
                proxy_fault = bool(lease is not None and exc.proxy_fault)
            except Exception as exc:
                last_error = redact_text(exc, limit=1000)
                retryable = True
                proxy_fault = lease is not None
            finally:
                if lease is not None:
                    if proxy_fault:
                        tried.add(lease.node_id)
                    try:
                        await asyncio.to_thread(
                            self.proxy.release,
                            operation_id,
                            proxy_fault=proxy_fault,
                            reason=last_error if proxy_fault else "",
                        )
                    except Exception:
                        pass

            if not retryable or attempt >= attempts:
                if dns_error is not None:
                    raise self._network_error(
                        dns_error,
                        mode=mode,
                        lease=lease,
                        attempts=attempt,
                    ) from dns_error
                break
            if policy.backoff_base_seconds:
                await asyncio.sleep(
                    min(policy.backoff_base_seconds * (2 ** (attempt - 1)), 10.0)
                )

        if last_dns_error is not None:
            raise self._network_error(
                last_dns_error,
                mode=mode,
                lease=None,
                attempts=attempts,
            ) from last_dns_error
        raise DiscoveryError(
            "danbooru_api_failed",
            last_error,
            details={
                "attempts": attempts,
                "status_code": last_status,
                "proxy": last_proxy,
            },
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
        search_url = search_site("danbooru").search_url(keyword)
        requested = max(1, int(limit))
        candidates: list[dict[str, Any]] = []
        authors: list[dict[str, Any]] = []
        candidate_ids: set[str] = set()
        author_keys: set[str] = set()
        before_id: int | None = None
        proxy_info: dict[str, Any] = {}
        attempts = 0

        while len(candidates) < requested:
            page_limit = min(200, requested - len(candidates))
            params: dict[str, Any] = {"tags": keyword, "limit": page_limit}
            if before_id is not None:
                params["page"] = f"b{before_id}"
            payload, proxy_info, page_attempts = await self._danbooru_api_json(
                "https://danbooru.donmai.us/posts.json",
                params=params,
                policy=policy,
                proxy_mode=proxy_mode,
                secure_search=secure_search,
            )
            attempts += page_attempts
            if not isinstance(payload, list):
                raise DiscoveryError(
                    "danbooru_api_protocol",
                    "Danbooru posts API 返回结构无效",
                )
            if not payload:
                break

            page_ids: list[int] = []
            for row in payload:
                if not isinstance(row, dict):
                    continue
                post_id = _integer(row.get("id"))
                if post_id is not None:
                    page_ids.append(post_id)
                candidate, row_authors = _danbooru_candidate(row)
                if candidate is not None and candidate["id"] not in candidate_ids:
                    candidate_ids.add(candidate["id"])
                    candidates.append(candidate)
                for author in row_authors:
                    key = str(author.get("works_url") or author.get("name") or "")
                    if key and key not in author_keys:
                        author_keys.add(key)
                        authors.append(author)
                if len(candidates) >= requested:
                    break

            if len(payload) < page_limit or len(candidates) >= requested:
                break
            if not page_ids:
                raise DiscoveryError(
                    "danbooru_api_protocol",
                    "Danbooru posts API 分页缺少帖子 ID",
                )
            next_before_id = min(page_ids)
            if before_id is not None and next_before_id >= before_id:
                raise DiscoveryError(
                    "danbooru_api_protocol",
                    "Danbooru posts API 分页游标没有前进",
                )
            before_id = next_before_id
        return {
            "site": "danbooru",
            "keyword": keyword,
            "search_url": search_url,
            "candidate_count": len(candidates),
            "author_count": len(authors),
            "candidates": candidates,
            "authors": authors,
            "proxy": proxy_info,
            "attempts": attempts,
            "transport": "danbooru_api_honest_ua",
        }

    async def _search_danbooru_artists_api(
        self,
        *,
        keyword: str,
        limit: int,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
    ) -> dict[str, Any]:
        parts = [part for part in re.split(r"\s+", keyword.strip()) if part]
        # No wildcards: see search_danbooru_artists — they trigger HTTP 500
        # database timeouts on Danbooru's artist table.
        pattern = " ".join(parts)
        search_url = "https://danbooru.donmai.us/artists?" + urlencode(
            {"search[any_name_matches]": pattern}
        )
        payload, proxy_info, attempts = await self._danbooru_api_json(
            "https://danbooru.donmai.us/artists.json",
            params={"search[any_name_matches]": pattern, "limit": min(max(1, int(limit)), 200)},
            policy=policy,
            proxy_mode=proxy_mode,
        )
        if not isinstance(payload, list):
            raise DiscoveryError(
                "danbooru_api_protocol",
                "Danbooru artists API 返回结构无效",
            )
        authors: list[dict[str, Any]] = []
        for row in payload[:limit]:
            if not isinstance(row, dict):
                continue
            name = str(row.get("name") or "").strip()
            if not name:
                continue
            works_url = "https://danbooru.donmai.us/posts?" + urlencode({"tags": name})
            _candidate, row_authors = _danbooru_artist_queue(works_url, row)
            authors.extend(row_authors)
        return {
            "site": "danbooru",
            "keyword": keyword,
            "search_url": search_url,
            "candidate_count": 0,
            "author_count": len(authors),
            "candidates": [],
            "authors": authors,
            "proxy": proxy_info,
            "attempts": attempts,
            "transport": "danbooru_api_honest_ua",
        }

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
        url = spec.search_url(keyword)
        try:
            result = await self.discover_url(
                site=spec.site,
                url=url,
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
        except DiscoveryError as exc:
            if spec.site != "danbooru" or exc.code in _DNS_ERROR_CODES:
                raise
            return await self._bounded_search_fallback(
                self._search_danbooru_posts_api(
                    keyword=keyword,
                    limit=limit,
                    policy=policy,
                    proxy_mode=proxy_mode,
                ),
                timeout_seconds,
                "Danbooru 帖子分页发现超时",
            )
        if spec.site == "danbooru" and not result.get("candidate_count"):
            return await self._bounded_search_fallback(
                self._search_danbooru_posts_api(
                    keyword=keyword,
                    limit=limit,
                    policy=policy,
                    proxy_mode=proxy_mode,
                ),
                timeout_seconds,
                "Danbooru 帖子分页发现超时",
            )
        return result

    @staticmethod
    async def _bounded_search_fallback(
        coro: Awaitable[dict[str, Any]],
        timeout_seconds: float,
        message: str,
    ) -> dict[str, Any]:
        # The Danbooru-native API fallbacks have only per-request timeouts; without an
        # overall bound the caller's timeout_seconds is silently dropped and a slow API
        # can hold /search open for pages×(retries+1)×http_timeout. Mirror the inline
        # bound used on discover_url's shortcut path (raise a uniform discovery_failed).
        try:
            return await asyncio.wait_for(coro, timeout=timeout_seconds)
        except asyncio.TimeoutError as exc:
            raise DiscoveryError(
                "discovery_failed",
                message,
                details={"timeout_seconds": timeout_seconds},
            ) from exc

    async def enrich_exhentai_previews(
        self,
        result: dict[str, Any],
        *,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        """Fill EH search candidates with batched gdata titles and cover URLs."""
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
        if mode == "direct":
            await self.validate_direct(target_url)

        async def fetch_batch(batch: list[tuple[int, str]]) -> list[dict[str, Any]]:
            # e-hentai's gdata API temp-bans an IP after a few rapid requests, so
            # each ≤25-gid batch takes its own proxy lease; consecutive batches
            # therefore ride different pool nodes instead of hammering one IP.
            attempts = max(1, policy.retry_limit + 1)
            tried: set[str] = set()
            last_error = "EH 画廊预览资料读取失败"
            last_proxy = self._proxy_metadata(mode, None)
            last_dns_error: EncryptedDNSError | None = None

            for attempt in range(1, attempts + 1):
                operation_id = f"eh-preview-{uuid.uuid4().hex}"
                last_dns_error = None
                lease: ProxyLease | None = None
                proxy_fault = False
                retryable = True
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
                            raise DiscoveryError(
                                "proxy_unavailable",
                                "代理租约获取失败，已拒绝回退直连",
                                details={"attempts": attempt, "proxy": last_proxy},
                            ) from exc
                        if lease is None:
                            raise DiscoveryError(
                                "proxy_dns_failed",
                                "当前没有可用于代理 DNS 校验的健康节点，已拒绝回退直连",
                                details={"attempts": attempt, "proxy": last_proxy},
                            )
                        last_proxy = self._proxy_metadata(mode, lease)
                        await self.validate_proxy(target_url, lease)

                    def request_batch() -> list[dict[str, Any]]:
                        session = requests.Session()
                        session.trust_env = False
                        session.headers["User-Agent"] = "gallery-dl-backend/0.3"
                        proxies = (
                            {"http": lease.endpoint, "https": lease.endpoint}
                            if lease
                            else None
                        )
                        try:
                            response = session.post(
                                target_url,
                                json={
                                    "method": "gdata",
                                    "gidlist": [list(pair) for pair in batch],
                                    "namespace": 1,
                                },
                                proxies=proxies,
                                timeout=request_timeout,
                                allow_redirects=False,
                                verify=True,
                            )
                            if 300 <= int(getattr(response, "status_code", 200)) < 400:
                                raise ValueError("EH gdata API 返回了未接受的重定向")
                            response.raise_for_status()
                            payload = response.json()
                            if not isinstance(payload, dict):
                                raise ValueError("EH gdata API 返回结构无效")
                            if payload.get("error"):
                                raise ValueError(str(payload["error"]))
                            metadata = payload.get("gmetadata")
                            if not isinstance(metadata, list):
                                raise ValueError("EH gdata API 缺少 gmetadata")
                            return [item for item in metadata if isinstance(item, dict)]
                        finally:
                            close = getattr(session, "close", None)
                            if callable(close):
                                close()

                    return await asyncio.to_thread(request_batch)
                except EncryptedDNSError as exc:
                    dns_error = last_dns_error = exc
                    last_error = exc.message
                    retryable = exc.retryable
                    proxy_fault = bool(lease is not None and exc.proxy_fault)
                    if not proxy_fault:
                        raise self._network_error(
                            exc,
                            mode=mode,
                            lease=lease,
                            attempts=attempt,
                        ) from exc
                except DiscoveryError:
                    raise
                except Exception as exc:
                    last_error = redact_text(exc, limit=1000)
                    decision = classify_result(1, last_error)
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
                        decision.retryable or transient_request or decision.proxy_fault
                    )
                    proxy_fault = bool(
                        lease is not None
                        and (decision.proxy_fault or transient_request)
                    )
                finally:
                    if lease is not None:
                        if proxy_fault:
                            tried.add(lease.node_id)
                        try:
                            await asyncio.to_thread(
                                self.proxy.release,
                                operation_id,
                                proxy_fault=proxy_fault,
                                reason=last_error if proxy_fault else "",
                            )
                        except Exception:
                            pass

                if not retryable or attempt >= attempts:
                    if dns_error is not None:
                        raise self._network_error(
                            dns_error,
                            mode=mode,
                            lease=lease,
                            attempts=attempt,
                        ) from dns_error
                    break
                if policy.backoff_base_seconds:
                    await asyncio.sleep(
                        min(policy.backoff_base_seconds * (2 ** (attempt - 1)), 10.0)
                    )

            if last_dns_error is not None:
                raise self._network_error(
                    last_dns_error,
                    mode=mode,
                    lease=None,
                    attempts=attempts,
                ) from last_dns_error
            raise DiscoveryError(
                "exhentai_preview_lookup_failed",
                last_error,
                details={"attempts": attempts, "proxy": last_proxy},
            )

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

    async def danbooru_autocomplete(
        self,
        query: str,
        *,
        limit: int = 10,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
    ) -> dict[str, Any]:
        """Danbooru's search-box autocomplete: prefix-fuzzy tag lookup.

        This is the only artist lookup that still supports fuzzy matching —
        wildcard any_name_matches queries now die to the server-side 3s
        statement timeout.  It prefix-matches tag names and translated
        other_names; `antecedent` reports which alias a row was matched by.
        """
        payload, proxy_info, attempts = await self._danbooru_api_json(
            "https://danbooru.donmai.us/autocomplete.json",
            params={
                "search[query]": query,
                "search[type]": "tag_query",
                "version": 1,
                "limit": min(max(1, int(limit)), 20),
            },
            policy=policy,
            proxy_mode=proxy_mode,
        )
        if not isinstance(payload, list):
            raise DiscoveryError(
                "danbooru_api_protocol",
                "Danbooru autocomplete 返回结构无效",
            )
        items: list[dict[str, Any]] = []
        for row in payload:
            if not isinstance(row, dict):
                continue
            value = _text(row.get("value"), 300)
            if not value:
                continue
            category = _integer(row.get("category"))
            items.append(
                {
                    "value": value,
                    "label": _text(row.get("label"), 300) or value.replace("_", " "),
                    "match_type": _text(row.get("type"), 50),
                    "antecedent": _text(row.get("antecedent"), 300),
                    "category": _DANBOORU_TAG_CATEGORY_NAMES.get(category, "general"),
                    "post_count": _integer(row.get("post_count")),
                }
            )
        return {
            "query": query,
            "items": items,
            "proxy": proxy_info,
            "attempts": attempts,
        }

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
        parts = [part for part in re.split(r"\s+", keyword.strip()) if part]
        # Any wildcard — even between words — now makes Danbooru's artist
        # directory scan the whole table and fail with HTTP 500
        # (ActiveRecord::QueryCanceled).  A plain query is an exact match on
        # name/other_names/group_name with space/underscore normalized
        # server-side, which is all the alias expansion needs.
        pattern = " ".join(parts)
        url = "https://danbooru.donmai.us/artists?" + urlencode(
            {"search[any_name_matches]": pattern}
        )
        try:
            result = await self.discover_url(
                site="danbooru",
                url=url,
                keyword=keyword,
                limit=limit,
                range_kind="child",
                policy=policy,
                proxy_mode=proxy_mode,
                credentials_ref=credentials_ref,
                cookies_file=cookies_file,
                config_file=config_file,
                extra_args=[],
                timeout_seconds=timeout_seconds,
            )
        except DiscoveryError as exc:
            if exc.code in _DNS_ERROR_CODES:
                raise
            return await self._bounded_search_fallback(
                self._search_danbooru_artists_api(
                    keyword=keyword,
                    limit=limit,
                    policy=policy,
                    proxy_mode=proxy_mode,
                ),
                timeout_seconds,
                "Danbooru 画师检索超时",
            )
        if not result.get("author_count"):
            return await self._bounded_search_fallback(
                self._search_danbooru_artists_api(
                    keyword=keyword,
                    limit=limit,
                    policy=policy,
                    proxy_mode=proxy_mode,
                ),
                timeout_seconds,
                "Danbooru 画师检索超时",
            )
        return result

    async def danbooru_artist_profiles(
        self,
        names: list[str],
        *,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        limit: int = 20,
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        """Read Danbooru's manually maintained artist URLs for matched artist tags."""
        unique = list(dict.fromkeys(str(name).strip() for name in names if str(name).strip()))[:limit]
        semaphore = asyncio.Semaphore(4)

        async def fetch(name: str):
            async with semaphore:
                try:
                    return await self._danbooru_artist_profile(
                        name,
                        policy=policy,
                        proxy_mode=proxy_mode,
                    )
                except Exception as exc:
                    return {"_error": redact_text(exc, limit=1000), "name": name}

        raw = await asyncio.gather(*(fetch(name) for name in unique))
        profiles: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []
        for name, item in zip(unique, raw):
            if item is None:
                continue
            if item.get("_error"):
                errors.append({"artist": name, "message": str(item["_error"])})
            else:
                profiles.append(item)
        return profiles, errors

    async def _danbooru_artist_profile(
        self,
        name: str,
        *,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
    ) -> dict[str, Any] | None:
        mode: ProxyMode = proxy_mode or policy.proxy_mode
        attempts = max(1, policy.retry_limit + 1)
        tried: set[str] = set()
        last_error = "Danbooru 画师资料读取失败"
        preferred_tags = self._danbooru_node_tags(policy)
        target_url = "https://danbooru.donmai.us/artists.json"
        last_proxy = self._proxy_metadata(mode, None)
        last_dns_error: EncryptedDNSError | None = None

        if mode == "direct":
            await self.validate_direct(target_url)

        for attempt in range(1, attempts + 1):
            operation_id = f"dan-artist-{uuid.uuid4().hex}"
            last_dns_error = None
            lease: ProxyLease | None = None
            proxy_fault = False
            retryable = True
            dns_error: EncryptedDNSError | None = None
            try:
                if mode != "direct":
                    try:
                        lease = await asyncio.to_thread(
                            self.proxy.acquire,
                            operation_id,
                            node_tags=preferred_tags,
                            exclude_ids=tried,
                            allowed_ids=getattr(policy, "allowed_proxy_ids", None),
                            probe_before_use=policy.probe_before_use,
                            probe_url=policy.probe_url,
                        )
                        if lease is None and preferred_tags and not policy.node_tags:
                            lease = await asyncio.to_thread(
                                self.proxy.acquire,
                                operation_id,
                                node_tags=[],
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
                        raise DiscoveryError(
                            "proxy_unavailable",
                            "代理租约获取失败，已拒绝回退直连",
                            details={"attempts": attempt, "proxy": last_proxy},
                        ) from exc
                    if lease is None:
                        raise DiscoveryError(
                            "proxy_dns_failed",
                            "当前没有可用于代理 DNS 校验的健康节点，已拒绝回退直连",
                            details={"attempts": attempt, "proxy": last_proxy},
                        )
                    last_proxy = self._proxy_metadata(mode, lease)
                    await self.validate_proxy(target_url, lease)

                def request_profile() -> dict[str, Any] | None:
                    session = requests.Session()
                    session.trust_env = False
                    session.headers["User-Agent"] = "gallery-dl-backend/0.3"
                    proxies = (
                        {"http": lease.endpoint, "https": lease.endpoint}
                        if lease
                        else None
                    )

                    def request_json(url: str, params: dict[str, Any]) -> Any:
                        response = session.get(
                            url,
                            params=params,
                            proxies=proxies,
                            timeout=policy.http_timeout,
                            allow_redirects=False,
                            verify=True,
                        )
                        status_code = int(getattr(response, "status_code", 200))
                        if 300 <= status_code < 400:
                            raise ValueError("Danbooru API 返回了未接受的重定向")
                        body = str(getattr(response, "text", "") or "")
                        if _is_cloudflare_challenge(status_code, body):
                            return _danbooru_json_request(
                                url,
                                params=params,
                                proxy_url=lease.endpoint if lease else None,
                                timeout=policy.http_timeout,
                            )
                        response.raise_for_status()
                        return response.json()

                    try:
                        payload = request_json(
                            target_url,
                            {"search[name]": name, "limit": 20},
                        )
                        if not isinstance(payload, list) or not payload:
                            return None
                        exact = next(
                            (
                                item
                                for item in payload
                                if _tag_key(item.get("name", "")) == _tag_key(name)
                            ),
                            None,
                        )
                        if exact is None:
                            return None
                        artist_id = int(exact["id"])
                        url_payload = request_json(
                            "https://danbooru.donmai.us/artist_urls.json",
                            {"search[artist_id]": artist_id, "limit": 100},
                        )
                        related: list[dict[str, Any]] = []
                        if isinstance(url_payload, list):
                            for row in url_payload:
                                if not isinstance(row, dict) or not row.get("url"):
                                    continue
                                classified = classify_external_profile(str(row["url"]))
                                classified.update(
                                    {
                                        "id": row.get("id"),
                                        "active": bool(row.get("is_active", True)),
                                    }
                                )
                                related.append(classified)
                        return {
                            "id": str(artist_id),
                            "name": str(exact.get("name") or name),
                            "other_names": [
                                str(value) for value in exact.get("other_names") or []
                            ],
                            "group_name": exact.get("group_name"),
                            "profile_url": f"https://danbooru.donmai.us/artists/{artist_id}",
                            "works_url": "https://danbooru.donmai.us/posts?"
                            + urlencode({"tags": exact.get("name") or name}),
                            "related_profiles": related,
                            "proxy": self._proxy_metadata(mode, lease),
                        }
                    finally:
                        close = getattr(session, "close", None)
                        if callable(close):
                            close()

                return await asyncio.to_thread(request_profile)
            except EncryptedDNSError as exc:
                dns_error = last_dns_error = exc
                last_error = exc.message
                retryable = exc.retryable
                proxy_fault = bool(lease is not None and exc.proxy_fault)
                if not proxy_fault:
                    raise self._network_error(
                        exc,
                        mode=mode,
                        lease=lease,
                        attempts=attempt,
                    ) from exc
            except DiscoveryError:
                raise
            except Exception as exc:
                last_error = redact_text(exc, limit=1000)
                decision = classify_result(1, last_error)
                response = getattr(exc, "response", None)
                status_code = _integer(getattr(response, "status_code", None))
                response_body = str(getattr(response, "text", "") or "")
                challenge = _is_cloudflare_challenge(status_code, response_body)
                transient_request = isinstance(
                    exc,
                    (requests.Timeout, requests.ConnectionError),
                ) or bool(
                    status_code
                    and (status_code in {408, 425, 429} or status_code >= 500)
                )
                if isinstance(exc, _DanbooruApiRequestError):
                    transient_request = exc.retryable
                    challenge = exc.proxy_fault
                retryable = bool(
                    decision.retryable
                    or transient_request
                    or decision.proxy_fault
                )
                proxy_fault = bool(
                    lease is not None
                    and (decision.proxy_fault or challenge or transient_request)
                )
            finally:
                if lease is not None:
                    if proxy_fault:
                        tried.add(lease.node_id)
                    try:
                        await asyncio.to_thread(
                            self.proxy.release,
                            operation_id,
                            proxy_fault=proxy_fault,
                            reason=last_error if proxy_fault else "",
                        )
                    except Exception:
                        pass

            if not retryable or attempt >= attempts:
                if dns_error is not None:
                    raise self._network_error(
                        dns_error,
                        mode=mode,
                        lease=lease,
                        attempts=attempt,
                    ) from dns_error
                break
            if policy.backoff_base_seconds:
                await asyncio.sleep(
                    min(policy.backoff_base_seconds * (2 ** (attempt - 1)), 10.0)
                )

        if last_dns_error is not None:
            raise self._network_error(
                last_dns_error,
                mode=mode,
                lease=None,
                attempts=attempts,
            ) from last_dns_error
        raise DiscoveryError(
            "danbooru_artist_lookup_failed",
            last_error,
            details={"attempts": attempts, "proxy": last_proxy},
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
        values = validate_discovery_args(extra_args)
        if spec.site == "pixiv":
            values = _pixiv_first_media_args(values)
        if (
            spec.site == "danbooru"
            and keyword is None
            and not values
            and not any((credentials_ref, cookies_file, config_file))
        ):
            parsed = urlsplit(url)
            tags = (parse_qs(parsed.query).get("tags") or [""])[0].strip()
            if parsed.path.rstrip("/") == "/posts" and tags:
                try:
                    return await asyncio.wait_for(
                        self._search_danbooru_posts_api(
                            keyword=tags,
                            limit=limit,
                            policy=policy,
                            proxy_mode=proxy_mode,
                            secure_search=False,
                        ),
                        timeout=timeout_seconds,
                    )
                except asyncio.TimeoutError as exc:
                    raise DiscoveryError(
                        "discovery_failed",
                        "Danbooru 帖子分页发现超时",
                        details={"timeout_seconds": timeout_seconds},
                    ) from exc
        if range_kind is None:
            if spec.site == "exhentai" and re.search(r"/(?:g|s|mpv)/", url):
                range_kind = "file"
                limit = 1
            elif spec.site == "pawchive" and not urlsplit(url).path.startswith(
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
