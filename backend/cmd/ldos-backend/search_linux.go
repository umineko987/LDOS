package main

import (
	"context"
	"ldos/backend/internal/authorization"
	"ldos/backend/internal/config"
	"ldos/backend/internal/credentials"
	"ldos/backend/internal/discovery"
	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/gallery"
	"ldos/backend/internal/network"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/scheduler"
	"ldos/backend/internal/search"
	"ldos/backend/internal/store"
	"ldos/backend/internal/tasks"
)

func newDiscoveryRuntime(settings config.Settings, runner *gallery.Runner, pool *proxypool.Pool, vault *credentials.Store) (*discovery.Service, discovery.Validator, error) {
	validator := network.URLValidator{AllowPrivate: settings.Server.AllowPrivateTargets}
	transport, err := discovery.NewTransport(runner, pool, validator, settings.RuntimeDir, vault.Invalidate)
	if err != nil {
		return nil, nil, err
	}
	return discovery.New(transport), validator, nil
}

func newSearchRuntime(settings config.Settings, db *store.Store, runner *gallery.Runner, pool *proxypool.Pool, vault *credentials.Store, auth *authorization.Service) (*search.Service, error) {
	discovered, validator, err := newDiscoveryRuntime(settings, runner, pool, vault)
	if err != nil {
		return nil, err
	}
	return newSearchWithDiscovery(settings, db, runner, vault, auth, discovered, validator)
}

func newSearchWithDiscovery(settings config.Settings, db *store.Store, runner *gallery.Runner, vault *credentials.Store, auth *authorization.Service, discovered *discovery.Service, validator discovery.Validator) (*search.Service, error) {
	return search.New(search.Dependencies{
		Discovery: discovered, AuthStatus: auth.Status,
		Policy: func(ctx context.Context, site string) (scheduler.Policy, error) {
			return runtimePolicy(ctx, settings, db, site)
		},
		Credentials: func(ctx context.Context, site string, options search.SourceOptions) (search.Credentials, error) {
			return searchCredentials(ctx, settings, vault, site, options)
		},
		ValidateStatic: func(value string) error { _, err := validator.ValidateStatic(value); return err },
		ValidateDirect: func(ctx context.Context, value string) error {
			_, err := validator.ValidateDirect(ctx, value)
			return err
		},
		ValidateArgs: func(args []string) ([]string, error) {
			if _, err := discoverydata.ValidateArgs(args); err != nil {
				return nil, err
			}
			return runner.ValidateArgs(args)
		},
	})
}
func searchCredentials(ctx context.Context, settings config.Settings, vault *credentials.Store, site string, options search.SourceOptions) (search.Credentials, error) {
	value := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	cookies := value(options.CookiesFile)
	if cookies == "" {
		var err error
		cookies, err = vault.CookiesFor(ctx, site)
		if err != nil {
			return search.Credentials{}, err
		}
	}
	cookies, err := tasks.ResolveCredentialFile(cookies, settings.ProjectDir, settings.AllowedCookieRoots, "cookies_file")
	if err != nil {
		return search.Credentials{}, err
	}
	configuration, err := tasks.ResolveCredentialFile(value(options.ConfigFile), settings.ProjectDir, settings.AllowedConfigRoots, "config_file")
	if err != nil {
		return search.Credentials{}, err
	}
	return search.Credentials{Reference: value(options.CredentialsRef), CookiesFile: cookies, ConfigFile: configuration}, nil
}
