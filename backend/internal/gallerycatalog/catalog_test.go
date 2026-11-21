package gallerycatalog

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"ldos/backend/internal/config"
	"ldos/backend/internal/store"
)

func testService(t *testing.T) *Service {
	t.Helper()
	home := t.TempDir()
	db, e := store.Open(filepath.Join(home, "state.db"))
	must(t, e)
	s, e := New(context.Background(), Dependencies{Store: db, Settings: config.Settings{RuntimeDir: home}})
	must(t, e)
	t.Cleanup(func() { must(t, s.Stop()); must(t, db.Close()) })
	return s
}
func must(t *testing.T, e error) {
	t.Helper()
	if e != nil {
		var ge *Error
		if errors.As(e, &ge) {
			t.Fatalf("%s: %v", ge.Code, ge.Cause)
		}
		t.Fatal(e)
	}
}
func wantError(t *testing.T, e error, code string) {
	t.Helper()
	if e == nil || errorCode(e) != code {
		t.Fatalf("got error %v (%s), want %s", e, errorCode(e), code)
	}
}
func put(t *testing.T, root, relative string, data []byte) {
	t.Helper()
	target := filepath.Join(root, filepath.FromSlash(relative))
	must(t, os.MkdirAll(filepath.Dir(target), 0755))
	must(t, os.WriteFile(target, data, 0644))
}
func picture(t *testing.T, root, relative string) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 12, 9))
	for y := 0; y < 9; y++ {
		for x := 0; x < 12; x++ {
			img.Set(x, y, color.RGBA{uint8(x * 20), uint8(y * 20), 100, 255})
		}
	}
	var b bytes.Buffer
	must(t, png.Encode(&b, img))
	put(t, root, relative, b.Bytes())
}
func importScan(t *testing.T, s *Service, root string) string {
	t.Helper()
	row, e := s.ImportSource(context.Background(), root, filepath.Base(root))
	must(t, e)
	sid := str(row, "source_id")
	_, e = s.Scan(context.Background(), sid)
	must(t, e)
	return sid
}
func imageAt(t *testing.T, s *Service, sid, rel string) Row {
	t.Helper()
	row, e := s.db.QueryRow(context.Background(), "SELECT * FROM gallery_assets WHERE source_id=? AND relative_path=?", sid, rel)
	must(t, e)
	if row == nil {
		t.Fatalf("no asset %s", rel)
	}
	return projectAsset(row)
}
func allImages(t *testing.T, s *Service, sid string) []Row {
	t.Helper()
	page, e := s.ListImages(context.Background(), ImageQuery{SourceID: sid, IncludeDescendants: true, Limit: 200})
	must(t, e)
	return page.Assets
}

