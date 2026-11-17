package credentials

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func metadataForTest(t *testing.T, s *Store) map[string]json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(s.managedDir, metadataName))
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func compactJSON(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var b bytes.Buffer
	if err := json.Compact(&b, raw); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func TestInvalidatePreservesMetadataAndRedactsMessage(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	path := filepath.Join(s.managedDir, cookieName("twitter"))
	putFile(t, path, twitterCookies())
	putFile(t, filepath.Join(s.managedDir, cookieName("exhentai")), ehCookies())
	putFile(t, filepath.Join(s.managedDir, metadataName), `{"twitter":{"method":"old","browser":"shared_project_chrome","updated_at":123.5,"cookie_count":2,"custom":{"exact":9007199254740993123456789}},"exhentai":{"updated_at":100,"cookie_count":3},"pixiv":{"scope":"kept"},"_authorization_proxy":{"mode":"direct"},"future":[1e9999,"保留"]}`)
	before := metadataForTest(t, s)
	beforeTime := float64(time.Now().UnixNano()) / 1e9
	changed, err := s.Invalidate(ctx, " X ", path, "401 https://example.test/?token=DO_NOT_PERSIST raw-password-secret")
	if err != nil || !changed {
		t.Fatalf("Invalidate: %v, %v", changed, err)
	}
	after := metadataForTest(t, s)
	for key, value := range before {
		if key != "twitter" && compactJSON(t, after[key]) != compactJSON(t, value) {
			t.Errorf("changed unrelated metadata %q", key)
		}
	}
	fields := siteFields(after["twitter"])
	for key, value := range siteFields(before["twitter"]) {
		if key != "method" && key != "browser" && compactJSON(t, fields[key]) != compactJSON(t, value) {
			t.Errorf("changed preserved site field %q", key)
		}
	}
	if string(fields["method"]) != `"managed_browser"` || string(fields["browser"]) != `"project_chrome"` || string(fields["invalid_reason"]) != `"登录凭证失效"` {
		t.Fatal("invalidation fields differ from Python contract")
	}
	var timestamp float64
	if json.Unmarshal(fields["invalidated_at"], &timestamp) != nil || timestamp < beforeTime || timestamp > float64(time.Now().UnixNano())/1e9 {
		t.Fatal("invalid invalidation timestamp")
	}
	contents, err := os.ReadFile(filepath.Join(s.managedDir, metadataName))
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"DO_NOT_PERSIST", "raw-password-secret", "example.test", "fake-value"} {
		if bytes.Contains(contents, []byte(secret)) {
			t.Fatal("metadata leaked untrusted worker or cookie content")
		}
	}
	if got, err := s.CookiesFor(ctx, "twitter"); err != nil || got != "" {
		t.Fatalf("invalidated cookie still returned: %v", err)
	}
	if available, err := s.Available(ctx, "x", path); err != nil || available {
		t.Fatalf("invalidated credential still available: %v", err)
	}
	if got, err := s.CookiesFor(ctx, "eh"); err != nil || got == "" {
		t.Fatalf("other site was blocked: %v", err)
	}
	checkNoTemporaryFiles(t, s)
}

func TestMissingCookiesAndMetadata(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	path := filepath.Join(s.managedDir, cookieName("twitter"))
	if got, err := s.CookiesFor(ctx, "twitter"); err != nil || got != "" {
		t.Fatalf("missing cookies: %v", err)
	}
	if available, err := s.Available(ctx, "twitter", path); err != nil || available {
		t.Fatalf("missing managed path: %v", err)
	}
	if changed, err := s.Invalidate(ctx, "twitter", path, ""); err != nil || !changed {
		t.Fatalf("missing cookie can still be invalidated: %v, %v", changed, err)
	}
	if !invalidated(metadataForTest(t, s)["twitter"]) {
		t.Fatal("invalidation not persisted")
	}
	putFile(t, path, twitterCookies())
	if got, err := s.CookiesFor(ctx, "twitter"); err != nil || got != "" {
		t.Fatalf("cookie rewrite must not clear invalidation: %v", err)
	}
	putFile(t, filepath.Join(s.managedDir, metadataName), `{"twitter":{"invalidated_at":0}}`)
	if got, err := s.CookiesFor(ctx, "twitter"); err != nil || got != path {
		t.Fatalf("metadata change not observed: %v", err)
	}
	putFile(t, path, cookieHeader)
	if got, err := s.CookiesFor(ctx, "twitter"); err != nil || got != "" {
		t.Fatalf("cookie change not observed: %v", err)
	}
}

