"""数据集持久化（schema v15）。

`DatasetRepository` 拥有 datasets / dataset_roots / dataset_crawls /
dataset_decisions / dataset_stage_runs 的全部读写。成员不落表：
它是「根目录下的活跃图片」实时推导出来的，见 `member_predicate`。
"""

from __future__ import annotations

import base64
import json
import uuid
from typing import Any, Iterable, Mapping, Sequence

from ._database_repository import Clock, ReadFactory, TransactionFactory


DATASET_STAGES: tuple[str, ...] = ("collect", "clean", "dedup", "tag", "review", "export")
DATASET_KINDS = frozenset({"character", "style", "concept"})
DATASET_ROOT_ORIGINS = frozenset({"import", "library", "crawl"})
DATASET_DECISIONS = frozenset({"exclude", "approve"})
DATASET_STAGE_RUN_STATUSES = frozenset({"running", "succeeded", "failed", "cancelled"})
DATASET_CRAWL_STATES = frozenset({"pending", "attached", "failed"})

MEMBER_PAGE_DEFAULT_LIMIT = 100
MEMBER_PAGE_MAX_LIMIT = 500

# 与 gallery_review_selection.EXCLUDED_REVIEW_DIRECTORIES 一致：这些目录里的
# 图不会进入清洗/去重审核，所以也不算数据集成员。
_EXCLUDED_PATH_PARTS = (".ldos", "duplicates", "keep", "trashed", "trash")

_MEMBER_COLUMNS = (
    "a.id, a.source_id, a.directory_id, a.relative_path, a.name, a.extension, "
    "a.sort_key, a.size_bytes, a.modified_ns, a.content_sha256, a.content_version, "
    "a.format, a.width, a.height, a.txt_relative_path, a.txt_size_bytes, "
    "a.txt_modified_ns, a.txt_version, a.txt_state, a.dedup_visibility, "
    "a.lifecycle_state"
)


class DatasetNotFound(Exception):
    def __init__(self, dataset_id: str) -> None:
        super().__init__(f"dataset_not_found:{dataset_id}")
        self.dataset_id = dataset_id


class DatasetCursorError(ValueError):
    """成员分页游标格式或取值非法。"""


def _path_filter_sql() -> str:
    wrapped = "('/' || lower(a.relative_path) || '/')"
    clauses = [f"{wrapped} NOT LIKE '%/{part}/%'" for part in _EXCLUDED_PATH_PARTS]
    clauses.append("('/' || lower(a.relative_path)) NOT LIKE '%/.ldos-%'")
    return " AND ".join(clauses)


def member_predicate() -> str:
    """一个数据集（参数 :dataset_id）的成员全集谓词，别名 a = gallery_assets。

    - 在某个根目录下：根是来源根（relative_path=''）或路径前缀加 '/' 边界，
      所以 `a/b` 不会匹配 `a/bc`；
    - 活跃且没被去重排除；或者虽然已移入回收区/被排除，但本数据集对它
      记过「排除」决定（这样漏斗里还能看到它在哪一段被排除）。
    """
    return f"""
        EXISTS (
            SELECT 1 FROM dataset_roots AS r
            WHERE r.dataset_id = :dataset_id AND r.source_id = a.source_id
              AND (r.relative_path = ''
                   OR substr(a.relative_path, 1, length(r.relative_path) + 1)
                      = r.relative_path || '/')
        )
        AND {_path_filter_sql()}
        AND (
            (a.lifecycle_state = 'active' AND a.dedup_visibility != 'excluded')
            OR (a.lifecycle_state IN ('active', 'trashed') AND EXISTS (
                SELECT 1 FROM dataset_decisions AS d
                WHERE d.dataset_id = :dataset_id AND d.asset_id = a.id
                  AND d.decision = 'exclude'
            ))
        )
    """


