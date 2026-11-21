package captions

import (
	"context"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"ldos/backend/internal/config"
	"ldos/backend/internal/gallerycatalog"
	"ldos/backend/internal/store"
)

func installGallery(t *testing.T, f *fixture) *gallerycatalog.Service {
	t.Helper()
	ctx := context.Background()
	cat, e := gallerycatalog.New(ctx, gallerycatalog.Dependencies{Store: f.db, Settings: config.Settings{RuntimeDir: filepath.Join(f.root, "runtime")}})
	must(t, e)
	t.Cleanup(func() { _ = cat.Stop() })
	deps := catalogCaptionDeps(f.s.deps, cat)
	deps.Store = f.db
	must(t, f.s.Stop())
	f.s, e = New(ctx, deps)
	must(t, e)
	return cat
}

func importCaptionSource(t *testing.T, cat *gallerycatalog.Service, paths ...string) (root, id string) {
	t.Helper()
	root = t.TempDir()
	for _, rel := range paths {
		file := filepath.Join(root, rel)
		must(t, os.MkdirAll(filepath.Dir(file), 0700))
		out, e := os.Create(file)
		must(t, e)
		must(t, png.Encode(out, image.NewRGBA(image.Rect(0, 0, 2, 2))))
		must(t, out.Close())
	}
	ctx := context.Background()
	source, e := cat.ImportSource(ctx, root, "Test gallery")
	must(t, e)
	id = Text(source["source_id"])
	_, e = cat.Scan(ctx, id)
	must(t, e)
	return root, id
}

func galleryRequest(t *testing.T, f *fixture, method, path string, body any, status int) (Row, string) {
	t.Helper()
	var input string
	if body != nil {
		input = encode(body)
	}
	w := f.request(method, path, input)
	if w.Code != status {
		t.Fatalf("%s %s: got %d, want %d: %s", method, path, w.Code, status, w.Body.String())
	}
	var result Row
	must(t, json.Unmarshal(w.Body.Bytes(), &result))
	return result, w.Header().Get("ETag")
}

