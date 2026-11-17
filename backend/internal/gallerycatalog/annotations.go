package gallerycatalog

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode/utf8"

	"ldos/backend/internal/store"
)

func (s *Service) GetAnnotation(ctx context.Context, assetID string) (Row, error) {
	a, e := s.GetImage(ctx, assetID)
	if e != nil {
		return nil, e
	}
	release, e := s.LockSources(ctx, str(a, "source_id"))
	if e != nil {
		return nil, e
	}
	defer release()
	return s.annotationLocked(ctx, assetID)
}

// GetAnnotationSnapshot exposes BOM metadata only to trusted caption consumers.
func (s *Service) GetAnnotationSnapshot(ctx context.Context, assetID string) (Row, error) {
	a, e := s.GetImage(ctx, assetID)
	if e != nil {
		return nil, e
	}
	release, e := s.LockSources(ctx, str(a, "source_id"))
	if e != nil {
		return nil, e
	}
	defer release()
	return s.annotationSnapshotLocked(ctx, assetID)
}

func (s *Service) annotationLocked(ctx context.Context, assetID string) (Row, error) {
	row, err := s.annotationSnapshotLocked(ctx, assetID)
	delete(row, "bom")
	return row, err
}

func (s *Service) annotationSnapshotLocked(ctx context.Context, assetID string) (Row, error) {
	a, e := s.GetImage(ctx, assetID)
	if e != nil {
		return nil, e
	}
	if str(a, "lifecycle_state") != "active" {
		return nil, failure("asset_not_active", 409)
	}
	root, e := s.OpenSource(ctx, str(a, "source_id"))
	if e != nil {
		return nil, e
	}
	defer root.Close()
	bytes, disk, _, e := root.ReadVersion(CaptionRelativePath(str(a, "relative_path")), 8<<20)
	if e != nil {
		return nil, wrapIO(e, "txt_io_error")
	}
	state := captionState(bytes, bytes != nil, true, str(a, "txt_state") == "pair_conflict")
	var content any
	if state == "normal" || state == "blank" {
		content, _ = decodeCaption(bytes)
	}
	return Row{"asset_id": assetID, "txt_state": state, "content": content, "txt_version": num(a, "txt_version"), "disk_version": disk, "bom": strings.HasPrefix(string(bytes), "\ufeff")}, nil
}
func (s *Service) ReadAnnotations(ctx context.Context, assetIDs []string) (map[string]Row, error) {
	if len(assetIDs) > 2000 {
		return nil, failure("invalid_asset_ids", 422)
	}
	out := map[string]Row{}
	for _, aid := range assetIDs {
		if e := ctx.Err(); e != nil {
			return nil, e
		}
		a, e := s.GetAnnotation(ctx, aid)
		if e != nil {
			a = Row{"asset_id": aid, "content": nil, "error": errorCode(e)}
		}
		out[aid] = a
	}
	return out, nil
}

type AnnotationWrite struct {
	ExpectedTxtVersion  int64
	ExpectedDiskVersion string
	PreserveBOM         bool
}

func (s *Service) SaveAnnotation(ctx context.Context, assetID, content string, expectedTxtVersion int64, expectedDiskVersion string) (Row, error) {
	return s.WriteAnnotation(ctx, assetID, &content, AnnotationWrite{ExpectedTxtVersion: expectedTxtVersion, ExpectedDiskVersion: expectedDiskVersion})
}
func (s *Service) RemoveAnnotation(ctx context.Context, assetID string, expectedTxtVersion int64, expectedDiskVersion string) (Row, error) {
	return s.WriteAnnotation(ctx, assetID, nil, AnnotationWrite{ExpectedTxtVersion: expectedTxtVersion, ExpectedDiskVersion: expectedDiskVersion})
}