func TestCatalogScanPaginationSearchAndVersions(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root := t.TempDir()
	for _, rel := range []string{"a2.png", "a10.png", "a1.png", "folder/sub/cat.png", "other/dog.png", "pair.jpg", "pair.png"} {
		picture(t, root, rel)
	}
	put(t, root, "a2.txt", []byte("blue cat\n"))
	put(t, root, "a10.txt", []byte("\xef\xbb\xbf   \r\n"))
	put(t, root, "a1.txt", []byte{0xff, 0xfe, 0})
	put(t, root, "pair.txt", []byte("shared"))
	put(t, root, "broken.png", []byte("not a picture"))
	picture(t, root, ".hidden/secret.png")
	picture(t, root, ".ldos/trash/x.png")
	picture(t, root, "_filtered/out.png")
	picture(t, root, "_duplicates/out.png")
	sid := importScan(t, s, root)
	source, e := s.Source(ctx, sid)
	must(t, e)
	if num(source, "asset_count") != 11 {
		t.Fatalf("source counts %#v", source)
	}
	initialContent := num(source, "content_version")
	initialAnnotations := num(source, "annotation_version")
	q := ImageQuery{SourceID: sid, IncludeDescendants: true, Limit: 2}
	names := []string{}
	seen := map[string]bool{}
	for {
		page, e := s.ListImages(ctx, q)
		must(t, e)
		for _, a := range page.Assets {
			if seen[str(a, "asset_id")] {
				t.Fatal("duplicate page asset")
			}
			seen[str(a, "asset_id")] = true
			names = append(names, str(a, "name"))
		}
		if page.AssetCursor == nil {
			break
		}
		q.AssetCursor = *page.AssetCursor
	}
	if len(names) != 11 || strings.Join(names[:3], ",") != "a1.png,a2.png,a10.png" {
		t.Fatalf("natural order %v", names)
	}
	states := map[string]string{"a1.png": "invalid_encoding", "a2.png": "normal", "a10.png": "blank", "pair.jpg": "pair_conflict", "pair.png": "pair_conflict"}
	for rel, want := range states {
		if got := str(imageAt(t, s, sid, rel), "txt_state"); got != want {
			t.Errorf("%s: %s != %s", rel, got, want)
		}
	}
	if str(imageAt(t, s, sid, "broken.png"), "read_state") != "failed" {
		t.Fatal("bad image not classified")
	}
	for _, term := range []string{"blue cat", "folder cat", "_", "%", "NOT"} {
		page, e := s.ListImages(ctx, ImageQuery{SourceID: sid, Query: term})
		must(t, e)
		want := 0
		if term == "blue cat" || term == "folder cat" {
			want = 1
		}
		if term == "_" {
			want = 2
		}
		if len(page.Assets) != want {
			t.Fatalf("search %q: %d", term, len(page.Assets))
		}
	}
	_, e = s.ListImages(ctx, ImageQuery{SourceID: sid, AssetCursor: "nonsense"})
	wantError(t, e, "invalid_cursor")
	_, e = s.ListImages(ctx, ImageQuery{SourceID: sid, TxtState: "bogus"})
	wantError(t, e, "invalid_txt_state")
	_, e = s.Scan(ctx, sid)
	must(t, e)
	source, e = s.Source(ctx, sid)
	must(t, e)
	if num(source, "content_version") != initialContent || num(source, "annotation_version") != initialAnnotations {
		t.Fatalf("no-op scan changed versions: %#v", source)
	}
	put(t, root, "a2.txt", []byte("green zebra"))
	_, e = s.Scan(ctx, sid)
	must(t, e)
	source, e = s.Source(ctx, sid)
	must(t, e)
	if num(source, "content_version") != initialContent || num(source, "annotation_version") != initialAnnotations+1 {
		t.Fatalf("caption changed content version %#v", source)
	}
	must(t, os.Remove(filepath.Join(root, "other/dog.png")))
	_, e = s.Scan(ctx, sid)
	must(t, e)
	if str(imageAt(t, s, sid, "other/dog.png"), "lifecycle_state") != "missing" {
		t.Fatal("deleted file not missing")
	}
	if len(allImages(t, s, sid)) != 10 {
		t.Fatal("missing asset visible")
	}
	rootDir, e := s.RootDirectory(ctx, sid)
	must(t, e)
	entries, e := s.DirectoryEntries(ctx, str(rootDir, "directory_id"), ImageQuery{Limit: 1})
	must(t, e)
	if entries["directory_cursor"] == nil {
		t.Fatal("directory cursor missing")
	}
	anc, e := s.Ancestors(ctx, DirectoryID(sid, "folder/sub"))
	must(t, e)
	if len(anc["ancestors"].([]Row)) != 2 {
		t.Fatal(anc)
	}
}

func TestSourceRegistrationRelinkRemovalAndRoots(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root := t.TempDir()
	picture(t, root, "x.png")
	sid := importScan(t, s, root)
	_, e := s.ImportSource(ctx, root, "duplicate")
	wantError(t, e, "source_conflict")
	must(t, os.Mkdir(filepath.Join(root, "nested"), 0755))
	_, e = s.ImportSource(ctx, filepath.Join(root, "nested"), "nested")
	wantError(t, e, "source_conflict")
	_, e = s.ImportSource(ctx, filepath.Dir(root), "parent")
	wantError(t, e, "source_conflict")
	moved := root + "-moved"
	must(t, os.Rename(root, moved))
	t.Cleanup(func() { _ = os.RemoveAll(moved) })
	stats, e := s.Scan(ctx, sid)
	must(t, e)
	if !truth(stats, "offline") {
		t.Fatal("missing source not offline")
	}
	source, e := s.Source(ctx, sid)
	must(t, e)
	if str(source, "availability") != "offline" {
		t.Fatal(source)
	}
	_, e = s.RelinkSource(ctx, sid, moved)
	must(t, e)
	_, e = s.Scan(ctx, sid)
	must(t, e)
	if str(imageAt(t, s, sid, "x.png"), "asset_id") != AssetID(sid, "x.png") {
		t.Fatal("relink changed ID")
	}
	must(t, s.UnregisterSource(ctx, sid))
	if _, e = os.Stat(filepath.Join(moved, "x.png")); e != nil {
		t.Fatal("unregister removed imported files")
	}
	source, e = s.ImportSource(ctx, moved, "again")
	must(t, e)
	e = s.DeleteBatchSource(ctx, str(source, "source_id"))
	wantError(t, e, "gallery_batch_source_required")
}

