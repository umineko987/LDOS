from __future__ import annotations

import json
import uuid
from typing import Any

from ._database_review_repository import ReviewRepository


class GalleryReviewRepository(ReviewRepository):
    """Independent identities; groups, decisions and result state reuse ReviewRepository."""

    def create(self, selection: list[dict[str, Any]], snapshot: list[dict[str, Any]]) -> dict[str, Any]:
        review_id = str(uuid.uuid4())
        now = self._clock()
        with self._transaction() as conn:
            conn.execute("""INSERT INTO gallery_reviews(review_id,status,selection_json,snapshot_json,
                         total_image_count,created_at,updated_at) VALUES (?,'pending',?,?,?,?,?)""",
                         (review_id, json.dumps(selection), json.dumps(snapshot), len(snapshot), now, now))
        return self.get_crawl_review(review_id)

    def get_crawl_review(self, review_id: str) -> dict[str, Any] | None:
        review = super().get_crawl_review(review_id)
        if review is not None:
            review["directories"] = json.loads(review.pop("selection_json"))
            review.pop("snapshot_json")
        return review

    def snapshot(self, review_id: str) -> list[dict[str, Any]]:
        with self._read() as conn:
            row = conn.execute("SELECT snapshot_json FROM gallery_reviews WHERE review_id=?", (review_id,)).fetchone()
        if row is None:
            raise KeyError(review_id)
        return json.loads(row["snapshot_json"])

    def refresh_snapshot_asset(self, review_id: str, asset_id: str, content_version: int, txt_version: int) -> None:
        """恢复/回收会抬升资产版本号；同步进冻结快照，保证后续校验与预览不误报。"""
        snapshots = self.snapshot(review_id)
        changed = False
        for item in snapshots:
            if item["asset_id"] == asset_id and (item["content_version"] != content_version or item["txt_version"] != txt_version):
                item["content_version"] = content_version
                item["txt_version"] = txt_version
                changed = True
        if not changed:
            return
        with self._transaction() as conn:
            conn.execute("UPDATE gallery_reviews SET snapshot_json=? WHERE review_id=?",
                         (json.dumps(snapshots), review_id))

    def claim_next_crawl_review(self) -> dict[str, Any] | None:
        now = self._clock()
        with self._transaction() as conn:
            row = conn.execute("SELECT review_id FROM gallery_reviews WHERE status='pending' ORDER BY created_at LIMIT 1").fetchone()
            if row is None:
                return None
            conn.execute("UPDATE gallery_reviews SET status='analyzing',version=version+1,started_at=?,updated_at=?,error='' WHERE review_id=?", (now, now, row["review_id"]))
        return {"review_id": row["review_id"], "images": self.snapshot(row["review_id"])}

    def next_crawl_review_automatic(self) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute("SELECT review_id FROM gallery_reviews WHERE status='auto_applying' ORDER BY created_at LIMIT 1").fetchone()
        return {"review_id": row["review_id"], "images": self.snapshot(row["review_id"])} if row else None

    def crawl_review_group_images(self, review_id: str, group_id: str) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                "SELECT * FROM gallery_review_images WHERE review_id=? AND group_id=? ORDER BY ordinal",
                (review_id, group_id),
            ).fetchall()
            return [self._crawl_review_image(row) for row in rows]

    def refresh_crawl_review_counts(self, review_id: str) -> None:
        now = self._clock()
        with self._transaction() as conn:
            counts = conn.execute(
                """
                SELECT
                    SUM(CASE WHEN disposition='kept' THEN 1 ELSE 0 END) AS kept,
                    SUM(CASE WHEN disposition='rejected' THEN 1 ELSE 0 END) AS rejected,
                    SUM(CASE WHEN disposition='failed' THEN 1 ELSE 0 END) AS failed
                FROM gallery_review_images WHERE review_id=?
                """,
                (review_id,),
            ).fetchone()
            failed = int(counts["failed"] or 0)
            conn.execute(
                "UPDATE gallery_reviews SET kept_image_count=?, rejected_image_count=?, failed_image_count=?,"
                " error=?, updated_at=? WHERE review_id=? AND status='ready'",
                (int(counts["kept"] or 0), int(counts["rejected"] or 0), failed,
                 f"{failed} 张图片处理失败" if failed else "", now, review_id),
            )

    def delete_crawl_review(self, review_id: str) -> None:
        with self._transaction() as conn:
            row = conn.execute("SELECT review_id FROM gallery_reviews WHERE review_id=?", (review_id,)).fetchone()
            if row is None:
                raise KeyError(review_id)
            conn.execute("DELETE FROM gallery_review_images WHERE review_id=?", (review_id,))
            conn.execute("DELETE FROM gallery_review_groups WHERE review_id=?", (review_id,))
            conn.execute("DELETE FROM gallery_reviews WHERE review_id=?", (review_id,))

    def get_crawl_review_image(self, review_id: str, image_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute("SELECT * FROM gallery_review_images WHERE review_id=? AND id=?", (review_id, image_id)).fetchone()
        return self._crawl_review_image(row)

    def delete_all_reviews(self) -> int:
        """一次性任务语义：上次会话遗留的任务记录不可再打开，启动时全部清除。"""
        with self._transaction() as conn:
            removed = conn.execute("SELECT COUNT(*) FROM gallery_reviews").fetchone()[0]
            conn.execute("DELETE FROM gallery_review_images")
            conn.execute("DELETE FROM gallery_review_groups")
            conn.execute("DELETE FROM gallery_reviews")
            return int(removed)

    def bump_version(self, review_id: str) -> None:
        with self._transaction() as conn:
            conn.execute("UPDATE gallery_reviews SET version=version+1 WHERE review_id=?", (review_id,))
