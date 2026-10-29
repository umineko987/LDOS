"""caption 批次持久化（schema v16）。

`CaptionBatchRepository` 拥有 caption_batches / caption_batch_items 的全部读写。
一个批次是一次批量写入（打标结果写入、批量操作、单张编辑），条目记下每张图
写入前后的文本和磁盘版本，撤销时据此做乐观并发检查。
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Iterable, Mapping, Sequence

from ._database_repository import Clock, ReadFactory, TransactionFactory


CAPTION_BATCH_KINDS = frozenset({"from_tagger", "ops", "edit"})


def _loads(raw: str | None, default: Any) -> Any:
    try:
        value = json.loads(raw) if raw else default
    except json.JSONDecodeError:
        return default
    return value if isinstance(value, type(default)) else default


class CaptionBatchRepository:
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

    def create_batch(
        self,
        dataset_id: str,
        *,
        kind: str,
        params: Mapping[str, Any],
        stats: Mapping[str, Any],
        items: Iterable[Mapping[str, Any]],
        batch_id: str | None = None,
    ) -> dict[str, Any]:
        """一个事务里写批次和全部条目。

        条目字段：asset_id、before_text（None 表示写入前没有 caption 文件）、
        before_version、after_text（None 表示写入后仍没有文件）、after_version、
        tagger_tags（from_tagger 批次的打标标签列表，其余为 None）。
        """
        if kind not in CAPTION_BATCH_KINDS:
            raise ValueError("invalid_caption_batch_kind")
        batch_id = batch_id or str(uuid.uuid4())
        now = self._clock()
        rows = [
            (
                batch_id,
                str(item["asset_id"]),
                item.get("before_text"),
                str(item["before_version"]),
                item.get("after_text"),
                str(item["after_version"]),
                None if item.get("tagger_tags") is None else json.dumps(list(item["tagger_tags"])),
            )
            for item in items
        ]
        with self._transaction() as conn:
            conn.execute(
                """
                INSERT INTO caption_batches(id, dataset_id, kind, params_json, stats_json,
                                            created_at, undone_at, undo_stats_json)
                VALUES (?, ?, ?, ?, ?, ?, NULL, '{}')
                """,
                (batch_id, dataset_id, kind, json.dumps(dict(params)), json.dumps(dict(stats)), now),
            )
            conn.executemany(
                """
                INSERT INTO caption_batch_items(batch_id, asset_id, before_text, before_version,
                                                after_text, after_version, tagger_tags_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        batch = self.get_batch(batch_id)
        assert batch is not None
        return batch

    def get_batch(self, batch_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                f"SELECT {self._BATCH_COLUMNS} FROM caption_batches AS b WHERE b.id=?",
                (batch_id,),
            ).fetchone()
        return None if row is None else self._project_batch(row)

    def list_batches(self, dataset_id: str, *, limit: int = 50) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                f"""
                SELECT {self._BATCH_COLUMNS} FROM caption_batches AS b
                WHERE b.dataset_id=?
                ORDER BY b.created_at DESC, b.rowid DESC LIMIT ?
                """,
                (dataset_id, max(1, min(int(limit), 500))),
            ).fetchall()
        return [self._project_batch(row) for row in rows]

    def batch_items(self, batch_id: str) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                "SELECT * FROM caption_batch_items WHERE batch_id=? ORDER BY rowid",
                (batch_id,),
            ).fetchall()
        return [
            {
                "asset_id": row["asset_id"],
                "before_text": row["before_text"],
                "before_version": row["before_version"],
                "after_text": row["after_text"],
                "after_version": row["after_version"],
                "tagger_tags": (
                    None if row["tagger_tags_json"] is None else _loads(row["tagger_tags_json"], [])
                ),
            }
            for row in rows
        ]

    def mark_undone(self, batch_id: str, undo_stats: Mapping[str, Any]) -> bool:
        """只有尚未撤销的批次才会被标记；返回是否由这次调用标记。"""
        with self._transaction() as conn:
            cursor = conn.execute(
                """
                UPDATE caption_batches SET undone_at=?, undo_stats_json=?
                WHERE id=? AND undone_at IS NULL
                """,
                (self._clock(), json.dumps(dict(undo_stats)), batch_id),
            )
        return cursor.rowcount == 1

    def latest_tagger_tags(
        self, dataset_id: str, asset_ids: Sequence[str] | None = None
    ) -> dict[str, list[str]]:
        """每张图最近一次（未撤销的）打标写入记下的打标标签。merge 模式据此识别手改。"""
        wanted = None if asset_ids is None else set(asset_ids)
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT i.asset_id, i.tagger_tags_json
                FROM caption_batch_items AS i
                JOIN caption_batches AS b ON b.id = i.batch_id
                WHERE b.dataset_id=? AND b.kind='from_tagger' AND b.undone_at IS NULL
                  AND i.tagger_tags_json IS NOT NULL
                ORDER BY b.created_at, b.rowid
                """,
                (dataset_id,),
            ).fetchall()
        latest: dict[str, list[str]] = {}
        for row in rows:
            asset_id = str(row["asset_id"])
            if wanted is None or asset_id in wanted:
                latest[asset_id] = [str(tag) for tag in _loads(row["tagger_tags_json"], [])]
        return latest

    _BATCH_COLUMNS = (
        "b.id, b.dataset_id, b.kind, b.params_json, b.stats_json, b.created_at, "
        "b.undone_at, b.undo_stats_json, "
        "(SELECT COUNT(*) FROM caption_batch_items AS i WHERE i.batch_id = b.id "
        " AND i.before_version != i.after_version) AS changed_count"
    )

    @staticmethod
    def _project_batch(row: Any) -> dict[str, Any]:
        return {
            "batch_id": row["id"],
            "dataset_id": row["dataset_id"],
            "kind": row["kind"],
            "params": _loads(row["params_json"], {}),
            "stats": _loads(row["stats_json"], {}),
            "changed_count": int(row["changed_count"]),
            "created_at": row["created_at"],
            "undone_at": row["undone_at"],
            "undo_stats": _loads(row["undo_stats_json"], {}),
        }


__all__ = [
    "CAPTION_BATCH_KINDS",
    "CaptionBatchRepository",
]
