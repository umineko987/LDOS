"""caption 批次持久化（schema v16）。

`CaptionBatchRepository` 拥有 caption_batches / caption_batch_items 的全部读写。
一个批次是一次批量写入（打标结果写入、批量操作、单张编辑），条目记下每张图
写入前后的文本和磁盘版本，撤销时据此做乐观并发检查。

写入是日志式的：`begin_batch` 先把整批意图记成 planned 条目（批次 state=writing），
每张落盘后 `mark_written` 补上写后版本，最后 `finish_batch` 收尾。进程中途被杀时，
启动恢复按磁盘上的文本认领或丢弃 planned 条目，已写的图仍可撤销。
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
        rows = [self._item_row(batch_id, item, "written") for item in items]
        with self._transaction() as conn:
            conn.execute(
                """
                INSERT INTO caption_batches(id, dataset_id, kind, params_json, stats_json,
                                            created_at, undone_at, undo_stats_json)
                VALUES (?, ?, ?, ?, ?, ?, NULL, '{}')
                """,
                (batch_id, dataset_id, kind, json.dumps(dict(params)), json.dumps(dict(stats)), now),
            )
            conn.executemany(self._INSERT_ITEM, rows)
        batch = self.get_batch(batch_id)
        assert batch is not None
        return batch

    @staticmethod
    def _item_row(batch_id: str, item: Mapping[str, Any], write_state: str) -> tuple[Any, ...]:
        return (
            batch_id,
            str(item["asset_id"]),
            item.get("before_text"),
            str(item["before_version"]),
            item.get("after_text"),
            str(item.get("after_version") or ""),
            None if item.get("tagger_tags") is None else json.dumps(list(item["tagger_tags"])),
            write_state,
        )

    _INSERT_ITEM = """
        INSERT INTO caption_batch_items(batch_id, asset_id, before_text, before_version,
                                        after_text, after_version, tagger_tags_json,
                                        write_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """

    def begin_batch(
        self,
        dataset_id: str,
        *,
        kind: str,
        params: Mapping[str, Any],
        stats: Mapping[str, Any],
        planned: Iterable[Mapping[str, Any]],
        baseline: Iterable[Mapping[str, Any]] = (),
        batch_id: str,
    ) -> None:
        """写文件之前：批次记成 writing，每张要写的图记成 planned（after_version 待补）。

        baseline 是不改文件、只记打标基线的图，直接记成 written。
        """
        if kind not in CAPTION_BATCH_KINDS:
            raise ValueError("invalid_caption_batch_kind")
        rows = [self._item_row(batch_id, item, "planned") for item in planned]
        rows += [self._item_row(batch_id, item, "written") for item in baseline]
        with self._transaction() as conn:
            conn.execute(
                """
                INSERT INTO caption_batches(id, dataset_id, kind, params_json, stats_json,
                                            created_at, undone_at, undo_stats_json, state)
                VALUES (?, ?, ?, ?, ?, ?, NULL, '{}', 'writing')
                """,
                (batch_id, dataset_id, kind, json.dumps(dict(params)), json.dumps(dict(stats)), self._clock()),
            )
            conn.executemany(self._INSERT_ITEM, rows)

    def mark_written(self, batch_id: str, asset_id: str, after_version: str) -> None:
        with self._transaction() as conn:
            conn.execute(
                """
                UPDATE caption_batch_items SET write_state='written', after_version=?
                WHERE batch_id=? AND asset_id=? AND write_state='planned'
                """,
                (str(after_version), batch_id, asset_id),
            )

    def drop_planned(self, batch_id: str, asset_id: str) -> None:
        with self._transaction() as conn:
            conn.execute(
                "DELETE FROM caption_batch_items WHERE batch_id=? AND asset_id=? AND write_state='planned'",
                (batch_id, asset_id),
            )

    def planned_items(self, batch_id: str) -> list[dict[str, Any]]:
        return [item for item in self.batch_items(batch_id) if item["write_state"] == "planned"]

    def finish_batch(self, batch_id: str, *, stats: Mapping[str, Any]) -> None:
        """收尾：写最终统计，state 改成 complete。"""
        with self._transaction() as conn:
            conn.execute(
                "UPDATE caption_batches SET stats_json=?, state='complete' WHERE id=?",
                (json.dumps(dict(stats)), batch_id),
            )

    def delete_batch(self, batch_id: str) -> None:
        with self._transaction() as conn:
            conn.execute("DELETE FROM caption_batch_items WHERE batch_id=?", (batch_id,))
            conn.execute("DELETE FROM caption_batches WHERE id=?", (batch_id,))

    def writing_batches(self) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                f"SELECT {self._BATCH_COLUMNS} FROM caption_batches AS b WHERE b.state='writing' ORDER BY b.created_at, b.rowid"
            ).fetchall()
        return [self._project_batch(row) for row in rows]

    def mark_item_restored(self, batch_id: str, asset_id: str) -> None:
        with self._transaction() as conn:
            conn.execute(
                "UPDATE caption_batch_items SET undo_state='restored' WHERE batch_id=? AND asset_id=?",
                (batch_id, asset_id),
            )

    def record_undo_attempt(self, batch_id: str, undo_stats: Mapping[str, Any]) -> None:
        """撤销没做完（有暂时失败）：记下这次的统计，批次保持可撤销。"""
        with self._transaction() as conn:
            conn.execute(
                "UPDATE caption_batches SET undo_stats_json=? WHERE id=? AND undone_at IS NULL",
                (json.dumps(dict(undo_stats)), batch_id),
            )

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
                "write_state": row["write_state"],
                "undo_state": row["undo_state"],
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
        """每张图最近一次（未撤销、已落盘的）打标写入记下的打标标签。merge 模式据此识别手改。"""
        wanted = None if asset_ids is None else set(asset_ids)
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT i.asset_id, i.tagger_tags_json
                FROM caption_batch_items AS i
                JOIN caption_batches AS b ON b.id = i.batch_id
                WHERE b.dataset_id=? AND b.kind='from_tagger' AND b.undone_at IS NULL
                  AND i.tagger_tags_json IS NOT NULL
                  AND i.write_state='written' AND i.undo_state IS NULL
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
        "b.undone_at, b.undo_stats_json, b.state, "
        "(SELECT COUNT(*) FROM caption_batch_items AS i WHERE i.batch_id = b.id "
        " AND i.write_state = 'written' AND i.before_version != i.after_version) AS changed_count, "
        "(SELECT COUNT(*) FROM caption_batch_items AS i WHERE i.batch_id = b.id "
        " AND i.write_state = 'written' AND i.before_version != i.after_version"
        " AND i.undo_state IS NULL) AS undoable_count"
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
            "state": row["state"],
            "undoable_count": int(row["undoable_count"]),
        }


__all__ = [
    "CAPTION_BATCH_KINDS",
    "CaptionBatchRepository",
]
