from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from .discovery_contracts import DiscoveryError
from .redaction import redact_text


@dataclass(frozen=True, slots=True)
class SearchSiteSpec:
    site: str
    aliases: tuple[str, ...]
    candidate_kind: str
    search_range: str
    authentication: str

    def search_url(self, keyword: str) -> str:
        if self.site == "twitter":
            return "https://x.com/search?" + urlencode({"q": keyword, "f": "live"})
        if self.site == "danbooru":
            return "https://danbooru.donmai.us/posts?" + urlencode({"tags": keyword})
        if self.site == "exhentai":
            return "https://e-hentai.org/?" + urlencode({"f_search": keyword})
        if self.site == "pawchive":
            return "https://pawchive.pw/artists?" + urlencode({"q": keyword})
        raise ValueError(f"未注册关键词搜索站点: {self.site}")


SITE_SPECS: tuple[SearchSiteSpec, ...] = (
    SearchSiteSpec(
        "twitter",
        ("twitter", "x"),
        "work",
        "post",
        "auth_token Cookie",
    ),
    SearchSiteSpec(
        "pixiv",
        ("pixiv",),
        "work",
        "post",
        "refresh token 或 PHPSESSID Cookie",
    ),
    SearchSiteSpec(
        "danbooru",
        ("danbooru",),
        "post",
        "post",
        "公开搜索可直接使用；账号/API key 可选",
    ),
    SearchSiteSpec(
        "exhentai",
        ("exhentai", "eh", "e-hentai", "e_hentai"),
        "gallery",
        "child",
        "E-Hentai 公开搜索可直接使用；ExHentai 使用 Cookie",
    ),
    SearchSiteSpec(
        "pawchive",
        ("pawchive",),
        "account",
        "child",
        "公开 API 与文件下载无需登录",
    ),
)

_SITE_INDEX = {alias: spec for spec in SITE_SPECS for alias in spec.aliases}
EXHENTAI_TAG_NAMESPACES: tuple[dict[str, Any], ...] = (
    {"namespace": "artist", "label": "艺术家 / 作者", "aliases": ["a"]},
    {"namespace": "character", "label": "角色", "aliases": ["c", "char"]},
    {"namespace": "cosplayer", "label": "角色扮演者", "aliases": ["cos"]},
    {"namespace": "female", "label": "女性", "aliases": ["f"]},
    {"namespace": "group", "label": "社团 / 团体", "aliases": ["g", "circle"]},
    {"namespace": "language", "label": "语言", "aliases": ["l", "lang"]},
    {"namespace": "location", "label": "地点", "aliases": ["loc"]},
    {"namespace": "male", "label": "男性", "aliases": ["m"]},
    {"namespace": "mixed", "label": "混合", "aliases": ["x"]},
    {"namespace": "other", "label": "其他", "aliases": ["o"]},
    {"namespace": "parody", "label": "原作 / 系列", "aliases": ["p", "series"]},
    {"namespace": "reclass", "label": "重分类", "aliases": ["r"]},
    {"namespace": "temp", "label": "临时标签", "aliases": []},
)
_EXHENTAI_TAG_NAMESPACE_INDEX = {
    alias: str(item["namespace"])
    for item in EXHENTAI_TAG_NAMESPACES
    for alias in (str(item["namespace"]), *item["aliases"])
}
_EXHENTAI_TAG_NAMESPACE_LABELS = {
    str(item["namespace"]): str(item["label"])
    for item in EXHENTAI_TAG_NAMESPACES
}
_DNS_ERROR_CODES = frozenset(
    {
        "invalid_network_target",
        "proxy_dns_failed",
        "encrypted_dns_unavailable",
        "encrypted_dns_redirect",
        "encrypted_dns_http_error",
        "encrypted_dns_protocol",
        "encrypted_dns_status_error",
        "encrypted_dns_nxdomain",
        "encrypted_dns_no_answer",
        "encrypted_dns_response_too_large",
    }
)

_DISCOVERY_MANAGED_ARGS = {
    "-g",
    "-G",
    "-j",
    "-J",
    "--get-urls",
    "--resolve-urls",
    "--dump-json",
    "--resolve-json",
    "--range",
    "--file-range",
    "--image-range",
    "--post-range",
    "--child-range",
    "--chapter-range",
}


def search_site(site: str) -> SearchSiteSpec:
    key = str(site).strip().lower()
    try:
        return _SITE_INDEX[key]
    except KeyError as exc:
        raise ValueError(
            "site 当前支持 x/twitter、pixiv、danbooru、eh/exhentai、pawchive"
        ) from exc


def search_site_catalog() -> list[dict[str, Any]]:
    catalog = []
    for spec in SITE_SPECS:
        item = {
            "site": spec.site,
            "aliases": list(spec.aliases),
            "candidate_kind": spec.candidate_kind,
            "authentication": spec.authentication,
        }
        if spec.site == "exhentai":
            item["tag_namespaces"] = [
                {
                    "namespace": namespace["namespace"],
                    "label": namespace["label"],
                    "aliases": list(namespace["aliases"]),
                }
                for namespace in EXHENTAI_TAG_NAMESPACES
            ]
        catalog.append(item)
    return catalog


