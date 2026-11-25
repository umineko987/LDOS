package crawls

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"ldos/backend/internal/gallery"
)

func TestRequestItemLimitExcludedIDsAnd2000Addresses(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()

	// 2000 addresses in a single source should succeed validation; 2001 should fail.
	addrs := make([]Address, 2000)
	for i := range addrs {
		addrs[i] = Address{URL: fmt.Sprintf("https://www.pixiv.net/artworks/%d", i+1)}
	}
	b, created, err := s.Create(ctx, Request{
		Concurrency: 4,
		MaxTasks:    4000,
		Sources:     []Source{{Site: "pixiv", Addresses: addrs}},
	}, nil)
	good(t, err)
	if !created || len(batchAddresses(b)) != 2000 {
		t.Fatalf("expected 2000 addresses, got %d", len(batchAddresses(b)))
	}

	addrs = append(addrs, Address{URL: "https://www.pixiv.net/artworks/2001"})
	if _, _, err := s.Create(ctx, Request{
		Concurrency: 4,
		MaxTasks:    4000,
		Sources:     []Source{{Site: "pixiv", Addresses: addrs}},
	}, nil); err == nil {
		t.Fatal("expected 2001 addresses to fail")
	}

	// Null / invalid item_limit and excluded_ids are rejected.
	for _, raw := range []string{
		`{"sources":[{"site":"pixiv","addresses":[{"url":"https://www.pixiv.net/users/17","item_limit":null}]}]}`,
		`{"sources":[{"site":"pixiv","addresses":[{"url":"https://www.pixiv.net/users/17","item_limit":0}]}]}`,
		`{"sources":[{"site":"pixiv","addresses":[{"url":"https://www.pixiv.net/users/17","excluded_ids":null}]}]}`,
		`{"sources":[{"site":"pixiv","addresses":[{"url":"https://www.pixiv.net/users/17","excluded_ids":[""]}]}]}`,
	} {
		if _, err := DecodeRequest([]byte(raw)); err == nil {
			t.Fatalf("expected DecodeRequest failure for %s", raw)
		}
	}
}

func TestPlanAddressItemLimitAndExcludedIDs(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	s.deps.Discovery.Transport.Gallery = captureFunc(func(_ context.Context, req gallery.CaptureRequest) (gallery.CaptureResult, error) {
		return gallery.CaptureResult{
			Stdout: `[[2,{"id":101,"page_count":1}],[2,{"id":102,"page_count":1}],[2,{"id":103,"page_count":1}],[2,{"id":104,"page_count":1}]]`,
		}, nil
	})

	req, err := DecodeRequest([]byte(`{
		"sources":[{
			"site":"pixiv",
			"addresses":[{
				"url":"https://www.pixiv.net/users/17/artworks",
				"item_limit":3,
				"excluded_ids":["102"]
			}]
		}]
	}`))
	good(t, err)
	b := createBatch(t, s, req)
	id := str(b["id"])
	good(t, s.RunOnce(ctx))

	rows, err := s.ListTasks(ctx, id, "", 10, 0)
	good(t, err)
	if len(rows) != 2 {
		t.Fatalf("expected 2 tasks (101, 103), got %d: %+v", len(rows), rows)
	}
	if rows[0]["url"] != "https://www.pixiv.net/artworks/101" || rows[1]["url"] != "https://www.pixiv.net/artworks/103" {
		t.Fatalf("unexpected task urls: %+v", rows)
	}
	updated, err := s.Get(ctx, id)
	good(t, err)
	if integer(updated["pre_dedup_skipped_count"]) != 1 {
		t.Fatalf("expected pre_dedup_skipped_count=1, got %v", updated["pre_dedup_skipped_count"])
	}
}

func TestPlanAddressAllExcludedCompletesWithoutError(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	s.deps.Discovery.Transport.Gallery = captureFunc(func(_ context.Context, req gallery.CaptureRequest) (gallery.CaptureResult, error) {
		return gallery.CaptureResult{Stdout: `[[2,{"id":101,"page_count":1}]]`}, nil
	})
	req, err := DecodeRequest([]byte(`{
		"sources":[{
			"site":"pixiv",
			"addresses":[{"url":"https://www.pixiv.net/users/17/artworks","item_limit":1,"excluded_ids":["101"]}]
		}]
	}`))
	good(t, err)
	b := createBatch(t, s, req)
	id := str(b["id"])
	good(t, s.RunOnce(ctx))

	updated, err := s.Get(ctx, id)
	good(t, err)
	if updated["status"] != "succeeded" || integer(updated["pre_dedup_skipped_count"]) != 1 {
		t.Fatalf("expected succeeded batch with 1 skipped, got %+v", updated)
	}
}

