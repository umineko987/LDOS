package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/collect"
	"ldos/backend/internal/config"
	"ldos/backend/internal/crawls"
	"ldos/backend/internal/credentials"
	"ldos/backend/internal/danboorucollect"
	"ldos/backend/internal/datasets"
	"ldos/backend/internal/discovery"
	"ldos/backend/internal/downloads"
	"ldos/backend/internal/gallerycatalog"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/reviews"
	"ldos/backend/internal/scheduler"
	"ldos/backend/internal/search"
	"ldos/backend/internal/store"
	"ldos/backend/internal/tasks"
	"ldos/backend/internal/workbench"
)

type liveSettings struct {
	mu    sync.RWMutex
	value config.Settings
}

func (s *liveSettings) snapshot() config.Settings { s.mu.RLock(); defer s.mu.RUnlock(); return s.value }
func (s *liveSettings) enableDedup()              { s.mu.Lock(); s.value.Dedup.Enabled = true; s.mu.Unlock() }

type businessRuntime struct {
	ctx       context.Context
	cancel    context.CancelFunc
	db        *store.Store
	settings  *liveSettings
	pipeline  *pipelineRuntime
	gallery   *gallerycatalog.Service
	reviews   *reviews.Service
	datasets  *datasets.Service
	crawls    *crawls.Service
	discovery *discovery.Service
	danbooru  *danboorucollect.Service
	workbench *workbench.Service
	collect   *collect.Service
	validator discovery.Validator
}

func runtimePolicy(ctx context.Context, settings config.Settings, db *store.Store, site string) (scheduler.Policy, error) {
	raw := settings.DefaultSitePolicy
	saved, err := db.GetSitePolicy(ctx, site)
	if err != nil {
		return scheduler.Policy{}, err
	}
	if saved != nil {
		var ok bool
		raw, ok = saved["policy"].(map[string]any)
		if !ok {
			return scheduler.Policy{}, errors.New("stored site policy is invalid")
		}
	}
	projected := map[string]any{}
	for _, key := range []string{"max_concurrency", "retry_limit", "backoff_base_seconds", "proxy_mode"} {
		if value, ok := raw[key]; ok {
			projected[key] = value
		}
	}
	return scheduler.ParsePolicy(projected)
}

type businessOptions struct {
	ReviewRunner func(context.Context, reviews.WorkerInput) (reviews.Manifest, string, error)
	Downloads    *downloads.Store
	Search       *search.Service
	AuthStatus   func(context.Context, string) (map[string]any, error)
}