func TestExternalCredentialsPassThroughUntouched(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	metadata := filepath.Join(s.managedDir, metadataName)
	putFile(t, metadata, "damaged metadata must not be read for external credentials")
	external := filepath.Join(t.TempDir(), "external.cookies.txt")
	putFile(t, external, "not a cookie jar")
	if err := os.Chmod(external, 0644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "external-link")
	if err := os.Symlink(external, link); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ site, path string }{
		{"twitter", ""}, {"twitter", external}, {"x", link},
		{"twitter", external + "-missing"}, {"twitter", filepath.Dir(external)},
		{"pixiv", filepath.Join(s.managedDir, cookieName("twitter"))},
		{"twitter", filepath.Join(s.managedDir, cookieName("exhentai"))},
	} {
		if available, err := s.Available(ctx, tc.site, tc.path); err != nil || !available {
			t.Errorf("external credentials blocked: %v", err)
		}
		if changed, err := s.Invalidate(ctx, tc.site, tc.path, "secret"); err != nil || changed {
			t.Errorf("external credentials invalidated: %v", err)
		}
	}
	contents, err := os.ReadFile(external)
	if err != nil || string(contents) != "not a cookie jar" {
		t.Fatal("external file changed")
	}
	mode, err := os.Stat(external)
	if err != nil || mode.Mode().Perm() != 0644 {
		t.Fatal("external file permissions changed")
	}
	contents, err = os.ReadFile(metadata)
	if err != nil || string(contents) != "damaged metadata must not be read for external credentials" {
		t.Fatal("external operations changed metadata")
	}
}

func TestInvalidationExclusions(t *testing.T) {
	s := newTestStore(t)
	path := filepath.Join(s.managedDir, cookieName("twitter"))
	putFile(t, filepath.Join(s.managedDir, metadataName), "invalid JSON untouched by exclusions")
	for _, marker := range []string{
		"tweets are protected", "has blocked your account", "blocked your account",
		"insufficient privileges to access this endpoint", "temporarily banned", "gallery not available",
	} {
		changed, err := s.Invalidate(context.Background(), "twitter", path, "401: "+strings.ToUpper(marker)+" raw secret")
		if err != nil || changed {
			t.Errorf("excluded %q changed=%v err=%v", marker, changed, err)
		}
	}
	contents, err := os.ReadFile(filepath.Join(s.managedDir, metadataName))
	if err != nil || string(contents) != "invalid JSON untouched by exclusions" {
		t.Fatal("exclusion changed metadata")
	}
}