def validate_discovery_args(args: list[str]) -> list[str]:
    values = [str(value) for value in args]
    for value in values:
        option = value.split("=", 1)[0]
        if option in _DISCOVERY_MANAGED_ARGS:
            raise ValueError(f"搜索输出协议参数由后端管理: {option}")
    return values


def _pixiv_first_media_args(args: list[str]) -> list[str]:
    values = list(args)
    for index in range(len(values) - 1, -1, -1):
        value = values[index]
        if value == "--filter":
            if index + 1 >= len(values):
                raise ValueError("--filter 缺少表达式")
            values[index + 1] = f"({values[index + 1]}) and (num == 0)"
            return values
        if value.startswith("--filter="):
            expression = value.split("=", 1)[1]
            values[index] = f"--filter=({expression}) and (num == 0)"
            return values
    values.extend(["--filter", "num == 0"])
    return values


def _text(value: Any, limit: int = 500) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    if not result:
        return None
    return result[:limit]


def _integer(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _list(value: Any, limit: int = 50) -> list[str]:
    if isinstance(value, str):
        values = value.split()
    elif isinstance(value, (list, tuple, set)):
        values = value
    else:
        return []
    return [str(item)[:200] for item in values if str(item).strip()][:limit]


def _exhentai_tag_parts(value: Any) -> tuple[str, str, str] | None:
    text = _text(value, 300)
    if not text:
        return None
    if ":" in text:
        prefix, tag_value = text.split(":", 1)
        raw_namespace = prefix.strip().lower()
        tag_value = tag_value.strip()
        namespace = _EXHENTAI_TAG_NAMESPACE_INDEX.get(raw_namespace, "unknown")
    else:
        namespace = "temp"
        tag_value = text
    if not tag_value:
        return None
    key = f"{namespace}:{tag_value.lower()}"
    return namespace, tag_value, key


def exhentai_tag_facets(addresses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group EH gallery tags by the official E-Hentai namespace taxonomy."""
    counts: dict[str, dict[str, dict[str, Any]]] = {}
    galleries: dict[str, set[int]] = {}
    for address_index, address in enumerate(addresses):
        metadata = address.get("metadata") if isinstance(address.get("metadata"), dict) else {}
        raw_tags = metadata.get("tags")
        if isinstance(raw_tags, str):
            tag_values = [raw_tags]
        elif isinstance(raw_tags, (list, tuple, set)):
            tag_values = raw_tags
        else:
            tag_values = []
        seen: set[str] = set()
        for raw_tag in tag_values:
            parts = _exhentai_tag_parts(raw_tag)
            if parts is None:
                continue
            namespace, value, key = parts
            if key in seen:
                continue
            seen.add(key)
            namespace_counts = counts.setdefault(namespace, {})
            item = namespace_counts.setdefault(
                key,
                {
                    "tag": f"{namespace}:{value}",
                    "value": value,
                    "count": 0,
                },
            )
            item["count"] += 1
            galleries.setdefault(namespace, set()).add(address_index)

    namespace_order = [
        str(item["namespace"]) for item in EXHENTAI_TAG_NAMESPACES
    ]
    namespace_order.extend(
        namespace for namespace in counts if namespace not in namespace_order
    )
    result: list[dict[str, Any]] = []
    for namespace in namespace_order:
        namespace_counts = counts.get(namespace)
        if not namespace_counts:
            continue
        tags = sorted(
            namespace_counts.values(),
            key=lambda item: (-int(item["count"]), str(item["value"]).lower()),
        )
        result.append(
            {
                "namespace": namespace,
                "label": _EXHENTAI_TAG_NAMESPACE_LABELS.get(namespace, "未识别命名空间"),
                "tag_count": len(tags),
                "gallery_count": len(galleries.get(namespace, set())),
                "tags": tags,
            }
        )
    return result


def _author(
    site: str,
    *,
    author_id: Any,
    name: Any,
    display_name: Any,
    profile_url: str | None,
    works_url: str | None,
) -> dict[str, Any] | None:
    name_text = _text(name, 200)
    display = _text(display_name, 200)
    if not (name_text or display or author_id is not None):
        return None
    return {
        "id": _text(author_id, 200),
        "site": site,
        "kind": "author",
        "name": name_text,
        "display_name": display,
        "url": profile_url,
        "works_url": works_url or profile_url,
    }


def _twitter_candidate(data: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    work_id = _integer(data.get("tweet_id"))
    if work_id is None:
        return None, []
    user = data.get("author") if isinstance(data.get("author"), dict) else {}
    username = _text(user.get("name"), 200)
    profile = f"https://x.com/{username}" if username else None
    author = _author(
        "twitter",
        author_id=user.get("id"),
        name=username,
        display_name=user.get("nick"),
        profile_url=profile,
        works_url=f"{profile}/media" if profile else None,
    )
    work_url = f"{profile}/status/{work_id}" if profile else f"https://x.com/i/web/status/{work_id}"
    candidate = {
        "id": str(work_id),
        "site": "twitter",
        "kind": "work",
        "title": _text(data.get("content"), 500) or f"Post {work_id}",
        "url": work_url,
        "download_url": work_url,
        "thumbnail_url": None,
        "media_count": _integer(data.get("count")) or 1,
        "author": author,
        "metadata": {
            "date": _text(data.get("date"), 100),
            "language": _text(data.get("lang"), 50),
            "favorite_count": _integer(data.get("favorite_count")),
            "retweet_count": _integer(data.get("retweet_count")),
            "reply_count": _integer(data.get("reply_count")),
            "view_count": _integer(data.get("view_count")),
            "hashtags": _list(data.get("hashtags")),
            "sensitive": data.get("sensitive"),
        },
    }
    return candidate, [author] if author else []


def _pixiv_candidate(data: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    work_id = _integer(data.get("id"))
    if work_id is None:
        return None, []
    user = data.get("user") if isinstance(data.get("user"), dict) else {}
    author_id = _integer(user.get("id"))
    profile = f"https://www.pixiv.net/users/{author_id}" if author_id is not None else None
    author = _author(
        "pixiv",
        author_id=author_id,
        name=user.get("account"),
        display_name=user.get("name"),
        profile_url=profile,
        works_url=f"{profile}/artworks" if profile else None,
    )
    work_url = f"https://www.pixiv.net/artworks/{work_id}"
    tags = data.get("tags")
    if isinstance(tags, list):
        tag_names = [
            str(item.get("name") or item.get("translated_name") or "")
            if isinstance(item, dict)
            else str(item)
            for item in tags
        ]
    else:
        tag_names = []
    candidate = {
        "id": str(work_id),
        "site": "pixiv",
        "kind": "work",
        "title": _text(data.get("title"), 500) or f"Artwork {work_id}",
        "url": work_url,
        "download_url": work_url,
        "thumbnail_url": None,
        "media_count": _integer(data.get("count")) or _integer(data.get("page_count")) or 1,
        "author": author,
        "metadata": {
            "date": _text(data.get("date") or data.get("create_date"), 100),
            "rating": _text(data.get("rating"), 50),
            "type": _text(data.get("type"), 50),
            "tags": [tag for tag in tag_names if tag][:50],
            "total_bookmarks": _integer(data.get("total_bookmarks")),
            "total_view": _integer(data.get("total_view")),
        },
    }
    return candidate, [author] if author else []


def _danbooru_candidate(data: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    post_id = _integer(data.get("id"))
    if post_id is None:
        return None, []
    artists = _list(data.get("tags_artist") or data.get("tag_string_artist"), 20)
    authors: list[dict[str, Any]] = []
    for artist in artists:
        works_url = "https://danbooru.donmai.us/posts?" + urlencode({"tags": artist})
        item = _author(
            "danbooru",
            author_id=None,
            name=artist,
            display_name=artist.replace("_", " "),
            profile_url="https://danbooru.donmai.us/artists?" + urlencode({"search[name]": artist}),
            works_url=works_url,
        )
        if item:
            authors.append(item)
    work_url = f"https://danbooru.donmai.us/posts/{post_id}"
    copyrights = _list(data.get("tags_copyright") or data.get("tag_string_copyright"), 10)
    source_url = _text(data.get("source"), 8192)
    candidate = {
        "id": str(post_id),
        "site": "danbooru",
        "kind": "post",
        "title": " / ".join(copyrights) or f"Post {post_id}",
        "url": work_url,
        "download_url": work_url,
        "source_url": source_url,
        "thumbnail_url": _text(
            data.get("preview_file_url")
            or data.get("large_file_url")
            or data.get("file_url")
            or source_url,
            8192,
        ),
        "media_count": 1,
        "author": authors[0] if authors else None,
        "metadata": {
            "date": _text(data.get("date") or data.get("created_at"), 100),
            "rating": _text(data.get("rating"), 50),
            "score": _integer(data.get("score")),
            "width": _integer(data.get("image_width")),
            "height": _integer(data.get("image_height")),
            "artists": artists,
            "characters": _list(
                data.get("tags_character") or data.get("tag_string_character"),
                30,
            ),
            "copyrights": copyrights,
        },
    }
    return candidate, authors


def _danbooru_artist_queue(
    url: str,
    data: dict[str, Any],
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    name = _text(data.get("name"), 200)
    if not name:
        return None, []
    artist_id = _integer(data.get("id"))
    author = _author(
        "danbooru",
        author_id=artist_id,
        name=name,
        display_name=name.replace("_", " "),
        profile_url=(
            f"https://danbooru.donmai.us/artists/{artist_id}"
            if artist_id is not None
            else "https://danbooru.donmai.us/artists?" + urlencode({"search[name]": name})
        ),
        works_url=url,
    )
    if author is not None:
        author["other_names"] = [str(value) for value in data.get("other_names") or []][:50]
        author["group_name"] = _text(data.get("group_name"), 200)
        author["origin"] = "danbooru_artist_directory"
    return None, [author] if author else []


def _exhentai_directory_candidate(
    data: dict[str, Any], source_url: str
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    gallery_id = _integer(data.get("gid") or data.get("gallery_id"))
    token = _text(data.get("token") or data.get("gallery_token"), 100)
    if gallery_id is None:
        return None, []
    if token:
        host = "exhentai.org" if "exhentai.org" in source_url else "e-hentai.org"
        url = f"https://{host}/g/{gallery_id}/{token}/"
    else:
        url = source_url
    uploader = _text(data.get("uploader"), 200)
    author = None
    if uploader:
        works_url = "https://e-hentai.org/?" + urlencode({"f_search": f'uploader:"{uploader}$"'})
        author = _author(
            "exhentai",
            author_id=None,
            name=uploader,
            display_name=uploader,
            profile_url=works_url,
            works_url=works_url,
        )
    candidate = {
        "id": str(gallery_id),
        "site": "exhentai",
        "kind": "gallery",
        "title": _text(data.get("title"), 500) or f"Gallery {gallery_id}",
        "url": url,
        "download_url": url,
        "thumbnail_url": _text(data.get("thumb"), 8192),
        "media_count": _integer(data.get("filecount")),
        "author": author,
        "metadata": {
            "title_jpn": _text(data.get("title_jpn"), 500),
            "category": _text(data.get("eh_category") or data.get("category"), 100),
            "language": _text(data.get("language"), 100),
            "rating": _text(data.get("rating"), 50),
            "tags": _list(data.get("tags"), 50),
        },
    }
    return candidate, [author] if author else []


def _exhentai_queue_candidate(
    url: str, data: dict[str, Any]
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    gallery_id = _integer(data.get("gallery_id"))
    if gallery_id is None:
        match = re.search(r"/g/(\d+)/", url)
        gallery_id = int(match.group(1)) if match else None
    if gallery_id is None:
        return None, []
    normalized = url if url.endswith("/") else url + "/"
    return {
        "id": str(gallery_id),
        "site": "exhentai",
        "kind": "gallery",
        "title": f"Gallery {gallery_id}",
        "url": normalized,
        "download_url": normalized,
        "thumbnail_url": None,
        "media_count": None,
        "author": None,
        "metadata": {"gallery_token": _text(data.get("gallery_token"), 100)},
    }, []


_PAWCHIVE_ROOT = "https://pawchive.pw"
_PAWCHIVE_FILE_PREFIX = "https://file.pawchive.pw/data/"


def _pawchive_thumbnail(media_url: str | None) -> str | None:
    """Map a file-server original to its cached thumbnail for previews."""
    if not media_url:
        return media_url
    if media_url.startswith(_PAWCHIVE_FILE_PREFIX):
        return (
            "https://img.pawchive.pw/thumbnail/data/"
            + media_url[len(_PAWCHIVE_FILE_PREFIX):]
        )
    return media_url


def _pawchive_candidate(
    data: dict[str, Any],
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Post candidate from a creator-listing Directory message."""
    post_id = _text(data.get("id"), 100)
    service = _text(data.get("service"), 50)
    user = _text(data.get("user"), 100)
    if not post_id or not service or not user:
        return None, []
    media_count = _integer(data.get("count"))
    if media_count is not None and media_count <= 0:
        # Every attachment of the post is still deferred on the site; there is
        # nothing to download, so an image task would just succeed empty.
        return None, []
    profile_url = f"{_PAWCHIVE_ROOT}/{service}/user/{user}"
    author = {
        "site": "pawchive",
        "id": user,
        "name": _text(data.get("username"), 300),
        "url": profile_url,
        "works_url": profile_url,
    }
    return {
        "id": post_id,
        "site": "pawchive",
        "kind": "post",
        "title": _text(data.get("title"), 300) or f"Post {post_id}",
        "url": f"{profile_url}/post/{post_id}",
        "download_url": f"{profile_url}/post/{post_id}",
        "thumbnail_url": None,
        "media_count": media_count,
        "author": author,
        "metadata": {
            "service": service,
            "published": _text(data.get("published"), 100),
        },
    }, [author]


def _pawchive_queue_candidate(
    url: str, data: dict[str, Any]
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Creator candidate from an /artists search Queue message."""
    creator_id = _text(data.get("id"), 100)
    service = _text(data.get("service"), 50)
    if not creator_id or not service:
        return None, []
    if data.get("ever_imported") is False:
        # /api/v1/creators mixes locally imported creators with stubs synced
        # from kemono's directory; stub profile/post endpoints 404 on
        # pawchive, so they cannot be crawled.
        return None, []
    profile_url = f"{_PAWCHIVE_ROOT}/{service}/user/{creator_id}"
    name = _text(data.get("name"), 300)
    return {
        "id": f"{service}:{creator_id}",
        "site": "pawchive",
        "kind": "account",
        "title": name or f"{service}/{creator_id}",
        "url": url or profile_url,
        "download_url": profile_url,
        "thumbnail_url": f"{_PAWCHIVE_ROOT}/icons/{service}/{creator_id}",
        "media_count": None,
        "author": {
            "site": "pawchive",
            "id": creator_id,
            "name": name,
            "url": profile_url,
            "works_url": profile_url,
        },
        "metadata": {
            "service": service,
            "favorited": _integer(data.get("favorited")),
            "updated": _integer(data.get("updated")),
            "ever_imported": bool(data.get("ever_imported")),
        },
    }, []


def parse_discovery_output(
    site: str,
    stdout: str,
    *,
    source_url: str,
    limit: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise DiscoveryError(
            "invalid_gallery_output",
            "gallery-dl 搜索输出不是有效 JSON",
            details={"line": exc.lineno, "column": exc.colno},
        ) from exc
    if not isinstance(payload, list):
        raise DiscoveryError("invalid_gallery_output", "gallery-dl 搜索输出结构无效")

    errors: list[str] = []
    candidates: list[dict[str, Any]] = []
    candidate_by_id: dict[str, dict[str, Any]] = {}
    authors: list[dict[str, Any]] = []
    author_keys: set[str] = set()

    def add(candidate: dict[str, Any] | None, related: list[dict[str, Any]]) -> None:
        if candidate is not None:
            key = str(candidate["id"])
            if key not in candidate_by_id and len(candidates) < limit:
                candidate_by_id[key] = candidate
                candidates.append(candidate)
        for author in related:
            author_site = str(author.get("site") or site)
            author_id = str(author.get("id") or "").strip()
            raw_key = str(author.get("works_url") or author.get("url") or author.get("name") or "")
            if author_id:
                key = f"{author_site}:id:{author_id}"
            elif "://" in raw_key:
                try:
                    key = canonical_gallery_address(author_site, raw_key)
                except ValueError:
                    key = raw_key
            else:
                key = raw_key.casefold()
            if key and key not in author_keys:
                author_keys.add(key)
                authors.append(author)

    for message in payload:
        if not isinstance(message, list) or not message:
            continue
        message_type = message[0]
        if message_type == -1 and len(message) > 1 and isinstance(message[-1], dict):
            errors.append(str(message[-1].get("message") or message[-1].get("error") or "extractor error"))
            continue
        if message_type == 2 and len(message) >= 2 and isinstance(message[-1], dict):
            data = message[-1]
            if site == "twitter":
                add(*_twitter_candidate(data))
            elif site == "pixiv":
                add(*_pixiv_candidate(data))
            elif site == "danbooru":
                add(*_danbooru_candidate(data))
            elif site == "exhentai":
                add(*_exhentai_directory_candidate(data, source_url))
            elif site == "pawchive":
                add(*_pawchive_candidate(data))
        elif message_type == 6 and len(message) >= 3 and isinstance(message[-1], dict):
            if site == "exhentai":
                add(*_exhentai_queue_candidate(str(message[1]), message[-1]))
            elif site == "danbooru":
                add(*_danbooru_artist_queue(str(message[1]), message[-1]))
            elif site == "pawchive":
                add(*_pawchive_queue_candidate(str(message[1]), message[-1]))
        elif message_type == 3 and len(message) >= 3 and isinstance(message[-1], dict):
            data = message[-1]
            item_id = data.get("tweet_id") if site == "twitter" else data.get("id")
            if site == "exhentai":
                item_id = data.get("gid") or data.get("gallery_id")
            candidate = candidate_by_id.get(str(item_id))
            if candidate is not None:
                media_url = _text(message[1], 8192)
                if site == "twitter" and media_url:
                    media_urls = candidate.setdefault("media_urls", [])
                    if media_url not in media_urls:
                        media_urls.append(media_url)
                if site == "pawchive":
                    media_url = _pawchive_thumbnail(media_url)
                if media_url and not candidate.get("thumbnail_url"):
                    candidate["thumbnail_url"] = media_url

    # DataJob returns exit 0 even when an extractor raises mid-run (a (-1, {...})
    # message), so `errors` can be non-empty on an otherwise successful enumeration.
    # Only fail hard when nothing was parsed — a late transient error (rate limit /
    # token expiry on page 280/300) must not throw away the 280 candidates already
    # collected. With candidates present, treat the errors as a soft partial result.
    if errors and not candidates:
        raise DiscoveryError(
            "extractor_error",
            redact_text(errors[0], limit=1000),
            details={"errors": [redact_text(item, limit=500) for item in errors[:5]]},
        )
    return candidates, authors


def _tag_key(value: str) -> str:
    return re.sub(r"[\s_-]+", "_", str(value).strip().lower()).strip("_")


def _identity_key(value: Any) -> str:
    return _tag_key(str(value or "").strip().lstrip("@"))


_DANBOORU_ALIAS_CAP = 4

_DANBOORU_TAG_CATEGORY_NAMES = {
    0: "general",
    1: "artist",
    3: "copyright",
    4: "character",
    5: "meta",
}


def danbooru_alias_terms(
    artist_result: dict[str, Any] | None,
    keyword: str,
    cap: int = _DANBOORU_ALIAS_CAP,
) -> list[str]:
    """Alias search terms for `keyword` from Danbooru's curated artist directory.

    Only artists whose primary name, one of their other_names, or their
    group_name matches the keyword exactly (identity-normalized) contribute
    aliases; a directory result produced by a fuzzy/substring query must not
    leak another artist's aliases into the expansion.  Non-ASCII aliases are
    ordered first: EH gallery titles and Fanbox/Patreon creator names usually
    carry the Japanese variant, so they matter more once `cap` truncates.
    """
    keyword_key = _identity_key(keyword)
    if not keyword_key or not isinstance(artist_result, dict):
        return []
    terms: list[str] = []
    seen_keys: set[str] = {keyword_key}
    for author in artist_result.get("authors") or []:
        if not isinstance(author, dict):
            continue
        name = str(author.get("name") or "").strip()
        other_names = [
            str(value).strip()
            for value in author.get("other_names") or []
            if str(value).strip()
        ]
        alias_keys = {_identity_key(value) for value in other_names}
        if (
            keyword_key != _identity_key(name)
            and keyword_key not in alias_keys
            and keyword_key != _identity_key(author.get("group_name"))
        ):
            continue
        display = str(author.get("display_name") or "").strip() or name.replace(
            "_", " "
        )
        for term in (display, *other_names):
            # Single-character aliases (e.g. 毛) are too broad for a site
            # search — they burn a request and return unrelated noise.
            if len(term) < 2:
                continue
            term_key = _identity_key(term)
            if not term_key or term_key in seen_keys:
                continue
            seen_keys.add(term_key)
            terms.append(term)
    terms.sort(key=lambda term: term.isascii())
    return terms[: max(0, int(cap))]


def merge_alias_search_results(
    keyword: str,
    primary: dict[str, Any],
    alias_results: list[tuple[str, dict[str, Any]]],
    *,
    limit: int,
) -> dict[str, Any]:
    """Fold alias-search evidence into the primary keyword's search result.

    Candidates are deduplicated by site-level id (URL as fallback) with the
    primary keyword's hits kept first; every surviving candidate records the
    terms that found it in `matched_keywords` so the evidence layer can tell
    direct hits from alias-only hits.
    """
    merged = dict(primary)
    candidates: list[dict[str, Any]] = []
    by_key: dict[str, dict[str, Any]] = {}
    authors: list[dict[str, Any]] = []
    author_keys: set[str] = set()

    def fold_candidates(term: str, result: dict[str, Any]) -> None:
        for item in result.get("candidates") or []:
            if not isinstance(item, dict):
                continue
            key = str(
                item.get("id") or item.get("download_url") or item.get("url") or ""
            )
            if not key:
                continue
            existing = by_key.get(key)
            if existing is None:
                copy = dict(item)
                copy["matched_keywords"] = [term]
                by_key[key] = copy
                candidates.append(copy)
                continue
            matched = existing.setdefault("matched_keywords", [])
            if term not in matched:
                matched.append(term)

    def fold_authors(result: dict[str, Any]) -> None:
        for author in result.get("authors") or []:
            if not isinstance(author, dict):
                continue
            key = str(
                author.get("works_url") or author.get("url") or author.get("name") or ""
            )
            if not key or key in author_keys:
                continue
            author_keys.add(key)
            authors.append(author)

    fold_candidates(keyword, primary)
    fold_authors(primary)
    attempts = int(primary.get("attempts") or 0)
    for term, result in alias_results:
        fold_candidates(term, result)
        fold_authors(result)
        attempts += int(result.get("attempts") or 0)

    candidates = candidates[: max(0, int(limit))]
    merged["candidates"] = candidates
    merged["candidate_count"] = len(candidates)
    merged["authors"] = authors
    merged["author_count"] = len(authors)
    merged["attempts"] = attempts
    merged["alias_keywords"] = [term for term, _ in alias_results]
    return merged


def canonical_gallery_address(site: str, url: str) -> str:
    spec = search_site(site)
    text = str(url).strip()
    parsed = urlsplit(text)
    if not parsed.hostname:
        return text
    host = (parsed.hostname or "").lower()
    path = re.sub(r"/{2,}", "/", parsed.path or "/").rstrip("/")
    query = parsed.query
    if spec.site == "twitter" and host in {"x.com", "www.x.com", "twitter.com", "www.twitter.com"}:
        host = "x.com"
        segments = [segment for segment in path.split("/") if segment]
        reserved = {"i", "home", "search", "intent", "share", "hashtag", "explore"}
        if len(segments) == 1 and segments[0].lower() not in reserved:
            path = f"/{segments[0].lower()}/media"
        elif (
            len(segments) == 2
            and segments[0].lower() not in reserved
            and segments[1].lower() == "media"
        ):
            path = f"/{segments[0].lower()}/media"
        query = ""
    elif spec.site == "pixiv" and host in {"pixiv.net", "www.pixiv.net"}:
        host = "www.pixiv.net"
        match = re.match(r"^/users/(\d+)(?:/artworks)?$", path)
        if match:
            path = f"/users/{match.group(1)}/artworks"
        query = ""
    elif spec.site == "danbooru" and host in {"danbooru.donmai.us", "www.danbooru.donmai.us"}:
        host = "danbooru.donmai.us"
        tags = (parse_qs(parsed.query).get("tags") or [""])[0]
        if path == "/posts" and tags:
            query = urlencode({"tags": tags})
    elif spec.site == "exhentai" and re.match(r"^/g/\d+/[0-9a-f]{10}$", path, re.I):
        path += "/"
    elif spec.site == "pawchive" and host in {
        "pawchive.pw",
        "www.pawchive.pw",
        "pawchive.st",
        "www.pawchive.st",
    }:
        host = "pawchive.pw"
        if re.match(r"^/[^/]+/user/[^/]+(?:/post/[^/]+)?$", path):
            query = ""
    return urlunsplit(("https", host, path or "/", query, ""))


def discovery_addresses(
    site: str,
    result: dict[str, Any],
    *,
    keyword: str,
    limit: int,
) -> list[dict[str, Any]]:
    """Convert extractor evidence into selectable account/tag/gallery addresses."""
    spec = search_site(site)
    addresses: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(item: dict[str, Any]) -> None:
        raw_url = str(item.get("url") or "").strip()
        if not raw_url:
            return
        url = canonical_gallery_address(spec.site, raw_url)
        if url and url not in seen and len(addresses) < limit:
            item["url"] = url
            item["source"] = spec.site
            item.setdefault("origin", "site_search")
            addresses.append(item)
            seen.add(url)

    candidates = [item for item in result.get("candidates") or [] if isinstance(item, dict)]
    authors = [item for item in result.get("authors") or [] if isinstance(item, dict)]
    if spec.site in {"twitter", "pixiv"}:
        address_type = "account"
        keyword_key = _identity_key(keyword)
        for author in authors:
            url = str(author.get("works_url") or author.get("url") or "").strip()
            if not url:
                continue
            author_id = str(author.get("id") or "").strip()
            author_name = _tag_key(author.get("name") or "")
            address_identity = author_id or uuid.uuid5(
                uuid.NAMESPACE_URL,
                canonical_gallery_address(spec.site, url),
            ).hex
            samples = []
            for item in candidates:
                candidate_author = (
                    item.get("author") if isinstance(item.get("author"), dict) else {}
                )
                candidate_id = str(candidate_author.get("id") or "").strip()
                candidate_name = _tag_key(candidate_author.get("name") or "")
                same_id = bool(author_id and candidate_id and author_id == candidate_id)
                same_name = bool(author_name and candidate_name and author_name == candidate_name)
                if same_id or same_name:
                    samples.append(item)
            identity_keys = {
                key
                for key in (
                    _identity_key(author.get("name")),
                    _identity_key(author.get("display_name")),
                )
                if key
            }
            exact_identity = bool(keyword_key and keyword_key in identity_keys)
            verified = bool(exact_identity and samples)
            evidence_reasons = ["site_search_work_evidence"] if samples else []
            if exact_identity:
                evidence_reasons.append("account_name_exact_match")
            if not verified:
                evidence_reasons.append("account_identity_unverified")
            add(
                {
                    "id": f"{spec.site}:account:{address_identity}",
                    "address_type": address_type,
                    "label": author.get("display_name") or author.get("name") or address_identity,
                    "url": url,
                    "profile_url": author.get("url"),
                    "matched_items": len(samples),
                    "confidence": "verified" if verified else "weak_evidence",
                    "evidence_reasons": evidence_reasons,
                    "sample_thumbnails": [
                        item["thumbnail_url"]
                        for item in samples
                        if item.get("thumbnail_url")
                    ][:5],
                }
            )
        return addresses

    if spec.site == "pawchive":
        keyword_key = _identity_key(keyword)
        alias_keys = {
            _identity_key(term)
            for term in result.get("alias_keywords") or []
            if _identity_key(term)
        }
        for candidate in candidates:
            if candidate.get("kind") != "account":
                continue
            metadata = (
                candidate.get("metadata")
                if isinstance(candidate.get("metadata"), dict)
                else {}
            )
            name = str(candidate.get("title") or "").strip()
            name_key = _identity_key(name)
            exact = bool(keyword_key and name_key == keyword_key)
            alias_exact = bool(not exact and name_key and name_key in alias_keys)
            if exact:
                reasons = ["account_name_exact_match"]
            elif alias_exact:
                reasons = ["danbooru_alias_name_match"]
            else:
                reasons = ["keyword_creator_search"]
            entry = {
                "id": f"pawchive:account:{candidate.get('id')}",
                "address_type": "account",
                "label": name or str(candidate.get("id")),
                "url": str(
                    candidate.get("download_url") or candidate.get("url")
                ),
                "profile_url": candidate.get("url"),
                "thumbnail_url": candidate.get("thumbnail_url"),
                "media_count": candidate.get("media_count"),
                "metadata": metadata,
                "confidence": "verified" if exact or alias_exact else "site_search",
                "evidence_reasons": reasons,
            }
            matched_terms = [
                str(term) for term in candidate.get("matched_keywords") or []
            ]
            if matched_terms:
                entry["matched_keywords"] = matched_terms
            add(entry)
        return addresses

    if spec.site == "danbooru":
        keyword_key = _identity_key(keyword)
        artist_counts: dict[str, int] = {}
        artist_names: dict[str, str] = {}
        character_counts: dict[str, int] = {}
        character_names: dict[str, str] = {}
        author_by_key: dict[str, dict[str, Any]] = {}
        directory_authors: list[dict[str, Any]] = []

        for candidate in candidates:
            metadata = candidate.get("metadata") if isinstance(candidate.get("metadata"), dict) else {}
            for artist in metadata.get("artists") or []:
                name = str(artist).strip()
                key = _identity_key(name)
                if key:
                    artist_names.setdefault(key, name)
                    artist_counts[key] = artist_counts.get(key, 0) + 1
            for character in metadata.get("characters") or []:
                name = str(character).strip()
                key = _identity_key(name)
                if key and key == keyword_key:
                    character_names.setdefault(key, name)
                    character_counts[key] = character_counts.get(key, 0) + 1

        for author in authors:
            name = str(author.get("name") or "").strip()
            key = _identity_key(name)
            if not key:
                continue
            author_by_key.setdefault(key, author)
            if str(author.get("origin") or "") == "danbooru_artist_directory":
                directory_authors.append(author)

        ordered_artists: list[tuple[str, dict[str, Any], str, str]] = []
        emitted_artist_keys: set[str] = set()
        primary_directory_authors = [
            author
            for author in directory_authors
            if keyword_key
            and _identity_key(author.get("name")) == keyword_key
        ]
        alias_directory_authors = [
            author
            for author in directory_authors
            if keyword_key
            and any(
                _identity_key(value) == keyword_key
                for value in author.get("other_names") or []
            )
        ]
        if primary_directory_authors:
            selected_directory_authors = primary_directory_authors
            directory_reason = "danbooru_artist_directory_match"
            directory_confidence = "verified"
        else:
            selected_directory_authors = alias_directory_authors
            directory_reason = "danbooru_artist_directory_alias_match"
            directory_confidence = "weak_evidence"

        for author in selected_directory_authors:
            name = str(author.get("name") or "").strip()
            key = _identity_key(name)
            if not key or key in emitted_artist_keys:
                continue
            emitted_artist_keys.add(key)
            ordered_artists.append(
                (name, author, directory_reason, directory_confidence)
            )
        if keyword_key in artist_names and keyword_key not in emitted_artist_keys:
            name = artist_names[keyword_key]
            emitted_artist_keys.add(keyword_key)
            ordered_artists.append(
                (
                    name,
                    author_by_key.get(keyword_key, {"name": name}),
                    "artist_tag_exact_match",
                    "verified",
                )
            )

        for name, author, reason, confidence in ordered_artists[:limit]:
            url = canonical_gallery_address(
                "danbooru",
                "https://danbooru.donmai.us/posts?" + urlencode({"tags": name}),
            )
            if url in seen:
                continue
            addresses.append(
                {
                    "id": f"danbooru:artist_tag:{name}",
                    "source": spec.site,
                    "origin": str(author.get("origin") or "site_search"),
                    "address_type": "artist_tag",
                    "label": name.replace("_", " "),
                    "url": url,
                    "profile_url": author.get("url"),
                    "matched_items": max(1, artist_counts.get(_identity_key(name), 0)),
                    "tag": name,
                    "confidence": confidence,
                    "evidence_reasons": [reason],
                    "related_profiles": [],
                }
            )
            seen.add(url)

        if keyword_key in character_names:
            name = character_names[keyword_key]
            url = canonical_gallery_address(
                "danbooru",
                "https://danbooru.donmai.us/posts?" + urlencode({"tags": name}),
            )
            if url not in seen:
                addresses.append(
                    {
                        "id": f"danbooru:character_tag:{name}",
                        "source": spec.site,
                        "origin": "site_search",
                        "address_type": "character_tag",
                        "label": name.replace("_", " "),
                        "url": url,
                        "profile_url": None,
                        "matched_items": character_counts[keyword_key],
                        "tag": name,
                        "confidence": "verified",
                        "evidence_reasons": ["character_tag_exact_match"],
                        "related_profiles": [],
                    }
                )
                seen.add(url)
        return addresses

    keyword_key = _identity_key(keyword)
    alias_keys = {
        _identity_key(term)
        for term in result.get("alias_keywords") or []
        if _identity_key(term)
    }
    for candidate in candidates:
        url = str(candidate.get("download_url") or candidate.get("url") or "").strip()
        if not url:
            continue
        matched_terms = [
            str(term) for term in candidate.get("matched_keywords") or []
        ]
        matched_keys = {_identity_key(term) for term in matched_terms}
        reasons: list[str] = []
        if not matched_terms or (keyword_key and keyword_key in matched_keys):
            reasons.append("keyword_gallery_search")
        if alias_keys and matched_keys & alias_keys:
            reasons.append("danbooru_alias_search")
        entry = {
            "id": f"exhentai:gallery:{candidate.get('id') or url}",
            "address_type": "gallery",
            "label": candidate.get("title") or f"Gallery {candidate.get('id')}",
            "url": url,
            "thumbnail_url": candidate.get("thumbnail_url"),
            "media_count": candidate.get("media_count"),
            "metadata": candidate.get("metadata") or {},
            "confidence": "site_search",
            "evidence_reasons": reasons or ["keyword_gallery_search"],
        }
        if matched_terms:
            entry["matched_keywords"] = matched_terms
        add(entry)
    return addresses


def classify_external_profile(url: str) -> dict[str, Any]:
    """Classify a Danbooru-maintained artist URL and derive a crawlable account URL."""
    text = str(url).strip()
    parsed = urlsplit(text)
    host = (parsed.hostname or "").lower().removeprefix("www.")
    path = parsed.path.rstrip("/")
    segments = [segment for segment in path.split("/") if segment]
    platform = host or "external"
    crawl_site: str | None = None
    crawl_url: str | None = None

    if host in {"x.com", "twitter.com"}:
        platform = "twitter"
        reserved = {"i", "home", "search", "intent", "share", "hashtag", "explore"}
        if len(segments) == 1 and segments[0].lower() not in reserved:
            crawl_site = "twitter"
            crawl_url = f"https://x.com/{segments[0].lower()}/media"
    elif host in {"pixiv.net", "www.pixiv.net"}:
        platform = "pixiv"
        match = re.match(r"^/users/(\d+)", path)
        if not match and path.endswith("/member.php"):
            user_id = (parse_qs(parsed.query).get("id") or [""])[0]
            match = re.match(r"^(\d+)$", user_id)
        if match:
            crawl_site = "pixiv"
            crawl_url = f"https://www.pixiv.net/users/{match.group(1)}/artworks"
    elif host.endswith("fanbox.cc") or "pixiv.net/fanbox" in text:
        platform = "fanbox"
    elif host == "skeb.jp":
        platform = "skeb"

    return {
        "url": text,
        "platform": platform,
        "crawl_site": crawl_site,
        "crawl_url": crawl_url,
    }
