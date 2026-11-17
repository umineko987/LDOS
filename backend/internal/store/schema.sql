-- Native Go copy of the complete legacy v18 schema, including non-task objects.
-- All changes are additive. Runtime initialization never invokes Python.
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, url TEXT NOT NULL, site TEXT NOT NULL,
 subcategory TEXT NOT NULL DEFAULT '', extractor TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
 priority INTEGER NOT NULL DEFAULT 0, output_dir TEXT NOT NULL, proxy_mode TEXT NOT NULL,
 max_attempts INTEGER NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
 backoff_anchor_attempt INTEGER NOT NULL DEFAULT 0, next_run_at REAL NOT NULL,
 created_at REAL NOT NULL, updated_at REAL NOT NULL, started_at REAL, finished_at REAL,
 cancel_requested INTEGER NOT NULL DEFAULT 0, pid INTEGER, process_marker TEXT, exit_code INTEGER,
 last_error_class TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
 cookies_file TEXT, config_file TEXT, credentials_ref TEXT,
 extra_args_json TEXT NOT NULL DEFAULT '[]', policy_json TEXT NOT NULL DEFAULT '{}',
 tried_proxy_ids_json TEXT NOT NULL DEFAULT '[]', artifact_count INTEGER NOT NULL DEFAULT 0,
 artifact_bytes INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(status, next_run_at, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_site_status ON tasks(site, status);
CREATE TABLE IF NOT EXISTS attempts (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 attempt_no INTEGER NOT NULL, status TEXT NOT NULL, started_at REAL NOT NULL, finished_at REAL,
 exit_code INTEGER, proxy_node_id TEXT, proxy_endpoint TEXT, error_class TEXT NOT NULL DEFAULT '',
 error_message TEXT NOT NULL DEFAULT '', retryable INTEGER NOT NULL DEFAULT 0, pid INTEGER,
 process_marker TEXT, UNIQUE(task_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id, attempt_no);
CREATE TABLE IF NOT EXISTS leases (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE, node_id TEXT NOT NULL,
 endpoint TEXT NOT NULL, site TEXT NOT NULL, acquired_at REAL NOT NULL, heartbeat_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS task_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 attempt_id TEXT, ts REAL NOT NULL, stream TEXT NOT NULL, line TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_task_id ON task_logs(task_id, id);
CREATE TABLE IF NOT EXISTS task_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 ts REAL NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_task_id ON task_events(task_id, id);
CREATE TABLE IF NOT EXISTS site_policies (site TEXT PRIMARY KEY, policy_json TEXT NOT NULL, updated_at REAL NOT NULL);

CREATE TABLE IF NOT EXISTS crawl_batches (
 id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, status TEXT NOT NULL, output_dir TEXT NOT NULL,
 concurrency INTEGER NOT NULL, max_tasks INTEGER NOT NULL, task_count INTEGER NOT NULL DEFAULT 0,
 succeeded_task_count INTEGER NOT NULL DEFAULT 0, failed_task_count INTEGER NOT NULL DEFAULT 0,
 cancelled_task_count INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0,
 created_at REAL NOT NULL, updated_at REAL NOT NULL, started_at REAL, finished_at REAL,
 last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_crawl_batches_status ON crawl_batches(status, created_at);
CREATE TABLE IF NOT EXISTS crawl_addresses (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES crawl_batches(id) ON DELETE CASCADE,
 site TEXT NOT NULL, source_order INTEGER NOT NULL, address_order INTEGER NOT NULL, url TEXT NOT NULL,
 label TEXT NOT NULL DEFAULT '', address_type TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
 proxy_mode TEXT NOT NULL, max_attempts INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
 credentials_ref TEXT, cookies_file TEXT, config_file TEXT, download_options_json TEXT NOT NULL DEFAULT '{}',
 extra_args_json TEXT NOT NULL DEFAULT '[]', discovery_args_json TEXT NOT NULL DEFAULT '[]',
 timeout_seconds REAL NOT NULL DEFAULT 180, planned_task_count INTEGER NOT NULL DEFAULT 0,
 pre_dedup_skipped_count INTEGER NOT NULL DEFAULT 0, succeeded_task_count INTEGER NOT NULL DEFAULT 0,
 failed_task_count INTEGER NOT NULL DEFAULT 0, cancelled_task_count INTEGER NOT NULL DEFAULT 0,
 created_at REAL NOT NULL, updated_at REAL NOT NULL, started_at REAL, finished_at REAL,
 last_error TEXT NOT NULL DEFAULT '', planning_error TEXT NOT NULL DEFAULT '',
 UNIQUE(batch_id, source_order, address_order)
);
CREATE INDEX IF NOT EXISTS idx_crawl_addresses_batch_order ON crawl_addresses(batch_id, source_order, address_order);
CREATE INDEX IF NOT EXISTS idx_crawl_addresses_status ON crawl_addresses(status, updated_at);
CREATE TABLE IF NOT EXISTS crawl_address_tasks (
 address_id TEXT NOT NULL REFERENCES crawl_addresses(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE, sequence_no INTEGER NOT NULL,
 created_at REAL NOT NULL, PRIMARY KEY(address_id, task_id), UNIQUE(address_id, sequence_no)
);
CREATE INDEX IF NOT EXISTS idx_crawl_address_tasks_address ON crawl_address_tasks(address_id, sequence_no);
CREATE TABLE IF NOT EXISTS crawl_task_source_keys (
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, source_key TEXT NOT NULL,
 source_url TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, PRIMARY KEY(task_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_crawl_task_source_keys_key ON crawl_task_source_keys(source_key);
CREATE TABLE IF NOT EXISTS crawl_address_proxy_probes (
 address_id TEXT PRIMARY KEY REFERENCES crawl_addresses(id) ON DELETE CASCADE, target_url TEXT NOT NULL,
 total_count INTEGER NOT NULL, healthy_count INTEGER NOT NULL, checked_at REAL NOT NULL,
 last_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS crawl_address_proxy_nodes (
 address_id TEXT NOT NULL REFERENCES crawl_addresses(id) ON DELETE CASCADE, node_id TEXT NOT NULL,
 PRIMARY KEY(address_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_crawl_address_proxy_nodes_address ON crawl_address_proxy_nodes(address_id);
CREATE TABLE IF NOT EXISTS crawl_reviews (
 batch_id TEXT PRIMARY KEY REFERENCES crawl_batches(id) ON DELETE CASCADE, status TEXT NOT NULL,
 total_image_count INTEGER NOT NULL DEFAULT 0, total_group_count INTEGER NOT NULL DEFAULT 0,
 duplicate_group_count INTEGER NOT NULL DEFAULT 0, unreadable_image_count INTEGER NOT NULL DEFAULT 0,
 automatic_group_count INTEGER NOT NULL DEFAULT 0, automatic_rejected_image_count INTEGER NOT NULL DEFAULT 0,
 kept_image_count INTEGER NOT NULL DEFAULT 0, rejected_image_count INTEGER NOT NULL DEFAULT 0,
 failed_image_count INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
 analysis_log_path TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL,
 started_at REAL, ready_at REAL, applied_at REAL
);
CREATE INDEX IF NOT EXISTS idx_crawl_reviews_status ON crawl_reviews(status, created_at);
CREATE TABLE IF NOT EXISTS crawl_review_groups (
 batch_id TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL,
 match_levels_json TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL DEFAULT '', decided INTEGER NOT NULL DEFAULT 0,
 created_at REAL NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY(batch_id, id), UNIQUE(batch_id, ordinal),
 FOREIGN KEY(batch_id) REFERENCES crawl_reviews(batch_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_crawl_review_groups_order ON crawl_review_groups(batch_id, kind, ordinal);
CREATE TABLE IF NOT EXISTS crawl_review_images (
 batch_id TEXT NOT NULL, id TEXT NOT NULL, group_id TEXT NOT NULL, ordinal INTEGER NOT NULL, relative_path TEXT NOT NULL,
 file_hash TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}', readable INTEGER NOT NULL DEFAULT 1,
 recommended INTEGER NOT NULL DEFAULT 0, selected INTEGER NOT NULL DEFAULT 1, disposition TEXT NOT NULL DEFAULT 'pending',
 final_relative_path TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL,
 PRIMARY KEY(batch_id, id), UNIQUE(batch_id, relative_path),
 FOREIGN KEY(batch_id, group_id) REFERENCES crawl_review_groups(batch_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_crawl_review_images_group ON crawl_review_images(batch_id, group_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_crawl_review_images_selection ON crawl_review_images(batch_id, selected, disposition);

CREATE TABLE IF NOT EXISTS gallery_reviews (
 review_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, selection_json TEXT NOT NULL DEFAULT '[]',
 snapshot_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, total_image_count INTEGER NOT NULL DEFAULT 0,
 total_group_count INTEGER NOT NULL DEFAULT 0, duplicate_group_count INTEGER NOT NULL DEFAULT 0,
 unreadable_image_count INTEGER NOT NULL DEFAULT 0, automatic_group_count INTEGER NOT NULL DEFAULT 0,
 automatic_rejected_image_count INTEGER NOT NULL DEFAULT 0, kept_image_count INTEGER NOT NULL DEFAULT 0,
 rejected_image_count INTEGER NOT NULL DEFAULT 0, failed_image_count INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
 analysis_log_path TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL,
 started_at REAL, ready_at REAL, applied_at REAL
);
CREATE INDEX IF NOT EXISTS idx_gallery_reviews_status ON gallery_reviews(status, created_at);
CREATE TABLE IF NOT EXISTS gallery_review_groups (
 review_id TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL,
 match_levels_json TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL DEFAULT '', decided INTEGER NOT NULL DEFAULT 0,
 created_at REAL NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY(review_id, id), UNIQUE(review_id, ordinal),
 FOREIGN KEY(review_id) REFERENCES gallery_reviews(review_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gallery_review_groups_order ON gallery_review_groups(review_id, kind, ordinal);
CREATE TABLE IF NOT EXISTS gallery_review_images (
 review_id TEXT NOT NULL, id TEXT NOT NULL, group_id TEXT NOT NULL, ordinal INTEGER NOT NULL, relative_path TEXT NOT NULL,
 file_hash TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}', readable INTEGER NOT NULL DEFAULT 1,
 recommended INTEGER NOT NULL DEFAULT 0, selected INTEGER NOT NULL DEFAULT 1, disposition TEXT NOT NULL DEFAULT 'pending',
 final_relative_path TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL,
 PRIMARY KEY(review_id, id), UNIQUE(review_id, relative_path),
 FOREIGN KEY(review_id, group_id) REFERENCES gallery_review_groups(review_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gallery_review_images_group ON gallery_review_images(review_id, group_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_gallery_review_images_selection ON gallery_review_images(review_id, selected, disposition);
CREATE TABLE IF NOT EXISTS gallery_review_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, options_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gallery_sources (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, batch_id TEXT UNIQUE REFERENCES crawl_batches(id) ON DELETE CASCADE,
 display_name TEXT NOT NULL, root_path TEXT NOT NULL, canonical_root_key TEXT NOT NULL UNIQUE,
 availability TEXT NOT NULL DEFAULT 'available', crawl_complete INTEGER NOT NULL DEFAULT 0, dedup_required INTEGER NOT NULL DEFAULT 0,
 dedup_state TEXT NOT NULL DEFAULT 'not_required', dedup_applied_version INTEGER NOT NULL DEFAULT 0,
 content_version INTEGER NOT NULL DEFAULT 1, annotation_version INTEGER NOT NULL DEFAULT 1, indexed_version INTEGER NOT NULL DEFAULT 0,
 last_scanned_at REAL, created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gallery_sources_kind ON gallery_sources(kind, availability);
CREATE TABLE IF NOT EXISTS gallery_directories (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES gallery_sources(id) ON DELETE CASCADE,
 parent_id TEXT REFERENCES gallery_directories(id) ON DELETE CASCADE, relative_path TEXT NOT NULL, name TEXT NOT NULL, sort_key TEXT NOT NULL,
 direct_directory_count INTEGER NOT NULL DEFAULT 0, direct_asset_count INTEGER NOT NULL DEFAULT 0,
 recursive_asset_count INTEGER NOT NULL DEFAULT 0, cover_asset_ids_json TEXT NOT NULL DEFAULT '[]',
 indexed_version INTEGER NOT NULL DEFAULT 0, lifecycle_state TEXT NOT NULL DEFAULT 'active',
 created_at REAL NOT NULL, updated_at REAL NOT NULL, UNIQUE(source_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_gallery_directories_parent ON gallery_directories(source_id, parent_id, sort_key, name);
CREATE TABLE IF NOT EXISTS gallery_assets (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES gallery_sources(id) ON DELETE CASCADE,
 directory_id TEXT NOT NULL REFERENCES gallery_directories(id) ON DELETE CASCADE, relative_path TEXT NOT NULL,
 name TEXT NOT NULL, extension TEXT NOT NULL, sort_key TEXT NOT NULL, size_bytes INTEGER NOT NULL, modified_ns INTEGER NOT NULL,
 file_version INTEGER NOT NULL DEFAULT 1, content_sha256 TEXT NOT NULL DEFAULT '', content_version INTEGER NOT NULL DEFAULT 1,
 format TEXT NOT NULL DEFAULT '', width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
 read_state TEXT NOT NULL DEFAULT 'pending', error_code TEXT NOT NULL DEFAULT '', txt_relative_path TEXT NOT NULL DEFAULT '',
 txt_size_bytes INTEGER NOT NULL DEFAULT 0, txt_modified_ns INTEGER NOT NULL DEFAULT 0, txt_sha256 TEXT NOT NULL DEFAULT '',
 txt_version INTEGER NOT NULL DEFAULT 1, txt_state TEXT NOT NULL DEFAULT 'missing', dedup_visibility TEXT NOT NULL DEFAULT 'candidate',
 lifecycle_state TEXT NOT NULL DEFAULT 'active', created_at REAL NOT NULL, updated_at REAL NOT NULL, UNIQUE(source_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_gallery_assets_directory ON gallery_assets(directory_id, sort_key, name);
CREATE INDEX IF NOT EXISTS idx_gallery_assets_lifecycle ON gallery_assets(source_id, lifecycle_state, dedup_visibility);
CREATE TABLE IF NOT EXISTS gallery_reconciliation_events (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES gallery_sources(id) ON DELETE CASCADE,
 batch_id TEXT NOT NULL REFERENCES crawl_batches(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending',
 attempt_count INTEGER NOT NULL DEFAULT 0, error_code TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL,
 applied_at REAL, UNIQUE(source_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_gallery_reconciliation_events_status ON gallery_reconciliation_events(status, updated_at);
CREATE TABLE IF NOT EXISTS gallery_reconciliation_items (
 event_id TEXT NOT NULL REFERENCES gallery_reconciliation_events(id) ON DELETE CASCADE, relative_path TEXT NOT NULL,
 disposition TEXT NOT NULL, PRIMARY KEY(event_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_gallery_reconciliation_items_lookup ON gallery_reconciliation_items(disposition, relative_path);
CREATE TABLE IF NOT EXISTS gallery_file_operations (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, source_ids_json TEXT NOT NULL DEFAULT '[]',
 created_at REAL NOT NULL, updated_at REAL NOT NULL, finished_at REAL
);
CREATE INDEX IF NOT EXISTS idx_gallery_file_operations_status ON gallery_file_operations(status, created_at);
CREATE TABLE IF NOT EXISTS gallery_file_operation_items (
 operation_id TEXT NOT NULL REFERENCES gallery_file_operations(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL,
 source_id TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT 'asset', directory_id TEXT NOT NULL DEFAULT '', asset_id TEXT NOT NULL,
 origin_relative_path TEXT NOT NULL, target_relative_path TEXT NOT NULL DEFAULT '', has_txt INTEGER NOT NULL DEFAULT 0,
 expected_asset_version INTEGER NOT NULL DEFAULT 1, expected_txt_version INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'planned', error_code TEXT NOT NULL DEFAULT '', PRIMARY KEY(operation_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_gallery_file_operation_items_asset ON gallery_file_operation_items(asset_id, status);
CREATE TABLE IF NOT EXISTS dataset_export_jobs (
 id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, dataset_id TEXT NOT NULL DEFAULT '', options_json TEXT NOT NULL DEFAULT '{}',
 status TEXT NOT NULL, target_path TEXT NOT NULL, sample_count INTEGER NOT NULL DEFAULT 0, image_bytes INTEGER NOT NULL DEFAULT 0,
 txt_bytes INTEGER NOT NULL DEFAULT 0, snapshot_digest TEXT NOT NULL DEFAULT '', error_class TEXT NOT NULL DEFAULT '',
 created_at REAL NOT NULL, updated_at REAL NOT NULL, started_at REAL, finished_at REAL
);
CREATE INDEX IF NOT EXISTS idx_dataset_export_jobs_status ON dataset_export_jobs(status, created_at);
CREATE TABLE IF NOT EXISTS dataset_export_sources (
 job_id TEXT NOT NULL REFERENCES dataset_export_jobs(id) ON DELETE CASCADE, source_id TEXT NOT NULL, directory_id TEXT NOT NULL,
 include_descendants INTEGER NOT NULL DEFAULT 0, output_alias TEXT NOT NULL, content_version INTEGER NOT NULL DEFAULT 1,
 annotation_version INTEGER NOT NULL DEFAULT 1, indexed_version INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL,
 PRIMARY KEY(job_id, source_id, directory_id)
);
CREATE TABLE IF NOT EXISTS dataset_export_items (
 job_id TEXT NOT NULL REFERENCES dataset_export_jobs(id) ON DELETE CASCADE, asset_id TEXT NOT NULL, source_id TEXT NOT NULL,
 output_relative_path TEXT NOT NULL, source_relative_path TEXT NOT NULL, txt_output_relative_path TEXT NOT NULL DEFAULT '',
 txt_source_relative_path TEXT NOT NULL DEFAULT '', has_txt INTEGER NOT NULL DEFAULT 1, expected_content_version INTEGER NOT NULL DEFAULT 1,
 expected_txt_version INTEGER NOT NULL DEFAULT 1, image_size_bytes INTEGER NOT NULL DEFAULT 0, txt_size_bytes INTEGER NOT NULL DEFAULT 0,
 image_sha256 TEXT NOT NULL DEFAULT '', txt_sha256 TEXT NOT NULL DEFAULT '', copy_state TEXT NOT NULL DEFAULT 'pending', committed_at REAL,
 PRIMARY KEY(job_id, asset_id), UNIQUE(job_id, output_relative_path)
);
CREATE INDEX IF NOT EXISTS idx_dataset_export_items_job_state ON dataset_export_items(job_id, copy_state, output_relative_path);
CREATE TABLE IF NOT EXISTS dataset_export_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES dataset_export_jobs(id) ON DELETE CASCADE,
 ts REAL NOT NULL, event_type TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_dataset_export_events_job ON dataset_export_events(job_id, id);

CREATE VIRTUAL TABLE IF NOT EXISTS gallery_search_index USING fts5(asset_id UNINDEXED, source_id UNINDEXED, file_name, relative_path, txt_content);

CREATE TABLE IF NOT EXISTS datasets (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, trigger_word TEXT NOT NULL DEFAULT '', config_json TEXT NOT NULL DEFAULT '{}',
 cover_asset_id TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_datasets_updated ON datasets(updated_at);
CREATE TABLE IF NOT EXISTS dataset_roots (
 id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
 source_id TEXT NOT NULL REFERENCES gallery_sources(id) ON DELETE CASCADE, directory_id TEXT NOT NULL,
 relative_path TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL, created_at REAL NOT NULL, UNIQUE(dataset_id, source_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_dataset_roots_source ON dataset_roots(source_id, dataset_id);
CREATE TABLE IF NOT EXISTS dataset_crawls (
 dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE, batch_id TEXT NOT NULL REFERENCES crawl_batches(id) ON DELETE CASCADE,
 state TEXT NOT NULL DEFAULT 'pending', root_id TEXT, error_code TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL,
 PRIMARY KEY(dataset_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_dataset_crawls_state ON dataset_crawls(state, batch_id);
CREATE TABLE IF NOT EXISTS dataset_decisions (
 dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE, stage TEXT NOT NULL, asset_id TEXT NOT NULL, decision TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '', previous_decision TEXT, previous_reason TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL,
 PRIMARY KEY(dataset_id, stage, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_dataset_decisions_asset ON dataset_decisions(dataset_id, asset_id);
CREATE TABLE IF NOT EXISTS dataset_stage_runs (
 id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE, stage TEXT NOT NULL, status TEXT NOT NULL,
 ref_id TEXT NOT NULL DEFAULT '', input_digest TEXT NOT NULL DEFAULT '', stats_json TEXT NOT NULL DEFAULT '{}', error_code TEXT NOT NULL DEFAULT '',
 created_at REAL NOT NULL, updated_at REAL NOT NULL, finished_at REAL
);
CREATE INDEX IF NOT EXISTS idx_dataset_stage_runs_stage ON dataset_stage_runs(dataset_id, stage, created_at);
CREATE INDEX IF NOT EXISTS idx_gallery_assets_content_sha256 ON gallery_assets(content_sha256) WHERE content_sha256 != '';
CREATE TABLE IF NOT EXISTS caption_batches (
 id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE, kind TEXT NOT NULL,
 params_json TEXT NOT NULL DEFAULT '{}', stats_json TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL, undone_at REAL,
 undo_stats_json TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'complete'
);
CREATE INDEX IF NOT EXISTS idx_caption_batches_dataset ON caption_batches(dataset_id, created_at);
CREATE TABLE IF NOT EXISTS caption_batch_items (
 batch_id TEXT NOT NULL REFERENCES caption_batches(id) ON DELETE CASCADE, asset_id TEXT NOT NULL, before_text TEXT, before_version TEXT NOT NULL,
 after_text TEXT, after_version TEXT NOT NULL, tagger_tags_json TEXT, write_state TEXT NOT NULL DEFAULT 'written', undo_state TEXT,
 before_bom INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(batch_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_caption_batch_items_asset ON caption_batch_items(asset_id);

-- Precise provenance and retry state for preview-selected Danbooru imports.
CREATE TABLE IF NOT EXISTS danbooru_import_items (
 batch_id TEXT NOT NULL REFERENCES crawl_batches(id) ON DELETE CASCADE,
 post_id TEXT NOT NULL, file_name TEXT NOT NULL, PRIMARY KEY(batch_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_danbooru_import_post ON danbooru_import_items(post_id);
CREATE TABLE IF NOT EXISTS danbooru_collect_requests (
 dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL, tokens_json TEXT NOT NULL, plan_json TEXT NOT NULL,
 result_json TEXT NOT NULL DEFAULT '', PRIMARY KEY(dataset_id, request_key)
);
