from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Any


TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}
ACTIVE_STATUSES = {"starting", "running", "cancelling"}
TERMINAL_BATCH_STATUSES = {"succeeded", "completed_with_errors", "cancelled"}

ReadFactory = Callable[[], AbstractContextManager[sqlite3.Connection]]
TransactionFactory = Callable[[], AbstractContextManager[sqlite3.Connection]]
Clock = Callable[[], float]
UuidFactory = Callable[[], Any]


def project_task(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for key, default in (
        ("extra_args_json", []),
        ("policy_json", {}),
        ("tried_proxy_ids_json", []),
    ):
        target = key.removesuffix("_json")
        try:
            data[target] = json.loads(data.pop(key) or "null")
        except Exception:
            data[target] = default
            data.pop(key, None)
    data["cancel_requested"] = bool(data.get("cancel_requested"))
    return data


def project_attempt(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    data["retryable"] = bool(data.get("retryable"))
    return data


def project_crawl_batch(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    data["cancel_requested"] = bool(data.get("cancel_requested"))
    return data


def project_crawl_address(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for key, default in (
        ("download_options_json", {}),
        ("extra_args_json", []),
        ("discovery_args_json", []),
    ):
        target = key.removesuffix("_json")
        try:
            data[target] = json.loads(data.pop(key) or "null")
        except Exception:
            data[target] = default
            data.pop(key, None)
    return data


def project_crawl_review(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return dict(row)


def project_crawl_review_group(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    try:
        data["match_levels"] = json.loads(data.pop("match_levels_json") or "[]")
    except Exception:
        data["match_levels"] = []
        data.pop("match_levels_json", None)
    data["decided"] = bool(data.get("decided"))
    return data


def project_crawl_review_image(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    try:
        data["metadata"] = json.loads(data.pop("metadata_json") or "{}")
    except Exception:
        data["metadata"] = {}
        data.pop("metadata_json", None)
    for key in ("readable", "recommended", "selected"):
        data[key] = bool(data.get(key))
    return data
