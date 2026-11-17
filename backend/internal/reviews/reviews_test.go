package reviews

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"ldos/backend/internal/config"
	"ldos/backend/internal/store"
)

func TestMain(m *testing.M) {
	if os.Getenv("LDOS_REVIEWS_GO_EXECUTOR") == "1" {
		os.Exit(fakeProcess())
	}
	os.Exit(m.Run())
}
func fakeProcess() int {
	if len(os.Args) > 2 && os.Args[1] == "--child" {
		signal.Ignore(syscall.SIGTERM)
		_ = os.WriteFile(os.Args[2], []byte(strconv.Itoa(os.Getpid())), 0600)
		time.Sleep(time.Hour)
		return 0
	}
	if len(os.Args) < 2 {
		return 10
	}
	modeBytes, e := os.ReadFile(os.Args[1])
	if e != nil {
		return 11
	}
	mode := string(modeBytes)
	args := map[string]string{}
	root := ""
	for n := 2; n < len(os.Args); n++ {
		arg := os.Args[n]
		if strings.HasPrefix(arg, "--") {
			if n+1 < len(os.Args) && !strings.HasPrefix(os.Args[n+1], "--") {
				args[arg] = os.Args[n+1]
				n++
			}
		} else if root == "" {
			root = arg
		}
	}
	if mode == "hold" {
		signal.Ignore(syscall.SIGTERM)
		child := exec.Command(os.Args[0], "--child", os.Args[1]+".child")
		if child.Start() != nil {
			return 12
		}
		_ = os.WriteFile(os.Args[1]+".started", []byte(strconv.Itoa(os.Getpid())), 0600)
		time.Sleep(time.Hour)
		return 0
	}
	if mode == "fail" {
		fmt.Fprintln(os.Stderr, "password=do-not-leak bearer abc123")
		return 7
	}
	if mode == "bad" {
		_ = os.WriteFile(args["--output"], []byte(`{"schema_version":3,"groups":null}`), 0600)
		return 0
	}
	input := WorkerInput{OutputDir: root}
	if path := args["--input"]; path != "" {
		b, e := os.ReadFile(path)
		if e != nil {
			return 13
		}
		if json.Unmarshal(b, &input) != nil {
			return 14
		}
	}
	manifest := fakeManifest(input, mode)
	f, e := os.Create(args["--output"])
	if e != nil {
		return 15
	}
	defer f.Close()
	if json.NewEncoder(f).Encode(manifest) != nil {
		return 16
	}
	return 0
}
func fakeManifest(input WorkerInput, mode string) Manifest {
	m := Manifest{SchemaVersion: 2, Root: input.OutputDir, Counts: map[string]int{}, Groups: []ManifestGroup{}, AutoGroups: []ManifestGroup{}, FilteredItems: []ManifestImage{}}
	items := []ManifestImage{}
	if input.ReviewID != "" {
		m.SchemaVersion = 3
		m.Root = ""
		m.ReviewID = input.ReviewID
		m.FilterConfig = input.FilterConfig
		for n, v := range input.Images {
			items = append(items, ManifestImage{ID: v.AssetID, Ordinal: n + 1, RelativePath: v.SourceID + "/" + v.RelativePath, Recommended: n == 0, Metadata: Row{"w": 640, "h": 480, "secret": "not-public", "review_metrics": Row{"score": 0.5}}})
		}
	} else {
		_ = filepath.WalkDir(input.OutputDir, func(path string, d os.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if d.IsDir() {
				if path != input.OutputDir && excludedPath(d.Name()) {
					return filepath.SkipDir
				}
				return nil
			}
			if filepath.Ext(path) == ".jpg" || filepath.Ext(path) == ".png" {
				rel, _ := filepath.Rel(input.OutputDir, path)
				items = append(items, ManifestImage{ID: fmt.Sprintf("image-%d", len(items)+1), RelativePath: rel, Recommended: len(items) == 0, Metadata: Row{"w": 640, "h": 480, "secret": "not-public"}})
			}
			return nil
		})
	}
	m.Counts["images"] = len(items)
	if mode == "automatic" && len(items) > 1 {
		m.AutoGroups = append(m.AutoGroups, ManifestGroup{ID: "automatic", Kind: "exact", Winner: items[0], RejectedItems: []ManifestImage{items[1]}})
		items = append(items[:1], items[2:]...)
	}
	if mode == "filtered" && len(items) > 0 {
		items[0].Reason = "filter_character"
		m.FilteredItems = append(m.FilteredItems, items[0])
		items = items[1:]
	}
	if len(items) > 0 {
		kind := "single"
		if len(items) > 1 {
			kind = "duplicate"
		}
		m.Groups = append(m.Groups, ManifestGroup{ID: "group", Ordinal: 1, Kind: kind, Items: items})
	}
	return m
}

