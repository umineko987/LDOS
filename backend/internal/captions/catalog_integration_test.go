package captions

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"ldos/backend/internal/config"
	"ldos/backend/internal/gallerycatalog"
)

func TestNativeCatalogGuardsAndSearchIndex(t *testing.T) {
	f := newFixture(t)
	f.put("a", ptr("original"))
	must(t, os.WriteFile(filepath.Join(f.root, "a.png"), []byte("image"), 0600))
	f.exec(`INSERT INTO gallery_sources(id,kind,display_name,root_path,canonical_root_key,created_at,updated_at) VALUES('source','imported','Source',?,?,1,1)`, f.root, f.root)
	f.exec(`INSERT INTO gallery_directories(id,source_id,relative_path,name,sort_key,created_at,updated_at) VALUES('root','source','','Source','',1,1)`)
	f.exec(`INSERT INTO gallery_assets(id,source_id,directory_id,relative_path,name,extension,sort_key,size_bytes,modified_ns,txt_relative_path,txt_state,created_at,updated_at) VALUES('a','source','root','a.png','a.png','.png','a',5,1,'a.txt','normal',1,1)`)
	cat, e := gallerycatalog.New(context.Background(), gallerycatalog.Dependencies{Store: f.db, Settings: config.Settings{RuntimeDir: filepath.Join(f.root, "runtime")}})
	must(t, e)
	defer cat.Stop()
	convert := func(r gallerycatalog.Row) Annotation {
		a := Annotation{AssetID: Text(r["asset_id"]), State: Text(r["txt_state"]), DiskVersion: Text(r["disk_version"]), TXTVersion: Number(r["txt_version"]), Error: Text(r["error"])}
		if r["content"] != nil {
			v := Text(r["content"])
			a.Content = &v
		}
		return a
	}
	deps := f.s.deps
	deps.ReadAnnotations = func(ctx context.Context, ids []string) (map[string]Annotation, error) {
		rows, e := cat.ReadAnnotations(ctx, ids)
		out := map[string]Annotation{}
		for k, r := range rows {
			out[k] = convert(r)
		}
		return out, e
	}
	deps.WriteAnnotation = func(ctx context.Context, id string, v *string, o AnnotationWrite) (Annotation, error) {
		r, e := cat.WriteAnnotation(ctx, id, v, gallerycatalog.AnnotationWrite{ExpectedTxtVersion: o.TXTVersion, ExpectedDiskVersion: o.DiskVersion, PreserveBOM: o.BOM})
		var ge *gallerycatalog.Error
		if errors.As(e, &ge) {
			e = &Error{Status: ge.Status, Code: ge.Code, Message: ge.Error()}
		}
		return convert(r), e
	}
	must(t, f.s.Stop())
	f.s, e = New(context.Background(), deps)
	must(t, e)
	a, e := f.s.read(context.Background(), []string{"a"})
	must(t, e)
	r, e := f.s.Edit(context.Background(), "d", "a", "searchable, caption", a["a"].DiskVersion)
	must(t, e)
	indexed, e := f.db.QueryRow(context.Background(), "SELECT txt_content FROM gallery_search_index WHERE asset_id='a'")
	must(t, e)
	if Text(indexed["txt_content"]) != "searchable, caption" {
		t.Fatal(indexed)
	}
	_, e = f.s.Undo(context.Background(), Text(r["batch_id"]))
	must(t, e)
	a, e = f.s.read(context.Background(), []string{"a"})
	must(t, e)
	must(t, os.WriteFile(filepath.Join(f.root, "a.txt"), []byte("external"), 0600))
	_, e = f.s.Edit(context.Background(), "d", "a", "clobber", a["a"].DiskVersion)
	code(t, e, "caption_version_conflict")
	f.exec("UPDATE gallery_assets SET txt_state='pair_conflict' WHERE id='a'")
	_, e = f.s.Edit(context.Background(), "d", "a", "clobber", "v")
	code(t, e, "caption_not_editable")
	f.exec("UPDATE gallery_assets SET txt_state='normal' WHERE id='a'")
	outside := filepath.Join(t.TempDir(), "outside.txt")
	must(t, os.WriteFile(outside, []byte("protected"), 0600))
	must(t, os.Remove(filepath.Join(f.root, "a.txt")))
	must(t, os.Symlink(outside, filepath.Join(f.root, "a.txt")))
	r, e = f.ops([]string{"a"}, []Op{{Op: "add", Tags: []string{"clobber"}}}, false)
	must(t, e)
	if r["stats"].(map[string]int)["skipped"] != 1 {
		t.Fatal(r)
	}
	b, e := os.ReadFile(outside)
	must(t, e)
	if string(b) != "protected" {
		t.Fatal("escaped source")
	}
	f.exec("UPDATE gallery_sources SET availability='offline' WHERE id='source'")
	r, e = f.ops([]string{"a"}, []Op{{Op: "add", Tags: []string{"x"}}}, false)
	must(t, e)
	if r["stats"].(map[string]int)["written"] != 0 {
		t.Fatal(r)
	}
}
