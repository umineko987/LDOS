from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ._database_repository import Clock, ReadFactory, TransactionFactory
from .redaction import redact_text


ProbeReader = Callable[[str], dict[str, Any] | None]


class ProxyProbeRepository:
    """Address probe persistence over Database-owned connection boundaries."""

    def __init__(
        self,
        *,
        read: ReadFactory,
        transaction: TransactionFactory,
        clock: Clock,
        get_probe: ProbeReader,
    ) -> None:
        self._read = read
        self._transaction = transaction
        self._clock = clock
        self._get_probe = get_probe

    def save_crawl_address_proxy_probe(
        self,
        address_id: str,
        *,
        target_url: str,
        total_count: int,
        healthy_node_ids: list[str],
        error: str = "",
    ) -> dict[str, Any]:
        checked_at = self._clock()
        node_ids = list(dict.fromkeys(str(value) for value in healthy_node_ids if str(value)))
        with self._transaction() as conn:
            address = conn.execute(
                "SELECT id FROM crawl_addresses WHERE id=?",
                (address_id,),
            ).fetchone()
            if address is None:
                raise KeyError(address_id)
            conn.execute(
                """
                INSERT INTO crawl_address_proxy_probes(
                    address_id, target_url, total_count, healthy_count, checked_at, last_error
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(address_id) DO UPDATE SET
                    target_url=excluded.target_url,
                    total_count=excluded.total_count,
                    healthy_count=excluded.healthy_count,
                    checked_at=excluded.checked_at,
                    last_error=excluded.last_error
                """,
                (
                    address_id,
                    target_url,
                    max(0, int(total_count)),
                    len(node_ids),
                    checked_at,
                    redact_text(error, limit=2000),
                ),
            )
            conn.execute(
                "DELETE FROM crawl_address_proxy_nodes WHERE address_id=?",
                (address_id,),
            )
            conn.executemany(
                "INSERT INTO crawl_address_proxy_nodes(address_id, node_id) VALUES (?, ?)",
                ((address_id, node_id) for node_id in node_ids),
            )
        return self._get_probe(address_id)

    def get_crawl_address_proxy_probe(self, address_id: str) -> dict[str, Any] | None:
        with self._read() as conn:
            row = conn.execute(
                "SELECT * FROM crawl_address_proxy_probes WHERE address_id=?",
                (address_id,),
            ).fetchone()
            if row is None:
                return None
            node_rows = conn.execute(
                """
                SELECT node_id FROM crawl_address_proxy_nodes
                WHERE address_id=? ORDER BY node_id
                """,
                (address_id,),
            ).fetchall()
        result = dict(row)
        result["node_ids"] = [str(item["node_id"]) for item in node_rows]
        return result
