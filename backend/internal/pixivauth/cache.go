package pixivauth

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const (
	pixivPrefix     = "gallery_dl.extractor.pixiv."
	refreshPrefix   = pixivPrefix + "_refresh_token_cache-"
	defaultTokenKey = refreshPrefix + "None"
)

var (
	ErrCache      = errors.New("Pixiv cache operation failed")
	ErrUnsafePath = errors.New("unsafe Pixiv cache path")
	ErrToken      = errors.New("invalid Pixiv refresh token")
)

// Cache holds only a path, never a persistent SQLite handle. It needs no Close.
// Newly created parents are private; existing shared parents keep their modes.
// The caller owns permissions on any pre-existing dedicated credential directory.
// SQLite reopens the checked pathname: its parent directories must not be
// writable by untrusted processes that could replace entries during an operation.
type Cache struct{ path string }

func NewCache(path string) (*Cache, error) {
	absolute, err := cachePath(path)
	if err != nil {
		return nil, err
	}
	cache := &Cache{path: absolute}
	err = cache.withDB(context.Background(), func(db *sql.DB) error {
		_, err := db.Exec("CREATE TABLE IF NOT EXISTS data (key TEXT PRIMARY KEY, value TEXT, expires INTEGER)")
		return err
	})
	if err != nil {
		return nil, err
	}
	return cache, nil
}

func cachePath(path string) (string, error) {
	if path == "" || strings.ContainsRune(path, 0) {
		return "", ErrUnsafePath
	}
	// Do not clean away a potentially symlinked component before checking it.
	for _, part := range strings.Split(path, string(os.PathSeparator)) {
		if part == ".." {
			return "", ErrUnsafePath
		}
	}
	absolute, err := filepath.Abs(path)
	if err != nil || absolute == "/" {
		return "", ErrUnsafePath
	}
	return absolute, nil
}

func (c *Cache) HasToken(ctx context.Context) (found bool, err error) {
	err = c.withDB(ctx, func(db *sql.DB) error {
		var queryErr error
		found, queryErr = hasToken(ctx, db)
		return queryErr
	})
	return found && err == nil, err
}

type tokenQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func hasToken(ctx context.Context, db tokenQuerier) (bool, error) {
	// GLOB treats underscores literally and is case-sensitive, unlike LIKE.
	rows, err := db.QueryContext(ctx, `SELECT value FROM data WHERE key GLOB ?
		AND typeof(expires) = 'integer' AND (expires = 0 OR expires > ?) AND length(CAST(value AS BLOB)) <= ?`,
		refreshPrefix+"*", time.Now().Unix(), maxCacheValueBytes)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var value any
		if err := rows.Scan(&value); err != nil {
			return false, err
		}
		if token, ok := decodeCacheToken(value); ok && strings.TrimSpace(token) != "" {
			return true, nil
		}
	}
	return false, rows.Err()
}

// SaveToken atomically replaces only Pixiv rows with a pickle BLOB under the
// default (Python None) username. Tokens must fit the 1024-byte encoded limit.
func (c *Cache) SaveToken(ctx context.Context, token string) error {
	if !validSavedToken(token) {
		return ErrToken
	}
	return c.withDB(ctx, func(db *sql.DB) error {
		return inTransaction(ctx, db, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, "DELETE FROM data WHERE key GLOB ?", pixivPrefix+"*"); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, "INSERT INTO data (key, value, expires) VALUES (?, ?, 0)", defaultTokenKey, pickleToken(token))
			return err
		})
	})
}

func (c *Cache) Clear(ctx context.Context) error {
	return c.withDB(ctx, func(db *sql.DB) error {
		_, err := db.ExecContext(ctx, "DELETE FROM data WHERE key GLOB ?", pixivPrefix+"*")
		return err
	})
}

// Migrate copies exact Pixiv rows, preserving values and expiration. A valid
// target token makes this a no-op. Missing sources are also a no-op; malformed
// or unsafe source databases return a controlled error. Source data is read-only.
func (c *Cache) Migrate(ctx context.Context, source string) error {
	source, err := cachePath(source)
	if err != nil {
		return err
	}
	if source == c.path {
		return ctx.Err()
	}
	return c.withDB(ctx, func(target *sql.DB) error {
		return inTransaction(ctx, target, func(tx *sql.Tx) error {
			valid, err := hasToken(ctx, tx)
			if err != nil || valid {
				return err
			}
			reader, finish, err := openCacheDB(ctx, source, false)
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			defer finish()
			rows, err := reader.QueryContext(ctx, "SELECT key, value, expires FROM data WHERE key GLOB ?", pixivPrefix+"*")
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var key string
				var value, expires any
				if err := rows.Scan(&key, &value, &expires); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, "INSERT OR REPLACE INTO data (key, value, expires) VALUES (?, ?, ?)", key, value, expires); err != nil {
					return err
				}
			}
			return rows.Err()
		})
	})
}

func inTransaction(ctx context.Context, db *sql.DB, fn func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil) // DSN uses BEGIN IMMEDIATE to serialize migrations and saves.
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (c *Cache) withDB(ctx context.Context, fn func(*sql.DB) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	db, finish, err := openCacheDB(ctx, c.path, true)
	if err == nil {
		err = fn(db)
		closeErr := finish()
		if err == nil {
			err = closeErr
		}
	}
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, ErrUnsafePath) {
			return ErrUnsafePath
		}
		return ErrCache
	}
	return nil
}

func openCacheDB(ctx context.Context, path string, writable bool) (*sql.DB, func() error, error) {
	dir, err := openCacheDirectory(filepath.Dir(path), writable)
	if err != nil {
		return nil, nil, err
	}
	name := filepath.Base(path)
	if err := secureCacheFiles(dir, name, writable); err != nil {
		dir.Close()
		return nil, nil, err
	}
	uri := url.URL{Scheme: "file", Path: path}
	query := url.Values{"_pragma": {"busy_timeout(5000)", "trusted_schema(OFF)"}}
	if writable {
		query.Set("mode", "rw") // The validated file already exists; never create via SQLite.
		query.Set("_txlock", "immediate")
	} else {
		query.Set("mode", "ro")
		query.Add("_pragma", "query_only(ON)")
	}
	uri.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		dir.Close()
		return nil, nil, err
	}
	db.SetMaxOpenConns(1)
	finish := func() error {
		closeErr := db.Close()
		secureErr := secureCacheFiles(dir, name, writable)
		dir.Close()
		if closeErr != nil {
			return closeErr
		}
		return secureErr
	}
	if err := db.PingContext(ctx); err != nil {
		finish()
		return nil, nil, err
	}
	return db, finish, nil
}