// WriteAnnotation takes nil content to delete a sidecar. Caption batches can retain
// a source BOM explicitly. Both the indexed version and opaque disk version are
// required; an unrelated external edit is never silently overwritten.
func (s *Service) WriteAnnotation(ctx context.Context, assetID string, content *string, opts AnnotationWrite) (Row, error) {
	if opts.ExpectedTxtVersion < 1 || len(opts.ExpectedDiskVersion) != 64 {
		return nil, failure("invalid_annotation_version", 422)
	}
	if content != nil && (!utf8.ValidString(*content) || len([]rune(*content)) > 2<<20) {
		return nil, failure("invalid_annotation_content", 422)
	}
	a, e := s.GetImage(ctx, assetID)
	if e != nil {
		return nil, e
	}
	release, e := s.LockSources(ctx, str(a, "source_id"))
	if e != nil {
		return nil, e
	}
	defer release()
	a, e = s.GetImage(ctx, assetID)
	if e != nil {
		return nil, e
	}
	if str(a, "lifecycle_state") != "active" {
		return nil, failure("asset_not_active", 409)
	}
	if str(a, "txt_state") == "pair_conflict" {
		return nil, failure("txt_pair_conflict", 409)
	}
	if num(a, "txt_version") != opts.ExpectedTxtVersion {
		return nil, failure("txt_version_conflict", 409)
	}
	root, e := s.OpenSource(ctx, str(a, "source_id"))
	if e != nil {
		return nil, e
	}
	defer root.Close()
	relative := CaptionRelativePath(str(a, "relative_path"))
	before, disk, oldStat, e := root.ReadVersion(relative, 8<<20)
	if e != nil {
		return nil, wrapIO(e, "txt_io_error")
	}
	if disk != opts.ExpectedDiskVersion {
		return nil, failure("txt_disk_conflict", 409)
	}
	newDisk := MissingDiskVersion
	newStat := fileIdentity{}
	var bytes []byte
	if content != nil {
		bytes = []byte(*content)
		if opts.PreserveBOM && strings.HasPrefix(string(before), "\ufeff") && !strings.HasPrefix(*content, "\ufeff") {
			bytes = append([]byte("\ufeff"), bytes...)
		}
		newDisk, newStat, e = root.AtomicWrite(relative, bytes, disk)
	} else if before != nil {
		e = root.Remove(relative, &oldStat)
	}
	if e != nil {
		return nil, wrapIO(e, "txt_io_error")
	}
	state := captionState(bytes, content != nil, true, false)
	txtRel, hash := relative, ""
	if content != nil {
		hash = digest(bytes)
	}
	e = s.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		result, e := tx.ExecContext(ctx, `UPDATE gallery_assets SET txt_relative_path=?,txt_size_bytes=?,txt_modified_ns=?,txt_sha256=?,txt_state=?,txt_version=txt_version+1,updated_at=? WHERE id=? AND txt_version=? AND lifecycle_state='active'`, txtRel, newStat.Size, newStat.Modified, hash, state, now(), assetID, opts.ExpectedTxtVersion)
		if e = checkRows(result, e, "txt_version_conflict"); e != nil {
			return e
		}
		updated, e := store.QueryRowTx(ctx, tx, "SELECT * FROM gallery_assets WHERE id=?", assetID)
		if e != nil {
			return e
		}
		txt := ""
		if content != nil {
			txt, _ = decodeCaption(bytes)
		}
		if e = refreshFTSTx(ctx, tx, updated, txt); e != nil {
			return e
		}
		_, e = tx.ExecContext(ctx, "UPDATE gallery_sources SET annotation_version=annotation_version+1,indexed_version=indexed_version+1,updated_at=? WHERE id=?", now(), a["source_id"])
		return e
	})
	if e != nil {
		// Roll back only the inode/version this operation published. If a foreign
		// writer replaced it, report recovery rather than destroy their data.
		var rollback error
		if before == nil {
			if content != nil {
				rollback = root.Remove(relative, &newStat)
			}
		} else {
			_, _, rollback = root.AtomicWrite(relative, before, newDisk)
		}
		if rollback != nil {
			return nil, &Error{Code: "annotation_recovery_required", Status: 500, Cause: errors.Join(e, rollback)}
		}
		return nil, e
	}
	return s.annotationLocked(ctx, assetID)
}
