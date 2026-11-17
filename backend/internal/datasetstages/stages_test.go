package datasetstages

import (
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"ldos/backend/internal/captions"
	"ldos/backend/internal/config"
	"ldos/backend/internal/datasets"
	"ldos/backend/internal/store"
)

type fixture struct {
	t                    *testing.T
	db                   *store.Store
	ds                   *datasets.Service
	s                    *Service
	root, dbPath         string
	callback             func(Row)
	adopted              int
	failGroup, failAsset string
	createStatus         string
	clean                bool
	lines                []Row
	captured             captions.TaggerOptions
	capturedConfig       Row
}

func must(t *testing.T, e error) {
	t.Helper()
	if e != nil {
		t.Fatal(e)
	}
}
func expectCode(t *testing.T, e error, want string) {
	t.Helper()
	var api *Error
	if !errors.As(e, &api) || api.Code != want {
		t.Fatalf("%v want %s", e, want)
	}
}
func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	dbPath := filepath.Join(root, "state.db")
	db, e := store.Open(dbPath)
	must(t, e)
	ds, e := datasets.New(context.Background(), datasets.Dependencies{Store: db})
	must(t, e)
	f := &fixture{t: t, db: db, ds: ds, root: root, dbPath: dbPath, createStatus: "ready"}
	f.exec(`INSERT INTO gallery_sources(id,kind,display_name,root_path,canonical_root_key,created_at,updated_at) VALUES('source','imported','Source',?,?,1,1)`, root, root)
	f.exec(`INSERT INTO gallery_directories(id,source_id,relative_path,name,sort_key,created_at,updated_at) VALUES('root','source','','Source','',1,1)`)
	for _, id := range []string{"a", "b", "c"} {
		p := filepath.Join(root, id+".png")
		must(t, os.WriteFile(p, []byte(id), 0600))
		st, e := os.Stat(p)
		must(t, e)
		f.exec(`INSERT INTO gallery_assets(id,source_id,directory_id,relative_path,name,extension,sort_key,size_bytes,modified_ns,width,height,format,read_state,created_at,updated_at) VALUES(?,'source','root',?,?,'.png',?,?,?,12,9,'PNG','ready',1,1)`, id, id+".png", id+".png", id, st.Size(), st.ModTime().UnixNano())
	}
	f.exec(`INSERT INTO datasets(id,name,kind,created_at,updated_at) VALUES('d','Dataset','character',1,1)`)
	f.exec(`INSERT INTO dataset_roots(id,dataset_id,source_id,directory_id,relative_path,origin,created_at) VALUES('attachment','d','source','root','','library',1)`)
	f.s = f.service()
	t.Cleanup(func() { _ = f.s.Stop(); _ = f.ds.Stop(); _ = f.db.Close() })
	return f
}
func (f *fixture) service() *Service {
	settings := config.Settings{Tagger: config.Tagger{Enabled: true}, Dedup: config.Dedup{Enabled: true}}
	s, e := New(context.Background(), Dependencies{Store: f.db, Settings: settings, StageInput: func(ctx context.Context, id, stage string) ([]Row, error) { return f.ds.StageInput(ctx, id, stage) }, StageInputDigest: f.ds.StageInputDigest, ApplyCaptions: func(ctx context.Context, id string, o captions.TaggerOptions) (Row, error) {
		if e := ctx.Err(); e != nil {
			return nil, e
		}
		f.captured = o
		return Row{"dataset_id": id, "dry_run": o.DryRun}, nil
	}, Reviews: ReviewCallbacks{Create: f.createReview, Adopt: f.adopt, Finish: func(ctx context.Context, id string) error {
		return f.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
			_, e := tx.ExecContext(ctx, "DELETE FROM gallery_reviews WHERE review_id=?", id)
			return e
		})
	}, Presets: func(context.Context) ([]Row, error) {
		return []Row{{"id": "custom", "name": "custom", "options": Row{"basic_dedup": true, "similarity_groups": false, "filter_character": true}}}, nil
	}}, Tagger: TaggerCallbacks{Catalog: func(context.Context) ([]Row, error) {
		return []Row{{"key": "m", "installed": true, "adapter": "fake", "revision": "r", "default_thresholds": map[string]float64{"general": .5, "character": .7, "rating": 0}}}, nil
	}, Tag: func(ctx context.Context, models, paths []string, batch int, ref Row, done func(Row)) (string, error) {
		f.callback = done
		return "job", nil
	}, Cancel: func(context.Context, string) error { return nil }, Query: func(ctx context.Context, cmd string, models, inputs, extra []string) ([]Row, error) {
		if e := ctx.Err(); e != nil {
			return nil, e
		}
		return f.lines, nil
	}}})
	must(f.t, e)
	return s
}
func (f *fixture) exec(q string, args ...any) {
	f.t.Helper()
	must(f.t, f.db.WriteTransaction(context.Background(), func(tx *sql.Tx) error { _, e := tx.Exec(q, args...); return e }))
}
func (f *fixture) createReview(ctx context.Context, ids []string, cfg Row) (Row, error) {
	f.capturedConfig = cfg
	id := uuid.NewString()
	clean := !truth(object(cfg["options"])["basic_dedup"]) && !truth(object(cfg["options"])["similarity_groups"])
	e := f.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		_, e := tx.ExecContext(ctx, "INSERT INTO gallery_reviews(review_id,status,total_image_count,created_at,updated_at) VALUES(?,?,?,1,1)", id, f.createStatus, len(ids))
		if e != nil {
			return e
		}
		for ordinal, gid := range []string{"g", "auto"} {
			kind := "duplicate"
			decided := 0
			if clean {
				kind = "single"
			}
			if gid == "auto" {
				kind = "auto_exact"
				if clean {
					kind = "auto_filtered"
				}
				decided = 1
			}
			if _, e = tx.ExecContext(ctx, "INSERT INTO gallery_review_groups(review_id,id,ordinal,kind,decided,created_at,updated_at) VALUES(?,?,?,?,?,1,1)", id, gid, ordinal, kind, decided); e != nil {
				return e
			}
		}
		for i, aid := range ids {
			g, disposition, selected := "g", "kept", 1
			metadata := Row{"w": 24, "h": 18, "sharpness": 1.25, "review_metrics": Row{"similarity": .9}}
			if clean {
				metadata["classification"] = "monochrome"
			}
			if aid == "c" {
				g = "auto"
				disposition = "rejected"
				selected = 0
				metadata["automatic_dedup"] = Row{"winner_relative_path": "source/a.png"}
			}
			if _, e = tx.ExecContext(ctx, "INSERT INTO gallery_review_images(review_id,id,group_id,ordinal,relative_path,metadata_json,selected,recommended,disposition,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,1)", id, aid, g, i, "source/"+aid+".png", encode(metadata), selected, aid == "a", disposition); e != nil {
				return e
			}
		}
		return nil
	})
	return Row{"review_id": id}, e
}
func (f *fixture) adopt(ctx context.Context, id, group string, keep []string, version int64, automatic bool) (Row, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	if f.failGroup == group {
		return nil, fail(409, "review_state_conflict", "rejected")
	}
	images, e := f.s.groupImages(ctx, id, group)
	if e != nil {
		return nil, e
	}
	f.adopted++
	e = f.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		r, e := store.QueryRowTx(ctx, tx, "SELECT version FROM gallery_reviews WHERE review_id=?", id)
		if e != nil {
			return e
		}
		if number(r["version"]) != version {
			return fail(409, "review_state_conflict", "version")
		}
		for _, image := range images {
			aid := text(image["id"])
			disposition := "rejected"
			lifecycle := "trashed"
			if slices.Contains(keep, aid) {
				disposition = "kept"
				lifecycle = "active"
			}
			if f.failAsset == aid {
				disposition = "failed"
				lifecycle = "active"
			}
			if _, e = tx.ExecContext(ctx, "UPDATE gallery_review_images SET selected=?,disposition=?,error=? WHERE review_id=? AND id=?", slices.Contains(keep, aid), disposition, map[bool]string{true: "file_failed", false: ""}[f.failAsset == aid], id, aid); e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, "UPDATE gallery_assets SET lifecycle_state=? WHERE id=?", lifecycle, aid); e != nil {
				return e
			}
		}
		if _, e = tx.ExecContext(ctx, "UPDATE gallery_review_groups SET decided=1 WHERE review_id=? AND id=?", id, group); e != nil {
			return e
		}
		_, e = tx.ExecContext(ctx, "UPDATE gallery_reviews SET version=version+1 WHERE review_id=?", id)
		return e
	})
	if e == nil {
		f.s.OnReviewChanged(id)
	}
	return Row{}, e
}
func (f *fixture) run(stage string) Row {
	f.t.Helper()
	r, e := f.s.Run(context.Background(), "d", stage, RunOptions{})
	must(f.t, e)
	return r
}
func (f *fixture) request(method, url, body string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	f.s.Register(mux)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(method, url, strings.NewReader(body)))
	return w
}
func (f *fixture) candidateLines() {
	models := []Row{{"key": "m", "adapter": "fake", "revision": "r", "fingerprint": "actual", "vocabulary_fingerprint": "vocabulary", "vocabulary_size": 8, "categories": []string{"general", "character", "rating"}, "default_thresholds": Row{"general": .5, "character": .7, "rating": 0}}}
	f.lines = []Row{{"type": "models", "models": models}, {"type": "candidates", "path": filepath.Join(f.root, "a.png"), "status": "ok", "models": Row{"m": [][]any{{"long_hair", "general", .5}, {"low", "general", .49999999999}, {"Miku_(vocaloid)", "character", .8}, {"safe", "rating", .7}, {"explicit", "rating", .2}, {"tiny", "general", .001}}}}, {"type": "candidates", "path": filepath.Join(f.root, "b.png"), "status": "missing_scores", "missing_models": []string{"m"}, "models": Row{}}, {"type": "candidates", "path": filepath.Join(f.root, "c.png"), "status": "decode_error", "models": Row{}}}
}

