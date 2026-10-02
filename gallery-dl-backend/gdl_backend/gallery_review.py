from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any

from .gallery_review_selection import select_review_assets, validate_snapshot
from .gallery_safe_paths import SafeSourceRoot
from .review import DedupReviewManager


def review_trash_operation_id(review_id: str, image_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"ldos:review:{review_id}:{image_id}"))


class GalleryDedupReviewManager(DedupReviewManager):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.repository = self.db.gallery_reviews

    def create(self, directory_ids: list[str]) -> dict[str, Any]:
        if not self.settings.enabled:
            raise RuntimeError("去重功能未启用")
        selection, snapshot = select_review_assets(self.catalog, directory_ids)
        result = self.repository.create(selection, snapshot)
        self.notify()
        return result

    def retry_analysis(self, review_id: str) -> bool:
        retried = super().retry_analysis(review_id)
        if retried:
            self.repository.bump_version(review_id)
            self.notify()
        return retried

    def _validate_input(self, claimed: dict[str, Any]) -> None:
        snapshots = claimed["images"]
        with self.catalog._filesystem_locks.hold(*(f"source:{s['source_id']}" for s in snapshots)):
            for snapshot in snapshots:
                with SafeSourceRoot(snapshot["root_path"]) as safe:
                    validate_snapshot(self.db.gallery, snapshot, safe)

    def _validate_manifest(self, claimed: dict[str, Any], manifest: dict[str, Any]) -> None:
        super()._validate_manifest(claimed, manifest)
        self._validate_input(claimed)

    def _preflight(self, review_id: str) -> None:
        images = {image["id"]: image for image in self.repository.crawl_review_apply_images(review_id)}
        for snapshot in self.repository.snapshot(review_id):
            image = images.get(snapshot["asset_id"])
            operation_id = review_trash_operation_id(review_id, snapshot["asset_id"])
            with self.db._read() as conn:
                operation = conn.execute("SELECT status FROM gallery_file_operations WHERE id=?", (operation_id,)).fetchone()
            trashed = bool(operation and operation["status"] == "committed")
            with SafeSourceRoot(snapshot["root_path"]) as safe:
                validate_snapshot(self.db.gallery, snapshot, safe, trash_operation_id=operation_id if trashed else "")
            if trashed and (image is None or image["selected"]):
                raise RuntimeError("review_operation_conflict")

    def _process_images(self, review_id: str, images: list[dict[str, Any]]) -> None:
        snapshots = {s["asset_id"]: s for s in self.repository.snapshot(review_id)}
        # Serialize preflight + mutation with every Gallery filesystem consumer.
        with self.file_operations.hold_sources([s["source_id"] for s in snapshots.values()]):
            try:
                self._preflight(review_id)
            except Exception as exc:
                for image in images:
                    self.repository.finish_crawl_review_image(review_id, image["id"], "failed",
                        final_relative_path=image["final_relative_path"], error=str(exc))
                return
            for image in images:
                if image["disposition"] == "rejected" or (image["disposition"] == "kept" and image["selected"]):
                    continue
                snapshot = snapshots[image["id"]]
                try:
                    if image["selected"]:
                        with SafeSourceRoot(snapshot["root_path"]) as safe:
                            validate_snapshot(self.db.gallery, snapshot, safe)
                        disposition, final_path = "kept", snapshot["relative_path"]
                    else:
                        operation_id = review_trash_operation_id(review_id, image["id"])
                        self.file_operations.trash_assets([snapshot["asset_id"]],
                            review_snapshot=snapshot, operation_id=operation_id)
                        disposition = "rejected"
                        final_path = f".ldos/trash/{operation_id}/files/{snapshot['relative_path']}"
                    self.repository.finish_crawl_review_image(review_id, image["id"], disposition,
                                                              final_relative_path=final_path)
                except Exception as exc:
                    self.repository.finish_crawl_review_image(review_id, image["id"], "failed",
                        final_relative_path=image["final_relative_path"], error=str(exc))

    def _apply_automatic_rejections(self, claimed: dict[str, Any]) -> dict[str, Any]:
        review_id = claimed["review_id"]
        self._process_images(review_id, self.repository.crawl_review_automatic_images(review_id))
        self.repository.finish_crawl_review_automatic(review_id)
        self.repository.bump_version(review_id)
        return self.repository.get_crawl_review(review_id)

    def apply(self, review_id: str, *, version: int) -> dict[str, Any]:
        if not self.repository.begin_crawl_review_apply(review_id, version=version):
            return self.repository.get_crawl_review(review_id)
        self._process_images(review_id, self.repository.crawl_review_apply_images(review_id))
        self.repository.finish_crawl_review_apply(review_id)
        self.repository.bump_version(review_id)
        return self.repository.get_crawl_review(review_id)

    def image_content(self, review_id: str, image_id: str) -> tuple[Any, str]:
        image = self.repository.get_crawl_review_image(review_id, image_id)
        if image is None:
            raise KeyError(image_id)
        snapshot = next((s for s in self.repository.snapshot(review_id) if s["asset_id"] == image_id), None)
        if snapshot is None:
            raise KeyError(image_id)
        with self.catalog._filesystem_locks.hold(f"source:{snapshot['source_id']}"):
            with SafeSourceRoot(snapshot["root_path"]) as safe:
                operation_id = review_trash_operation_id(review_id, image_id)
                asset = self.db.gallery.get_asset(image_id)
                trashed = bool(asset and asset["lifecycle_state"] == "trashed" and
                               image["final_relative_path"].startswith(f".ldos/trash/{operation_id}/"))
                validate_snapshot(self.db.gallery, snapshot, safe, trash_operation_id=operation_id if trashed else "")
                relative = image["final_relative_path"] if trashed else snapshot["relative_path"]
                return safe.open_binary(relative), Path(snapshot["relative_path"]).name
