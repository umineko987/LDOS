package main

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	"ldos/backend/internal/config"
	"ldos/backend/internal/credentials"
	"ldos/backend/internal/gallery"
	"ldos/backend/internal/scheduler"
	"ldos/backend/internal/store"
	"ldos/backend/internal/tasks"
)

type taskRuntime struct {
	service   *tasks.Service
	scheduler *scheduler.Scheduler
	runner    *gallery.Runner
	grace     time.Duration
}

func validateTaskExecution(settings config.Settings, enabled bool, executorsDir string) error {
	if !enabled {
		if executorsDir != "" {
			return errors.New("--executors-dir requires --enable-tasks")
		}
		return nil
	}
	if executorsDir == "" {
		return errors.New("--enable-tasks requires --executors-dir pointing to backend/executors")
	}
	return nil
}

func newTaskRuntime(settings config.Settings, db *store.Store, executorsDir string, proxy scheduler.ProxyPool) (*taskRuntime, error) {
	if err := validateTaskExecution(settings, true, executorsDir); err != nil {
		return nil, err
	}
	grace := time.Duration(settings.Gallery.TerminateGraceSeconds * float64(time.Second))
	runner, err := gallery.New(gallery.Settings{
		RepoPath: settings.Gallery.RepoPath, CacheFile: settings.Gallery.CacheFile,
		PythonExecutable: settings.Gallery.PythonExecutable, TerminateGrace: grace,
		MaxLogLineChars: settings.Gallery.MaxLogLineChars, ForbiddenArgs: settings.Gallery.ForbiddenArgs,
	}, executorsDir)
	if err != nil {
		return nil, err
	}
	vault, err := credentials.New(filepath.Join(settings.AllowedCookieRoots[0], "managed"))
	if err != nil {
		return nil, err
	}
	db.SetMaxLogsPerTask(settings.Scheduler.MaxLogsPerTask)
	control, err := scheduler.New(db, scheduler.Dependencies{
		Runner: scheduler.GalleryRunner{Runner: runner}, Proxy: proxy,
		ValidateCredentials: vault.Available, InvalidateCredentials: vault.Invalidate,
		TerminateStale: scheduler.StaleProcessTerminator(grace),
	}, settings.Scheduler.RuntimeSettings())
	if err != nil {
		return nil, err
	}
	service, err := tasks.New(db, tasks.Dependencies{
		Control: control, ValidateArgs: runner.ValidateArgs,
		Resolve: func(ctx context.Context, value string) (tasks.SiteInfo, error) {
			info, err := runner.Resolve(ctx, value)
			return tasks.SiteInfo{Site: info.Site, Subcategory: info.Subcategory, Extractor: info.Extractor, Supported: info.Supported, Host: info.Host}, err
		},
		Credentials: func(ctx context.Context, site string) (tasks.Credentials, error) {
			cookies, err := vault.CookiesFor(ctx, site)
			return tasks.Credentials{CookiesFile: cookies}, err
		},
	}, tasks.Config{
		RuntimeDir: settings.RuntimeDir, ProjectDir: settings.ProjectDir, OutputRoot: settings.DefaultOutputRoot,
		AllowedOutputRoots: settings.AllowedOutputRoots, AllowedConfigRoots: settings.AllowedConfigRoots, AllowedCookieRoots: settings.AllowedCookieRoots,
		AllowPrivateTargets: settings.Server.AllowPrivateTargets, StrictTargetDNS: settings.Server.StrictTargetDNS, DefaultPolicy: settings.DefaultSitePolicy,
	})
	if err != nil {
		return nil, err
	}
	return &taskRuntime{service: service, scheduler: control, runner: runner, grace: settings.Scheduler.RuntimeSettings().ShutdownGrace}, nil
}

func (t *taskRuntime) stop() error {
	ctx, cancel := context.WithTimeout(context.Background(), t.grace)
	defer cancel()
	err := t.scheduler.Stop(ctx)
	// Resolve requests are not scheduler tasks. StopAll also drains them before
	// storage closes; a timed-out scheduler gets a second chance after child exit.
	t.runner.StopAll()
	if err != nil {
		ctx, cancel := context.WithTimeout(context.Background(), t.grace)
		defer cancel()
		err = t.scheduler.Stop(ctx)
	}
	return err
}