func TestGalleryCaptionStudioHTTP(t *testing.T) {
	f := newFixture(t)
	cat := installGallery(t, f)
	root, source := importCaptionSource(t, cat, "root.png", "inner/direct.png", "inner/child/nested.png", "inner/hidden.png")
	_, other := importCaptionSource(t, cat, "other.png")
	direct := gallerycatalog.AssetID(source, "inner/direct.png")
	nested := gallerycatalog.AssetID(source, "inner/child/nested.png")
	hidden := gallerycatalog.AssetID(source, "inner/hidden.png")
	foreign := gallerycatalog.AssetID(other, "other.png")
	f.exec("UPDATE gallery_assets SET dedup_visibility='excluded' WHERE id=?", hidden)
	f.exec("INSERT INTO caption_batches(id,dataset_id,kind,created_at) VALUES('legacy','d','edit',1)")
	base := "/api/v1/gallery/sources/" + source
	otherBase := "/api/v1/gallery/sources/" + other
	directory := gallerycatalog.DirectoryID(source, "inner")
	path := base + "/captions?directory_id=" + directory
	list, etag := galleryRequest(t, f, http.MethodGet, path, nil, 200)
	if list["source_id"] != source || list["dataset_id"] != nil || list["trigger_word"] != "" || list["etag"] != etag || etag == "" {
		t.Fatal(list, etag)
	}
	items := map[string]Row{}
	for _, raw := range list["items"].([]any) {
		item := raw.(map[string]any)
		items[Text(item["asset_id"])] = item
	}
	if len(items) != 2 || items[nested]["name"] != "nested.png" || items[direct]["name"] != "direct.png" {
		t.Fatalf("not the directory and its descendants: %v", items)
	}
	mux := http.NewServeMux()
	f.s.Register(mux)
	r := httptest.NewRequest(http.MethodGet, path, nil)
	r.Header.Set("If-None-Match", "W/"+etag)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 304 || w.Body.Len() != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
	galleryRequest(t, f, http.MethodGet, otherBase+"/captions?directory_id="+directory, nil, 409)
	galleryRequest(t, f, http.MethodGet, base+"/captions?directory_id=missing", nil, 404)
	galleryRequest(t, f, http.MethodGet, "/api/v1/gallery/sources/missing/captions", nil, 404)

	version := items[direct]["version"]
	edit := Row{"text": "first, second", "expected_version": version}
	galleryRequest(t, f, http.MethodPut, base+"/captions/"+foreign, edit, 422)
	galleryRequest(t, f, http.MethodPut, base+"/captions/"+hidden, edit, 422)
	ops := func(ids []string, dry bool) Row {
		return Row{"asset_ids": ids, "ops": []Op{{Op: "add", Tags: []string{"new"}}}, "dry_run": dry}
	}
	galleryRequest(t, f, http.MethodPost, base+"/captions/ops", ops([]string{direct, foreign}, false), 422)
	preview, _ := galleryRequest(t, f, http.MethodPost, base+"/captions/ops", ops([]string{direct, nested}, true), 200)
	if preview["batch_id"] != nil || preview["source_id"] != source || preview["dataset_id"] != nil || preview["stats"].(map[string]any)["new"] != float64(2) {
		t.Fatal(preview)
	}
	_, unchanged := galleryRequest(t, f, http.MethodGet, path, nil, 200)
	if unchanged != etag {
		t.Fatal("rejected write or dry run changed captions")
	}

	edits := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		go func() { edits <- f.request(http.MethodPut, base+"/captions/"+direct, encode(edit)) }()
	}
	var written Row
	conflicts := 0
	for range 2 {
		w := <-edits
		switch w.Code {
		case 200:
			must(t, json.Unmarshal(w.Body.Bytes(), &written))
		case 409:
			conflicts++
		default:
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if conflicts != 1 || written["batch_id"] == nil || written["caption"].(map[string]any)["text"] != "first, second" {
		t.Fatal(written, conflicts)
	}
	_, afterEdit := galleryRequest(t, f, http.MethodGet, path, nil, 200)
	if afterEdit == etag {
		t.Fatal("caption edit did not invalidate ETag")
	}
	_, e := cat.Rename(context.Background(), direct, "renamed")
	must(t, e)
	_, afterRename := galleryRequest(t, f, http.MethodGet, path, nil, 200)
	if afterRename == afterEdit {
		t.Fatal("asset rename did not invalidate ETag")
	}

	applied, _ := galleryRequest(t, f, http.MethodPost, base+"/captions/ops", ops([]string{direct, nested}, false), 200)
	batch := Text(applied["batch_id"])
	if batch == "" || applied["stats"].(map[string]any)["written"] != float64(2) {
		t.Fatal(applied)
	}
	for owner, want := range map[string]int{base: 2, otherBase: 0, "/api/v1/datasets/d": 1} {
		history, _ := galleryRequest(t, f, http.MethodGet, owner+"/caption-batches", nil, 200)
		batches := history["items"].([]any)
		if len(batches) != want {
			t.Fatal(owner, history)
		}
		if owner == base {
			entry := batches[0].(map[string]any)
			if entry["batch_id"] != batch || entry["dataset_id"] != nil || entry["source_id"] != source || entry["can_undo"] != true {
				t.Fatal(entry)
			}
		}
	}
	undoPath := "/api/v1/caption-batches/" + batch + "/undo"
	// Visibility at undo time is enforced as well. The hidden item can retry
	// without rolling back either the visible restoration or another source.
	f.exec("UPDATE gallery_assets SET dedup_visibility='excluded' WHERE id=?", nested)
	part, _ := galleryRequest(t, f, http.MethodPost, undoPath, nil, 200)
	if part["undone"] != false || part["source_id"] != source || part["failed"].([]any)[0].(map[string]any)["reason"] != notInSource {
		t.Fatal(part)
	}
	bytes, e := os.ReadFile(filepath.Join(root, "inner", "child", "nested.txt"))
	must(t, e)
	if string(bytes) != "new" {
		t.Fatal(string(bytes))
	}
	f.exec("UPDATE gallery_assets SET dedup_visibility='candidate' WHERE id=?", nested)
	undone, _ := galleryRequest(t, f, http.MethodPost, undoPath, nil, 200)
	if undone["undone"] != true || undone["dataset_id"] != nil {
		t.Fatal(undone)
	}
	bytes, e = os.ReadFile(filepath.Join(root, "inner", "renamed.txt"))
	must(t, e)
	if string(bytes) != "first, second" {
		t.Fatal(string(bytes))
	}
	if _, e := os.Stat(filepath.Join(root, "inner", "child", "nested.txt")); !os.IsNotExist(e) {
		t.Fatal("undo failed to restore missing caption", e)
	}
}

func TestGalleryManualKeepDurableAcrossTrashRestoreAndReopen(t *testing.T) {
	f := newFixture(t)
	cat := installGallery(t, f)
	_, source := importCaptionSource(t, cat, "file.png", "hidden.png")
	_, other := importCaptionSource(t, cat, "other.png")
	id := gallerycatalog.AssetID(source, "file.png")
	hidden := gallerycatalog.AssetID(source, "hidden.png")
	foreign := gallerycatalog.AssetID(other, "other.png")
	f.exec("UPDATE gallery_assets SET dedup_visibility='excluded' WHERE id=?", hidden)
	path := "/api/v1/gallery/sources/" + source + "/kept"
	get := func(want []any) {
		t.Helper()
		out, _ := galleryRequest(t, f, http.MethodGet, path, nil, 200)
		if !reflect.DeepEqual(out["asset_ids"], want) {
			t.Fatal(out)
		}
	}
	put := func(ids []string, kept bool, status int) Row {
		returnRow, _ := galleryRequest(t, f, http.MethodPut, path, Row{"asset_ids": ids, "kept": kept}, status)
		return returnRow
	}
	get([]any{})
	put([]string{id, foreign}, true, 422)
	put([]string{id, hidden}, true, 422)
	galleryRequest(t, f, http.MethodPut, path, Row{"asset_ids": []string{id}}, 422)
	get([]any{})
	if put([]string{id, id}, true, 200)["updated"] != float64(1) || put([]string{id}, true, 200)["updated"] != float64(0) {
		t.Fatal("keep was not idempotent")
	}
	ctx := context.Background()
	trash, e := cat.Trash(ctx, gallerycatalog.Selection{AssetIDs: []string{id}})
	must(t, e)
	get([]any{})
	put([]string{id}, false, 422)
	_, e = cat.Restore(ctx, trash.OperationID)
	must(t, e)
	must(t, f.s.Stop())
	must(t, cat.Stop())
	must(t, f.db.Close())
	f.db, e = store.Open(f.dbPath)
	must(t, e)
	installGallery(t, f)
	get([]any{id})
	otherKept, _ := galleryRequest(t, f, http.MethodGet, "/api/v1/gallery/sources/"+other+"/kept", nil, 200)
	if len(otherKept["asset_ids"].([]any)) != 0 || put([]string{id}, false, 200)["updated"] != float64(1) {
		t.Fatal(otherKept)
	}
	get([]any{})
}

func TestSourceJournalRecoveryChecksOwnership(t *testing.T) {
	f := newFixture(t)
	cat := installGallery(t, f)
	root, source := importCaptionSource(t, cat, "mine.png")
	otherRoot, other := importCaptionSource(t, cat, "foreign.png")
	mine := gallerycatalog.AssetID(source, "mine.png")
	foreign := gallerycatalog.AssetID(other, "foreign.png")
	for file, id := range map[string]string{filepath.Join(root, "mine.txt"): mine, filepath.Join(otherRoot, "foreign.txt"): foreign} {
		must(t, os.WriteFile(file, []byte("after"), 0600))
		batch := "batch-" + id
		f.exec("INSERT INTO caption_batches(id,source_id,kind,created_at,state) VALUES(?,?,'ops',2,'writing')", batch, source)
		f.exec("INSERT INTO caption_batch_items(batch_id,asset_id,before_version,after_text,after_version,write_state) VALUES(?,?,'missing','after','','planned')", batch, id)
	}
	n, e := f.s.Recover(context.Background())
	must(t, e)
	if n != 1 {
		t.Fatal(n)
	}
	history, e := f.s.sourceHistory(context.Background(), source, 10)
	must(t, e)
	if len(history) != 2 {
		t.Fatal(history)
	}
	for _, batch := range history {
		if batch["can_undo"] != (batch["batch_id"] == "batch-"+mine) {
			t.Fatal(batch)
		}
	}
}
