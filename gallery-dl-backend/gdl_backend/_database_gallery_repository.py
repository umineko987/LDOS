"""Gallery 索引持久化（docs/图库(含导出).md §5.1–§5.4）。

`GalleryRepository` 拥有 gallery_sources / gallery_directories /
gallery_assets / gallery_search_index 的全部读写。目录与资产 ID 采用
`uuid5(source_id, relative_path)` 保证重扫描稳定；来源根绝对路径只在
后端内部流转，公开投影必须剥离。
"""

from __future__ import annotations

import base64
import json
import uuid
from typing import Any, Iterable, Mapping, Sequence
from ._database_repository import Clock, ReadFactory, TransactionFactory
from .gallery_catalog import (
    is_safe_relative_path,
    natural_sort_key,
    root_relation,
    canonical_root_key,
)


GALLERY_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "ldos:gallery")

GALLERY_PAGE_DEFAULT_LIMIT = 100
GALLERY_PAGE_MAX_LIMIT = 200


class GallerySourceConflictError(Exception):
    """新来源根与现有来源同路径或形成祖先/后代关系（§3.1）。"""

    def __init__(self, relation: str, existing_source: Mapping[str, Any]) -> None:
        super().__init__(f"source_path_conflict:{relation}")
        self.relation = relation
        self.existing_source = dict(existing_source)


class GalleryVersionConflict(Exception):
    """乐观版本检查失败（TXT 保存、文件操作执行前校验）。"""

    def __init__(self, code: str, details: Mapping[str, Any]) -> None:
        super().__init__(code)
        self.code = code
        self.details = dict(details)


class GalleryScanSnapshotConflict(RuntimeError):
    """A scan attempted to commit over a newer Gallery index projection."""


class GalleryCursorError(ValueError):
    """游标格式或取值非法。"""


def gallery_directory_id(source_id: str, relative_path: str) -> str:
    return str(uuid.uuid5(GALLERY_NAMESPACE, f"directory:{source_id}:{relative_path}"))


def gallery_asset_id(source_id: str, relative_path: str) -> str:
    return str(uuid.uuid5(GALLERY_NAMESPACE, f"asset:{source_id}:{relative_path}"))


def gallery_reconciliation_id(source_id: str, batch_id: str) -> str:
    return str(
        uuid.uuid5(GALLERY_NAMESPACE, f"review-reconciliation:{source_id}:{batch_id}")
    )

