package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"ldos/backend/internal/datasets"
	"ldos/backend/internal/gallerycatalog"
	"ldos/backend/internal/reviews"
)

func TestNativeReadyCrawlRecoversAutomaticMovesWithoutFinishingReview(t *testing.T) {
	b, root := nativeBusinessFixture(t, true)
	ctx := b.ctx
	output := filepath.Join(root, "downloads/automatic")
	nativePicture(t, filepath.Join(output, "kept.png"), 10)
	nativePicture(t, filepath.Join(output, "rejected.png"), 20)
	nativeOK(t, b.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO crawl_batches(id,status,output_dir,concurrency,max_tasks,created_at,updated_at) VALUES('automatic','succeeded',?,1,100,1,1)`, output)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO crawl_reviews(batch_id,status,total_image_count,total_group_count,rejected_image_count,automatic_rejected_image_count,created_at,updated_at) VALUES('automatic','ready',2,2,1,1,1,1)`)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO crawl_review_groups(batch_id,id,ordinal,kind,decided,created_at,updated_at) VALUES('automatic','manual',1,'duplicate',0,1,1),('automatic','auto',2,'exact',1,1,1)`)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO crawl_review_images(batch_id,id,group_id,ordinal,relative_path,selected,disposition,final_relative_path,created_at,updated_at) VALUES('automatic','keep','manual',1,'kept.png',1,'pending','',1,1),('automatic','reject','auto',2,'rejected.png',0,'rejected','duplicates/rejected.png',1,1)`)
		return err
	}))
	source, err := b.gallery.AutoRegisterBatchSource(ctx, "automatic", output, "Automatic", true)
	nativeOK(t, err)
	sid := valueString(source["source_id"])
	_, err = b.gallery.Scan(ctx, sid)
	nativeOK(t, err)
	dataset, err := b.datasets.Create(ctx, datasets.CreateOptions{Name: "Automatic", Kind: "character"})
	nativeOK(t, err)
	did := valueString(dataset["dataset_id"])
	_, _, err = b.datasets.AttachSource(ctx, did, sid)
	nativeOK(t, err)
	nativeOK(t, b.datasets.WaitHashing(ctx))
	nativeOK(t, os.MkdirAll(filepath.Join(output, "duplicates"), 0700))
	nativeOK(t, os.Rename(filepath.Join(output, "rejected.png"), filepath.Join(output, "duplicates/rejected.png")))
	batch, err := b.crawls.Get(ctx, "automatic")
	nativeOK(t, err)
	for range 2 {
		// Startup replays this path for already completed batches.
		nativeOK(t, b.batchFinished(ctx, batch))
		members, err := b.datasets.MemberRows(ctx, did)
		nativeOK(t, err)
		if len(members) != 1 || members[0]["asset_id"] != gallerycatalog.AssetID(sid, "kept.png") {
			t.Fatalf("members retain a moved original: %v", members)
		}
		source, err = b.gallery.GetSource(ctx, sid)
		nativeOK(t, err)
		if source["dedup_state"] != "review_pending" || valueFloat(source["asset_count"]) != 1 || valueFloat(source["removed_count"]) != 1 {
			t.Fatal(source)
		}
		review, err := b.reviews.GetCrawl(ctx, "automatic")
		nativeOK(t, err)
		if review["status"] != "ready" {
			t.Fatal(review)
		}
	}
	// Moved files remain available through the review's actual final path.
	f, err := b.reviews.OpenCrawlImage(ctx, "automatic", "reject")
	nativeOK(t, err)
	nativeOK(t, f.Close())
	_, err = b.reviews.UpdateCrawlDecisions(ctx, "automatic", []reviews.Decision{{GroupID: "manual", SelectedImageIDs: []string{"keep"}}})
	nativeOK(t, err)
	_, err = b.reviews.ApplyCrawl(ctx, "automatic")
	nativeOK(t, err)
	source, err = b.gallery.GetSource(ctx, sid)
	nativeOK(t, err)
	if source["dedup_state"] != "applied" {
		t.Fatal(source)
	}
}
