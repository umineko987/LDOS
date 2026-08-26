"""数据集导出合同纯函数（docs/图库(含导出).md §3.9、§5.6、§10.5）。

导出状态机、来源别名与输出相对路径、Manifest v1 记录构造与敏感字段
校验。复制、hash、暂存与提交引擎（G5）必须复用这些定义；API 层不得
自行拼装输出路径或绕过 manifest 校验。
"""

from __future__ import annotations

import json
import re
from pathlib import PurePosixPath
from typing import Any, Iterable, Mapping

from .gallery_catalog import (
    IMAGEWEAVE_RESERVED_DIR,
    is_safe_relative_path,
    natural_sort_key,
)


MANIFEST_SCHEMA_VERSION = 1
STAGING_DIR_NAME = "staging"
EXPORTS_DIR_NAME = "exports"

ExportJobState = str

DATASET_EXPORT_JOB_STATES: frozenset[ExportJobState] = frozenset(
    {
        "draft",
        "preflighting",
        "blocked",
        "ready",
        "staging",
        "paused",
        "failed",
        "staged",
        "committing",
        "completed",
        "discarded",
        "recovery_required",
    }
)
DATASET_EXPORT_TERMINAL_STATES: frozenset[ExportJobState] = frozenset(
    {"completed", "discarded"}
)

# §5.6 状态机：draft → preflighting → blocked|ready → staging →
# paused|failed|staged → committing → completed；继续/丢弃/恢复分支如下。
VALID_EXPORT_TRANSITIONS: dict[ExportJobState, frozenset[ExportJobState]] = {
    "draft": frozenset({"preflighting", "discarded"}),
    "preflighting": frozenset({"blocked", "ready", "discarded"}),
    "blocked": frozenset({"preflighting", "discarded"}),
    "ready": frozenset({"staging", "discarded"}),
    "staging": frozenset({"paused", "failed", "staged", "blocked"}),
    "paused": frozenset({"staging", "discarded"}),
    "failed": frozenset({"staging", "discarded"}),
    "staged": frozenset({"committing", "discarded"}),
    "committing": frozenset({"completed", "recovery_required"}),
    "recovery_required": frozenset({"committing", "staged", "discarded"}),
    "completed": frozenset(),
    "discarded": frozenset(),
}

_ALIAS_FORBIDDEN = re.compile(r"[\x00-\x1f\x7f/\\:*?\"<>|]")
_ABSOLUTE_PATH_LIKE = re.compile(r"^(?:/|[A-Za-z]:[\\/]|\\\\)")
_FORBIDDEN_KEY_TOKENS = (
    "cookie",
    "token",
    "authorization",
    "proxy",
    "password",
    "secret",
    "api_key",
    "credential",
    "absolute_path",
)


def can_transition_export_state(current: ExportJobState, target: ExportJobState) -> bool:
    if current not in VALID_EXPORT_TRANSITIONS or target not in DATASET_EXPORT_JOB_STATES:
        return False
    return target in VALID_EXPORT_TRANSITIONS[current]


def validate_export_alias(alias: str) -> str:
    """输出别名必须是单个安全目录名，冲突时要求用户修正而非静默加后缀。"""
    if not isinstance(alias, str) or not alias.strip():
        raise ValueError("invalid_export_alias")
    if alias in {".", ".."} or alias == IMAGEWEAVE_RESERVED_DIR:
        raise ValueError("invalid_export_alias")
    if _ALIAS_FORBIDDEN.search(alias) or alias.endswith(" ") or alias.endswith("."):
        raise ValueError("invalid_export_alias")
    return alias


def export_output_relative_path(alias: str, source_relative_path: str) -> PurePosixPath:
    """`<别名>/<原相对路径>`；别名与来源相对路径都先通过合同校验。"""
    validate_export_alias(alias)
    if not is_safe_relative_path(source_relative_path):
        raise ValueError(f"invalid_source_relative_path:{source_relative_path!r}")
    return PurePosixPath(alias) / PurePosixPath(source_relative_path)


def export_staging_relative_dir(export_id: str) -> PurePosixPath:
    """任务暂存区 `<目标>/.imageweave/staging/<export-id>/`（§3.9）。"""
    if not export_id or "/" in export_id or "\\" in export_id or ".." in export_id:
        raise ValueError("invalid_export_id")
    return PurePosixPath(IMAGEWEAVE_RESERVED_DIR) / STAGING_DIR_NAME / export_id


