package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"ldos/backend/internal/authbrowser"
	"ldos/backend/internal/config"
	"ldos/backend/internal/downloads"
	"ldos/backend/internal/pixivauth"
	"ldos/backend/internal/search"
)

func TestAuthorizationImportAndSearchCredentialWiring(t *testing.T) {
	for _, mode := range []string{"valid", "corrupt", "disabled"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			root := t.TempDir()
			t.Setenv("XDG_CACHE_HOME", filepath.Join(root, "default-cache"))
			sourcePath := filepath.Join(root, "default-cache/gallery-dl/cache.sqlite3")
			source, err := pixivauth.NewCache(sourcePath)
			if err != nil {
				t.Fatal(err)
			}
			if err := source.SaveToken(ctx, "fixture-refresh-token"); err != nil {
				t.Fatal(err)
			}
			if mode == "corrupt" {
				if err := os.WriteFile(sourcePath, []byte("invalid sqlite"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			settings := config.Settings{ProjectDir: root, AllowedCookieRoots: []string{filepath.Join(root, "cookies")}, AllowedConfigRoots: []string{filepath.Join(root, "configs")}, Gallery: config.Gallery{CacheFile: filepath.Join(root, "cache.sqlite3"), MigrateDefaultAuth: mode != "disabled"}}
			auth, vault, err := newAuthorizationRuntime(ctx, settings, downloads.New(filepath.Join(root, "runtime")))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := auth.Stop(); err != nil {
					t.Error(err)
				}
			})
			status, err := auth.Status(ctx, "pixiv")
			if err != nil || status["authorized"] != (mode == "valid") {
				t.Fatal(status, err)
			}
			cookies := authbrowser.Netscape([]authbrowser.Cookie{{Domain: ".x.com", Path: "/", Name: "auth_token", Value: "fixture"}, {Domain: ".x.com", Path: "/", Name: "ct0", Value: "fixture"}})
			if err := vault.SaveCookies(ctx, "twitter", cookies, map[string]any{}); err != nil {
				t.Fatal(err)
			}
			managed, err := searchCredentials(ctx, settings, vault, "twitter", search.SourceOptions{})
			if err != nil || managed.CookiesFile != filepath.Join(root, "cookies/managed/twitter.cookies.txt") {
				t.Fatal(managed, err)
			}
			external := filepath.Join(root, "cookies/external.txt")
			if err := os.WriteFile(external, []byte("external fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			resolved, err := searchCredentials(ctx, settings, vault, "twitter", search.SourceOptions{CookiesFile: &external})
			if err != nil || resolved.CookiesFile != external {
				t.Fatal(resolved, err)
			}
			outside := filepath.Join(root, "outside.txt")
			if err := os.WriteFile(outside, []byte("fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := searchCredentials(ctx, settings, vault, "twitter", search.SourceOptions{CookiesFile: &outside}); err == nil {
				t.Fatal("search accepted cookies outside allowed roots")
			}
			if _, err := vault.Invalidate(ctx, "twitter", managed.CookiesFile, "AuthenticationError: secret"); err != nil {
				t.Fatal(err)
			}
			resolved, err = searchCredentials(ctx, settings, vault, "twitter", search.SourceOptions{})
			if err != nil || resolved.CookiesFile != "" {
				t.Fatal("search reused invalidated cookies", err)
			}
		})
	}
}