type fixture struct {
	t         *testing.T
	db        *store.Store
	s         *Service
	ctx       context.Context
	dir, root string
	lock      sync.Mutex
}

func newFixture(t *testing.T, enabled bool) *fixture {
	t.Helper()
	dir := t.TempDir()
	db, e := store.Open(filepath.Join(dir, "db.sqlite3"))
	if e != nil {
		t.Fatal(e)
	}
	f := &fixture{t: t, db: db, ctx: context.Background(), dir: dir, root: filepath.Join(dir, "images")}
	if e = os.MkdirAll(f.root, 0700); e != nil {
		t.Fatal(e)
	}
	deps := Dependencies{Store: db, Settings: config.Settings{RuntimeDir: filepath.Join(dir, "runtime")}, Dedup: Settings{Enabled: enabled, PollInterval: time.Hour, ShutdownGrace: 30 * time.Millisecond}}
	deps.Runner = func(ctx context.Context, input WorkerInput) (Manifest, string, error) {
		return fakeManifest(input, "manual"), "", nil
	}
	deps.Gallery = GalleryCallbacks{HoldSources: func(ctx context.Context, _ []string, fn func(context.Context) error) error {
		f.lock.Lock()
		defer f.lock.Unlock()
		return fn(ctx)
	}, ScanSource: func(context.Context, string) error { return nil }, TrashAsset: f.trash, RestoreTrash: f.restore, RecoverFiles: func(context.Context) error { return nil }, CheckFilters: func(ctx context.Context, names []string) (map[string]Capability, error) {
		out := map[string]Capability{}
		for _, name := range names {
			out[name] = Capability{Available: true}
		}
		return out, nil
	}}
	f.s, e = New(f.ctx, deps)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = f.s.Stop(); _ = db.Close() })
	return f
}
func (f *fixture) exec(q string, args ...any) {
	f.t.Helper()
	e := f.db.WriteTransaction(f.ctx, func(tx *sql.Tx) error { _, e := tx.ExecContext(f.ctx, q, args...); return e })
	if e != nil {
		f.t.Fatalf("%s: %v", q, e)
	}
}
func (f *fixture) file(path string) {
	f.t.Helper()
	absolute := filepath.Join(f.root, path)
	if e := os.MkdirAll(filepath.Dir(absolute), 0700); e != nil {
		f.t.Fatal(e)
	}
	if e := os.WriteFile(absolute, []byte("file:"+path), 0600); e != nil {
		f.t.Fatal(e)
	}
}
func (f *fixture) crawl(id string) {
	f.exec("INSERT INTO crawl_batches(id,status,output_dir,concurrency,max_tasks,created_at,updated_at,finished_at) VALUES(?,'succeeded',?,1,10,1,1,1)", id, f.root)
}
func (f *fixture) source(id string, paths ...string) {
	f.t.Helper()
	f.exec("INSERT INTO gallery_sources(id,kind,display_name,root_path,canonical_root_key,created_at,updated_at) VALUES(?,'local',?,?,?,1,1)", id, "Source "+id, f.root, id)
	f.exec("INSERT INTO gallery_directories(id,source_id,relative_path,name,sort_key,created_at,updated_at) VALUES(?,?,'','Images','images',1,1)", id+"-root", id)
	for n, path := range paths {
		f.file(path)
		f.exec("INSERT INTO gallery_assets(id,source_id,directory_id,relative_path,name,extension,sort_key,size_bytes,modified_ns,txt_relative_path,created_at,updated_at) VALUES(?,?,?,?,?,'jpg',?,1,1,?,1,1)", fmt.Sprintf("%s-%d", id, n+1), id, id+"-root", path, filepath.Base(path), path, captionPath(path))
	}
}
func (f *fixture) trash(ctx context.Context, assetID, op string, snapshot Snapshot) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	r, e := openRoot(snapshot.RootPath)
	if e != nil {
		return e
	}
	defer r.close()
	target := ".ldos/trash/" + op + "/files/" + snapshot.RelativePath
	if e = r.move(snapshot.RelativePath, target); e != nil {
		return e
	}
	txt, e := regularCaption(r, snapshot.TXTRelativePath)
	if e != nil {
		return e
	}
	if txt {
		if e = r.move(snapshot.TXTRelativePath, captionPath(target)); e != nil {
			return e
		}
	}
	return f.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if _, e = tx.ExecContext(ctx, "INSERT INTO gallery_file_operations(id,kind,status,created_at,updated_at) VALUES(?,'trash','committed',?,?) ON CONFLICT(id) DO UPDATE SET status='committed'", op, now(), now()); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, "INSERT INTO gallery_file_operation_items(operation_id,ordinal,source_id,asset_id,origin_relative_path,target_relative_path,has_txt,status) VALUES(?,0,?,?,?,?,?,'committed') ON CONFLICT(operation_id,ordinal) DO UPDATE SET status='committed'", op, snapshot.SourceID, assetID, snapshot.RelativePath, target, txt); e != nil {
			return e
		}
		_, e = tx.ExecContext(ctx, "UPDATE gallery_assets SET lifecycle_state='trashed',content_version=content_version+1 WHERE id=?", assetID)
		return e
	})
}
func (f *fixture) restore(ctx context.Context, op string) error {
	item, e := f.db.QueryRow(ctx, "SELECT i.*,s.root_path FROM gallery_file_operation_items i JOIN gallery_sources s ON s.id=i.source_id WHERE i.operation_id=?", op)
	if e != nil {
		return e
	}
	r, e := openRoot(text(item["root_path"]))
	if e != nil {
		return e
	}
	defer r.close()
	source, target := text(item["target_relative_path"]), text(item["origin_relative_path"])
	if e = r.move(source, target); e != nil {
		return e
	}
	if truth(item["has_txt"]) {
		if e = r.move(captionPath(source), captionPath(target)); e != nil {
			return e
		}
	}
	return f.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		_, e := tx.ExecContext(ctx, "UPDATE gallery_assets SET lifecycle_state='active',content_version=content_version+1 WHERE id=?", item["asset_id"])
		return e
	})
}
func (f *fixture) process(mode string) {
	f.t.Helper()
	f.s.deps.Runner = nil
	program, e := os.Executable()
	if e != nil {
		f.t.Fatal(e)
	}
	script := filepath.Join(f.dir, "fake-worker")
	if e = os.WriteFile(script, []byte(mode), 0600); e != nil {
		f.t.Fatal(e)
	}
	f.s.deps.Dedup.PythonExecutable = program
	f.s.deps.Dedup.WorkerScript = script
	f.s.deps.Dedup.CoreScript = script
	f.t.Setenv("LDOS_REVIEWS_GO_EXECUTOR", "1")
}
func (f *fixture) run() {
	f.t.Helper()
	worked, e := f.s.RunOnce(f.ctx)
	if e != nil || !worked {
		f.t.Fatalf("RunOnce worked=%t err=%v", worked, e)
	}
}
func (f *fixture) gallery(assets ...string) string {
	f.t.Helper()
	v, e := f.s.CreateGallery(f.ctx, nil, assets, nil)
	if e != nil {
		f.t.Fatal(e)
	}
	return text(v["review_id"])
}
func (f *fixture) request(method, path, body string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	f.s.Register(mux)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
	return w
}
func assertStatus(t *testing.T, row Row, want string, e error) {
	t.Helper()
	if e != nil || text(row["status"]) != want {
		t.Fatalf("status %v, expected %s: %v", row, want, e)
	}
}
func expectCode(t *testing.T, e error, code string) {
	t.Helper()
	var v *Error
	if !errors.As(e, &v) || v.Code != code {
		t.Fatalf("expected %s, got %v", code, e)
	}
}

