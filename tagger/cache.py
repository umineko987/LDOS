"""打标结果缓存（SQLite）。

两层结构对应两级身份：
- scores：推理结果，键 = 模型指纹 × 文件内容哈希（完整 fp32 分数向量）；
- selected：筛选结果，键 = 模型指纹 × 策略指纹 × 文件哈希（JSON）。

改阈值只影响 selected 层；模型/词表/适配器/预处理变化会改变模型指纹，
从而避免误命中旧结果。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import numpy as np


def _secure_cache_files(database_path: Path) -> None:
    # 与去重缓存一致的权限收紧
    for suffix in ("", "-wal", "-shm"):
        candidate = database_path.with_name(database_path.name + suffix)
        try:
            if candidate.exists():
                candidate.chmod(0o600)
        except OSError:
            pass


class TaggerCache:
    def __init__(self, database_path: Path):
        database_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            database_path.parent.chmod(0o700)
        except OSError:
            pass
        self.database_path = database_path
        self.connection = sqlite3.connect(database_path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA busy_timeout=30000")
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS scores (
                model_fingerprint TEXT NOT NULL,
                file_hash TEXT NOT NULL,
                dimension INTEGER NOT NULL,
                vector BLOB NOT NULL,
                PRIMARY KEY (model_fingerprint, file_hash)
            )
            """
        )
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS selected (
                model_fingerprint TEXT NOT NULL,
                policy_fingerprint TEXT NOT NULL,
                file_hash TEXT NOT NULL,
                tags_json TEXT NOT NULL,
                PRIMARY KEY (model_fingerprint, policy_fingerprint, file_hash)
            )
            """
        )
        self.connection.commit()
        _secure_cache_files(database_path)

    def get_scores(self, model_fingerprint: str, file_hash: str) -> np.ndarray | None:
        row = self.connection.execute(
            "SELECT dimension, vector FROM scores WHERE model_fingerprint = ? AND file_hash = ?",
            (model_fingerprint, file_hash),
        ).fetchone()
        if row is None:
            return None
        dimension, vector = row
        result = np.frombuffer(vector, dtype=np.float32)
        if result.size != dimension:
            return None
        return result

    def put_scores(self, model_fingerprint: str, items: list[tuple[str, np.ndarray]]) -> None:
        rows = []
        for file_hash, vector in items:
            normalized = np.asarray(vector, dtype=np.float32).reshape(-1)
            rows.append((model_fingerprint, file_hash, normalized.size, normalized.tobytes()))
        self.connection.executemany(
            "INSERT OR REPLACE INTO scores(model_fingerprint, file_hash, dimension, vector) VALUES (?, ?, ?, ?)",
            rows,
        )
        self.connection.commit()

    def get_selected(self, model_fingerprint: str, policy_fingerprint: str, file_hash: str) -> list[dict] | None:
        row = self.connection.execute(
            "SELECT tags_json FROM selected WHERE model_fingerprint = ? AND policy_fingerprint = ? AND file_hash = ?",
            (model_fingerprint, policy_fingerprint, file_hash),
        ).fetchone()
        if row is None:
            return None
        data = json.loads(row[0])
        return data if isinstance(data, list) else None

    def put_selected(
        self,
        model_fingerprint: str,
        policy_fingerprint: str,
        items: list[tuple[str, list[dict]]],
    ) -> None:
        def normalize(tags: list[dict]) -> str:
            payload = [
                {tag: round(float(score), 5) for tag, score in category.items()}
                for category in tags
            ]
            return json.dumps(payload, ensure_ascii=False)

        self.connection.executemany(
            "INSERT OR REPLACE INTO selected(model_fingerprint, policy_fingerprint, file_hash, tags_json) "
            "VALUES (?, ?, ?, ?)",
            [
                (model_fingerprint, policy_fingerprint, file_hash, normalize(tags))
                for file_hash, tags in items
            ],
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()
        _secure_cache_files(self.database_path)
