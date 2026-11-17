package main

import (
	"context"
	"log"
	"os"
	"path/filepath"

	"ldos/backend/internal/authbrowser"
	"ldos/backend/internal/authorization"
	"ldos/backend/internal/config"
	"ldos/backend/internal/credentials"
	"ldos/backend/internal/downloads"
	"ldos/backend/internal/pixivauth"
)

func newAuthorizationRuntime(ctx context.Context, settings config.Settings, downloadSettings *downloads.Store) (*authorization.Service, *credentials.Store, error) {
	managed := filepath.Join(settings.AllowedCookieRoots[0], "managed")
	vault, err := credentials.New(managed)
	if err != nil {
		return nil, nil, err
	}
	cache, err := pixivauth.NewCache(settings.Gallery.CacheFile)
	if err != nil {
		return nil, nil, err
	}
	if settings.Gallery.MigrateDefaultAuth {
		base := os.Getenv("XDG_CACHE_HOME")
		if base == "" {
			if home, err := os.UserHomeDir(); err == nil {
				base = filepath.Join(home, ".cache")
			}
		}
		if base != "" {
			if err := cache.Migrate(ctx, filepath.Join(base, "gallery-dl", "cache.sqlite3")); err != nil {
				if ctx.Err() != nil {
					return nil, nil, ctx.Err()
				}
				log.Printf("optional default Pixiv cache import skipped: %v", err)
			}
		}
	}
	browser := authbrowser.New(filepath.Join(managed, "browser-profiles", "shared"))
	return authorization.New(ctx, settings.Auth, settings.Path, vault, cache, browser, downloadSettings), vault, nil
}
