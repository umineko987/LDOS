package store_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"

	"ldos/backend/internal/datasets"
	"ldos/backend/internal/store"
)

func TestUpgradeV18GalleryReview(t *testing.T) {
	ctx := context.Background()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	equal := func(got, want any) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	path := filepath.Join(t.TempDir(), "v18.sqlite")
	s, err := store.Open(path)
	check(err)
	t.Cleanup(func() { _ = s.Close() })
	write := func(query string) error {
		return s.WriteTransaction(ctx, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, query)
			return err
		})
	}
	check(write(`
DROP TABLE gallery_asset_keeps;
DROP TABLE caption_batch_items;
DROP TABLE caption_batches;
UPDATE meta SET value='18' WHERE key='schema_version';
CREATE TABLE caption_batches (
 id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE, kind TEXT NOT NULL,
 params_json TEXT NOT NULL DEFAULT '{}', stats_json TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL, undone_at REAL,
 undo_stats_json TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'complete'
);
CREATE INDEX idx_caption_batches_dataset ON caption_batches(dataset_id, created_at);
CREATE TABLE caption_batch_items (
 batch_id TEXT NOT NULL REFERENCES caption_batches(id) ON DELETE CASCADE, asset_id TEXT NOT NULL, before_text TEXT, before_version TEXT NOT NULL,
 after_text TEXT, after_version TEXT NOT NULL, tagger_tags_json TEXT, write_state TEXT NOT NULL DEFAULT 'written', undo_state TEXT,
 before_bom INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(batch_id, asset_id)
);
CREATE INDEX idx_caption_batch_items_asset ON caption_batch_items(asset_id);
INSERT INTO datasets(id,name,kind,created_at,updated_at) VALUES ('dataset','Set','custom',1,1);
INSERT INTO gallery_sources(id,kind,display_name,root_path,canonical_root_key,created_at,updated_at)
 VALUES ('source','imported','Source','/unused','/unused',1,1);
INSERT INTO gallery_directories(id,source_id,relative_path,name,sort_key,created_at,updated_at)
 VALUES ('root','source','','Source','',1,1);
INSERT INTO gallery_assets(id,source_id,directory_id,relative_path,name,extension,sort_key,size_bytes,modified_ns,created_at,updated_at)
 VALUES ('a','source','root','a.png','a.png','.png','a',1,1,1,1), ('b','source','root','b.png','b.png','.png','b',1,1,1,1),
 ('c','source','root','c.png','c.png','.png','c',1,1,1,1), ('d','source','root','d.png','d.png','.png','d',1,1,1,1);
INSERT INTO dataset_roots(id,dataset_id,source_id,directory_id,origin,created_at) VALUES ('root','dataset','source','root','import',1);
INSERT INTO caption_batches(rowid,id,dataset_id,kind,params_json,stats_json,created_at,undone_at,undo_stats_json,state)
 VALUES (23,'tagger','dataset','from_tagger','{"mode":"merge"}','{"written":1}',1,2,'{"restored":1}','complete'),
 (24,'ongoing','dataset','ops','{}','{}',1,NULL,'{}','writing');
INSERT INTO caption_batch_items(rowid,batch_id,asset_id,before_text,before_version,after_text,after_version,tagger_tags_json,write_state,undo_state,before_bom)
 VALUES (32,'tagger','a','original','before','after','after','["tag"]','written','restored',1),
 (34,'ongoing','b',NULL,'missing','after','',NULL,'planned',NULL,0);
INSERT INTO dataset_decisions(dataset_id,stage,asset_id,decision,reason,previous_decision,previous_reason,created_at,updated_at)
 VALUES ('dataset','review','a','exclude','old a','approve','old approval',2,3),
 ('dataset','review','b','exclude','old b',NULL,'',2,3),
 ('dataset','review','c','exclude','old c',NULL,'',2,3),
 ('dataset','review','d','approve','old approval',NULL,'',2,3),
 ('dataset','export','b','approve','export approval',NULL,'',4,5),
 ('dataset','export','c','exclude','already excluded',NULL,'',4,5);`))
	beforeBatches, err := s.QueryRows(ctx, "SELECT rowid,* FROM caption_batches ORDER BY rowid")
	check(err)
	beforeItems, err := s.QueryRows(ctx, "SELECT rowid,* FROM caption_batch_items ORDER BY rowid")
	check(err)
	beforeReview, err := s.QueryRows(ctx, "SELECT * FROM dataset_decisions WHERE stage='review' ORDER BY asset_id")
	check(err)
	check(s.Close())

	s, err = store.Open(path)
	check(err)
	batches, err := s.QueryRows(ctx, "SELECT rowid,* FROM caption_batches ORDER BY rowid")
	check(err)
	for _, b := range batches {
		if b["source_id"] != nil {
			t.Fatalf("legacy batch assigned to a source: %v", b)
		}
		delete(b, "source_id")
	}
	equal(batches, beforeBatches)
	items, err := s.QueryRows(ctx, "SELECT rowid,* FROM caption_batch_items ORDER BY rowid")
	check(err)
	equal(items, beforeItems)
	review, err := s.QueryRows(ctx, "SELECT * FROM dataset_decisions WHERE stage='review' ORDER BY asset_id")
	check(err)
	equal(review, beforeReview)

	// Use the production export planner after the upgrade: only the review
	// approval remains exportable, even though the five stages omit review.
	ds, err := datasets.New(ctx, datasets.Dependencies{Store: s})
	check(err)
	defer ds.Stop()
	preview, err := ds.PreviewExport(ctx, "dataset", datasets.Record{"target_path": t.TempDir(), "include_captions": false, "layout": "flat"})
	check(err)
	exportable := preview["items"].([]datasets.Record)
	if len(exportable) != 1 || exportable[0]["asset_id"] != "d" {
		t.Fatalf("v18 review exclusions did not survive export: %v", exportable)
	}
	projected, err := s.QueryRows(ctx, "SELECT asset_id,reason,previous_decision FROM dataset_decisions WHERE stage='export' ORDER BY asset_id")
	check(err)
	if len(projected) != 3 || projected[0]["reason"] != "old a" || projected[1]["previous_decision"] != "approve" || projected[2]["reason"] != "already excluded" {
		t.Fatalf("incorrect exclusion precedence: %v", projected)
	}
	keeps, err := s.QueryRows(ctx, "SELECT asset_id FROM gallery_asset_keeps")
	check(err)
	if len(keeps) != 0 {
		t.Fatalf("legacy decisions inferred a gallery keep: %v", keeps)
	}

	for _, query := range []string{
		"INSERT INTO caption_batches(id,kind,created_at) VALUES('bad','edit',3)",
		"INSERT INTO caption_batches(id,dataset_id,source_id,kind,created_at) VALUES('bad','dataset','source','edit',3)",
		"INSERT INTO caption_batches(id,source_id,kind,created_at) VALUES('bad','nonexistent','edit',3)",
	} {
		if err := write(query); err == nil {
			t.Fatalf("invalid owner accepted: %s", query)
		}
	}
	check(write(`INSERT INTO caption_batches(id,source_id,kind,created_at) VALUES('new','source','edit',3);
INSERT INTO caption_batch_items(batch_id,asset_id,before_version,after_version) VALUES('new','a','x','y');
DELETE FROM gallery_sources WHERE id='source';`))
	items, err = s.QueryRows(ctx, "SELECT rowid,* FROM caption_batch_items ORDER BY rowid")
	check(err)
	equal(items, beforeItems)
	violations, err := s.QueryRows(ctx, "PRAGMA foreign_key_check")
	check(err)
	if len(violations) != 0 {
		t.Fatal(violations)
	}
}
