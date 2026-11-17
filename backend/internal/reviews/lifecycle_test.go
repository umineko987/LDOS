package reviews

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ldos/backend/internal/activity"
)

func TestEnableAfterDisabledStartAndActivityContract(t *testing.T) {
	f := newFixture(t, false)
	f.crawl("crawl")
	f.file("a.jpg")
	f.exec("INSERT INTO crawl_reviews(batch_id,status,created_at,updated_at) VALUES('crawl','pending',1,1)")
	f.s.deps.Jobs = activity.NewRegistry(activity.NewBus(0))
	f.s.SetActivityDescription(func(ctx context.Context, id string) (string, map[string]string) {
		return "Dataset triage", map[string]string{"dataset_id": "dataset", "stage": "triage"}
	})
	var calls atomic.Int32
	f.s.deps.Runner = func(ctx context.Context, input WorkerInput) (Manifest, string, error) {
		calls.Add(1)
		input.Images = []Snapshot{{AssetID: "image-1", RelativePath: "a.jpg"}}
		return fakeManifest(input, "manual"), "", nil
	}
	if e := f.s.Start(); e != nil {
		t.Fatal(e)
	}
	if worked, e := f.s.RunOnce(f.ctx); worked || e != nil {
		t.Fatal(worked, e)
	}
	if calls.Load() != 0 {
		t.Fatal("disabled worker executed")
	}
	var wg sync.WaitGroup
	for n := 0; n < 12; n++ {
		wg.Go(func() {
			if e := f.s.Enable(); e != nil {
				t.Error(e)
			}
		})
	}
	wg.Wait()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		v, e := f.s.GetCrawl(f.ctx, "crawl")
		if e != nil {
			t.Fatal(e)
		}
		if text(v["status"]) == "ready" {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if e := f.s.Stop(); e != nil {
		t.Fatal(e)
	}
	v, e := f.s.GetCrawl(f.ctx, "crawl")
	assertStatus(t, v, "ready", e)
	if calls.Load() != 1 {
		t.Fatal("duplicate processing", calls.Load())
	}
	job := f.s.deps.Jobs.Get("review:crawl")
	if job == nil || job.Kind != "dedup.review" || job.Title != "Dataset triage" || job.Ref["dataset_id"] != "dataset" || job.Ref["stage"] != "triage" {
		t.Fatalf("wrong activity: %#v", job)
	}
	if e = f.s.Enable(); !errors.Is(e, context.Canceled) {
		t.Fatal("enabled stopped service", e)
	}
}
func TestCallerCancellationRollsBackOwnedTransaction(t *testing.T) {
	f := newFixture(t, true)
	ctx, cancel := context.WithCancel(f.ctx)
	e := f.s.write(ctx, func(tx *sql.Tx) error {
		_, e := tx.ExecContext(ctx, "INSERT INTO meta(key,value) VALUES('review-test-cancelled','bad')")
		cancel()
		return e
	})
	if e == nil {
		t.Fatal("committed cancelled owner")
	}
	row, e := f.db.QueryRow(f.ctx, "SELECT value FROM meta WHERE key='review-test-cancelled'")
	if e != nil || row != nil {
		t.Fatal(row, e)
	}
}
func TestGalleryHTTPContractAndLegacyRetryFailurePreservesMarker(t *testing.T) {
	f := newFixture(t, true)
	f.source("src", "a.jpg")
	w := f.request("POST", "/api/v1/gallery/reviews", `{"asset_ids":["src-1"]}`)
	if w.Code != 202 || !strings.Contains(w.Body.String(), `"response_profile":"desktop-gallery-review-operation-v1"`) || strings.Contains(w.Body.String(), `"groups"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	row, e := f.db.QueryRow(f.ctx, "SELECT review_id FROM gallery_reviews")
	if e != nil {
		t.Fatal(e)
	}
	id := text(row["review_id"])
	f.run()
	w = f.request("GET", "/api/v1/gallery/reviews/"+id, "")
	for _, key := range []string{`"asset_id":"src-1"`, `"source_id":"src"`, `"relative_path":"a.jpg"`, `"byte_truncated":false`, `"filter_config":null`} {
		if !strings.Contains(w.Body.String(), key) {
			t.Fatal(key, w.Body.String())
		}
	}
	if w.Code != 200 || strings.Contains(w.Body.String(), f.root) {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, body := range []string{`{"asset_ids":null}`, `{"asset_ids":["src-1"],"filter_config":{"preset_name":"x"}}`, `{"asset_ids":["src-1"],"filter_config":{"preset_name":"x","options":null}}`} {
		w = f.request("POST", "/api/v1/gallery/reviews", body)
		if w.Code != 422 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	f.exec("INSERT INTO meta(key,value) VALUES(?,'12')", "legacy_gallery_review:"+id)
	f.exec("UPDATE gallery_sources SET availability='offline' WHERE id='src'")
	w = f.request("POST", "/api/v1/gallery/reviews/"+id+"/retry", "")
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	marker, _ := f.db.QueryRow(f.ctx, "SELECT value FROM meta WHERE key=?", "legacy_gallery_review:"+id)
	if marker == nil {
		t.Fatal("failed retry removed legacy barrier")
	}
	w = f.request("POST", "/api/v1/gallery/reviews/"+id+"/finish", "")
	if w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestDesktopProjectionBoundsAndWholeGroupPagination(t *testing.T) {
	review := Row{"batch_id": "batch", "status": "ready"}
	groups := []Row{}
	for n := 0; n < 4; n++ {
		images := []Row{}
		for m := 0; m < 1000; m++ {
			images = append(images, Row{"id": strings.Repeat("界", 128), "metadata": Row{"width": 999999999, "height": -1, "secret": "excluded"}})
		}
		groups = append(groups, Row{"id": fmt.Sprint(n), "kind": "duplicate", "images": images})
	}
	page := Page{Items: groups, Limit: 4, Total: 4}
	projected, e := projectReview(review, &page, nil, false)
	if e == nil {
		t.Fatal("expected first group to exceed byte budget", projected)
	}
	expectCode(t, e, "review_group_response_too_large")
	for _, g := range groups {
		images := g["images"].([]Row)
		for _, im := range images {
			im["id"] = strings.Repeat("a", 128)
		}
	}
	projected, e = projectReview(review, &page, nil, false)
	if e != nil {
		t.Fatal(e)
	}
	p := projected["groups"].(Row)
	if !truth(p["byte_truncated"]) || len(p["items"].([]Row)) < 1 || len(p["items"].([]Row)) >= 4 {
		t.Fatal(p)
	}
	first := p["items"].([]Row)[0]["images"].([]Row)[0]["metadata"].(Row)
	if number(first["w"]) != 1000000 || number(first["h"]) != 0 || first["secret"] != nil {
		t.Fatal(first)
	}
	groups[0]["images"] = append(groups[0]["images"].([]Row), Row{})
	_, e = projectReview(review, &page, nil, false)
	expectCode(t, e, "review_group_too_large")
	f := newFixture(t, true)
	f.crawl("crawl")
	f.exec("INSERT INTO crawl_reviews(batch_id,status,created_at,updated_at) VALUES('crawl','ready',1,1)")
	e = f.db.WriteTransaction(f.ctx, func(tx *sql.Tx) error {
		statement, e := tx.PrepareContext(f.ctx, "INSERT INTO crawl_review_groups(batch_id,id,ordinal,kind,created_at,updated_at) VALUES('crawl',?,?,'single',1,1)")
		if e != nil {
			return e
		}
		defer statement.Close()
		for n := 0; n <= MaxGroups; n++ {
			if _, e = statement.ExecContext(f.ctx, fmt.Sprint(n), n); e != nil {
				return e
			}
		}
		return nil
	})
	if e != nil {
		t.Fatal(e)
	}
	w := f.request("GET", "/api/v1/crawls/crawl/review?all=true", "")
	if w.Code != 413 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = f.request("GET", "/api/v1/crawls/crawl/review?limit=2&offset=10000", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"total":10001`) {
		t.Fatal(w.Code, w.Body.String())
	}
}
