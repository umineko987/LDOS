package gallerycatalog

import (
	"context"
	"testing"
)

func TestSourceDedupStateUsesReviewAndContentVersions(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root := t.TempDir()
	picture(t, root, "image.png")
	must(t, s.exec(ctx, `INSERT INTO crawl_batches(id,status,output_dir,concurrency,max_tasks,created_at,updated_at) VALUES('projection','succeeded',?,1,10,1,1)`, root))
	row, err := s.RegisterBatchSource(ctx, "projection", root, "Projection", true)
	must(t, err)
	sid := str(row, "source_id")
	assertState := func(want string) {
		t.Helper()
		got, e := s.GetSource(ctx, sid)
		must(t, e)
		if got["dedup_state"] != want {
			t.Fatal(got)
		}
	}
	assertState("pending_analysis")
	must(t, s.exec(ctx, "INSERT INTO crawl_reviews(batch_id,status,created_at,updated_at) VALUES('projection','pending',1,1)"))
	assertState("review_pending")
	must(t, s.exec(ctx, "UPDATE crawl_reviews SET status='analyzing' WHERE batch_id='projection'"))
	assertState("pending_analysis")
	must(t, s.exec(ctx, "UPDATE crawl_reviews SET status='ready' WHERE batch_id='projection'"))
	assertState("review_pending")
	must(t, s.exec(ctx, "UPDATE gallery_sources SET dedup_state='applied',dedup_applied_version=content_version WHERE id=?", sid))
	assertState("applied")
	must(t, s.exec(ctx, "UPDATE gallery_sources SET content_version=content_version+1 WHERE id=?", sid))
	assertState("stale")
	must(t, s.exec(ctx, "UPDATE gallery_sources SET dedup_required=0 WHERE id=?", sid))
	assertState("not_required")
}