func TestAnnotationsConcurrencyBOMAndSearch(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root := t.TempDir()
	picture(t, root, "one.png")
	sid := importScan(t, s, root)
	aid := str(imageAt(t, s, sid, "one.png"), "asset_id")
	a, e := s.GetAnnotation(ctx, aid)
	must(t, e)
	if a["content"] != nil || str(a, "disk_version") != MissingDiskVersion {
		t.Fatal(a)
	}
	contentBefore := num(mustSource(t, s, sid), "content_version")
	written, e := s.SaveAnnotation(ctx, aid, "new kitten", num(a, "txt_version"), str(a, "disk_version"))
	must(t, e)
	if str(written, "content") != "new kitten" || num(written, "txt_version") != num(a, "txt_version")+1 {
		t.Fatal(written)
	}
	_, e = s.SaveAnnotation(ctx, aid, "stale", num(a, "txt_version"), str(a, "disk_version"))
	wantError(t, e, "txt_version_conflict")
	put(t, root, "one.txt", []byte("external"))
	_, e = s.SaveAnnotation(ctx, aid, "overwrite", num(written, "txt_version"), str(written, "disk_version"))
	wantError(t, e, "txt_disk_conflict")
	disk, e := s.GetAnnotation(ctx, aid)
	must(t, e)
	written, e = s.SaveAnnotation(ctx, aid, "accepted", num(disk, "txt_version"), str(disk, "disk_version"))
	must(t, e)
	put(t, root, "one.txt", append([]byte{0xef, 0xbb, 0xbf}, []byte("with bom")...))
	_, e = s.Scan(ctx, sid)
	must(t, e)
	a, e = s.GetAnnotation(ctx, aid)
	must(t, e)
	caption := "zebra caption"
	written, e = s.WriteAnnotation(ctx, aid, &caption, AnnotationWrite{ExpectedTxtVersion: num(a, "txt_version"), ExpectedDiskVersion: str(a, "disk_version"), PreserveBOM: true})
	must(t, e)
	raw, e := os.ReadFile(filepath.Join(root, "one.txt"))
	must(t, e)
	if !bytes.HasPrefix(raw, []byte{0xef, 0xbb, 0xbf}) {
		t.Fatal("BOM lost")
	}
	page, e := s.ListImages(ctx, ImageQuery{SourceID: sid, Query: "zebra"})
	must(t, e)
	if len(page.Assets) != 1 {
		t.Fatal("FTS not refreshed")
	}
	if num(mustSource(t, s, sid), "content_version") != contentBefore {
		t.Fatal("annotation invalidated content version")
	}
	removed, e := s.RemoveAnnotation(ctx, aid, num(written, "txt_version"), str(written, "disk_version"))
	must(t, e)
	if str(removed, "disk_version") != MissingDiskVersion || removed["content"] != nil {
		t.Fatal(removed)
	}
	page, e = s.ListImages(ctx, ImageQuery{SourceID: sid, Query: "zebra"})
	must(t, e)
	if len(page.Assets) != 0 {
		t.Fatal("deleted annotation remained searchable")
	}
	picture(t, root, "one.jpg")
	put(t, root, "one.txt", []byte("paired"))
	_, e = s.Scan(ctx, sid)
	must(t, e)
	a, e = s.GetAnnotation(ctx, aid)
	must(t, e)
	_, e = s.SaveAnnotation(ctx, aid, "wrong", num(a, "txt_version"), str(a, "disk_version"))
	wantError(t, e, "txt_pair_conflict")
}
func mustSource(t *testing.T, s *Service, sid string) Row {
	t.Helper()
	row, e := s.Source(context.Background(), sid)
	must(t, e)
	return row
}

func TestAnnotationRollsBackOnWriterFailure(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root := t.TempDir()
	picture(t, root, "a.png")
	put(t, root, "a.txt", []byte("old"))
	sid := importScan(t, s, root)
	aid := AssetID(sid, "a.png")
	a, e := s.GetAnnotation(ctx, aid)
	must(t, e)
	must(t, s.exec(ctx, `CREATE TRIGGER fail_annotation BEFORE UPDATE OF txt_version ON gallery_assets BEGIN SELECT RAISE(ABORT,'test writer failure'); END`))
	_, e = s.SaveAnnotation(ctx, aid, "new", num(a, "txt_version"), str(a, "disk_version"))
	if e == nil {
		t.Fatal("writer failure reported success")
	}
	b, e := os.ReadFile(filepath.Join(root, "a.txt"))
	must(t, e)
	if string(b) != "old" {
		t.Fatalf("rollback left %q", b)
	}
	must(t, s.exec(ctx, "DROP TRIGGER fail_annotation"))
}

