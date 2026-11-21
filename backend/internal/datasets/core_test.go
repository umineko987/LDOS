package datasets

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"ldos/backend/internal/store"
)

type fixture struct {
	t                             *testing.T
	ctx                           context.Context
	db                            *store.Store
	s                             *Service
	source, root, target, dataset string
}

func newFixture(t *testing.T, files map[string]string) *fixture {
	t.Helper()
	base := t.TempDir()
	db, e := store.Open(filepath.Join(base, "db.sqlite3"))
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	s, e := New(ctx, Dependencies{Store: db})
	if e != nil {
		t.Fatal(e)
	}
	f := &fixture{t: t, ctx: ctx, db: db, s: s, source: "source", root: filepath.Join(base, "source"), target: filepath.Join(base, "target")}
	for _, p := range []string{f.root, f.target} {
		if e = os.Mkdir(p, 0700); e != nil {
			t.Fatal(e)
		}
	}
	t.Cleanup(func() { _ = s.Stop(); cancel(); _ = db.Close() })
	f.exec(`INSERT INTO gallery_sources(id,kind,display_name,root_path,canonical_root_key,created_at,updated_at) VALUES(?,'imported','来源',?,?,1,1)`, f.source, f.root, f.root)
	f.directory("")
	for relative, data := range files {
		f.asset(relative, data)
	}
	d, e := s.Create(ctx, CreateOptions{Name: "Example", TriggerWord: "char_tok"})
	if e != nil {
		t.Fatal(e)
	}
	f.dataset = str(d["dataset_id"])
	_, _, e = s.AttachSource(ctx, f.dataset, f.source)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.WaitHashing(ctx); e != nil {
		t.Fatal(e)
	}
	return f
}
func (f *fixture) exec(q string, args ...any) {
	f.t.Helper()
	if e := f.db.WriteTransaction(f.ctx, func(tx *sql.Tx) error { _, e := tx.ExecContext(f.ctx, q, args...); return e }); e != nil {
		f.t.Fatal(e)
	}
}
func (f *fixture) directory(relative string) {
	f.t.Helper()
	if relative != "" {
		if e := os.MkdirAll(filepath.Join(f.root, relative), 0700); e != nil {
			f.t.Fatal(e)
		}
	}
	f.exec(`INSERT OR IGNORE INTO gallery_directories(id,source_id,relative_path,name,sort_key,created_at,updated_at) VALUES(?,?,?,?,?,1,1)`, DirectoryID(f.source, relative), f.source, relative, filepath.Base(relative), relative)
}
func (f *fixture) asset(relative, data string) {
	f.t.Helper()
	dir := filepath.ToSlash(filepath.Dir(relative))
	if dir == "." {
		dir = ""
	}
	f.directory(dir)
	p := filepath.Join(f.root, relative)
	if e := os.WriteFile(p, []byte(data), 0600); e != nil {
		f.t.Fatal(e)
	}
	info, e := os.Stat(p)
	if e != nil {
		f.t.Fatal(e)
	}
	f.exec(`INSERT INTO gallery_assets(id,source_id,directory_id,relative_path,name,extension,sort_key,size_bytes,modified_ns,format,width,height,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'PNG',4,3,1,1)`, relative, f.source, DirectoryID(f.source, dir), relative, filepath.Base(relative), filepath.Ext(relative), strings.ToLower(relative), info.Size(), info.ModTime().UnixNano())
}
func (f *fixture) caption(asset, text string) {
	f.t.Helper()
	relative := strings.TrimSuffix(asset, filepath.Ext(asset)) + ".txt"
	p := filepath.Join(f.root, relative)
	if e := os.WriteFile(p, []byte(text), 0600); e != nil {
		f.t.Fatal(e)
	}
	st, e := os.Stat(p)
	if e != nil {
		f.t.Fatal(e)
	}
	f.exec("UPDATE gallery_assets SET txt_relative_path=?,txt_state='ready',txt_size_bytes=?,txt_modified_ns=?,txt_sha256=? WHERE id=?", relative, st.Size(), st.ModTime().UnixNano(), hashBytes([]byte(text)), asset)
}
func mustRecord(t *testing.T, r Record, e error) Record {
	t.Helper()
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func assertCode(t *testing.T, e error, want string) {
	t.Helper()
	var de *Error
	if !errors.As(e, &de) || de.Code != want {
		t.Fatalf("error = %v, want %s", e, want)
	}
}
func records(v any) []Record { return v.([]Record) }
func ids(rows []Record) []string {
	out := []string{}
	for _, r := range rows {
		out = append(out, str(r["asset_id"]))
	}
	return out
}

func TestCoreMembershipPaginationDecisionsAndStages(t *testing.T) {
	f := newFixture(t, map[string]string{"a/b/one.png": "one", "a/b/two.png": "two", "a/bc/no.png": "no", "keep/no.png": "no", "trash/no.png": "no", "duplicates/no.png": "no", ".ldos/private.png": "no", "a/.ldos-copy-temp/no.png": "no"})
	ctx, s, id := f.ctx, f.s, f.dataset
	roots, e := s.ListRoots(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.DetachRoot(ctx, id, str(roots[0]["root_id"])); e != nil {
		t.Fatal(e)
	}
	r, created, e := s.AttachDirectory(ctx, id, DirectoryID(f.source, "a/b"))
	if e != nil || !created || r["available"] != true {
		t.Fatalf("attach: %v %v %v", r, created, e)
	}
	_, created, e = s.AttachRoot(ctx, id, f.source, "a/b", "library")
	if e != nil || created {
		t.Fatalf("idempotent attach: %v %v", created, e)
	}
	members, e := s.MemberRows(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(ids(members), []string{"a/b/one.png", "a/b/two.png"}) {
		t.Fatalf("members: %v", ids(members))
	}
	p, e := s.MembersPage(ctx, id, MemberOptions{Limit: 1})
	if e != nil {
		t.Fatal(e)
	}
	if num(p["total"]) != 2 || str(p["next_cursor"]) == "" {
		t.Fatal(p)
	}
	p2, e := s.MembersPage(ctx, id, MemberOptions{Limit: 1, Cursor: str(p["next_cursor"])})
	if e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(ids(records(p2["items"])), []string{"a/b/two.png"}) || p2["next_cursor"] != nil {
		t.Fatal(p2)
	}
	_, e = s.MembersPage(ctx, id, MemberOptions{Cursor: "not-json"})
	assertCode(t, e, "invalid_dataset_cursor")
	_, e = s.MembersPage(ctx, id, MemberOptions{Decision: "excluded"})
	assertCode(t, e, "invalid_dataset_member_filter")
	// Decode a Python-format cursor, including padded base64 and extra metadata.
	cursor := base64.URLEncoding.EncodeToString([]byte(`{"kind":"dataset-member","sort_key":"a/b/one.png","name":"one.png","id":"a/b/one.png"}`))
	p2, e = s.MembersPage(ctx, id, MemberOptions{Cursor: cursor})
	if e != nil || len(records(p2["items"])) != 1 {
		t.Fatalf("legacy cursor: %v %v", p2, e)
	}
	_, e = s.Decide(ctx, id, "clean", []string{"a/bc/no.png"}, "exclude", "")
	assertCode(t, e, "dataset_asset_not_member")
	v, e := s.Decide(ctx, id, "clean", []string{"a/b/one.png", "a/b/one.png"}, "exclude", "bad")
	if e != nil || num(v["updated"]) != 1 {
		t.Fatalf("decision: %v %v", v, e)
	}
	f.exec("UPDATE gallery_assets SET lifecycle_state='trashed' WHERE id='a/b/one.png'")
	funnel, e := s.Funnel(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	stages := records(funnel["stages"])
	if num(funnel["member_count"]) != 2 || num(stages[1]["excluded"]) != 1 || len(stages) != 5 || stages[4]["stage"] != "export" || num(stages[4]["output"]) != 1 {
		t.Fatal(funnel)
	}
	input, e := s.StageInput(ctx, id, "dedup")
	if e != nil || !reflect.DeepEqual(ids(input), []string{"a/b/two.png"}) {
		t.Fatalf("stage input: %v %v", input, e)
	}
	run, e := s.StartStageRun(ctx, id, "dedup")
	if e != nil {
		t.Fatal(e)
	}
	run, e = s.FinishStageRun(ctx, str(run["run_id"]), FinishStageRunOptions{Status: "succeeded", Stats: Record{"ok": true}})
	if e != nil {
		t.Fatal(e)
	}
	funnel, e = s.Funnel(ctx, id)
	if e != nil || records(funnel["stages"])[2]["stale"] != false {
		t.Fatal(funnel, e)
	}
	f.exec("UPDATE gallery_assets SET modified_ns=modified_ns+1 WHERE id='a/b/two.png'")
	funnel, e = s.Funnel(ctx, id)
	if e != nil || records(funnel["stages"])[2]["stale"] != true {
		t.Fatal(funnel, e)
	}
	_, e = s.Update(ctx, id, Record{"name": " New ", "config": Record{"nested": true}, "cover_asset_id": "not-member"})
	if e != nil {
		t.Fatal(e)
	}
	d, e := s.Get(ctx, id)
	if e != nil || d["name"] != "New" || d["cover_asset_id"] != "a/b/two.png" {
		t.Fatal(d, e)
	}
	if e = s.Delete(ctx, id); e != nil {
		t.Fatal(e)
	}
	for _, table := range []string{"datasets", "dataset_roots", "dataset_decisions", "dataset_stage_runs"} {
		row, e := f.db.QueryRow(ctx, "SELECT count(*) AS n FROM "+table)
		if e != nil || num(row["n"]) != 0 {
			t.Fatal(table, row, e)
		}
	}
	members, e = f.db.QueryRows(ctx, "SELECT id FROM gallery_assets")
	if e != nil || len(members) != 8 {
		t.Fatal("dataset deletion changed gallery", members, e)
	}
}
func TestSetAsideRestoresDecisionIdentity(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "a", "b.png": "b", "c.png": "c"})
	s, ctx, id := f.s, f.ctx, f.dataset
	if _, e := s.Decide(ctx, id, "dedup", []string{"a.png"}, "approve", "reviewed"); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Decide(ctx, id, "clean", []string{"c.png"}, "exclude", "upstream"); e != nil {
		t.Fatal(e)
	}
	aside, e := s.SetAside(ctx, id, "dedup", []string{"a.png", "b.png", "c.png"}, "atlas")
	if e != nil || num(aside["updated"]) != 2 {
		t.Fatal(aside, e)
	}
	aside, e = s.SetAside(ctx, id, "dedup", []string{"a.png", "b.png"}, "atlas")
	if e != nil || num(aside["updated"]) != 0 {
		t.Fatal(aside, e)
	}
	back, e := s.PutBack(ctx, id, "dedup", []string{"a.png", "b.png"}, "wrong-owner")
	if e != nil || num(back["updated"]) != 0 {
		t.Fatal(back, e)
	}
	f.exec("UPDATE gallery_assets SET lifecycle_state='trashed' WHERE id IN ('a.png','b.png')")
	back, e = s.PutBack(ctx, id, "dedup", []string{"a.png", "b.png"}, "atlas")
	if e != nil || num(back["updated"]) != 2 {
		t.Fatal(back, e)
	}
	rows, e := s.ListDecisions(ctx, id, []string{"a.png", "b.png"})
	if e != nil || len(rows) != 1 || rows[0]["decision"] != "approve" || rows[0]["reason"] != "reviewed" {
		t.Fatal(rows, e)
	}
}
func TestExcludedPathsAndLiteralSearch(t *testing.T) {
	f := newFixture(t, map[string]string{"file_100%.png": "a", "other.png": "b", "KEEP/no.png": "c", "a/.ldos-x/no.png": "d", "a/keeps/yes.png": "e"})
	p, e := f.s.MembersPage(f.ctx, f.dataset, MemberOptions{Query: "_100%"})
	if e != nil || num(p["total"]) != 1 {
		t.Fatal(p, e)
	}
	rows, e := f.s.MemberRows(f.ctx, f.dataset)
	if e != nil || len(rows) != 3 {
		t.Fatal(rows, e)
	}
	for _, path := range []string{"../source", "a//b", "a/./b", "/absolute", "a\\b", "keep", "a/.LDOS-private"} {
		_, _, e = f.s.AttachRoot(f.ctx, f.dataset, f.source, path, "library")
		if e == nil {
			t.Fatalf("accepted root %q", path)
		}
	}
}
func TestHashingDetectsChangedAndMissingSources(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "image"})
	r, e := f.db.QueryRow(f.ctx, "SELECT content_sha256 FROM gallery_assets WHERE id='a.png'")
	if e != nil || r["content_sha256"] != hashBytes([]byte("image")) {
		t.Fatal(r, e)
	}
	f.exec("UPDATE gallery_assets SET content_sha256='',modified_ns=modified_ns+1 WHERE id='a.png'")
	status, e := f.s.HashAsset(f.ctx, "a.png")
	if e != nil || status != "changed" {
		t.Fatal(status, e)
	}
	f.exec("UPDATE gallery_sources SET availability='offline'")
	status, e = f.s.HashAsset(f.ctx, "a.png")
	if e != nil || status != "unavailable" {
		t.Fatal(status, e)
	}
	state, e := f.s.HashingStatus(f.ctx, f.dataset)
	if e != nil || num(state["hashed_count"]) != 0 || num(state["member_count"]) != 1 {
		t.Fatal(state, e)
	}
}
func TestHTTPContractsAndValidation(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "a"})
	mux := http.NewServeMux()
	f.s.Register(mux)
	request := func(method, path, body string) (int, Record) {
		t.Helper()
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
		var value Record
		if w.Body.Len() > 0 {
			if e := json.Unmarshal(w.Body.Bytes(), &value); e != nil {
				t.Fatal(w.Body.String(), e)
			}
		}
		return w.Code, value
	}
	prefix := "/api/v1/datasets/" + f.dataset
	for _, path := range []string{"/api/v1/datasets", prefix, prefix + "/roots", prefix + "/members", prefix + "/funnel", prefix + "/hashing", prefix + "/crawls", prefix + "/stage-runs", prefix + "/exports"} {
		status, body := request("GET", path, "")
		if status != 200 {
			t.Fatal(path, status, body)
		}
	}
	for _, body := range []string{`{"name":""}`, `{"name":"x","unknown":1}`, `{"name":"x","kind":"wrong"}`, `{"name":"x","config":[]}`, `{"name":"x"} {}`} {
		status, _ := request("POST", "/api/v1/datasets", body)
		if status != 422 {
			t.Fatal(body, status)
		}
	}
	status, _ := request("POST", prefix+"/roots", `{"source_id":"source","path":"/tmp"}`)
	if status != 422 {
		t.Fatal(status)
	}
	status, _ = request("GET", prefix+"/members?cursor=", "")
	if status != 422 {
		t.Fatal(status)
	}
	status, _ = request("GET", prefix+"/members?limit=0", "")
	if status != 422 {
		t.Fatal(status)
	}
	status, v := request("GET", "/api/v1/datasets/no-such", "")
	if status != 404 || object(v["error"])["code"] != "dataset_not_found" {
		t.Fatal(status, v)
	}
	body, _ := json.Marshal(Record{"target_path": f.target, "dry_run": true})
	status, v = request("POST", prefix+"/exports", string(body))
	if status != 200 || v["dry_run"] != true || v["job"] != nil {
		t.Fatal(status, v)
	}
	status, _ = request("DELETE", prefix, "")
	if status != 204 {
		t.Fatal(status)
	}
}
