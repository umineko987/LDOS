package store

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
	"strconv"
	"strings"
)

const CurrentSchemaVersion = 19
const captionOwnerSchemaVersion = 19

//go:embed schema.sql
var schemaSQL string

//go:embed schema_captions.sql
var captionTablesSQL string

// additiveColumns includes both versioned migrations and the legacy same-version
// additions (task backoff, caption write/undo journaling, address planning).
var additiveColumns = []struct{ table, name, definition string }{
	{"tasks", "backoff_anchor_attempt", "INTEGER NOT NULL DEFAULT 0"},
	{"crawl_addresses", "download_options_json", "TEXT NOT NULL DEFAULT '{}'"},
	{"crawl_addresses", "pre_dedup_skipped_count", "INTEGER NOT NULL DEFAULT 0"},
	{"crawl_addresses", "planning_error", "TEXT NOT NULL DEFAULT ''"},
	{"crawl_reviews", "automatic_group_count", "INTEGER NOT NULL DEFAULT 0"},
	{"crawl_reviews", "automatic_rejected_image_count", "INTEGER NOT NULL DEFAULT 0"},
	{"gallery_sources", "dedup_applied_version", "INTEGER NOT NULL DEFAULT 0"},
	{"gallery_directories", "lifecycle_state", "TEXT NOT NULL DEFAULT 'active'"},
	{"gallery_file_operation_items", "item_type", "TEXT NOT NULL DEFAULT 'asset'"},
	{"gallery_file_operation_items", "directory_id", "TEXT NOT NULL DEFAULT ''"},
	{"gallery_file_operation_items", "review_snapshot_json", "TEXT NOT NULL DEFAULT '{}'"},
	{"gallery_reviews", "filter_config_json", "TEXT"},
	{"gallery_reviews", "reference_snapshot_json", "TEXT NOT NULL DEFAULT '[]'"},
	{"caption_batches", "state", "TEXT NOT NULL DEFAULT 'complete'"},
	{"caption_batch_items", "write_state", "TEXT NOT NULL DEFAULT 'written'"},
	{"caption_batch_items", "undo_state", "TEXT"},
	{"caption_batch_items", "before_bom", "INTEGER NOT NULL DEFAULT 0"},
	{"dataset_export_jobs", "dataset_id", "TEXT NOT NULL DEFAULT ''"},
	{"dataset_export_jobs", "options_json", "TEXT NOT NULL DEFAULT '{}'"},
	{"dataset_decisions", "previous_decision", "TEXT"},
	{"dataset_decisions", "previous_reason", "TEXT NOT NULL DEFAULT ''"},
}

func (s *Store) initialize(ctx context.Context) error {
	return s.withWrite(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); err != nil {
			return err
		}
		var raw string
		err := tx.QueryRowContext(ctx, "SELECT value FROM meta WHERE key='schema_version'").Scan(&raw)
		if err == sql.ErrNoRows {
			raw = "1"
		} else if err != nil {
			return err
		}
		version, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || version < 1 || version > CurrentSchemaVersion {
			return fmt.Errorf("unsupported SQLite schema_version %q", raw)
		}
		// DDL and the final marker share one transaction. Missing FTS5 is fatal,
		// never a reason to produce a task-only database marked as current.
		if _, err := tx.ExecContext(ctx, schemaSQL); err != nil {
			return fmt.Errorf("create complete SQLite schema (FTS5 required): %w", err)
		}
		if err := migrateLegacyRecords(ctx, tx, version); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, captionTablesSQL); err != nil {
			return err
		}
		for _, col := range additiveColumns {
			columns, err := queryMaps(ctx, tx, "PRAGMA table_info("+col.table+")")
			if err != nil {
				return err
			}
			exists := false
			for _, existing := range columns {
				if existing["name"] == col.name {
					exists = true
					break
				}
			}
			if !exists {
				// All SQL identifiers here are static migration declarations.
				if _, err = tx.ExecContext(ctx, "ALTER TABLE "+col.table+" ADD COLUMN "+col.name+" "+col.definition); err != nil {
					return err
				}
			}
		}
		if version < captionOwnerSchemaVersion {
			if err := migrateGalleryReview(ctx, tx); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, `
CREATE INDEX IF NOT EXISTS idx_caption_batches_dataset ON caption_batches(dataset_id, created_at);
CREATE INDEX IF NOT EXISTS idx_caption_batches_source ON caption_batches(source_id, created_at);
CREATE INDEX IF NOT EXISTS idx_caption_batch_items_asset ON caption_batch_items(asset_id);`); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "CREATE INDEX IF NOT EXISTS idx_dataset_export_jobs_dataset ON dataset_export_jobs(dataset_id, created_at)"); err != nil {
			return err
		}
		// Also require FTS when IF NOT EXISTS found an existing index.
		if _, err = queryMaps(ctx, tx, "SELECT rowid FROM gallery_search_index WHERE gallery_search_index MATCH ? LIMIT 0", "ldos"); err != nil {
			return fmt.Errorf("SQLite FTS5 unavailable: %w", err)
		}
		if err = validateSchemaColumns(ctx, tx); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO meta(key,value) VALUES ('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", strconv.Itoa(CurrentSchemaVersion))
		return err
	})
}
