from __future__ import annotations

import json
from typing import Any

from ._database_repository import Clock, ReadFactory, TransactionFactory
from .site_policy import EditableSitePolicy


class SitePolicyRepository:
    """Site policy persistence over Database-owned connection boundaries."""

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

    def put_site_policy(self, site: str, policy: dict[str, Any]) -> dict[str, Any]:
        normalized = EditableSitePolicy.model_validate(policy).model_dump()
        now = self._clock()
        with self._transaction() as conn:
            conn.execute(
                """
                INSERT INTO site_policies(site, policy_json, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(site) DO UPDATE SET policy_json=excluded.policy_json, updated_at=excluded.updated_at
                """,
                (site, json.dumps(normalized, ensure_ascii=False), now),
            )
        return {"site": site, "policy": normalized, "updated_at": now}

    def get_site_policy(self, site: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute("SELECT * FROM site_policies WHERE site=?", (site,)).fetchone()
            if row is None:
                return None
            return {"site": row["site"], "policy": json.loads(row["policy_json"]), "updated_at": row["updated_at"]}

    def list_site_policies(self) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute("SELECT * FROM site_policies ORDER BY site").fetchall()
            return [
                {"site": row["site"], "policy": json.loads(row["policy_json"]), "updated_at": row["updated_at"]}
                for row in rows
            ]

    def delete_site_policy(self, site: str) -> bool:
        with self._transaction() as conn:
            return bool(conn.execute("DELETE FROM site_policies WHERE site=?", (site,)).rowcount)
