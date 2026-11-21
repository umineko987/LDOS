package datasets

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
	"ldos/backend/internal/store"
)

func (f *fixture) createExport(options Record) string {
	f.t.Helper()
	if options == nil {
		options = Record{}
	}
	options["target_path"] = f.target
	job, e := f.s.CreateExport(f.ctx, f.dataset, options)
	if e != nil {
		f.t.Fatal(e)
	}
	return str(job["export_id"])
}
func (f *fixture) wait(id, status string) Record {
	f.t.Helper()
	r, e := f.s.WaitExport(f.ctx, id)
	if e != nil {
		f.t.Fatal(e)
	}
	if r["status"] != status {
		f.t.Fatalf("export: %v, want %s", r, status)
	}
	return r
}
func readFile(t *testing.T, path string) string {
	t.Helper()
	b, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	return string(b)
}
func missing(t *testing.T, path string) {
	t.Helper()
	_, e := os.Lstat(path)
	if !errors.Is(e, os.ErrNotExist) {
		t.Fatalf("%s should not exist: %v", path, e)
	}
}
func recoverService(t *testing.T, f *fixture) {
	t.Helper()
	if e := f.s.Stop(); e != nil {
		t.Fatal(e)
	}
	if e := f.db.Close(); e != nil {
		t.Fatal(e)
	}
	db, e := store.Open(filepath.Join(filepath.Dir(f.root), "db.sqlite3"))
	if e != nil {
		t.Fatal(e)
	}
	s, e := New(f.ctx, Dependencies{Store: db, RegisterExport: f.s.deps.RegisterExport})
	if e != nil {
		t.Fatal(e)
	}
	f.db = db
	f.s = s
	t.Cleanup(func() { _ = s.Stop(); _ = db.Close() })
	if e = s.Start(); e != nil {
		t.Fatal(e)
	}
}
func TestExportCaptionCollisionAndManifest(t *testing.T) {
	f := newFixture(t, map[string]string{"a/same.png": "first", "b/same.jpg": "second", "c/unique.png": "third"})
	f.caption("a/same.png", "\ufeffblue_hair, blue hair, unwanted, CHAR TOK, ^_^\r\nred_eyes")
	options := Record{"target_path": f.target, "tag_blacklist": []string{"unwanted"}, "underscore_to_space": true}
	p, e := f.s.PreviewExport(f.ctx, f.dataset, options)
	if e != nil {
		t.Fatal(e)
	}
	if p["folder_name"] != "10_char_tok" || num(p["collision_count"]) != 1 || num(p["caption_count"]) != 3 {
		t.Fatal(p)
	}
	items := records(p["items"])
	if items[0]["caption_preview"] != "char_tok, blue hair, ^_^, red eyes" || items[1]["output_relative_path"] != "same_2.jpg" {
		t.Fatal(items)
	}
	id := f.createExport(options)
	job := f.wait(id, "succeeded")
	output := str(job["output_path"])
	if readFile(t, filepath.Join(output, "same.png")) != "first" || readFile(t, filepath.Join(output, "same_2.jpg")) != "second" {
		t.Fatal("wrong image bytes")
	}
	if readFile(t, filepath.Join(output, "same.txt")) != "char_tok, blue hair, ^_^, red eyes" {
		t.Fatal("wrong caption")
	}
	if readFile(t, filepath.Join(output, "unique.txt")) != "char_tok" {
		t.Fatal("missing caption synthesis")
	}
	if readFile(t, filepath.Join(f.root, "a/same.txt")) != "\ufeffblue_hair, blue hair, unwanted, CHAR TOK, ^_^\r\nred_eyes" {
		t.Fatal("source caption mutated")
	}
	missing(t, filepath.Join(f.target, StagingName(id)))
	rows, e := f.s.exportItems(f.ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	for _, r := range rows {
		if r["copy_state"] != "staged" || r["committed_at"] == nil || str(r["image_sha256"]) == "" {
			t.Fatal(r)
		}
	}
	events, e := f.db.QueryRows(f.ctx, "SELECT event_type FROM dataset_export_events WHERE job_id=? ORDER BY id", id)
	if e != nil {
		t.Fatal(e)
	}
	types := []string{}
	for _, r := range events {
		types = append(types, str(r["event_type"]))
	}
	if !reflect.DeepEqual(types, []string{"planned", "staging_created", "commit_started", "committed", "finished"}) {
		t.Fatal(types)
	}
	if job["resumable"] != false || num(job["staged_items"]) != 3 || num(job["copied_bytes"]) != num(job["total_bytes"]) {
		t.Fatal(job)
	}
	if _, exists := object(job["options"])["target_identity"]; exists {
		t.Fatal("private identity leaked")
	}
	runs, e := f.s.ListStageRuns(f.ctx, f.dataset, "export", 50)
	if e != nil || len(runs) != 1 || runs[0]["status"] != "succeeded" || num(object(runs[0]["stats"])["exported"]) != 3 {
		t.Fatal(runs, e)
	}
}
func TestExportSnapshotSurvivesRestartAndSkipsStaged(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "first", "b.png": "second"})
	f.s.afterItem = func(string, int) error { return errSimulatedCrash }
	id := f.createExport(nil)
	f.s.wg.Wait()
	items, e := f.s.exportItems(f.ctx, id)
	if e != nil || items[0]["copy_state"] != "staged" || items[1]["copy_state"] != "pending" {
		t.Fatal(items, e)
	}
	staging := filepath.Join(f.target, StagingName(id))
	before, e := os.Stat(filepath.Join(staging, "a.png"))
	if e != nil {
		t.Fatal(e)
	}
	// Change dataset selection and options after creating the durable manifest.
	if _, e = f.s.Decide(f.ctx, f.dataset, "export", []string{"b.png"}, "exclude", "later"); e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.Update(f.ctx, f.dataset, Record{"trigger_word": "new-trigger"}); e != nil {
		t.Fatal(e)
	}
	if e = os.Remove(filepath.Join(f.root, "a.png")); e != nil {
		t.Fatal(e)
	}
	recoverService(t, f)
	r, e := f.s.GetExport(f.ctx, id)
	if e != nil || r["status"] != "interrupted" || r["resumable"] != true {
		t.Fatal(r, e)
	}
	if _, e = f.s.ResumeExport(f.ctx, id); e != nil {
		t.Fatal(e)
	}
	r = f.wait(id, "succeeded")
	out := str(r["output_path"])
	after, e := os.Stat(filepath.Join(out, "a.png"))
	if e != nil || !os.SameFile(before, after) {
		t.Fatal("staged file recopied", e)
	}
	if readFile(t, filepath.Join(out, "b.txt")) != "char_tok" {
		t.Fatal("mutable options changed frozen manifest")
	}
	if readFile(t, filepath.Join(out, "b.png")) != "second" {
		t.Fatal("mutable dataset selection changed manifest")
	}
}
func TestExportRecoversRenameBeforeSuccessRecord(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "image"})
	var handoffs []string
	f.s.deps.RegisterExport = func(_ context.Context, path string, _ *os.File) error {
		handoffs = append(handoffs, path)
		return nil
	}
	f.s.afterCommit = func(string) error { return errSimulatedCrash }
	id := f.createExport(nil)
	f.s.wg.Wait()
	missing(t, filepath.Join(f.target, StagingName(id)))
	if readFile(t, filepath.Join(f.target, "10_char_tok", "a.png")) != "image" {
		t.Fatal("commit missing")
	}
	if len(handoffs) != 0 {
		t.Fatalf("handoff before recovered terminal state: %v", handoffs)
	}
	output := filepath.Join(f.target, "10_char_tok")
	if e := os.Remove(filepath.Join(output, "a.png")); e != nil {
		t.Fatal(e)
	}
	recoverService(t, f)
	f.wait(id, "succeeded")
	missing(t, filepath.Join(output, "a.png"))
	// A later restart must not feed historical successes back into gallery.
	recoverService(t, f)
	f.wait(id, "succeeded")
	if !reflect.DeepEqual(handoffs, []string{output}) {
		t.Fatalf("unexpected gallery handoffs: %v", handoffs)
	}
}
func TestExportCancellationRollsBackAndDoesNotTouchSources(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "first", "b.png": "second"})
	f.s.deps.RegisterExport = func(context.Context, string, *os.File) error {
		t.Error("cancelled export was sent to gallery")
		return nil
	}
	reached := make(chan struct{})
	release := make(chan struct{})
	f.s.afterItem = func(_ string, index int) error {
		if index == 1 {
			close(reached)
			select {
			case <-release:
			case <-f.s.ctx.Done():
			}
		}
		return nil
	}
	id := f.createExport(nil)
	select {
	case <-reached:
	case <-f.ctx.Done():
		t.Fatal(f.ctx.Err())
	}
	if _, e := f.s.CancelExport(f.ctx, id); e != nil {
		t.Fatal(e)
	}
	close(release)
	f.wait(id, "cancelled")
	missing(t, filepath.Join(f.target, StagingName(id)))
	missing(t, filepath.Join(f.target, "10_char_tok"))
	if readFile(t, filepath.Join(f.root, "a.png")) != "first" {
		t.Fatal("source modified")
	}
	_, e := f.s.ResumeExport(f.ctx, id)
	assertCode(t, e, "export_not_resumable")
}
func TestExportShutdownKeepsPartialProgress(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "first", "b.png": "second"})
	reached := make(chan struct{})
	s := f.s
	s.afterItem = func(_ string, index int) error {
		if index == 1 {
			close(reached)
			<-s.ctx.Done()
		}
		return nil
	}
	id := f.createExport(nil)
	select {
	case <-reached:
	case <-f.ctx.Done():
		t.Fatal(f.ctx.Err())
	}
	if e := s.Stop(); e != nil {
		t.Fatal(e)
	}
	r, e := s.GetExport(f.ctx, id)
	if e != nil || r["status"] != "interrupted" || num(r["staged_items"]) != 1 {
		t.Fatal(r, e)
	}
	recoverService(t, f)
	if _, e = f.s.ResumeExport(f.ctx, id); e != nil {
		t.Fatal(e)
	}
	f.wait(id, "succeeded")
}
func TestExportTargetConflictCanResume(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "image"})
	handoffs := 0
	f.s.deps.RegisterExport = func(context.Context, string, *os.File) error {
		handoffs++
		return nil
	}
	f.s.afterItem = func(string, int) error { return os.Mkdir(filepath.Join(f.target, "10_char_tok"), 0700) }
	id := f.createExport(nil)
	r := f.wait(id, "failed")
	if r["error_code"] != "export_target_exists" || r["resumable"] != true {
		t.Fatal(r)
	}
	if _, e := os.Stat(filepath.Join(f.target, StagingName(id), "a.png")); e != nil {
		t.Fatal(e)
	}
	if e := os.Remove(filepath.Join(f.target, "10_char_tok")); e != nil {
		t.Fatal(e)
	}
	f.s.afterItem = nil
	if _, e := f.s.ResumeExport(f.ctx, id); e != nil {
		t.Fatal(e)
	}
	f.wait(id, "succeeded")
	if handoffs != 1 {
		t.Fatalf("got %d gallery handoffs; want one successful attempt only", handoffs)
	}
}
func TestExportPendingPartialPairIsRecopied(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "image", "b.png": "second"})
	f.s.afterItem = func(string, int) error { return errSimulatedCrash }
	id := f.createExport(nil)
	f.s.wg.Wait()
	staging := filepath.Join(f.target, StagingName(id))
	if e := os.WriteFile(filepath.Join(staging, "b.png"), []byte("partial"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(staging, "b.txt"), []byte("partial"), 0600); e != nil {
		t.Fatal(e)
	}
	recoverService(t, f)
	if _, e := f.s.ResumeExport(f.ctx, id); e != nil {
		t.Fatal(e)
	}
	r := f.wait(id, "succeeded")
	if readFile(t, filepath.Join(str(r["output_path"]), "b.png")) != "second" {
		t.Fatal("partial pending item reused")
	}
}
func TestValidateTreeReadsCurrentEntries(t *testing.T) {
	path := t.TempDir()
	if err := os.WriteFile(filepath.Join(path, "a.png"), []byte("a"), 0600); err != nil {
		t.Fatal(err)
	}
	dir, err := openDirectory(path)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	if err := validateTree(t.Context(), dir, map[string]int64{"a.png": 1}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "a.txt"), []byte("caption"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateTree(t.Context(), dir, map[string]int64{"a.png": 1, "a.txt": 7}); err != nil {
		t.Fatal(err)
	}
}

func TestExportStagingTamperingRejected(t *testing.T) {
	for _, kind := range []string{"unexpected", "hardlink", "symlink", "size"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t, map[string]string{"a.png": "image", "b.png": "second"})
			f.s.afterItem = func(string, int) error { return errSimulatedCrash }
			id := f.createExport(nil)
			f.s.wg.Wait()
			staging := filepath.Join(f.target, StagingName(id))
			outside := filepath.Join(filepath.Dir(f.target), "foreign")
			if e := os.WriteFile(outside, []byte("image"), 0600); e != nil {
				t.Fatal(e)
			}
			switch kind {
			case "unexpected":
				if e := os.WriteFile(filepath.Join(staging, "stranger"), []byte("x"), 0600); e != nil {
					t.Fatal(e)
				}
			case "hardlink", "symlink":
				if e := os.Remove(filepath.Join(staging, "a.png")); e != nil {
					t.Fatal(e)
				}
				var e error
				if kind == "hardlink" {
					e = os.Link(outside, filepath.Join(staging, "a.png"))
				} else {
					e = os.Symlink(outside, filepath.Join(staging, "a.png"))
				}
				if e != nil {
					t.Fatal(e)
				}
			case "size":
				if e := os.WriteFile(filepath.Join(staging, "a.png"), []byte("wrong length"), 0600); e != nil {
					t.Fatal(e)
				}
			}
			recoverService(t, f)
			if _, e := f.s.ResumeExport(f.ctx, id); e != nil {
				t.Fatal(e)
			}
			r := f.wait(id, "failed")
			if r["error_code"] != "target_path_changed" || r["resumable"] != false {
				t.Fatal(r)
			}
			if readFile(t, outside) != "image" {
				t.Fatal("foreign data touched")
			}
			missing(t, filepath.Join(f.target, "10_char_tok"))
		})
	}
}
func TestExportSourceReplacementRejected(t *testing.T) {
	for _, kind := range []string{"symlink", "fifo", "bytes", "version", "caption"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t, map[string]string{"a.png": "first", "b.png": "second"})
			f.caption("b.png", "tag")
			f.s.afterItem = func(string, int) error { return errSimulatedCrash }
			id := f.createExport(nil)
			f.s.wg.Wait()
			p := filepath.Join(f.root, "b.png")
			switch kind {
			case "symlink":
				if e := os.Remove(p); e != nil {
					t.Fatal(e)
				}
				if e := os.Symlink(filepath.Join(f.root, "a.png"), p); e != nil {
					t.Fatal(e)
				}
			case "fifo":
				if e := os.Remove(p); e != nil {
					t.Fatal(e)
				}
				if e := unix.Mkfifo(p, 0600); e != nil {
					t.Fatal(e)
				}
			case "bytes":
				if e := os.WriteFile(p, []byte("change"), 0600); e != nil {
					t.Fatal(e)
				}
			case "version":
				f.exec("UPDATE gallery_assets SET content_version=content_version+1 WHERE id='b.png'")
			case "caption":
				if e := os.WriteFile(filepath.Join(f.root, "b.txt"), []byte("new"), 0600); e != nil {
					t.Fatal(e)
				}
			}
			recoverService(t, f)
			if _, e := f.s.ResumeExport(f.ctx, id); e != nil {
				t.Fatal(e)
			}
			r := f.wait(id, "failed")
			if r["error_code"] != "source_changed" {
				t.Fatal(r)
			}
			missing(t, filepath.Join(f.target, "10_char_tok"))
			missing(t, filepath.Join(f.target, StagingName(id)))
		})
	}
}
func TestExportDoesNotDeleteReplacedStagingOrTarget(t *testing.T) {
	for _, replaceTarget := range []bool{false, true} {
		t.Run(map[bool]string{false: "staging", true: "target"}[replaceTarget], func(t *testing.T) {
			f := newFixture(t, map[string]string{"a.png": "first", "b.png": "second"})
			f.s.afterItem = func(string, int) error { return errSimulatedCrash }
			id := f.createExport(nil)
			f.s.wg.Wait()
			p := filepath.Join(f.target, StagingName(id))
			if replaceTarget {
				p = f.target
			}
			if e := os.Rename(p, p+"-original"); e != nil {
				t.Fatal(e)
			}
			if e := os.Mkdir(p, 0700); e != nil {
				t.Fatal(e)
			}
			if e := os.WriteFile(filepath.Join(p, "foreign"), []byte("do not touch"), 0600); e != nil {
				t.Fatal(e)
			}
			recoverService(t, f)
			if _, e := f.s.ResumeExport(f.ctx, id); e != nil {
				t.Fatal(e)
			}
			r := f.wait(id, "failed")
			if r["error_code"] != map[bool]string{true: "target_root_changed", false: "target_path_changed"}[replaceTarget] {
				t.Fatal(r)
			}
			if readFile(t, filepath.Join(p, "foreign")) != "do not touch" {
				t.Fatal("foreign directory touched")
			}
		})
	}
}