func TestHTTPContractsContentRangeThumbnailAndErrors(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root := t.TempDir()
	picture(t, root, "folder/a.png")
	sid := importScan(t, s, root)
	aid := AssetID(sid, "folder/a.png")
	mux := http.NewServeMux()
	s.Register(mux)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	w := request("GET", "/api/v1/gallery/assets/"+aid, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var response Row
	must(t, json.Unmarshal(w.Body.Bytes(), &response))
	asset := response["asset"].(map[string]any)
	if _, ok := asset["sort_key"]; ok {
		t.Fatal("internal field leaked")
	}
	if response["source_roots"].(map[string]any)[sid] != root {
		t.Fatal(response)
	}
	w = request("GET", "/api/v1/gallery/sources/"+sid, "")
	if strings.Contains(w.Body.String(), root) {
		t.Fatal("root leaked into source DTO")
	}
	r := httptest.NewRequest("GET", "/api/v1/gallery/assets/"+aid+"/content", nil)
	r.Header.Set("Range", "bytes=0-7")
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 206 || w.Body.Len() != 8 || w.Header().Get("ETag") == "" {
		t.Fatal(w.Code, w.Body.String())
	}
	r = httptest.NewRequest("GET", "/api/v1/gallery/assets/"+aid+"/content", nil)
	r.Header.Set("If-None-Match", w.Header().Get("ETag"))
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 304 {
		t.Fatal(w.Code)
	}
	w = request("GET", "/api/v1/gallery/assets/"+aid+"/thumbnail?size=256", "")
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatal(w.Code, w.Body.String())
	}
	thumbnail, _, e := image.Decode(bytes.NewReader(w.Body.Bytes()))
	must(t, e)
	if thumbnail.Bounds().Dx() != 12 || thumbnail.Bounds().Dy() != 9 {
		t.Fatal(thumbnail.Bounds())
	}
	r = httptest.NewRequest("GET", "/api/v1/gallery/assets/"+aid+"/thumbnail?size=256", nil)
	r.Header.Set("If-None-Match", w.Header().Get("ETag"))
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 304 {
		t.Fatal(w.Code)
	}
	for _, uri := range []string{"/api/v1/gallery/trash", "/api/v1/gallery/search?query=x&scope=bad", "/api/v1/gallery/assets/" + aid + "/thumbnail?size=1"} {
		w = request("GET", uri, "")
		if w.Code != 422 {
			t.Fatal(uri, w.Code, w.Body.String())
		}
	}
	w = request("GET", "/api/v1/gallery/assets/missing", "")
	if w.Code != 404 {
		t.Fatal(w.Code)
	}
	f, _, e := s.OpenImage(ctx, aid)
	must(t, e)
	_, e = io.ReadAll(f)
	must(t, e)
	must(t, f.Close())
}

func TestWithSourcesNestedScopeAndUnrelatedContext(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root := t.TempDir()
	picture(t, root, "a.png")
	sid := importScan(t, s, root)
	var escaped context.Context
	must(t, s.WithSources(ctx, []string{sid}, func(held context.Context) error {
		escaped = held
		if _, e := s.Scan(held, sid); e != nil {
			return e
		}
		r, e := s.Trash(held, Selection{AssetIDs: []string{AssetID(sid, "a.png")}})
		if e != nil {
			return e
		}
		if _, e = s.Restore(held, r.OperationID); e != nil {
			return e
		}
		other, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
		defer cancel()
		release, e := s.LockSources(other, sid)
		if e == nil {
			release()
			t.Fatal("unrelated context bypassed lock")
		}
		return nil
	}))
	release, e := s.LockSources(ctx, sid)
	must(t, e)
	defer release()
	expired, cancel := context.WithTimeout(escaped, 20*time.Millisecond)
	defer cancel()
	_, e = s.LockSources(expired, sid)
	if !errors.Is(e, context.DeadlineExceeded) {
		t.Fatalf("expired owner reused lock: %v", e)
	}
}

func TestCatalogUsesCurrentStoreSchema(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	must(t, s.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		row, e := store.QueryRowTx(ctx, tx, "SELECT value FROM meta WHERE key='schema_version'")
		if e != nil {
			return e
		}
		if str(row, "value") != strconv.Itoa(store.CurrentSchemaVersion) {
			t.Errorf("schema drift %#v", row)
		}
		return nil
	}))
}
