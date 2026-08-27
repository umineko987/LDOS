"""数据集导出仓储（G5）：任务/来源/条目/事件持久化与状态机守卫。

表结构见 `_database_schema.py` v9；状态机语义见 `dataset_export.py`。
所有跨请求可恢复状态只经由本仓储写 SQLite；引擎（staging/commit）通过
仓储的单一写入口推进状态，不由 API route 直接 UPDATE。
"""

from __future__ import annotations

import json
import time
from contextlib import contextmanager
from typing import Any, Callable, Iterator, Mapping, Sequence

from .dataset_export import can_transition_export_state

_EXPORT_EVENT_CAP = 500


class DatasetExportRepository:
    """SQLite 权威导出任务状态（§5.6）。"""

    def __init__(
        self,
        *,
        read: Callable[[], Iterator[Any]],
        transaction: Callable[[], Iterator[Any]],
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._read_ctx = read
        self._transaction_ctx = transaction
        self._clock = clock

    # ---- 内部连接助手 ----

    @contextmanager
    def _read(self) -> Iterator[Any]:
        with self._read_ctx() as conn:
            yield conn

    @contextmanager
    def _transaction(self) -> Iterator[Any]:
        with self._transaction_ctx() as conn:
            yield conn

    # ---- 任务生命周期 ----

    def create_job(
        self,
        *,
        target_path: str,
        idempotency_key: str | None,
        snapshot_digest: str,
    ) -> dict[str, Any]:
        """创建 draft 任务；幂等键冲突时返回既有任务。"""
        now = self._clock()
        job_id = f"exp-{int(now * 1000):013d}-{id(snapshot_digest) & 0xFFFFFFFF:08x}"
        with self._transaction() as conn:
            if idempotency_key:
                existing = conn.execute(
                    "SELECT * FROM dataset_export_jobs WHERE idempotency_key=?",
                    (idempotency_key,),
                ).fetchone()
                if existing is not None:
                    return self._project_job(existing)
            conn.execute(
                """
                INSERT INTO dataset_export_jobs(
                    id, idempotency_key, status, target_path,
                    sample_count, image_bytes, txt_bytes,
                    snapshot_digest, error_class,
                    created_at, updated_at, started_at, finished_at
                ) VALUES (?, ?, 'draft', ?, 0, 0, 0, ?, '', ?, ?, NULL, NULL)
                """,
                (job_id, idempotency_key, target_path, snapshot_digest, now, now),
            )
            row = conn.execute(
                "SELECT * FROM dataset_export_jobs WHERE id=?", (job_id,)
            ).fetchone()
            assert row is not None
            return self._project_job(row)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM dataset_export_jobs WHERE id=?", (job_id,)
            ).fetchone()
        return None if row is None else self._project_job(row)

    def list_jobs(
        self,
        *,
        status: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        conditions = []
        params: list[Any] = []
        if status:
            conditions.append("status=?")
            params.append(status)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        params.extend([max(1, min(limit, 200)), max(0, offset)])
        with self._read() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM dataset_export_jobs {where}
                ORDER BY created_at DESC LIMIT ? OFFSET ?
                """,
                params,
            ).fetchall()
        return [self._project_job(row) for row in rows]

    def update_job_status(
        self,
        job_id: str,
        target: str,
        *,
        error_class: str = "",
    ) -> dict[str, Any]:
        """按 §5.6 状态机推进任务状态；非法转移抛 ValueError。"""
        now = self._clock()
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT * FROM dataset_export_jobs WHERE id=?", (job_id,)
            ).fetchone()
            if row is None:
                raise ValueError("export_not_found")
            current = str(row["status"])
            if not can_transition_export_state(current, target):
                raise ValueError("export_state_invalid")
            started = row["started_at"]
            finished = row["finished_at"]
            if target == "staging" and started is None:
                started = now
            if target in {"completed", "discarded"}:
                finished = now
            conn.execute(
                """
                UPDATE dataset_export_jobs
                SET status=?, error_class=?, updated_at=?, started_at=?, finished_at=?
                WHERE id=?
                """,
                (target, error_class, now, started, finished, job_id),
            )
            self._append_event(conn, job_id, "status_change", {"to": target})
            updated = conn.execute(
                "SELECT * FROM dataset_export_jobs WHERE id=?", (job_id,)
            ).fetchone()
            assert updated is not None
            return self._project_job(updated)

    def set_job_progress(
        self,
        job_id: str,
        *,
        sample_count: int,
        image_bytes: int,
        txt_bytes: int,
    ) -> None:
        """staging 期间批量推进权威计数（引擎内部提交）。"""
        now = self._clock()
        with self._transaction() as conn:
            conn.execute(
                """
                UPDATE dataset_export_jobs
                SET sample_count=?, image_bytes=?, txt_bytes=?, updated_at=?
                WHERE id=?
                """,
                (sample_count, image_bytes, txt_bytes, now, job_id),
            )

    # ---- 来源快照 ----

    def add_source_snapshot(
        self,
        job_id: str,
        *,
        source_id: str,
        directory_id: str,
        include_descendants: bool,
        output_alias: str,
        content_version: int,
        annotation_version: int,
        indexed_version: int,
    ) -> None:
        now = self._clock()
        with self._transaction() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO dataset_export_sources(
                    job_id, source_id, directory_id, include_descendants,
                    output_alias, content_version, annotation_version,
                    indexed_version, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    source_id,
                    directory_id,
                    1 if include_descendants else 0,
                    output_alias,
                    content_version,
                    annotation_version,
                    indexed_version,
                    now,
                ),
            )

    def list_source_snapshots(self, job_id: str) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT * FROM dataset_export_sources
                WHERE job_id=? ORDER BY output_alias, directory_id
                """,
                (job_id,),
            ).fetchall()
        return [self._project_source(row) for row in rows]

    # ---- 冻结条目 ----

    def replace_items(
        self, job_id: str, items: Sequence[Mapping[str, Any]]
    ) -> None:
        """预检后整批替换冻结条目（draft/preflight 阶段专用）。"""
        now = self._clock()
        with self._transaction() as conn:
            conn.execute("DELETE FROM dataset_export_items WHERE job_id=?", (job_id,))
            for item in items:
                conn.execute(
                    """
                    INSERT INTO dataset_export_items(
                        job_id, asset_id, source_id,
                        output_relative_path, source_relative_path,
                        txt_output_relative_path, txt_source_relative_path,
                        has_txt, expected_content_version, expected_txt_version,
                        image_size_bytes, txt_size_bytes,
                        image_sha256, txt_sha256, copy_state, committed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)
                    """,
                    (
                        job_id,
                        item["asset_id"],
                        item["source_id"],
                        item["output_relative_path"],
                        item["source_relative_path"],
                        item.get("txt_output_relative_path", ""),
                        item.get("txt_source_relative_path", ""),
                        1 if item.get("has_txt") else 0,
                        item["expected_content_version"],
                        item["expected_txt_version"],
                        item.get("image_size_bytes", 0),
                        item.get("txt_size_bytes", 0),
                        item.get("image_sha256", ""),
                        item.get("txt_sha256", ""),
                    ),
                )
            conn.execute(
                """
                UPDATE dataset_export_jobs
                SET sample_count=?, image_bytes=?, txt_bytes=?, updated_at=?
                WHERE id=?
                """,
                (
                    len(items),
                    sum(int(i.get("image_size_bytes", 0)) for i in items),
                    sum(int(i.get("txt_size_bytes", 0)) for i in items),
                    now,
                    job_id,
                ),
            )

    def list_items(
        self, job_id: str, *, copy_state: str | None = None
    ) -> list[dict[str, Any]]:
        conditions = ["job_id=?"]
        params: list[Any] = [job_id]
        if copy_state:
            conditions.append("copy_state=?")
            params.append(copy_state)
        with self._read() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM dataset_export_items
                WHERE {' AND '.join(conditions)}
                ORDER BY output_relative_path
                """,
                params,
            ).fetchall()
        return [self._project_item(row) for row in rows]

    def set_item_copy_state(
        self,
        job_id: str,
        asset_id: str,
        copy_state: str,
        *,
        image_sha256: str | None = None,
        txt_sha256: str | None = None,
    ) -> None:
        now = self._clock()
        with self._transaction() as conn:
            assignments = ["copy_state=?"]
            params: list[Any] = [copy_state]
            if image_sha256 is not None:
                assignments.append("image_sha256=?")
                params.append(image_sha256)
            if txt_sha256 is not None:
                assignments.append("txt_sha256=?")
                params.append(txt_sha256)
            if copy_state == "committed":
                assignments.append("committed_at=?")
                params.append(now)
            params.extend([job_id, asset_id])
            conn.execute(
                f"""
                UPDATE dataset_export_items
                SET {', '.join(assignments)}
                WHERE job_id=? AND asset_id=?
                """,
                params,
            )

    # ---- 事件（有界） ----

    def list_events(self, job_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT * FROM dataset_export_events
                WHERE job_id=? ORDER BY id DESC LIMIT ?
                """,
                (job_id, max(1, min(limit, _EXPORT_EVENT_CAP))),
            ).fetchall()
        return [
            {
                "event_type": str(row["event_type"]),
                "ts": float(row["ts"]),
                "detail": json.loads(row["detail_json"] or "{}"),
            }
            for row in rows
        ]

    def append_event(
        self, job_id: str, event_type: str, detail: Mapping[str, Any]
    ) -> None:
        with self._transaction() as conn:
            self._append_event(conn, job_id, event_type, detail)

    def _append_event(
        self, conn: Any, job_id: str, event_type: str, detail: Mapping[str, Any]
    ) -> None:
        # 有界：每个任务最多保留 _EXPORT_EVENT_CAP 条，超出裁剪最旧事件。
        conn.execute(
            """
            INSERT INTO dataset_export_events(job_id, ts, event_type, detail_json)
            VALUES (?, ?, ?, ?)
            """,
            (job_id, self._clock(), event_type, json.dumps(dict(detail))),
        )
        conn.execute(
            """
            DELETE FROM dataset_export_events WHERE id IN (
                SELECT id FROM dataset_export_events WHERE job_id=?
                ORDER BY id DESC LIMIT -1 OFFSET ?
            )
            """,
            (job_id, _EXPORT_EVENT_CAP),
        )

    # ---- 投影 ----

    @staticmethod
    def _project_job(row: Any) -> dict[str, Any]:
        return {
            "job_id": row["id"],
            "status": row["status"],
            "target_path": row["target_path"],
            "sample_count": row["sample_count"],
            "image_bytes": row["image_bytes"],
            "txt_bytes": row["txt_bytes"],
            "snapshot_digest": row["snapshot_digest"],
            "error_class": row["error_class"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
        }

    @staticmethod
    def _project_source(row: Any) -> dict[str, Any]:
        return {
            "source_id": row["source_id"],
            "directory_id": row["directory_id"],
            "include_descendants": bool(row["include_descendants"]),
            "output_alias": row["output_alias"],
            "content_version": row["content_version"],
            "annotation_version": row["annotation_version"],
            "indexed_version": row["indexed_version"],
        }

    @staticmethod
    def _project_item(row: Any) -> dict[str, Any]:
        return {
            "asset_id": row["asset_id"],
            "source_id": row["source_id"],
            "output_relative_path": row["output_relative_path"],
            "source_relative_path": row["source_relative_path"],
            "txt_output_relative_path": row["txt_output_relative_path"],
            "txt_source_relative_path": row["txt_source_relative_path"],
            "has_txt": bool(row["has_txt"]),
            "expected_content_version": row["expected_content_version"],
            "expected_txt_version": row["expected_txt_version"],
            "image_size_bytes": row["image_size_bytes"],
            "txt_size_bytes": row["txt_size_bytes"],
            "image_sha256": row["image_sha256"],
            "txt_sha256": row["txt_sha256"],
            "copy_state": row["copy_state"],
            "committed_at": row["committed_at"],
        }