func TestExportDirectWithoutCompletedProcessing(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "keep", "b.png": "excluded", "c.png": "unreviewed and untagged"})
	f.caption("a.png", "original, remove_me")
	if _, e := f.s.Decide(f.ctx, f.dataset, "export", []string{"b.png"}, "exclude", ""); e != nil {
		t.Fatal(e)
	}
	id := f.createExport(Record{"tag_blacklist": []string{"remove_me"}})
	r := f.wait(id, "succeeded")
	out := str(r["output_path"])
	if got := readFile(t, filepath.Join(out, "a.png")); got != "keep" {
		t.Fatal(got)
	}
	if got := readFile(t, filepath.Join(out, "a.txt")); got != "char_tok, original" {
		t.Fatal(got)
	}
	missing(t, filepath.Join(out, "b.png"))
	if got := readFile(t, filepath.Join(out, "c.png")); got != "unreviewed and untagged" {
		t.Fatal(got)
	}
	if got := readFile(t, filepath.Join(out, "c.txt")); got != "char_tok" {
		t.Fatal("default pin-trigger caption:", got)
	}
	missing(t, filepath.Join(f.root, "c.txt"))
	if got := readFile(t, filepath.Join(f.root, "a.txt")); got != "original, remove_me" {
		t.Fatal("source caption changed:", got)
	}
	if got := readFile(t, filepath.Join(f.root, "b.png")); got != "excluded" {
		t.Fatal("excluded source image changed:", got)
	}
	runs, e := f.s.LatestStageRuns(f.ctx, f.dataset)
	if e != nil || len(runs) != 1 || runs["export"]["status"] != "succeeded" {
		t.Fatal(runs, e)
	}
	_, e = f.s.CreateExport(f.ctx, f.dataset, Record{"target_path": f.target})
	assertCode(t, e, "export_target_exists")
	if got := readFile(t, filepath.Join(out, "a.png")); got != "keep" {
		t.Fatal("existing export changed:", got)
	}
}

