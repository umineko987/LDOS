package main

import (
	"context"
	"encoding/json"

	"ldos/backend/internal/credentials"
	"ldos/backend/internal/discovery"
	"ldos/backend/internal/search"
	"ldos/backend/internal/workbench"
)

func (b *businessRuntime) newWorkbench(vault *credentials.Store) *workbench.Service {
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
		return discovery.Request{Site: site, Policy: policy, ProxyMode: policy.ProxyMode, ConfigFile: resolved.ConfigFile, CookiesFile: resolved.CookiesFile, CredentialsRef: resolved.Reference, TimeoutSeconds: 60}, nil
	}
	return workbench.New(workbench.Dependencies{
		RequireDataset: b.datasets.Require,
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
		StartCrawl: func(ctx context.Context, dataset string, body json.RawMessage, key string) (string, error) {
			link, err := b.datasets.StartCrawl(ctx, dataset, body, key)
			return valueString(link["batch_id"]), err
		},
		FetchPreview: func(ctx context.Context, site, target string) ([]byte, error) {
			policy, err := runtimePolicy(ctx, b.settings.snapshot(), b.db, site)
			if err != nil {
				return nil, err
			}
			return workbench.FetchHTTPPreview(ctx, b.discovery.Transport, policy, site, target)
		},
	})
}
