package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/captions"
	"ldos/backend/internal/datasets"
	"ldos/backend/internal/datasetstages"
	"ldos/backend/internal/diagnostics"
	"ldos/backend/internal/downloads"
	"ldos/backend/internal/gallerycatalog"
	"ldos/backend/internal/httpapi"
	"ldos/backend/internal/policy"
	"ldos/backend/internal/reviews"
)

func attachNativeDataset(t *testing.T, b *businessRuntime, path string) (string, string) {
	t.Helper()
	source, err := b.gallery.ImportSource(b.ctx, path, "Pipeline")
	nativeOK(t, err)
	sid := valueString(source["source_id"])
	_, err = b.gallery.Scan(b.ctx, sid)
	nativeOK(t, err)
	dataset, err := b.datasets.Create(b.ctx, datasets.CreateOptions{Name: "Pipeline", Kind: "style"})
	nativeOK(t, err)
	did := valueString(dataset["dataset_id"])
	_, _, err = b.datasets.AttachSource(b.ctx, did, sid)
	nativeOK(t, err)
	nativeOK(t, b.datasets.WaitHashing(b.ctx))
	return did, sid
}
func TestNativeCaptionBOMUndoAndExternalConflict(t *testing.T) {
	b, root := nativeBusinessFixture(t, false)
	images := filepath.Join(root, "images")
	nativePicture(t, filepath.Join(images, "a.png"), 30)
	original := "\ufeffcat, original"
	path := filepath.Join(images, "a.txt")
	nativeOK(t, os.WriteFile(path, []byte(original), 0600))
	did, sid := attachNativeDataset(t, b, images)
	id := gallerycatalog.AssetID(sid, "a.png")
	annotations, err := b.readAnnotations(b.ctx, []string{id})
	nativeOK(t, err)
	if !annotations[id].BOM {
		t.Fatal("BOM omitted from caption snapshot")
	}
	result, err := b.pipeline.captions.Edit(b.ctx, did, id, "cat, edited", annotations[id].DiskVersion)
	nativeOK(t, err)
	content, err := os.ReadFile(path)
	nativeOK(t, err)
	if string(content) != "cat, edited" {
		t.Fatalf("caption normalization changed: %q", content)
	}
	_, err = b.pipeline.captions.Undo(b.ctx, valueString(result["batch_id"]))
	nativeOK(t, err)
	content, err = os.ReadFile(path)
	nativeOK(t, err)
	if string(content) != original {
		t.Fatalf("undo did not restore caption: %q", content)
	}
	annotations, err = b.readAnnotations(b.ctx, []string{id})
	nativeOK(t, err)
	nativeOK(t, os.WriteFile(path, []byte("external edit"), 0600))
	_, err = b.pipeline.captions.Edit(b.ctx, did, id, "overwrite", annotations[id].DiskVersion)
	var conflict *captions.Error
	if !errors.As(err, &conflict) || conflict.Code != "caption_version_conflict" {
		t.Fatal(err)
	}
	content, err = os.ReadFile(path)
	nativeOK(t, err)
	if string(content) != "external edit" {
		t.Fatal("external edit overwritten")
	}
	public, err := b.gallery.GetAnnotation(b.ctx, id)
	nativeOK(t, err)
	if _, ok := public["bom"]; ok {
		t.Fatal("private BOM metadata added to HTTP projection")
	}
}
func TestNativeDatasetReviewAcceptsCompleteInput(t *testing.T) {
	b, root := nativeBusinessFixture(t, true)
	images := filepath.Join(root, "images")
	for i := 0; i < 205; i++ {
		nativePicture(t, filepath.Join(images, fmt.Sprintf("%03d.png", i)), uint8(i))
	}
	did, _ := attachNativeDataset(t, b, images)
	members, err := b.datasets.MemberRows(b.ctx, did)
	nativeOK(t, err)
	ids := []string{}
	for _, m := range members {
		ids = append(ids, valueString(m["asset_id"]))
	}
	_, err = b.reviews.CreateGallery(b.ctx, nil, ids, nil)
	var bounded *reviews.Error
	if !errors.As(err, &bounded) || bounded.Status != 422 {
		t.Fatalf("interactive gallery lost its input bound: %v", err)
	}
	summary, err := b.pipeline.stages.Run(b.ctx, did, "dedup", datasetstages.RunOptions{})
	nativeOK(t, err)
	nativeWait(t, func() bool {
		summary, err = b.pipeline.stages.Summary(b.ctx, did, "dedup")
		nativeOK(t, err)
		run := summary["run"].(map[string]any)
		if run["status"] == "failed" {
			t.Fatal(summary)
		}
		return run["status"] == "succeeded"
	})
	rid := valueString(summary["review_id"])
	review, err := b.reviews.GetGallery(b.ctx, rid)
	nativeOK(t, err)
	if valueFloat(review["total_image_count"]) != 205 {
		t.Fatal("dataset input truncated", review)
	}
}
func TestNativeCrawlReviewJournalSurvivesRescan(t *testing.T) {
	b, root := nativeBusinessFixture(t, true)
	output := filepath.Join(root, "downloads/batch")
	nativePicture(t, filepath.Join(output, "a.png"), 10)
	nativePicture(t, filepath.Join(output, "b.png"), 20)
	nativeOK(t, b.db.WriteTransaction(b.ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(b.ctx, `INSERT INTO crawl_batches(id,status,output_dir,concurrency,max_tasks,created_at,updated_at,finished_at) VALUES('review-batch','succeeded',?,1,100,1,1,2)`, output)
		return err
	}))
	batch, err := b.crawls.Get(b.ctx, "review-batch")
	nativeOK(t, err)
	nativeOK(t, b.batchFinished(b.ctx, batch))
	nativeWait(t, func() bool {
		r, err := b.reviews.GetCrawl(b.ctx, "review-batch")
		nativeOK(t, err)
		if r["status"] == "failed" {
			t.Fatal(r)
		}
		return r["status"] == "ready"
	})
	sources, err := b.gallery.ListSources(b.ctx)
	nativeOK(t, err)
	if len(sources) != 1 {
		t.Fatal(sources)
	}
	sid := valueString(sources[0]["source_id"])
	_, err = b.gallery.Scan(b.ctx, sid)
	nativeOK(t, err)
	_, err = b.reviews.UpdateCrawlDecisions(b.ctx, "review-batch", []reviews.Decision{{GroupID: "fixture-group", SelectedImageIDs: []string{"a.png"}}})
	nativeOK(t, err)
	result, err := b.reviews.ApplyCrawl(b.ctx, "review-batch")
	nativeOK(t, err)
	if result["status"] != "applied" {
		t.Fatal(result)
	}
	event, err := b.db.QueryRow(b.ctx, "SELECT * FROM gallery_reconciliation_events WHERE batch_id='review-batch'")
	nativeOK(t, err)
	if event["status"] != "applied" {
		t.Fatal("review journal was not applied", event)
	}
	_, err = b.gallery.Scan(b.ctx, sid)
	nativeOK(t, err)
	rows, err := b.db.QueryRows(b.ctx, "SELECT relative_path,dedup_visibility FROM gallery_assets WHERE source_id=? AND lifecycle_state='active' ORDER BY relative_path", sid)
	nativeOK(t, err)
	if len(rows) != 2 || rows[0]["relative_path"] != "a.png" || rows[0]["dedup_visibility"] != "kept" || rows[1]["dedup_visibility"] != "excluded" {
		t.Fatal(rows)
	}
	nativePicture(t, filepath.Join(output, "b.png"), 99)
	_, err = b.gallery.Scan(b.ctx, sid)
	nativeOK(t, err)
	fresh, err := b.db.QueryRow(b.ctx, "SELECT dedup_visibility FROM gallery_assets WHERE source_id=? AND relative_path='b.png'", sid)
	nativeOK(t, err)
	if fresh["dedup_visibility"] == "excluded" {
		t.Fatal("new file at a rejected original path stayed excluded", fresh)
	}
}
func TestNativeHTTPContractRoutesMounted(t *testing.T) {
	b, root := nativeBusinessFixture(t, false)
	settings := b.settings.snapshot()
	bus := activity.NewBus(0)
	defer bus.Close()
	jobs := activity.NewRegistry(bus)
	proxy, err := newProxyRuntime(settings)
	nativeOK(t, err)
	defer proxy.stop()
	downloadSettings := downloads.NewWithPool(settings.RuntimeDir, downloadPool{pool: proxy.pool})
	auth, vault, err := newAuthorizationRuntime(b.ctx, settings, downloadSettings)
	nativeOK(t, err)
	defer auth.Stop()
	task, err := newTaskRuntime(settings, b.db, filepath.Join(root, "executors"), schedulerPool{pool: proxy.pool})
	nativeOK(t, err)
	defer task.stop()
	search, err := newSearchRuntime(settings, b.db, task.runner, proxy.pool, vault, auth)
	nativeOK(t, err)
	diagnostic := diagnostics.New(b.ctx, b.modelSettings)
	defer diagnostic.Stop()
	var mux *http.ServeMux
	httpapi.New(settings, b.db, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { httpapi.JSON(w, 200, jobs.List()) }), bus, downloadSettings, policy.New(settings.DefaultSitePolicy, b.db),
		httpapi.WithProxy(proxy.handler), httpapi.WithAuthorization(auth.Handler()), httpapi.WithTasks(task.service), httpapi.WithSearch(search), b.register,
		httpapi.WithDiagnostics(httpapi.RuntimeDiagnostics{Settings: b.modelSettings, Tasks: task.scheduler.Summary, Crawls: b.crawls.Status, Ready: func(ctx context.Context) map[string]any {
			return diagnostic.Readiness(ctx, true, proxy.pool.Status(), proxy.pool.HealthSummary(), task.scheduler.Summary(), b.crawls.Status())
		}}),
		func(m *http.ServeMux) { mux = m },
	)
	placeholder := regexp.MustCompile(`\{[^}]+\}`)
	for _, route := range httpapi.ContractRoutes() {
		path := placeholder.ReplaceAllString(route.Path, "fixture")
		_, pattern := mux.Handler(&http.Request{Method: route.Method, URL: &url.URL{Path: path}})
		if pattern == "" {
			t.Errorf("missing original route: %s %s", route.Method, route.Path)
		}
	}
}
