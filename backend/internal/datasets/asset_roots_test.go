package datasets

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"ldos/backend/internal/activity"
)

func newAssetRootDataset(t *testing.T, f *fixture) string {
	t.Helper()
	d, e := f.s.Create(f.ctx, CreateOptions{Name: "Selected library images"})
	if e != nil {
		t.Fatal(e)
	}
	return str(d["dataset_id"])
}

func TestAttachAssetsIncludesOnlySelectedFile(t *testing.T) {
	f := newFixture(t, map[string]string{"batch/one.png": "one", "batch/two.png": "two", "batch/one.png.extra.png": "neighbor"})
	f.caption("batch/one.png", "original caption")
	before, e := f.db.QueryRow(f.ctx, "SELECT * FROM gallery_assets WHERE id=?", "batch/one.png")
	if e != nil {
		t.Fatal(e)
	}
	id := newAssetRootDataset(t, f)
	added, e := f.s.AttachAssets(f.ctx, id, []string{"batch/one.png", "batch/one.png"})
	if e != nil || added != 1 {
		t.Fatalf("attach: %d %v", added, e)
	}
	members, e := f.s.MemberRows(f.ctx, id)
	if e != nil || !reflect.DeepEqual(ids(members), []string{"batch/one.png"}) {
		t.Fatalf("selected members: %v %v", ids(members), e)
	}
	page, e := f.s.MembersPage(f.ctx, id, MemberOptions{})
	if e != nil || num(page["total"]) != 1 || !reflect.DeepEqual(ids(records(page["items"])), []string{"batch/one.png"}) {
		t.Fatalf("members page: %v %v", page, e)
	}
	roots, e := f.s.ListRoots(f.ctx, id)
	if e != nil || len(roots) != 1 {
		t.Fatalf("roots: %v %v", roots, e)
	}
	r := roots[0]
	if r["relative_path"] != "batch/one.png" || r["directory_id"] != DirectoryID(f.source, "batch/one.png") || r["name"] != "one.png" || r["origin"] != "library" || r["available"] != true || num(r["recursive_asset_count"]) != 1 {
		t.Fatal(r)
	}
	for _, key := range []string{"asset_name", "directory_name", "source_availability", "selection_kind"} {
		if _, ok := r[key]; ok {
			t.Fatalf("internal or new API field %q leaked: %v", key, r)
		}
	}
	after, e := f.db.QueryRow(f.ctx, "SELECT * FROM gallery_assets WHERE id=?", "batch/one.png")
	if e != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("library asset changed: %v %v", after, e)
	}
	original, e := f.s.MemberRows(f.ctx, f.dataset)
	if e != nil || len(original) != 3 {
		t.Fatalf("original dataset members: %v %v", original, e)
	}
}

func TestAttachAssetsSkipsCoveredDirectories(t *testing.T) {
	for _, relative := range []string{"", "batch"} {
		t.Run("root="+relative, func(t *testing.T) {
			f := newFixture(t, map[string]string{"batch/a.png": "a", "batch/b.png": "b", "batch2/c.png": "c"})
			wantCount := int64(2)
			if relative == "" {
				wantCount = 3
			}
			f.exec("UPDATE gallery_directories SET recursive_asset_count=? WHERE id=?", wantCount, DirectoryID(f.source, relative))
			id := newAssetRootDataset(t, f)
			r, created, e := f.s.AttachDirectory(f.ctx, id, DirectoryID(f.source, relative))
			if e != nil || !created || r["available"] != true || num(r["recursive_asset_count"]) != wantCount {
				t.Fatalf("directory root: %v %v %v", r, created, e)
			}
			added, e := f.s.AttachAssets(f.ctx, id, []string{"batch/a.png", "batch/b.png"})
			if e != nil || added != 0 {
				t.Fatalf("covered assets: %d %v", added, e)
			}
			roots, e := f.s.ListRoots(f.ctx, id)
			if e != nil || len(roots) != 1 || num(roots[0]["recursive_asset_count"]) != wantCount {
				t.Fatalf("directory count changed: %v %v", roots, e)
			}
			if relative != "" {
				added, e = f.s.AttachAssets(f.ctx, id, []string{"batch2/c.png"})
				if e != nil || added != 1 {
					t.Fatalf("prefix neighbor incorrectly covered: %d %v", added, e)
				}
			}
		})
	}
}

