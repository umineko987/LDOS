from __future__ import annotations

import sqlite3
from collections.abc import Callable
from contextlib import AbstractContextManager


CURRENT_SCHEMA_VERSION = 8
SITE_POLICY_SIMPLIFICATION_SCHEMA_VERSION = 8

TransactionFactory = Callable[[], AbstractContextManager[sqlite3.Connection]]


def initialize_schema(
    connection: sqlite3.Connection,
    transaction: TransactionFactory,
) -> None:
    # 先读取持久版本，再创建缺失结构；不能在数据迁移前提前抬高版本号。
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
        """
    )
    raw_version = connection.execute(
        "SELECT value FROM meta WHERE key='schema_version'"
    ).fetchone()
    try:
        schema_version = int(raw_version[0])
    except (TypeError, ValueError, IndexError) as exc:
        raise RuntimeError("SQLite schema_version 无效") from exc
    if not 1 <= schema_version <= CURRENT_SCHEMA_VERSION:
        raise RuntimeError(
            f"SQLite schema_version={schema_version} 不受当前后端支持"
        )

    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT UNIQUE,
            url TEXT NOT NULL,
            site TEXT NOT NULL,
            subcategory TEXT NOT NULL DEFAULT '',
            extractor TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            output_dir TEXT NOT NULL,
            proxy_mode TEXT NOT NULL,
            max_attempts INTEGER NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            backoff_anchor_attempt INTEGER NOT NULL DEFAULT 0,
            next_run_at REAL NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            started_at REAL,
            finished_at REAL,
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            pid INTEGER,
            process_marker TEXT,
            exit_code INTEGER,
            last_error_class TEXT NOT NULL DEFAULT '',
            last_error TEXT NOT NULL DEFAULT '',
            cookies_file TEXT,
            config_file TEXT,
            credentials_ref TEXT,
            extra_args_json TEXT NOT NULL DEFAULT '[]',
            policy_json TEXT NOT NULL DEFAULT '{}',
            tried_proxy_ids_json TEXT NOT NULL DEFAULT '[]',
            artifact_count INTEGER NOT NULL DEFAULT 0,
            artifact_bytes INTEGER NOT NULL DEFAULT 0,
            version INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_queue
            ON tasks(status, next_run_at, priority, created_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_site_status
            ON tasks(site, status);

        CREATE TABLE IF NOT EXISTS attempts (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            attempt_no INTEGER NOT NULL,
            status TEXT NOT NULL,
            started_at REAL NOT NULL,
            finished_at REAL,
            exit_code INTEGER,
            proxy_node_id TEXT,
            proxy_endpoint TEXT,
            error_class TEXT NOT NULL DEFAULT '',
            error_message TEXT NOT NULL DEFAULT '',
            retryable INTEGER NOT NULL DEFAULT 0,
            pid INTEGER,
            process_marker TEXT,
            UNIQUE(task_id, attempt_no)
        );
        CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id, attempt_no);

        CREATE TABLE IF NOT EXISTS leases (
            task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
            attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            site TEXT NOT NULL,
            acquired_at REAL NOT NULL,
            heartbeat_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            attempt_id TEXT,
            ts REAL NOT NULL,
            stream TEXT NOT NULL,
            line TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_logs_task_id ON task_logs(task_id, id);

        CREATE TABLE IF NOT EXISTS task_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            ts REAL NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_events_task_id ON task_events(task_id, id);

        CREATE TABLE IF NOT EXISTS site_policies (
            site TEXT PRIMARY KEY,
            policy_json TEXT NOT NULL,
            updated_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS crawl_batches (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT UNIQUE,
            status TEXT NOT NULL,
            output_dir TEXT NOT NULL,
            concurrency INTEGER NOT NULL,
            max_tasks INTEGER NOT NULL,
            task_count INTEGER NOT NULL DEFAULT 0,
            succeeded_task_count INTEGER NOT NULL DEFAULT 0,
            failed_task_count INTEGER NOT NULL DEFAULT 0,
            cancelled_task_count INTEGER NOT NULL DEFAULT 0,
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            started_at REAL,
            finished_at REAL,
            last_error TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_crawl_batches_status
            ON crawl_batches(status, created_at);

        CREATE TABLE IF NOT EXISTS crawl_addresses (
            id TEXT PRIMARY KEY,
            batch_id TEXT NOT NULL REFERENCES crawl_batches(id) ON DELETE CASCADE,
            site TEXT NOT NULL,
            source_order INTEGER NOT NULL,
            address_order INTEGER NOT NULL,
            url TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            address_type TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            proxy_mode TEXT NOT NULL,
            max_attempts INTEGER NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            credentials_ref TEXT,
            cookies_file TEXT,
            config_file TEXT,
            download_options_json TEXT NOT NULL DEFAULT '{}',
            extra_args_json TEXT NOT NULL DEFAULT '[]',
            discovery_args_json TEXT NOT NULL DEFAULT '[]',
            timeout_seconds REAL NOT NULL DEFAULT 180,
            planned_task_count INTEGER NOT NULL DEFAULT 0,
            pre_dedup_skipped_count INTEGER NOT NULL DEFAULT 0,
            succeeded_task_count INTEGER NOT NULL DEFAULT 0,
            failed_task_count INTEGER NOT NULL DEFAULT 0,
            cancelled_task_count INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            started_at REAL,
            finished_at REAL,
            last_error TEXT NOT NULL DEFAULT '',
            planning_error TEXT NOT NULL DEFAULT '',
            UNIQUE(batch_id, source_order, address_order)
        );
        CREATE INDEX IF NOT EXISTS idx_crawl_addresses_batch_order
            ON crawl_addresses(batch_id, source_order, address_order);
        CREATE INDEX IF NOT EXISTS idx_crawl_addresses_status
            ON crawl_addresses(status, updated_at);

        CREATE TABLE IF NOT EXISTS crawl_address_tasks (
            address_id TEXT NOT NULL REFERENCES crawl_addresses(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
            sequence_no INTEGER NOT NULL,
            created_at REAL NOT NULL,
            PRIMARY KEY(address_id, task_id),
            UNIQUE(address_id, sequence_no)
        );
        CREATE INDEX IF NOT EXISTS idx_crawl_address_tasks_address
            ON crawl_address_tasks(address_id, sequence_no);

        CREATE TABLE IF NOT EXISTS crawl_task_source_keys (
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            source_key TEXT NOT NULL,
            source_url TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            PRIMARY KEY(task_id, source_key)
        );
        CREATE INDEX IF NOT EXISTS idx_crawl_task_source_keys_key
            ON crawl_task_source_keys(source_key);

        CREATE TABLE IF NOT EXISTS crawl_address_proxy_probes (
            address_id TEXT PRIMARY KEY REFERENCES crawl_addresses(id) ON DELETE CASCADE,
            target_url TEXT NOT NULL,
            total_count INTEGER NOT NULL,
            healthy_count INTEGER NOT NULL,
            checked_at REAL NOT NULL,
            last_error TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS crawl_address_proxy_nodes (
            address_id TEXT NOT NULL REFERENCES crawl_addresses(id) ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            PRIMARY KEY(address_id, node_id)
        );
        CREATE INDEX IF NOT EXISTS idx_crawl_address_proxy_nodes_address
            ON crawl_address_proxy_nodes(address_id);

        CREATE TABLE IF NOT EXISTS crawl_reviews (
            batch_id TEXT PRIMARY KEY REFERENCES crawl_batches(id) ON DELETE CASCADE,
            status TEXT NOT NULL,
            total_image_count INTEGER NOT NULL DEFAULT 0,
            total_group_count INTEGER NOT NULL DEFAULT 0,
            duplicate_group_count INTEGER NOT NULL DEFAULT 0,
            unreadable_image_count INTEGER NOT NULL DEFAULT 0,
            automatic_group_count INTEGER NOT NULL DEFAULT 0,
            automatic_rejected_image_count INTEGER NOT NULL DEFAULT 0,
            kept_image_count INTEGER NOT NULL DEFAULT 0,
            rejected_image_count INTEGER NOT NULL DEFAULT 0,
            failed_image_count INTEGER NOT NULL DEFAULT 0,
            error TEXT NOT NULL DEFAULT '',
            analysis_log_path TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            started_at REAL,
            ready_at REAL,
            applied_at REAL
        );
        CREATE INDEX IF NOT EXISTS idx_crawl_reviews_status
            ON crawl_reviews(status, created_at);

        CREATE TABLE IF NOT EXISTS crawl_review_groups (
            batch_id TEXT NOT NULL,
            id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            kind TEXT NOT NULL,
            match_levels_json TEXT NOT NULL DEFAULT '[]',
            reason TEXT NOT NULL DEFAULT '',
            decided INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            PRIMARY KEY(batch_id, id),
            UNIQUE(batch_id, ordinal),
            FOREIGN KEY(batch_id) REFERENCES crawl_reviews(batch_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_crawl_review_groups_order
            ON crawl_review_groups(batch_id, kind, ordinal);

        CREATE TABLE IF NOT EXISTS crawl_review_images (
            batch_id TEXT NOT NULL,
            id TEXT NOT NULL,
            group_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            relative_path TEXT NOT NULL,
            file_hash TEXT NOT NULL DEFAULT '',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            readable INTEGER NOT NULL DEFAULT 1,
            recommended INTEGER NOT NULL DEFAULT 0,
            selected INTEGER NOT NULL DEFAULT 1,
            disposition TEXT NOT NULL DEFAULT 'pending',
            final_relative_path TEXT NOT NULL DEFAULT '',
            error TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            PRIMARY KEY(batch_id, id),
            UNIQUE(batch_id, relative_path),
            FOREIGN KEY(batch_id, group_id)
                REFERENCES crawl_review_groups(batch_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_crawl_review_images_group
            ON crawl_review_images(batch_id, group_id, ordinal);
        CREATE INDEX IF NOT EXISTS idx_crawl_review_images_selection
            ON crawl_review_images(batch_id, selected, disposition);
        """
    )
    address_columns = {
        str(row["name"])
        for row in connection.execute("PRAGMA table_info(crawl_addresses)").fetchall()
    }
    if "download_options_json" not in address_columns:
        connection.execute(
            "ALTER TABLE crawl_addresses ADD COLUMN "
            "download_options_json TEXT NOT NULL DEFAULT '{}'"
        )
    if "pre_dedup_skipped_count" not in address_columns:
        connection.execute(
            "ALTER TABLE crawl_addresses ADD COLUMN "
            "pre_dedup_skipped_count INTEGER NOT NULL DEFAULT 0"
        )
    if "planning_error" not in address_columns:
        connection.execute(
            "ALTER TABLE crawl_addresses ADD COLUMN "
            "planning_error TEXT NOT NULL DEFAULT ''"
        )
    review_columns = {
        str(row["name"])
        for row in connection.execute("PRAGMA table_info(crawl_reviews)").fetchall()
    }
    if "automatic_group_count" not in review_columns:
        connection.execute(
            "ALTER TABLE crawl_reviews ADD COLUMN "
            "automatic_group_count INTEGER NOT NULL DEFAULT 0"
        )
    if "automatic_rejected_image_count" not in review_columns:
        connection.execute(
            "ALTER TABLE crawl_reviews ADD COLUMN "
            "automatic_rejected_image_count INTEGER NOT NULL DEFAULT 0"
        )
    task_columns = {
        str(row["name"])
        for row in connection.execute("PRAGMA table_info(tasks)").fetchall()
    }
    if "backoff_anchor_attempt" not in task_columns:
        connection.execute(
            "ALTER TABLE tasks ADD COLUMN "
            "backoff_anchor_attempt INTEGER NOT NULL DEFAULT 0"
        )

    if schema_version < SITE_POLICY_SIMPLIFICATION_SCHEMA_VERSION:
        # v8 产品迁移：旧行可能带高级字段，必须与版本标记在同一事务中
        # 一次性清除。提交 v8 后新建的四字段覆盖在后续启动中会保留。
        with transaction() as conn:
            conn.execute("DELETE FROM site_policies")
            conn.execute(
                "UPDATE meta SET value=? WHERE key='schema_version'",
                (str(CURRENT_SCHEMA_VERSION),),
            )
