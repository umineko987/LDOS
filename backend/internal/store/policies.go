package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// Policy field validation and normalization belong to the policy service/handler.
// Store persists the supplied policy without silently changing its fields.
func (s *Store) PutSitePolicy(ctx context.Context, site string, policy map[string]any) (map[string]any, error) {
	encoded, err := json.Marshal(policy)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	err = s.withWrite(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO site_policies(site,policy_json,updated_at) VALUES (?,?,?)
			ON CONFLICT(site) DO UPDATE SET policy_json=excluded.policy_json,updated_at=excluded.updated_at`,
			site, string(encoded), s.clock())
		if err != nil {
			return err
		}
		row, err := queryMap(ctx, tx, "SELECT * FROM site_policies WHERE site=?", site)
		if err != nil {
			return err
		}
		result, err = projectPolicy(row)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Store) GetSitePolicy(ctx context.Context, site string) (map[string]any, error) {
	row, err := queryMap(ctx, s.reader, "SELECT * FROM site_policies WHERE site=?", site)
	if err != nil {
		return nil, err
	}
	return projectPolicy(row)
}

func (s *Store) ListSitePolicies(ctx context.Context) ([]map[string]any, error) {
	rows, err := queryMaps(ctx, s.reader, "SELECT * FROM site_policies ORDER BY site")
	if err != nil {
		return nil, err
	}
	for i, row := range rows {
		rows[i], err = projectPolicy(row)
		if err != nil {
			return nil, err
		}
	}
	return rows, nil
}

func (s *Store) DeleteSitePolicy(ctx context.Context, site string) (deleted bool, err error) {
	err = s.withWrite(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, "DELETE FROM site_policies WHERE site=?", site)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		deleted = count != 0
		return err
	})
	return deleted && err == nil, err
}

func projectPolicy(row map[string]any) (map[string]any, error) {
	if row == nil {
		return nil, nil
	}
	var policy any
	decoder := json.NewDecoder(strings.NewReader(row["policy_json"].(string)))
	decoder.UseNumber()
	if err := decoder.Decode(&policy); err != nil {
		return nil, fmt.Errorf("invalid policy JSON for site %q: %w", row["site"], err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("invalid policy JSON for site %q: trailing data", row["site"])
	}
	return map[string]any{"site": row["site"], "policy": policy, "updated_at": row["updated_at"]}, nil
}
