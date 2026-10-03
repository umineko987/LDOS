from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any

from .gallery_review_selection import select_review_assets, validate_snapshot
from .gallery_safe_paths import SafeSourceRoot
from .review import DedupReviewManager, ensure_private_directory
from .review_filters import FilterConfigurationError, require_filter_capabilities
from .schemas import FilterConfig


def review_trash_operation_id(review_id: str, image_id: str, attempt: int = 0) -> str:
    suffix = "" if attempt <= 0 else f":{attempt}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"ldos:review:{review_id}:{image_id}{suffix}"))


class GalleryDedupReviewManager(DedupReviewManager):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.repository = self.db.gallery_reviews

    def create(self, directory_ids: list[str], asset_ids: list[str] | None = None,
               filter_config: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.settings.enabled:
            raise RuntimeError("去重功能未启用")
        if not directory_ids and not asset_ids:
            raise ValueError("review_selection_empty")
        config = FilterConfig.model_validate(filter_config).model_dump() if filter_config is not None else None
        references = []
        if config is not None:
            options = config["options"]
            if options["filter_character"] and not options["reference_asset_ids"]:
                raise FilterConfigurationError("filter_reference_required", "角色过滤必须指定有效参考图")
            if options["reference_asset_ids"]:
                try:
                    _, references = select_review_assets(self.catalog, [], options["reference_asset_ids"])
                    from PIL import Image
                    with self.catalog._filesystem_locks.hold(*(f"source:{s['source_id']}" for s in references)):
                        for reference in references:
                            with SafeSourceRoot(reference["root_path"]) as safe:
                                validate_snapshot(self.db.gallery, reference, safe)
                                with safe.open_binary(reference["relative_path"]) as handle:
                                    with Image.open(handle) as image:
                                        image.verify()
                except (KeyError, ValueError, RuntimeError, OSError) as exc:
                    raise FilterConfigurationError("filter_reference_invalid", "参考图不存在、不可读取或安全快照无效") from exc
            require_filter_capabilities(options)
        selection, snapshot = select_review_assets(self.catalog, directory_ids, asset_ids or ())
        result = self.repository.create(selection, snapshot, filter_config=config, reference_snapshot=references)
        self.notify()
        return result

    async def start(self) -> None:
        """一次性任务：启动时先恢复中断的物理文件操作，再清空上次会话遗留的任务记录。"""
        if self._loop_task is not None:
            return
        if self.file_operations is not None:
            await asyncio.to_thread(self.file_operations.recover_unfinished)
        await asyncio.to_thread(self.repository.delete_all_reviews)
        if not self.settings.enabled:
            return
        ensure_private_directory(self.runtime_dir)
        self._loop_task = asyncio.create_task(self._loop(), name="dedup-review-manager")

    def retry_analysis(self, review_id: str) -> bool:
        retried = super().retry_analysis(review_id)
        if retried:
            self.repository.bump_version(review_id)
            self.notify()
        return retried

    def _validate_input(self, claimed: dict[str, Any]) -> None:
        snapshots = claimed["images"] + claimed.get("references", [])
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

    def adopt_group(self, review_id: str, group_id: str, selected_image_ids: list[str], *, version: int) -> dict[str, Any]:
        """采纳单组：先写决策（版本与归属校验，fail-closed），再逐图实时对账物理状态。"""
        self.repository.update_crawl_review_decisions(
            review_id, [{"group_id": group_id, "selected_image_ids": selected_image_ids}], version=version,
        )
        images = self.repository.crawl_review_group_images(review_id, group_id)
        snapshots = {snapshot["asset_id"]: snapshot for snapshot in self.repository.snapshot(review_id)}
        with self.catalog._filesystem_locks.hold(*(f"source:{snapshots[image['id']]['source_id']}" for image in images)):
            for image in images:
                try:
                    disposition, final_path = self._settle_image(review_id, image, snapshots[image["id"]])
                except Exception as exc:
                    self.repository.finish_crawl_review_image(review_id, image["id"], "failed",
                                                             final_relative_path=image["final_relative_path"], error=str(exc))
                else:
                    self.repository.finish_crawl_review_image(review_id, image["id"], disposition,
                                                              final_relative_path=final_path)
        self.repository.refresh_crawl_review_counts(review_id)
        self.repository.bump_version(review_id)
        return self.repository.get_crawl_review(review_id)

    def finish(self, review_id: str) -> None:
        """完成一次性任务：已落地的文件操作保持不变，任务记录即刻删除。"""
        self.repository.delete_crawl_review(review_id)
        self.notify()

    def _settle_image(self, review_id: str, image: dict[str, Any], snapshot: dict[str, Any]) -> tuple[str, str]:
        asset = self.db.gallery.get_asset(snapshot["asset_id"])
        if asset is None:
            raise RuntimeError("review_asset_missing")
        operation_id = self._current_trash_operation(review_id, image, asset)
        if image["selected"]:
            if operation_id is None:
                return "kept", snapshot["relative_path"]
            self.file_operations.restore_trash(operation_id)
            current = self.db.gallery.get_asset(snapshot["asset_id"])
            self.repository.refresh_snapshot_asset(review_id, snapshot["asset_id"],
                                                  int(current["content_version"]), int(current["txt_version"]))
            return "kept", snapshot["relative_path"]
        if operation_id is not None:
            return "rejected", f".ldos/trash/{operation_id}/files/{snapshot['relative_path']}"
        with SafeSourceRoot(snapshot["root_path"]) as safe:
            validate_snapshot(self.db.gallery, snapshot, safe)
        for attempt in range(64):
            candidate = review_trash_operation_id(review_id, image["id"], attempt)
            with self.db._read() as conn:
                row = conn.execute("SELECT status FROM gallery_file_operations WHERE id=?", (candidate,)).fetchone()
            if row is None or row["status"] == "rolled_back":
                self.file_operations.trash_assets([snapshot["asset_id"]], review_snapshot=snapshot, operation_id=candidate)
                return "rejected", f".ldos/trash/{candidate}/files/{snapshot['relative_path']}"
            if row["status"] == "committed" and asset["lifecycle_state"] != "trashed":
                continue  # 该槽位的回收已被后续采纳撤销，换下一个槽位
            raise RuntimeError("review_operation_conflict")

    def _current_trash_operation(self, review_id: str, image: dict[str, Any], asset: dict[str, Any]) -> str | None:
        if asset["lifecycle_state"] != "trashed":
            return None
        with self.db._read() as conn:
            row = conn.execute(
                """
                SELECT o.id FROM gallery_file_operations o
                JOIN gallery_file_operation_items i ON i.operation_id=o.id
                WHERE o.kind='trash' AND o.status='committed' AND i.asset_id=?
                ORDER BY o.created_at DESC LIMIT 1
                """,
                (asset["asset_id"],),
            ).fetchone()
        if row is not None and row["id"] in {review_trash_operation_id(review_id, image["id"], attempt) for attempt in range(64)}:
            return str(row["id"])
        raise RuntimeError("review_operation_conflict")

    def image_content(self, review_id: str, image_id: str) -> tuple[Any, str]:
        image = self.repository.get_crawl_review_image(review_id, image_id)
        if image is None:
            raise KeyError(image_id)
        snapshot = next((s for s in self.repository.snapshot(review_id) if s["asset_id"] == image_id), None)
        if snapshot is None:
            raise KeyError(image_id)
        with self.catalog._filesystem_locks.hold(f"source:{snapshot['source_id']}"):
            with SafeSourceRoot(snapshot["root_path"]) as safe:
                asset = self.db.gallery.get_asset(image_id)
                final_path = str(image["final_relative_path"] or "")
                trashed_operation = final_path[len(".ldos/trash/"):].split("/", 1)[0] if final_path.startswith(".ldos/trash/") else ""
                trashed = bool(asset and asset["lifecycle_state"] == "trashed" and trashed_operation)
                validate_snapshot(self.db.gallery, snapshot, safe, trash_operation_id=trashed_operation if trashed else "")
                relative = image["final_relative_path"] if trashed else snapshot["relative_path"]
                return safe.open_binary(relative), Path(snapshot["relative_path"]).name