def _encode_cursor(kind: str, payload: Mapping[str, Any]) -> str:
    raw = json.dumps({"kind": kind, **payload}, ensure_ascii=True, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_cursor(kind: str, cursor: str) -> dict[str, Any]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise GalleryCursorError("invalid_gallery_cursor") from exc
    if not isinstance(decoded, dict) or decoded.get("kind") != kind:
        raise GalleryCursorError("invalid_gallery_cursor")
    if set(decoded) != {"kind", "sort_key", "name", "id"}:
        raise GalleryCursorError("invalid_gallery_cursor")
    if not all(isinstance(decoded[field], str) for field in ("sort_key", "name", "id")):
        raise GalleryCursorError("invalid_gallery_cursor")
    return decoded


def _bounded_limit(limit: int | None) -> int:
    if limit is None:
        return GALLERY_PAGE_DEFAULT_LIMIT
    if not 1 <= limit <= GALLERY_PAGE_MAX_LIMIT:
        raise ValueError("invalid_gallery_page_limit")
    return limit


class GalleryRepository:
    """图库来源、目录树、资产索引与搜索的 SQLite 权威读写。"""

    def __init__(
        self,
        *,
        read: ReadFactory,
        transaction: TransactionFactory,
        clock: Clock,
    ) -> None:
        self._read = read
        self._transaction = transaction
        self._clock = clock

    # ---- 来源注册（§3.1） ----

    def register_source(
        self,
        *,
        kind: str,
        root_path: str,
        display_name: str,
        batch_id: str | None = None,
        dedup_required: bool = False,
    ) -> dict[str, Any]:
        if kind not in {"crawl_batch", "imported"}:
            raise ValueError("invalid_gallery_source_kind")
        if kind == "crawl_batch" and not batch_id:
            raise ValueError("gallery_batch_source_requires_batch_id")
        if kind == "imported" and batch_id is not None:
            raise ValueError("gallery_imported_source_forbids_batch_id")
        canonical = canonical_root_key(root_path)
        now = self._clock()
        source_id = str(uuid.uuid4())
        with self._transaction() as conn:
            self._assert_root_unique(conn, canonical)
            conn.execute(
                """
                INSERT INTO gallery_sources(
                    id, kind, batch_id, display_name, root_path,
                    canonical_root_key, availability, crawl_complete,
                    dedup_required, dedup_state, content_version,
                    annotation_version, indexed_version, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'available', 0, ?, ?, 1, 1, 0, ?, ?)
                """,
                (
                    source_id,
                    kind,
                    batch_id,
                    display_name,
                    str(root_path),
                    canonical,
                    1 if dedup_required else 0,
                    "pending_analysis" if dedup_required else "not_required",
                    now,
                    now,
                ),
            )
        return self._project_source_row(
            self._source_row_by_id(None, source_id)
        )

    def _assert_root_unique(self, conn: Any, canonical: str) -> None:
        for row in conn.execute(
            "SELECT * FROM gallery_sources WHERE canonical_root_key != ?",
            (canonical,),
        ).fetchall():
            relation = root_relation(canonical, row["canonical_root_key"])
            if relation != "disjoint":
                raise GallerySourceConflictError(relation, self._project_source_row(row))
        duplicate = conn.execute(
            "SELECT * FROM gallery_sources WHERE canonical_root_key = ?", (canonical,)
        ).fetchone()
        if duplicate is not None:
            raise GallerySourceConflictError("same", self._project_source_row(duplicate))

    def _source_row_by_id(self, conn: Any, source_id: str) -> Any:
        if conn is None:
            with self._read() as reader:
                return reader.execute(
                    "SELECT * FROM gallery_sources WHERE id=?", (source_id,)
                ).fetchone()
        return conn.execute(
            "SELECT * FROM gallery_sources WHERE id=?", (source_id,)
        ).fetchone()

    def get_source_by_batch_id(self, batch_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM gallery_sources WHERE batch_id=? ORDER BY created_at LIMIT 1",
                (batch_id,),
            ).fetchone()
        return None if row is None else self._project_source_row(row)

    def get_asset_ids_by_relative_paths(
        self, source_id: str, relative_paths: Sequence[str]
    ) -> list[str]:
        """按相对路径解析来源内的资产 ID（审核排除提交用）。"""
        if not relative_paths:
            return []
        with self._read() as conn:
            placeholders = ",".join("?" for _ in relative_paths)
            rows = conn.execute(
                f"""
                SELECT id FROM gallery_assets
                WHERE source_id=? AND relative_path IN ({placeholders})
                """,
                (source_id, *relative_paths),
            ).fetchall()
        return [str(row["id"]) for row in rows]

    def get_source(self, source_id: str) -> dict[str, Any] | None:
        row = self._source_row_by_id(None, source_id)
        return None if row is None else self._project_source_row(row)

    def list_sources(self) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                "SELECT * FROM gallery_sources ORDER BY kind, display_name, id"
            ).fetchall()
        return [self._project_source_row(row) for row in rows]

    def unregister_source(self, source_id: str) -> bool:
        with self._transaction() as conn:
            row = self._source_row_by_id(conn, source_id)
            if row is None:
                return False
            conn.execute(
                "DELETE FROM gallery_search_index WHERE source_id=?", (source_id,)
            )
            conn.execute("DELETE FROM gallery_sources WHERE id=?", (source_id,))
        return True

    def apply_review_result(
        self,
        source_id: str,
        *,
        excluded_asset_ids: Sequence[str],
    ) -> bool:
        """审核应用后的图库侧原子提交（§3.8）。

        - 被排除资产置 dedup_visibility='excluded'（列表/搜索/计数立即剔除）；
        - 来源 dedup_state='applied'，dedup_applied_version=当前 content_version；
        - indexed_version 递增驱动前端刷新。
        """
        now = self._clock()
        with self._transaction() as conn:
            row = self._source_row_by_id(conn, source_id)
            if row is None:
                return False
            current_version = int(row["content_version"])
            conn.execute(
                """
                UPDATE gallery_sources
                SET dedup_state='applied', dedup_applied_version=?,
                    indexed_version=indexed_version+1, updated_at=?
                WHERE id=?
                """,
                (current_version, now, source_id),
            )
            conn.execute(
                """
                UPDATE gallery_assets
                SET dedup_visibility='kept', updated_at=?
                WHERE source_id=? AND lifecycle_state='active'
                  AND dedup_visibility!='excluded'
                """,
                (now, source_id),
            )
            for asset_id in excluded_asset_ids:
                conn.execute(
                    """
                    UPDATE gallery_assets
                    SET dedup_visibility='excluded', updated_at=?
                    WHERE id=? AND source_id=?
                    """,
                    (now, asset_id, source_id),
                )
                conn.execute(
                    "DELETE FROM gallery_search_index WHERE asset_id=?",
                    (asset_id,),
                )
            # 立即修正目录计数与封面（被排除项不再进入目录计数/封面）。
            if excluded_asset_ids:
                placeholders = ",".join("?" for _ in excluded_asset_ids)
                affected = conn.execute(
                    f"""
                    SELECT DISTINCT directory_id FROM gallery_assets
                    WHERE source_id=? AND id IN ({placeholders})
                    """,
                    (source_id, *excluded_asset_ids),
                ).fetchall()
                for directory_row in affected:
                    directory_id = str(directory_row["directory_id"])
                    self._recount_directory(conn, source_id, directory_id, now)
        return True

    def queue_review_reconciliation(
        self,
        *,
        source_id: str,
        batch_id: str,
        retained_relative_paths: Sequence[str],
        excluded_relative_paths: Sequence[str],
        rejected_relative_paths: Sequence[str],
    ) -> dict[str, Any]:
        """Persist the review/Gallery handoff before visibility changes are attempted."""
        groups = (
            ("kept", retained_relative_paths),
            ("excluded_original", excluded_relative_paths),
            ("excluded", rejected_relative_paths),
        )
        normalized: list[tuple[str, str]] = []
        for disposition, paths in groups:
            for relative_path in sorted(set(paths)):
                path = str(relative_path)
                if not is_safe_relative_path(path):
                    raise ValueError("invalid_reconciliation_relative_path")
                normalized.append((path, disposition))
        event_id = gallery_reconciliation_id(source_id, batch_id)
        now = self._clock()
        with self._transaction() as conn:
            source = self._source_row_by_id(conn, source_id)
            if source is None:
                raise ValueError("gallery_source_not_found")
            if str(source["batch_id"] or "") != batch_id:
                raise ValueError("gallery_reconciliation_batch_mismatch")
            conn.execute(
                """
                INSERT INTO gallery_reconciliation_events(
                    id, source_id, batch_id, status, attempt_count, error_code,
                    created_at, updated_at, applied_at
                ) VALUES (?, ?, ?, 'pending', 0, '', ?, ?, NULL)
                ON CONFLICT(source_id, batch_id) DO UPDATE SET
                    status='pending', error_code='', updated_at=excluded.updated_at,
                    applied_at=NULL
                """,
                (event_id, source_id, batch_id, now, now),
            )
            conn.execute(
                "DELETE FROM gallery_reconciliation_items WHERE event_id=?",
                (event_id,),
            )
            for relative_path, disposition in normalized:
                conn.execute(
                    """
                    INSERT INTO gallery_reconciliation_items(
                        event_id, relative_path, disposition
                    ) VALUES (?, ?, ?)
                    ON CONFLICT(event_id, relative_path) DO UPDATE SET
                        disposition=excluded.disposition
                    """,
                    (event_id, relative_path, disposition),
                )
        event = self.get_review_reconciliation(source_id)
        if event is None:
            raise RuntimeError("gallery_reconciliation_queue_failed")
        return event

    def apply_review_reconciliation(self, event_id: str) -> dict[str, Any]:
        """Atomically apply one durable reconciliation and mark it completed."""
        now = self._clock()
        with self._transaction() as conn:
            event = conn.execute(
                "SELECT * FROM gallery_reconciliation_events WHERE id=?",
                (event_id,),
            ).fetchone()
            if event is None:
                raise ValueError("gallery_reconciliation_not_found")
            source_id = str(event["source_id"])
            source = self._source_row_by_id(conn, source_id)
            if source is None:
                raise ValueError("gallery_source_not_found")
            if event["status"] == "applied":
                return self._project_reconciliation_row(event)
            conn.execute(
                """
                UPDATE gallery_assets SET dedup_visibility='kept', updated_at=?
                WHERE source_id=? AND lifecycle_state='active'
                """,
                (now, source_id),
            )
            conn.execute(
                """
                UPDATE gallery_assets SET dedup_visibility='excluded', updated_at=?
                WHERE source_id=? AND relative_path IN (
                    SELECT relative_path FROM gallery_reconciliation_items
                    WHERE event_id=? AND disposition IN ('excluded_original', 'excluded')
                )
                """,
                (now, source_id, event_id),
            )
            # Final rejected destinations from every persisted event remain excluded
            # after later scans or retries; original paths are not permanently reserved.
            conn.execute(
                """
                UPDATE gallery_assets SET dedup_visibility='excluded', updated_at=?
                WHERE source_id=? AND relative_path IN (
                    SELECT item.relative_path
                    FROM gallery_reconciliation_items AS item
                    JOIN gallery_reconciliation_events AS queued
                      ON queued.id=item.event_id
                    WHERE queued.source_id=? AND item.disposition='excluded'
                )
                """,
                (now, source_id, source_id),
            )
            conn.execute(
                """
                DELETE FROM gallery_search_index WHERE asset_id IN (
                    SELECT id FROM gallery_assets
                    WHERE source_id=? AND dedup_visibility='excluded'
                )
                """,
                (source_id,),
            )
            current_version = int(source["content_version"])
            conn.execute(
                """
                UPDATE gallery_sources
                SET dedup_state='applied', dedup_applied_version=?,
                    indexed_version=indexed_version+1, updated_at=?
                WHERE id=?
                """,
                (current_version, now, source_id),
            )
            directory_rows = conn.execute(
                "SELECT id FROM gallery_directories WHERE source_id=?",
                (source_id,),
            ).fetchall()
            for directory in directory_rows:
                self._recount_directory(conn, source_id, str(directory["id"]), now)
            conn.execute(
                """
                UPDATE gallery_reconciliation_events
                SET status='applied', attempt_count=attempt_count+1,
                    error_code='', updated_at=?, applied_at=?
                WHERE id=?
                """,
                (now, now, event_id),
            )
            applied = conn.execute(
                "SELECT * FROM gallery_reconciliation_events WHERE id=?",
                (event_id,),
            ).fetchone()
        return self._project_reconciliation_row(applied)

    def mark_review_reconciliation_failed(
        self, event_id: str, error_code: str
    ) -> dict[str, Any]:
        now = self._clock()
        with self._transaction() as conn:
            updated = conn.execute(
                """
                UPDATE gallery_reconciliation_events
                SET status='failed', attempt_count=attempt_count+1,
                    error_code=?, updated_at=?, applied_at=NULL
                WHERE id=? AND status!='applied'
                """,
                (error_code, now, event_id),
            ).rowcount
            if not updated:
                row = conn.execute(
                    "SELECT * FROM gallery_reconciliation_events WHERE id=?",
                    (event_id,),
                ).fetchone()
                if row is None:
                    raise ValueError("gallery_reconciliation_not_found")
            row = conn.execute(
                "SELECT * FROM gallery_reconciliation_events WHERE id=?",
                (event_id,),
            ).fetchone()
            if updated:
                source_id = str(row["source_id"])
                conn.execute(
                    """
                    UPDATE gallery_assets SET dedup_visibility='excluded', updated_at=?
                    WHERE source_id=? AND lifecycle_state='active'
                      AND relative_path IN (
                        SELECT relative_path FROM gallery_reconciliation_items
                        WHERE event_id=?
                          AND disposition IN ('excluded_original', 'excluded')
                      )
                    """,
                    (now, source_id, event_id),
                )
                conn.execute(
                    """
                    DELETE FROM gallery_search_index WHERE asset_id IN (
                        SELECT id FROM gallery_assets
                        WHERE source_id=? AND dedup_visibility='excluded'
                    )
                    """,
                    (source_id,),
                )
                directories = conn.execute(
                    "SELECT id FROM gallery_directories WHERE source_id=?",
                    (source_id,),
                ).fetchall()
                for directory in directories:
                    self._recount_directory(
                        conn, source_id, str(directory["id"]), now
                    )
                conn.execute(
                    """
                    UPDATE gallery_sources
                    SET indexed_version=indexed_version+1, updated_at=?
                    WHERE id=?
                    """,
                    (now, source_id),
                )
        return self._project_reconciliation_row(row)

    def get_review_reconciliation(self, source_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                """
                SELECT * FROM gallery_reconciliation_events
                WHERE source_id=? ORDER BY updated_at DESC, id DESC LIMIT 1
                """,
                (source_id,),
            ).fetchone()
        return None if row is None else self._project_reconciliation_row(row)

    def list_retryable_review_reconciliations(self) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT * FROM gallery_reconciliation_events
                WHERE status IN ('pending', 'failed')
                ORDER BY updated_at, id
                """
            ).fetchall()
        return [self._project_reconciliation_row(row) for row in rows]


    @staticmethod
    def _project_reconciliation_row(row: Any) -> dict[str, Any]:
        return {
            "event_id": str(row["id"]),
            "source_id": str(row["source_id"]),
            "batch_id": str(row["batch_id"]),
            "state": str(row["status"]),
            "attempt_count": int(row["attempt_count"]),
            "error_code": str(row["error_code"]),
            "created_at": float(row["created_at"]),
            "updated_at": float(row["updated_at"]),
            "applied_at": (
                None if row["applied_at"] is None else float(row["applied_at"])
            ),
        }

    def _recount_directory(
        self, conn: Any, source_id: str, directory_id: str, now: Any
    ) -> None:
        row = conn.execute(
            """
            SELECT relative_path FROM gallery_directories
            WHERE source_id=? AND id=?
            """,
            (source_id, directory_id),
        ).fetchone()
        if row is None:
            return
        relative_path = str(row["relative_path"])
        prefix = f"{relative_path}/" if relative_path else ""
        conn.execute(
            """
            UPDATE gallery_directories SET
                direct_directory_count=(
                    SELECT COUNT(*) FROM gallery_directories AS child
                    WHERE child.parent_id=? AND child.lifecycle_state='active'
                ),
                direct_asset_count=(
                    SELECT COUNT(*) FROM gallery_assets
                    WHERE directory_id=? AND lifecycle_state='active'
                      AND dedup_visibility!='excluded'
                ),
                recursive_asset_count=(
                    SELECT COUNT(*) FROM gallery_assets
                    WHERE source_id=? AND lifecycle_state='active'
                      AND dedup_visibility!='excluded'
                      AND (relative_path=? OR relative_path LIKE ?)
                ),
                cover_asset_ids_json=(
                    SELECT COALESCE(json_group_array(id), '[]') FROM (
                        SELECT id FROM gallery_assets
                        WHERE source_id=? AND lifecycle_state='active'
                          AND dedup_visibility!='excluded'
                          AND (relative_path=? OR relative_path LIKE ?)
                        ORDER BY sort_key LIMIT 4
                    )
                ),
                updated_at=?
            WHERE source_id=? AND id=?
            """,
            (
                directory_id,
                directory_id,
                source_id,
                relative_path,
                f"{prefix}%",
                source_id,
                relative_path,
                f"{prefix}%",
                now,
                source_id,
                directory_id,
            ),
        )


    def relink_source(self, source_id: str, new_root_path: str) -> dict[str, Any]:
        canonical = canonical_root_key(new_root_path)
        now = self._clock()
        with self._transaction() as conn:
            row = self._source_row_by_id(conn, source_id)
            if row is None:
                raise ValueError("gallery_source_not_found")
            if canonical == row["canonical_root_key"]:
                availability = "available" if _path_exists(new_root_path) else "offline"
                conn.execute(
                    """
                    UPDATE gallery_sources
                    SET availability=?, updated_at=? WHERE id=?
                    """,
                    (availability, now, source_id),
                )
            else:
                for other in conn.execute(
                    """
                    SELECT * FROM gallery_sources
                    WHERE id != ? AND canonical_root_key != ?
                    """,
                    (source_id, canonical),
                ).fetchall():
                    relation = root_relation(canonical, other["canonical_root_key"])
                    if relation != "disjoint":
                        raise GallerySourceConflictError(
                            relation, self._project_source_row(other)
                        )
                availability = "available" if _path_exists(new_root_path) else "offline"
                conn.execute(
                    """
                    UPDATE gallery_sources
                    SET root_path=?, canonical_root_key=?, availability=?,
                        updated_at=?
                    WHERE id=?
                    """,
                    (str(new_root_path), canonical, availability, now, source_id),
                )
        return self._project_source_row(self._source_row_by_id(None, source_id))

    @staticmethod
    def _project_source_row(row: Any) -> dict[str, Any]:
        return {
            "source_id": row["id"],
            "kind": row["kind"],
            "batch_id": row["batch_id"],
            "display_name": row["display_name"],
            "root_path": row["root_path"],
            "canonical_root_key": row["canonical_root_key"],
            "availability": row["availability"],
            "crawl_complete": bool(row["crawl_complete"]),
            "dedup_required": bool(row["dedup_required"]),
            "dedup_state": row["dedup_state"],
            "dedup_applied_version": row["dedup_applied_version"],
            "content_version": row["content_version"],
            "annotation_version": row["annotation_version"],
            "indexed_version": row["indexed_version"],
            "last_scanned_at": row["last_scanned_at"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    # ---- 扫描提交（§6.1） ----

    def commit_scan(
        self,
        source_id: str,
        *,
        directories: Sequence[Mapping[str, Any]],
        assets: Sequence[Mapping[str, Any]],
        expected_indexed_version: int | None = None,
        availability: str = "available",
        scan_error: str = "",
    ) -> dict[str, Any]:
        """以新的 indexed_version 单事务提交整棵目录树快照。

        directories: [{relative_path, name, parent_relative_path}]
        assets: [{relative_path, name, extension, size_bytes, modified_ns,
                  format, width, height, read_state, error_code,
                  txt_relative_path, txt_size_bytes, txt_modified_ns,
                  txt_state, txt_content}]
        """
        now = self._clock()
        with self._transaction() as conn:
            source_row = self._source_row_by_id(conn, source_id)
            if source_row is None:
                raise ValueError("gallery_source_not_found")
            if (
                expected_indexed_version is not None
                and int(source_row["indexed_version"]) != expected_indexed_version
            ):
                raise GalleryScanSnapshotConflict(source_id)
            existing_assets = {
                row["relative_path"]: row
                for row in conn.execute(
                    """
                    SELECT relative_path, size_bytes, modified_ns,
                           txt_size_bytes, txt_modified_ns, txt_state,
                           lifecycle_state, dedup_visibility
                    FROM gallery_assets WHERE source_id=?
                    """,
                    (source_id,),
                ).fetchall()
            }
            new_assets = {str(asset["relative_path"]): asset for asset in assets}
            reconciliation_rows = conn.execute(
                """
                SELECT item.relative_path, item.disposition
                FROM gallery_reconciliation_items AS item
                JOIN gallery_reconciliation_events AS event ON event.id=item.event_id
                WHERE event.source_id=?
                  AND event.status IN ('pending', 'failed', 'applied')
                  AND item.disposition IN ('excluded_original', 'excluded')
                """,
                (source_id,),
            ).fetchall()
            expected_removed_paths = {
                str(row["relative_path"])
                for row in reconciliation_rows
                if row["disposition"] == "excluded_original"
            }
            expected_rejected_destinations = {
                str(row["relative_path"])
                for row in reconciliation_rows
                if row["disposition"] == "excluded"
            }

            content_changed = False
            annotation_changed = False
            for relative_path, asset in new_assets.items():
                previous = existing_assets.get(relative_path)
                if previous is None:
                    if relative_path not in expected_rejected_destinations:
                        content_changed = True
                    continue
                if (
                    previous["lifecycle_state"] == "missing"
                    or int(previous["size_bytes"]) != int(asset["size_bytes"])
                    or int(previous["modified_ns"]) != int(asset["modified_ns"])
                ):
                    content_changed = True
                if (
                    int(previous["txt_size_bytes"]) != int(asset["txt_size_bytes"])
                    or int(previous["txt_modified_ns"]) != int(asset["txt_modified_ns"])
                ):
                    annotation_changed = True
            for relative_path, previous in existing_assets.items():
                if (
                    relative_path not in new_assets
                    and previous["lifecycle_state"] == "active"
                    and not (
                        relative_path in expected_removed_paths
                        and previous["dedup_visibility"] == "excluded"
                    )
                ):
                    content_changed = True

            counts = self._directory_counts(source_id, directories, new_assets)

            next_indexed = int(source_row["indexed_version"]) + 1
            next_content = int(source_row["content_version"]) + (1 if content_changed else 0)
            next_annotation = int(source_row["annotation_version"]) + (
                1 if annotation_changed else 0
            )
            conn.execute(
                """
                UPDATE gallery_sources
                SET indexed_version=?, content_version=?, annotation_version=?,
                    availability=?, last_scanned_at=?, updated_at=?
                WHERE id=?
                """,
                (
                    next_indexed,
                    next_content,
                    next_annotation,
                    availability,
                    now,
                    now,
                    source_id,
                ),
            )

            seen_directory_ids: set[str] = set()
            for directory in directories:
                relative_path = str(directory["relative_path"])
                directory_id = gallery_directory_id(source_id, relative_path)
                parent_relative = directory.get("parent_relative_path")
                parent_id = (
                    gallery_directory_id(source_id, str(parent_relative))
                    if parent_relative is not None
                    else None
                )
                name = str(directory.get("name") or "")
                direct = counts["direct"][relative_path]
                conn.execute(
                    """
                    INSERT INTO gallery_directories(
                        id, source_id, parent_id, relative_path, name, sort_key,
                        direct_directory_count, direct_asset_count,
                        recursive_asset_count, cover_asset_ids_json,
                        indexed_version, lifecycle_state, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        parent_id=excluded.parent_id,
                        name=excluded.name,
                        sort_key=excluded.sort_key,
                        direct_directory_count=excluded.direct_directory_count,
                        direct_asset_count=excluded.direct_asset_count,
                        recursive_asset_count=excluded.recursive_asset_count,
                        cover_asset_ids_json=excluded.cover_asset_ids_json,
                        indexed_version=excluded.indexed_version,
                        lifecycle_state='active',
                        updated_at=excluded.updated_at
                    """,
                    (
                        directory_id,
                        source_id,
                        parent_id,
                        relative_path,
                        name,
                        natural_sort_key(name),
                        direct["directories"],
                        direct["assets"],
                        counts["recursive"][relative_path],
                        json.dumps(counts["covers"][relative_path]),
                        next_indexed,
                        now,
                        now,
                    ),
                )
                seen_directory_ids.add(directory_id)

            conn.execute(
                "DELETE FROM gallery_search_index WHERE source_id=?", (source_id,)
            )
            seen_asset_ids: set[str] = set()
            for relative_path, asset in new_assets.items():
                if not is_safe_relative_path(relative_path):
                    raise ValueError(f"invalid_asset_relative_path:{relative_path!r}")
                asset_id = gallery_asset_id(source_id, relative_path)
                directory_relative = _parent_relative_path(relative_path)
                directory_id = gallery_directory_id(source_id, directory_relative)
                name = str(asset["name"])
                txt_state = str(asset["txt_state"])
                if txt_state not in {
                    "normal",
                    "missing",
                    "blank",
                    "invalid_encoding",
                    "pair_conflict",
                    "io_error",
                }:
                    raise ValueError(f"invalid_txt_state:{txt_state!r}")
                conn.execute(
                    """
                    INSERT INTO gallery_assets(
                        id, source_id, directory_id, relative_path, name,
                        extension, sort_key, size_bytes, modified_ns,
                        content_version, format, width, height, read_state,
                        error_code, txt_relative_path, txt_size_bytes,
                        txt_modified_ns, txt_state, dedup_visibility,
                        lifecycle_state, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                              'candidate', 'active', ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        directory_id=excluded.directory_id,
                        name=excluded.name,
                        extension=excluded.extension,
                        sort_key=excluded.sort_key,
                        -- SET 右侧读的是更新前的行：文件大小、修改时间变了，
                        -- 或者这条记录刚从 missing 回来，旧哈希就不再可信。
                        content_sha256=CASE
                            WHEN gallery_assets.size_bytes!=excluded.size_bytes
                              OR gallery_assets.modified_ns!=excluded.modified_ns
                              OR gallery_assets.lifecycle_state!='active'
                            THEN '' ELSE gallery_assets.content_sha256 END,
                        size_bytes=excluded.size_bytes,
                        modified_ns=excluded.modified_ns,
                        format=excluded.format,
                        width=excluded.width,
                        height=excluded.height,
                        read_state=excluded.read_state,
                        error_code=excluded.error_code,
                        txt_relative_path=excluded.txt_relative_path,
                        txt_size_bytes=excluded.txt_size_bytes,
                        txt_modified_ns=excluded.txt_modified_ns,
                        txt_state=excluded.txt_state,
                        lifecycle_state=excluded.lifecycle_state,
                        updated_at=excluded.updated_at
                    """,
                    (
                        asset_id,
                        source_id,
                        directory_id,
                        relative_path,
                        name,
                        str(asset["extension"]),
                        natural_sort_key(name),
                        int(asset["size_bytes"]),
                        int(asset["modified_ns"]),
                        str(asset["format"]),
                        int(asset["width"]),
                        int(asset["height"]),
                        str(asset["read_state"]),
                        str(asset["error_code"]),
                        str(asset["txt_relative_path"]),
                        int(asset["txt_size_bytes"]),
                        int(asset["txt_modified_ns"]),
                        txt_state,
                        now,
                        now,
                    ),
                )
                seen_asset_ids.add(asset_id)
                if txt_state == "normal":
                    conn.execute(
                        """
                        INSERT INTO gallery_search_index(
                            asset_id, source_id, file_name, relative_path, txt_content
                        ) VALUES (?, ?, ?, ?, ?)
                        """,
                        (
                            asset_id,
                            source_id,
                            name,
                            relative_path,
                            str(asset.get("txt_content") or ""),
                        ),
                    )

            if seen_asset_ids:
                placeholders = ",".join("?" for _ in seen_asset_ids)
                conn.execute(
                    f"""
                    UPDATE gallery_assets SET lifecycle_state='missing', updated_at=?
                    WHERE source_id=? AND id NOT IN ({placeholders})
                      AND lifecycle_state='active'
                    """,
                    (now, source_id, *seen_asset_ids),
                )
            else:
                conn.execute(
                    """
                    UPDATE gallery_assets SET lifecycle_state='missing', updated_at=?
                    WHERE source_id=? AND lifecycle_state='active'
                    """,
                    (now, source_id),
                )


            # Rejected originals are not path tombstones. If a new file later
            # appears at the old path, it is a fresh candidate and makes the
            # previously applied dedup result stale through content_changed.
            conn.execute(
                """
                UPDATE gallery_assets SET dedup_visibility='candidate', updated_at=?
                WHERE source_id=? AND lifecycle_state='active'
                  AND relative_path IN (
                    SELECT item.relative_path
                    FROM gallery_reconciliation_items AS item
                    JOIN gallery_reconciliation_events AS event
                      ON event.id=item.event_id
                    WHERE event.source_id=? AND item.disposition='excluded_original'
                  )
                  AND relative_path NOT IN (
                    SELECT item.relative_path
                    FROM gallery_reconciliation_items AS item
                    JOIN gallery_reconciliation_events AS event
                      ON event.id=item.event_id
                    WHERE event.source_id=? AND item.disposition='excluded'
                  )
                """,
                (now, source_id, source_id, source_id),
            )
            # A review rejection is tied to its final on-disk destination. New rows
            # discovered there inherit exclusion before this scan becomes visible.
            conn.execute(
                """
                UPDATE gallery_assets SET dedup_visibility='excluded', updated_at=?
                WHERE source_id=? AND lifecycle_state='active'
                  AND relative_path IN (
                    SELECT item.relative_path
                    FROM gallery_reconciliation_items AS item
                    JOIN gallery_reconciliation_events AS event
                      ON event.id=item.event_id
                    WHERE event.source_id=? AND item.disposition='excluded'
                  )
                """,
                (now, source_id, source_id),
            )
            conn.execute(
                """
                DELETE FROM gallery_search_index WHERE asset_id IN (
                    SELECT id FROM gallery_assets
                    WHERE source_id=? AND dedup_visibility='excluded'
                )
                """,
                (source_id,),
            )
            if seen_directory_ids:
                directory_placeholders = ",".join("?" for _ in seen_directory_ids)
                conn.execute(
                    f"""
                    DELETE FROM gallery_directories
                    WHERE source_id=? AND id NOT IN ({directory_placeholders})
                      AND lifecycle_state!='trashed'
                    """,
                    (source_id, *seen_directory_ids),
                )
            else:
                conn.execute(
                    "DELETE FROM gallery_directories "
                    "WHERE source_id=? AND lifecycle_state!='trashed'", (source_id,)
                )

            for directory_id in seen_directory_ids:
                self._recount_directory(conn, source_id, directory_id, now)

            visibility_counts = conn.execute(
                """
                SELECT
                    SUM(CASE WHEN lifecycle_state='active'
                              AND dedup_visibility='candidate' THEN 1 ELSE 0 END) AS candidate_count,
                    SUM(CASE WHEN lifecycle_state='active'
                              AND dedup_visibility='kept' THEN 1 ELSE 0 END) AS kept_count,
                    SUM(CASE WHEN lifecycle_state='active'
                              AND dedup_visibility='excluded' THEN 1 ELSE 0 END) AS removed_count
                FROM gallery_assets WHERE source_id=?
                """,
                (source_id,),
            ).fetchone()
            candidate_count = int(visibility_counts["candidate_count"] or 0)
            kept_count = int(visibility_counts["kept_count"] or 0)
            removed_count = int(visibility_counts["removed_count"] or 0)

            if scan_error:
                conn.execute(
                    """
                    UPDATE gallery_sources SET availability='error', updated_at=?
                    WHERE id=?
                    """,
                    (now, source_id),
                )

            return {
                "source_id": source_id,
                "indexed_version": next_indexed,
                "content_version": next_content,
                "annotation_version": next_annotation,
                "content_changed": content_changed,
                "annotation_changed": annotation_changed,
                "asset_count": candidate_count + kept_count,
                "candidate_count": candidate_count,
                "kept_count": kept_count,
                "removed_count": removed_count,
                "directory_count": len(directories),
            }

    @staticmethod
    def _directory_counts(
        source_id: str,
        directories: Sequence[Mapping[str, Any]],
        assets: Mapping[str, Mapping[str, Any]],
    ) -> dict[str, Any]:
        children: dict[str | None, list[str]] = {}
        by_relative = {str(directory["relative_path"]): directory for directory in directories}
        for relative_path, directory in by_relative.items():
            parent = directory.get("parent_relative_path")
            children.setdefault(str(parent) if parent is not None else None, []).append(
                relative_path
            )
        asset_by_directory: dict[str, list[tuple[str, str]]] = {}
        for relative_path in assets:
            parent = _parent_relative_path(str(relative_path))
            asset_by_directory.setdefault(parent, []).append(
                (natural_sort_key(assets[relative_path]["name"]), relative_path)
            )

        recursive: dict[str, int] = {}

        def _recursive_count(relative_path: str) -> int:
            if relative_path in recursive:
                return recursive[relative_path]
            total = len(asset_by_directory.get(relative_path, []))
            for child in children.get(relative_path, []):
                total += _recursive_count(child)
            recursive[relative_path] = total
            return total

        covers: dict[str, list[str]] = {}
        direct: dict[str, dict[str, int]] = {}
        for relative_path in by_relative:
            _recursive_count(relative_path)
            sorted_assets = sorted(asset_by_directory.get(relative_path, []))
            covers[relative_path] = [
                gallery_asset_id(source_id, path)
                for _, path in sorted_assets[:4]
            ]
            direct[relative_path] = {
                "directories": len(children.get(relative_path, [])),
                "assets": len(sorted_assets),
            }
        return {
            "recursive": recursive,
            "covers": covers,
            "direct": direct,
        }

    # ---- 读取与游标分页（§6.4） ----

    def get_directory(self, directory_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM gallery_directories "
                "WHERE id=? AND lifecycle_state='active'",
                (directory_id,),
            ).fetchone()
        return None if row is None else self._project_directory_row(row)

    def get_root_directory(self, source_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM gallery_directories "
                "WHERE source_id=? AND relative_path='' AND lifecycle_state='active'",
                (source_id,),
            ).fetchone()
        return None if row is None else self._project_directory_row(row)
    @staticmethod
    def _project_directory_row(row: Any) -> dict[str, Any]:
        return {
            "directory_id": row["id"],
            "source_id": row["source_id"],
            "parent_id": row["parent_id"],
            "relative_path": row["relative_path"],
            "name": row["name"],
            "direct_directory_count": row["direct_directory_count"],
            "direct_asset_count": row["direct_asset_count"],
            "recursive_asset_count": row["recursive_asset_count"],
            "cover_asset_ids": json.loads(row["cover_asset_ids_json"]),
            "indexed_version": row["indexed_version"],
        }

    def list_directory_entries(
        self,
        *,
        directory_id: str,
        include_descendants: bool = False,
        txt_state: str | None = None,
        query: str | None = None,
        directory_cursor: str | None = None,
        asset_cursor: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        page_limit = _bounded_limit(limit)
        with self._read() as conn:
            directory_row = conn.execute(
                "SELECT * FROM gallery_directories "
                "WHERE id=? AND lifecycle_state='active'",
                (directory_id,),
            ).fetchone()
            if directory_row is None:
                raise ValueError("gallery_directory_not_found")
            source_id = directory_row["source_id"]

            directories, next_directory_cursor = self._page_directories(
                conn, directory_id, directory_cursor, page_limit
            )
            assets, next_asset_cursor = self._page_assets(
                conn,
                source_id=source_id,
                directory_id=directory_id,
                include_descendants=include_descendants,
                txt_state=txt_state,
                query=query,
                cursor=asset_cursor,
                limit=page_limit,
            )
            return {
                "directory": self._project_directory_row(directory_row),
                "directories": directories,
                "assets": assets,
                "directory_cursor": next_directory_cursor,
                "asset_cursor": next_asset_cursor,
                "include_descendants": include_descendants,
                "limit": page_limit,
            }

    def _page_directories(
        self,
        conn: Any,
        directory_id: str,
        cursor: str | None,
        limit: int,
    ) -> tuple[list[dict[str, Any]], str | None]:
        params: list[Any] = [directory_id]
        predicate = "parent_id=? AND lifecycle_state='active'"
        if cursor is not None:
            decoded = _decode_cursor("gallery-directory", cursor)
            predicate += " AND (sort_key, name, id) > (?, ?, ?)"
            params.extend([decoded["sort_key"], decoded["name"], decoded["id"]])
        rows = conn.execute(
            f"""
            SELECT * FROM gallery_directories WHERE {predicate}
            ORDER BY sort_key, name, id LIMIT ?
            """,
            (*params, limit + 1),
        ).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        next_cursor = None
        if has_more and rows:
            last = rows[-1]
            next_cursor = _encode_cursor(
                "gallery-directory",
                {"sort_key": last["sort_key"], "name": last["name"], "id": last["id"]},
            )
        return [self._project_directory_row(row) for row in rows], next_cursor

    def _page_assets(
        self,
        conn: Any,
        *,
        source_id: str | None,
        directory_id: str | None,
        include_descendants: bool,
        txt_state: str | None,
        query: str | None,
        cursor: str | None,
        limit: int,
    ) -> tuple[list[dict[str, Any]], str | None]:
        restrictions: list[str] = [
            "lifecycle_state='active'",
            "dedup_visibility!='excluded'",
        ]
        params: list[Any] = []
        if txt_state is not None:
            restrictions.append("txt_state=?")
            params.append(txt_state)
        if query:
            terms = [term for term in _fts_terms(query) if term]
            if not terms:
                return [], None
            match = " ".join(f'"{term}"*' for term in terms)
            if source_id is None:
                restrictions.append(
                    "id IN (SELECT asset_id FROM gallery_search_index "
                    "WHERE gallery_search_index MATCH ?)"
                )
                params.append(match)
            else:
                restrictions.append(
                    "id IN (SELECT asset_id FROM gallery_search_index "
                    "WHERE gallery_search_index MATCH ? AND source_id=?)"
                )
                params.extend([match, source_id])
        if directory_id is not None:
            if include_descendants:
                restrictions.append(
                    "directory_id IN ("
                    "WITH RECURSIVE subtree(id) AS ("
                    "SELECT id FROM gallery_directories WHERE id=? "
                    "UNION ALL "
                    "SELECT child.id FROM gallery_directories AS child "
                    "JOIN subtree ON child.parent_id=subtree.id"
                    ") SELECT id FROM subtree)"
                )
            else:
                restrictions.append("directory_id=?")
            params.append(directory_id)
        elif source_id is not None:
            restrictions.append("source_id=?")
            params.append(source_id)
        predicate = " AND ".join(restrictions)
        if cursor is not None:
            decoded = _decode_cursor("gallery-asset", cursor)
            predicate += " AND (sort_key, name, id) > (?, ?, ?)"
            params.extend([decoded["sort_key"], decoded["name"], decoded["id"]])
        rows = conn.execute(
            f"""
            SELECT * FROM gallery_assets WHERE {predicate}
            ORDER BY sort_key, name, id LIMIT ?
            """,
            (*params, limit + 1),
        ).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        next_cursor = None
        if has_more and rows:
            last = rows[-1]
            next_cursor = _encode_cursor(
                "gallery-asset",
                {"sort_key": last["sort_key"], "name": last["name"], "id": last["id"]},
            )
        return [self._project_asset_row(row) for row in rows], next_cursor

    def search_assets(
        self,
        *,
        scope: str,
        source_id: str | None = None,
        directory_id: str | None = None,
        include_descendants: bool = False,
        txt_state: str | None = None,
        query: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        if scope not in {"directory", "source", "gallery"}:
            raise ValueError("invalid_gallery_search_scope")
        page_limit = _bounded_limit(limit)
        if not query or not query.strip():
            raise ValueError("gallery_search_query_required")
        with self._read() as conn:
            resolved_source = source_id
            resolved_directory = directory_id
            if scope == "directory":
                if directory_id is None:
                    raise ValueError("gallery_search_directory_required")
            elif scope == "source":
                resolved_directory = None
                if source_id is None:
                    raise ValueError("gallery_search_source_required")
            else:
                resolved_source = None
                resolved_directory = None
            assets, next_cursor = self._page_assets(
                conn,
                source_id=resolved_source,
                directory_id=resolved_directory,
                include_descendants=include_descendants,
                txt_state=txt_state,
                query=query,
                cursor=cursor,
                limit=page_limit,
            )
            return {
                "scope": scope,
                "assets": assets,
                "asset_cursor": next_cursor,
                "limit": page_limit,
            }

    def get_asset(self, asset_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM gallery_assets WHERE id=?", (asset_id,)
            ).fetchone()
        return None if row is None else self._project_asset_row(row)


    def get_source_asset_stats(self, source_id: str) -> dict[str, dict[str, Any]]:
        """扫描增量复用所需的既有资产统计（相对路径 → 大小/mtime/解码结果）。"""
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT relative_path, size_bytes, modified_ns, format, width,
                       height, read_state, error_code
                FROM gallery_assets WHERE source_id=? AND lifecycle_state='active'
                """,
                (source_id,),
            ).fetchall()
        return {
            row["relative_path"]: {
                "size_bytes": row["size_bytes"],
                "modified_ns": row["modified_ns"],
                "format": row["format"],
                "width": row["width"],
                "height": row["height"],
                "read_state": row["read_state"],
                "error_code": row["error_code"],
            }
            for row in rows
        }

    def set_source_availability(self, source_id: str, availability: str) -> None:
        if availability not in {"available", "offline", "error"}:
            raise ValueError("invalid_gallery_source_availability")
        with self._transaction() as conn:
            updated = conn.execute(
                """
                UPDATE gallery_sources SET availability=?, updated_at=?
                WHERE id=?
                """,
                (availability, self._clock(), source_id),
            ).rowcount
        if not updated:
            raise ValueError("gallery_source_not_found")

    def rename_source(self, source_id: str, display_name: str) -> None:
        with self._transaction() as conn:
            updated = conn.execute(
                """
                UPDATE gallery_sources SET display_name=?, updated_at=?
                WHERE id=?
                """,
                (display_name, self._clock(), source_id),
            ).rowcount
        if not updated:
            raise ValueError("gallery_source_not_found")

    def get_source_asset_counts(self, source_id: str) -> dict[str, int]:
        with self._read() as conn:
            row = conn.execute(
                """
                SELECT
                    SUM(CASE WHEN lifecycle_state='active'
                              AND dedup_visibility='candidate' THEN 1 ELSE 0 END)
                        AS candidate_count,
                    SUM(CASE WHEN lifecycle_state='active'
                              AND dedup_visibility='kept' THEN 1 ELSE 0 END)
                        AS kept_count,
                    SUM(CASE WHEN lifecycle_state='active'
                              AND dedup_visibility='excluded' THEN 1 ELSE 0 END)
                        AS removed_count
                FROM gallery_assets WHERE source_id=?
                """,
                (source_id,),
            ).fetchone()
        candidate = int(row["candidate_count"] or 0)
        kept = int(row["kept_count"] or 0)
        removed = int(row["removed_count"] or 0)
        return {
            "asset_count": candidate + kept,
            "candidate_count": candidate,
            "kept_count": kept,
            "removed_count": removed,
        }

    def count_source_assets(self, source_id: str) -> int:
        return self.get_source_asset_counts(source_id)["asset_count"]

    # ---- TXT 注解写路径（§7.2 PUT annotation；G3-1） ----

    def update_annotation(
        self,
        asset_id: str,
        *,
        expected_txt_version: int,
        txt_state: str,
        txt_size_bytes: int,
        txt_modified_ns: int,
        txt_sha256: str,
        txt_relative_path: str,
        txt_content: str,
    ) -> dict[str, Any]:
        """提交已写入磁盘后的注解索引更新（乐观版本检查 + FTS 同步）。

        调用方（service）已保证磁盘 TXT 原子写完成；本方法只负责把索引
        与统计推进到新版本。返回更新后的资产投影。
        """
        now = self._clock()
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT * FROM gallery_assets WHERE id=?", (asset_id,)
            ).fetchone()
            if row is None:
                raise ValueError("gallery_asset_not_found")
            if int(row["txt_version"]) != expected_txt_version:
                raise GalleryVersionConflict(
                    "txt_version_conflict",
                    {"asset_id": asset_id, "expected": expected_txt_version,
                     "actual": int(row["txt_version"])},
                )
            if row["lifecycle_state"] != "active":
                raise GalleryVersionConflict(
                    "asset_not_active", {"asset_id": asset_id,
                     "lifecycle": row["lifecycle_state"]},
                )
            # FTS 行先删后插，保证 txt_content 与新版本一致。
            conn.execute(
                "DELETE FROM gallery_search_index WHERE asset_id=?", (asset_id,)
            )
            conn.execute(
                ""
                "INSERT INTO gallery_search_index(asset_id, source_id, file_name, relative_path, txt_content)"
                " VALUES (?, ?, ?, ?, ?)",
                (asset_id, row["source_id"], row["name"], row["relative_path"],
                 txt_content if txt_state == "normal" else ""),
            )
            new_version = expected_txt_version + 1
            conn.execute(
                ""
                "UPDATE gallery_assets SET"
                " txt_state=?, txt_size_bytes=?, txt_modified_ns=?,"
                " txt_sha256=?, txt_version=?, txt_relative_path=?, updated_at=?"
                " WHERE id=?",
                (
                    txt_state,
                    txt_size_bytes,
                    txt_modified_ns,
                    txt_sha256,
                    new_version,
                    txt_relative_path,
                    now,
                    asset_id,
                ),
            )
            conn.execute(
                ""
                "UPDATE gallery_sources"
                " SET annotation_version=annotation_version+1, updated_at=?"
                " WHERE id=?",
                (now, row["source_id"]),
            )
            updated = conn.execute(
                "SELECT * FROM gallery_assets WHERE id=?", (asset_id,)
            ).fetchone()
        return self._project_asset_row(updated)

    def set_content_sha256(
        self,
        asset_id: str,
        content_sha256: str,
        *,
        size_bytes: int,
        modified_ns: int,
    ) -> bool:
        """条件写入文件哈希：只有索引里的大小和修改时间仍是哈希时读到的值才写。

        扫描在两次读取之间更新了这行（文件已变化）时返回 False，不写入。
        """
        if len(content_sha256) != 64:
            raise ValueError("invalid_content_sha256")
        with self._transaction() as conn:
            cursor = conn.execute(
                """
                UPDATE gallery_assets SET content_sha256=?
                WHERE id=? AND size_bytes=? AND modified_ns=?
                  AND lifecycle_state='active' AND content_sha256=''
                """,
                (content_sha256, asset_id, int(size_bytes), int(modified_ns)),
            )
            return cursor.rowcount == 1

    def get_assets_by_ids(self, asset_ids: Iterable[str]) -> list[dict[str, Any]]:
        ids = list(dict.fromkeys(asset_ids))
        if not ids:
            return []
        placeholders = ",".join("?" for _ in ids)
        with self._read() as conn:
            rows = conn.execute(
                f"SELECT * FROM gallery_assets WHERE id IN ({placeholders})",
                ids,
            ).fetchall()
        by_id = {row["id"]: self._project_asset_row(row) for row in rows}
        return [by_id[asset_id] for asset_id in ids if asset_id in by_id]

    def caption_texts(self, asset_ids: Iterable[str]) -> dict[str, str]:
        """搜索索引里的 caption 文本：只有 txt_state=normal 的图有，写 caption 和扫描时同步。"""
        ids = list(dict.fromkeys(asset_ids))
        if not ids:
            return {}
        with self._read() as conn:
            rows = conn.execute(
                "SELECT asset_id, txt_content FROM gallery_search_index "
                "WHERE asset_id IN (SELECT value FROM json_each(?))",
                (json.dumps(ids),),
            ).fetchall()
        return {row["asset_id"]: row["txt_content"] for row in rows if row["txt_content"]}

    @staticmethod
    def _project_asset_row(row: Any) -> dict[str, Any]:
        return {
            "asset_id": row["id"],
            "source_id": row["source_id"],
            "directory_id": row["directory_id"],
            "relative_path": row["relative_path"],
            "name": row["name"],
            "extension": row["extension"],
            "size_bytes": row["size_bytes"],
            "modified_ns": row["modified_ns"],
            "content_sha256": row["content_sha256"],
            "content_version": row["content_version"],
            "format": row["format"],
            "width": row["width"],
            "height": row["height"],
            "read_state": row["read_state"],
            "error_code": row["error_code"],
            "txt_relative_path": row["txt_relative_path"],
            "txt_size_bytes": row["txt_size_bytes"],
            "txt_modified_ns": row["txt_modified_ns"],
            "txt_version": row["txt_version"],
            "txt_state": row["txt_state"],
            "dedup_visibility": row["dedup_visibility"],
            "lifecycle_state": row["lifecycle_state"],
            "updated_at": row["updated_at"],
        }


def _parent_relative_path(relative_path: str) -> str:
    parent, _, _ = relative_path.rpartition("/")
    return parent



def _fts_terms(query: str) -> list[str]:
    cleaned = "".join(
        character if character.isalnum() or ord(character) > 0x2E7F else " "
        for character in query
    )
    return [term for term in cleaned.split() if term][:8]


def _path_exists(path: str) -> bool:
    import os

    return os.path.exists(path)




__all__ = [
    "GalleryRepository",
    "GallerySourceConflictError",
    "GalleryVersionConflict",
    "GalleryCursorError",
    "gallery_directory_id",
    "gallery_asset_id",
    "GALLERY_PAGE_DEFAULT_LIMIT",
    "GALLERY_PAGE_MAX_LIMIT",
]
