package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/config"
	"ldos/backend/internal/credentials"
	"ldos/backend/internal/datasets"
	"ldos/backend/internal/gallerycatalog"
	"ldos/backend/internal/reviews"
	"ldos/backend/internal/store"
)

func nativeBusinessFixture(t *testing.T, reviewEnabled bool) (*businessRuntime, string) {
	t.Helper()
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	self, err := os.Executable()
	nativeOK(t, err)
	executors := filepath.Join(root, "executors")
	repo := filepath.Join(root, "gallery")
	for _, p := range []string{filepath.Join(executors, "ldos_gallery/worker_entry.py"), filepath.Join(repo, "gallery_dl/__init__.py")} {
		nativeOK(t, os.MkdirAll(filepath.Dir(p), 0700))
		nativeOK(t, os.WriteFile(p, nil, 0600))
	}
	raw, err := json.Marshal(map[string]any{"runtime_dir": filepath.Join(root, "runtime"), "database_path": filepath.Join(root, "runtime/db.sqlite3"), "workspace_dir": filepath.Join(root, "workspace"), "default_output_root": filepath.Join(root, "downloads"), "allowed_output_roots": []string{root}, "allowed_cookie_roots": []string{filepath.Join(root, "cookies")}, "allowed_config_roots": []string{root}, "proxy": map[string]any{"enabled": false}, "server": map[string]any{"allow_private_targets": true}, "dedup": map[string]any{"enabled": reviewEnabled}, "gallery": map[string]any{"repo_path": repo, "python_executable": self, "cache_file": filepath.Join(root, "cache.sqlite3"), "migrate_default_auth": false}, "default_site_policy": map[string]any{"proxy_mode": "direct"}})
	nativeOK(t, err)
	p := filepath.Join(root, "config.json")
	nativeOK(t, os.WriteFile(p, raw, 0600))
	settings, err := config.Load(p, func(string) string { return "" })
	nativeOK(t, err)
	db, err := store.Open(settings.DatabasePath)
	nativeOK(t, err)
	t.Cleanup(func() { nativeOK(t, db.Close()) })
	bus := activity.NewBus(0)
	t.Cleanup(bus.Close)
	jobs := activity.NewRegistry(bus)
	proxy, err := newProxyRuntime(settings)
	nativeOK(t, err)
	t.Cleanup(func() { nativeOK(t, proxy.stop()) })
	vault, err := credentials.New(filepath.Join(settings.AllowedCookieRoots[0], "managed"))
	nativeOK(t, err)
	task, err := newTaskRuntime(settings, db, executors, schedulerPool{pool: proxy.pool})
	nativeOK(t, err)
	t.Cleanup(func() { nativeOK(t, task.stop()) })
	b, err := newBusinessRuntime(ctx, &liveSettings{value: settings}, db, jobs, bus, task, proxy.pool, vault, businessOptions{ReviewRunner: func(ctx context.Context, input reviews.WorkerInput) (reviews.Manifest, string, error) {
		items := []reviews.ManifestImage{}
		for _, v := range input.Images {
			items = append(items, reviews.ManifestImage{ID: v.AssetID, RelativePath: v.SourceID + "/" + v.RelativePath})
		}
		if input.BatchID != "" {
			entries, err := os.ReadDir(input.OutputDir)
			if err != nil {
				return reviews.Manifest{}, "", err
			}
			for _, entry := range entries {
				if !entry.IsDir() && filepath.Ext(entry.Name()) == ".png" {
					items = append(items, reviews.ManifestImage{ID: entry.Name(), RelativePath: entry.Name()})
				}
			}
		}
		kind := "single"
		if len(items) > 1 {
			kind = "duplicate"
		}
		return reviews.Manifest{SchemaVersion: 3, Root: input.OutputDir, ReviewID: input.ReviewID, FilterConfig: input.FilterConfig, Counts: map[string]int{"images": len(items)}, Groups: []reviews.ManifestGroup{{ID: "fixture-group", Kind: kind, Items: items}}}, "", ctx.Err()
	}})
	nativeOK(t, err)
	t.Cleanup(func() { nativeOK(t, b.stop()) })
	nativeOK(t, b.start())
	return b, root
}
func nativeOK(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func nativePicture(t *testing.T, path string, shade uint8) {
	t.Helper()
	nativeOK(t, os.MkdirAll(filepath.Dir(path), 0700))
	f, err := os.Create(path)
	nativeOK(t, err)
	im := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	im.SetNRGBA(0, 0, color.NRGBA{R: shade, A: 255})
	nativeOK(t, png.Encode(f, im))
	nativeOK(t, f.Close())
}
func nativeWait(t *testing.T, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatal("native handoff did not settle")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestNativeGalleryDatasetReviewAndExportHandoff(t *testing.T) {
	b, root := nativeBusinessFixture(t, true)
	ctx := b.ctx
	images := filepath.Join(root, "images")
	nativePicture(t, filepath.Join(images, "a.png"), 10)
	nativePicture(t, filepath.Join(images, "b.png"), 20)
	nativeOK(t, os.WriteFile(filepath.Join(images, "a.txt"), []byte("cat, blue"), 0600))
	source, err := b.gallery.ImportSource(ctx, images, "Fixture")
	nativeOK(t, err)
	sid := valueString(source["source_id"])
	_, err = b.gallery.Scan(ctx, sid)
	nativeOK(t, err)
	dataset, err := b.datasets.Create(ctx, datasets.CreateOptions{Name: "Fixture", Kind: "character", TriggerWord: "subject"})
	nativeOK(t, err)
	did := valueString(dataset["dataset_id"])
	_, _, err = b.datasets.AttachSource(ctx, did, sid)
	nativeOK(t, err)
	nativeOK(t, b.datasets.WaitHashing(ctx))
	members, err := b.datasets.MemberRows(ctx, did)
	nativeOK(t, err)
	if len(members) != 2 {
		t.Fatal(members)
	}
	a, bid := gallerycatalog.AssetID(sid, "a.png"), gallerycatalog.AssetID(sid, "b.png")
	review, err := b.reviews.CreateGallery(ctx, nil, []string{a, bid}, nil)
	nativeOK(t, err)
	rid := valueString(review["review_id"])
	nativeWait(t, func() bool {
		review, err = b.reviews.GetGallery(ctx, rid)
		nativeOK(t, err)
		if review["status"] == "failed" {
			t.Fatal(review)
		}
		return review["status"] == "ready"
	})
	review, err = b.reviews.AdoptGroup(ctx, rid, "fixture-group", []string{a}, int64(valueFloat(review["version"])), false)
	nativeOK(t, err)
	if review["failed_image_count"] != int64(0) {
		t.Fatal(review)
	}
	if _, err = os.Stat(filepath.Join(images, "b.png")); !os.IsNotExist(err) {
		t.Fatal("rejected image was not moved", err)
	}
	review, err = b.reviews.AdoptGroup(ctx, rid, "fixture-group", []string{a, bid}, int64(valueFloat(review["version"])), false)
	nativeOK(t, err)
	if review["failed_image_count"] != int64(0) {
		t.Fatal(review)
	}
	_, err = os.Stat(filepath.Join(images, "b.png"))
	nativeOK(t, err)
	annotation, err := b.gallery.GetAnnotation(ctx, a)
	nativeOK(t, err)
	_, err = b.gallery.SaveAnnotation(ctx, a, "cat, edited", int64(valueFloat(annotation["txt_version"])), valueString(annotation["disk_version"]))
	nativeOK(t, err)
	target := filepath.Join(root, "exports")
	nativeOK(t, os.MkdirAll(target, 0700))
	exported, err := b.datasets.CreateExport(ctx, did, datasets.Record{"target_path": target, "folder_name": "fixture", "layout": "flat", "include_captions": true})
	nativeOK(t, err)
	exported, err = b.datasets.WaitExport(ctx, valueString(exported["export_id"]))
	nativeOK(t, err)
	if exported["status"] != "succeeded" {
		t.Fatal(exported)
	}
	foundCaption := false
	nativeOK(t, filepath.WalkDir(target, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Name() == "a.txt" {
			foundCaption = true
			data, e := os.ReadFile(path)
			if e != nil {
				return e
			}
			if string(data) != "subject, cat, edited" {
				t.Fatal(string(data))
			}
		}
		return nil
	}))
	if !foundCaption {
		t.Fatal("export omitted the edited caption")
	}

	// Final review operates on the auto-indexed copy, not the dataset roots.
	out := valueString(exported["output_path"])
	copySource, err := b.db.QueryRow(ctx, "SELECT id FROM gallery_sources WHERE root_path=?", out)
	nativeOK(t, err)
	if copySource == nil || copySource["id"] == sid || exported["gallery_warning"] != nil {
		t.Fatalf("export was not handed off to a separate source: %v %v", copySource, exported)
	}
	copyAsset := gallerycatalog.AssetID(valueString(copySource["id"]), "a.png")
	before, err := b.datasets.StageInputDigest(ctx, did, "export")
	nativeOK(t, err)
	op, err := b.gallery.Trash(ctx, gallerycatalog.Selection{AssetIDs: []string{copyAsset}})
	nativeOK(t, err)
	for _, name := range []string{"a.png", "a.txt"} {
		if _, err := os.Stat(filepath.Join(out, name)); !os.IsNotExist(err) {
			t.Fatalf("exported %s was not moved to trash: %v", name, err)
		}
		_, err := os.Stat(filepath.Join(images, name))
		nativeOK(t, err)
	}
	after, err := b.datasets.StageInputDigest(ctx, did, "export")
	nativeOK(t, err)
	if after != before {
		t.Fatal("reviewing the export changed the original dataset's inputs")
	}
	_, err = b.gallery.Undo(ctx, op.OperationID)
	nativeOK(t, err)
	caption, err := os.ReadFile(filepath.Join(out, "a.txt"))
	nativeOK(t, err)
	if string(caption) != "subject, cat, edited" {
		t.Fatalf("restored wrong caption: %q", caption)
	}
}

func TestNativeCompletedCrawlRegistersGalleryAndDatasetOnce(t *testing.T) {
	b, root := nativeBusinessFixture(t, false)
	ctx := b.ctx
	output := filepath.Join(root, "downloads/batch")
	nativePicture(t, filepath.Join(output, "image.png"), 30)
	nativeOK(t, b.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO crawl_batches(id,status,output_dir,concurrency,max_tasks,created_at,updated_at) VALUES('fixture','running',?,1,100,1,1)`, output)
		return err
	}))
	dataset, err := b.datasets.Create(ctx, datasets.CreateOptions{Name: "Crawl", Kind: "character"})
	nativeOK(t, err)
	did := valueString(dataset["dataset_id"])
	_, err = b.datasets.RegisterCrawl(ctx, did, "fixture")
	nativeOK(t, err)
	nativeOK(t, b.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "UPDATE crawl_batches SET status='succeeded',finished_at=2 WHERE id='fixture'")
		return err
	}))
	batch, err := b.crawls.Get(ctx, "fixture")
	nativeOK(t, err)
	nativeOK(t, b.batchFinished(ctx, batch))
	nativeOK(t, b.batchFinished(ctx, batch))
	nativeWait(t, func() bool {
		members, err := b.datasets.MemberRows(ctx, did)
		nativeOK(t, err)
		return len(members) == 1
	})
	sources, err := b.gallery.ListSources(ctx)
	nativeOK(t, err)
	roots, err := b.datasets.ListRoots(ctx, did)
	nativeOK(t, err)
	if len(sources) != 1 || len(roots) != 1 {
		t.Fatal(sources, roots)
	}
}