func newBusinessRuntime(parent context.Context, settings *liveSettings, db *store.Store, jobs *activity.Registry, events *activity.Bus, task *taskRuntime, pool *proxypool.Pool, vault *credentials.Store, options businessOptions) (_ *businessRuntime, err error) {
	ctx, cancel := context.WithCancel(parent)
	b := &businessRuntime{ctx: ctx, cancel: cancel, db: db, settings: settings}
	defer func() {
		if err != nil {
			_ = b.stop()
		}
	}()
	initial := settings.snapshot()
	b.discovery, b.validator, err = newDiscoveryRuntime(initial, task.runner, pool, vault)
	if err != nil {
		return nil, err
	}
	b.gallery, err = gallerycatalog.New(ctx, gallerycatalog.Dependencies{Store: db, Settings: initial, Jobs: jobs})
	if err != nil {
		return nil, err
	}
	b.reviews, err = reviews.New(ctx, reviews.Dependencies{Store: db, Settings: initial, Jobs: jobs, Runner: options.ReviewRunner, PythonExecutable: func() string { return b.modelSettings().Dedup.PythonExecutable }, Gallery: reviews.GalleryCallbacks{
		HoldSources:  b.gallery.WithSources,
		CheckFilters: b.checkFilters,
		ScanSource:   func(ctx context.Context, id string) error { _, err := b.gallery.Scan(ctx, id); return err },
		TrashAsset: func(ctx context.Context, asset, operation string, snapshot reviews.Snapshot) error {
			encoded, err := json.Marshal(snapshot)
			if err != nil {
				return err
			}
			var row map[string]any
			if err = json.Unmarshal(encoded, &row); err != nil {
				return err
			}
			_, err = b.gallery.TrashForReview(ctx, operation, gallerycatalog.Selection{AssetIDs: []string{asset}}, map[string]gallerycatalog.Row{asset: row})
			return err
		},
		RestoreTrash: func(ctx context.Context, operation string) error {
			_, err := b.gallery.Restore(ctx, operation)
			return err
		},
		ReconcileCrawl: b.reconcileReview,
	}})
	if err != nil {
		return nil, err
	}
	b.crawls, err = crawls.New(ctx, crawls.Dependencies{Store: db, Settings: initial, Jobs: jobs, Discovery: b.discovery, Tasks: task.service,
		PolicyFor: func(ctx context.Context, site string) (scheduler.Policy, error) {
			return runtimePolicy(ctx, settings.snapshot(), db, site)
		},
		Credentials: func(ctx context.Context, site string, request crawls.CredentialsRequest) (crawls.Credentials, error) {
			c, err := searchCredentials(ctx, settings.snapshot(), vault, site, search.SourceOptions{CredentialsRef: request.Reference, CookiesFile: request.CookiesFile, ConfigFile: request.ConfigFile})
			return crawls.Credentials{Reference: c.Reference, CookiesFile: c.CookiesFile, ConfigFile: c.ConfigFile}, err
		},
		ValidateArgs:   task.runner.ValidateArgs,
		ValidateTarget: b.discovery.Transport.ValidateTarget,
		Resolve: func(ctx context.Context, target string) (tasks.SiteInfo, error) {
			r, err := task.runner.Resolve(ctx, target)
			return tasks.SiteInfo{Site: r.Site, Subcategory: r.Subcategory, Extractor: r.Extractor, Supported: r.Supported, Host: r.Host}, err
		},
		ResolveBatch: func(ctx context.Context, targets []string) ([]tasks.SiteInfo, error) {
			resolved, err := task.runner.ResolveBatch(ctx, targets)
			if err != nil {
				return nil, err
			}
			infos := make([]tasks.SiteInfo, len(resolved))
			for i, info := range resolved {
				infos[i] = tasks.SiteInfo(info)
			}
			return infos, nil
		},
		ProbeForTarget: pool.ProbeForTarget, NotifyTasks: task.scheduler.Notify, BatchComplete: b.batchFinished,
	})
	if err != nil {
		return nil, err
	}
	b.datasets, err = datasets.New(ctx, datasets.Dependencies{Store: db, Settings: initial, Jobs: jobs, Events: events,
		Catalog: datasetCatalog{b.gallery}, Images: datasetImages{b.gallery},
		RegisterExport: func(ctx context.Context, path string, committed *os.File) error {
			return datasetPeerError(b.gallery.RegisterDatasetExport(ctx, path, committed))
		},
		Crawls: datasets.CrawlCallback(func(ctx context.Context, raw json.RawMessage, key string) (string, error) {
			request, err := crawls.DecodeRequest(raw)
			if err != nil {
				return "", datasetPeerError(err)
			}
			var idempotency *string
			if key != "" {
				idempotency = &key
			}
			row, _, err := b.crawls.Create(ctx, request, idempotency)
			if err != nil {
				return "", datasetPeerError(err)
			}
			return valueString(row["id"]), nil
		}),
	})
	if err != nil {
		return nil, err
	}
	b.workbench = b.newWorkbench(vault)
	b.danbooru = danboorucollect.New(danboorucollect.Dependencies{
		Store: db, Datasets: b.datasets, Transport: b.discovery.Danbooru.Transport, Browse: b.discovery.Danbooru.Browse,
		Request: func(ctx context.Context) (discovery.Request, error) {
			policy, err := runtimePolicy(ctx, settings.snapshot(), db, "danbooru")
			if err != nil {
				return discovery.Request{}, err
			}
			resolved, err := searchCredentials(ctx, settings.snapshot(), vault, "danbooru", search.SourceOptions{})
			if err != nil {
				return discovery.Request{}, err
			}
			return discovery.Request{Site: "danbooru", Policy: policy, ProxyMode: policy.ProxyMode, ConfigFile: resolved.ConfigFile, CookiesFile: resolved.CookiesFile, CredentialsRef: resolved.Reference, TimeoutSeconds: 60}, nil
		},
		CreateCrawl: func(ctx context.Context, datasetID string, raw json.RawMessage, key string) (map[string]any, error) {
			link, err := b.datasets.StartCrawl(ctx, datasetID, raw, key)
			if err != nil {
				return nil, err
			}
			return map[string]any{"id": link["batch_id"]}, nil
		},
	})
	if b.collect, err = b.newCollect(vault, task.runner, options.Search, options.AuthStatus); err != nil {
		return nil, err
	}
	b.gallery.AddScanListener(func(id string) {
		if err := b.datasets.OnScanCommitted(ctx, id); err != nil && ctx.Err() == nil {
			log.Printf("dataset scan reconciliation: %v", err)
		}
	})
	if err = b.newPipeline(jobs, events, options.Downloads); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *businessRuntime) start() error {
	if err := b.gallery.Start(); err != nil {
		return err
	}
	if err := b.pipeline.captions.Start(); err != nil {
		return err
	}
	if err := b.datasets.Start(); err != nil {
		return err
	}
	// Restore catalog links before an old pending review can move a batch's files.
	rows, err := b.db.QueryRows(b.ctx, "SELECT id FROM crawl_batches WHERE status IN ('succeeded','completed_with_errors','cancelled') ORDER BY created_at,id")
	if err != nil {
		return err
	}
	for _, row := range rows {
		batch, err := b.crawls.Get(b.ctx, valueString(row["id"]))
		if err != nil {
			return err
		}
		if err = b.batchFinished(b.ctx, batch); err != nil {
			log.Printf("batch reconciliation deferred: %v", err)
		}
	}
	if err := b.reviews.Start(); err != nil {
		return err
	}
	if err := b.pipeline.start(); err != nil {
		return err
	}
	return b.crawls.Start()
}
func (b *businessRuntime) stop() error {
	b.cancel()
	var result error
	if b.crawls != nil {
		result = errors.Join(result, b.crawls.Stop())
	}
	if b.pipeline != nil {
		result = errors.Join(result, b.pipeline.stop())
	}
	if b.reviews != nil {
		result = errors.Join(result, b.reviews.Stop())
	}
	if b.datasets != nil {
		result = errors.Join(result, b.datasets.Stop())
	}
	if b.gallery != nil {
		result = errors.Join(result, b.gallery.Stop())
	}
	return result
}
func (b *businessRuntime) register(mux *http.ServeMux) {
	b.crawls.Register(mux)
	b.gallery.Register(mux)
	b.reviews.Register(mux)
	b.datasets.Register(mux)
	mux.Handle("/api/v1/danbooru/", b.danbooru.Handler())
	mux.Handle("POST /api/v1/datasets/{dataset_id}/danbooru/collect", b.danbooru.Handler())
	b.workbench.Register(mux)
	b.collect.Register(mux)
	b.pipeline.register(mux)
}

