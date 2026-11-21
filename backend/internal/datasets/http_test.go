package datasets

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestHTTPRouteSurfaceAndErrorEnvelope(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "image"})
	mux := http.NewServeMux()
	f.s.Register(mux)
	call := func(method, path, body string, want int) Record {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("X-Request-ID", "untrusted-client")
		w := httptest.NewRecorder()
		w.Header().Set("X-Request-ID", "middleware-request")
		mux.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		result := Record{}
		if want != 204 && want != 404 {
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
		}
		if want >= 400 && want != 404 {
			public := result["error"].(map[string]any)
			if public["request_id"] != "middleware-request" || public["code"] != "validation_error" || public["message"] != "请求参数校验失败" {
				t.Fatal(public)
			}
		}
		return result
	}
	prefix := "/api/v1/datasets/" + f.dataset
	for _, path := range []string{"/api/v1/datasets", prefix, prefix + "/roots", prefix + "/members", prefix + "/funnel", prefix + "/stage-runs", prefix + "/hashing", prefix + "/crawls", prefix + "/exports"} {
		call("GET", path, "", 200)
	}
	for _, query := range []string{"?stage=", "?decision=", "?limit=", "?limit=501"} {
		call("GET", prefix+"/members"+query, "", 422)
	}
	call("POST", prefix+"/hashing", "", 202)
	call("POST", prefix+"/decisions", `{"stage":"review","asset_ids":["a.png"],"decision":"approve"}`, 422)
	call("POST", prefix+"/decisions", `{"stage":"collect","asset_ids":["a.png"],"decision":"approve"}`, 200)
	body, _ := json.Marshal(Record{"target_path": f.target, "folder_name": "http", "dry_run": "true", "include_captions": "false", "repeats": "12"})
	preview := call("POST", prefix+"/exports", string(body), 200)
	if preview["dry_run"] != true || preview["job"] != nil {
		t.Fatal(preview)
	}
	body, _ = json.Marshal(Record{"target_path": f.target, "folder_name": "http", "include_captions": false})
	created := call("POST", prefix+"/exports", string(body), 202)
	id := str(created["job"].(map[string]any)["export_id"])
	finished, err := f.s.WaitExport(f.ctx, id)
	if err != nil || finished["status"] != "succeeded" {
		t.Fatal(finished, err)
	}
	call("GET", "/api/v1/exports/"+id, "", 200)
	// Peer routes must remain available to their owner: the dataset fallback is a 404.
	for _, suffix := range []string{"/captions", "/tagging", "/triage"} {
		call("GET", prefix+suffix, "", 404)
	}
	roots, err := f.s.ListRoots(f.ctx, f.dataset)
	if err != nil {
		t.Fatal(err)
	}
	call("DELETE", prefix+"/roots/"+str(roots[0]["root_id"]), "", 204)
	call("DELETE", prefix, "", 204)
	// Dataset removal does not erase the durable export history.
	call("GET", "/api/v1/exports/"+id, "", 200)
}

func TestCrawlReconciliationRetriesCallbackFailures(t *testing.T) {
	f := newFixture(t, map[string]string{"batch/a.png": "image"})
	output := filepath.Join(f.root, "batch")
	f.exec(`INSERT INTO crawl_batches(id,status,output_dir,concurrency,max_tasks,created_at,updated_at) VALUES('retry','succeeded',?,1,100,1,1)`, output)
	f.s.deps.Catalog = CatalogCallbacks{Scan: func(context.Context, string) error { return errors.New("temporary catalog failure") }}
	row, err := f.s.RegisterCrawl(f.ctx, f.dataset, "retry")
	if err != nil || row["state"] != "pending" {
		t.Fatal(row, err)
	}
	if _, err = f.s.Reconcile(f.ctx); err != nil {
		t.Fatal(err)
	}
	f.s.deps.Catalog = CatalogCallbacks{Scan: func(context.Context, string) error { return nil }}
	if err = f.s.OnBatchFinished(f.ctx, "retry"); err != nil {
		t.Fatal(err)
	}
	rows, err := f.s.ListCrawls(f.ctx, f.dataset)
	if err != nil || len(rows) != 1 || rows[0]["state"] != "attached" {
		t.Fatal(rows, err)
	}
}
