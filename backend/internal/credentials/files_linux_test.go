//go:build linux

package credentials

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != want {
		t.Fatalf("unexpected permissions (want %o): %v", want, err)
	}
}

func TestPrivatePermissions(t *testing.T) {
	parent := t.TempDir()
	if err := os.Chmod(parent, 0755); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(parent, "new", "managed")
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	assertMode(t, parent, 0755)
	assertMode(t, filepath.Dir(dir), 0700)
	assertMode(t, dir, 0700)
	for _, name := range []string{cookieName("twitter"), cookieName("exhentai"), metadataName} {
		putFile(t, filepath.Join(dir, name), `{}`)
		if err := os.Chmod(filepath.Join(dir, name), 0666); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(dir, 0777); err != nil {
		t.Fatal(err)
	}
	if _, err := New(dir); err != nil {
		t.Fatal(err)
	}
	assertMode(t, dir, 0700)
	for _, name := range []string{cookieName("twitter"), cookieName("exhentai"), metadataName} {
		assertMode(t, filepath.Join(dir, name), 0600)
	}
	path := filepath.Join(dir, cookieName("twitter"))
	putFile(t, path, twitterCookies())
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CookiesFor(context.Background(), "twitter"); err != nil {
		t.Fatal(err)
	}
	assertMode(t, path, 0600)
	if changed, err := s.Invalidate(context.Background(), "twitter", path, "401"); err != nil || !changed {
		t.Fatalf("Invalidate: %v, %v", changed, err)
	}
	assertMode(t, filepath.Join(dir, metadataName), 0600)
	assertMode(t, parent, 0755)
}

func TestNewRejectsSymlinkPaths(t *testing.T) {
	for _, kind := range []string{"directory", "parent", "dangling directory", "cookie", "metadata", "dangling cookie", "cleaned away link"} {
		t.Run(kind, func(t *testing.T) {
			base := t.TempDir()
			external := filepath.Join(base, "external")
			if err := os.Mkdir(external, 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(external, 0755); err != nil {
				t.Fatal(err)
			}
			dir := filepath.Join(base, "managed")
			var link, target string
			switch kind {
			case "directory":
				link, target = dir, external
			case "parent":
				link, target = filepath.Join(base, "parent"), external
				dir = filepath.Join(link, "managed")
			case "dangling directory":
				link, target = dir, filepath.Join(external, "missing")
			case "cleaned away link":
				link, target = filepath.Join(base, "alias"), external
				dir = link + "/../managed"
			default:
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
				name := cookieName("twitter")
				if kind == "metadata" {
					name = metadataName
				}
				link, target = filepath.Join(dir, name), filepath.Join(external, "private-target")
				if kind != "dangling cookie" {
					putFile(t, target, "external secret")
					if err := os.Chmod(target, 0644); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
			if store, err := New(dir); store != nil || !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("symlink accepted: %v", err)
			}
			assertMode(t, external, 0755)
			if kind == "cookie" || kind == "metadata" {
				assertMode(t, target, 0644)
				data, err := os.ReadFile(target)
				if err != nil || string(data) != "external secret" {
					t.Fatal("external symlink target changed")
				}
			}
		})
	}
}

func TestManagedSymlinksAfterNewRejected(t *testing.T) {
	for _, name := range []string{cookieName("twitter"), metadataName} {
		t.Run(name, func(t *testing.T) {
			s := newTestStore(t)
			path := filepath.Join(s.managedDir, cookieName("twitter"))
			putFile(t, path, twitterCookies())
			putFile(t, filepath.Join(s.managedDir, metadataName), `{}`)
			external := filepath.Join(t.TempDir(), "private-target")
			putFile(t, external, "external secret")
			if err := os.Chmod(external, 0644); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(filepath.Join(s.managedDir, name)); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(external, filepath.Join(s.managedDir, name)); err != nil {
				t.Fatal(err)
			}
			if got, err := s.CookiesFor(context.Background(), "twitter"); got != "" || !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("CookiesFor followed link: %v", err)
			}
			if available, err := s.Available(context.Background(), "twitter", path); available || !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("Available followed link: %v", err)
			}
			if changed, err := s.Invalidate(context.Background(), "twitter", path, "secret message"); changed || !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("Invalidate followed link: %v", err)
			}
			assertMode(t, external, 0644)
			contents, err := os.ReadFile(external)
			if err != nil || string(contents) != "external secret" {
				t.Fatal("external target changed")
			}
		})
	}
}