func TestCrawlLifecycleProcessArtifactsAndReconciliation(t *testing.T) {
	f := newFixture(t, true)
	f.crawl("crawl")
	f.file("a.jpg")
	f.file("b.jpg")
	f.file("b.txt")
	f.source("source")
	f.exec("UPDATE gallery_sources SET batch_id='crawl' WHERE id='source'")
	f.process("manual")
	v, e := f.s.StartCrawl(f.ctx, "crawl")
	assertStatus(t, v, "pending", e)
	v, e = f.s.StartCrawl(f.ctx, "crawl")
	assertStatus(t, v, "pending", e)
	f.run()
	v, e = f.s.GetCrawl(f.ctx, "crawl")
	assertStatus(t, v, "ready", e)
	p, e := f.s.CrawlGroups(f.ctx, "crawl", GroupQuery{All: true})
	if e != nil || p.Total != 1 {
		t.Fatal(p, e)
	}
	images := p.Items[0]["images"].([]Row)
	if len(images) != 2 || number(v["selected_image_count"]) != 2 {
		t.Fatal(v, p)
	}
	_, e = f.s.ApplyCrawl(f.ctx, "crawl")
	expectCode(t, e, "review_state_conflict")
	v, e = f.s.UpdateCrawlDecisions(f.ctx, "crawl", []Decision{{GroupID: "group", SelectedImageIDs: []string{text(images[0]["id"])}}})
	assertStatus(t, v, "ready", e)
	v, e = f.s.ApplyCrawl(f.ctx, "crawl")
	assertStatus(t, v, "applied", e)
	if number(v["kept_image_count"]) != 1 || number(v["rejected_image_count"]) != 1 {
		t.Fatal(v)
	}
	for _, path := range []string{"duplicates/b.jpg", "duplicates/b.txt"} {
		if _, e = os.Stat(filepath.Join(f.root, path)); e != nil {
			t.Fatal(e)
		}
	}
	event, e := f.db.QueryRow(f.ctx, "SELECT * FROM gallery_reconciliation_events WHERE batch_id='crawl'")
	if e != nil || event == nil || text(event["status"]) != "pending" {
		t.Fatal(event, e)
	}
	for _, ext := range []string{".json", ".log"} {
		st, e := os.Stat(filepath.Join(f.s.runtime, "crawl"+ext))
		if e != nil || st.Mode().Perm() != 0600 {
			t.Fatal(st, e)
		}
	}
	w := f.request("GET", "/api/v1/crawls/crawl/review?view=desktop", "")
	if w.Code != 200 || strings.Contains(w.Body.String(), "not-public") || strings.Contains(w.Body.String(), f.root) {
		t.Fatal(w.Code, w.Body.String())
	}
	image, e := f.s.OpenCrawlImage(f.ctx, "crawl", text(images[1]["id"]))
	if e != nil {
		t.Fatal(e)
	}
	defer image.Close()
	b, _ := io.ReadAll(image)
	if string(b) != "file:b.jpg" {
		t.Fatal(string(b))
	}
}
func TestGalleryAdoptUndoAndRepeatedReject(t *testing.T) {
	f := newFixture(t, true)
	f.source("src", "a.jpg", "b.jpg")
	f.file("b.txt")
	id := f.gallery("src-1", "src-2")
	f.run()
	v, e := f.s.GetGallery(f.ctx, id)
	assertStatus(t, v, "ready", e)
	v, e = f.s.AdoptGroup(f.ctx, id, "group", []string{"src-1"}, number(v["version"]), false)
	assertStatus(t, v, "ready", e)
	if number(v["rejected_image_count"]) != 1 {
		t.Fatal(v)
	}
	image, e := f.s.OpenGalleryImage(f.ctx, id, "src-2")
	if e != nil {
		t.Fatal(e)
	}
	image.Close()
	_, e = f.s.AdoptGroup(f.ctx, id, "group", []string{"src-1", "src-2"}, 1, false)
	expectCode(t, e, "review_state_conflict")
	v, e = f.s.AdoptGroup(f.ctx, id, "group", []string{"src-1", "src-2"}, number(v["version"]), false)
	assertStatus(t, v, "ready", e)
	if _, e = os.Stat(filepath.Join(f.root, "b.txt")); e != nil {
		t.Fatal(e)
	}
	if e = f.s.ResetGroupDecided(f.ctx, id, "group"); e != nil {
		t.Fatal(e)
	}
	v, e = f.s.GetGallery(f.ctx, id)
	if e != nil || number(v["decided_group_count"]) != 0 {
		t.Fatal(v, e)
	}
	v, e = f.s.AdoptGroup(f.ctx, id, "group", []string{"src-1"}, number(v["version"]), false)
	assertStatus(t, v, "ready", e)
	if _, e = os.Stat(filepath.Join(f.root, ".ldos/trash/"+TrashOperationID(id, "src-2", 1)+"/files/b.jpg")); e != nil {
		t.Fatal(e)
	}
	if e = f.s.FinishGallery(f.ctx, id); e != nil {
		t.Fatal(e)
	}
	_, e = f.s.GetGallery(f.ctx, id)
	expectCode(t, e, "review_not_found")
	if _, e = os.Stat(filepath.Join(f.root, "b.jpg")); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("finish restored a rejected file", e)
	}
}
func TestAutomaticCleanupAndTriageUndo(t *testing.T) {
	f := newFixture(t, true)
	f.source("src", "a.jpg", "b.jpg")
	f.s.deps.Runner = func(ctx context.Context, input WorkerInput) (Manifest, string, error) {
		return fakeManifest(input, "automatic"), "", nil
	}
	id := f.gallery("src-1", "src-2")
	f.run()
	v, e := f.s.GetGallery(f.ctx, id)
	assertStatus(t, v, "ready", e)
	if number(v["automatic_rejected_image_count"]) != 1 || number(v["rejected_image_count"]) != 1 {
		t.Fatal(v)
	}
	p, e := f.s.GalleryGroups(f.ctx, id, GroupQuery{All: true})
	if e != nil || p.Total != 1 {
		t.Fatal(p, e)
	}
	p, e = f.s.GalleryGroups(f.ctx, id, GroupQuery{All: true, IncludeAutomatic: true})
	if e != nil || p.Total != 2 {
		t.Fatal(p, e)
	}
	_, e = f.s.AdoptGroup(f.ctx, id, "automatic", []string{"src-2"}, number(v["version"]), false)
	expectCode(t, e, "review_state_conflict")
	v, e = f.s.AdoptGroup(f.ctx, id, "automatic", []string{"src-2"}, number(v["version"]), true)
	assertStatus(t, v, "ready", e)
	if _, e = os.Stat(filepath.Join(f.root, "b.jpg")); e != nil {
		t.Fatal(e)
	}
}
func TestGalleryPreflightPreventsPartialAutomaticDeletion(t *testing.T) {
	f := newFixture(t, true)
	f.source("src", "a.jpg", "b.jpg", "c.jpg")
	id := f.gallery("src-1", "src-2", "src-3")
	input, e := f.s.workerInput(f.ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	f.exec("UPDATE gallery_reviews SET status='analyzing' WHERE review_id=?", id)
	m := fakeManifest(input, "automatic")
	if e = validateManifest(input, m); e != nil {
		t.Fatal(e)
	}
	if e = f.s.replaceManifest(f.ctx, identity{id, true}, m, ""); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(f.root, "c.jpg"), []byte("changed"), 0600); e != nil {
		t.Fatal(e)
	}
	f.run()
	v, e := f.s.GetGallery(f.ctx, id)
	assertStatus(t, v, "ready", e)
	if number(v["failed_image_count"]) != 1 {
		t.Fatal(v)
	}
	if _, e = os.Stat(filepath.Join(f.root, "b.jpg")); e != nil {
		t.Fatal("deleted before validating all input", e)
	}
}
func TestLegacyReviewPreservationRefreshAndStartupRecovery(t *testing.T) {
	f := newFixture(t, true)
	f.source("src", "a.jpg")
	id := f.gallery("src-1")
	f.run()
	f.exec("INSERT INTO meta(key,value) VALUES(?,?)", "legacy_gallery_review:"+id, "12")
	before, _ := f.db.QueryRow(f.ctx, "SELECT * FROM gallery_reviews WHERE review_id=?", id)
	groupsBefore, _ := f.db.QueryRows(f.ctx, "SELECT * FROM gallery_review_groups WHERE review_id=?", id)
	f.s.enabled.Store(false)
	if e := f.s.Start(); e != nil {
		t.Fatal(e)
	}
	_ = f.s.Stop()
	var newErr error
	f.s, newErr = New(f.ctx, f.s.deps)
	if newErr != nil {
		t.Fatal(newErr)
	}
	after, _ := f.db.QueryRow(f.ctx, "SELECT * FROM gallery_reviews WHERE review_id=?", id)
	if encode(before) != encode(after) {
		t.Fatal("legacy raw row changed")
	}
	v, e := f.s.GetGallery(f.ctx, id)
	assertStatus(t, v, "failed", e)
	_, e = f.s.AdoptGroup(f.ctx, id, "group", nil, number(v["version"]), false)
	expectCode(t, e, "review_state_conflict")
	worked, e := f.s.RunOnce(f.ctx)
	if e != nil || worked {
		t.Fatal(worked, e)
	}
	v, e = f.s.RetryGallery(f.ctx, id)
	assertStatus(t, v, "pending", e)
	marker, _ := f.db.QueryRow(f.ctx, "SELECT value FROM meta WHERE key=?", "legacy_gallery_review:"+id)
	if marker != nil {
		t.Fatal(marker)
	}
	groupsAfter, _ := f.db.QueryRows(f.ctx, "SELECT * FROM gallery_review_groups WHERE review_id=?", id)
	if encode(groupsBefore) != encode(groupsAfter) {
		t.Fatal("retry discarded legacy decisions before validated manifest")
	}
	f.run()
	v, e = f.s.GetGallery(f.ctx, id)
	assertStatus(t, v, "ready", e)
}
func TestRecoveryEvenWhenDisabledAndRetries(t *testing.T) {
	f := newFixture(t, false)
	f.crawl("crawl")
	f.exec("INSERT INTO crawl_reviews(batch_id,status,created_at,updated_at) VALUES('crawl','analyzing',1,1)")
	f.exec("INSERT INTO gallery_reviews(review_id,status,created_at,updated_at) VALUES('saved','ready',1,1)")
	if e := f.s.Start(); e != nil {
		t.Fatal(e)
	}
	v, e := f.s.GetCrawl(f.ctx, "crawl")
	assertStatus(t, v, "pending", e)
	v, e = f.s.GetGallery(f.ctx, "saved")
	assertStatus(t, v, "ready", e)
	_, e = f.s.RetryCrawl(f.ctx, "crawl")
	expectCode(t, e, "review_state_conflict")
}
func TestSelectionBoundsSymlinksAndSnapshotChanges(t *testing.T) {
	f := newFixture(t, true)
	f.source("src", "a.jpg", "duplicates/b.jpg")
	_, e := f.s.CreateGallery(f.ctx, nil, []string{"src-2"}, nil)
	expectCode(t, e, "review_state_conflict")
	v, e := f.s.CreateGallery(f.ctx, []string{"src-root", "src-root"}, []string{"src-1"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	id := text(v["review_id"])
	input, e := f.s.workerInput(f.ctx, id)
	if e != nil || len(input.Images) != 1 {
		t.Fatal(input, e)
	}
	if e = os.Remove(filepath.Join(f.root, "a.jpg")); e != nil {
		t.Fatal(e)
	}
	outside := filepath.Join(f.dir, "outside.jpg")
	if e = os.WriteFile(outside, []byte("outside"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.Symlink(outside, filepath.Join(f.root, "a.jpg")); e != nil {
		t.Fatal(e)
	}
	_, e = f.s.RunOnce(f.ctx)
	if e == nil {
		t.Fatal("analyzed symlink")
	}
	v, e = f.s.GetGallery(f.ctx, id)
	assertStatus(t, v, "failed", e)
	b, _ := os.ReadFile(outside)
	if string(b) != "outside" {
		t.Fatal("outside changed")
	}
}
func TestCrawlMoveResumeCollisionAndTaskArtifacts(t *testing.T) {
	f := newFixture(t, true)
	f.crawl("crawl")
	f.file("a.jpg")
	f.file("a.txt")
	f.file("duplicates/a.jpg")
	f.file("duplicates/a_1.txt")
	f.exec("INSERT INTO tasks(id,url,site,status,output_dir,proxy_mode,max_attempts,next_run_at,created_at,updated_at) VALUES('task','https://example.invalid','site','succeeded',?,'direct',1,1,1,1)", f.root)
	f.exec("INSERT INTO crawl_addresses(id,batch_id,site,source_order,address_order,url,status,proxy_mode,max_attempts,created_at,updated_at) VALUES('address','crawl','site',0,0,'https://example.invalid','succeeded','direct',1,1,1)")
	f.exec("INSERT INTO crawl_address_tasks(address_id,task_id,sequence_no,created_at) VALUES('address','task',0,1)")
	f.exec("UPDATE tasks SET artifact_count=1,artifact_bytes=10 WHERE id='task'")
	_, e := f.s.StartCrawl(f.ctx, "crawl")
	if e != nil {
		t.Fatal(e)
	}
	f.run()
	_, e = f.s.UpdateCrawlDecisions(f.ctx, "crawl", []Decision{{GroupID: "group", SelectedImageIDs: []string{}}})
	if e != nil {
		t.Fatal(e)
	}
	v, e := f.s.ApplyCrawl(f.ctx, "crawl")
	assertStatus(t, v, "applied", e)
	if _, e = os.Stat(filepath.Join(f.root, "duplicates/a_2.jpg")); e != nil {
		t.Fatal(e)
	}
	artifact, e := f.db.QueryRow(f.ctx, "SELECT artifact_count,artifact_bytes FROM tasks WHERE id='task'")
	if e != nil || number(artifact["artifact_count"]) != 1 || number(artifact["artifact_bytes"]) != 10 {
		t.Fatal(artifact, e)
	}
	// A crash after moving the image but before its caption resumes from the journal.
	f.file("resume.txt")
	f.file("duplicates/resume.jpg")
	f.exec("UPDATE crawl_reviews SET status='apply_failed' WHERE batch_id='crawl'")
	f.exec("UPDATE crawl_review_images SET relative_path='resume.jpg',final_relative_path='duplicates/resume.jpg',disposition='moving' WHERE batch_id='crawl'")
	v, e = f.s.ApplyCrawl(f.ctx, "crawl")
	assertStatus(t, v, "applied", e)
	if _, e = os.Stat(filepath.Join(f.root, "duplicates/resume.txt")); e != nil {
		t.Fatal(e)
	}
}
func TestDecisionTransactionPaginationClassificationAndHTTP(t *testing.T) {
	f := newFixture(t, true)
	f.crawl("crawl")
	f.file("a.jpg")
	f.file("b.jpg")
	_, e := f.s.StartCrawl(f.ctx, "crawl")
	if e != nil {
		t.Fatal(e)
	}
	f.run()
	_, e = f.s.UpdateCrawlDecisions(f.ctx, "crawl", []Decision{{GroupID: "group", SelectedImageIDs: []string{}}, {GroupID: "missing", SelectedImageIDs: []string{}}})
	expectCode(t, e, "review_not_found")
	v, e := f.s.GetCrawl(f.ctx, "crawl")
	if e != nil || number(v["selected_image_count"]) != 2 || number(v["decided_group_count"]) != 0 {
		t.Fatal(v, e)
	}
	f.exec("UPDATE crawl_review_images SET metadata_json=? WHERE id='image-1'", `{"w":800,"h":600,"classification":"rough","secret":"hidden"}`)
	for _, test := range []struct {
		query  string
		status int
	}{{"?classification=rough", 200}, {"?classification=other", 422}, {"?limit=51", 422}, {"?limit=0", 422}, {"?offset=-1", 422}, {"?view=unknown", 422}, {"?classification=bad", 422}, {"?kind=auto_exact", 422}, {"?all=true&limit=1", 200}} {
		w := f.request("GET", "/api/v1/crawls/crawl/review"+test.query, "")
		if w.Code != test.status {
			t.Fatalf("%s: %d %s", test.query, w.Code, w.Body.String())
		}
	}
	w := f.request("GET", "/api/v1/crawls/crawl/review?view=desktop&classification=rough", "")
	if strings.Contains(w.Body.String(), "hidden") || strings.Contains(w.Body.String(), "relative_path") || !strings.Contains(w.Body.String(), `"classification":"rough"`) {
		t.Fatal(w.Body.String())
	}
	for _, body := range []string{`{"groups":[]}`, `{"groups":[{"group_id":"group","selected_image_ids":["image-1","image-1"]}]}`, `{"groups":[{"group_id":"group","selected_image_ids":[],"extra":true}]}`} {
		w = f.request("PUT", "/api/v1/crawls/crawl/review/decisions", body)
		if w.Code != 422 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}
func TestPresetsAndStrictFilterValidation(t *testing.T) {
	f := newFixture(t, true)
	w := f.request("GET", "/api/v1/gallery/review-presets", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "builtin-style") {
		t.Fatal(w.Code, w.Body.String())
	}
	valid := `{"name":" Custom ","options":{"basic_dedup":true,"filter_monochrome":false,"filter_sketch":false,"filter_character":false,"similarity_groups":false,"reference_asset_ids":[]}}`
	w = f.request("POST", "/api/v1/gallery/review-presets", valid)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var p Preset
	if e := json.Unmarshal(w.Body.Bytes(), &p); e != nil || p.Name != "Custom" {
		t.Fatal(p, e)
	}
	w = f.request("PUT", "/api/v1/gallery/review-presets/builtin-style", valid)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = f.request("DELETE", "/api/v1/gallery/review-presets/builtin-style", "")
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = f.request("DELETE", "/api/v1/gallery/review-presets/"+p.ID, "")
	if w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, body := range []string{`{"name":"x"}`, strings.Replace(valid, `"basic_dedup":true`, `"basic_dedup":1`, 1), strings.Replace(valid, `"filter_sketch":false,`, "", 1), strings.Replace(valid, `"reference_asset_ids":[]`, `"reference_asset_ids":null`, 1), strings.Replace(valid, `"name":" Custom "`, `"name":"\tbad"`, 1)} {
		w = f.request("POST", "/api/v1/gallery/review-presets", body)
		if w.Code != 422 {
			t.Fatal(body, w.Code, w.Body.String())
		}
	}
	f.source("src", "a.jpg")
	cfg := &FilterConfig{PresetName: "filter", Options: FilterOptions{FilterCharacter: true, ReferenceAssetIDs: []string{}}}
	_, e := f.s.CreateGallery(f.ctx, nil, []string{"src-1"}, cfg)
	expectCode(t, e, "filter_reference_required")
	cfg.Options.ReferenceAssetIDs = []string{"src-1"}
	_, e = f.s.CreateGallery(f.ctx, nil, []string{"src-1"}, cfg)
	expectCode(t, e, "filter_reference_invalid")
	imageFile, e := os.Create(filepath.Join(f.root, "a.jpg"))
	if e != nil {
		t.Fatal(e)
	}
	pixels := image.NewRGBA(image.Rect(0, 0, 2, 2))
	pixels.Set(0, 0, color.White)
	if e = png.Encode(imageFile, pixels); e != nil {
		t.Fatal(e)
	}
	imageFile.Close()
	cfg.Options.FilterCharacter = false
	cfg.Options.FilterMonochrome = true
	f.s.deps.Gallery.CheckFilters = func(context.Context, []string) (map[string]Capability, error) {
		return map[string]Capability{"completeness": {Available: false, Reason: "missing model"}}, nil
	}
	_, e = f.s.CreateGallery(f.ctx, nil, []string{"src-1"}, cfg)
	expectCode(t, e, "review_filter_unavailable")
}
func waitFile(t *testing.T, path string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		b, e := os.ReadFile(path)
		if e == nil && len(b) > 0 {
			return string(b)
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for " + path)
	return ""
}
func TestStopKillsProcessGroupAndPreventsLateWrites(t *testing.T) {
	f := newFixture(t, true)
	f.crawl("crawl")
	f.file("a.jpg")
	f.process("hold")
	_, e := f.s.StartCrawl(f.ctx, "crawl")
	if e != nil {
		t.Fatal(e)
	}
	result := make(chan error, 1)
	go func() { _, e := f.s.RunOnce(f.ctx); result <- e }()
	pid, _ := strconv.Atoi(waitFile(t, f.s.deps.Dedup.WorkerScript+".started"))
	child, _ := strconv.Atoi(waitFile(t, f.s.deps.Dedup.WorkerScript+".child"))
	before, _ := f.db.QueryRow(f.ctx, "SELECT * FROM crawl_reviews WHERE batch_id='crawl'")
	if e = f.s.Stop(); e != nil {
		t.Fatal(e)
	}
	if !errors.Is(<-result, context.Canceled) {
		t.Fatal("worker wasn't canceled")
	}
	after, _ := f.db.QueryRow(f.ctx, "SELECT * FROM crawl_reviews WHERE batch_id='crawl'")
	if encode(before) != encode(after) {
		t.Fatal("canceled owner wrote review")
	}
	if e = syscall.Kill(pid, 0); !errors.Is(e, syscall.ESRCH) {
		t.Fatal("leader remains", pid, e)
	}
	// A killed orphan may briefly be a zombie until PID 1 reaps it.
	data, _ := os.ReadFile(fmt.Sprintf("/proc/%d/stat", child))
	if len(data) > 0 && !strings.Contains(string(data), ") Z ") {
		t.Fatal("child remains running", string(data))
	}
	_, e = f.s.RetryCrawl(f.ctx, "crawl")
	if !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	if e = f.s.Start(); e == nil {
		t.Fatal("restarted stopped service")
	}
}
func TestFinishCancelsGalleryBeforeReturning(t *testing.T) {
	f := newFixture(t, true)
	f.source("src", "a.jpg")
	id := f.gallery("src-1")
	f.process("hold")
	result := make(chan error, 1)
	go func() { _, e := f.s.RunOnce(f.ctx); result <- e }()
	waitFile(t, f.s.deps.Dedup.WorkerScript+".started")
	waitFile(t, f.s.deps.Dedup.WorkerScript+".child")
	if e := f.s.FinishGallery(f.ctx, id); e != nil {
		t.Fatal(e)
	}
	if !errors.Is(<-result, context.Canceled) {
		t.Fatal("worker not canceled")
	}
	row, e := f.db.QueryRow(f.ctx, "SELECT * FROM gallery_reviews WHERE review_id=?", id)
	if e != nil || row != nil {
		t.Fatal(row, e)
	}
	rows, e := f.db.QueryRows(f.ctx, "SELECT * FROM gallery_review_groups WHERE review_id=?", id)
	if e != nil || len(rows) != 0 {
		t.Fatal(rows, e)
	}
}
func TestConcurrentReviewSerializationAndCanceledCaller(t *testing.T) {
	f := newFixture(t, true)
	f.crawl("one")
	f.crawl("two")
	f.file("a.jpg")
	_, _ = f.s.StartCrawl(f.ctx, "one")
	_, _ = f.s.StartCrawl(f.ctx, "two")
	var active, maxActive atomic.Int32
	var orderMu sync.Mutex
	order := []string{}
	f.s.deps.Runner = func(ctx context.Context, input WorkerInput) (Manifest, string, error) {
		n := active.Add(1)
		defer active.Add(-1)
		if n > maxActive.Load() {
			maxActive.Store(n)
		}
		orderMu.Lock()
		order = append(order, input.BatchID)
		orderMu.Unlock()
		time.Sleep(10 * time.Millisecond)
		return fakeManifest(input, "manual"), "", nil
	}
	var wg sync.WaitGroup
	for n := 0; n < 4; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := f.s.RunOnce(f.ctx)
			if e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	sort.Strings(order)
	if maxActive.Load() != 1 || strings.Join(order, ",") != "one,two" {
		t.Fatal(maxActive.Load(), order)
	}
	ctx, cancel := context.WithCancel(f.ctx)
	cancel()
	_, e := f.s.UpdateCrawlDecisions(ctx, "one", []Decision{{GroupID: "group", SelectedImageIDs: []string{}}})
	if !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	v, e := f.s.GetCrawl(f.ctx, "one")
	if e != nil || number(v["decided_group_count"]) != 0 {
		t.Fatal(v, e)
	}
}
func TestInvalidManifestAndWorkerFailureCannotReplaceDecisions(t *testing.T) {
	for _, mode := range []string{"fail", "bad"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t, true)
			f.crawl("crawl")
			f.file("a.jpg")
			_, e := f.s.StartCrawl(f.ctx, "crawl")
			if e != nil {
				t.Fatal(e)
			}
			f.process(mode)
			_, e = f.s.RunOnce(f.ctx)
			if e == nil {
				t.Fatal("worker should fail")
			}
			v, e := f.s.GetCrawl(f.ctx, "crawl")
			assertStatus(t, v, "failed", e)
			if strings.Contains(text(v["error"]), "do-not-leak") {
				t.Fatal(v)
			}
			v, e = f.s.RetryCrawl(f.ctx, "crawl")
			assertStatus(t, v, "pending", e)
		})
	}
}
