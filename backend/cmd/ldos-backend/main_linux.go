package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/config"
	"ldos/backend/internal/diagnostics"
	"ldos/backend/internal/downloads"
	"ldos/backend/internal/httpapi"
	"ldos/backend/internal/policy"
	"ldos/backend/internal/store"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("ldos-backend", flag.ContinueOnError)
	configPath := flags.String("config", "", "existing JSON configuration path")
	flags.Bool("allow-incomplete", false, "deprecated compatibility flag; all native services are enabled")
	flags.Bool("enable-tasks", true, "deprecated compatibility flag; native task execution is always enabled")
	executorsDir := flags.String("executors-dir", "", "directory containing the isolated ldos_gallery executor")
	doctor := flags.Bool("doctor", false, "check native backend and isolated executor readiness")
	jsonOutput := flags.Bool("json", false, "print doctor output as JSON")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	settings, err := config.Load(*configPath, os.Getenv)
	if err != nil {
		return err
	}
	if *doctor {
		return runDoctor(settings, *jsonOutput)
	}
	executors, err := resolveExecutors(settings, *executorsDir)
	if err != nil {
		return err
	}
	syscall.Umask(0077)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if os.Getenv("GDL_BACKEND_PARENT_PIPE") == "1" {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); stop() }()
	}
	// Bind before opening storage: a second instance must not initialize the
	// database or alter permissions while the first backend owns the endpoint.
	listener, err := net.Listen("tcp", settings.Server.Address())
	if err != nil {
		return fmt.Errorf("bind backend endpoint: %w", err)
	}
	defer listener.Close()
	db, err := store.Open(settings.DatabasePath)
	if err != nil {
		return fmt.Errorf("open backend database: %w", err)
	}
	defer db.Close()
	bus := activity.NewBus(0)
	defer bus.Close()
	jobs := activity.NewRegistry(bus)
	jobHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Capture the cursor first: events during snapshotting may replay, never
		// disappear in the gap between GET /jobs and opening the event stream.
		cursor := bus.LastEventID()
		httpapi.JSON(w, http.StatusOK, map[string]any{"items": jobs.List(), "last_event_id": cursor})
	})
	proxy, err := newProxyRuntime(settings)
	if err != nil {
		return fmt.Errorf("initialize native proxy: %w", err)
	}
	defer func() {
		if err := proxy.stop(); err != nil {
			log.Printf("native proxy shutdown: %v", err)
		}
	}()
	proxy.start(ctx, settings.Proxy)
	downloadSettings := downloads.NewWithPool(settings.RuntimeDir, downloadPool{pool: proxy.pool})
	auth, vault, err := newAuthorizationRuntime(ctx, settings, downloadSettings)
	if err != nil {
		return fmt.Errorf("initialize native authorization: %w", err)
	}
	defer func() {
		if err := auth.Stop(); err != nil {
			log.Printf("native authorization shutdown: %v", err)
		}
	}()
	task, err := newTaskRuntime(settings, db, executors, schedulerPool{pool: proxy.pool})
	if err != nil {
		return fmt.Errorf("initialize native tasks: %w", err)
	}
	defer func() {
		if err := task.stop(); err != nil {
			log.Printf("native task shutdown: %v", err)
		}
	}()
	search, err := newSearchRuntime(settings, db, task.runner, proxy.pool, vault, auth)
	if err != nil {
		return fmt.Errorf("initialize native search: %w", err)
	}
	business, err := newBusinessRuntime(ctx, &liveSettings{value: settings}, db, jobs, bus, task, proxy.pool, vault, businessOptions{Downloads: downloadSettings, Search: search, AuthStatus: auth.Status})
	if err != nil {
		return fmt.Errorf("initialize native services: %w", err)
	}
	defer func() {
		if err := business.stop(); err != nil {
			log.Printf("native services shutdown: %v", err)
		}
	}()
	if err = business.start(); err != nil {
		return fmt.Errorf("start native services: %w", err)
	}
	if err = task.scheduler.Start(ctx); err != nil {
		return fmt.Errorf("start native scheduler: %w", err)
	}
	diagnostic := diagnostics.New(ctx, business.modelSettings)
	defer diagnostic.Stop()
	options := []httpapi.Option{httpapi.WithProxy(proxy.handler), httpapi.WithAuthorization(auth.Handler()), httpapi.WithTasks(task.service), httpapi.WithSearch(search), business.register,
		httpapi.WithDiagnostics(httpapi.RuntimeDiagnostics{Settings: business.modelSettings, Tasks: task.scheduler.Summary, Crawls: business.crawls.Status, Ready: func(ctx context.Context) map[string]any {
			return diagnostic.Readiness(ctx, db.Ping(ctx) == nil, proxy.pool.Status(), proxy.pool.HealthSummary(), task.scheduler.Summary(), business.crawls.Status())
		}}),
	}
	handler := httpapi.New(settings, db, jobHandler, bus, downloadSettings, policy.New(settings.DefaultSitePolicy, db), options...)
	server := &http.Server{
		Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 64 * 1024,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	log.Printf("LDOS backend listening at %s", settings.Server.Address())
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			jobs.Flush()
		case err := <-served:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return err
		case <-ctx.Done():
			bus.Close()
			shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			err := server.Shutdown(shutdown)
			cancel()
			if err != nil {
				_ = server.Close()
			}
			return err
		}
	}
}
