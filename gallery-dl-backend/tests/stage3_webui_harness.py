#!/usr/bin/env python3
"""Tests-only Stage 3 FastAPI harness for deterministic Chromium acceptance.

The production ``create_app`` composition, static ``/ui/`` mount, Pydantic
schemas, route handlers, API client and SQLite crawl repository are real. Only
third-party discovery adapter methods and background executors are replaced at
their documented service boundary. No public network or download worker runs.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import uvicorn

from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.discovery import DiscoveryError
from gdl_backend.site import SiteInfo
from tests.helpers import make_settings


def _candidate(site: str, suffix: str = "1") -> dict[str, Any]:
    numeric = int(suffix)
    urls = {
        "danbooru": f"https://danbooru.donmai.us/posts?tags=stage3_{suffix}",
        "twitter": f"https://x.com/stage3_{suffix}/media",
        "pixiv": f"https://www.pixiv.net/users/{300 + numeric}/artworks",
        "exhentai": f"https://e-hentai.org/g/{5000 + numeric}/a{numeric:09d}/",
        "pawchive": f"https://pawchive.pw/artists/stage3_{suffix}",
    }
    return {
        "id": f"{site}-{suffix}",
        "site": site,
        "kind": "gallery" if site == "exhentai" else "account" if site == "pawchive" else "author",
        "name": f"Stage 3 {site} {suffix}",
        "display_name": f"Stage 3 {site} {suffix}",
        "title": "partial" if site == "pawchive" else f"Stage 3 {site} {suffix}",
        "url": urls[site],
        "works_url": urls[site],
        "download_url": urls[site],
        "media_count": 3 + numeric,
        "metadata": {},
    }


class Stage3DiscoveryHarness:
    """Synthetic discovery adapter; production route aggregation remains real."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.search_calls: list[dict[str, Any]] = []
        self.autocomplete_calls: list[dict[str, Any]] = []
        self.search_requests: list[dict[str, Any]] = []

    @staticmethod
    def _delay(keyword: str) -> float:
        return 0.85 if keyword.startswith("delay") or keyword == "partial" else 0.0

    @staticmethod
    def _base_keyword(keyword: str) -> str:
        return "partial" if keyword == "stage3_alias" else keyword

    async def search_danbooru_artists(self, **kwargs: Any) -> dict[str, Any]:
        keyword = str(kwargs["keyword"])
        if keyword == "server-422":
            raise DiscoveryError("invalid_search_source", "synthetic 422 source")
        if delay := self._delay(keyword):
            await asyncio.sleep(delay)
        if keyword == "transport-error":
            raise DiscoveryError("proxy_pool_unavailable", "synthetic transport boundary")
        if keyword == "no-result":
            return {"authors": []}
        artist_name = "weak_stage3" if keyword == "partial" else keyword.replace(" ", "_") or "stage3_artist"
        return {
            "authors": [
                {
                    "id": "303",
                    "name": artist_name,
                    "display_name": "Weak Stage 3" if keyword == "partial" else keyword,
                    "other_names": [keyword, "stage3_alias"],
                    "url": "https://danbooru.donmai.us/artists/303",
                    "works_url": f"https://danbooru.donmai.us/posts?tags={artist_name}",
                    "origin": "danbooru_artist_directory",
                }
            ]
        }

    async def search(self, **kwargs: Any) -> dict[str, Any]:
        site = str(kwargs["site"])
        keyword = str(kwargs["keyword"])
        base_keyword = self._base_keyword(keyword)
        with self._lock:
            self.search_calls.append({
                "site": site,
                "keyword": keyword,
                "limit": int(kwargs["limit"]),
                "proxy_mode": kwargs.get("proxy_mode"),
            })
        if delay := self._delay(keyword):
            await asyncio.sleep(delay)
        if keyword == "stage3_alias" and site == "exhentai":
            raise DiscoveryError("exhentai_alias_search_failed", "synthetic alias partial")
        if base_keyword == "no-result" or keyword == "stage3_alias":
            candidates: list[dict[str, Any]] = []
        elif base_keyword == "transport-error" and site == "pawchive":
            raise DiscoveryError("proxy_pool_unavailable", "synthetic transport boundary")
        else:
            candidate = _candidate(site)
            if site == "pawchive":
                candidate["title"] = base_keyword
                second = _candidate(site, "2")
                second["title"] = f"{base_keyword} archive"
                candidates = [candidate, second]
            else:
                candidates = [candidate]
            if site == "exhentai":
                candidates[0]["thumbnail_url"] = ""
            if site == "danbooru":
                candidates = [{
                    "id": "post-1",
                    "site": "danbooru",
                    "kind": "post",
                    "url": "https://danbooru.donmai.us/posts/3301",
                    "metadata": {"artists": ["stage3_artist"]},
                }]
        return {
            "site": site,
            "keyword": keyword,
            "search_url": f"https://example.invalid/{site}/search",
            "candidate_count": len(candidates),
            "author_count": 0,
            "candidates": candidates,
            "authors": ([{
                "id": "paw-1",
                "site": "pawchive",
                "kind": "author",
                "name": base_keyword,
                "display_name": base_keyword,
                "url": "https://pawchive.pw/artists/stage3_1",
                "works_url": "https://pawchive.pw/artists/stage3_1",
            }] if site == "pawchive" else []),
            "proxy": {"mode": kwargs.get("proxy_mode") or "direct", "used": False},
            "attempts": 1,
        }

    async def enrich_exhentai_previews(self, result: dict[str, Any], **_kwargs: Any) -> dict[str, Any]:
        enriched = {**result, "preview_count": len(result.get("candidates") or []), "preview_missing_count": 0}
        candidates = []
        for raw in result.get("candidates") or []:
            candidates.append({
                **raw,
                "thumbnail_url": None,
                "metadata": {
                    **(raw.get("metadata") or {}),
                    "tags": ["artist:stage3", "language:chinese"],
                },
            })
        enriched["candidates"] = candidates
        if result.get("keyword") == "partial":
            enriched["preview_missing_count"] = 1
        return enriched

    async def danbooru_artist_profiles(self, _artist_names: list[str], **_kwargs: Any):
        artist_name = str(_artist_names[0])
        return ([{
            "id": "303",
            "name": artist_name,
            "other_names": ["stage3_alias"],
            "group_name": None,
            "profile_url": "https://danbooru.donmai.us/artists/303",
            "related_profiles": [
                {
                    "url": f"https://x.com/{artist_name}",
                    "platform": "twitter",
                    "crawl_site": "twitter",
                    "crawl_url": f"https://x.com/{artist_name}/media",
                    "active": True,
                },
                {
                    "url": "https://www.pixiv.net/users/303",
                    "platform": "pixiv",
                    "crawl_site": "pixiv",
                    "crawl_url": "https://www.pixiv.net/users/303/artworks",
                    "active": True,
                },
            ],
        }], [])

    async def danbooru_autocomplete(self, query: str, *, limit: int, **_kwargs: Any) -> dict[str, Any]:
        with self._lock:
            self.autocomplete_calls.append({"query": query, "limit": limit})
        if query.startswith("slow"):
            await asyncio.sleep(0.75)
        elif query.startswith("fast"):
            await asyncio.sleep(0.05)
        else:
            await asyncio.sleep(0.12)
        return {
            "query": query,
            "items": [
                {
                    "value": f"{query.replace(' ', '_')}_artist",
                    "label": f"{query} artist",
                    "match_type": "tag",
                    "antecedent": "",
                    "category": "artist",
                    "post_count": 303,
                },
                {
                    "value": f"{query.replace(' ', '_')}_character",
                    "label": f"{query} character",
                    "match_type": "tag",
                    "antecedent": "",
                    "category": "character",
                    "post_count": 101,
                },
            ][:limit],
            "proxy": {"used": False},
            "attempts": 1,
        }


