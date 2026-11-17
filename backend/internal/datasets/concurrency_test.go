package datasets

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestExportCapacityAndPortableTargetReservation(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "image"})
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	s := f.s
	s.afterItem = func(string, int) error {
		entered <- struct{}{}
		select {
		case <-release:
		case <-s.ctx.Done():
		}
		return nil
	}
	first := f.createExport(Record{"layout": "flat", "folder_name": "Résumé"})
	select {
	case <-entered:
	case <-f.ctx.Done():
		t.Fatal(f.ctx.Err())
	}
	_, e := s.CreateExport(f.ctx, f.dataset, Record{"target_path": f.target, "layout": "flat", "folder_name": "Re\u0301sume\u0301"})
	assertCode(t, e, "export_target_busy")
	second := f.createExport(Record{"layout": "flat", "folder_name": "second"})
	select {
	case <-entered:
	case <-f.ctx.Done():
		t.Fatal(f.ctx.Err())
	}
	_, e = s.CreateExport(f.ctx, f.dataset, Record{"target_path": f.target, "layout": "flat", "folder_name": "third"})
	assertCode(t, e, "export_capacity_reached")
	close(release)
	f.wait(first, "succeeded")
	f.wait(second, "succeeded")
}
func TestConcurrentDatasetWritesUseSerializedStore(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "a", "b.png": "b"})
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var e error
			if i%2 == 0 {
				_, e = f.s.Decide(f.ctx, f.dataset, "clean", []string{"a.png"}, "approve", "")
			} else {
				_, e = f.s.Update(f.ctx, f.dataset, Record{"trigger_word": "trigger"})
			}
			errs <- e
		}(i)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	rows, e := f.s.ListDecisions(f.ctx, f.dataset)
	if e != nil || len(rows) != 1 || rows[0]["decision"] != "approve" {
		t.Fatal(rows, e)
	}
}
func TestUnicodeCollisionAndCaptionlessPolicy(t *testing.T) {
	f := newFixture(t, map[string]string{"a/é.png": "one", "b/e\u0301.jpg": "two", "c/É.png": "three"})
	p, e := f.s.PreviewExport(f.ctx, f.dataset, Record{"target_path": f.target, "layout": "flat", "pin_trigger": false})
	if e != nil || num(p["collision_count"]) != 2 || num(p["caption_count"]) != 0 {
		t.Fatal(p, e)
	}
	id := f.createExport(Record{"layout": "flat", "pin_trigger": false})
	r := f.wait(id, "succeeded")
	entries, e := os.ReadDir(str(r["output_path"]))
	if e != nil || len(entries) != 3 {
		t.Fatal(entries, e)
	}
}
func TestCancelInterruptedIsIdempotentlyTerminal(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "a", "b.png": "b"})
	f.s.afterItem = func(string, int) error { return errSimulatedCrash }
	id := f.createExport(nil)
	f.s.wg.Wait()
	recoverService(t, f)
	r, e := f.s.CancelExport(f.ctx, id)
	if e != nil || r["status"] != "cancelled" {
		t.Fatal(r, e)
	}
	missing(t, filepath.Join(f.target, StagingName(id)))
	_, e = f.s.CancelExport(f.ctx, id)
	assertCode(t, e, "export_not_cancellable")
}
func TestSourceReaderRejectsTraversalAndParentSymlinks(t *testing.T) {
	f := newFixture(t, map[string]string{"sub/a.png": "a"})
	outside := t.TempDir()
	if e := os.WriteFile(filepath.Join(outside, "secret"), []byte("secret"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.Symlink(outside, filepath.Join(f.root, "link")); e != nil {
		t.Fatal(e)
	}
	for _, path := range []string{"../secret", "/etc/passwd", "sub/../../secret", "link/secret"} {
		file, e := f.s.openSource(context.Background(), f.source, path)
		if e == nil {
			file.Close()
			t.Fatalf("opened unsafe source %q", path)
		}
	}
}
