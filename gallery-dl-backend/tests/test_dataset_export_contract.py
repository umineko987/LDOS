from __future__ import annotations

import json
import unittest

from gdl_backend.dataset_export import (
    DATASET_EXPORT_JOB_STATES,
    DATASET_EXPORT_TERMINAL_STATES,
    MANIFEST_SCHEMA_VERSION,
    build_export_manifest_sample_record,
    build_export_manifest_task_record,
    can_transition_export_state,
    export_manifest_relative_path,
    export_output_relative_path,
    export_staging_relative_dir,
    serialize_export_manifest,
    validate_export_alias,
    validate_manifest_record,
    VALID_EXPORT_TRANSITIONS,
)


class ExportStateMachineContractTest(unittest.TestCase):
    def test_happy_path_is_linear(self) -> None:
        path = [
            ("draft", "preflighting"),
            ("preflighting", "ready"),
            ("ready", "staging"),
            ("staging", "staged"),
            ("staged", "committing"),
            ("committing", "completed"),
        ]
        for current, target in path:
            self.assertTrue(can_transition_export_state(current, target), (current, target))

    def test_interruption_and_recovery_branches(self) -> None:
        for current, target in (
            ("preflighting", "blocked"),
            ("blocked", "preflighting"),
            ("staging", "paused"),
            ("staging", "failed"),
            ("staging", "blocked"),
            ("paused", "staging"),
            ("failed", "staging"),
            ("staged", "committing"),
            ("committing", "recovery_required"),
            ("recovery_required", "committing"),
            ("recovery_required", "staged"),
        ):
            self.assertTrue(can_transition_export_state(current, target), (current, target))

    def test_discard_is_reachable_from_every_idle_state(self) -> None:
        # 两个例外：staging 正在复制，必须先暂停/失败再丢弃暂存；
        # committing 提交中途只能先进入 recovery_required，由恢复流程决定
        # 继续提交、退回暂存或丢弃，不允许半提交/半复制状态下直接丢弃。
        for state in (
            DATASET_EXPORT_JOB_STATES
            - DATASET_EXPORT_TERMINAL_STATES
            - {"committing", "staging"}
        ):
            self.assertTrue(can_transition_export_state(state, "discarded"), state)

    def test_invalid_or_backward_jumps_are_rejected(self) -> None:
        for current, target in (
            ("draft", "staging"),
            ("draft", "ready"),
            ("ready", "preflighting"),
            ("completed", "staging"),
            ("completed", "preflighting"),
            ("discarded", "staging"),
            ("blocked", "ready"),
            ("staged", "staging"),
            ("unknown", "ready"),
            ("ready", "unknown"),
        ):
            self.assertFalse(can_transition_export_state(current, target), (current, target))

    def test_terminal_states_have_no_outgoing_edges(self) -> None:
        for state in DATASET_EXPORT_TERMINAL_STATES:
            self.assertEqual(VALID_EXPORT_TRANSITIONS[state], frozenset())


class ExportPathContractTest(unittest.TestCase):
    def test_alias_must_be_a_single_safe_component(self) -> None:
        self.assertEqual(validate_export_alias("batch-2026"), "batch-2026")
        self.assertEqual(validate_export_alias("导入目录"), "导入目录")
        for bad in (
            "",
            " ",
            ".",
            "..",
            ".imageweave",
            "a/b",
            "a\\b",
            "a:b",
            "a*b",
            "a?b",
            'a"b',
            "a<b",
            "a|b",
            "trailing ",
            "trailing.",
            "a\nb",
        ):
            with self.assertRaises(ValueError, msg=repr(bad)):
                validate_export_alias(bad)

    def test_output_path_preserves_source_relative_tree_under_alias(self) -> None:
        self.assertEqual(
            str(export_output_relative_path("batch-a", "sub/2.jpg")),
            "batch-a/sub/2.jpg",
        )
        with self.assertRaises(ValueError):
            export_output_relative_path("batch-a", "../escape.jpg")
        with self.assertRaises(ValueError):
            export_output_relative_path("batch-a", "/abs/1.jpg")
        with self.assertRaises(ValueError):
            export_output_relative_path("bad/alias", "a.jpg")

    def test_staging_and_manifest_live_in_hidden_target_tree(self) -> None:
        self.assertEqual(
            str(export_staging_relative_dir("exp-1")), ".imageweave/staging/exp-1"
        )
        self.assertEqual(
            str(export_manifest_relative_path("exp-1")),
            ".imageweave/exports/exp-1.jsonl",
        )
        for bad in ("", "..", "a/b", "a\\b"):
            with self.assertRaises(ValueError):
                export_staging_relative_dir(bad)
            with self.assertRaises(ValueError):
                export_manifest_relative_path(bad)


