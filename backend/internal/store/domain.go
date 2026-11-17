package store

import (
	"context"
	"database/sql"
)

// QueryRows reads through the query-only pool shared by the native repositories.
func (s *Store) QueryRows(ctx context.Context, query string, args ...any) ([]map[string]any, error) {
	return queryMaps(ctx, s.reader, query, args...)
}

func (s *Store) QueryRow(ctx context.Context, query string, args ...any) (map[string]any, error) {
	return queryMap(ctx, s.reader, query, args...)
}

// WriteTransaction serializes domain mutations with tasks, migrations and logs.
// Callers must query through tx inside fn to observe their uncommitted changes.
func (s *Store) WriteTransaction(ctx context.Context, fn func(*sql.Tx) error) error {
	return s.withWrite(ctx, fn)
}

func QueryRowsTx(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]map[string]any, error) {
	return queryMaps(ctx, tx, query, args...)
}

func QueryRowTx(ctx context.Context, tx *sql.Tx, query string, args ...any) (map[string]any, error) {
	return queryMap(ctx, tx, query, args...)
}
