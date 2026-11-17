package pixivauth

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestCache(t *testing.T) *Cache {
	t.Helper()
	cache, err := NewCache(filepath.Join(t.TempDir(), "credentials", "cache.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	return cache
}

func cacheSQL(t *testing.T, c *Cache, fn func(*sql.DB)) {
	t.Helper()
	db, err := sql.Open("sqlite", c.path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	fn(db)
}

func execCache(t *testing.T, c *Cache, query string, args ...any) {
	t.Helper()
	cacheSQL(t, c, func(db *sql.DB) {
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	})
}

func cacheRows(t *testing.T, c *Cache) map[string][]any {
	t.Helper()
	result := map[string][]any{}
	cacheSQL(t, c, func(db *sql.DB) {
		rows, err := db.Query("SELECT key, value, expires FROM data")
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var key string
			var value, expires any
			if err := rows.Scan(&key, &value, &expires); err != nil {
				t.Fatal(err)
			}
			result[key] = []any{value, expires}
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
	})
	return result
}

func assertHasToken(t *testing.T, c *Cache, want bool) {
	t.Helper()
	got, err := c.HasToken(context.Background())
	if err != nil || got != want {
		t.Fatalf("HasToken = %v, %v; want %v", got, err, want)
	}
}

func TestCacheMissExpirationAndReadPreservation(t *testing.T) {
	c := newTestCache(t)
	assertHasToken(t, c, false)
	for _, tc := range []struct {
		name    string
		value   any
		expires any
		want    bool
	}{
		{"None", []byte("\x80\x05N."), 0, false},
		{"legacy", "legacy-token", 0, true},
		{"unicode", pickleToken("中😀é"), 0, true},
		{"expired", pickleToken("token"), time.Now().Unix() - 1, false},
		{"future", pickleToken("token"), time.Now().Unix() + 1000, true},
		{"negative", pickleToken("token"), -1, false},
		{"invalid-expiration", pickleToken("token"), "not-a-time", false},
		{"null-expiration", pickleToken("token"), nil, false},
		{"blank", pickleToken(" \t"), 0, false},
		{"malformed", []byte("not-a-pickle"), 0, false},
		{"trailing", append(pickleToken("token"), 'x'), 0, false},
		{"huge", strings.Repeat("x", 1025), 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			execCache(t, c, "DELETE FROM data")
			execCache(t, c, "INSERT INTO data VALUES (?, ?, ?)", defaultTokenKey, tc.value, tc.expires)
			before := cacheRows(t, c)
			assertHasToken(t, c, tc.want)
			if !reflect.DeepEqual(before, cacheRows(t, c)) {
				t.Fatal("status rewrote cache")
			}
		})
	}
	execCache(t, c, "DELETE FROM data")
	execCache(t, c, "INSERT INTO data VALUES (?, ?, 0)", refreshPrefix+"a", []byte("broken"))
	execCache(t, c, "INSERT INTO data VALUES (?, ?, 0)", refreshPrefix+"z", pickleToken("valid"))
	assertHasToken(t, c, true)
}

func TestSaveClearExactPrefixAndPickleStorage(t *testing.T) {
	c := newTestCache(t)
	ctx := context.Background()
	unrelated := []string{"gallery_dl.extractor.twitter.token", "galleryXdl.extractor.pixiv.token", "gallery_dl.extractor.pixivx.token", "GALLERY_DL.extractor.pixiv.token"}
	for _, key := range unrelated {
		execCache(t, c, "INSERT INTO data VALUES (?, 'keep', 0)", key)
	}
	execCache(t, c, "INSERT INTO data VALUES (?, 'old', 0)", pixivPrefix+"PixivAppAPI._login_impl-None")
	execCache(t, c, "INSERT INTO data VALUES (?, 'old', 0)", refreshPrefix+"old-user")
	if err := c.SaveToken(ctx, "unicode-中😀é"); err != nil {
		t.Fatal(err)
	}
	rows := cacheRows(t, c)
	if len(rows) != len(unrelated)+1 {
		t.Fatal(rows)
	}
	value, ok := rows[defaultTokenKey][0].([]byte)
	if !ok {
		t.Fatal("save used TEXT instead of BLOB")
	}
	if token, ok := decodeCacheToken(value); !ok || token != "unicode-中😀é" {
		t.Fatal("invalid saved pickle")
	}
	if rows[defaultTokenKey][1] != int64(0) {
		t.Fatal("refresh token unexpectedly expires")
	}
	assertHasToken(t, c, true)
	if err := c.Clear(ctx); err != nil {
		t.Fatal(err)
	}
	rows = cacheRows(t, c)
	if len(rows) != len(unrelated) {
		t.Fatal(rows)
	}
	for _, key := range unrelated {
		if rows[key][0] != "keep" {
			t.Fatal("unrelated row changed")
		}
	}
	assertHasToken(t, c, false)
	// Similar prefixes cannot create an authorization false positive.
	execCache(t, c, "INSERT INTO data VALUES (?, 'fake', 0)", "galleryXdl.extractor.pixiv._refresh_token_cache-None")
	assertHasToken(t, c, false)
}

func TestSaveAndMigrationRollback(t *testing.T) {
	ctx := context.Background()
	target := newTestCache(t)
	execCache(t, target, "INSERT INTO data VALUES (?, 'previous', 0)", pixivPrefix+"old")
	execCache(t, target, "INSERT INTO data VALUES ('unrelated', 'keep', 0)")
	before := cacheRows(t, target)
	execCache(t, target, `CREATE TRIGGER fail_save BEFORE INSERT ON data WHEN NEW.key = 'gallery_dl.extractor.pixiv._refresh_token_cache-None' BEGIN SELECT RAISE(ABORT, 'SECRET_TRIGGER'); END`)
	if err := target.SaveToken(ctx, "new-token"); err != ErrCache {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, cacheRows(t, target)) {
		t.Fatal("failed save removed old data")
	}
	for _, invalid := range []string{"", " \t", strings.Repeat("x", 1017), string([]byte{0xff})} {
		if err := target.SaveToken(ctx, invalid); err != ErrToken {
			t.Fatal(err)
		}
	}
	source := newTestCache(t)
	execCache(t, source, "INSERT INTO data VALUES (?, 'would overwrite', 0)", pixivPrefix+"old")
	execCache(t, source, "INSERT INTO data VALUES (?, ?, 0)", defaultTokenKey, pickleToken("new-token"))
	if err := target.Migrate(ctx, source.path); err != ErrCache {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, cacheRows(t, target)) {
		t.Fatal("failed migration partially wrote data")
	}
}

func TestMigrationPreservesValuesAndExistingValidTarget(t *testing.T) {
	ctx := context.Background()
	source, target := newTestCache(t), newTestCache(t)
	execCache(t, source, "INSERT INTO data VALUES (?, ?, 0)", defaultTokenKey, pickleToken("source-token"))
	execCache(t, source, "INSERT INTO data VALUES (?, ?, 123)", pixivPrefix+"PixivAppAPI._login_impl-None", []byte("opaque-pickle"))
	execCache(t, source, "INSERT INTO data VALUES ('galleryXdl.extractor.pixiv.fake', 'do not copy', 0)")
	execCache(t, source, "INSERT INTO data VALUES ('unrelated', 'source', 0)")
	execCache(t, target, "INSERT INTO data VALUES ('unrelated', 'target', 0)")
	sourceBefore := cacheRows(t, source)
	if err := target.Migrate(ctx, source.path); err != nil {
		t.Fatal(err)
	}
	rows := cacheRows(t, target)
	if len(rows) != 3 || rows["unrelated"][0] != "target" {
		t.Fatal(rows)
	}
	for _, key := range []string{defaultTokenKey, pixivPrefix + "PixivAppAPI._login_impl-None"} {
		if !reflect.DeepEqual(rows[key], sourceBefore[key]) {
			t.Fatal("source value/expiration not preserved")
		}
	}
	if !reflect.DeepEqual(sourceBefore, cacheRows(t, source)) {
		t.Fatal("source was modified")
	}
	if err := target.SaveToken(ctx, "target-token"); err != nil {
		t.Fatal(err)
	}
	before := cacheRows(t, target)
	if err := target.Migrate(ctx, source.path); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, cacheRows(t, target)) {
		t.Fatal("valid target overwritten")
	}
	if err := target.Clear(ctx); err != nil {
		t.Fatal(err)
	}
	if err := target.Migrate(ctx, filepath.Join(t.TempDir(), "missing", "cache")); err != nil {
		t.Fatal(err)
	}
	if err := target.Migrate(ctx, target.path); err != nil {
		t.Fatal(err)
	}
}

func TestCacheConcurrentSavesAndCancellation(t *testing.T) {
	c := newTestCache(t)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := c.SaveToken(context.Background(), "concurrent-token"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	assertHasToken(t, c, true)
	before := cacheRows(t, c)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.Clear(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := c.SaveToken(ctx, "replacement"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, cacheRows(t, c)) {
		t.Fatal("canceled write changed cache")
	}
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != want {
		t.Fatalf("%s mode %o want %o", path, info.Mode().Perm(), want)
	}
}

func TestCachePermissionsAndSidecars(t *testing.T) {
	shared := t.TempDir()
	if err := os.Chmod(shared, 0755); err != nil {
		t.Fatal(err)
	}
	c, err := NewCache(filepath.Join(shared, "cache.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	assertMode(t, shared, 0755)
	assertMode(t, c.path, 0600)
	private, err := NewCache(filepath.Join(shared, "private", "nested", "cache.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	assertMode(t, filepath.Dir(private.path), 0700)
	assertMode(t, filepath.Join(shared, "private"), 0700)
	if err := os.Chmod(c.path, 0644); err != nil {
		t.Fatal(err)
	}
	cacheSQL(t, c, func(db *sql.DB) {
		if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("INSERT INTO data VALUES ('unrelated', 'keep', 0)"); err != nil {
			t.Fatal(err)
		}
		for _, suffix := range []string{"-wal", "-shm"} {
			if err := os.Chmod(c.path+suffix, 0644); err != nil {
				t.Fatal(err)
			}
		}
		assertHasToken(t, c, false)
		for _, suffix := range []string{"", "-wal", "-shm"} {
			assertMode(t, c.path+suffix, 0600)
		}
		if err := c.SaveToken(context.Background(), "wal-token"); err != nil {
			t.Fatal(err)
		}
		for _, suffix := range []string{"", "-wal", "-shm"} {
			assertMode(t, c.path+suffix, 0600)
		}
	})
	// Existing rollback journal is secured even when SQLite removes it on close.
	if err := os.WriteFile(c.path+"-journal", nil, 0644); err != nil {
		t.Fatal(err)
	}
	assertHasToken(t, c, true)
	if _, err := os.Stat(c.path + "-journal"); err == nil {
		assertMode(t, c.path+"-journal", 0600)
	}
}

func TestCacheRejectsSymlinksHardlinksAndSpecialFiles(t *testing.T) {
	for _, suffix := range []string{"", "-journal", "-wal", "-shm"} {
		for _, linkType := range []string{"symlink", "hardlink"} {
			t.Run(linkType+suffix, func(t *testing.T) {
				root := t.TempDir()
				path := filepath.Join(root, "cache.sqlite3")
				external := filepath.Join(root, "external")
				if err := os.WriteFile(external, []byte("untouched"), 0644); err != nil {
					t.Fatal(err)
				}
				var err error
				if linkType == "symlink" {
					err = os.Symlink(external, path+suffix)
				} else {
					err = os.Link(external, path+suffix)
				}
				if err != nil {
					t.Fatal(err)
				}
				if _, err := NewCache(path); !errors.Is(err, ErrUnsafePath) {
					t.Fatal(err)
				}
				assertMode(t, external, 0644)
			})
		}
	}
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.Mkdir(real, 0755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(link, "cache"), link + "/../cache", real} {
		if _, err := NewCache(path); !errors.Is(err, ErrUnsafePath) {
			t.Fatalf("accepted unsafe path %s: %v", path, err)
		}
	}
	c := newTestCache(t)
	if err := os.Remove(c.path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "missing"), c.path); err != nil {
		t.Fatal(err)
	}
	if _, err := c.HasToken(context.Background()); !errors.Is(err, ErrUnsafePath) {
		t.Fatal("did not recheck path", err)
	}
	target := newTestCache(t)
	if err := target.Migrate(context.Background(), c.path); !errors.Is(err, ErrUnsafePath) {
		t.Fatal("unsafe source accepted", err)
	}
}
