from __future__ import annotations

import asyncio
import re
from typing import Any, Awaitable, Callable
from urllib.parse import parse_qs, urlencode, urlsplit

import requests

from ..classifier import classify_result
from ..discovery_contracts import DiscoveryError
from ..discovery_transport import (
    AttemptFailure,
    AttemptsExhausted,
    DiscoveryTransport,
)
from ..discovery_transforms import (
    _DANBOORU_TAG_CATEGORY_NAMES,
    _DNS_ERROR_CODES,
    _danbooru_artist_queue,
    _danbooru_candidate,
    _integer,
    _tag_key,
    _text,
    classify_external_profile,
    search_site,
)
from ..redaction import redact_text
from ..schemas import ProxyMode, SitePolicy


GalleryDiscover = Callable[..., Awaitable[dict[str, Any]]]
ApiRequest = Callable[..., Any]
ApiJson = Callable[..., Awaitable[tuple[Any, dict[str, Any], int]]]
PostsSearch = Callable[..., Awaitable[dict[str, Any]]]

_DANBOORU_PROBE_URL = "https://danbooru.donmai.us/"


class DanbooruApiRequestError(RuntimeError):
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


def is_cloudflare_challenge(status_code: int | None, body: str) -> bool:
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




class DanbooruDiscoveryAdapter:
    """Danbooru discovery, API fallback, autocomplete, and artist profiles."""

    def __init__(
        self,
        transport: DiscoveryTransport,
        *,
        gallery_discover: GalleryDiscover,
        api_request: ApiRequest,
    ) -> None:
        self.transport = transport
        self._gallery_discover = gallery_discover
        self._api_request = api_request

    @staticmethod
    def _target_policy(policy: SitePolicy) -> SitePolicy:
        if policy.probe_url:
            return policy
        return policy.model_copy(update={"probe_url": _DANBOORU_PROBE_URL})

    def _node_tags(self, policy: SitePolicy) -> list[str]:
        if policy.node_tags:
            return list(policy.node_tags)
        try:
            nodes = self.transport.proxy.status().get("nodes") or []
        except Exception:
            return []
        if any(
            isinstance(node, dict)
            and node.get("healthy")
            and "us" in (node.get("tags") or [])
            for node in nodes
        ):
            return ["us"]
        return []

    async def api_json(
        self,
        url: str,
        *,
        params: dict[str, Any],
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        secure_search: bool = True,
    ) -> tuple[Any, dict[str, Any], int]:
        policy = self._target_policy(policy)
        mode: ProxyMode = proxy_mode or policy.proxy_mode
        preferred_tags = self._node_tags(policy)
        fallback_tags = [] if preferred_tags and not policy.node_tags else None
        last_status: int | None = None

        async def request(attempt):
            nonlocal last_status
            try:
                return await self.transport.run_http(
                    lambda: self._api_request(
                        url,
                        params=params,
                        proxy_url=attempt.lease.endpoint if attempt.lease else None,
                        timeout=policy.http_timeout,
                    )
                )
            except DanbooruApiRequestError as exc:
                last_status = exc.status_code
                raise AttemptFailure(
                    redact_text(exc, limit=1000),
                    retryable=exc.retryable,
                    proxy_fault=bool(attempt.lease is not None and exc.proxy_fault),
                    details={"status_code": exc.status_code},
                ) from exc

        def classify(exc: Exception, attempt) -> AttemptFailure:
            return AttemptFailure(
                redact_text(exc, limit=1000),
                retryable=True,
                proxy_fault=attempt.lease is not None,
            )

        try:
            result = await self.transport.execute_with_retries(
                target_url=url,
                policy=policy,
                proxy_mode=proxy_mode,
                operation_prefix="dan-api",
                secure_target=secure_search,
                operation=request,
                classify_exception=classify,
                node_tags=preferred_tags,
                fallback_node_tags=fallback_tags,
                acquire_error_fatal=secure_search or mode == "required",
                required_lease_message=(
                    "当前没有符合 Danbooru API 查询策略的健康代理节点"
                ),
            )
        except AttemptsExhausted as exc:
            raise DiscoveryError(
                "danbooru_api_failed",
                exc.failure.message,
                details={
                    "attempts": exc.attempts,
                    "status_code": last_status,
                    "proxy": exc.proxy,
                },
            ) from exc
        return result.value, result.proxy, result.attempts

    async def search_posts_api(
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
            payload, proxy_info, page_attempts = await self.api_json(
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

    async def search_artists_api(
        self,
        *,
        keyword: str,
        limit: int,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
    ) -> dict[str, Any]:
        parts = [part for part in re.split(r"\s+", keyword.strip()) if part]
        pattern = " ".join(parts)
        search_url = "https://danbooru.donmai.us/artists?" + urlencode(
            {"search[any_name_matches]": pattern}
        )
        payload, proxy_info, attempts = await self.api_json(
            "https://danbooru.donmai.us/artists.json",
            params={
                "search[any_name_matches]": pattern,
                "limit": min(max(1, int(limit)), 200),
            },
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
        keyword: str,
        limit: int,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        credentials_ref: str | None,
        cookies_file: str | None,
        config_file: str | None,
        extra_args: list[str],
        timeout_seconds: float,
        posts_search: PostsSearch | None = None,
    ) -> dict[str, Any]:
        policy = self._target_policy(policy)
        fallback = posts_search or self.search_posts_api
        url = search_site("danbooru").search_url(keyword)
        try:
            result = await self._gallery_discover(
                site="danbooru",
                url=url,
                keyword=keyword,
                limit=limit,
                range_kind="post",
                policy=policy,
                proxy_mode=proxy_mode,
                credentials_ref=credentials_ref,
                cookies_file=cookies_file,
                config_file=config_file,
                extra_args=extra_args,
                timeout_seconds=timeout_seconds,
            )
        except DiscoveryError as exc:
            if exc.code in _DNS_ERROR_CODES:
                raise
            return await self.bounded_search_fallback(
                fallback(
                    keyword=keyword,
                    limit=limit,
                    policy=policy,
                    proxy_mode=proxy_mode,
                ),
                timeout_seconds,
                "Danbooru 帖子分页发现超时",
            )
        if not result.get("candidate_count"):
            return await self.bounded_search_fallback(
                fallback(
                    keyword=keyword,
                    limit=limit,
                    policy=policy,
                    proxy_mode=proxy_mode,
                ),
                timeout_seconds,
                "Danbooru 帖子分页发现超时",
            )
        return result

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
        posts_search: PostsSearch | None = None,
    ) -> dict[str, Any]:
        policy = self._target_policy(policy)
        fallback = posts_search or self.search_posts_api
        if keyword is None and not extra_args and not any(
            (credentials_ref, cookies_file, config_file)
        ):
            parsed = urlsplit(url)
            tags = (parse_qs(parsed.query).get("tags") or [""])[0].strip()
            if parsed.path.rstrip("/") == "/posts" and tags:
                return await self.bounded_search_fallback(
                    fallback(
                        keyword=tags,
                        limit=limit,
                        policy=policy,
                        proxy_mode=proxy_mode,
                        secure_search=False,
                    ),
                    timeout_seconds,
                    "Danbooru 帖子分页发现超时",
                )
        return await self._gallery_discover(
            site="danbooru",
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

    @staticmethod
    async def bounded_search_fallback(
        coro: Awaitable[dict[str, Any]],
        timeout_seconds: float,
        message: str,
    ) -> dict[str, Any]:
        try:
            return await asyncio.wait_for(coro, timeout=timeout_seconds)
        except asyncio.TimeoutError as exc:
            raise DiscoveryError(
                "discovery_failed",
                message,
                details={"timeout_seconds": timeout_seconds},
            ) from exc

    async def autocomplete(
        self,
        query: str,
        *,
        limit: int,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        api_json: ApiJson | None = None,
    ) -> dict[str, Any]:
        policy = self._target_policy(policy)
        request = api_json or self.api_json
        payload, proxy_info, attempts = await request(
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

    async def search_artists(
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
        artists_search: PostsSearch | None = None,
    ) -> dict[str, Any]:
        policy = self._target_policy(policy)
        fallback = artists_search or self.search_artists_api
        parts = [part for part in re.split(r"\s+", keyword.strip()) if part]
        pattern = " ".join(parts)
        url = "https://danbooru.donmai.us/artists?" + urlencode(
            {"search[any_name_matches]": pattern}
        )
        try:
            result = await self._gallery_discover(
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
            return await self.bounded_search_fallback(
                fallback(
                    keyword=keyword,
                    limit=limit,
                    policy=policy,
                    proxy_mode=proxy_mode,
                ),
                timeout_seconds,
                "Danbooru 画师检索超时",
            )
        if not result.get("author_count"):
            return await self.bounded_search_fallback(
                fallback(
                    keyword=keyword,
                    limit=limit,
                    policy=policy,
                    proxy_mode=proxy_mode,
                ),
                timeout_seconds,
                "Danbooru 画师检索超时",
            )
        return result

    async def artist_profiles(
        self,
        names: list[str],
        *,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        limit: int = 20,
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        unique = list(
            dict.fromkeys(str(name).strip() for name in names if str(name).strip())
        )[:limit]
        semaphore = asyncio.Semaphore(4)

        async def fetch(name: str):
            async with semaphore:
                try:
                    return await self.artist_profile(
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

    async def artist_profile(
        self,
        name: str,
        *,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
    ) -> dict[str, Any] | None:
        policy = self._target_policy(policy)
        preferred_tags = self._node_tags(policy)
        fallback_tags = [] if preferred_tags and not policy.node_tags else None
        target_url = "https://danbooru.donmai.us/artists.json"

        async def load(attempt):
            def request_profile() -> dict[str, Any] | None:
                with self.transport.http_session(
                    backend="requests",
                    proxy_url=attempt.lease.endpoint if attempt.lease else None,
                ) as session:

                    def request_json(url: str, params: dict[str, Any]) -> Any:
                        response = session.request_json(
                            "get",
                            url,
                            params=params,
                            timeout=policy.http_timeout,
                            parse_json=False,
                        )
                        status_code = response.status_code
                        if 300 <= status_code < 400:
                            raise ValueError(
                                "Danbooru API 返回了未接受的重定向"
                            )
                        if is_cloudflare_challenge(status_code, response.text):
                            return self._api_request(
                                url,
                                params=params,
                                proxy_url=(
                                    attempt.lease.endpoint if attempt.lease else None
                                ),
                                timeout=policy.http_timeout,
                            )
                        response.raw_response.raise_for_status()
                        return response.raw_response.json()

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
                        "profile_url": (
                            f"https://danbooru.donmai.us/artists/{artist_id}"
                        ),
                        "works_url": "https://danbooru.donmai.us/posts?"
                        + urlencode({"tags": exact.get("name") or name}),
                        "related_profiles": related,
                        "proxy": attempt.proxy,
                    }

            return await self.transport.run_http(request_profile)

        def classify(exc: Exception, attempt) -> AttemptFailure:
            message = redact_text(exc, limit=1000)
            decision = classify_result(1, message)
            response = getattr(exc, "response", None)
            status_code = _integer(getattr(response, "status_code", None))
            response_body = str(getattr(response, "text", "") or "")
            challenge = is_cloudflare_challenge(status_code, response_body)
            transient_request = isinstance(
                exc,
                (requests.Timeout, requests.ConnectionError),
            ) or bool(
                status_code
                and (status_code in {408, 425, 429} or status_code >= 500)
            )
            if isinstance(exc, DanbooruApiRequestError):
                transient_request = exc.retryable
                challenge = exc.proxy_fault
            retryable = bool(
                decision.retryable or transient_request or decision.proxy_fault
            )
            proxy_fault = bool(
                attempt.lease is not None
                and (decision.proxy_fault or challenge or transient_request)
            )
            return AttemptFailure(
                message,
                error_class=decision.error_class,
                retryable=retryable,
                proxy_fault=proxy_fault,
            )

        try:
            result = await self.transport.execute_with_retries(
                target_url=target_url,
                policy=policy,
                proxy_mode=proxy_mode,
                operation_prefix="dan-artist",
                secure_target=True,
                operation=load,
                classify_exception=classify,
                node_tags=preferred_tags,
                fallback_node_tags=fallback_tags,
                acquire_error_fatal=True,
            )
        except AttemptsExhausted as exc:
            raise DiscoveryError(
                "danbooru_artist_lookup_failed",
                exc.failure.message,
                details={"attempts": exc.attempts, "proxy": exc.proxy},
            ) from exc
        return result.value