func TestDetachAssetRootPreservesLibraryAssetAndCaption(t *testing.T) {
	f := newFixture(t, map[string]string{"batch/a.png": "original image"})
	f.caption("batch/a.png", "original caption")
	id := newAssetRootDataset(t, f)
	if _, e := f.s.AttachAssets(f.ctx, id, []string{"batch/a.png"}); e != nil {
		t.Fatal(e)
	}
	roots, e := f.s.ListRoots(f.ctx, id)
	if e != nil || len(roots) != 1 {
		t.Fatal(roots, e)
	}
	if e = f.s.DetachRoot(f.ctx, id, str(roots[0]["root_id"])); e != nil {
		t.Fatal(e)
	}
	members, e := f.s.MemberRows(f.ctx, id)
	if e != nil || len(members) != 0 {
		t.Fatal(members, e)
	}
	original, e := f.s.MemberRows(f.ctx, f.dataset)
	if e != nil || len(original) != 1 || original[0]["lifecycle_state"] != "active" {
		t.Fatalf("source asset changed: %v %v", original, e)
	}
	for relative, want := range map[string]string{"batch/a.png": "original image", "batch/a.txt": "original caption"} {
		got, e := os.ReadFile(filepath.Join(f.root, relative))
		if e != nil || string(got) != want {
			t.Fatalf("source file %s: %q %v", relative, got, e)
		}
	}
}

func TestAssetRootAvailabilityTracksCatalogState(t *testing.T) {
	for _, state := range []string{"missing", "trashed", "excluded", "offline"} {
		t.Run(state, func(t *testing.T) {
			f := newFixture(t, map[string]string{"batch/a.png": "a"})
			id := newAssetRootDataset(t, f)
			if _, e := f.s.AttachAssets(f.ctx, id, []string{"batch/a.png"}); e != nil {
				t.Fatal(e)
			}
			wantMembers, wantCount := 0, int64(0)
			switch state {
			case "missing":
				if e := os.Remove(filepath.Join(f.root, "batch/a.png")); e != nil {
					t.Fatal(e)
				}
				f.exec("UPDATE gallery_assets SET lifecycle_state='missing' WHERE id='batch/a.png'")
			case "trashed":
				f.exec("UPDATE gallery_assets SET lifecycle_state='trashed' WHERE id='batch/a.png'")
			case "excluded":
				f.exec("UPDATE gallery_assets SET dedup_visibility='excluded' WHERE id='batch/a.png'")
			case "offline":
				f.exec("UPDATE gallery_sources SET availability='offline'")
				wantMembers, wantCount = 1, 1
			}
			roots, e := f.s.ListRoots(f.ctx, id)
			if e != nil || len(roots) != 1 || roots[0]["name"] != "a.png" || roots[0]["available"] != false || num(roots[0]["recursive_asset_count"]) != wantCount {
				t.Fatalf("unavailable root: %v %v", roots, e)
			}
			members, e := f.s.MemberRows(f.ctx, id)
			if e != nil || len(members) != wantMembers {
				t.Fatalf("members: %v %v", members, e)
			}
		})
	}
}

