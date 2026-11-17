package atlas

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/config"
	"ldos/backend/internal/datasets"
	"ldos/backend/internal/store"
)

func must(t *testing.T, e error) {
	t.Helper()
	if e != nil {
		t.Fatal(e)
	}
}
func fixture(t *testing.T) (*Service, *datasets.Service) {
	t.Helper()
	root := t.TempDir()
	db, e := store.Open(filepath.Join(root, "state.sqlite"))
	must(t, e)
	t.Cleanup(func() { db.Close() })
	images := filepath.Join(root, "images")
	must(t, os.MkdirAll(images, 0700))
	for _, id := range []string{"a", "b"} {
		must(t, os.WriteFile(filepath.Join(images, id+".png"), []byte("fake image "+id), 0600))
	}
	must(t, db.WriteTransaction(context.Background(), func(tx *sql.Tx) error {
		queries := []struct {
			q    string
			args []any
		}{{`INSERT INTO datasets(id,name,kind,trigger_word,created_at,updated_at) VALUES('d','Fixture','style','trigger',1,1)`, nil}, {`INSERT INTO gallery_sources(id,kind,display_name,root_path,canonical_root_key,created_at,updated_at) VALUES('s','imported','Fixture',?,'fixture',1,1)`, []any{images}}, {`INSERT INTO gallery_directories(id,source_id,relative_path,name,sort_key,created_at,updated_at) VALUES('dir','s','','root','root',1,1)`, nil}, {`INSERT INTO dataset_roots(id,dataset_id,source_id,directory_id,relative_path,origin,created_at) VALUES('root','d','s','dir','','manual',1)`, nil}}
		for _, q := range queries {
			if _, e := tx.Exec(q.q, q.args...); e != nil {
				return e
			}
		}
		for _, id := range []string{"a", "b"} {
			if _, e := tx.Exec(`INSERT INTO gallery_assets(id,source_id,directory_id,relative_path,name,extension,sort_key,size_bytes,modified_ns,content_sha256,read_state,created_at,updated_at) VALUES(?,'s','dir',?,?,'.png',?,12,100,?,'ready',1,1)`, id, id+".png", id+".png", id, strings.Repeat(id, 64)); e != nil {
				return e
			}
			if _, e := tx.Exec(`INSERT INTO gallery_search_index(asset_id,source_id,file_name,relative_path,txt_content) VALUES(?,'s',?,?,?)`, id, id+".png", id+".png", "trigger, blue_hair\nsmile, blue_hair"); e != nil {
				return e
			}
		}
		return nil
	}))
	events := activity.NewBus(200)
	jobs := activity.NewRegistry(events)
	settings := config.Settings{RuntimeDir: filepath.Join(root, "runtime"), Dedup: config.Dedup{Enabled: true, ModelDir: filepath.Join(root, "models"), Device: "cpu", ShutdownGraceSeconds: .05}}
	ds, e := datasets.New(context.Background(), datasets.Dependencies{Store: db, Settings: settings, Events: events})
	must(t, e)
	t.Cleanup(func() { ds.Stop() })
	self, e := os.Executable()
	must(t, e)
	wrapper := filepath.Join(root, "python")
	must(t, os.WriteFile(wrapper, []byte("#!/bin/sh\nexec '"+strings.ReplaceAll(self, "'", "'\\''")+"' -test.run=TestWorkerHelper -- \"$@\"\n"), 0700))
	settings.Dedup.PythonExecutable = wrapper
	settings.Dedup.AtlasScript = filepath.Join(root, "worker.py")
	must(t, os.WriteFile(settings.Dedup.AtlasScript, []byte("fixture"), 0600))
	s, e := New(context.Background(), Dependencies{Store: db, Settings: settings, Jobs: jobs, Events: events, Datasets: DatasetCallbacks{StageInput: func(ctx context.Context, id, stage string) ([]Record, error) { return ds.StageInput(ctx, id, stage) }, HashAsset: ds.HashAsset, SetAside: ds.SetAside, PutBack: ds.PutBack}})
	must(t, e)
	t.Cleanup(func() { s.Stop() })
	t.Setenv("LDOS_ATLAS_HELPER", "success")
	return s, ds
}
func TestWorkerHelper(t *testing.T) {
	mode := os.Getenv("LDOS_ATLAS_HELPER")
	if mode == "" {
		return
	}
	jobPath := ""
	for i, arg := range os.Args {
		if arg == "--job" && i+1 < len(os.Args) {
			jobPath = os.Args[i+1]
		}
	}
	job, e := readRecord(jobPath)
	if e != nil {
		os.Exit(3)
	}
	out := text(job["output_dir"])
	fmt.Println(`{"type":"stage","stage":"embed"}`)
	if mode == "wait" {
		time.Sleep(30 * time.Second)
	}
	if mode == "fail" {
		fmt.Println(`{"type":"error","code":"fixture","message":"failed https://secret:pass@example.org"}`)
		os.Exit(2)
	}
	items := []Record{}
	for i, v := range array(job["items"]) {
		item := object(v)
		items = append(items, Record{"asset_id": item["asset_id"], "sha256": item["sha256"], "x": float64(i) / 2, "y": .5, "cluster": 0, "outlier": float64(i), "sprite": []int{0, i}})
	}
	payload := Record{"schema_version": 1, "method": "fixture", "items": items, "clusters": []Record{{"id": 0, "size": len(items), "share": 1, "x": .5, "y": .5, "medoid_asset_id": "a"}}, "params": Record{"outlier_threshold": .5}, "counts": Record{"items": len(items)}, "vectors": Record{"dims": 2, "dtype": "int8", "encoding": "base64", "order": "items", "scales": []float64{.2, .3}, "data": "AP9/gA=="}, "sprites": Record{"format": "webp", "sheet_size": 1024, "cell_size": 32, "columns": 32, "per_sheet": 1024, "sheets": []string{"sprites/sheet-0000.webp"}}, "skipped": []Record{}}
	if mode == "bad" {
		payload["sprites"] = Record{"sheets": []string{"../../outside"}}
	}
	if writeBytes(filepath.Join(out, "sprites/sheet-0000.webp"), []byte("RIFFfixtureWEBP")) != nil || writeJSON(filepath.Join(out, "atlas.json"), payload) != nil {
		os.Exit(4)
	}
	fmt.Println(`{"type":"done"}`)
	os.Exit(0)
}
func waitRun(t *testing.T, s *Service, id string) {
	t.Helper()
	s.mu.Lock()
	active := s.active[id]
	s.mu.Unlock()
	if active != nil {
		select {
		case <-active.finished:
		case <-time.After(5 * time.Second):
			t.Fatal("atlas did not finish")
		}
	}
}
func TestRunCacheProjectionRemovalRestoreAndETag(t *testing.T) {
	s, _ := fixture(t)
	clusters := 2
	perplexity := 30.0
	request := RunRequest{Clusters: &clusters, Perplexity: &perplexity}
	_, e := s.Run(context.Background(), "d", request)
	must(t, e)
	waitRun(t, s, "d")
	payload, etag, e := s.Payload(context.Background(), "d", "")
	must(t, e)
	if payload["status"] != "ready" || len(payload["items"].([]Record)) != 2 {
		t.Fatal(payload)
	}
	if object(payload["vectors"])["data"] != "AP9/gA==" {
		t.Fatal("embedding encoding changed")
	}
	cluster := payload["clusters"].([]Record)[0]
	if strings.Join(cluster["top_tags"].([]string), ",") != "blue_hair,smile" {
		t.Fatal(cluster)
	}
	if strings.Join(object(payload["hints"])["outliers"].([]string), ",") != "b" {
		t.Fatal(payload)
	}
	run := text(object(payload["run"])["run_id"])
	meta, e := readRecord(filepath.Join(s.runDir("d", run), "run.json"))
	must(t, e)
	if meta["input_digest"] != payload["current_digest"] {
		t.Fatalf("numeric option digest drift: %v %v", meta["input_digest"], payload["current_digest"])
	}
	if _, e = os.Stat(filepath.Join(s.runDir("d", run), "job.json")); !os.IsNotExist(e) {
		t.Fatal("private job not removed")
	}
	cached, e := s.Run(context.Background(), "d", request)
	must(t, e)
	if cached["cached"] != true {
		t.Fatal(cached)
	}
	same, _, e := s.Payload(context.Background(), "d", etag)
	must(t, e)
	if same != nil {
		t.Fatal("ETag missed")
	}
	_, e = s.Remove(context.Background(), "d", []string{"a"})
	must(t, e)
	removed, newTag, e := s.Payload(context.Background(), "d", etag)
	must(t, e)
	if removed == nil || newTag == etag || removed["stale"] != false || len(object(removed["delta"])["removed_asset_ids"].([]string)) != 1 {
		t.Fatal(removed)
	}
	decision, e := s.deps.Store.QueryRow(context.Background(), "SELECT * FROM dataset_decisions WHERE asset_id='a'")
	must(t, e)
	if decision["stage"] != "dedup" || decision["reason"] != "atlas" {
		t.Fatal(decision)
	}
	_, e = s.Restore(context.Background(), "d", []string{"a"})
	must(t, e)
	restored, _, e := s.Payload(context.Background(), "d", "")
	must(t, e)
	if restored["status"] != "ready" || len(object(restored["delta"])["removed_asset_ids"].([]string)) != 0 {
		t.Fatal(restored)
	}
	must(t, s.deps.Store.WriteTransaction(context.Background(), func(tx *sql.Tx) error {
		_, e := tx.Exec("UPDATE gallery_assets SET content_sha256='changed' WHERE id='a'")
		return e
	}))
	stale, e := s.Status(context.Background(), "d")
	must(t, e)
	if stale["stale"] != true || object(stale["delta"])["changed"] != 1 {
		t.Fatal(stale)
	}
}
func TestFailedRunPreservesCurrentAndValidatesOutput(t *testing.T) {
	s, _ := fixture(t)
	_, e := s.Run(context.Background(), "d", RunRequest{})
	must(t, e)
	waitRun(t, s, "d")
	current := s.current("d")
	for _, mode := range []string{"fail", "bad"} {
		t.Setenv("LDOS_ATLAS_HELPER", mode)
		_, e = s.Run(context.Background(), "d", RunRequest{Force: true})
		must(t, e)
		waitRun(t, s, "d")
		status, e := s.Status(context.Background(), "d")
		must(t, e)
		if status["status"] != "failed" || s.current("d") != current {
			t.Fatal(status)
		}
		encoded, _ := json.Marshal(status)
		if strings.Contains(string(encoded), "secret:pass") {
			t.Fatal("credentials leaked")
		}
		entries, e := os.ReadDir(filepath.Join(s.root, "d", "runs"))
		must(t, e)
		if len(entries) != 1 {
			t.Fatal("failed run not discarded")
		}
	}
}
func TestCancellationAndGlobalWorkerGate(t *testing.T) {
	s, _ := fixture(t)
	must(t, s.deps.Store.WriteTransaction(context.Background(), func(tx *sql.Tx) error {
		if _, e := tx.Exec("INSERT INTO datasets(id,name,kind,created_at,updated_at) VALUES('d2','Second','style',1,1)"); e != nil {
			return e
		}
		_, e := tx.Exec("INSERT INTO dataset_roots(id,dataset_id,source_id,directory_id,origin,created_at) VALUES('root2','d2','s','dir','manual',1)")
		return e
	}))
	t.Setenv("LDOS_ATLAS_HELPER", "wait")
	_, e := s.Run(context.Background(), "d", RunRequest{})
	must(t, e)
	deadline := time.Now().Add(3 * time.Second)
	for {
		s.mu.Lock()
		phase := s.active["d"].phase
		s.mu.Unlock()
		if phase == "embed" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("worker not ready")
		}
		time.Sleep(time.Millisecond)
	}
	_, e = s.Run(context.Background(), "d2", RunRequest{})
	must(t, e)
	state := s.State("d2")
	if object(state["progress"])["phase"] != "queued" {
		t.Fatal(state)
	}
	_, e = s.Cancel(context.Background(), "d2")
	must(t, e)
	_, e = s.Cancel(context.Background(), "d")
	must(t, e)
	if s.current("d") != "" || s.current("d2") != "" {
		t.Fatal("cancel published")
	}
	if s.deps.Jobs.Get("atlas:d").Status != activity.StatusCancelled || s.deps.Jobs.Get("atlas:d2").Status != activity.StatusCancelled {
		t.Fatal("job cancellation")
	}
}
func TestAtlasHTTPAndSafeSprites(t *testing.T) {
	s, _ := fixture(t)
	_, e := s.Run(context.Background(), "d", RunRequest{})
	must(t, e)
	waitRun(t, s, "d")
	run := s.current("d")
	mux := http.NewServeMux()
	s.Register(mux)
	request := func(path, etag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("If-None-Match", etag)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	path := "/api/v1/datasets/d/atlas/sprites/0?run=" + run
	w := request(path, "")
	if w.Code != 200 || !strings.Contains(w.Header().Get("Cache-Control"), "immutable") || w.Body.String() != "RIFFfixtureWEBP" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = request(path, w.Header().Get("ETag")); w.Code != 304 {
		t.Fatal(w.Code)
	}
	for _, path := range []string{"/api/v1/datasets/d/atlas/sprites/-1", "/api/v1/datasets/d/atlas/sprites/0?run=../bad"} {
		if w = request(path, ""); w.Code != 422 {
			t.Fatal(w.Code)
		}
	}
	sprite := filepath.Join(s.runDir("d", run), "sprites/sheet-0000.webp")
	must(t, os.Remove(sprite))
	must(t, os.Symlink(s.deps.Settings.Dedup.AtlasScript, sprite))
	if w = request(path, ""); w.Code != 404 {
		t.Fatal("followed sprite symlink", w.Code)
	}
}
func TestLegacyDigestAndSafeSource(t *testing.T) {
	raw := "a\x00abc\nb\x0012:100\n{\"clusters\": 2, \"perplexity\": 30.0}"
	sum := sha256.Sum256([]byte(raw))
	if got := Digest(map[string]string{"b": "12:100", "a": "abc"}, Record{"perplexity": 30.0, "clusters": 2}); got != hex.EncodeToString(sum[:]) {
		t.Fatal(got)
	}
	s, _ := fixture(t)
	source, e := s.deps.Store.QueryRow(context.Background(), "SELECT root_path FROM gallery_sources WHERE id='s'")
	must(t, e)
	must(t, os.Symlink(s.deps.Settings.Dedup.AtlasScript, filepath.Join(text(source["root_path"]), "link.png")))
	for _, relative := range []string{"../worker.py", "link.png"} {
		if f, e := s.openSource(context.Background(), "s", relative); e == nil {
			f.Close()
			t.Fatal("unsafe source path accepted")
		}
	}
}
