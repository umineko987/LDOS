from __future__ import annotations

import json
import unittest

from gdl_backend.proxy_policy import (
    ProxyNodeRecord,
    cached_probe_projection,
    mark_cached_node_unhealthy,
    merge_single_probe_projection,
    node_tags,
    probe_cache_key,
    probe_parts,
    project_node_row,
    project_pool_status,
    public_probe_target,
    select_lease_candidates,
)


class ProxyPolicyTests(unittest.TestCase):
    def test_node_labels_are_exact_tokens_and_region_aliases(self):
        self.assertIn("jp", node_tags("Tokyo 日本", "http", "node.example"))
        self.assertIn("au", node_tags("AUSTRALIA", "http", "node.example"))
        self.assertNotIn("us", node_tags("AUSTRALIA", "http", "node.example"))
        self.assertEqual(node_tags("plain", "SOCKS5", "host"), ["host", "plain", "socks5"])

    def test_probe_target_key_and_public_projection_preserve_host_boundary(self):
        self.assertEqual(
            probe_cache_key("https://CACHE.example/private?token=SECRET"),
            ("https", "cache.example", 443),
        )
        self.assertEqual(
            probe_cache_key("http://cache.example/path"),
            ("http", "cache.example", 80),
        )
        self.assertEqual(
            probe_parts("https://cache.example:444/path"),
            ("cache.example", 444),
        )
        with self.assertRaisesRegex(ValueError, "不接受 URL 凭据"):
            probe_parts("https://user:secret@cache.example/path")
        self.assertEqual(
            public_probe_target("https://cache.example/private?token=SECRET"),
            "https://cache.example/private",
        )

    def test_lease_selection_is_ordered_exact_and_side_effect_free(self):
        records = [
            ProxyNodeRecord("first", "first", "http", "http://first", ["jp"], True),
            ProxyNodeRecord("second", "second", "http", "http://second", ["us"], False),
            ProxyNodeRecord("third", "third", "http", "http://third", ["jp", "us"], True),
        ]
        selected = select_lease_candidates(
            records,
            node_tags_filter=["JP"],
            exclude_ids={"first"},
            allowed_ids={"first", "third"},
            probe_before_use=False,
        )
        self.assertEqual([record.id for record in selected], ["third"])
        preprobe = select_lease_candidates(
            records,
            node_tags_filter=["us"],
            exclude_ids=None,
            allowed_ids=None,
            probe_before_use=True,
        )
        self.assertEqual([record.id for record in preprobe], ["second", "third"])
        self.assertFalse(records[1].healthy)

    def test_probe_cache_projection_ttl_merge_and_fault_are_deep_copies(self):
        original = {
            "total": 2,
            "healthy": 2,
            "cached": False,
            "results": [
                {"id": "first", "healthy": True},
                {"id": "second", "healthy": True},
            ],
        }
        cached = cached_probe_projection((10.0, original), now=11.5, ttl_seconds=5)
        self.assertTrue(cached["cached"])
        self.assertEqual(cached["age_seconds"], 1.5)
        self.assertIsNone(cached_probe_projection((10.0, original), now=15.0, ttl_seconds=5))

        merged = merge_single_probe_projection(
            original,
            node_id="first",
            node_result={"id": "first", "healthy": False},
        )
        self.assertEqual(merged["healthy"], 1)
        self.assertTrue(original["results"][0]["healthy"])
        faulted = mark_cached_node_unhealthy(merged, node_id="second")
        self.assertIsNone(faulted)
        self.assertTrue(original["results"][1]["healthy"])

    def test_status_projection_is_an_exact_redacted_allowlist(self):
        record = ProxyNodeRecord(
            id="node-id",
            name="safe-name",
            protocol="http",
            endpoint="http://user:password@127.0.0.1:18080",
            tags=["jp"],
            healthy=True,
            last_error="password=TOP_SECRET",
        )
        row = project_node_row(
            record,
            pool_status={"leased": False, "cooldown_left": 0.0},
            running=True,
            now=10.0,
        )
        status = project_pool_status(
            enabled=True,
            engine="native",
            auto_start=False,
            running=True,
            configured_revision="configured",
            active_revision="active",
            nodes=[row],
            lease_count=0,
            last_error="",
            transport_core={"enabled": False, "running": False},
            source_summary={"warnings": []},
            probe_cache_entries=1,
            probe_cache_ttl_seconds=600,
        )
        self.assertEqual(
            set(status),
            {
                "enabled",
                "engine",
                "managed_by_backend",
                "auto_start",
                "executable_required",
                "running",
                "configured_revision",
                "active_revision",
                "reload_required",
                "total",
                "healthy",
                "retry_eligible",
                "leases",
                "last_error",
                "transport_core",
                "sources",
                "probe_cache",
                "nodes",
            },
        )
        rendered = json.dumps(status)
        self.assertNotIn("user:", rendered)
        self.assertNotIn("password@", rendered)
        self.assertNotIn("TOP_SECRET", rendered)
        self.assertEqual(row["endpoint"], "http://***@127.0.0.1:18080")


if __name__ == "__main__":
    unittest.main()
