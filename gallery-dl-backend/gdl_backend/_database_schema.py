from __future__ import annotations

import sqlite3
from collections.abc import Callable
from contextlib import AbstractContextManager


CURRENT_SCHEMA_VERSION = 18
SITE_POLICY_SIMPLIFICATION_SCHEMA_VERSION = 8
GALLERY_EXPORT_SCHEMA_VERSION = 9
GALLERY_RECONCILIATION_SCHEMA_VERSION = 10
GALLERY_DIRECTORY_TRASH_SCHEMA_VERSION = 11
DATASET_SCHEMA_VERSION = 15
CAPTION_BATCH_SCHEMA_VERSION = 16
DATASET_EXPORT_SCHEMA_VERSION = 17
DATASET_DECISION_STASH_SCHEMA_VERSION = 18
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


def _ensure_dataset_schema(connection: sqlite3.Connection) -> None:
    # v15：数据集是流水线的一等对象。成员不落表，由根目录 + 决定实时推导；
    # 只有被决定过的图才在 dataset_decisions 里占一行。
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS datasets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            trigger_word TEXT NOT NULL DEFAULT '',
            config_json TEXT NOT NULL DEFAULT '{}',
            cover_asset_id TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_datasets_updated
            ON datasets(updated_at);

        CREATE TABLE IF NOT EXISTS dataset_roots (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            source_id TEXT NOT NULL REFERENCES gallery_sources(id) ON DELETE CASCADE,
            directory_id TEXT NOT NULL,
            relative_path TEXT NOT NULL DEFAULT '',
            origin TEXT NOT NULL,
            created_at REAL NOT NULL,
            UNIQUE(dataset_id, source_id, relative_path)
        );
        CREATE INDEX IF NOT EXISTS idx_dataset_roots_source
            ON dataset_roots(source_id, dataset_id);

        CREATE TABLE IF NOT EXISTS dataset_crawls (
            dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            batch_id TEXT NOT NULL REFERENCES crawl_batches(id) ON DELETE CASCADE,
            state TEXT NOT NULL DEFAULT 'pending',
            root_id TEXT,
            error_code TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            PRIMARY KEY(dataset_id, batch_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dataset_crawls_state
            ON dataset_crawls(state, batch_id);

        CREATE TABLE IF NOT EXISTS dataset_decisions (
            dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            stage TEXT NOT NULL,
            asset_id TEXT NOT NULL,
            decision TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            previous_decision TEXT,
            previous_reason TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            PRIMARY KEY(dataset_id, stage, asset_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dataset_decisions_asset
            ON dataset_decisions(dataset_id, asset_id);

        CREATE TABLE IF NOT EXISTS dataset_stage_runs (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            stage TEXT NOT NULL,
            status TEXT NOT NULL,
            ref_id TEXT NOT NULL DEFAULT '',
            input_digest TEXT NOT NULL DEFAULT '',
            stats_json TEXT NOT NULL DEFAULT '{}',
            error_code TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            finished_at REAL
        );
        CREATE INDEX IF NOT EXISTS idx_dataset_stage_runs_stage
            ON dataset_stage_runs(dataset_id, stage, created_at);

        CREATE INDEX IF NOT EXISTS idx_gallery_assets_content_sha256
            ON gallery_assets(content_sha256) WHERE content_sha256 != '';
        """
    )



def _ensure_caption_batch_schema(connection: sqlite3.Connection) -> None:
    # v16：caption 批量写入的撤销记录。每次批量写入一行 caption_batches，
    # 每张写过（或 from_tagger 记下打标基线）的图一行 caption_batch_items。
    # 版本是写入前后的磁盘版本（gallery_safe_paths 的 disk_version），
    # 撤销只在当前版本仍等于 after_version 时恢复。
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS caption_batches (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            params_json TEXT NOT NULL DEFAULT '{}',
            stats_json TEXT NOT NULL DEFAULT '{}',
            created_at REAL NOT NULL,
            undone_at REAL,
            undo_stats_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_caption_batches_dataset
            ON caption_batches(dataset_id, created_at);

        CREATE TABLE IF NOT EXISTS caption_batch_items (
            batch_id TEXT NOT NULL REFERENCES caption_batches(id) ON DELETE CASCADE,
            asset_id TEXT NOT NULL,
            before_text TEXT,
            before_version TEXT NOT NULL,
            after_text TEXT,
            after_version TEXT NOT NULL,
            tagger_tags_json TEXT,
            PRIMARY KEY(batch_id, asset_id)
        );
        CREATE INDEX IF NOT EXISTS idx_caption_batch_items_asset
            ON caption_batch_items(asset_id);
        """
    )

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

        CREATE TABLE IF NOT EXISTS gallery_reviews (
            review_id TEXT PRIMARY KEY,
            version INTEGER NOT NULL DEFAULT 1,
            selection_json TEXT NOT NULL DEFAULT '[]',
            snapshot_json TEXT NOT NULL DEFAULT '[]',
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
        CREATE INDEX IF NOT EXISTS idx_gallery_reviews_status
            ON gallery_reviews(status, created_at);

        CREATE TABLE IF NOT EXISTS gallery_review_groups (
            review_id TEXT NOT NULL,
            id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            kind TEXT NOT NULL,
            match_levels_json TEXT NOT NULL DEFAULT '[]',
            reason TEXT NOT NULL DEFAULT '',
            decided INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            PRIMARY KEY(review_id, id),
            UNIQUE(review_id, ordinal),
            FOREIGN KEY(review_id) REFERENCES gallery_reviews(review_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_gallery_review_groups_order
            ON gallery_review_groups(review_id, kind, ordinal);

        CREATE TABLE IF NOT EXISTS gallery_review_images (
            review_id TEXT NOT NULL,
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
            PRIMARY KEY(review_id, id),
            UNIQUE(review_id, relative_path),
            FOREIGN KEY(review_id, group_id)
                REFERENCES gallery_review_groups(review_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_gallery_review_images_group
            ON gallery_review_images(review_id, group_id, ordinal);
        CREATE INDEX IF NOT EXISTS idx_gallery_review_images_selection
            ON gallery_review_images(review_id, selected, disposition);

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
            dedup_applied_version INTEGER NOT NULL DEFAULT 0,
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
            lifecycle_state TEXT NOT NULL DEFAULT 'active',
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

        CREATE TABLE IF NOT EXISTS gallery_reconciliation_events (
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL REFERENCES gallery_sources(id) ON DELETE CASCADE,
            batch_id TEXT NOT NULL REFERENCES crawl_batches(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'pending',
            attempt_count INTEGER NOT NULL DEFAULT 0,
            error_code TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            applied_at REAL,
            UNIQUE(source_id, batch_id)
        );
        CREATE INDEX IF NOT EXISTS idx_gallery_reconciliation_events_status
            ON gallery_reconciliation_events(status, updated_at);

        CREATE TABLE IF NOT EXISTS gallery_reconciliation_items (
            event_id TEXT NOT NULL REFERENCES gallery_reconciliation_events(id) ON DELETE CASCADE,
            relative_path TEXT NOT NULL,
            disposition TEXT NOT NULL,
            PRIMARY KEY(event_id, relative_path)
        );
        CREATE INDEX IF NOT EXISTS idx_gallery_reconciliation_items_lookup
            ON gallery_reconciliation_items(disposition, relative_path);

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
            item_type TEXT NOT NULL DEFAULT 'asset',
            directory_id TEXT NOT NULL DEFAULT '',
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
            dataset_id TEXT NOT NULL DEFAULT '',
            options_json TEXT NOT NULL DEFAULT '{}',
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
    _ensure_dataset_schema(connection)
    _ensure_caption_batch_schema(connection)

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

    if schema_version <= GALLERY_EXPORT_SCHEMA_VERSION:
        # v9 迁移：图库与数据集导出只有新增对象，纯 DDL 已由上方幂等脚本建齐；
        # 版本标记单独提交，失败时下次启动自动重试，不产生半迁移状态。
        # v9 开发期内补列：早于列加入的 v9 库用防御性 ALTER 对齐。
        with transaction() as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(gallery_sources)")}
            if "dedup_applied_version" not in columns:
                conn.execute(
                    "ALTER TABLE gallery_sources ADD COLUMN dedup_applied_version INTEGER NOT NULL DEFAULT 0"
                )

        with transaction() as conn:
            conn.execute(
                "UPDATE meta SET value=? WHERE key='schema_version'",
                (str(GALLERY_EXPORT_SCHEMA_VERSION),),
            )

    if schema_version < GALLERY_RECONCILIATION_SCHEMA_VERSION:
        # v10 迁移：审核结果与 Gallery 可见性之间增加可重试的持久对账事件。
        # 表已由上方幂等 DDL 建齐；本块只提交自己的明确目标版本。
        with transaction() as conn:
            conn.execute(
                "UPDATE meta SET value=? WHERE key='schema_version'",
                (str(GALLERY_RECONCILIATION_SCHEMA_VERSION),),
            )
        schema_version = GALLERY_RECONCILIATION_SCHEMA_VERSION

    if schema_version < GALLERY_DIRECTORY_TRASH_SCHEMA_VERSION:
        # v11 迁移：目录回收需要持久区分目录条目，并保留已移入回收区的目录索引。
        with transaction() as conn:
            directory_columns = {
                str(row[1])
                for row in conn.execute("PRAGMA table_info(gallery_directories)")
            }
            if "lifecycle_state" not in directory_columns:
                conn.execute(
                    "ALTER TABLE gallery_directories ADD COLUMN "
                    "lifecycle_state TEXT NOT NULL DEFAULT 'active'"
                )
            item_columns = {
                str(row[1])
                for row in conn.execute(
                    "PRAGMA table_info(gallery_file_operation_items)"
                )
            }
            if "item_type" not in item_columns:
                conn.execute(
                    "ALTER TABLE gallery_file_operation_items ADD COLUMN "
                    "item_type TEXT NOT NULL DEFAULT 'asset'"
                )
            if "directory_id" not in item_columns:
                conn.execute(
                    "ALTER TABLE gallery_file_operation_items ADD COLUMN "
                    "directory_id TEXT NOT NULL DEFAULT ''"
                )
            conn.execute(
                "UPDATE meta SET value=? WHERE key='schema_version'",
                (str(GALLERY_DIRECTORY_TRASH_SCHEMA_VERSION),),
            )
        schema_version = GALLERY_DIRECTORY_TRASH_SCHEMA_VERSION

    if schema_version < 12:
        with transaction() as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(gallery_file_operation_items)")}
            if "review_snapshot_json" not in columns:
                conn.execute("ALTER TABLE gallery_file_operation_items ADD COLUMN review_snapshot_json TEXT NOT NULL DEFAULT '{}'")
            conn.execute("UPDATE meta SET value='12' WHERE key='schema_version'")

    if schema_version < 13:
        # 一次性去重改造：旧审核记录的快照无法与新来源结构对齐，直接全部清空，不做兼容迁移。
        with transaction() as conn:
            for table in ("gallery_review_images", "gallery_review_groups", "gallery_reviews"):
                conn.execute(f"DELETE FROM {table}")
            conn.execute("UPDATE meta SET value='13' WHERE key='schema_version'")

    if schema_version < 14:
        with transaction() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS gallery_review_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, options_json TEXT NOT NULL)")
            columns = {row[1] for row in conn.execute("PRAGMA table_info(gallery_reviews)")}
            if "filter_config_json" not in columns:
                conn.execute("ALTER TABLE gallery_reviews ADD COLUMN filter_config_json TEXT")
            if "reference_snapshot_json" not in columns:
                conn.execute("ALTER TABLE gallery_reviews ADD COLUMN reference_snapshot_json TEXT NOT NULL DEFAULT '[]'")
            conn.execute("UPDATE meta SET value='14' WHERE key='schema_version'")

    if schema_version < DATASET_SCHEMA_VERSION:
        # v15 迁移：数据集表与 content_sha256 索引都是新增对象，DDL 已由
        # _ensure_dataset_schema 幂等建齐；本块只提交目标版本。
        with transaction() as conn:
            conn.execute(
                "UPDATE meta SET value=? WHERE key='schema_version'",
                (str(DATASET_SCHEMA_VERSION),),
            )

    if schema_version < CAPTION_BATCH_SCHEMA_VERSION:
        # v16 迁移：caption 批次两张表都是新增对象，DDL 已由
        # _ensure_caption_batch_schema 幂等建齐；本块只提交目标版本。
        with transaction() as conn:
            conn.execute(
                "UPDATE meta SET value=? WHERE key='schema_version'",
                (str(CAPTION_BATCH_SCHEMA_VERSION),),
            )

    if schema_version < DATASET_EXPORT_SCHEMA_VERSION:
        # v17 迁移：数据集导出任务记下所属数据集与导出选项（v9 起的旧表一直没有写入方）。
        # 补列与索引和版本标记同一事务；按列探测，不依赖中间版本的迁移是否存在。
        with transaction() as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(dataset_export_jobs)")}
            if "dataset_id" not in columns:
                conn.execute("ALTER TABLE dataset_export_jobs ADD COLUMN dataset_id TEXT NOT NULL DEFAULT ''")
            if "options_json" not in columns:
                conn.execute("ALTER TABLE dataset_export_jobs ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_dataset_export_jobs_dataset"
                " ON dataset_export_jobs(dataset_id, created_at)"
            )
            conn.execute(
                "UPDATE meta SET value=? WHERE key='schema_version'",
                (str(DATASET_EXPORT_SCHEMA_VERSION),),
            )

    if schema_version < DATASET_DECISION_STASH_SCHEMA_VERSION:
        # v18 迁移：决定行补上「被地图移除盖掉的原决定」，还原时放回去。
        # 按列探测：没有数据集表的旧库由 _ensure_dataset_schema 直接建出带新列的表。
        with transaction() as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(dataset_decisions)")}
            if "previous_decision" not in columns:
                conn.execute("ALTER TABLE dataset_decisions ADD COLUMN previous_decision TEXT")
            if "previous_reason" not in columns:
                conn.execute("ALTER TABLE dataset_decisions ADD COLUMN previous_reason TEXT NOT NULL DEFAULT ''")
            conn.execute(
                "UPDATE meta SET value=? WHERE key='schema_version'",
                (str(DATASET_DECISION_STASH_SCHEMA_VERSION),),
            )
