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

    def list(self, *, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        with self._read() as conn:
            total = conn.execute("SELECT COUNT(*) FROM gallery_reviews").fetchone()[0]
            rows = conn.execute("SELECT review_id FROM gallery_reviews ORDER BY created_at DESC,review_id LIMIT ? OFFSET ?", (limit, offset)).fetchall()
        return {"items": [self.get_crawl_review(row["review_id"]) for row in rows],
                "total": total, "limit": limit, "offset": offset}

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

    def begin_crawl_review_apply(self, review_id: str, *, version: int) -> bool:
        with self._transaction() as conn:
            row = conn.execute("SELECT status,version FROM gallery_reviews WHERE review_id=?", (review_id,)).fetchone()
            if row is None:
                raise KeyError(review_id)
            if row["version"] != version:
                raise RuntimeError("审核版本冲突")
            if row["status"] == "applied":
                return False  # Idempotent acknowledgement, never retrash restored assets.
            if row["status"] not in {"ready", "apply_failed"}:
                raise RuntimeError("当前审核状态不允许应用选择")
            undecided = conn.execute("SELECT COUNT(*) FROM gallery_review_groups WHERE review_id=? AND decided=0", (review_id,)).fetchone()[0]
            if undecided:
                raise RuntimeError(f"还有 {undecided} 个图片组尚未确认")
            conn.execute("UPDATE gallery_reviews SET status='applying',version=version+1,error='',updated_at=? WHERE review_id=?", (self._clock(), review_id))
        return True

    def get_crawl_review_image(self, review_id: str, image_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute("SELECT * FROM gallery_review_images WHERE review_id=? AND id=?", (review_id, image_id)).fetchone()
        return self._crawl_review_image(row)

    def bump_version(self, review_id: str) -> None:
        with self._transaction() as conn:
            conn.execute("UPDATE gallery_reviews SET version=version+1 WHERE review_id=?", (review_id,))
