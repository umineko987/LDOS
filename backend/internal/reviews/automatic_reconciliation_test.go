package reviews

import (
	"context"
	"errors"
	"testing"
)

func TestAutomaticCrawlJournalsAndReconcilesBeforeManualApply(t *testing.T) {
	f := newFixture(t, true)
	f.crawl("crawl")
	f.file("a.jpg")
	f.file("b.jpg")
	f.source("source")
	f.exec("UPDATE gallery_sources SET batch_id='crawl' WHERE id='source'")
	f.s.deps.Runner = func(_ context.Context, input WorkerInput) (Manifest, string, error) {
		return fakeManifest(input, "automatic"), "", nil
	}
	calls := 0
	f.s.deps.Gallery.ReconcileCrawl = func(ctx context.Context, id string, images []Row) error {
		calls++
		if id != "crawl" {
			t.Fatal(id)
		}
		found := false
		for _, image := range images {
			if text(image["relative_path"]) == "b.jpg" {
				found = text(image["disposition"]) == "rejected" && text(image["final_relative_path"]) == "duplicates/b.jpg"
			}
		}
		if !found {
			t.Fatal("automatic reconciliation used stale image dispositions", images)
		}
		// A durable journal must remain available when the catalog cannot commit.
		return errors.New("catalog temporarily unavailable")
	}
	_, err := f.s.StartCrawl(f.ctx, "crawl")
	if err != nil {
		t.Fatal(err)
	}
	f.run()
	review, err := f.s.GetCrawl(f.ctx, "crawl")
	assertStatus(t, review, "ready", err)
	if calls != 1 {
		t.Fatalf("automatic reconcile calls = %d, want 1", calls)
	}
	event, err := f.db.QueryRow(f.ctx, "SELECT * FROM gallery_reconciliation_events WHERE batch_id='crawl'")
	if err != nil || text(event["status"]) != "pending" {
		t.Fatal(event, err)
	}
	rules, err := f.db.QueryRows(f.ctx, "SELECT relative_path,disposition FROM gallery_reconciliation_items WHERE event_id=? ORDER BY relative_path", event["id"])
	if err != nil || len(rules) != 2 {
		t.Fatal(rules, err)
	}
	if text(rules[0]["relative_path"]) != "b.jpg" || text(rules[0]["disposition"]) != "excluded_original" || text(rules[1]["relative_path"]) != "duplicates/b.jpg" || text(rules[1]["disposition"]) != "excluded" {
		t.Fatal(rules)
	}
}