func (b *businessRuntime) batchFinished(ctx context.Context, batch map[string]any) error {
	id := valueString(batch["id"])
	root := valueString(batch["output_dir"])
	if st, err := os.Stat(root); err == nil && st.IsDir() && b.settings.snapshot().Dedup.Enabled {
		if _, err = b.reviews.StartCrawl(ctx, id); err != nil {
			return err
		}
	}
	review, err := b.db.QueryRow(ctx, "SELECT status,rejected_image_count FROM crawl_reviews WHERE batch_id=?", id)
	if err != nil {
		return err
	}
	sourceRows, err := b.db.QueryRows(ctx, "SELECT DISTINCT site FROM crawl_addresses WHERE batch_id=? ORDER BY site", id)
	if err != nil {
		return err
	}
	sites := []string{}
	seen := map[string]bool{}
	for _, source := range sourceRows {
		site := valueString(source["site"])
		if site != "" && !seen[site] {
			sites = append(sites, site)
			seen[site] = true
		}
	}
	sort.Strings(sites)
	title := strings.Join(sites, "、")
	if title == "" {
		title = "爬取"
	}
	created := time.Unix(int64(valueFloat(batch["created_at"])), 0).In(time.Local).Format("2006-01-02")
	if _, err = b.gallery.AutoRegisterBatchSource(ctx, id, root, title+" 批次 "+created, review != nil); err != nil {
		return err
	}
	if review != nil {
		status := valueString(review["status"])
		if status == "applied" || status == "apply_failed" || valueFloat(review["rejected_image_count"]) > 0 {
			images, err := b.db.QueryRows(ctx, "SELECT * FROM crawl_review_images WHERE batch_id=?", id)
			if err != nil {
				return err
			}
			if err = b.reconcileReview(ctx, id, images); err != nil {
				return err
			}
		} else {
			if err = b.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
				_, e := tx.ExecContext(ctx, "UPDATE gallery_sources SET dedup_required=1,dedup_state='pending_analysis' WHERE batch_id=? AND dedup_required=0", id)
				return e
			}); err != nil {
				return err
			}
		}
	}
	return b.datasets.OnBatchFinished(ctx, id)
}
func (b *businessRuntime) reconcileReview(ctx context.Context, batchID string, images []reviews.Row) error {
	retained, excluded, rejected := []string{}, []string{}, []string{}
	for _, image := range images {
		original := valueString(image["relative_path"])
		final := valueString(image["final_relative_path"])
		switch valueString(image["disposition"]) {
		case "kept":
			if final == "" {
				final = original
			}
			retained = append(retained, final)
		case "rejected":
			excluded = append(excluded, original)
			if final != "" {
				rejected = append(rejected, final)
			}
		}
	}
	_, err := b.gallery.ReconcileReviewResult(ctx, batchID, retained, excluded, rejected)
	if err != nil {
		return err
	}
	rows, err := b.db.QueryRows(ctx, "SELECT DISTINCT r.dataset_id FROM dataset_roots r JOIN gallery_sources s ON s.id=r.source_id WHERE s.batch_id=?", batchID)
	if err != nil {
		return err
	}
	for _, row := range rows {
		b.datasets.PublishUpdated(valueString(row["dataset_id"]), "members")
	}
	return nil
}

