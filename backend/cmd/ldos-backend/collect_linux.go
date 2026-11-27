package main

import (
	"context"
	"encoding/json"

	"ldos/backend/internal/collect"
	"ldos/backend/internal/credentials"
	"ldos/backend/internal/discovery"
	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/gallery"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/scheduler"
	"ldos/backend/internal/search"
)

func (b *businessRuntime) newCollect(
	vault *credentials.Store,
	pool *proxypool.Pool,
	runner *gallery.Runner,
	searchSvc *search.Service,
	authStatus func(context.Context, string) (map[string]any, error),
) (*collect.Service, error) {
	requestFor := func(ctx context.Context, site string) (discovery.Request, error) {
		settings := b.settings.snapshot()
		policy, err := runtimePolicy(ctx, settings, b.db, site)
		if err != nil {
			return discovery.Request{}, err
		}
		resolved, err := searchCredentials(ctx, settings, vault, site, search.SourceOptions{})
		if err != nil {
			return discovery.Request{}, err
		}
		return discovery.Request{
			Site:           site,
			Policy:         policy,
			ProxyMode:      policy.ProxyMode,
			ConfigFile:     resolved.ConfigFile,
			CookiesFile:    resolved.CookiesFile,
			CredentialsRef: resolved.Reference,
			TimeoutSeconds: 60,
		}, nil
	}

	if authStatus == nil {
		authStatus = func(_ context.Context, site string) (map[string]any, error) {
			return map[string]any{"site": site, "authorized": true, "state": "ready"}, nil
		}
	}
	if searchSvc == nil {
		var err error
		searchSvc, err = search.New(search.Dependencies{
			Discovery:  b.discovery,
			AuthStatus: authStatus,
			Policy: func(ctx context.Context, site string) (scheduler.Policy, error) {
				return runtimePolicy(ctx, b.settings.snapshot(), b.db, site)
			},
			Credentials: func(ctx context.Context, site string, options search.SourceOptions) (search.Credentials, error) {
				return searchCredentials(ctx, b.settings.snapshot(), vault, site, options)
			},
			ValidateStatic: func(value string) error { _, err := b.validator.ValidateStatic(value); return err },
			ValidateDirect: func(ctx context.Context, value string) error { _, err := b.validator.ValidateDirect(ctx, value); return err },
			ValidateArgs: func(args []string) ([]string, error) {
				if _, err := discoverydata.ValidateArgs(args); err != nil {
					return nil, err
				}
				return runner.ValidateArgs(args)
			},
		})
		if err != nil {
			return nil, err
		}
	}

	return collect.New(collect.Dependencies{
		Store:          b.db,
		RequireDataset: b.datasets.Require,
		MemberRows:     b.datasets.MemberRows,
		AttachAssets:   b.datasets.AttachAssets,
		StartCrawl: func(ctx context.Context, dataset string, body json.RawMessage, key string) (string, error) {
			link, err := b.datasets.StartCrawl(ctx, dataset, body, key)
			return valueString(link["batch_id"]), err
		},
		Search:     searchSvc.Perform,
		AuthStatus: authStatus,
		PolicyFor: func(ctx context.Context, site string) (scheduler.Policy, error) {
			return runtimePolicy(ctx, b.settings.snapshot(), b.db, site)
		},
		DanbooruReq: func(ctx context.Context) (discovery.Request, error) {
			return requestFor(ctx, "danbooru")
		},
		DanbooruBrowse: b.discovery.Danbooru.Browse,
		BrowseTimeline: func(ctx context.Context, site, target string, limit int) ([]map[string]any, bool, error) {
			request, err := requestFor(ctx, site)
			if err != nil {
				return nil, false, err
			}
			request.URL, request.Limit = target, limit
			return b.discovery.BrowseTimeline(ctx, request)
		},
		BrowseEHPages: func(ctx context.Context, target string, limit int) ([]map[string]any, int, error) {
			request, err := requestFor(ctx, "exhentai")
			if err != nil {
				return nil, 0, err
			}
			return b.crawls.BrowseEHPages(ctx, target, request.Policy, request.ProxyMode, request.CookiesFile, limit)
		},
		Discover: func(ctx context.Context, site, target string, limit int, rangeKind string) (map[string]any, error) {
			request, err := requestFor(ctx, site)
			if err != nil {
				return nil, err
			}
			request.URL, request.Limit, request.RangeKind = target, limit, rangeKind
			return b.discovery.Discover(ctx, request)
		},
		Transport:    b.discovery.Transport,
		PoolCapacity: pool.Capacity,
	}), nil
}