class ManifestContractTest(unittest.TestCase):
    def _task_record(self) -> dict:
        return build_export_manifest_task_record(
            export_id="exp-1",
            created_at=1000.0,
            completed_at=2000.0,
            sources=[
                {
                    "source_id": "src-1",
                    "directory_id": "dir-1",
                    "include_descendants": True,
                    "output_alias": "batch-a",
                    "source_kind": "crawl_batch",
                }
            ],
            sample_count=2,
            image_bytes=100,
            txt_bytes=20,
            snapshot_digest="digest-1",
        )

    def _samples(self) -> list[dict]:
        return [
            build_export_manifest_sample_record(
                image_path="batch-a/sub/10.jpg",
                txt_path="batch-a/sub/10.txt",
                image_format="jpeg",
                image_width=800,
                image_height=600,
                image_bytes=60,
                image_sha256="b" * 64,
                txt_bytes=10,
                txt_sha256="c" * 64,
                source_kind="crawl_batch",
                source_id="src-1",
                source_relative_path="sub/10.jpg",
            ),
            build_export_manifest_sample_record(
                image_path="batch-a/2.png",
                txt_path="batch-a/2.txt",
                image_format="png",
                image_width=80,
                image_height=60,
                image_bytes=40,
                image_sha256="d" * 64,
                txt_bytes=10,
                txt_sha256="e" * 64,
                source_kind="crawl_batch",
                source_id="src-1",
                source_relative_path="2.png",
            ),
        ]

    def test_task_record_shape_matches_v1_contract(self) -> None:
        record = self._task_record()
        self.assertEqual(record["record_type"], "export")
        self.assertEqual(record["schema_version"], MANIFEST_SCHEMA_VERSION)
        self.assertEqual(record["export_id"], "exp-1")
        self.assertEqual(record["sample_count"], 2)
        self.assertEqual(
            record["sources"],
            [
                {
                    "source_id": "src-1",
                    "directory_id": "dir-1",
                    "include_descendants": True,
                    "output_alias": "batch-a",
                    "source_kind": "crawl_batch",
                }
            ],
        )

    def test_serialization_is_jsonl_task_first_samples_naturally_sorted(self) -> None:
        text = serialize_export_manifest(self._task_record(), self._samples())
        lines = text.splitlines()
        self.assertEqual(len(lines), 3)
        self.assertTrue(text.endswith("\n"))
        first = json.loads(lines[0])
        self.assertEqual(first["record_type"], "export")
        # 自然排序：2.png 先于 10.jpg。
        self.assertEqual(
            [json.loads(line)["image_path"] for line in lines[1:]],
            ["batch-a/2.png", "batch-a/sub/10.jpg"],
        )

    def test_manifest_is_deterministic_for_the_same_snapshot(self) -> None:
        first = serialize_export_manifest(self._task_record(), self._samples())
        second = serialize_export_manifest(self._task_record(), self._samples())
        self.assertEqual(first, second)

    def test_manifest_rejects_secrets_and_absolute_paths(self) -> None:
        with self.assertRaises(ValueError):
            validate_manifest_record(
                {**self._samples()[0], "cookie": "session=1", "record_type": "sample"}
            )
        with self.assertRaises(ValueError):
            validate_manifest_record(
                {**self._samples()[0], "proxy_url": "http://127.0.0.1:7890", "record_type": "sample"}
            )
        with self.assertRaises(ValueError):
            validate_manifest_record(
                {
                    **self._samples()[0],
                    "image_path": "/home/user/images/2.png",
                    "record_type": "sample",
                }
            )
        with self.assertRaises(ValueError):
            validate_manifest_record(
                {
                    **self._samples()[0],
                    "txt_path": "C:\\data\\2.txt",
                    "record_type": "sample",
                }
            )

    def test_manifest_rejects_wrong_record_types_and_schema_versions(self) -> None:
        with self.assertRaises(ValueError):
            serialize_export_manifest(
                {**self._task_record(), "schema_version": 2}, self._samples()
            )
        with self.assertRaises(ValueError):
            serialize_export_manifest(
                self._task_record(),
                [{**self._samples()[0], "record_type": "export"}],
            )
        with self.assertRaises(ValueError):
            serialize_export_manifest(self._samples()[0], self._samples())


if __name__ == "__main__":
    unittest.main()
