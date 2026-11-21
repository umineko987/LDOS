package datasets

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"ldos/backend/internal/gallerycatalog"
)

func TestExportRegistersAndScansFinalCopy(t *testing.T) {
	var img bytes.Buffer
	if err := png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 2, 3))); err != nil {
		t.Fatal(err)
	}
	f := newFixture(t, map[string]string{"a.png": img.String()})
	catalog, err := gallerycatalog.New(f.ctx, gallerycatalog.Dependencies{Store: f.db})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = catalog.Stop() })
	f.s.deps.RegisterExport = catalog.RegisterDatasetExport
	id := f.createExport(nil)
	job := f.wait(id, "succeeded")
	if job["error_code"] != nil || job["gallery_warning"] != nil {
		t.Fatal(job)
	}
	sources, err := catalog.ListSources(f.ctx)
	if err != nil || len(sources) != 2 {
		t.Fatal(sources, err)
	}
	var exported gallerycatalog.Row
	for _, source := range sources {
		if source["display_name"] == job["folder_name"] {
			exported = source
		}
	}
	if num(exported["asset_count"]) != 1 || exported["kind"] != "imported" {
		t.Fatal(exported)
	}
	sourceID := str(exported["source_id"])
	root, err := catalog.Source(f.ctx, sourceID)
	if err != nil || root["root_path"] != job["output_path"] {
		t.Fatal(root, err)
	}
	scan, err := catalog.GetScan(f.ctx, sourceID)
	if err != nil || scan["state"] != "succeeded" {
		t.Fatal(scan, err)
	}
	page, err := catalog.ListImages(f.ctx, gallerycatalog.ImageQuery{SourceID: sourceID, Limit: 10})
	if err != nil || len(page.Assets) != 1 || page.Assets[0]["relative_path"] != "a.png" {
		t.Fatal(page, err)
	}
}

func TestExportGalleryWarningDoesNotFailFileCopy(t *testing.T) {
	for _, tc := range []struct{ failure, warning string }{
		{"source_conflict", "gallery_registration_failed"},
		{"gallery_scan_failed", "gallery_scan_failed"},
	} {
		t.Run(tc.warning, func(t *testing.T) {
			f := newFixture(t, map[string]string{"a.png": "image"})
			f.s.deps.RegisterExport = func(_ context.Context, path string, _ *os.File) error {
				if path != filepath.Join(f.target, "10_char_tok") {
					t.Errorf("gallery received wrong path: %q", path)
				}
				return failure(409, tc.failure, "")
			}
			id := f.createExport(nil)
			job := f.wait(id, "succeeded")
			if job["gallery_warning"] != tc.warning || job["error_code"] != nil || job["resumable"] != false {
				t.Fatal(job)
			}
			if got := readFile(t, filepath.Join(str(job["output_path"]), "a.png")); got != "image" {
				t.Fatal(got)
			}
		})
	}
}
