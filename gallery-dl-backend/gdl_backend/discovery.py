from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable
import requests
from curl_cffi import requests as curl_requests

from .discovery_adapters.danbooru import (
    DanbooruApiRequestError,
    DanbooruDiscoveryAdapter,
    is_cloudflare_challenge,
)
from .discovery_adapters.exhentai import ExHentaiDiscoveryAdapter
from .discovery_adapters.gallery_dl import (
    GalleryDlDiscoveryAdapter,
    PawchiveDiscoveryAdapter,
)
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
from .proxy import ProxyLease, ProxyPoolAdapter
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
        self._gallery_dl_adapter = GalleryDlDiscoveryAdapter(self.transport)
        self._pawchive_adapter = PawchiveDiscoveryAdapter(
            self._gallery_dl_adapter
        )
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
        if spec.site == "pawchive":
            return await self._pawchive_adapter.search(
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
        return await self._gallery_dl_adapter.search(
            site=spec.site,
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
        if spec.site == "pawchive":
            return await self._pawchive_adapter.discover_url(
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
        """Private compatibility seam for source adapters and focused tests."""
        return await self._gallery_dl_adapter.discover_url(
            site=site,
            url=url,
            keyword=keyword,
            limit=limit,
            range_kind=range_kind,
            range_limit=None,
            policy=policy,
            proxy_mode=proxy_mode,
            credentials_ref=credentials_ref,
            cookies_file=cookies_file,
            config_file=config_file,
            extra_args=extra_args,
            timeout_seconds=timeout_seconds,
        )
