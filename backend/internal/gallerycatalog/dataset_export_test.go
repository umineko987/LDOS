package gallerycatalog

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func exportDirectory(t *testing.T, path string) *os.File {
	t.Helper()
	f, err := os.Open(path)
	must(t, err)
	t.Cleanup(func() { must(t, f.Close()) })
	return f
}

func TestRegisterDatasetExportReusesSourceAndPreservesTrash(t *testing.T) {
	s, ctx := testService(t), context.Background()
	path := filepath.Join(t.TempDir(), "exported copy")
	picture(t, path, "image.png")
	committed := exportDirectory(t, path)
	must(t, s.RegisterDatasetExport(ctx, path, committed))
	sources, err := s.ListSources(ctx)
	must(t, err)
	if len(sources) != 1 || str(sources[0], "display_name") != filepath.Base(path) || num(sources[0], "asset_count") != 1 {
		t.Fatal(sources)
	}
	sourceID := str(sources[0], "source_id")
	assetID := str(imageAt(t, s, sourceID, "image.png"), "asset_id")
	_, err = s.Trash(ctx, Selection{AssetIDs: []string{assetID}})
	must(t, err)
	if _, err := os.Stat(filepath.Join(path, "image.png")); !os.IsNotExist(err) {
		t.Fatalf("image was not moved to trash: %v", err)
	}
	// Even if a file with the same relative path reappears, it stays hidden.
	picture(t, path, "image.png")
	picture(t, path, "new.png")
	must(t, s.RegisterDatasetExport(ctx, path, committed))
	sources, err = s.ListSources(ctx)
	must(t, err)
	if len(sources) != 1 || str(sources[0], "source_id") != sourceID {
		t.Fatal(sources)
	}
	images := allImages(t, s, sourceID)
	if len(images) != 1 || str(images[0], "relative_path") != "new.png" {
		t.Fatal(images)
	}
}

func TestRegisterDatasetExportRescansContainingSourceAfterRunningScan(t *testing.T) {
	s := testService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	parent := t.TempDir()
	picture(t, parent, "before.png")
	source, err := s.ImportSource(ctx, parent, "original name")
	must(t, err)
	sourceID := str(source, "source_id")
	first, release := make(chan struct{}), make(chan struct{})
	s.AddScanListener(func(string) {
		select {
		case <-first:
			return
		default:
			close(first)
		}
		select {
		case <-release:
		case <-ctx.Done():
		}
	})
	original, err := s.StartScan(ctx, sourceID)
	must(t, err)
	select {
	case <-first:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	path := filepath.Join(parent, "exported")
	picture(t, path, "image.png")
	committed := exportDirectory(t, path)
	result := make(chan error, 1)
	go func() { result <- s.RegisterDatasetExport(ctx, path, committed) }()
	close(release)
	select {
	case err := <-result:
		must(t, err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	sources, err := s.ListSources(ctx)
	must(t, err)
	if len(sources) != 1 || str(sources[0], "source_id") != sourceID || str(sources[0], "display_name") != "original name" || num(sources[0], "asset_count") != 2 {
		t.Fatal(sources)
	}
	scan, err := s.GetScan(ctx, sourceID)
	must(t, err)
	if scan["operation_id"] == original["operation_id"] || str(scan, "state") != "succeeded" {
		t.Fatal(scan)
	}
	imageAt(t, s, sourceID, "exported/image.png")
}

func TestRegisterDatasetExportRejectsOverlappingOrReplacedRoot(t *testing.T) {
	s, ctx := testService(t), context.Background()
	path := filepath.Join(t.TempDir(), "exported")
	child := filepath.Join(path, "already imported")
	picture(t, child, "image.png")
	original, err := s.ImportSource(ctx, child, "")
	must(t, err)
	committed := exportDirectory(t, path)
	wantError(t, s.RegisterDatasetExport(ctx, path, committed), "source_conflict")
	must(t, os.Rename(path, path+"-moved"))
	picture(t, path, "wrong-image.png")
	wantError(t, s.RegisterDatasetExport(ctx, path, committed), "unsafe_source_path")
	must(t, os.Symlink(path+"-moved", path+"-link"))
	wantError(t, s.RegisterDatasetExport(ctx, path+"-link", committed), "unsafe_source_path")
	sources, err := s.ListSources(ctx)
	must(t, err)
	if len(sources) != 1 || sources[0]["source_id"] != original["source_id"] {
		t.Fatal(sources)
	}
}

func TestRegisterDatasetExportReportsScanFailure(t *testing.T) {
	s, ctx := testService(t), context.Background()
	path := filepath.Join(t.TempDir(), "exported")
	picture(t, path, "image.png")
	must(t, s.exec(ctx, `CREATE TRIGGER fail_export_scan BEFORE INSERT ON gallery_assets BEGIN SELECT RAISE(FAIL, 'test scan failure'); END`))
	wantError(t, s.RegisterDatasetExport(ctx, path, exportDirectory(t, path)), "gallery_scan_failed")
	sources, err := s.ListSources(ctx)
	must(t, err)
	if len(sources) != 1 || num(sources[0], "asset_count") != 0 {
		t.Fatal(sources)
	}
	scan, err := s.GetScan(ctx, str(sources[0], "source_id"))
	must(t, err)
	if str(scan, "state") != "failed" {
		t.Fatal(scan)
	}
}
