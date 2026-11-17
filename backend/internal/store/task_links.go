package store

import (
	"context"
	"database/sql"
)

// TaskCrawlBatchID keeps task-level retries from bypassing crawl counters.
func (s *Store) TaskCrawlBatchID(ctx context.Context, taskID string) (string, error) {
	var id string
	err := s.reader.QueryRowContext(ctx, `SELECT ca.batch_id FROM crawl_address_tasks cat
		JOIN crawl_addresses ca ON ca.id=cat.address_id WHERE cat.task_id=? LIMIT 1`, taskID).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return id, err
}

// ProbeNodeIDs returns an explicit empty allowlist when no probe is saved.
// Callers must not interpret it as unrestricted node selection.
func (s *Store) ProbeNodeIDs(ctx context.Context, addressID string) ([]string, error) {
	rows, err := s.reader.QueryContext(ctx, `SELECT n.node_id FROM crawl_address_proxy_nodes n
		JOIN crawl_address_proxy_probes p ON p.address_id=n.address_id WHERE n.address_id=? ORDER BY n.node_id`, addressID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
