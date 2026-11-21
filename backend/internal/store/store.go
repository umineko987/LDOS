// Package store owns native Go SQLite persistence. It does not invoke Python.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// ErrNotFound is returned when BeginAttempt cannot find its task. Read methods
// return (nil, nil) for missing rows, matching the existing repository contract.
var ErrNotFound = errors.New("task not found")
var ErrInvalidState = errors.New("invalid task state")

// Store has one serialized writer and a separate query-only reader pool.
// It embeds the task repository so both s.GetTask and s.TaskRepository.GetTask work.
type Store struct {
	*TaskRepository
	path      string
	writer    *sql.DB
	reader    *sql.DB
	writeMu   sync.Mutex
	closeOnce sync.Once
	closeErr  error
}

// Open opens or creates a file database and atomically installs the complete
// schema. Existing rows are preserved; incompatible or future versions fail.
func Open(path string) (_ *Store, err error) {
	if path == "" || path == ":memory:" {
		return nil, errors.New("store requires a database file path")
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err = rejectSymlinks(path); err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	if err = secureSQLiteFiles(path); err != nil {
		return nil, err
	}
	// Precreate with private mode so WAL/SHM inherit private permissions as well.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = f.Chmod(0600); err != nil {
		_ = f.Close()
		return nil, err
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	s := &Store{path: path}
	defer func() {
		if err != nil {
			_ = s.Close()
		}
	}()
	s.writer, err = sql.Open("sqlite", databaseDSN(path, false))
	if err != nil {
		return nil, err
	}
	s.writer.SetMaxOpenConns(1)
	s.writer.SetMaxIdleConns(1)
	ctx := context.Background()
	if err = s.initialize(ctx); err != nil {
		return nil, err
	}
	s.reader, err = sql.Open("sqlite", databaseDSN(path, true))
	if err != nil {
		return nil, err
	}
	s.reader.SetMaxOpenConns(8)
	s.reader.SetMaxIdleConns(8)
	if err = s.reader.PingContext(ctx); err != nil {
		return nil, err
	}
	if err = secureSQLiteFiles(path); err != nil {
		return nil, err
	}
	s.TaskRepository = &TaskRepository{store: s, clock: unixTime, uuid: newID, maxLogs: 5000, sincePrune: make(map[string]int)}
	return s, nil
}

func databaseDSN(path string, reader bool) string {
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(10000)")
	q.Add("_pragma", "foreign_keys(ON)")
	if reader {
		q.Set("mode", "ro")
		q.Add("_pragma", "query_only(ON)")
	} else {
		q.Add("_pragma", "journal_mode(WAL)")
		q.Add("_pragma", "synchronous(NORMAL)")
		q.Set("_txlock", "immediate")
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func (s *Store) Close() error {
	s.closeOnce.Do(func() {
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
		var errs []error
		if s.reader != nil {
			errs = append(errs, s.reader.Close())
		}
		if s.writer != nil {
			errs = append(errs, s.writer.Close())
		}
		if s.path != "" {
			errs = append(errs, secureSQLiteFiles(s.path))
		}
		s.closeErr = errors.Join(errs...)
	})
	return s.closeErr
}

func (s *Store) Ping(ctx context.Context) error {
	var one int
	return s.reader.QueryRowContext(ctx, "SELECT 1").Scan(&one)
}

// withWrite commits before publishing any result to callers. Driver _txlock
// makes BeginTx issue BEGIN IMMEDIATE; rollback cannot obscure the primary error.
func (s *Store) withWrite(ctx context.Context, fn func(*sql.Tx) error) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.writeLocked(ctx, fn)
}

func (s *Store) writeLocked(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func rejectSymlinks(path string) error {
	for candidate := path; ; candidate = filepath.Dir(candidate) {
		info, err := os.Lstat(candidate)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("managed database path contains symlink: %s", candidate)
		}
		if filepath.Dir(candidate) == candidate {
			return nil
		}
	}
}

func secureSQLiteFiles(path string) error {
	for _, candidate := range []string{path, path + "-wal", path + "-shm"} {
		if err := rejectSymlinks(candidate); err != nil {
			return err
		}
		info, err := os.Lstat(candidate)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("database path is not a regular file: %s", candidate)
		}
		if err = os.Chmod(candidate, 0600); err != nil {
			return err
		}
	}
	return nil
}

func unixTime() float64 { return float64(time.Now().UnixNano()) / 1e9 }

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read cannot fail in supported Go versions.
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func queryMaps(ctx context.Context, q queryer, query string, args ...any) ([]map[string]any, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0)
	for rows.Next() {
		values := make([]any, len(cols))
		dest := make([]any, len(cols))
		for i := range values {
			dest[i] = &values[i]
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		m := make(map[string]any, len(cols))
		for i, col := range cols {
			if b, ok := values[i].([]byte); ok {
				values[i] = string(b)
			}
			m[col] = values[i]
		}
		result = append(result, m)
	}
	return result, rows.Err()
}

func queryMap(ctx context.Context, q queryer, query string, args ...any) (map[string]any, error) {
	rows, err := queryMaps(ctx, q, query, args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

func projectTask(row map[string]any) map[string]any {
	if row == nil {
		return nil
	}
	for _, key := range []string{"extra_args_json", "policy_json", "tried_proxy_ids_json"} {
		var fallback any = []any{}
		if key == "policy_json" {
			fallback = map[string]any{}
		}
		decodeColumn(row, key, strings.TrimSuffix(key, "_json"), "null", fallback)
	}
	row["cancel_requested"] = row["cancel_requested"] != int64(0)
	return row
}

func decodeColumn(row map[string]any, key, target, empty string, fallback any) {
	raw, _ := row[key].(string)
	if raw == "" {
		raw = empty
	}
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		value = fallback
	}
	delete(row, key)
	row[target] = value
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func terminal(status string) bool {
	return status == "succeeded" || status == "failed" || status == "cancelled"
}

func clamp(n, lo, hi int) int { return max(lo, min(n, hi)) }
