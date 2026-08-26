from __future__ import annotations

import sqlite3
from collections.abc import Callable
from contextlib import AbstractContextManager


CURRENT_SCHEMA_VERSION = 9
SITE_POLICY_SIMPLIFICATION_SCHEMA_VERSION = 8
GALLERY_EXPORT_SCHEMA_VERSION = 9

TransactionFactory = Callable[[], AbstractContextManager[sqlite3.Connection]]


def _ensure_gallery_search_index(connection: sqlite3.Connection) -> None:
    # 图库搜索索引使用 SQLite FTS5（计划 §5.4）。运行时缺失 FTS5 属于硬失败：
    # 必须在实现阶段更换受控后端索引，不允许静默退化为浏览器全量搜索。
    try:
        connection.executescript(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS gallery_search_index USING fts5(
                asset_id UNINDEXED,
                source_id UNINDEXED,
                file_name,
                relative_path,
                txt_content
            );
            """
        )
    except sqlite3.Error as exc:
        if "fts5" not in str(exc).lower():
            raise
        raise RuntimeError(
            "当前 Python runtime 的 SQLite 缺少 FTS5，无法创建 gallery_search_index；"
            "请按 docs/图库(含导出).md §5.4 更换受控搜索索引实现"
        ) from exc


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

        -- ---- 图库与数据集导出（v9） ----
        CREATE TABLE IF NOT EXISTS gallery_sources (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            batch_id TEXT UNIQUE REFERENCES crawl_batches(id) ON DELETE CASCADE,
            display_name TEXT NOT NULL,
            root_path TEXT NOT NULL,
            canonical_root_key TEXT NOT NULL UNIQUE,
            availability TEXT NOT NULL DEFAULT 'available',
            crawl_complete INTEGER NOT NULL DEFAULT 0,
            dedup_required INTEGER NOT NULL DEFAULT 0,
            dedup_state TEXT NOT NULL DEFAULT 'not_required',
            content_version INTEGER NOT NULL DEFAULT 1,
            annotation_version INTEGER NOT NULL DEFAULT 1,
            indexed_version INTEGER NOT NULL DEFAULT 0,
            last_scanned_at REAL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_gallery_sources_kind
            ON gallery_sources(kind, availability);

        CREATE TABLE IF NOT EXISTS gallery_directories (
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL REFERENCES gallery_sources(id) ON DELETE CASCADE,
            parent_id TEXT REFERENCES gallery_directories(id) ON DELETE CASCADE,
            relative_path TEXT NOT NULL,
            name TEXT NOT NULL,
            sort_key TEXT NOT NULL,
            direct_directory_count INTEGER NOT NULL DEFAULT 0,
            direct_asset_count INTEGER NOT NULL DEFAULT 0,
            recursive_asset_count INTEGER NOT NULL DEFAULT 0,
            cover_asset_ids_json TEXT NOT NULL DEFAULT '[]',
            indexed_version INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            UNIQUE(source_id, relative_path)
        );
        CREATE INDEX IF NOT EXISTS idx_gallery_directories_parent
            ON gallery_directories(source_id, parent_id, sort_key, name);

        CREATE TABLE IF NOT EXISTS gallery_assets (
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL REFERENCES gallery_sources(id) ON DELETE CASCADE,
            directory_id TEXT NOT NULL REFERENCES gallery_directories(id) ON DELETE CASCADE,
            relative_path TEXT NOT NULL,
            name TEXT NOT NULL,
            extension TEXT NOT NULL,
            sort_key TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            modified_ns INTEGER NOT NULL,
            file_version INTEGER NOT NULL DEFAULT 1,
            content_sha256 TEXT NOT NULL DEFAULT '',
            content_version INTEGER NOT NULL DEFAULT 1,
            format TEXT NOT NULL DEFAULT '',
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            read_state TEXT NOT NULL DEFAULT 'pending',
            error_code TEXT NOT NULL DEFAULT '',
            txt_relative_path TEXT NOT NULL DEFAULT '',
            txt_size_bytes INTEGER NOT NULL DEFAULT 0,
            txt_modified_ns INTEGER NOT NULL DEFAULT 0,
            txt_sha256 TEXT NOT NULL DEFAULT '',
            txt_version INTEGER NOT NULL DEFAULT 1,
            txt_state TEXT NOT NULL DEFAULT 'missing',
            dedup_visibility TEXT NOT NULL DEFAULT 'candidate',
            lifecycle_state TEXT NOT NULL DEFAULT 'active',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            UNIQUE(source_id, relative_path)
        );
        CREATE INDEX IF NOT EXISTS idx_gallery_assets_directory
            ON gallery_assets(directory_id, sort_key, name);
        CREATE INDEX IF NOT EXISTS idx_gallery_assets_lifecycle
            ON gallery_assets(source_id, lifecycle_state, dedup_visibility);

        CREATE TABLE IF NOT EXISTS gallery_file_operations (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            source_ids_json TEXT NOT NULL DEFAULT '[]',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            finished_at REAL
        );
        CREATE INDEX IF NOT EXISTS idx_gallery_file_operations_status
            ON gallery_file_operations(status, created_at);

        CREATE TABLE IF NOT EXISTS gallery_file_operation_items (
            operation_id TEXT NOT NULL REFERENCES gallery_file_operations(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            source_id TEXT NOT NULL,
            asset_id TEXT NOT NULL,
            origin_relative_path TEXT NOT NULL,
            target_relative_path TEXT NOT NULL DEFAULT '',
            has_txt INTEGER NOT NULL DEFAULT 0,
            expected_asset_version INTEGER NOT NULL DEFAULT 1,
            expected_txt_version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'planned',
            error_code TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(operation_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_gallery_file_operation_items_asset
            ON gallery_file_operation_items(asset_id, status);

        CREATE TABLE IF NOT EXISTS dataset_export_jobs (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT UNIQUE,
            status TEXT NOT NULL,
            target_path TEXT NOT NULL,
            sample_count INTEGER NOT NULL DEFAULT 0,
            image_bytes INTEGER NOT NULL DEFAULT 0,
            txt_bytes INTEGER NOT NULL DEFAULT 0,
            snapshot_digest TEXT NOT NULL DEFAULT '',
            error_class TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            started_at REAL,
            finished_at REAL
        );
        CREATE INDEX IF NOT EXISTS idx_dataset_export_jobs_status
            ON dataset_export_jobs(status, created_at);

        CREATE TABLE IF NOT EXISTS dataset_export_sources (
            job_id TEXT NOT NULL REFERENCES dataset_export_jobs(id) ON DELETE CASCADE,
            source_id TEXT NOT NULL,
            directory_id TEXT NOT NULL,
            include_descendants INTEGER NOT NULL DEFAULT 0,
            output_alias TEXT NOT NULL,
            content_version INTEGER NOT NULL DEFAULT 1,
            annotation_version INTEGER NOT NULL DEFAULT 1,
            indexed_version INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            PRIMARY KEY(job_id, source_id, directory_id)
        );

        CREATE TABLE IF NOT EXISTS dataset_export_items (
            job_id TEXT NOT NULL REFERENCES dataset_export_jobs(id) ON DELETE CASCADE,
            asset_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            output_relative_path TEXT NOT NULL,
            source_relative_path TEXT NOT NULL,
            txt_output_relative_path TEXT NOT NULL DEFAULT '',
            txt_source_relative_path TEXT NOT NULL DEFAULT '',
            has_txt INTEGER NOT NULL DEFAULT 1,
            expected_content_version INTEGER NOT NULL DEFAULT 1,
            expected_txt_version INTEGER NOT NULL DEFAULT 1,
            image_size_bytes INTEGER NOT NULL DEFAULT 0,
            txt_size_bytes INTEGER NOT NULL DEFAULT 0,
            image_sha256 TEXT NOT NULL DEFAULT '',
            txt_sha256 TEXT NOT NULL DEFAULT '',
            copy_state TEXT NOT NULL DEFAULT 'pending',
            committed_at REAL,
            PRIMARY KEY(job_id, asset_id),
            UNIQUE(job_id, output_relative_path)
        );
        CREATE INDEX IF NOT EXISTS idx_dataset_export_items_job_state
            ON dataset_export_items(job_id, copy_state, output_relative_path);

        CREATE TABLE IF NOT EXISTS dataset_export_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL REFERENCES dataset_export_jobs(id) ON DELETE CASCADE,
            ts REAL NOT NULL,
            event_type TEXT NOT NULL,
            detail_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_dataset_export_events_job
            ON dataset_export_events(job_id, id);
        """
    )
    _ensure_gallery_search_index(connection)

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
                (str(SITE_POLICY_SIMPLIFICATION_SCHEMA_VERSION),),
            )

    if schema_version < GALLERY_EXPORT_SCHEMA_VERSION:
        # v9 迁移：图库与数据集导出只有新增对象，纯 DDL 已由上方幂等脚本建齐；
        # 版本标记单独提交，失败时下次启动自动重试，不产生半迁移状态。
        with transaction() as conn:
            conn.execute(
                "UPDATE meta SET value=? WHERE key='schema_version'",
                (str(CURRENT_SCHEMA_VERSION),),
            )