func TestTagRunImmediateCompletionCancellationAndRecovery(t *testing.T) {
	f := newFixture(t)
	f.s.deps.Tagger.Tag = func(ctx context.Context, m, p []string, b int, r Row, done func(Row)) (string, error) {
		done(Row{"status": "succeeded", "last_result": Row{"total": 3, "per_model": Row{"m": Row{"inferred": 2, "cache_hits": 1}}, "decode_errors": []string{"c"}}})
		return "fast", nil
	}
	run, e := f.s.RunTag(context.Background(), "d", []string{"m"}, 8)
	must(t, e)
	finished, e := f.s.WaitTag(context.Background(), text(run["run_id"]))
	must(t, e)
	if text(finished["status"]) != "succeeded" || number(object(finished["stats"])["decode_errors"]) != 1 {
		t.Fatal(finished)
	}
	f.s.deps.Tagger.Tag = func(ctx context.Context, m, p []string, b int, r Row, done func(Row)) (string, error) {
		f.callback = done
		return "late", nil
	}
	run, e = f.s.RunTag(context.Background(), "d", []string{"m"}, 8)
	must(t, e)
	cancelled, e := f.s.CancelTag(context.Background(), text(run["run_id"]))
	must(t, e)
	f.callback(Row{"status": "succeeded", "last_result": Row{"total": 999}})
	again, e := f.s.getRun(context.Background(), text(run["run_id"]))
	must(t, e)
	if text(cancelled["status"]) != "cancelled" || text(again["status"]) != "cancelled" || number(object(again["stats"])["total"]) == 999 {
		t.Fatal(cancelled, again)
	}
	f.exec("INSERT INTO dataset_stage_runs(id,dataset_id,stage,status,created_at,updated_at) VALUES('abandoned','d','tag','running',1,1)")
	n, e := f.s.Recover(context.Background())
	must(t, e)
	if n != 1 {
		t.Fatal(n)
	}
	r, e := f.s.getRun(context.Background(), "abandoned")
	must(t, e)
	if text(r["error_code"]) != "interrupted" {
		t.Fatal(r)
	}
}
func TestCandidatesProjectionComposeThresholdsAndHTTP(t *testing.T) {
	f := newFixture(t)
	f.candidateLines()
	etag, body, e := f.s.Candidates(context.Background(), "d", []string{"m"}, .01)
	must(t, e)
	var payload Row
	must(t, json.Unmarshal(body, &payload))
	stats := object(payload["stats"])
	if number(stats["ok"]) != 1 || number(stats["missing_scores"]) != 1 || number(stats["decode_error"]) != 1 {
		t.Fatal(payload)
	}
	models := anySlice(payload["models"])
	model := object(models[0])
	if text(model["fingerprint"]) != "actual" || len(anySlice(model["tags"])) != 5 {
		t.Fatal(model)
	}
	_, e = f.s.CaptionsFromTagger(context.Background(), "d", FromTaggerOptions{Models: []string{"m"}, Mode: "merge", EscapeParens: true, DryRun: true, SampleLimit: 10})
	must(t, e)
	if !reflect.DeepEqual(f.captured.Tags["a"], []string{"long hair", `Miku_\(vocaloid\)`, "safe"}) {
		t.Fatal(f.captured)
	}
	if f.captured.Unavailable["b"] != "missing_scores" || f.captured.Unavailable["c"] != "decode_error" {
		t.Fatal(f.captured.Unavailable)
	}
	_, e = f.s.CaptionsFromTagger(context.Background(), "d", FromTaggerOptions{Models: []string{"m"}, Mode: "overwrite", Thresholds: map[string]map[string]float64{"m": {"general": .6}}, Categories: []string{"rating", "general"}})
	must(t, e)
	if !reflect.DeepEqual(f.captured.Tags["a"], []string{"safe"}) {
		t.Fatal(f.captured)
	}
	mux := http.NewServeMux()
	f.s.Register(mux)
	req := httptest.NewRequest("GET", "/api/v1/datasets/d/tagger/candidates?models=m", nil)
	req.Header.Set("If-None-Match", "W/"+etag)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != 304 || w.Body.Len() != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
	req = httptest.NewRequest("GET", "/api/v1/datasets/d/tagger/candidates?models=m", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if len(body) >= 1024 {
		if w.Header().Get("Content-Encoding") != "gzip" {
			t.Fatal(w.Header())
		}
		z, e := gzip.NewReader(w.Body)
		must(t, e)
		decompressed, e := io.ReadAll(z)
		must(t, e)
		must(t, z.Close())
		if !reflect.DeepEqual(decompressed, body) {
			t.Fatal("gzip altered result")
		}
	}
	for _, url := range []string{"/api/v1/datasets/d/tagger/candidates?models=unknown", "/api/v1/datasets/d/tagger/candidates?models=m&floor=NaN", "/api/v1/datasets/d/stages/clean/items?limit=0"} {
		w = f.request("GET", url, "")
		if w.Code != 422 {
			t.Fatal(url, w.Code, w.Body.String())
		}
	}
}
func TestInputSafetyHashesAndUnavailableProjection(t *testing.T) {
	f := newFixture(t)
	sha := strings.Repeat("a", 64)
	f.exec("UPDATE gallery_assets SET content_sha256=? WHERE id='a'", sha)
	ins, e := f.s.Inputs(context.Background(), "d", "tag", nil)
	must(t, e)
	if ins[0].SHA256 != sha || !strings.HasPrefix(ins[0].Line(), sha+"\t") {
		t.Fatal(ins)
	}
	must(t, os.WriteFile(filepath.Join(f.root, "a.png"), []byte("changed file"), 0600))
	ins, e = f.s.Inputs(context.Background(), "d", "tag", nil)
	must(t, e)
	if ins[0].SHA256 != "" {
		t.Fatal(ins)
	}
	outside := filepath.Join(t.TempDir(), "outside.png")
	must(t, os.WriteFile(outside, []byte("secret"), 0600))
	must(t, os.Remove(filepath.Join(f.root, "b.png")))
	must(t, os.Symlink(outside, filepath.Join(f.root, "b.png")))
	must(t, os.Remove(filepath.Join(f.root, "c.png")))
	ins, e = f.s.Inputs(context.Background(), "d", "tag", nil)
	must(t, e)
	if ins[1].Unavailable != "unsafe_source_path" || ins[2].Unavailable != "file_missing" {
		t.Fatal(ins)
	}
	f.candidateLines()
	_, body, e := f.s.Candidates(context.Background(), "d", []string{"m"}, .01)
	must(t, e)
	var payload Row
	must(t, json.Unmarshal(body, &payload))
	if number(object(payload["stats"])["unavailable"]) != 2 {
		t.Fatal(payload)
	}
}
func TestTriageRunGroupsApplyUndoFunnelAndActualFailures(t *testing.T) {
	f := newFixture(t)
	summary := f.run("dedup")
	run := object(summary["run"])
	if text(run["status"]) != "succeeded" || summary["counts"].(map[string]int)["automatic_excluded"] != 1 {
		t.Fatal(summary)
	}
	groups, e := f.s.DedupGroups(context.Background(), "d", PageOptions{Limit: 50, IncludeAutomatic: true})
	must(t, e)
	items := groups["items"].([]Row)
	if len(items) != 2 || items[1]["winner_asset_id"] != "a" {
		t.Fatal(groups)
	}
	first := items[0]["members"].([]Row)[0]
	if first["width"] != int64(24) || first["thumbnail_url"] != "/api/v1/gallery/assets/a/thumbnail?size=256" || first["review_metrics"] == nil {
		t.Fatal(first)
	}
	_, e = f.s.Apply(context.Background(), "d", "dedup", text(run["run_id"]), []GroupDecision{{GroupID: "g", Keep: []string{"a"}}, {GroupID: "missing"}})
	expectCode(t, e, "triage_group_not_found")
	if f.adopted != 0 {
		t.Fatal("mutated before validation")
	}
	applied, e := f.s.Apply(context.Background(), "d", "dedup", text(run["run_id"]), []GroupDecision{{GroupID: "g", Keep: []string{"a"}}})
	must(t, e)
	if !reflect.DeepEqual(applied["kept"], []string{"a"}) || !reflect.DeepEqual(applied["rejected"], []string{"b"}) {
		t.Fatal(applied)
	}
	next, e := f.ds.StageInput(context.Background(), "d", "tag")
	must(t, e)
	if len(next) != 1 || text(next[0]["asset_id"]) != "a" {
		t.Fatal(next)
	}
	_, e = f.s.Undo(context.Background(), "d", "dedup", "wrong")
	expectCode(t, e, "triage_undo_not_latest")
	u, e := f.s.Undo(context.Background(), "d", "dedup", text(applied["batch_id"]))
	must(t, e)
	if u["undone_groups"] != 1 {
		t.Fatal(u)
	}
	d, e := f.s.decisions(context.Background(), "d", "dedup")
	must(t, e)
	if d["a"] != nil || d["b"] != nil || text(d["c"]["reason"]) != "auto_exact" {
		t.Fatal(d)
	}
	f.failAsset = "b"
	applied, e = f.s.Apply(context.Background(), "d", "dedup", text(run["run_id"]), []GroupDecision{{GroupID: "g", Keep: []string{"a"}}})
	must(t, e)
	if len(applied["rejected"].([]string)) != 0 || len(applied["failed"].([]Row)) != 1 {
		t.Fatal(applied)
	}
	d, e = f.s.decisions(context.Background(), "d", "dedup")
	must(t, e)
	if d["b"] != nil {
		t.Fatal("failure fabricated exclusion", d)
	}
	_, e = f.s.Undo(context.Background(), "d", "dedup", "")
	expectCode(t, e, "triage_undo_failed")
	f.failAsset = ""
	_, e = f.s.Undo(context.Background(), "d", "dedup", "")
	must(t, e)
}
func TestCleanFiltersAutomaticRestoreAndExpiredRuns(t *testing.T) {
	f := newFixture(t)
	_, e := f.s.Run(context.Background(), "d", "clean", RunOptions{Options: Row{"filter_monochrome": false, "filter_sketch": false}})
	expectCode(t, e, "clean_stage_no_filters")
	_, e = f.s.Run(context.Background(), "d", "dedup", RunOptions{Options: Row{"basic_dedup": false, "similarity_groups": false}})
	expectCode(t, e, "dedup_stage_no_checks")
	summary := f.run("clean")
	opts := object(f.capturedConfig["options"])
	if truth(opts["basic_dedup"]) || truth(opts["similarity_groups"]) {
		t.Fatal(opts)
	}
	run := object(summary["run"])
	page, e := f.s.CleanItems(context.Background(), "d", PageOptions{Limit: 100, Reason: "filter_character"})
	must(t, e)
	if page["total"] != 1 || page["items"].([]Row)[0]["asset_id"] != "c" {
		t.Fatal(page)
	}
	applied, e := f.s.Apply(context.Background(), "d", "clean", text(run["run_id"]), []GroupDecision{{GroupID: "auto", Keep: []string{"c"}}})
	must(t, e)
	if !reflect.DeepEqual(applied["kept"], []string{"c"}) {
		t.Fatal(applied)
	}
	_, e = f.s.Undo(context.Background(), "d", "clean", "")
	must(t, e)
	d, e := f.s.decisions(context.Background(), "d", "clean")
	must(t, e)
	if text(d["c"]["reason"]) != "filter_character" {
		t.Fatal(d)
	}
	f.exec("DELETE FROM gallery_reviews WHERE review_id=?", run["ref_id"])
	_, e = f.s.CleanItems(context.Background(), "d", PageOptions{Limit: 100})
	expectCode(t, e, "stage_triage_expired")
	s, e := f.s.Summary(context.Background(), "d", "clean")
	must(t, e)
	if s["review_status"] != "expired" || s["counts"].(map[string]int)["input"] != 3 {
		t.Fatal(s)
	}
}
func TestPendingReviewListenerRecoveryAndHTTPRoutes(t *testing.T) {
	f := newFixture(t)
	f.createStatus = "analyzing"
	summary := f.run("dedup")
	run := object(summary["run"])
	_, e := f.s.Run(context.Background(), "d", "dedup", RunOptions{})
	expectCode(t, e, "stage_run_active")
	f.exec("UPDATE gallery_reviews SET status='ready' WHERE review_id=?", run["ref_id"])
	f.s.OnReviewChanged(text(run["ref_id"]))
	f.s.wg.Wait()
	r, e := f.s.getRun(context.Background(), text(run["run_id"]))
	must(t, e)
	if text(r["status"]) != "succeeded" {
		t.Fatal(r)
	}
	for _, url := range []string{"/api/v1/datasets/d/stages/dedup/triage", "/api/v1/datasets/d/stages/dedup/groups"} {
		w := f.request("GET", url, "")
		if w.Code != 200 {
			t.Fatal(url, w.Code, w.Body.String())
		}
	}
	f.exec("INSERT INTO dataset_stage_runs(id,dataset_id,stage,status,ref_id,created_at,updated_at) VALUES('lost','d','clean','running','absent',3,3)")
	must(t, f.s.Stop())
	must(t, f.ds.Stop())
	must(t, f.db.Close())
	f.db, e = store.Open(f.dbPath)
	must(t, e)
	f.ds, e = datasets.New(context.Background(), datasets.Dependencies{Store: f.db})
	must(t, e)
	f.s = f.service()
	must(t, f.s.Start())
	r, e = f.s.getRun(context.Background(), "lost")
	must(t, e)
	if text(r["error_code"]) != "interrupted" {
		t.Fatal(r)
	}
	w := f.request("POST", "/api/v1/datasets/d/stages/review/run", "")
	if w.Code != 422 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = f.request("POST", "/api/v1/datasets/d/stages/tag/run", `{"models":["m"],"batch_size":0}`)
	if w.Code != 422 {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestCanceledStagesCannotCommitAndConcurrentSummary(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, e := f.s.Run(ctx, "d", "dedup", RunOptions{})
	if !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	rows, e := f.db.QueryRows(context.Background(), "SELECT * FROM dataset_stage_runs")
	must(t, e)
	if len(rows) != 0 {
		t.Fatal(rows)
	}
	summary := f.run("dedup")
	rid := text(object(summary["run"])["run_id"])
	_, e = f.s.Apply(ctx, "d", "dedup", rid, []GroupDecision{{GroupID: "g", Keep: []string{"a"}}})
	if !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	if f.adopted != 0 {
		t.Fatal("cancelled adoption")
	}
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := f.s.Summary(context.Background(), "d", "dedup")
			if e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	run, e := f.s.RunTag(context.Background(), "d", []string{"m"}, 8)
	must(t, e)
	must(t, f.s.Stop())
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	r, e := f.s.WaitTag(ctx2, text(run["run_id"]))
	must(t, e)
	if text(r["status"]) != "cancelled" {
		t.Fatal(r)
	}
}