func TestExportBlocksWhileInputIsChanging(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "image"})
	options := Record{"target_path": f.target}
	plan, e := f.s.planExport(f.ctx, f.dataset, options)
	if e != nil {
		t.Fatal(e)
	}
	for _, stage := range []string{"clean", "dedup"} {
		t.Run(stage, func(t *testing.T) {
			run, e := f.s.StartStageRun(f.ctx, f.dataset, stage)
			if e != nil {
				t.Fatal(e)
			}
			_, e = f.s.PreviewExport(f.ctx, f.dataset, options)
			assertCode(t, e, "export_input_busy")
			_, e = f.s.CreateExport(f.ctx, f.dataset, options)
			assertCode(t, e, "export_input_busy")
			assertCode(t, f.s.insertExport(f.ctx, "old-plan", plan), "export_input_busy")
			if _, e = f.s.FinishStageRun(f.ctx, str(run["run_id"]), FinishStageRunOptions{Status: "failed"}); e != nil {
				t.Fatal(e)
			}
		})
	}
	f.exec(`INSERT INTO crawl_batches(id,status,output_dir,concurrency,max_tasks,created_at,updated_at) VALUES('batch','running',?,1,100,1,1)`, f.root)
	f.exec(`INSERT INTO dataset_crawls(dataset_id,batch_id,state,created_at,updated_at) VALUES(?,'batch','pending',1,1)`, f.dataset)
	_, e = f.s.CreateExport(f.ctx, f.dataset, options)
	assertCode(t, e, "export_input_busy")
	entries, e := os.ReadDir(f.target)
	if e != nil || len(entries) != 0 {
		t.Fatal(entries, e)
	}
	f.exec(`UPDATE crawl_batches SET status='paused' WHERE id='batch'`)
	if _, e = f.s.StartStageRun(f.ctx, f.dataset, "tag"); e != nil {
		t.Fatal(e)
	}
	// Paused collection, failed processing runs and tag generation don't change the input.
	f.wait(f.createExport(nil), "succeeded")
}

