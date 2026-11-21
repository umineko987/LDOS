package captions

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"ldos/backend/internal/store"
)

type fixture struct {
	t            *testing.T
	db           *store.Store
	s            *Service
	root, dbPath string
	mu           sync.Mutex
	versions     map[string]int64
	unavailable  map[string]string
	writeErrors  map[string]error
	hook         func(context.Context, string)
	calls        []string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	dbPath := filepath.Join(root, "state.db")
	db, e := store.Open(dbPath)
	must(t, e)
	f := &fixture{t: t, db: db, root: root, dbPath: dbPath, versions: map[string]int64{}, unavailable: map[string]string{}, writeErrors: map[string]error{}}
	f.exec("INSERT INTO datasets(id,name,kind,trigger_word,created_at,updated_at) VALUES('d','Dataset','character','trigger',1,1)")
	f.s = f.service()
	t.Cleanup(func() { _ = f.s.Stop(); _ = f.db.Close() })
	return f
}
func (f *fixture) service() *Service {
	s, e := New(context.Background(), Dependencies{Store: f.db, StageInput: func(ctx context.Context, id, stage string) ([]Row, error) {
		if stage != "export" {
			f.t.Fatalf("captions requested retired or unexpected stage %q", stage)
		}
		if id != "d" {
			return nil, Fail(404, "dataset_not_found", "missing")
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		out := []Row{}
		for _, aid := range []string{"a", "b", "c", "d"} {
			if _, ok := f.versions[aid]; ok {
				out = append(out, Row{"asset_id": aid, "name": aid + ".png"})
			}
		}
		return out, nil
	}, ReadAnnotations: f.read, WriteAnnotation: f.write, WithSources: func(ctx context.Context, _ []string, fn func(context.Context) error) error {
		return fn(ctx)
	}})
	must(f.t, e)
	return s
}
func (f *fixture) exec(q string, args ...any) {
	f.t.Helper()
	must(f.t, f.db.WriteTransaction(context.Background(), func(tx *sql.Tx) error { _, e := tx.Exec(q, args...); return e }))
}
func must(t *testing.T, e error) {
	t.Helper()
	if e != nil {
		t.Fatal(e)
	}
}
func code(t *testing.T, e error, want string) {
	t.Helper()
	var api *Error
	if !errors.As(e, &api) || api.Code != want {
		t.Fatalf("error %v want %s", e, want)
	}
}
func (f *fixture) put(id string, value *string) {
	f.t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	f.versions[id]++
	if value == nil {
		_ = os.Remove(filepath.Join(f.root, id+".txt"))
		return
	}
	must(f.t, os.WriteFile(filepath.Join(f.root, id+".txt"), []byte(*value), 0600))
}
func ptr(v string) *string { return &v }
func (f *fixture) annotation(id string) Annotation {
	a := Annotation{AssetID: id, TXTVersion: f.versions[id], State: "missing", DiskVersion: "missing"}
	if why := f.unavailable[id]; why != "" {
		a.Error = why
		a.State = "unavailable"
		return a
	}
	b, e := os.ReadFile(filepath.Join(f.root, id+".txt"))
	if os.IsNotExist(e) {
		return a
	}
	if e != nil {
		a.Error = "io_error"
		return a
	}
	sum := sha256.Sum256(b)
	a.DiskVersion = hex.EncodeToString(sum[:])
	if !utf8.Valid(b) {
		a.State = "invalid_encoding"
		return a
	}
	v := string(b)
	a.BOM = strings.HasPrefix(v, "\ufeff")
	v = strings.TrimPrefix(v, "\ufeff")
	a.Content = &v
	a.State = "normal"
	if strings.TrimSpace(v) == "" {
		a.State = "blank"
	}
	return a
}
func (f *fixture) read(ctx context.Context, ids []string) (map[string]Annotation, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]Annotation{}
	for _, id := range ids {
		out[id] = f.annotation(id)
	}
	return out, nil
}
func (f *fixture) write(ctx context.Context, id string, value *string, o AnnotationWrite) (Annotation, error) {
	if f.hook != nil {
		f.hook(ctx, id)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := ctx.Err(); e != nil {
		return Annotation{}, e
	}
	if e := f.writeErrors[id]; e != nil {
		return Annotation{}, e
	}
	a := f.annotation(id)
	if a.Error != "" {
		return Annotation{}, Fail(409, a.Error, a.Error)
	}
	if a.TXTVersion != o.TXTVersion || a.DiskVersion != o.DiskVersion {
		return Annotation{}, Fail(409, "txt_disk_conflict", "changed")
	}
	f.calls = append(f.calls, id)
	if value == nil {
		if e := os.Remove(filepath.Join(f.root, id+".txt")); e != nil && !os.IsNotExist(e) {
			return Annotation{}, e
		}
	} else {
		v := *value
		if o.BOM {
			v = "\ufeff" + v
		}
		tmp, e := os.CreateTemp(f.root, ".caption-")
		if e != nil {
			return Annotation{}, e
		}
		name := tmp.Name()
		defer os.Remove(name)
		if _, e = tmp.WriteString(v); e != nil {
			tmp.Close()
			return Annotation{}, e
		}
		if e = tmp.Close(); e != nil {
			return Annotation{}, e
		}
		if e = os.Rename(name, filepath.Join(f.root, id+".txt")); e != nil {
			return Annotation{}, e
		}
	}
	f.versions[id]++
	return f.annotation(id), nil
}
func (f *fixture) ops(ids []string, ops []Op, dry bool) (Row, error) {
	return f.s.RunOps(context.Background(), "d", OpsOptions{AssetIDs: ids, Ops: ops, DryRun: dry, SampleLimit: 20})
}
func (f *fixture) value(id string) string {
	f.t.Helper()
	b, e := os.ReadFile(filepath.Join(f.root, id+".txt"))
	must(f.t, e)
	return string(b)
}
func (f *fixture) request(method, url, body string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	f.s.Register(mux)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(method, url, strings.NewReader(body)))
	return w
}

