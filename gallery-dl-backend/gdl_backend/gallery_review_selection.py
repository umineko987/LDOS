"""Registered Gallery selection and immutable review file identities."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .gallery_safe_paths import SafeSourceRoot, UnsafeSourcePathError, validate_relative_path

EXCLUDED_REVIEW_DIRECTORIES = frozenset({".ldos", "duplicates", "keep", "trashed", "trash"})


def excluded_review_path(relative: str) -> bool:
    return any(part.casefold() in EXCLUDED_REVIEW_DIRECTORIES or part.casefold().startswith(".ldos-")
               for part in validate_relative_path(relative))


def snapshot_asset(repo: Any, asset: dict[str, Any], safe: SafeSourceRoot) -> dict[str, Any]:
    source = repo.get_source(asset["source_id"])
    if source is None or asset["lifecycle_state"] != "active" or asset["dedup_visibility"] == "excluded":
        raise RuntimeError("review_asset_unavailable")
    if excluded_review_path(asset["relative_path"]):
        raise RuntimeError("review_asset_excluded")
    if asset["txt_state"] == "pair_conflict":
        raise RuntimeError("review_txt_pair_conflict")
    result = {key: asset[key] for key in (
        "asset_id", "source_id", "directory_id", "relative_path", "content_version",
        "txt_version", "txt_relative_path", "txt_state",
    )}
    result.update(root_path=source["root_path"], root_identity=list(safe.root_identity()),
                  source_display_name=source["display_name"],
                  disk_version=safe.disk_version(asset["relative_path"]),
                  txt_disk_version=safe.disk_version(asset["txt_relative_path"], allow_missing=True))
    validate_snapshot(repo, result, safe)
    return result


def validate_snapshot(repo: Any, snapshot: dict[str, Any], safe: SafeSourceRoot,
                      *, trash_operation_id: str = "") -> dict[str, Any]:
    source = repo.get_source(snapshot["source_id"])
    asset = repo.get_asset(snapshot["asset_id"])
    if source is None or source["root_path"] != snapshot["root_path"]:
        raise RuntimeError("review_source_changed")
    if list(safe.root_identity()) != snapshot["root_identity"]:
        raise RuntimeError("review_source_root_changed")
    if source.get("batch_id"):
        with repo._read() as conn:
            batch = conn.execute("SELECT status FROM crawl_batches WHERE id=?", (source["batch_id"],)).fetchone()
        if batch is None or batch["status"] not in {"succeeded", "completed_with_errors", "cancelled"}:
            raise RuntimeError("review_source_crawl_active")
    if asset is None or any(asset[key] != snapshot[key] for key in
                            ("source_id", "directory_id", "relative_path", "txt_relative_path", "txt_version")):
        raise RuntimeError("review_asset_changed")
    if trash_operation_id:
        if asset["lifecycle_state"] != "trashed":
            raise RuntimeError("review_trash_changed")
        image_path = f".ldos/trash/{trash_operation_id}/files/{snapshot['relative_path']}"
        txt_path = f".ldos/trash/{trash_operation_id}/files/{snapshot['txt_relative_path']}"
    else:
        if asset["lifecycle_state"] != "active" or asset["content_version"] != snapshot["content_version"]:
            raise RuntimeError("review_asset_version_conflict")
        image_path, txt_path = snapshot["relative_path"], snapshot["txt_relative_path"]
    if safe.disk_version(image_path) != snapshot["disk_version"]:
        raise RuntimeError("review_image_changed")
    if safe.disk_version(txt_path, allow_missing=True) != snapshot["txt_disk_version"]:
        raise RuntimeError("review_txt_changed")
    return asset


def select_review_assets(catalog: Any, directory_ids: list[str],
                         asset_ids: list[str] | tuple[str, ...] = ()) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    repo = catalog._repo
    explicit_assets = []
    for asset_id in dict.fromkeys(asset_ids):
        asset = repo.get_asset(asset_id)
        if asset is None:
            raise KeyError(asset_id)
        explicit_assets.append(asset)
    directories = []
    for directory_id in dict.fromkeys(directory_ids):
        directory = repo.get_directory(directory_id)
        if directory is None:
            raise KeyError(directory_id)
        if directory["relative_path"] and excluded_review_path(directory["relative_path"]):
            raise RuntimeError("review_directory_excluded")
        directories.append(directory)
    source_ids = sorted({row["source_id"] for row in directories} | {row["source_id"] for row in explicit_assets})
    # Shared with scans, relinks, unregister, annotations and file operations.
    with catalog._filesystem_locks.hold(*(f"source:{sid}" for sid in source_ids)):
        for sid in source_ids:
            stats = catalog.scan_source(sid)
            if stats["offline"]:
                raise RuntimeError("review_source_offline")
        selection = []
        snapshots = []
        seen_paths: set[str] = set()
        for sid in source_ids:
            source = repo.get_source(sid)
            if source is None:
                raise RuntimeError("review_source_changed")
            selected = [row for row in directories if row["source_id"] == sid]
            for row in selected:
                current = repo.get_directory(row["directory_id"])
                if current is None or current["relative_path"] != row["relative_path"]:
                    raise RuntimeError("review_directory_changed")
                selection.append({"directory_id": row["directory_id"], "source_id": sid,
                                  "source_display_name": source["display_name"],
                                  "relative_path": row["relative_path"], "name": row["name"]})
            with repo._read() as conn:
                rows = conn.execute("SELECT id FROM gallery_assets WHERE source_id=? AND lifecycle_state='active' AND dedup_visibility!='excluded' ORDER BY relative_path", (sid,)).fetchall()
            with SafeSourceRoot(source["root_path"]) as safe:
                for row in rows:
                    asset = repo.get_asset(row["id"])
                    relative = asset["relative_path"]
                    if excluded_review_path(relative) or not any(not d["relative_path"] or relative.startswith(d["relative_path"] + "/") for d in selected):
                        continue
                    physical = str(Path(source["root_path"]) / relative)
                    if physical in seen_paths:
                        continue
                    seen_paths.add(physical)
                    snapshots.append(snapshot_asset(repo, asset, safe))
                for row in (item for item in explicit_assets if item["source_id"] == sid):
                    # Re-read under the lock so trashed/renamed assets fail closed, like directory rows.
                    asset = repo.get_asset(row["asset_id"])
                    if asset is None or asset["source_id"] != sid:
                        raise RuntimeError("review_asset_changed")
                    physical = str(Path(source["root_path"]) / asset["relative_path"])
                    if physical in seen_paths:
                        continue
                    seen_paths.add(physical)
                    snapshots.append(snapshot_asset(repo, asset, safe))
        if not snapshots:
            raise ValueError("review_selection_empty")
        return selection, snapshots