func TestPlanAddressCrossBatchDatasetSourceKeyDedup(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()

	// Prepare dataset and historical attached batch with succeeded pixiv:101 source key.
	s.deps.Discovery.Transport.Gallery = captureFunc(func(_ context.Context, req gallery.CaptureRequest) (gallery.CaptureResult, error) {
		if strings.Contains(req.URL, "danbooru") {
			return gallery.CaptureResult{Stdout: `[[2,{"id":5001,"source":"https://www.pixiv.net/artworks/101","file_url":"https://cdn.donmai.us/original/a.png"}]]`}, nil
		}
		return gallery.CaptureResult{Stdout: `[[2,{"id":101,"page_count":1}],[2,{"id":102,"page_count":1}]]`}, nil
	})

	hist := createBatch(t, s, Request{
		Concurrency: 1,
		MaxTasks:    10,
		Sources:     []Source{{Site: "danbooru", Addresses: []Address{{URL: "https://danbooru.donmai.us/posts/5001"}}}},
	})
	histID := str(hist["id"])
	good(t, s.RunOnce(ctx))
	markTasks(t, s, histID, "succeeded")
	good(t, s.RunOnce(ctx))

	dsID := "ds-cross-dedup"
	srcID := "src-hist"
	rootID := "root-hist"
	dirPath := filepath.Join(s.deps.Settings.DefaultOutputRoot, "hist-dir")
	good(t, s.exec(ctx, `INSERT INTO datasets(id,name,kind,created_at,updated_at) VALUES(?,'Cross','character',1,1)`, dsID))
	good(t, s.exec(ctx, `INSERT INTO gallery_sources(id,kind,batch_id,display_name,root_path,canonical_root_key,availability,created_at,updated_at) VALUES(?,'crawl',?,'hist',?,?,'available',1,1)`, srcID, histID, dirPath, dirPath))
	good(t, s.exec(ctx, `INSERT INTO dataset_crawls(dataset_id,batch_id,state,root_id,created_at,updated_at) VALUES(?,?,'attached',?,1,1)`, dsID, histID, rootID))
	good(t, s.exec(ctx, `INSERT INTO dataset_roots(id,dataset_id,source_id,directory_id,relative_path,origin,created_at) VALUES(?,?,?,'dir-hist','','crawl',1)`, rootID, dsID, srcID))

	// Create a new batch linked to the same dataset; pixiv:101 should be skipped.
	cur := createBatch(t, s, batchRequest("https://www.pixiv.net/users/17/artworks"))
	curID := str(cur["id"])
	good(t, s.exec(ctx, `INSERT INTO dataset_crawls(dataset_id,batch_id,state,created_at,updated_at) VALUES(?,?,'pending',1,1)`, dsID, curID))
	good(t, s.RunOnce(ctx))

	rows, err := s.ListTasks(ctx, curID, "", 10, 0)
	good(t, err)
	if len(rows) != 1 || rows[0]["url"] != "https://www.pixiv.net/artworks/102" {
		t.Fatalf("expected only artwork 102 after cross-batch dedup, got %+v", rows)
	}

	// Removing dataset_root stops skipping pixiv:101 for subsequent batches.
	good(t, s.exec(ctx, `DELETE FROM dataset_roots WHERE id=?`, rootID))
	cur2 := createBatch(t, s, batchRequest("https://www.pixiv.net/users/18/artworks"))
	cur2ID := str(cur2["id"])
	good(t, s.exec(ctx, `INSERT INTO dataset_crawls(dataset_id,batch_id,state,created_at,updated_at) VALUES(?,?,'pending',1,1)`, dsID, cur2ID))
	good(t, s.RunOnce(ctx))

	rows2, err := s.ListTasks(ctx, cur2ID, "", 10, 0)
	good(t, err)
	if len(rows2) != 2 {
		t.Fatalf("expected both artworks after root removal, got %+v", rows2)
	}
}