type datasetCatalog struct{ catalog *gallerycatalog.Service }

func (a datasetCatalog) ImportSource(ctx context.Context, path, name string) (string, error) {
	r, e := a.catalog.ImportSource(ctx, path, name)
	if e != nil {
		return "", datasetPeerError(e)
	}
	return valueString(r["source_id"]), nil
}
func (a datasetCatalog) StartScan(ctx context.Context, id string) error {
	_, e := a.catalog.StartScan(ctx, id)
	var ce *gallerycatalog.Error
	if errors.As(e, &ce) && ce.Code == "scan_in_progress" {
		return nil
	}
	return datasetPeerError(e)
}

type datasetImages struct{ catalog *gallerycatalog.Service }

func (a datasetImages) LockSource(ctx context.Context, id string) (func(), error) {
	return a.catalog.LockSources(ctx, id)
}
func (a datasetImages) OpenImage(ctx context.Context, id, relative string) (*os.File, error) {
	root, e := a.catalog.OpenSource(ctx, id)
	if e != nil {
		return nil, e
	}
	defer root.Close()
	f, e := root.Open(relative)
	if e != nil {
		return nil, e
	}
	if e = root.AssertCurrent(); e != nil {
		f.Close()
		return nil, e
	}
	return f, nil
}
func datasetPeerError(err error) error {
	if err == nil {
		return nil
	}
	var galleryError *gallerycatalog.Error
	if errors.As(err, &galleryError) {
		return &datasets.Error{Status: galleryError.Status, Code: galleryError.Code, Message: galleryError.Code, Details: galleryError.Details}
	}
	var crawlError *crawls.Error
	if errors.As(err, &crawlError) {
		return &datasets.Error{Status: crawlError.Status, Code: crawlError.Code, Message: crawlError.Message, Details: crawlError.Details}
	}
	return err
}
func valueString(value any) string { v, _ := value.(string); return v }
func valueFloat(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case int64:
		return float64(v)
	case json.Number:
		n, _ := v.Float64()
		return n
	}
	return 0
}

func (b *businessRuntime) enableDedup() error {
	if err := b.reviews.Enable(); err != nil {
		return err
	}
	b.settings.enableDedup()
	rows, err := b.db.QueryRows(b.ctx, "SELECT id FROM crawl_batches WHERE status IN ('succeeded','completed_with_errors','cancelled')")
	if err != nil {
		return err
	}
	for _, row := range rows {
		batch, err := b.crawls.Get(b.ctx, valueString(row["id"]))
		if err != nil {
			return err
		}
		if err = b.batchFinished(b.ctx, batch); err != nil {
			return fmt.Errorf("enable review reconciliation: %w", err)
		}
	}
	return nil
}
