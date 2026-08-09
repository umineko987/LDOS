from __future__ import annotations

import unittest

from gdl_backend._scheduler_decisions import (
    ProxyFailurePlan,
    attempt_status,
    decide_task_transition,
    parse_task_policy,
    proxy_failure_plan,
    resolve_allowed_proxy_ids,
    retry_delay_seconds,
    updated_tried_proxy_ids,
    upgrade_partial_artifact_failure,
)
from gdl_backend.classifier import FailureDecision
from gdl_backend.schemas import TaskPolicy


class SchedulerDecisionTests(unittest.TestCase):
    def test_policy_parsing_is_pure_and_uses_persisted_values(self):
        raw = {
            "policy": {
                "max_concurrency": 3,
                "retry_limit": 2,
                "proxy_mode": "required",
                "allowed_proxy_ids": ["node-a", "node-b"],
            }
        }
        snapshot = {"policy": dict(raw["policy"])}

        policy = parse_task_policy(raw)

        self.assertEqual(policy.max_concurrency, 3)
        self.assertEqual(policy.proxy_mode, "required")
        self.assertEqual(policy.allowed_proxy_ids, ["node-a", "node-b"])
        self.assertEqual(raw, snapshot)
        self.assertEqual(parse_task_policy({}), TaskPolicy())

    def test_allowed_proxy_ids_prefer_explicit_then_probe_data(self):
        explicit = TaskPolicy(
            proxy_mode="required",
            allowed_proxy_ids=["explicit-b", "explicit-a"],
            proxy_probe_scope="address-1",
        )
        scoped = TaskPolicy(proxy_mode="required", proxy_probe_scope="address-1")
        unscoped = TaskPolicy(proxy_mode="required")

        self.assertEqual(
            resolve_allowed_proxy_ids(explicit, ["probe-only"]),
            {"explicit-a", "explicit-b"},
        )
        self.assertEqual(
            resolve_allowed_proxy_ids(scoped, ["probe-a", "probe-b"]),
            {"probe-a", "probe-b"},
        )
        self.assertEqual(resolve_allowed_proxy_ids(scoped, None), set())
        self.assertIsNone(resolve_allowed_proxy_ids(unscoped, ["ignored"]))

    def test_proxy_failure_matrix_preserves_required_and_prefer_rules(self):
        expected = {
            ("prefer", "pool_unavailable"): ProxyFailurePlan("fail", False, False),
            ("required", "pool_unavailable"): ProxyFailurePlan("fail", False, False),
            ("prefer", "acquire_error"): ProxyFailurePlan("fallback_direct", False, False),
            ("prefer", "empty"): ProxyFailurePlan("fallback_direct", False, False),
            ("required", "acquire_error"): ProxyFailurePlan("fail", True, True),
            ("required", "empty"): ProxyFailurePlan("fail", True, False),
        }
        for (mode, outcome), plan in expected.items():
            with self.subTest(mode=mode, outcome=outcome):
                self.assertEqual(proxy_failure_plan(mode, outcome), plan)

        with self.assertRaises(ValueError):
            proxy_failure_plan("direct", "empty")

    def test_partial_upgrade_is_narrow_and_keeps_failure_details(self):
        extraction = FailureDecision("extraction_error", False, True, "parse failed")
        already_retryable = FailureDecision("extraction_error", True, True, "parse failed")
        network = FailureDecision("network", True, True, "network failed")

        upgraded = upgrade_partial_artifact_failure(extraction, 1)

        self.assertEqual(
            upgraded,
            FailureDecision("extraction_partial", True, True, "parse failed"),
        )
        self.assertIs(upgrade_partial_artifact_failure(extraction, 0), extraction)
        self.assertIs(
            upgrade_partial_artifact_failure(already_retryable, 1),
            already_retryable,
        )
        self.assertIs(upgrade_partial_artifact_failure(network, 1), network)

    def test_task_transitions_cover_success_failure_cancel_and_bounded_retry(self):
        success = FailureDecision("success", False, False, "ok")
        failure = FailureDecision("extraction_error", False, False, "failed")
        retry = FailureDecision("download_error", True, False, "retry")
        cancelled = FailureDecision("cancelled", False, False, "cancelled")

        self.assertEqual(attempt_status(success), "succeeded")
        self.assertEqual(attempt_status(failure), "failed")
        self.assertEqual(attempt_status(cancelled), "cancelled")
        self.assertEqual(
            decide_task_transition(
                success,
                cancel_requested=False,
                attempt_no=1,
                max_attempts=1,
            ),
            "succeeded",
        )
        self.assertEqual(
            decide_task_transition(
                failure,
                cancel_requested=False,
                attempt_no=1,
                max_attempts=3,
            ),
            "failed",
        )
        self.assertEqual(
            decide_task_transition(
                retry,
                cancel_requested=False,
                attempt_no=1,
                max_attempts=2,
            ),
            "requeue",
        )
        self.assertEqual(
            decide_task_transition(
                retry,
                cancel_requested=False,
                attempt_no=2,
                max_attempts=2,
            ),
            "failed",
        )
        self.assertEqual(
            decide_task_transition(
                success,
                cancel_requested=True,
                attempt_no=1,
                max_attempts=2,
            ),
            "cancelled",
        )
        self.assertEqual(
            decide_task_transition(
                cancelled,
                cancel_requested=False,
                attempt_no=1,
                max_attempts=2,
            ),
            "cancelled",
        )

    def test_retry_delay_caps_history_and_manual_anchor_restarts_exponent(self):
        self.assertEqual(
            retry_delay_seconds(
                base_seconds=2.0,
                attempt_no=21,
                backoff_anchor_attempt=0,
                cap_seconds=300.0,
                jitter_seconds=0.75,
            ),
            300.75,
        )
        self.assertEqual(
            retry_delay_seconds(
                base_seconds=2.0,
                attempt_no=21,
                backoff_anchor_attempt=20,
                cap_seconds=300.0,
                jitter_seconds=0.75,
            ),
            2.75,
        )
        self.assertEqual(
            retry_delay_seconds(
                base_seconds=2.0,
                attempt_no=22,
                backoff_anchor_attempt=20,
                cap_seconds=300.0,
                jitter_seconds=0.0,
            ),
            4.0,
        )

    def test_proxy_fault_history_is_deduplicated_without_mutating_input(self):
        original = ["node-a"]
        self.assertEqual(
            updated_tried_proxy_ids(
                original,
                proxy_node_id="node-b",
                proxy_fault=True,
            ),
            ["node-a", "node-b"],
        )
        self.assertEqual(original, ["node-a"])
        self.assertEqual(
            updated_tried_proxy_ids(
                original,
                proxy_node_id="node-a",
                proxy_fault=True,
            ),
            ["node-a"],
        )
        self.assertEqual(
            updated_tried_proxy_ids(
                original,
                proxy_node_id="node-b",
                proxy_fault=False,
            ),
            ["node-a"],
        )


if __name__ == "__main__":
    unittest.main()