def export_manifest_relative_path(export_id: str) -> PurePosixPath:
    """独立清单 `<目标>/.imageweave/exports/<export-id>.jsonl`（§3.9）。"""
    if not export_id or "/" in export_id or "\\" in export_id or ".." in export_id:
        raise ValueError("invalid_export_id")
    return PurePosixPath(IMAGEWEAVE_RESERVED_DIR) / EXPORTS_DIR_NAME / f"{export_id}.jsonl"


def build_export_manifest_task_record(
    *,
    export_id: str,
    created_at: float,
    completed_at: float,
    sources: Iterable[Mapping[str, Any]],
    sample_count: int,
    image_bytes: int,
    txt_bytes: int,
    snapshot_digest: str,
) -> dict[str, Any]:
    """Manifest v1 首行任务记录：只包含选择摘要与统计，不含本机路径。"""
    source_entries = [
        {
            "source_id": str(source["source_id"]),
            "directory_id": str(source["directory_id"]),
            "include_descendants": bool(source["include_descendants"]),
            "output_alias": validate_export_alias(str(source["output_alias"])),
            "source_kind": str(source["source_kind"]),
        }
        for source in sources
    ]
    return {
        "record_type": "export",
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "export_id": str(export_id),
        "created_at": float(created_at),
        "completed_at": float(completed_at),
        "sources": source_entries,
        "sample_count": int(sample_count),
        "image_bytes": int(image_bytes),
        "txt_bytes": int(txt_bytes),
        "snapshot_digest": str(snapshot_digest),
    }


def build_export_manifest_sample_record(
    *,
    image_path: str,
    txt_path: str,
    image_format: str,
    image_width: int,
    image_height: int,
    image_bytes: int,
    image_sha256: str,
    txt_bytes: int,
    txt_sha256: str,
    source_kind: str,
    source_id: str,
    source_relative_path: str,
) -> dict[str, Any]:
    """Manifest v1 样本记录：数据集内相对路径 + 内容事实 + 脱敏来源引用。"""
    return {
        "record_type": "sample",
        "image_path": str(image_path),
        "txt_path": str(txt_path),
        "image_format": str(image_format),
        "image_width": int(image_width),
        "image_height": int(image_height),
        "image_bytes": int(image_bytes),
        "image_sha256": str(image_sha256),
        "txt_bytes": int(txt_bytes),
        "txt_sha256": str(txt_sha256),
        "source_kind": str(source_kind),
        "source_id": str(source_id),
        "source_relative_path": str(source_relative_path),
    }


def validate_manifest_record(record: Mapping[str, Any]) -> None:
    """拒绝禁用键与绝对路径式取值；序列化前强制执行（§10.5）。"""
    if not isinstance(record, Mapping):
        raise ValueError("invalid_manifest_record")
    for key, value in record.items():
        key_text = str(key).lower()
        if any(token in key_text for token in _FORBIDDEN_KEY_TOKENS):
            raise ValueError(f"forbidden_manifest_key:{key}")
        if isinstance(value, str) and key_text.endswith(("_path", "path")):
            if _ABSOLUTE_PATH_LIKE.match(value):
                raise ValueError(f"absolute_path_in_manifest:{key}")
    record_type = record.get("record_type")
    if record_type not in {"export", "sample"}:
        raise ValueError(f"invalid_manifest_record_type:{record_type!r}")
    if record_type == "export" and record.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        raise ValueError("invalid_manifest_schema_version")


def serialize_export_manifest(
    task_record: Mapping[str, Any],
    sample_records: Iterable[Mapping[str, Any]],
) -> str:
    """JSONL：首行任务记录，随后每行一个样本，按输出相对路径稳定自然排序。"""
    validate_manifest_record(task_record)
    if task_record["record_type"] != "export":
        raise ValueError("manifest_requires_export_task_record")
    samples = list(sample_records)
    for sample in samples:
        validate_manifest_record(sample)
        if sample["record_type"] != "sample":
            raise ValueError("manifest_requires_sample_records")
    ordered = sorted(samples, key=lambda sample: natural_sort_key(str(sample["image_path"])))
    lines = [
        json.dumps(task_record, ensure_ascii=True, sort_keys=True, separators=(",", ":")),
        *(
            json.dumps(sample, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
            for sample in ordered
        ),
    ]
    return "\n".join(lines) + "\n"
