package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
)

// migrateLegacyRecords replaces the old destructive v8/v13 resets. The original
// data stays in the database, and pre-v13 snapshots cannot be applied to current
// files until a review explicitly rebuilds them against the current catalog.
func migrateLegacyRecords(ctx context.Context, tx *sql.Tx, version int) error {
	if version < 8 {
		rows, err := queryMaps(ctx, tx, "SELECT site,policy_json FROM site_policies")
		if err != nil {
			return err
		}
		for _, row := range rows {
			raw, _ := row["policy_json"].(string)
			var fields map[string]json.RawMessage
			if err := json.Unmarshal([]byte(raw), &fields); err != nil || fields == nil {
				return fmt.Errorf("legacy site policy is not a JSON object")
			}
			projected := make(map[string]json.RawMessage)
			for _, key := range []string{"max_concurrency", "retry_limit", "backoff_base_seconds", "proxy_mode"} {
				if value, exists := fields[key]; exists {
					projected[key] = value
				}
			}
			if len(projected) == len(fields) {
				continue
			}
			if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)", "legacy_site_policy:"+row["site"].(string), raw); err != nil {
				return err
			}
			encoded, err := json.Marshal(projected)
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "UPDATE site_policies SET policy_json=? WHERE site=?", string(encoded), row["site"]); err != nil {
				return err
			}
		}
	}
	if version < 13 {
		_, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO meta(key,value) SELECT 'legacy_gallery_review:' || review_id, ? FROM gallery_reviews", strconv.Itoa(version))
		return err
	}
	return nil
}