func TestReplacedManagedDirectoryRejected(t *testing.T) {
	s := newTestStore(t)
	external := filepath.Join(t.TempDir(), "outside")
	if err := os.Mkdir(external, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(s.managedDir); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, s.managedDir); err != nil {
		t.Fatal(err)
	}
	if got, err := s.CookiesFor(context.Background(), "twitter"); got != "" || !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("replaced directory accepted: %v", err)
	}
	path := filepath.Join(s.managedDir, cookieName("twitter"))
	if changed, err := s.Invalidate(context.Background(), "twitter", path, "401"); changed || !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("replaced directory written: %v", err)
	}
	assertMode(t, external, 0755)
}

func TestManagedAliasesCannotBypassValidation(t *testing.T) {
	s := newTestStore(t)
	path := filepath.Join(s.managedDir, cookieName("twitter"))
	aliasDir := filepath.Join(t.TempDir(), "dir-alias")
	aliasFile := filepath.Join(t.TempDir(), "file-alias")
	if err := os.Symlink(s.managedDir, aliasDir); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path, aliasFile); err != nil {
		t.Fatal(err)
	}
	for _, exists := range []bool{false, true} {
		if exists {
			putFile(t, path, twitterCookies())
		}
		for _, alias := range []string{aliasFile, filepath.Join(aliasDir, cookieName("twitter"))} {
			if available, err := s.Available(context.Background(), "twitter", alias); available || !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("symlink alias passed availability: %v", err)
			}
			if changed, err := s.Invalidate(context.Background(), "twitter", alias, "401"); changed || !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("symlink alias allowed invalidation: %v", err)
			}
		}
	}
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	relative, err := filepath.Rel(wd, path)
	if err != nil {
		t.Fatal(err)
	}
	for _, alias := range []string{relative, s.managedDir + "/./twitter.cookies.txt", s.managedDir + "/missing/../twitter.cookies.txt"} {
		if available, err := s.Available(context.Background(), "twitter", alias); err != nil || !available {
			t.Fatalf("safe relative path rejected: %v", err)
		}
	}
}

func TestRejectSpecialFilesAndHardLinks(t *testing.T) {
	for _, kind := range []string{"directory", "fifo", "hard link"} {
		t.Run(kind, func(t *testing.T) {
			s := newTestStore(t)
			path := filepath.Join(s.managedDir, cookieName("twitter"))
			external := filepath.Join(t.TempDir(), "external")
			var err error
			switch kind {
			case "directory":
				err = os.Mkdir(path, 0700)
			case "fifo":
				err = unix.Mkfifo(path, 0600)
			case "hard link":
				putFile(t, external, twitterCookies())
				if err := os.Chmod(external, 0644); err != nil {
					t.Fatal(err)
				}
				err = os.Link(external, path)
			}
			if err != nil {
				t.Fatal(err)
			}
			if got, err := s.CookiesFor(context.Background(), "twitter"); got != "" || !errors.Is(err, ErrUnsafePath) {
				t.Fatalf("unsafe special file accepted: %v", err)
			}
			if kind == "hard link" {
				assertMode(t, external, 0644)
			}
		})
	}
}

func TestCancellationIncludingLockWait(t *testing.T) {
	s := newTestStore(t)
	path := filepath.Join(s.managedDir, cookieName("twitter"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got, err := s.CookiesFor(ctx, "twitter"); got != "" || !errors.Is(err, context.Canceled) {
		t.Fatalf("CookiesFor cancellation: %v", err)
	}
	if available, err := s.Available(ctx, "twitter", path); available || !errors.Is(err, context.Canceled) {
		t.Fatalf("Available cancellation: %v", err)
	}
	if changed, err := s.Invalidate(ctx, "twitter", path, "secret"); changed || !errors.Is(err, context.Canceled) {
		t.Fatalf("Invalidate cancellation: %v", err)
	}
	locked, err := s.open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Close()
	ctx, cancel = context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if changed, err := s.Invalidate(ctx, "twitter", path, "secret"); changed || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lock wait cancellation: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.managedDir, metadataName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("cancelled operation wrote metadata")
	}
}

func TestNewReturnsSafeErrors(t *testing.T) {
	base := t.TempDir()
	file := filepath.Join(base, "secret-path")
	putFile(t, file, "private")
	for _, path := range []string{"", "/", file, file + "/managed", base + "/invalid\x00token"} {
		store, err := New(path)
		if store != nil || err == nil {
			t.Fatal("invalid managed path accepted")
		}
		if strings.Contains(err.Error(), base) || strings.Contains(err.Error(), "secret-path") || strings.Contains(err.Error(), "token") {
			t.Fatal("unsafe path error leaked input")
		}
	}
}