def _encode_cursor(payload: Mapping[str, Any]) -> str:
    raw = json.dumps({"kind": "dataset-member", **payload}, ensure_ascii=True, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> dict[str, Any]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise DatasetCursorError("invalid_dataset_cursor") from exc
    if not isinstance(decoded, dict) or decoded.get("kind") != "dataset-member":
        raise DatasetCursorError("invalid_dataset_cursor")
    for key in ("sort_key", "name", "id"):
        if not isinstance(decoded.get(key), str):
            raise DatasetCursorError("invalid_dataset_cursor")
    return decoded


def _like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class DatasetRepository:
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

    # ---- 数据集 ----

    def create_dataset(
        self,
        *,
        name: str,
        kind: str,
        trigger_word: str = "",
        config: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        if kind not in DATASET_KINDS:
            raise ValueError("invalid_dataset_kind")
        dataset_id = str(uuid.uuid4())
        now = self._clock()
        with self._transaction() as conn:
            conn.execute(
                """
                INSERT INTO datasets(id, name, kind, trigger_word, config_json,
                                     cover_asset_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
                """,
                (dataset_id, name, kind, trigger_word, json.dumps(dict(config or {})), now, now),
            )
        dataset = self.get_dataset(dataset_id)
        assert dataset is not None
        return dataset

    def get_dataset(self, dataset_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute("SELECT * FROM datasets WHERE id=?", (dataset_id,)).fetchone()
        return None if row is None else self._project_dataset(row)

    def require_dataset(self, dataset_id: str) -> dict[str, Any]:
        dataset = self.get_dataset(dataset_id)
        if dataset is None:
            raise DatasetNotFound(dataset_id)
        return dataset

    def list_datasets(self) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                "SELECT * FROM datasets ORDER BY updated_at DESC, id"
            ).fetchall()
        return [self._project_dataset(row) for row in rows]

    def update_dataset(self, dataset_id: str, changes: Mapping[str, Any]) -> dict[str, Any]:
        allowed = {"name", "kind", "trigger_word", "config", "cover_asset_id"}
        unknown = set(changes) - allowed
        if unknown:
            raise ValueError(f"invalid_dataset_fields:{','.join(sorted(unknown))}")
        if "kind" in changes and changes["kind"] not in DATASET_KINDS:
            raise ValueError("invalid_dataset_kind")
        assignments: list[str] = []
        params: list[Any] = []
        for key, value in changes.items():
            if key == "config":
                assignments.append("config_json=?")
                params.append(json.dumps(dict(value or {})))
            else:
                assignments.append(f"{key}=?")
                params.append(value)
        with self._transaction() as conn:
            row = conn.execute("SELECT id FROM datasets WHERE id=?", (dataset_id,)).fetchone()
            if row is None:
                raise DatasetNotFound(dataset_id)
            assignments.append("updated_at=?")
            params.append(self._clock())
            conn.execute(
                f"UPDATE datasets SET {', '.join(assignments)} WHERE id=?",
                (*params, dataset_id),
            )
        return self.require_dataset(dataset_id)

    def touch_dataset(self, conn: Any, dataset_id: str) -> None:
        conn.execute("UPDATE datasets SET updated_at=? WHERE id=?", (self._clock(), dataset_id))

    def delete_dataset(self, dataset_id: str) -> bool:
        with self._transaction() as conn:
            cursor = conn.execute("DELETE FROM datasets WHERE id=?", (dataset_id,))
            return cursor.rowcount == 1

    @staticmethod
    def _project_dataset(row: Any) -> dict[str, Any]:
        try:
            config = json.loads(row["config_json"] or "{}")
        except json.JSONDecodeError:
            config = {}
        return {
            "dataset_id": row["id"],
            "name": row["name"],
            "kind": row["kind"],
            "trigger_word": row["trigger_word"],
            "config": config if isinstance(config, dict) else {},
            "cover_asset_id": row["cover_asset_id"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    # ---- 根目录 ----

    def add_root(
        self,
        dataset_id: str,
        *,
        source_id: str,
        relative_path: str,
        directory_id: str,
        origin: str,
    ) -> tuple[dict[str, Any], bool]:
        """挂一个根目录。同一来源同一路径已挂过时返回已有的那条（created=False）。"""
        if origin not in DATASET_ROOT_ORIGINS:
            raise ValueError("invalid_dataset_root_origin")
        now = self._clock()
        with self._transaction() as conn:
            if conn.execute("SELECT 1 FROM datasets WHERE id=?", (dataset_id,)).fetchone() is None:
                raise DatasetNotFound(dataset_id)
            existing = conn.execute(
                "SELECT id FROM dataset_roots WHERE dataset_id=? AND source_id=? AND relative_path=?",
                (dataset_id, source_id, relative_path),
            ).fetchone()
            if existing is not None:
                root_id, created = str(existing["id"]), False
            else:
                root_id, created = str(uuid.uuid4()), True
                conn.execute(
                    """
                    INSERT INTO dataset_roots(id, dataset_id, source_id, directory_id,
                                              relative_path, origin, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (root_id, dataset_id, source_id, directory_id, relative_path, origin, now),
                )
                self.touch_dataset(conn, dataset_id)
        root = self.get_root(dataset_id, root_id)
        assert root is not None
        return root, created

    def get_root(self, dataset_id: str, root_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                self._root_select() + " WHERE r.dataset_id=? AND r.id=?",
                (dataset_id, root_id),
            ).fetchone()
        return None if row is None else self._project_root(row)

    def list_roots(self, dataset_id: str) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                self._root_select() + " WHERE r.dataset_id=? ORDER BY r.created_at, r.id",
                (dataset_id,),
            ).fetchall()
        return [self._project_root(row) for row in rows]

    def delete_root(self, dataset_id: str, root_id: str) -> bool:
        with self._transaction() as conn:
            cursor = conn.execute(
                "DELETE FROM dataset_roots WHERE dataset_id=? AND id=?", (dataset_id, root_id)
            )
            if cursor.rowcount == 1:
                self.touch_dataset(conn, dataset_id)
            return cursor.rowcount == 1

    def dataset_ids_for_source(self, source_id: str) -> list[str]:
        with self._read() as conn:
            rows = conn.execute(
                "SELECT DISTINCT dataset_id FROM dataset_roots WHERE source_id=?", (source_id,)
            ).fetchall()
        return [str(row["dataset_id"]) for row in rows]

    @staticmethod
    def _root_select() -> str:
        return """
            SELECT r.*, s.display_name AS source_display_name,
                   s.availability AS source_availability, s.kind AS source_kind,
                   d.name AS directory_name, d.recursive_asset_count AS recursive_asset_count
            FROM dataset_roots AS r
            JOIN gallery_sources AS s ON s.id = r.source_id
            LEFT JOIN gallery_directories AS d
              ON d.id = r.directory_id AND d.lifecycle_state = 'active'
        """

    @staticmethod
    def _project_root(row: Any) -> dict[str, Any]:
        relative_path = str(row["relative_path"])
        return {
            "root_id": row["id"],
            "dataset_id": row["dataset_id"],
            "source_id": row["source_id"],
            "directory_id": row["directory_id"],
            "relative_path": relative_path,
            "origin": row["origin"],
            "name": row["directory_name"] or relative_path.rpartition("/")[2] or row["source_display_name"],
            "source_display_name": row["source_display_name"],
            "source_kind": row["source_kind"],
            "available": row["source_availability"] == "available" and row["directory_name"] is not None,
            "recursive_asset_count": int(row["recursive_asset_count"] or 0),
            "created_at": row["created_at"],
        }

    # ---- 在线采集 ----

    def add_crawl(self, dataset_id: str, batch_id: str) -> None:
        now = self._clock()
        with self._transaction() as conn:
            conn.execute(
                """
                INSERT INTO dataset_crawls(dataset_id, batch_id, state, created_at, updated_at)
                VALUES (?, ?, 'pending', ?, ?)
                ON CONFLICT(dataset_id, batch_id) DO NOTHING
                """,
                (dataset_id, batch_id, now, now),
            )

    def list_crawls(self, dataset_id: str) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT c.*, b.status AS batch_status FROM dataset_crawls AS c
                LEFT JOIN crawl_batches AS b ON b.id = c.batch_id
                WHERE c.dataset_id=? ORDER BY c.created_at DESC, c.batch_id
                """,
                (dataset_id,),
            ).fetchall()
        return [self._project_crawl(row) for row in rows]

    def pending_crawls(self, batch_id: str | None = None) -> list[dict[str, Any]]:
        query = """
            SELECT c.*, b.status AS batch_status FROM dataset_crawls AS c
            LEFT JOIN crawl_batches AS b ON b.id = c.batch_id
            WHERE c.state='pending'
        """
        params: tuple[Any, ...] = ()
        if batch_id is not None:
            query += " AND c.batch_id=?"
            params = (batch_id,)
        with self._read() as conn:
            rows = conn.execute(query + " ORDER BY c.created_at", params).fetchall()
        return [self._project_crawl(row) for row in rows]

    def mark_crawl(
        self,
        dataset_id: str,
        batch_id: str,
        *,
        state: str,
        root_id: str | None = None,
        error_code: str = "",
    ) -> None:
        if state not in DATASET_CRAWL_STATES:
            raise ValueError("invalid_dataset_crawl_state")
        with self._transaction() as conn:
            conn.execute(
                """
                UPDATE dataset_crawls SET state=?, root_id=?, error_code=?, updated_at=?
                WHERE dataset_id=? AND batch_id=?
                """,
                (state, root_id, error_code, self._clock(), dataset_id, batch_id),
            )

    @staticmethod
    def _project_crawl(row: Any) -> dict[str, Any]:
        return {
            "dataset_id": row["dataset_id"],
            "batch_id": row["batch_id"],
            "state": row["state"],
            "root_id": row["root_id"],
            "error_code": row["error_code"],
            "batch_status": row["batch_status"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    # ---- 决定 ----

    def set_decisions(
        self,
        dataset_id: str,
        stage: str,
        asset_ids: Sequence[str],
        decision: str,
        *,
        reason: str = "",
    ) -> int:
        """给一批图在某一阶段记「排除」或「通过」。同一阶段只保留最新一条。"""
        if stage not in DATASET_STAGES:
            raise ValueError("invalid_dataset_stage")
        if decision not in DATASET_DECISIONS:
            raise ValueError("invalid_dataset_decision")
        now = self._clock()
        with self._transaction() as conn:
            if conn.execute("SELECT 1 FROM datasets WHERE id=?", (dataset_id,)).fetchone() is None:
                raise DatasetNotFound(dataset_id)
            for asset_id in dict.fromkeys(asset_ids):
                conn.execute(
                    """
                    INSERT INTO dataset_decisions(dataset_id, stage, asset_id, decision,
                                                  reason, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(dataset_id, stage, asset_id) DO UPDATE SET
                        decision=excluded.decision, reason=excluded.reason,
                        updated_at=excluded.updated_at
                    """,
                    (dataset_id, stage, asset_id, decision, reason, now, now),
                )
            self.touch_dataset(conn, dataset_id)
        return len(dict.fromkeys(asset_ids))

    def clear_decisions(self, dataset_id: str, stage: str, asset_ids: Sequence[str]) -> int:
        if stage not in DATASET_STAGES:
            raise ValueError("invalid_dataset_stage")
        removed = 0
        with self._transaction() as conn:
            if conn.execute("SELECT 1 FROM datasets WHERE id=?", (dataset_id,)).fetchone() is None:
                raise DatasetNotFound(dataset_id)
            for asset_id in dict.fromkeys(asset_ids):
                removed += conn.execute(
                    "DELETE FROM dataset_decisions WHERE dataset_id=? AND stage=? AND asset_id=?",
                    (dataset_id, stage, asset_id),
                ).rowcount
            self.touch_dataset(conn, dataset_id)
        return removed

    def list_decisions(
        self, dataset_id: str, asset_ids: Iterable[str] | None = None
    ) -> list[dict[str, Any]]:
        query = "SELECT * FROM dataset_decisions WHERE dataset_id=?"
        params: list[Any] = [dataset_id]
        if asset_ids is not None:
            ids = list(dict.fromkeys(asset_ids))
            if not ids:
                return []
            query += f" AND asset_id IN ({','.join('?' for _ in ids)})"
            params.extend(ids)
        with self._read() as conn:
            rows = conn.execute(query, params).fetchall()
        return [
            {
                "stage": row["stage"],
                "asset_id": row["asset_id"],
                "decision": row["decision"],
                "reason": row["reason"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    # ---- 成员 ----

    def member_rows(self, dataset_id: str) -> list[dict[str, Any]]:
        """成员全集（未按阶段过滤），按自然排序。"""
        with self._read() as conn:
            rows = conn.execute(
                f"""
                SELECT {_MEMBER_COLUMNS} FROM gallery_assets AS a
                WHERE {member_predicate()}
                ORDER BY a.sort_key, a.name, a.id
                """,
                {"dataset_id": dataset_id},
            ).fetchall()
        return [self._project_member(row) for row in rows]

    def page_members(
        self,
        dataset_id: str,
        *,
        excluded_before: Sequence[str] = (),
        stage: str | None = None,
        decision: str | None = None,
        query: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """成员分页。

        excluded_before：在这些阶段被排除的图不算本阶段输入；
        decision：相对 stage 的过滤（excluded / approved / undecided）。
        """
        page_limit = max(1, min(int(limit or MEMBER_PAGE_DEFAULT_LIMIT), MEMBER_PAGE_MAX_LIMIT))
        params: dict[str, Any] = {"dataset_id": dataset_id}
        restrictions = [member_predicate()]
        if excluded_before:
            names = []
            for index, earlier in enumerate(excluded_before):
                key = f"earlier_{index}"
                params[key] = earlier
                names.append(f":{key}")
            restrictions.append(
                f"""NOT EXISTS (
                    SELECT 1 FROM dataset_decisions AS e
                    WHERE e.dataset_id = :dataset_id AND e.asset_id = a.id
                      AND e.decision = 'exclude' AND e.stage IN ({', '.join(names)})
                )"""
            )
        if decision is not None:
            if stage is None:
                raise ValueError("dataset_decision_filter_requires_stage")
            params["stage"] = stage
            if decision in DATASET_DECISIONS:
                params["decision"] = decision
                restrictions.append(
                    """EXISTS (
                        SELECT 1 FROM dataset_decisions AS f
                        WHERE f.dataset_id = :dataset_id AND f.asset_id = a.id
                          AND f.stage = :stage AND f.decision = :decision
                    )"""
                )
            elif decision == "undecided":
                restrictions.append(
                    """NOT EXISTS (
                        SELECT 1 FROM dataset_decisions AS f
                        WHERE f.dataset_id = :dataset_id AND f.asset_id = a.id
                          AND f.stage = :stage
                    )"""
                )
            else:
                raise ValueError("invalid_dataset_decision_filter")
        if query:
            params["query"] = f"%{_like_escape(query.lower())}%"
            restrictions.append("lower(a.relative_path) LIKE :query ESCAPE '\\'")
        base_predicate = " AND ".join(f"({item})" for item in restrictions)
        page_predicate = base_predicate
        if cursor is not None:
            decoded = _decode_cursor(cursor)
            params.update(
                cursor_sort_key=decoded["sort_key"],
                cursor_name=decoded["name"],
                cursor_id=decoded["id"],
            )
            page_predicate += " AND (a.sort_key, a.name, a.id) > (:cursor_sort_key, :cursor_name, :cursor_id)"
        params["limit"] = page_limit + 1
        with self._read() as conn:
            rows = conn.execute(
                f"""
                SELECT {_MEMBER_COLUMNS} FROM gallery_assets AS a
                WHERE {page_predicate}
                ORDER BY a.sort_key, a.name, a.id LIMIT :limit
                """,
                params,
            ).fetchall()
            total = conn.execute(
                f"SELECT COUNT(*) FROM gallery_assets AS a WHERE {base_predicate}",
                {key: value for key, value in params.items()
                 if not key.startswith("cursor_") and key != "limit"},
            ).fetchone()[0]
        has_more = len(rows) > page_limit
        rows = rows[:page_limit]
        next_cursor = None
        if has_more and rows:
            last = rows[-1]
            next_cursor = _encode_cursor(
                {"sort_key": last["sort_key"], "name": last["name"], "id": last["id"]}
            )
        return {
            "items": [self._project_member(row) for row in rows],
            "next_cursor": next_cursor,
            "total": int(total),
            "limit": page_limit,
        }

    @staticmethod
    def _project_member(row: Any) -> dict[str, Any]:
        return {
            "asset_id": row["id"],
            "source_id": row["source_id"],
            "directory_id": row["directory_id"],
            "relative_path": row["relative_path"],
            "name": row["name"],
            "extension": row["extension"],
            "sort_key": row["sort_key"],
            "size_bytes": int(row["size_bytes"]),
            "modified_ns": int(row["modified_ns"]),
            "content_sha256": row["content_sha256"],
            "content_version": int(row["content_version"]),
            "format": row["format"],
            "width": int(row["width"]),
            "height": int(row["height"]),
            "txt_relative_path": row["txt_relative_path"],
            "txt_size_bytes": int(row["txt_size_bytes"]),
            "txt_modified_ns": int(row["txt_modified_ns"]),
            "txt_version": int(row["txt_version"]),
            "txt_state": row["txt_state"],
            "dedup_visibility": row["dedup_visibility"],
            "lifecycle_state": row["lifecycle_state"],
        }

    # ---- 阶段运行 ----

    def create_stage_run(
        self,
        dataset_id: str,
        stage: str,
        *,
        input_digest: str,
        ref_id: str = "",
        status: str = "running",
        stats: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        if stage not in DATASET_STAGES:
            raise ValueError("invalid_dataset_stage")
        if status not in DATASET_STAGE_RUN_STATUSES:
            raise ValueError("invalid_dataset_stage_run_status")
        run_id = str(uuid.uuid4())
        now = self._clock()
        with self._transaction() as conn:
            if conn.execute("SELECT 1 FROM datasets WHERE id=?", (dataset_id,)).fetchone() is None:
                raise DatasetNotFound(dataset_id)
            conn.execute(
                """
                INSERT INTO dataset_stage_runs(id, dataset_id, stage, status, ref_id,
                    input_digest, stats_json, error_code, created_at, updated_at, finished_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
                """,
                (
                    run_id, dataset_id, stage, status, ref_id, input_digest,
                    json.dumps(dict(stats or {})), now, now,
                    None if status == "running" else now,
                ),
            )
            self.touch_dataset(conn, dataset_id)
        run = self.get_stage_run(run_id)
        assert run is not None
        return run

    def update_stage_run(
        self,
        run_id: str,
        *,
        status: str | None = None,
        ref_id: str | None = None,
        stats: Mapping[str, Any] | None = None,
        error_code: str | None = None,
    ) -> dict[str, Any] | None:
        if status is not None and status not in DATASET_STAGE_RUN_STATUSES:
            raise ValueError("invalid_dataset_stage_run_status")
        now = self._clock()
        assignments = ["updated_at=?"]
        params: list[Any] = [now]
        if status is not None:
            assignments.append("status=?")
            params.append(status)
            assignments.append("finished_at=?")
            params.append(None if status == "running" else now)
        if ref_id is not None:
            assignments.append("ref_id=?")
            params.append(ref_id)
        if stats is not None:
            assignments.append("stats_json=?")
            params.append(json.dumps(dict(stats)))
        if error_code is not None:
            assignments.append("error_code=?")
            params.append(error_code)
        with self._transaction() as conn:
            conn.execute(
                f"UPDATE dataset_stage_runs SET {', '.join(assignments)} WHERE id=?",
                (*params, run_id),
            )
        return self.get_stage_run(run_id)

    def get_stage_run(self, run_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute("SELECT * FROM dataset_stage_runs WHERE id=?", (run_id,)).fetchone()
        return None if row is None else self._project_stage_run(row)

    def list_stage_runs(
        self, dataset_id: str, *, stage: str | None = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        query = "SELECT * FROM dataset_stage_runs WHERE dataset_id=?"
        params: list[Any] = [dataset_id]
        if stage is not None:
            query += " AND stage=?"
            params.append(stage)
        query += " ORDER BY created_at DESC, id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 500)))
        with self._read() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._project_stage_run(row) for row in rows]

    def latest_stage_runs(self, dataset_id: str) -> dict[str, dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                """
                SELECT * FROM dataset_stage_runs AS run
                WHERE run.dataset_id=? AND run.rowid = (
                    SELECT latest.rowid FROM dataset_stage_runs AS latest
                    WHERE latest.dataset_id = run.dataset_id AND latest.stage = run.stage
                    ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
                )
                """,
                (dataset_id,),
            ).fetchall()
        return {str(row["stage"]): self._project_stage_run(row) for row in rows}

    @staticmethod
    def _project_stage_run(row: Any) -> dict[str, Any]:
        try:
            stats = json.loads(row["stats_json"] or "{}")
        except json.JSONDecodeError:
            stats = {}
        return {
            "run_id": row["id"],
            "dataset_id": row["dataset_id"],
            "stage": row["stage"],
            "status": row["status"],
            "ref_id": row["ref_id"],
            "input_digest": row["input_digest"],
            "stats": stats if isinstance(stats, dict) else {},
            "error_code": row["error_code"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "finished_at": row["finished_at"],
        }


__all__ = [
    "DATASET_STAGES",
    "DATASET_KINDS",
    "DATASET_ROOT_ORIGINS",
    "DATASET_DECISIONS",
    "DATASET_STAGE_RUN_STATUSES",
    "DatasetCursorError",
    "DatasetNotFound",
    "DatasetRepository",
    "member_predicate",
]
