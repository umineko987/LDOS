package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// These projections cover every business table, not just tasks. CREATE TABLE
// IF NOT EXISTS cannot repair an undocumented missing column in an existing
// table; fail explicitly rather than advance its version and break later reads.
var requiredSchemaColumns = []struct{ table, columns string }{
	{"meta", "key value"},
	{"tasks", "id idempotency_key url site subcategory extractor status priority output_dir proxy_mode max_attempts attempt_count backoff_anchor_attempt next_run_at created_at updated_at started_at finished_at cancel_requested pid process_marker exit_code last_error_class last_error cookies_file config_file credentials_ref extra_args_json policy_json tried_proxy_ids_json artifact_count artifact_bytes version"},
	{"attempts", "id task_id attempt_no status started_at finished_at exit_code proxy_node_id proxy_endpoint error_class error_message retryable pid process_marker"},
	{"leases", "task_id attempt_id node_id endpoint site acquired_at heartbeat_at"},
	{"task_logs", "id task_id attempt_id ts stream line"},
	{"task_events", "id task_id ts event_type payload_json"},
	{"site_policies", "site policy_json updated_at"},
	{"crawl_batches", "id idempotency_key status output_dir concurrency max_tasks task_count succeeded_task_count failed_task_count cancelled_task_count cancel_requested created_at updated_at started_at finished_at last_error"},
	{"danbooru_import_items", "batch_id post_id file_name"},
	{"danbooru_collect_requests", "dataset_id request_key tokens_json plan_json result_json"},
	{"crawl_addresses", "id batch_id site source_order address_order url label address_type status proxy_mode max_attempts priority credentials_ref cookies_file config_file download_options_json extra_args_json discovery_args_json timeout_seconds planned_task_count pre_dedup_skipped_count succeeded_task_count failed_task_count cancelled_task_count created_at updated_at started_at finished_at last_error planning_error"},
	{"crawl_address_tasks", "address_id task_id sequence_no created_at"},
	{"crawl_task_source_keys", "task_id source_key source_url created_at"},
	{"crawl_address_proxy_probes", "address_id target_url total_count healthy_count checked_at last_error"},
	{"crawl_address_proxy_nodes", "address_id node_id"},
	{"crawl_reviews", "batch_id status total_image_count total_group_count duplicate_group_count unreadable_image_count automatic_group_count automatic_rejected_image_count kept_image_count rejected_image_count failed_image_count error analysis_log_path created_at updated_at started_at ready_at applied_at"},
	{"crawl_review_groups", "batch_id id ordinal kind match_levels_json reason decided created_at updated_at"},
	{"crawl_review_images", "batch_id id group_id ordinal relative_path file_hash metadata_json readable recommended selected disposition final_relative_path error created_at updated_at"},
	{"gallery_reviews", "review_id version selection_json snapshot_json status total_image_count total_group_count duplicate_group_count unreadable_image_count automatic_group_count automatic_rejected_image_count kept_image_count rejected_image_count failed_image_count error analysis_log_path created_at updated_at started_at ready_at applied_at filter_config_json reference_snapshot_json"},
	{"gallery_review_groups", "review_id id ordinal kind match_levels_json reason decided created_at updated_at"},
	{"gallery_review_images", "review_id id group_id ordinal relative_path file_hash metadata_json readable recommended selected disposition final_relative_path error created_at updated_at"},
	{"gallery_review_presets", "id name options_json"},
	{"gallery_sources", "id kind batch_id display_name root_path canonical_root_key availability crawl_complete dedup_required dedup_state dedup_applied_version content_version annotation_version indexed_version last_scanned_at created_at updated_at"},
	{"gallery_directories", "id source_id parent_id relative_path name sort_key direct_directory_count direct_asset_count recursive_asset_count cover_asset_ids_json indexed_version lifecycle_state created_at updated_at"},
	{"gallery_assets", "id source_id directory_id relative_path name extension sort_key size_bytes modified_ns file_version content_sha256 content_version format width height read_state error_code txt_relative_path txt_size_bytes txt_modified_ns txt_sha256 txt_version txt_state dedup_visibility lifecycle_state created_at updated_at"},
	{"gallery_reconciliation_events", "id source_id batch_id status attempt_count error_code created_at updated_at applied_at"},
	{"gallery_reconciliation_items", "event_id relative_path disposition"},
	{"gallery_file_operations", "id kind status source_ids_json created_at updated_at finished_at"},
	{"gallery_file_operation_items", "operation_id ordinal source_id item_type directory_id asset_id origin_relative_path target_relative_path has_txt expected_asset_version expected_txt_version status error_code review_snapshot_json"},
	{"dataset_export_jobs", "id idempotency_key dataset_id options_json status target_path sample_count image_bytes txt_bytes snapshot_digest error_class created_at updated_at started_at finished_at"},
	{"dataset_export_sources", "job_id source_id directory_id include_descendants output_alias content_version annotation_version indexed_version created_at"},
	{"dataset_export_items", "job_id asset_id source_id output_relative_path source_relative_path txt_output_relative_path txt_source_relative_path has_txt expected_content_version expected_txt_version image_size_bytes txt_size_bytes image_sha256 txt_sha256 copy_state committed_at"},
	{"dataset_export_events", "id job_id ts event_type detail_json"},
	{"gallery_search_index", "asset_id source_id file_name relative_path txt_content"},
	{"datasets", "id name kind trigger_word config_json cover_asset_id created_at updated_at"},
	{"dataset_roots", "id dataset_id source_id directory_id relative_path origin created_at"},
	{"dataset_crawls", "dataset_id batch_id state root_id error_code created_at updated_at"},
	{"dataset_decisions", "dataset_id stage asset_id decision reason previous_decision previous_reason created_at updated_at"},
	{"dataset_stage_runs", "id dataset_id stage status ref_id input_digest stats_json error_code created_at updated_at finished_at"},
	{"gallery_asset_keeps", "asset_id"},
	{"caption_batches", "id dataset_id source_id kind params_json stats_json created_at undone_at undo_stats_json state"},
	{"caption_batch_items", "batch_id asset_id before_text before_version after_text after_version tagger_tags_json write_state undo_state before_bom"},
}

func validateSchemaColumns(ctx context.Context, tx *sql.Tx) error {
	for _, required := range requiredSchemaColumns {
		// Identifiers come only from the static declarations above. No row data is read.
		query := "SELECT " + strings.Join(strings.Fields(required.columns), ",") + " FROM " + required.table + " LIMIT 0"
		if _, err := queryMaps(ctx, tx, query); err != nil {
			return fmt.Errorf("unsupported SQLite schema for %s: %w", required.table, err)
		}
	}
	return nil
}
