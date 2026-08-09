from __future__ import annotations

import json
import unittest

from gdl_backend.discovery_transforms import (
    canonical_gallery_address,
    discovery_addresses,
    exhentai_tag_facets,
    merge_alias_search_results,
    parse_discovery_output,
)


class DiscoveryTransformTests(unittest.TestCase):
    def test_canonical_addresses_are_source_specific_and_stable(self):
        cases = (
            (
                "twitter",
                "https://Twitter.com/Artist_Name/?s=20#fragment",
                "https://x.com/artist_name/media",
            ),
            (
                "pixiv",
                "http://pixiv.net/users/77/?ref=fixture",
                "https://www.pixiv.net/users/77/artworks",
            ),
            (
                "danbooru",
                "https://www.danbooru.donmai.us/posts/?tags=artist_name&z=1",
                "https://danbooru.donmai.us/posts?tags=artist_name",
            ),
            (
                "exhentai",
                "https://e-hentai.org/g/30/aaaaaaaaaa",
                "https://e-hentai.org/g/30/aaaaaaaaaa/",
            ),
            (
                "pawchive",
                "https://www.pawchive.st/patreon/user/42/?o=50",
                "https://pawchive.pw/patreon/user/42",
            ),
        )
        for site, raw, expected in cases:
            with self.subTest(site=site):
                self.assertEqual(canonical_gallery_address(site, raw), expected)

    def test_output_parser_deduplicates_without_reordering_first_hits(self):
        payload = [
            [
                6,
                "https://e-hentai.org/g/30/aaaaaaaaaa/",
                {"gallery_id": 30, "gallery_token": "aaaaaaaaaa"},
            ],
            [
                6,
                "https://e-hentai.org/g/20/bbbbbbbbbb/",
                {"gallery_id": 20, "gallery_token": "bbbbbbbbbb"},
            ],
            [
                6,
                "https://e-hentai.org/g/30/cccccccccc/",
                {"gallery_id": 30, "gallery_token": "cccccccccc"},
            ],
        ]

        candidates, authors = parse_discovery_output(
            "exhentai",
            json.dumps(payload),
            source_url="https://e-hentai.org/?f_search=fixture",
            limit=20,
        )

        self.assertEqual([item["id"] for item in candidates], ["30", "20"])
        self.assertEqual(candidates[0]["metadata"]["gallery_token"], "aaaaaaaaaa")
        self.assertEqual(authors, [])

    def test_alias_merge_keeps_primary_order_and_records_all_terms(self):
        primary = {
            "search_url": "https://e-hentai.org/?f_search=primary",
            "candidates": [{"id": "a"}, {"id": "b"}],
            "authors": [{"name": "one", "works_url": "https://example.test/one"}],
            "attempts": 1,
        }
        alias = {
            "candidates": [{"id": "b"}, {"id": "c"}],
            "authors": [
                {"name": "one", "works_url": "https://example.test/one"},
                {"name": "two", "works_url": "https://example.test/two"},
            ],
            "attempts": 2,
        }

        merged = merge_alias_search_results(
            "primary",
            primary,
            [("別名", alias)],
            limit=3,
        )

        self.assertEqual([item["id"] for item in merged["candidates"]], ["a", "b", "c"])
        self.assertEqual(merged["candidates"][1]["matched_keywords"], ["primary", "別名"])
        self.assertEqual([item["name"] for item in merged["authors"]], ["one", "two"])
        self.assertEqual(merged["attempts"], 3)

    def test_public_address_projection_preserves_evidence_and_tag_facets(self):
        result = {
            "alias_keywords": ["別名"],
            "candidates": [
                {
                    "id": "30",
                    "title": "direct",
                    "download_url": "https://e-hentai.org/g/30/aaaaaaaaaa/",
                    "matched_keywords": ["fixture", "別名"],
                    "metadata": {"tags": ["artist:first", "language:english"]},
                },
                {
                    "id": "20",
                    "title": "alias only",
                    "download_url": "https://e-hentai.org/g/20/bbbbbbbbbb/",
                    "matched_keywords": ["別名"],
                    "metadata": {"tags": ["artist:second"]},
                },
            ],
        }

        addresses = discovery_addresses(
            "exhentai",
            result,
            keyword="fixture",
            limit=20,
        )
        facets = exhentai_tag_facets(addresses)

        self.assertEqual(
            [item["id"] for item in addresses],
            ["exhentai:gallery:30", "exhentai:gallery:20"],
        )
        self.assertEqual(
            addresses[0]["evidence_reasons"],
            ["keyword_gallery_search", "danbooru_alias_search"],
        )
        self.assertEqual(addresses[1]["evidence_reasons"], ["danbooru_alias_search"])
        self.assertEqual([item["namespace"] for item in facets], ["artist", "language"])
        self.assertEqual(facets[0]["gallery_count"], 2)


if __name__ == "__main__":
    unittest.main()