func TestAttachAssetsInvalidSelectionIsAtomic(t *testing.T) {
	cases := []struct {
		name, query, code string
	}{
		{"unknown", "DELETE FROM gallery_assets WHERE id='b.png'", "gallery_asset_not_found"},
		{"missing", "UPDATE gallery_assets SET lifecycle_state='missing' WHERE id='b.png'", "gallery_asset_unavailable"},
		{"trashed", "UPDATE gallery_assets SET lifecycle_state='trashed' WHERE id='b.png'", "gallery_asset_unavailable"},
		{"excluded", "UPDATE gallery_assets SET dedup_visibility='excluded' WHERE id='b.png'", "gallery_asset_unavailable"},
		{"offline", "UPDATE gallery_sources SET availability='offline'", "source_offline"},
		{"unsafe", "UPDATE gallery_assets SET relative_path='../b.png' WHERE id='b.png'", "dataset_root_path_invalid"},
		{"excluded_path", "UPDATE gallery_assets SET relative_path='keep/b.png' WHERE id='b.png'", "dataset_root_path_excluded"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t, map[string]string{"a.png": "a", "b.png": "b"})
			id := newAssetRootDataset(t, f)
			f.exec("UPDATE datasets SET updated_at=1 WHERE id=?", id)
			f.exec(tc.query)
			f.s.deps.Events = activity.NewBus(10)
			added, e := f.s.AttachAssets(f.ctx, id, []string{"a.png", "b.png"})
			assertCode(t, e, tc.code)
			if added != 0 {
				t.Fatalf("failed selection counted %d assets", added)
			}
			roots, e := f.s.ListRoots(f.ctx, id)
			if e != nil || len(roots) != 0 {
				t.Fatalf("partial roots: %v %v", roots, e)
			}
			d, e := f.db.QueryRow(f.ctx, "SELECT updated_at FROM datasets WHERE id=?", id)
			if e != nil || num(d["updated_at"]) != 1 {
				t.Fatalf("failed selection touched dataset: %v %v", d, e)
			}
			events, _ := f.s.deps.Events.EventsAfter(0)
			if len(events) != 0 {
				t.Fatalf("failed selection published: %v", events)
			}
		})
	}
}

func TestAttachAssetsBatchTouchesAndPublishesOnce(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "a", "b.png": "b"})
	id := newAssetRootDataset(t, f)
	f.exec("CREATE TABLE asset_root_touches(dataset_id TEXT)")
	f.exec("CREATE TRIGGER asset_root_touch AFTER UPDATE OF updated_at ON datasets BEGIN INSERT INTO asset_root_touches VALUES(new.id); END")
	f.s.deps.Events = activity.NewBus(10)
	for i, want := range []int{2, 0} {
		added, e := f.s.AttachAssets(f.ctx, id, []string{"a.png", "b.png", "a.png"})
		if e != nil || added != want {
			t.Fatalf("batch %d: %d %v", i, added, e)
		}
	}
	roots, e := f.s.ListRoots(f.ctx, id)
	if e != nil || len(roots) != 2 {
		t.Fatal(roots, e)
	}
	touches, e := f.db.QueryRow(f.ctx, "SELECT COUNT(*) AS n FROM asset_root_touches WHERE dataset_id=?", id)
	if e != nil || num(touches["n"]) != 1 {
		t.Fatalf("touches: %v %v", touches, e)
	}
	events, _ := f.s.deps.Events.EventsAfter(0)
	if len(events) != 1 || events[0].Kind != "dataset.updated" {
		t.Fatalf("events: %v", events)
	}
}

func TestAttachAssetsValidatesBoundsAndDataset(t *testing.T) {
	f := newFixture(t, map[string]string{"a.png": "a"})
	id := newAssetRootDataset(t, f)
	for _, count := range []int{0, 1001} {
		selection := make([]string, count)
		for i := range selection {
			selection[i] = "a.png"
		}
		added, e := f.s.AttachAssets(f.ctx, id, selection)
		assertCode(t, e, "validation_error")
		if added != 0 {
			t.Fatalf("invalid size %d added %d assets", count, added)
		}
	}
	_, e := f.s.AttachAssets(f.ctx, "missing-dataset", []string{"a.png"})
	assertCode(t, e, "dataset_not_found")
	selection := make([]string, 1000)
	for i := range selection {
		selection[i] = "a.png"
	}
	added, e := f.s.AttachAssets(f.ctx, id, selection)
	if e != nil || added != 1 {
		t.Fatalf("upper bound with duplicate IDs: %d %v", added, e)
	}
}
