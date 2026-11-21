package store

import (
	"context"
	"database/sql"
	"fmt"
)

func migrateGalleryReview(ctx context.Context, tx *sql.Tx) error {
	if err := migrateCaptionOwners(ctx, tx); err != nil {
		return fmt.Errorf("migrate caption batch owners: %w", err)
	}
	// The retired review stage excluded these assets from export. Keep the
	// original review rows and never infer a gallery-wide keep from approval.
	_, err := tx.ExecContext(ctx, `
INSERT INTO dataset_decisions(dataset_id,stage,asset_id,decision,reason,created_at,updated_at)
SELECT dataset_id,'export',asset_id,'exclude',reason,created_at,updated_at
FROM dataset_decisions WHERE stage='review' AND decision='exclude'
ON CONFLICT(dataset_id,stage,asset_id) DO UPDATE SET
 decision=excluded.decision,reason=excluded.reason,previous_decision=dataset_decisions.decision,
 previous_reason=dataset_decisions.reason,updated_at=max(excluded.updated_at,dataset_decisions.updated_at)
WHERE dataset_decisions.decision!='exclude'`)
	return err
}

func migrateCaptionOwners(ctx context.Context, tx *sql.Tx) error {
	columns, err := queryMaps(ctx, tx, "PRAGMA table_info(caption_batches)")
	if err != nil {
		return err
	}
	for _, col := range columns {
		if col["name"] == "source_id" {
			return nil // A fresh database already has the new table.
		}
	}
	// Rename both sides before rebuilding with foreign keys still enabled.
	// Dropping the old parent first could cascade away the old batch items.
	_, err = tx.ExecContext(ctx, `
ALTER TABLE caption_batch_items RENAME TO caption_batch_items_legacy;
ALTER TABLE caption_batches RENAME TO caption_batches_legacy;
`+captionTablesSQL+`
INSERT INTO caption_batches(rowid,id,dataset_id,kind,params_json,stats_json,created_at,undone_at,undo_stats_json,state)
SELECT rowid,id,dataset_id,kind,params_json,stats_json,created_at,undone_at,undo_stats_json,state FROM caption_batches_legacy;
INSERT INTO caption_batch_items(rowid,batch_id,asset_id,before_text,before_version,after_text,after_version,tagger_tags_json,write_state,undo_state,before_bom)
SELECT rowid,batch_id,asset_id,before_text,before_version,after_text,after_version,tagger_tags_json,write_state,undo_state,before_bom FROM caption_batch_items_legacy;
DROP TABLE caption_batch_items_legacy;
DROP TABLE caption_batches_legacy;`)
	return err
}
