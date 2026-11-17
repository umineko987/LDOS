package datasets

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPathImportResolvesExistingSourceAndRejectsAncestor(t *testing.T) {
	f := newFixture(t, map[string]string{"sub/a.png": "a"})
	scans, imports := 0, 0
	f.s.deps.Catalog = CatalogCallbacks{Import: func(ctx context.Context, path, name string) (string, error) {
		imports++
		if name != "new" {
			t.Error(name)
		}
		source := "imported"
		f.exec(`INSERT INTO gallery_sources(id,kind,display_name,root_path,canonical_root_key,created_at,updated_at) VALUES(?,'imported',?,?,?,1,1)`, source, name, path, path)
		return source, nil
	}, Scan: func(context.Context, string) error { scans++; return nil }}
	r, created, e := f.s.AttachPath(f.ctx, f.dataset, filepath.Join(f.root, "sub"), "")
	if e != nil || !created || r["relative_path"] != "sub" || imports != 0 || scans != 1 {
		t.Fatal(r, created, e, imports, scans)
	}
	_, _, e = f.s.AttachPath(f.ctx, f.dataset, filepath.Dir(f.root), "")
	assertCode(t, e, "source_path_conflict")
	fresh := filepath.Join(filepath.Dir(f.root), "import")
	if e = os.Mkdir(fresh, 0700); e != nil {
		t.Fatal(e)
	}
	r, created, e = f.s.AttachPath(f.ctx, f.dataset, fresh, "new")
	if e != nil || !created || r["source_id"] != "imported" || imports != 1 || scans != 2 || r["available"] != false {
		t.Fatal(r, created, e, imports, scans)
	}
}
func TestLinkedCrawlCallbacksAndReconciliation(t *testing.T) {
	f := newFixture(t, map[string]string{"batch/image.png": "image"})
	output := filepath.Join(f.root, "batch")
	f.exec(`INSERT INTO crawl_batches(id,status,output_dir,concurrency,max_tasks,created_at,updated_at) VALUES('batch','running',?,1,100,1,1)`, output)
	calls := 0
	f.s.deps.Crawls = CrawlCallback(func(ctx context.Context, request json.RawMessage, key string) (string, error) {
		calls++
		if key != "idempotency" || string(request) != `{"sources":[]}` {
			t.Errorf("callback: %s %s", request, key)
		}
		return "batch", nil
	})
	scans := 0
	f.s.deps.Catalog = CatalogCallbacks{Scan: func(context.Context, string) error { scans++; return nil }}
	r, e := f.s.StartCrawl(f.ctx, f.dataset, json.RawMessage(`{"sources":[]}`), "idempotency")
	if e != nil || r["state"] != "pending" || calls != 1 {
		t.Fatal(r, e, calls)
	}
	f.exec("UPDATE crawl_batches SET status='completed_with_errors' WHERE id='batch'")
	if e = f.s.OnBatchFinished(f.ctx, "batch"); e != nil {
		t.Fatal(e)
	}
	rows, e := f.s.ListCrawls(f.ctx, f.dataset)
	if e != nil || len(rows) != 1 || rows[0]["state"] != "attached" || str(rows[0]["root_id"]) == "" || scans != 1 {
		t.Fatal(rows, e, scans)
	}
	roots, e := f.s.ListRoots(f.ctx, f.dataset)
	if e != nil || len(roots) != 2 {
		t.Fatal(roots, e)
	}
	if roots[1]["origin"] != "crawl" || roots[1]["relative_path"] != "batch" {
		t.Fatal(roots)
	}
	r, e = f.s.RegisterCrawl(f.ctx, f.dataset, "batch")
	if e != nil || r["state"] != "attached" {
		t.Fatal(r, e)
	}
	if e = f.s.DetachRoot(f.ctx, f.dataset, str(r["root_id"])); e != nil {
		t.Fatal(e)
	}
	result, e := f.s.Reconcile(f.ctx)
	if e != nil || num(result["attached_crawls"]) != 0 {
		t.Fatal(result, e)
	}
	roots, e = f.s.ListRoots(f.ctx, f.dataset)
	if e != nil || len(roots) != 1 {
		t.Fatal("detached crawl root resurrected", roots, e)
	}
}
func TestReconcilePendingRegisteredBatchSource(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "image"})
	f.exec(`INSERT INTO crawl_batches(id,status,output_dir,concurrency,max_tasks,created_at,updated_at) VALUES('batch','cancelled',?,1,100,1,1)`, f.root)
	f.exec("UPDATE gallery_sources SET batch_id='batch',kind='batch'")
	f.exec(`INSERT INTO dataset_crawls(dataset_id,batch_id,state,created_at,updated_at) VALUES(?,'batch','pending',1,1)`, f.dataset)
	r, e := f.s.Reconcile(f.ctx)
	if e != nil || num(r["attached_crawls"]) != 1 {
		t.Fatal(r, e)
	}
	rows, e := f.s.ListCrawls(f.ctx, f.dataset)
	if e != nil || rows[0]["state"] != "attached" {
		t.Fatal(rows, e)
	}
	if e = f.s.OnScanCommitted(f.ctx, f.source); e != nil {
		t.Fatal(e)
	}
	if e = f.s.WaitHashing(f.ctx); e != nil {
		t.Fatal(e)
	}
}
func TestFailedCrawlOutputPersistsFailure(t *testing.T) {
	f := newFixture(t, map[string]string{})
	f.exec(`INSERT INTO crawl_batches(id,status,output_dir,concurrency,max_tasks,created_at,updated_at) VALUES('batch','succeeded',?,1,100,1,1)`, filepath.Join(f.root, "missing"))
	r, e := f.s.RegisterCrawl(f.ctx, f.dataset, "batch")
	if e != nil || r["state"] != "failed" || r["error_code"] != "crawl_output_missing" {
		t.Fatal(r, e)
	}
}
