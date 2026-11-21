package gallerycatalog

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// RegisterDatasetExport imports a committed copy, or scans its existing source.
// It never writes gallery files; Scan preserves trash state for known assets.
func (s *Service) RegisterDatasetExport(ctx context.Context, outputPath string, committed *os.File) error {
	expected, err := fileStat(committed)
	if err != nil {
		return err
	}
	root, err := openExportRoot(outputPath, expected)
	if err != nil {
		return err
	}
	outputPath = root.path
	root.Close()

	source, err := s.ImportSource(ctx, outputPath, "")
	var sourceID string
	if err == nil {
		sourceID = str(source, "source_id")
	} else {
		var conflict *Error
		if !errors.As(err, &conflict) || conflict.Code != "source_conflict" {
			return err
		}
		switch str(conflict.Details, "relation") {
		case "same", "descendant":
			sourceID = str(conflict.Details, "conflicting_source_id")
		default:
			return err
		}
	}

	validate := func(ctx context.Context) error {
		// This runs under the source lock, in case it was relinked while
		// waiting to scan. Do not index a replacement at the export path.
		source, err := s.Source(ctx, sourceID)
		if err != nil {
			return err
		}
		sourcePath := str(source, "root_path")
		switch rootRelation(outputPath, sourcePath) {
		case "same":
		case "descendant":
			rel, err := filepath.Rel(sourcePath, outputPath)
			if err != nil || ValidateRelativePath(rel, false) != nil {
				return failure("unsafe_source_path", 409)
			}
		default:
			return failure("source_conflict", 409)
		}
		root, err := openExportRoot(outputPath, expected)
		if err != nil {
			return err
		}
		return root.Close()
	}

	for {
		_, scan, err := s.startScan(ctx, sourceID, validate)
		if err != nil && errorCode(err) != "scan_in_progress" {
			return &Error{Code: "gallery_scan_failed", Status: 409, Cause: err}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-scan.done:
		}
		if err != nil {
			// A scan already underway may have enumerated the tree before the
			// export was renamed. Start a fresh one once it has finished.
			continue
		}
		stats, _ := scan.row["stats"].(Row)
		if str(scan.row, "state") != "succeeded" || truth(stats, "offline") {
			return failure("gallery_scan_failed", 409)
		}
		return nil
	}
}

func openExportRoot(path string, expected fileIdentity) (*SafeRoot, error) {
	for _, component := range strings.Split(path, "/") {
		if reserved(component) || strings.HasPrefix(component, ".ldos-txt-") {
			return nil, failure("unsafe_source_path", 409)
		}
	}
	root, err := OpenSafeRoot(path)
	if err != nil {
		return nil, wrapIO(err, "unsafe_source_path")
	}
	if !root.identity.sameFile(expected) {
		root.Close()
		return nil, failure("unsafe_source_path", 409)
	}
	return root, nil
}
