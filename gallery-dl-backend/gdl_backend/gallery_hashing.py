"""图库文件内容哈希（gallery_assets.content_sha256）。

嵌入向量和打标缓存都以文件 sha256 为键；索引里补上哈希后，才能按图片查到它们。
哈希只按需计算（数据集成员、显式请求），不会在启动时扫全库。

写入是有条件的：读文件前后的 fstat 都要和索引里记录的大小、修改时间一致，
写库时再用同样的条件做一次 UPDATE。任何一步对不上都放弃写入，等下次扫描
清掉旧值后重新排队。
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
from collections.abc import Callable, Iterable
from typing import Any, Literal

from ._database_gallery_repository import GalleryRepository
from .gallery_safe_paths import SafeSourceRoot, UnsafeSourcePathError


logger = logging.getLogger(__name__)

HashOutcome = Literal["hashed", "skipped", "changed", "unavailable"]

_CHUNK_SIZE = 1024 * 1024


class GalleryHashingService:
    def __init__(
        self,
        repository: GalleryRepository,
        *,
        after_read: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self._repo = repository
        # 测试钩子：读完文件、写库之前调用，用来模拟并发修改。
        self._after_read = after_read
        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        self._pending: dict[str, None] = {}
        self._in_flight = 0
        self._stopping = False
        self._thread: threading.Thread | None = None
        self._hashed_total = 0
        self._listeners: list[Callable[[str, HashOutcome], None]] = []

    def add_listener(self, listener: Callable[[str, HashOutcome], None]) -> None:
        """每处理完一张（不论结果）在工作线程里调用 listener(asset_id, outcome)。"""
        self._listeners.append(listener)

    # ---- 队列 ----

    def enqueue(self, asset_ids: Iterable[str]) -> int:
        added = 0
        with self._lock:
            if self._stopping:
                return 0
            for asset_id in asset_ids:
                if asset_id not in self._pending:
                    self._pending[asset_id] = None
                    added += 1
            if added:
                self._ensure_worker()
                self._wake.notify_all()
        return added

    def pending_count(self) -> int:
        with self._lock:
            return len(self._pending) + self._in_flight

    def status(self) -> dict[str, int]:
        with self._lock:
            return {
                "pending": len(self._pending) + self._in_flight,
                "hashed_total": self._hashed_total,
            }

    def wait_idle(self, timeout: float = 10.0) -> bool:
        """等队列清空（测试与同步调用方使用）。"""
        with self._lock:
            return self._wake.wait_for(
                lambda: not self._pending and self._in_flight == 0, timeout=timeout
            )

    def stop(self, timeout: float = 10.0) -> None:
        with self._lock:
            self._stopping = True
            self._pending.clear()
            self._wake.notify_all()
            thread = self._thread
        if thread is not None:
            thread.join(timeout=timeout)

    def _ensure_worker(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._run, name="gallery-hashing", daemon=True
        )
        self._thread.start()

    def _run(self) -> None:
        while True:
            with self._lock:
                while not self._pending and not self._stopping:
                    self._wake.notify_all()
                    if not self._wake.wait(timeout=30.0) and not self._pending:
                        # 空闲太久就退出，下次入队再起线程。
                        self._thread = None
                        self._wake.notify_all()
                        return
                if self._stopping:
                    self._thread = None
                    self._wake.notify_all()
                    return
                asset_id = next(iter(self._pending))
                del self._pending[asset_id]
                self._in_flight += 1
            try:
                outcome = self.hash_asset(asset_id)
            except Exception:
                logger.exception("gallery hashing failed; asset_id=%s", asset_id)
                outcome = "unavailable"
            # 监听者在出队计数之前调用，wait_idle 返回时它们都已执行完。
            for listener in self._listeners:
                try:
                    listener(asset_id, outcome)
                except Exception:
                    logger.exception("gallery hashing listener failed; asset_id=%s", asset_id)
            with self._lock:
                self._in_flight -= 1
                if outcome == "hashed":
                    self._hashed_total += 1
                self._wake.notify_all()

    # ---- 单张 ----

    def hash_asset(self, asset_id: str) -> HashOutcome:
        asset = self._repo.get_asset(asset_id)
        if asset is None or asset["lifecycle_state"] != "active" or asset["content_sha256"]:
            return "skipped"
        source = self._repo.get_source(asset["source_id"])
        if source is None or source["availability"] != "available":
            return "unavailable"
        try:
            with SafeSourceRoot(source["root_path"]) as root:
                handle = root.open_binary(asset["relative_path"])
        except (UnsafeSourcePathError, OSError):
            return "unavailable"
        with handle:
            before = os.fstat(handle.fileno())
            if (
                before.st_size != int(asset["size_bytes"])
                or before.st_mtime_ns != int(asset["modified_ns"])
            ):
                return "changed"
            digest = hashlib.sha256()
            while chunk := handle.read(_CHUNK_SIZE):
                digest.update(chunk)
            if self._after_read is not None:
                self._after_read(asset)
            after = os.fstat(handle.fileno())
        if after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns:
            return "changed"
        written = self._repo.set_content_sha256(
            asset_id,
            digest.hexdigest(),
            size_bytes=before.st_size,
            modified_ns=before.st_mtime_ns,
        )
        return "hashed" if written else "changed"


__all__ = ["GalleryHashingService", "HashOutcome"]