func TestCorruptMetadataNeverOverwritten(t *testing.T) {
	for name, contents := range map[string]string{
		"empty": "", "truncated": `{"twitter":`, "null": `null`, "array": `[]`,
		"scalar": `"secret"`, "trailing": `{}` + `{}`, "invalid UTF8": "{\"secret\":\"\xff\"}",
		"oversized":       `{"padding":"` + strings.Repeat("s", maxMetadataBytes) + `"}`,
		"non JSON number": `{"twitter":{"invalidated_at":NaN}}`,
	} {
		t.Run(name, func(t *testing.T) {
			s := newTestStore(t)
			path := filepath.Join(s.managedDir, cookieName("twitter"))
			putFile(t, path, twitterCookies())
			metadata := filepath.Join(s.managedDir, metadataName)
			putFile(t, metadata, contents)
			if got, err := s.CookiesFor(context.Background(), "twitter"); got != "" || !errors.Is(err, ErrInvalidMetadata) {
				t.Fatalf("corrupt metadata accepted: %v", err)
			}
			if available, err := s.Available(context.Background(), "twitter", path); available || !errors.Is(err, ErrInvalidMetadata) {
				t.Fatalf("corrupt metadata available: %v", err)
			}
			changed, err := s.Invalidate(context.Background(), "twitter", path, "token=DO_NOT_PERSIST")
			if changed || !errors.Is(err, ErrInvalidMetadata) {
				t.Fatalf("corrupt metadata overwritten: %v", err)
			}
			if strings.Contains(err.Error(), s.managedDir) || strings.Contains(err.Error(), "DO_NOT_PERSIST") || strings.Contains(err.Error(), "secret") {
				t.Fatal("unsafe error detail")
			}
			after, err := os.ReadFile(metadata)
			if err != nil || string(after) != contents {
				t.Fatal("corrupt metadata bytes changed")
			}
			checkNoTemporaryFiles(t, s)
		})
	}
}

func TestConcurrentStoresPreserveSites(t *testing.T) {
	s := newTestStore(t)
	other, err := New(s.managedDir)
	if err != nil {
		t.Fatal(err)
	}
	putFile(t, filepath.Join(s.managedDir, cookieName("twitter")), twitterCookies())
	putFile(t, filepath.Join(s.managedDir, cookieName("exhentai")), ehCookies())
	putFile(t, filepath.Join(s.managedDir, metadataName), `{"preserved":true}`)
	var wg sync.WaitGroup
	for i := range 16 {
		wg.Go(func() {
			store, site := s, "twitter"
			if i%2 != 0 {
				store, site = other, "exhentai"
			}
			path := filepath.Join(store.managedDir, cookieName(site))
			if changed, err := store.Invalidate(context.Background(), site, path, "401"); err != nil || !changed {
				t.Errorf("concurrent invalidation: %v, %v", changed, err)
			}
			if available, err := store.Available(context.Background(), site, path); err != nil || available {
				t.Errorf("concurrent read: %v, %v", available, err)
			}
		})
	}
	wg.Wait()
	metadata := metadataForTest(t, s)
	if !invalidated(metadata["twitter"]) || !invalidated(metadata["exhentai"]) || string(metadata["preserved"]) != "true" {
		t.Fatal("concurrent writes lost fields")
	}
	checkNoTemporaryFiles(t, s)
}

func TestAtomicReplacementAndOutputBound(t *testing.T) {
	s := newTestStore(t)
	metadata := filepath.Join(s.managedDir, metadataName)
	putFile(t, metadata, `{"keep":true}`)
	old, err := os.Open(metadata)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	path := filepath.Join(s.managedDir, cookieName("twitter"))
	if changed, err := s.Invalidate(context.Background(), "twitter", path, "401"); err != nil || !changed {
		t.Fatalf("Invalidate: %v, %v", changed, err)
	}
	buf := make([]byte, 32)
	n, err := old.Read(buf)
	if err != nil || string(buf[:n]) != `{"keep":true}` {
		t.Fatal("existing inode was truncated instead of atomically replaced")
	}
	contents := `{"keep":"` + strings.Repeat("x", maxMetadataBytes-30) + `"}`
	putFile(t, metadata, contents)
	if changed, err := s.Invalidate(context.Background(), "twitter", path, "401"); changed || !errors.Is(err, ErrInvalidMetadata) {
		t.Fatalf("oversized output: %v, %v", changed, err)
	}
	after, err := os.ReadFile(metadata)
	if err != nil || !reflect.DeepEqual(after, []byte(contents)) {
		t.Fatal("failed oversized write changed source")
	}
	checkNoTemporaryFiles(t, s)
}

func checkNoTemporaryFiles(t *testing.T, s *Store) {
	t.Helper()
	entries, err := os.ReadDir(s.managedDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatal("temporary metadata leaked")
		}
	}
}