func TestExportRejectsDestinationInUnselectedSource(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "image"})
	f.exec(`INSERT INTO gallery_sources(id,kind,display_name,root_path,canonical_root_key,created_at,updated_at) VALUES('empty','imported','Empty',?,?,1,1)`, f.target, f.target)
	if _, _, e := f.s.AttachSource(f.ctx, f.dataset, "empty"); e != nil {
		t.Fatal(e)
	}
	_, e := f.s.CreateExport(f.ctx, f.dataset, Record{"target_path": f.target})
	assertCode(t, e, "target_inside_source")
	entries, e := os.ReadDir(f.target)
	if e != nil || len(entries) != 0 {
		t.Fatal(entries, e)
	}
}

func TestExportPreviewBoundariesPoliciesAndEmpty(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "image"})
	for _, p := range []string{"relative", f.root, filepath.Join(f.root, "child")} {
		if strings.HasSuffix(p, "child") {
			if e := os.Mkdir(p, 0700); e != nil {
				t.Fatal(e)
			}
		}
		_, e := f.s.PreviewExport(f.ctx, f.dataset, Record{"target_path": p})
		if e == nil {
			t.Fatalf("accepted %q", p)
		}
	}
	link := f.target + "-link"
	if e := os.Symlink(f.target, link); e != nil {
		t.Fatal(e)
	}
	_, e := f.s.PreviewExport(f.ctx, f.dataset, Record{"target_path": link})
	if e == nil {
		t.Fatal("accepted symlink target")
	}
	for _, folder := range []string{"../bad", ".ldos-copy", "CON", "bad/leaf"} {
		_, e = f.s.PreviewExport(f.ctx, f.dataset, Record{"target_path": f.target, "folder_name": folder, "layout": "flat"})
		if e == nil {
			t.Fatal("accepted folder", folder)
		}
	}
	f.exec("UPDATE gallery_assets SET txt_state='invalid_encoding'")
	p, e := f.s.PreviewExport(f.ctx, f.dataset, Record{"target_path": f.target})
	if e != nil || len(records(p["blockers"])) != 1 {
		t.Fatal(p, e)
	}
	_, e = f.s.CreateExport(f.ctx, f.dataset, Record{"target_path": f.target})
	assertCode(t, e, "export_caption_unreadable")
	id := f.createExport(Record{"include_captions": false, "rename": "sequential", "layout": "flat"})
	r := f.wait(id, "succeeded")
	if readFile(t, filepath.Join(str(r["output_path"]), "0001.png")) != "image" {
		t.Fatal("sequential output missing")
	}
	missing(t, filepath.Join(str(r["output_path"]), "0001.txt"))
	if _, e = f.s.Decide(f.ctx, f.dataset, "export", []string{"a.png"}, "exclude", ""); e != nil {
		t.Fatal(e)
	}
	_, e = f.s.PreviewExport(f.ctx, f.dataset, Record{"target_path": f.target})
	assertCode(t, e, "export_empty")
}
func TestCaptionPolicyParity(t *testing.T) {
	got := TransformCaption("Foo_Bar, foo bar, BLUE_EYES, ^_^, >_<, gone, ẞ", "foo bar", true, []string{"gone", "ss"}, true)
	if got != "foo bar, BLUE EYES, ^_^, >_<" {
		t.Fatal(got)
	}
	if got := TransformCaption("tag", "trigger", false, nil, false); got != "tag" {
		t.Fatal(got)
	}
	if SafeFolderName("CON.txt") != "CON.txt_" || SafeFolderName("  a/b:*  ") != "a_b__" {
		t.Fatal("folder normalization")
	}
}
func TestCopyContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var out strings.Builder
	n, e := copyContext(ctx, &out, strings.NewReader("data"))
	if n != 0 || !errors.Is(e, context.Canceled) {
		t.Fatal(n, e)
	}
}