func TestTagOperationsAndManualOverrides(t *testing.T) {
	if got := Parse(" A, B\nA\r , c_c, (x) "); !reflect.DeepEqual(got, []string{"A", "B", "c_c", "(x)"}) {
		t.Fatal(got)
	}
	cases := []struct {
		before []string
		ops    []Op
		want   []string
	}{
		{[]string{"a", "b"}, []Op{{Op: "add", Tags: []string{"b", "c"}, Position: "front"}}, []string{"c", "a", "b"}},
		{[]string{"a", "b"}, []Op{{Op: "replace", From: "a", To: "b"}}, []string{"b"}},
		{[]string{"x", "b", "a", "c"}, []Op{{Op: "merge", Tags: []string{"a", "b"}, Into: "c"}}, []string{"x", "c"}},
		{[]string{"a", "trigger", "b"}, []Op{{Op: "pin", Tags: []string{"b", "absent"}}}, []string{"trigger", "b", "a"}},
		{[]string{"a", "trigger"}, []Op{{Op: "remove", Tags: []string{"trigger"}}}, []string{"a"}},
	}
	for _, tc := range cases {
		if got := ApplyOps(tc.before, tc.ops, "trigger"); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%v want %v", got, tc.want)
		}
	}
	if got := MergeTagger([]string{"manual", "old"}, []string{"old", "removed", "fresh"}, []string{"old", "removed"}, "merge", "trigger"); !reflect.DeepEqual(got, []string{"trigger", "manual", "old", "fresh"}) {
		t.Fatal(got)
	}
}
func TestPreviewWriteUndoAndHistory(t *testing.T) {
	f := newFixture(t)
	f.put("a", ptr("a, b"))
	f.put("b", nil)
	f.put("c", ptr(string([]byte{0xff})))
	op := []Op{{Op: "add", Tags: []string{"c"}}}
	preview, e := f.ops([]string{"a", "b", "c"}, op, true)
	must(t, e)
	stats := preview["stats"].(map[string]int)
	if stats["changed"] != 1 || stats["new"] != 1 || stats["skipped"] != 1 || stats["written"] != 0 || f.value("a") != "a, b" {
		t.Fatal(preview)
	}
	history, e := f.s.History(context.Background(), "d", 50)
	must(t, e)
	if len(history) != 0 {
		t.Fatal(history)
	}
	r, e := f.ops([]string{"a", "b", "c"}, op, false)
	must(t, e)
	batch := Text(r["batch_id"])
	if batch == "" || r["stats"].(map[string]int)["written"] != 2 {
		t.Fatal(r)
	}
	history, e = f.s.History(context.Background(), "d", 50)
	must(t, e)
	if len(history) != 1 || history[0]["can_undo"] != true || Number(history[0]["changed_count"]) != 2 {
		t.Fatal(history)
	}
	u, e := f.s.Undo(context.Background(), batch)
	must(t, e)
	if u["undone"] != true || Number(u["stats"].(Row)["restored"]) != 2 || f.value("a") != "a, b" {
		t.Fatal(u)
	}
	if _, e = os.Stat(filepath.Join(f.root, "b.txt")); !os.IsNotExist(e) {
		t.Fatal(e)
	}
	_, e = f.s.Undo(context.Background(), batch)
	code(t, e, "caption_batch_already_undone")
}
func TestConflictsEditAndAtomicFailure(t *testing.T) {
	f := newFixture(t)
	f.put("a", ptr("old"))
	a, _ := f.read(context.Background(), []string{"a"})
	_, e := f.s.Edit(context.Background(), "d", "a", "new", "wrong")
	code(t, e, "caption_version_conflict")
	r, e := f.s.Edit(context.Background(), "d", "a", " new , x\nx ", a["a"].DiskVersion)
	must(t, e)
	if f.value("a") != "new, x" {
		t.Fatal(r)
	}
	f.put("a", ptr("external"))
	u, e := f.s.Undo(context.Background(), Text(r["batch_id"]))
	must(t, e)
	if Number(u["stats"].(Row)["conflicts"]) != 1 || f.value("a") != "external" {
		t.Fatal(u)
	}
	f.writeErrors["a"] = Fail(409, "txt_write_failed", "failed")
	r, e = f.ops([]string{"a"}, []Op{{Op: "add", Tags: []string{"later"}}}, false)
	must(t, e)
	if r["batch_id"] != nil || r["stats"].(map[string]int)["failed"] != 1 || f.value("a") != "external" {
		t.Fatal(r)
	}
	_, e = f.s.Edit(context.Background(), "d", "unknown", "x", "v")
	code(t, e, "caption_asset_not_in_stage")
}
func TestUndoRetryBOMAndChain(t *testing.T) {
	f := newFixture(t)
	f.put("a", ptr("\ufefforiginal\n"))
	f.put("b", ptr("b"))
	r, e := f.ops([]string{"a", "b"}, []Op{{Op: "add", Tags: []string{"one"}}}, false)
	must(t, e)
	batch := Text(r["batch_id"])
	f.unavailable["b"] = "source_offline"
	u, e := f.s.Undo(context.Background(), batch)
	must(t, e)
	if u["undone"] != false || f.value("a") != "\ufefforiginal\n" {
		t.Fatal(u)
	}
	delete(f.unavailable, "b")
	u, e = f.s.Undo(context.Background(), batch)
	must(t, e)
	if u["undone"] != true || Number(u["stats"].(Row)["restored"]) != 1 {
		t.Fatal(u)
	}
	r, e = f.ops([]string{"b"}, []Op{{Op: "add", Tags: []string{"first"}}}, false)
	must(t, e)
	r2, e := f.ops([]string{"b"}, []Op{{Op: "add", Tags: []string{"second"}}}, false)
	must(t, e)
	_, e = f.s.Undo(context.Background(), Text(r2["batch_id"]))
	must(t, e)
	_, e = f.s.Undo(context.Background(), Text(r["batch_id"]))
	must(t, e)
	if f.value("b") != "b" {
		t.Fatal(f.value("b"))
	}
}
func TestTaggerMergeTracksBaselineAndUndo(t *testing.T) {
	f := newFixture(t)
	f.put("a", ptr("manual"))
	apply := func(mode string, tags []string) (Row, error) {
		return f.s.ApplyTagger(context.Background(), "d", TaggerOptions{Tags: map[string][]string{"a": tags}, AssetIDs: []string{"a"}, Mode: mode, SampleLimit: 20})
	}
	r, e := apply("merge", []string{"old", "removed"})
	must(t, e)
	if f.value("a") != "trigger, manual, old, removed" {
		t.Fatal(r)
	}
	f.put("a", ptr("trigger, manual, old, added"))
	r, e = apply("merge", []string{"old", "removed", "new"})
	must(t, e)
	if f.value("a") != "trigger, manual, added, old, new" {
		t.Fatal(r)
	}
	r, e = apply("fill_empty", []string{"no"})
	must(t, e)
	if r["batch_id"] != nil {
		t.Fatal(r)
	}
	r, e = apply("overwrite", []string{"only"})
	must(t, e)
	if f.value("a") != "trigger, only" {
		t.Fatal(r)
	}
	_, e = f.s.Undo(context.Background(), Text(r["batch_id"]))
	must(t, e)
	if f.value("a") != "trigger, manual, added, old, new" {
		t.Fatal(f.value("a"))
	}
}
func TestRecoveryAfterDatabaseReopenAndOfflinePending(t *testing.T) {
	f := newFixture(t)
	f.put("a", ptr("after"))
	f.put("b", ptr("before"))
	f.exec("INSERT INTO caption_batches(id,dataset_id,kind,created_at,state) VALUES('batch','d','ops',2,'writing')")
	for _, id := range []string{"a", "b"} {
		f.exec("INSERT INTO caption_batch_items(batch_id,asset_id,before_text,before_version,after_text,after_version,write_state) VALUES('batch',?,'before','before','after','','planned')", id)
	}
	f.unavailable["b"] = "source_offline"
	must(t, f.s.Stop())
	must(t, f.db.Close())
	var e error
	f.db, e = store.Open(f.dbPath)
	must(t, e)
	f.s = f.service()
	n, e := f.s.Recover(context.Background())
	must(t, e)
	if n != 0 {
		t.Fatal(n)
	}
	b, e := f.s.batch(context.Background(), "batch")
	must(t, e)
	if Text(b["state"]) != "writing" || Number(b["changed_count"]) != 1 {
		t.Fatal(b)
	}
	delete(f.unavailable, "b")
	n, e = f.s.Recover(context.Background())
	must(t, e)
	if n != 1 {
		t.Fatal(n)
	}
	u, e := f.s.Undo(context.Background(), "batch")
	must(t, e)
	if Number(u["stats"].(Row)["restored"]) != 1 || f.value("a") != "before" {
		t.Fatal(u)
	}
}
func TestCancelledWriteDoesNotCommitAndRecoversJournal(t *testing.T) {
	f := newFixture(t)
	f.put("a", ptr("before"))
	ctx, cancel := context.WithCancel(context.Background())
	f.hook = func(context.Context, string) { cancel() }
	_, e := f.s.RunOps(ctx, "d", OpsOptions{AssetIDs: []string{"a"}, Ops: []Op{{Op: "add", Tags: []string{"after"}}}})
	if !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	if f.value("a") != "before" {
		t.Fatal("cancelled write committed")
	}
	f.hook = nil
	n, e := f.s.Recover(context.Background())
	must(t, e)
	if n != 1 {
		t.Fatal(n)
	}
	h, e := f.s.History(context.Background(), "d", 50)
	must(t, e)
	if len(h) != 0 {
		t.Fatal(h)
	}
}
func TestHTTPETagValidationAndConcurrentEdits(t *testing.T) {
	f := newFixture(t)
	f.put("a", ptr("base"))
	w := f.request("GET", "/api/v1/datasets/d/captions", "")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var listing Row
	must(t, json.Unmarshal(w.Body.Bytes(), &listing))
	etag := w.Header().Get("ETag")
	mux := http.NewServeMux()
	f.s.Register(mux)
	r := httptest.NewRequest("GET", "/api/v1/datasets/d/captions", nil)
	r.Header.Set("If-None-Match", "W/"+etag)
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 304 || w.Body.Len() != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = f.request("POST", "/api/v1/datasets/d/captions/ops", `{"asset_ids":["a"],"ops":[{"op":"wat","tags":["x"]}]}`)
	if w.Code != 422 {
		t.Fatal(w.Code, w.Body.String())
	}
	a, _ := f.read(context.Background(), []string{"a"})
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, e := f.s.Edit(context.Background(), "d", "a", fmt.Sprintf("edit-%d", i), a["a"].DiskVersion)
			results <- e
		}(i)
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for e := range results {
		if e == nil {
			success++
		} else {
			code(t, e, "caption_version_conflict")
			conflict++
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal(success, conflict)
	}
}
