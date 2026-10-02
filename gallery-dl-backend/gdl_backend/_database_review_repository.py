from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from typing import Any

from ._database_repository import (
    Clock,
    ReadFactory,
    TERMINAL_BATCH_STATUSES,
    TransactionFactory,
    project_crawl_review,
    project_crawl_review_group,
    project_crawl_review_image,
)
from .redaction import redact_text


ReviewReader = Callable[[str], dict[str, Any] | None]
GroupLimit = Callable[[], int]


class CrawlReviewGroupLimitExceeded(RuntimeError):
    pass


def read_crawl_review_manifest_state(
    connection: sqlite3.Connection,
    batch_id: str,
    *, reviews_table: str = "crawl_reviews", identity_column: str = "batch_id",
) -> dict[str, Any]:
    row = connection.execute(
        f"SELECT status FROM {reviews_table} WHERE {identity_column}=?",
        (batch_id,),
    ).fetchone()
    if row is None or row["status"] != "analyzing":
        raise RuntimeError("审核任务未处于分析状态")
    return dict(row)


def normalize_crawl_review_manifest(
    manifest: dict[str, Any],
    *,
    groups: list[Any] | None = None,
    automatic_groups: list[Any] | None = None,
) -> dict[str, Any]:
    manual_groups = list(manifest.get("groups") or []) if groups is None else groups
    automatic = (
        list(manifest.get("auto_groups") or [])
        if automatic_groups is None
        else automatic_groups
    )
    normalized_groups: list[dict[str, Any]] = []
    seen_group_ids: set[str] = set()
    seen_image_ids: set[str] = set()
    seen_paths: set[str] = set()
    image_count = 0
    duplicate_count = 0
    unreadable_count = 0
    automatic_rejected_count = 0

    def normalize_group(
        group_id: str,
        ordinal: int,
        kind: str,
        match_levels: list[Any],
        reason: str,
        *,
        decided: bool,
    ) -> dict[str, Any]:
        if not group_id or group_id in seen_group_ids:
            raise ValueError("审核清单包含空或重复的组 ID")
        seen_group_ids.add(group_id)
        return {
            "id": group_id,
            "ordinal": ordinal,
            "kind": kind,
            "match_levels": match_levels,
            "reason": reason,
            "decided": decided,
            "images": [],
        }

    def normalize_image(
        group_id: str,
        image: dict[str, Any],
        fallback_ordinal: int,
        *,
        selected: bool,
        metadata_extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        nonlocal image_count, unreadable_count
        image_id = str(image.get("id") or "").strip()
        relative_path = str(image.get("relative_path") or "").strip()
        if not image_id or image_id in seen_image_ids:
            raise ValueError("审核清单包含空或重复的图片 ID")
        if not relative_path or relative_path in seen_paths:
            raise ValueError("审核清单包含空或重复的图片路径")
        seen_image_ids.add(image_id)
        seen_paths.add(relative_path)
        metadata = dict(image.get("metadata") or {})
        if metadata_extra:
            metadata.update(metadata_extra)
        # Worker 的顶层相似度字段继续折叠进 metadata_json，供既有 API/UI 使用。
        if image.get("review_metrics") is not None:
            metadata["review_metrics"] = image["review_metrics"]
        readable = bool(image.get("readable", True))
        if not readable:
            unreadable_count += 1
        image_count += 1
        return {
            "id": image_id,
            "group_id": group_id,
            "ordinal": int(image.get("ordinal") or fallback_ordinal),
            "relative_path": relative_path,
            "file_hash": str(metadata.get("file_hash") or ""),
            "metadata_json": json.dumps(metadata, ensure_ascii=False, allow_nan=False),
            "readable": readable,
            "recommended": bool(image.get("recommended")),
            "selected": selected,
        }

    for fallback_ordinal, group in enumerate(manual_groups, 1):
        group_id = str(group.get("id") or "").strip()
        kind = str(group.get("kind") or "single")
        if kind == "duplicate":
            duplicate_count += 1
        items = list(group.get("items") or [])
        normalized_group = normalize_group(
            group_id,
            int(group.get("ordinal") or fallback_ordinal),
            kind,
            list(group.get("match_levels") or []),
            str(group.get("reason") or ""),
            decided=False,
        )
        for fallback_image_ordinal, image in enumerate(items, 1):
            normalized_group["images"].append(
                normalize_image(
                    group_id,
                    image,
                    fallback_image_ordinal,
                    selected=True,
                )
            )
        normalized_groups.append(normalized_group)

    manual_ordinals = [
        int(group.get("ordinal") or fallback)
        for fallback, group in enumerate(manual_groups, 1)
    ]
    automatic_ordinal = max(manual_ordinals, default=0)
    for fallback_ordinal, group in enumerate(automatic, 1):
        group_id = str(group.get("id") or "").strip()
        automatic_kind = str(group.get("kind") or "")
        if automatic_kind not in {"exact", "compression"}:
            raise ValueError("自动去重组类型无效")
        winner = dict(group.get("winner") or {})
        winner_path = str(winner.get("relative_path") or "").strip()
        rejected_items = list(group.get("rejected_items") or [])
        if not winner_path or not rejected_items:
            raise ValueError("自动去重组缺少保留图或淘汰图")
        reason = str(group.get("reason") or "")
        normalized_group = normalize_group(
            group_id,
            automatic_ordinal + fallback_ordinal,
            f"auto_{automatic_kind}",
            list(group.get("match_levels") or []),
            reason,
            decided=True,
        )
        for fallback_image_ordinal, image in enumerate(rejected_items, 1):
            normalized_group["images"].append(
                normalize_image(
                    group_id,
                    image,
                    fallback_image_ordinal,
                    selected=False,
                    metadata_extra={
                        "automatic_dedup": {
                            "kind": automatic_kind,
                            "winner_relative_path": winner_path,
                            "reason": reason,
                        }
                    },
                )
            )
            automatic_rejected_count += 1
        normalized_groups.append(normalized_group)

    expected_images = int((manifest.get("counts") or {}).get("images") or 0)
    if expected_images != image_count:
        raise ValueError("审核清单的总图片计数不一致")
    return {
        "groups": normalized_groups,
        "manual_group_count": len(manual_groups),
        "automatic_group_count": len(automatic),
        "image_count": image_count,
        "duplicate_count": duplicate_count,
        "unreadable_count": unreadable_count,
        "automatic_rejected_count": automatic_rejected_count,
    }


def write_crawl_review_manifest(
    connection: sqlite3.Connection,
    batch_id: str,
    normalized: dict[str, Any],
    *,
    now: float,
    groups_table: str = "crawl_review_groups",
    images_table: str = "crawl_review_images",
    identity_column: str = "batch_id",
) -> None:
    connection.execute(
        f"DELETE FROM {groups_table} WHERE {identity_column}=?",
        (batch_id,),
    )
    for group in normalized["groups"]:
        connection.execute(
            f"""
            INSERT INTO {groups_table}(
                {identity_column}, id, ordinal, kind, match_levels_json, reason,
                decided, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                batch_id,
                group["id"],
                group["ordinal"],
                group["kind"],
                json.dumps(group["match_levels"], ensure_ascii=False),
                redact_text(group["reason"], limit=1000),
                int(group["decided"]),
                now,
                now,
            ),
        )
        for image in group["images"]:
            connection.execute(
                f"""
                INSERT INTO {images_table}(
                    {identity_column}, id, group_id, ordinal, relative_path, file_hash,
                    metadata_json, readable, recommended, selected, disposition,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                """,
                (
                    batch_id,
                    image["id"],
                    image["group_id"],
                    image["ordinal"],
                    image["relative_path"],
                    image["file_hash"],
                    image["metadata_json"],
                    int(image["readable"]),
                    int(image["recommended"]),
                    int(image["selected"]),
                    now,
                    now,
                ),
            )


def project_crawl_review_manifest_result(
    normalized: dict[str, Any],
) -> dict[str, Any]:
    automatic_rejected_count = int(normalized["automatic_rejected_count"])
    next_status = "auto_applying" if automatic_rejected_count else "ready"
    return {
        "status": next_status,
        "total_image_count": int(normalized["image_count"]),
        "total_group_count": int(normalized["manual_group_count"]),
        "duplicate_group_count": int(normalized["duplicate_count"]),
        "unreadable_image_count": int(normalized["unreadable_count"]),
        "automatic_group_count": int(normalized["automatic_group_count"]),
        "automatic_rejected_image_count": automatic_rejected_count,
    }


def update_crawl_review_manifest_result(
    connection: sqlite3.Connection,
    batch_id: str,
    result: dict[str, Any],
    *,
    log_path: str,
    now: float,
    reviews_table: str = "crawl_reviews", identity_column: str = "batch_id",
) -> None:
    connection.execute(
        f"""
        UPDATE {reviews_table} SET status=?, total_image_count=?,
            total_group_count=?, duplicate_group_count=?, unreadable_image_count=?,
            automatic_group_count=?, automatic_rejected_image_count=?,
            kept_image_count=0, rejected_image_count=0, failed_image_count=0,
            error='', analysis_log_path=?, ready_at=?, updated_at=?
        WHERE {identity_column}=?
        """,
        (
            result["status"],
            result["total_image_count"],
            result["total_group_count"],
            result["duplicate_group_count"],
            result["unreadable_image_count"],
            result["automatic_group_count"],
            result["automatic_rejected_image_count"],
            log_path,
            now if result["status"] == "ready" else None,
            now,
            batch_id,
        ),
    )


class ReviewRepository:
    """Review persistence over the Database-owned reader and write transaction."""

    def __init__(
        self,
        *,
        read: ReadFactory,
        transaction: TransactionFactory,
        clock: Clock,
        max_groups: GroupLimit,
        get_review: ReviewReader,
        gallery: bool = False,
    ) -> None:
        self._read = read
        self._transaction = transaction
        self._clock = clock
        self._max_groups = max_groups
        self._get_review = get_review
        prefix = "gallery" if gallery else "crawl"
        self.reviews_table = f"{prefix}_reviews"
        self.groups_table = f"{prefix}_review_groups"
        self.images_table = f"{prefix}_review_images"
        self.identity_column = "review_id" if gallery else "batch_id"

    _crawl_review = staticmethod(project_crawl_review)
    _crawl_review_group = staticmethod(project_crawl_review_group)
    _crawl_review_image = staticmethod(project_crawl_review_image)

    def replace_crawl_review_manifest(
        self,
        batch_id: str,
        manifest: dict[str, Any],
        *,
        log_path: str = "",
    ) -> None:
        groups = list(manifest.get("groups") or [])
        automatic_groups = list(manifest.get("auto_groups") or [])
        now = self._clock()
        with self._transaction() as connection:
            read_crawl_review_manifest_state(
                connection, batch_id, reviews_table=self.reviews_table,
                identity_column=self.identity_column,
            )
            normalized = normalize_crawl_review_manifest(
                manifest,
                groups=groups,
                automatic_groups=automatic_groups,
            )
            result = project_crawl_review_manifest_result(normalized)
            write_crawl_review_manifest(
                connection,
                batch_id,
                normalized,
                now=now, groups_table=self.groups_table, images_table=self.images_table,
                identity_column=self.identity_column,
            )
            update_crawl_review_manifest_result(
                connection,
                batch_id,
                result,
                log_path=log_path,
                now=now, reviews_table=self.reviews_table,
                identity_column=self.identity_column,
            )

    def get_crawl_review(self, batch_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                f"SELECT * FROM {self.reviews_table} WHERE {self.identity_column}=?",
                (batch_id,),
            ).fetchone()
            review = self._crawl_review(row)
            if review is None:
                return None
            image_counts = conn.execute(
                f"""
                SELECT
                    SUM(CASE WHEN selected=1 THEN 1 ELSE 0 END) AS selected_count,
                    SUM(CASE WHEN disposition='kept' THEN 1 ELSE 0 END) AS kept_count,
                    SUM(CASE WHEN disposition='rejected' THEN 1 ELSE 0 END) AS rejected_count,
                    SUM(CASE WHEN disposition='failed' THEN 1 ELSE 0 END) AS failed_count
                FROM {self.images_table} WHERE {self.identity_column}=?
                """,
                (batch_id,),
            ).fetchone()
            decided = conn.execute(
                f"""
                SELECT COUNT(*) FROM {self.groups_table}
                WHERE {self.identity_column}=? AND decided=1 AND kind NOT LIKE 'auto_%'
                """,
                (batch_id,),
            ).fetchone()[0]
        review["selected_image_count"] = int(image_counts["selected_count"] or 0)
        review["kept_image_count"] = int(image_counts["kept_count"] or review["kept_image_count"] or 0)
        review["rejected_image_count"] = int(
            image_counts["rejected_count"] or review["rejected_image_count"] or 0
        )
        review["failed_image_count"] = int(
            image_counts["failed_count"] or review["failed_image_count"] or 0
        )
        review["decided_group_count"] = int(decided or 0)
        return review

    def start_crawl_review(self, batch_id: str) -> dict[str, Any]:
        now = self._clock()
        with self._transaction() as conn:
            batch = conn.execute(
                "SELECT status FROM crawl_batches WHERE id=?",
                (batch_id,),
            ).fetchone()
            if batch is None:
                raise KeyError(batch_id)
            if batch["status"] not in {"succeeded", "completed_with_errors", "cancelled"}:
                raise RuntimeError("爬取批次结束后才能启动去重分析")
            conn.execute(
                f"""
                INSERT INTO {self.reviews_table}({self.identity_column}, status, created_at, updated_at)
                VALUES (?, 'pending', ?, ?)
                ON CONFLICT({self.identity_column}) DO UPDATE SET status='pending', updated_at=?, error=''
                WHERE {self.reviews_table}.status='waiting_for_crawl'
                """,
                (batch_id, now, now, now),
            )
        review = self._get_review(batch_id)
        if review is None:
            raise RuntimeError("去重分析任务建立后读取失败")
        return review

    def recover_crawl_reviews(self) -> int:
        now = self._clock()
        with self._transaction() as conn:
            analyzing = conn.execute(
                f"""
                UPDATE {self.reviews_table} SET status='pending', updated_at=?,
                    error='服务重启，重新执行去重分析'
                WHERE status='analyzing'
                """,
                (now,),
            ).rowcount
            applying = conn.execute(
                f"""
                UPDATE {self.reviews_table} SET status='apply_failed', updated_at=?,
                    error='服务重启，需重试应用审核结果'
                WHERE status='applying'
                """,
                (now,),
            ).rowcount
            return int(analyzing + applying)

    def claim_next_crawl_review(self) -> dict[str, Any] | None:
        now = self._clock()
        with self._transaction() as conn:
            row = conn.execute(
                f"""
                SELECT cr.{self.identity_column}, cb.output_dir FROM {self.reviews_table} cr
                JOIN crawl_batches cb ON cb.id=cr.{self.identity_column}
                WHERE cr.status='pending'
                  AND cb.status IN ('succeeded','completed_with_errors','cancelled')
                ORDER BY cb.finished_at, cb.created_at LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            updated = conn.execute(
                f"""
                UPDATE {self.reviews_table} SET status='analyzing', started_at=?, updated_at=?,
                    ready_at=NULL, applied_at=NULL, error=''
                WHERE {self.identity_column}=? AND status='pending'
                """,
                (now, now, row["batch_id"]),
            )
            if not updated.rowcount:
                return None
            return {"batch_id": str(row["batch_id"]), "output_dir": str(row["output_dir"])}

    def next_crawl_review_automatic(self) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                f"""
                SELECT cr.{self.identity_column}, cb.output_dir FROM {self.reviews_table} cr
                JOIN crawl_batches cb ON cb.id=cr.{self.identity_column}
                WHERE cr.status='auto_applying'
                ORDER BY cr.updated_at, cr.created_at LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            return {
                "batch_id": str(row["batch_id"]),
                "output_dir": str(row["output_dir"]),
            }

    def requeue_crawl_review(self, batch_id: str) -> None:
        with self._transaction() as conn:
            conn.execute(
                f"""
                UPDATE {self.reviews_table} SET status='pending', updated_at=?, error=''
                WHERE {self.identity_column}=? AND status='analyzing'
                """,
                (self._clock(), batch_id),
            )

    def fail_crawl_review(self, batch_id: str, error: str, *, log_path: str = "") -> None:
        with self._transaction() as conn:
            conn.execute(
                f"""
                UPDATE {self.reviews_table} SET status='failed', error=?, analysis_log_path=?,
                    updated_at=? WHERE {self.identity_column}=? AND status='analyzing'
                """,
                (redact_text(error, limit=4000), log_path, self._clock(), batch_id),
            )

    def retry_crawl_review(self, batch_id: str) -> bool:
        now = self._clock()
        with self._transaction() as conn:
            row = conn.execute(
                f"SELECT status FROM {self.reviews_table} WHERE {self.identity_column}=?",
                (batch_id,),
            ).fetchone()
            if row is None:
                return False
            if row["status"] != "failed":
                raise RuntimeError("当前审核分析状态不允许重试")
            conn.execute(f"DELETE FROM {self.groups_table} WHERE {self.identity_column}=?", (batch_id,))
            conn.execute(
                f"""
                UPDATE {self.reviews_table} SET status='pending', total_image_count=0,
                    total_group_count=0, duplicate_group_count=0, unreadable_image_count=0,
                    automatic_group_count=0, automatic_rejected_image_count=0,
                    kept_image_count=0, rejected_image_count=0, failed_image_count=0,
                    error='', updated_at=?, started_at=NULL, ready_at=NULL, applied_at=NULL
                WHERE {self.identity_column}=?
                """,
                (now, batch_id),
            )
            return True

    def list_crawl_review_groups(
        self,
        batch_id: str,
        *,
        kind: str | None = None,
        limit: int = 12,
        offset: int = 0,
        all_groups: bool = False,
    ) -> dict[str, Any]:
        where = f"{self.identity_column}=? AND kind NOT LIKE 'auto_%'"
        params: list[Any] = [batch_id]
        if kind:
            where += " AND kind=?"
            params.append(kind)
        page_limit = (
            self._max_groups()
            if all_groups
            else max(1, min(int(limit), 50))
        )
        page_offset = 0 if all_groups else max(0, int(offset))
        with self._read() as conn:
            total = int(
                conn.execute(
                    f"SELECT COUNT(*) FROM {self.groups_table} WHERE {where}",
                    params,
                ).fetchone()[0]
            )
            if all_groups and total > self._max_groups():
                raise CrawlReviewGroupLimitExceeded(
                    f"审核组数量超过全量读取上限 {self._max_groups()}"
                )
            rows = conn.execute(
                f"""
                SELECT * FROM {self.groups_table} WHERE {where}
                ORDER BY ordinal LIMIT ? OFFSET ?
                """,
                [*params, page_limit, page_offset],
            ).fetchall()
            groups: list[dict[str, Any]] = []
            for row in rows:
                group = self._crawl_review_group(row)
                if group is None:
                    continue
                image_rows = conn.execute(
                    f"""
                    SELECT * FROM {self.images_table}
                    WHERE {self.identity_column}=? AND group_id=? ORDER BY ordinal
                    """,
                    (batch_id, group["id"]),
                ).fetchall()
                group["images"] = [
                    self._crawl_review_image(image_row) for image_row in image_rows
                ]
                group["image_count"] = len(group["images"])
                group["selected_image_count"] = sum(
                    bool(image and image.get("selected")) for image in group["images"]
                )
                groups.append(group)
        return {
            "items": groups,
            "total": total,
            "limit": len(groups) if all_groups else page_limit,
            "offset": page_offset,
        }

    def update_crawl_review_decisions(
        self,
        batch_id: str,
        decisions: list[dict[str, Any]],
        *, version: int | None = None,
    ) -> None:
        now = self._clock()
        with self._transaction() as conn:
            review = conn.execute(
                f"SELECT * FROM {self.reviews_table} WHERE {self.identity_column}=?",
                (batch_id,),
            ).fetchone()
            if review is None:
                raise KeyError(batch_id)
            if version is not None and int(review["version"]) != version:
                raise RuntimeError("审核版本冲突")
            if review["status"] != "ready":
                raise RuntimeError("当前审核状态不允许修改选择")
            seen_groups: set[str] = set()
            for decision in decisions:
                group_id = str(decision.get("group_id") or "")
                if not group_id or group_id in seen_groups:
                    raise ValueError("审核决策包含空或重复的组 ID")
                seen_groups.add(group_id)
                group_row = conn.execute(
                    f"SELECT kind FROM {self.groups_table} WHERE {self.identity_column}=? AND id=?",
                    (batch_id, group_id),
                ).fetchone()
                if group_row is None:
                    raise KeyError(group_id)
                if str(group_row["kind"] or "").startswith("auto_"):
                    # Auto-dedup groups are applied by the worker, not the user. Flipping a
                    # rejected auto-image back to selected would make apply look for a file
                    # the worker already moved away -> apply_failed + skewed auto counts.
                    raise ValueError("不能修改自动去重组的选择")
                rows = conn.execute(
                    f"""
                    SELECT id FROM {self.images_table} WHERE {self.identity_column}=? AND group_id=?
                    """,
                    (batch_id, group_id),
                ).fetchall()
                if not rows:
                    raise KeyError(group_id)
                available = {str(row["id"]) for row in rows}
                selected = {str(value) for value in decision.get("selected_image_ids") or []}
                if not selected.issubset(available):
                    raise ValueError("审核决策包含不属于当前组的图片 ID")
                conn.execute(
                    f"""
                    UPDATE {self.images_table} SET selected=0, updated_at=?
                    WHERE {self.identity_column}=? AND group_id=?
                    """,
                    (now, batch_id, group_id),
                )
                if selected:
                    conn.executemany(
                        f"""
                        UPDATE {self.images_table} SET selected=1, updated_at=?
                        WHERE {self.identity_column}=? AND group_id=? AND id=?
                        """,
                        [(now, batch_id, group_id, image_id) for image_id in selected],
                    )
                conn.execute(
                    f"""
                    UPDATE {self.groups_table} SET decided=1, updated_at=?
                    WHERE {self.identity_column}=? AND id=?
                    """,
                    (now, batch_id, group_id),
                )
            conn.execute(
                f"UPDATE {self.reviews_table} SET updated_at=? "
                + (" , version=version+1 " if self.identity_column == "review_id" else "")
                + f"WHERE {self.identity_column}=?",
                (now, batch_id),
            )

    def get_crawl_review_image(self, batch_id: str, image_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                f"""
                SELECT cri.*, cb.output_dir FROM {self.images_table} cri
                JOIN crawl_batches cb ON cb.id=cri.{self.identity_column}
                WHERE cri.{self.identity_column}=? AND cri.id=?
                """,
                (batch_id, image_id),
            ).fetchone()
            return self._crawl_review_image(row)

    def begin_crawl_review_apply(self, batch_id: str) -> bool:
        with self._transaction() as conn:
            review = conn.execute(
                f"""
                SELECT cr.status AS status, cb.status AS batch_status
                FROM {self.reviews_table} cr JOIN crawl_batches cb ON cb.id=cr.{self.identity_column}
                WHERE cr.{self.identity_column}=?
                """,
                (batch_id,),
            ).fetchone()
            if review is None or review["status"] not in {"ready", "apply_failed"}:
                return False
            # A rerun/retry can pull the batch back to running after the review turned
            # ready; applying an old manifest then would move files while gallery-dl is
            # writing the same tree (and re-download whatever we "rejected"). Refuse
            # unless the batch is terminal again.
            if review["batch_status"] not in TERMINAL_BATCH_STATUSES:
                return False
            undecided = int(
                conn.execute(
                    f"""
                    SELECT COUNT(*) FROM {self.groups_table}
                    WHERE {self.identity_column}=? AND decided=0
                    """,
                    (batch_id,),
                ).fetchone()[0]
            )
            if undecided:
                raise RuntimeError(f"还有 {undecided} 个图片组尚未确认")
            updated = conn.execute(
                f"""
                UPDATE {self.reviews_table} SET status='applying', error='', updated_at=?
                WHERE {self.identity_column}=? AND status IN ('ready','apply_failed')
                """,
                (self._clock(), batch_id),
            )
            return bool(updated.rowcount)

    def crawl_review_apply_images(self, batch_id: str) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM {self.images_table} WHERE {self.identity_column}=?
                ORDER BY group_id, ordinal
                """,
                (batch_id,),
            ).fetchall()
            return [self._crawl_review_image(row) for row in rows]

    def crawl_review_automatic_images(self, batch_id: str) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                f"""
                SELECT cri.* FROM {self.images_table} cri
                JOIN {self.groups_table} crg
                    ON crg.{self.identity_column}=cri.{self.identity_column} AND crg.id=cri.group_id
                WHERE cri.{self.identity_column}=? AND crg.kind LIKE 'auto_%' AND cri.selected=0
                ORDER BY crg.ordinal, cri.ordinal
                """,
                (batch_id,),
            ).fetchall()
            return [self._crawl_review_image(row) for row in rows]

    def finish_crawl_review_automatic(self, batch_id: str) -> dict[str, Any] | None:
        now = self._clock()
        with self._transaction() as conn:
            counts = conn.execute(
                f"""
                SELECT
                    SUM(CASE WHEN cri.disposition='rejected' THEN 1 ELSE 0 END) AS rejected,
                    SUM(CASE WHEN cri.disposition='failed' THEN 1 ELSE 0 END) AS failed
                FROM {self.images_table} cri
                JOIN {self.groups_table} crg
                    ON crg.{self.identity_column}=cri.{self.identity_column} AND crg.id=cri.group_id
                WHERE cri.{self.identity_column}=? AND crg.kind LIKE 'auto_%'
                """,
                (batch_id,),
            ).fetchone()
            rejected = int(counts["rejected"] or 0)
            failed = int(counts["failed"] or 0)
            error = f"{failed} 张严格自动淘汰图片处理失败" if failed else ""
            updated = conn.execute(
                f"""
                UPDATE {self.reviews_table} SET status='ready', rejected_image_count=?,
                    failed_image_count=?, error=?, ready_at=?, updated_at=?
                WHERE {self.identity_column}=? AND status='auto_applying'
                """,
                (rejected, failed, error, now, now, batch_id),
            )
            if not updated.rowcount:
                return None
        return self._get_review(batch_id)

    def stage_crawl_review_image_move(
        self,
        batch_id: str,
        image_id: str,
        final_relative_path: str,
    ) -> None:
        with self._transaction() as conn:
            conn.execute(
                f"""
                UPDATE {self.images_table} SET disposition='moving', final_relative_path=?,
                    error='', updated_at=? WHERE {self.identity_column}=? AND id=?
                """,
                (final_relative_path, self._clock(), batch_id, image_id),
            )

    def finish_crawl_review_image(
        self,
        batch_id: str,
        image_id: str,
        disposition: str,
        *,
        final_relative_path: str,
        error: str = "",
    ) -> None:
        if disposition not in {"kept", "rejected", "failed"}:
            raise ValueError("审核图片结果状态无效")
        with self._transaction() as conn:
            conn.execute(
                f"""
                UPDATE {self.images_table} SET disposition=?, final_relative_path=?,
                    error=?, updated_at=? WHERE {self.identity_column}=? AND id=?
                """,
                (
                    disposition,
                    final_relative_path,
                    redact_text(error, limit=2000),
                    self._clock(),
                    batch_id,
                    image_id,
                ),
            )

    def finish_crawl_review_apply(self, batch_id: str) -> dict[str, Any] | None:
        now = self._clock()
        with self._transaction() as conn:
            counts = conn.execute(
                f"""
                SELECT
                    SUM(CASE WHEN disposition='kept' THEN 1 ELSE 0 END) AS kept,
                    SUM(CASE WHEN disposition='rejected' THEN 1 ELSE 0 END) AS rejected,
                    SUM(CASE WHEN disposition NOT IN ('kept','rejected') THEN 1 ELSE 0 END) AS failed
                FROM {self.images_table} WHERE {self.identity_column}=?
                """,
                (batch_id,),
            ).fetchone()
            kept = int(counts["kept"] or 0)
            rejected = int(counts["rejected"] or 0)
            failed = int(counts["failed"] or 0)
            status = "apply_failed" if failed else "applied"
            error = f"{failed} 张图片处理失败" if failed else ""
            conn.execute(
                f"""
                UPDATE {self.reviews_table} SET status=?, kept_image_count=?, rejected_image_count=?,
                    failed_image_count=?, error=?, updated_at=?, applied_at=? WHERE {self.identity_column}=?
                """,
                (status, kept, rejected, failed, error, now, now if not failed else None, batch_id),
            )
        return self._get_review(batch_id)