class Stage3Container(ServiceContainer):
    def __init__(self, settings):
        super().__init__(settings)
        self.stage3_discovery = Stage3DiscoveryHarness()
        self.discovery.search_danbooru_artists = self.stage3_discovery.search_danbooru_artists
        self.discovery.search = self.stage3_discovery.search
        self.discovery.enrich_exhentai_previews = self.stage3_discovery.enrich_exhentai_previews
        self.discovery.danbooru_artist_profiles = self.stage3_discovery.danbooru_artist_profiles
        self.discovery.danbooru_autocomplete = self.stage3_discovery.danbooru_autocomplete
        self.resolver.resolve = lambda url: SiteInfo(
            "exhentai" if "hentai.org" in url else
            "twitter" if "x.com" in url else
            "pixiv" if "pixiv.net" in url else
            "pawchive" if "pawchive" in url else
            "danbooru",
            "",
            "Stage3HarnessExtractor",
            True,
            "stage3.invalid",
        )
        self.ordered_crawls.notify = lambda: None


def build_harness(root: Path, port: int):
    settings = make_settings(root)
    settings.server.port = port
    settings.server.allow_private_targets = True
    container = Stage3Container(settings)
    app = create_app(settings, container=container, start_background=False)

    @app.middleware("http")
    async def stage3_search_faults(request, call_next):
        if request.url.path == "/api/v1/search" and request.method == "POST":
            raw = await request.body()
            try:
                body = json.loads(raw or b"{}")
            except (TypeError, ValueError):
                body = {}
            container.stage3_discovery.search_requests.append({
                "keyword": str(body.get("keyword") or ""),
                "limit": body.get("limit"),
                "sites": list(body.get("sites") or []),
            })
            if body.get("keyword") == "server-422":
                from fastapi.responses import JSONResponse
                return JSONResponse(
                    status_code=422,
                    content={
                        "error": {
                            "code": "invalid_search_fault",
                            "message": "synthetic test-only 422",
                            "request_id": "stage3-search-422",
                        }
                    },
                )
        return await call_next(request)

    @app.get("/__stage3__/facts", include_in_schema=False)
    async def stage3_facts():
        batches = container.db.list_crawl_batches(limit=50, offset=0)
        return {
            "batches": [container.db.get_crawl_batch(item["id"]) for item in batches],
            "search_calls": list(container.stage3_discovery.search_calls),
            "search_requests": list(container.stage3_discovery.search_requests),
            "autocomplete_calls": list(container.stage3_discovery.autocomplete_calls),
            "background_started": False,
        }

    return app


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18788)
    parser.add_argument("--root", type=Path)
    args = parser.parse_args()
    if args.root is None:
        temporary = tempfile.TemporaryDirectory(prefix="imageweave-stage3-harness-")
        root = Path(temporary.name)
    else:
        temporary = None
        root = args.root
        root.mkdir(parents=True, exist_ok=True)
    app = build_harness(root, args.port)
    try:
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
    finally:
        if temporary is not None:
            temporary.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
