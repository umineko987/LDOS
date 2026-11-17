package datasets

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

// errSimulatedCrash is used only by package tests to stop before finalization.
var errSimulatedCrash = errors.New("simulated process interruption")

func waitTick(ctx context.Context) error {
	t := time.NewTimer(time.Millisecond)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
func (s *Service) runExport(ctx context.Context, id string) {
	defer s.release(id)
	stats, e := s.executeExport(ctx, id)
	if errors.Is(e, errSimulatedCrash) {
		return
	}
	finalCtx := context.Background()
	status, code := "succeeded", ""
	var details Record
	if e != nil {
		status = "failed"
		code = "copy_io_error"
		var de *Error
		if errors.Is(e, context.Canceled) || errors.Is(e, context.DeadlineExceeded) {
			if s.ctx.Err() != nil {
				status = "interrupted"
				code = "export_interrupted"
			} else {
				status = "cancelled"
				code = ""
			}
		} else if errors.As(e, &de) {
			code = de.Code
			details, _ = de.Details.(Record)
		} else if errors.Is(e, os.ErrPermission) {
			code = "target_not_writable"
		}
		if status == "cancelled" || status == "failed" && code != "copy_io_error" && code != "export_target_exists" {
			_ = s.removeStaging(finalCtx, id)
		}
	}
	// The reservation stays held through terminal state persistence. Cancel and
	// resume cannot overwrite a just-committed success with a stale state read.
	_ = s.finishExport(finalCtx, id, status, code, stats, details)
}
func (s *Service) executeExport(ctx context.Context, id string) (Record, error) {
	row, e := s.exportRow(ctx, id)
	if e != nil {
		return nil, e
	}
	o := object(row["options_json"])
	targetPath := str(row["target_path"])
	folder := str(o["folder_name"])
	if !safeLeaf(folder) {
		return nil, failure(409, "target_path_unsafe", "导出目标无效")
	}
	expectedTarget, e := readIdentity(o["target_identity"])
	if e != nil {
		return nil, e
	}
	if e = verifyDirectory(targetPath, expectedTarget); e != nil {
		return nil, e
	}
	t := now()
	if e = s.exec(ctx, "UPDATE dataset_export_jobs SET status='running',updated_at=?,started_at=COALESCE(started_at,?) WHERE id=?", t, t, id); e != nil {
		return nil, e
	}
	s.publishExport(ctx, id)
	target, e := openDirectory(targetPath)
	if e != nil {
		return nil, e
	}
	defer target.Close()
	actual, e := identity(target)
	if e != nil {
		return nil, e
	}
	if actual != expectedTarget {
		return nil, failure(409, "target_root_changed", "导出目录已变化")
	}
	staging := StagingName(id)
	owned, resumed, e := s.stagingIdentity(ctx, id)
	if e != nil {
		return nil, e
	}
	if resumed {
		actual, err := identityAt(target, staging)
		if err != nil || actual != owned {
			final, finalErr := identityAt(target, folder)
			if finalErr == nil && final == owned {
				if e = s.exportEvent(ctx, id, "committed", Record{"recovered": true}); e != nil {
					return nil, e
				}
				return exportStats(id, o, row), nil
			}
			if !errors.Is(err, unix.ENOENT) {
				return nil, failure(409, "target_path_changed", "临时目录被替换")
			}
			if e = s.exec(ctx, "UPDATE dataset_export_items SET copy_state='pending',committed_at=NULL WHERE job_id=?", id); e != nil {
				return nil, e
			}
			resumed = false
		}
	}
	if !resumed {
		if e = unix.Mkdirat(int(target.Fd()), staging, 0700); e != nil {
			if errors.Is(e, unix.EEXIST) {
				return nil, failure(409, "target_path_changed", "临时目录名字已被占用")
			}
			return nil, e
		}
		owned, e = identityAt(target, staging)
		if e != nil {
			return nil, e
		}
		if e = target.Sync(); e != nil {
			return nil, e
		}
		if e = s.exportEvent(ctx, id, "staging_created", Record{"name": staging, "identity": owned}); e != nil {
			_ = removeOwned(target, staging, owned)
			return nil, e
		}
	}
	dir, e := openChildDirectory(target, staging)
	if e != nil {
		return nil, e
	}
	defer dir.Close()
	actual, e = identity(dir)
	if e != nil {
		return nil, e
	}
	if actual != owned {
		return nil, failure(409, "target_path_changed", "临时目录已变化")
	}
	items, e := s.exportItems(ctx, id)
	if e != nil {
		return nil, e
	}
	staged := 0
	for _, item := range items {
		if str(item["copy_state"]) == "staged" {
			staged++
		}
	}
	s.exportProgress(ctx, id, staged, len(items))
	for i, item := range items {
		if e = ctx.Err(); e != nil {
			return nil, e
		}
		if e = verifyDirectory(targetPath, expectedTarget); e != nil {
			return nil, e
		}
		if e = verifyOwned(target, staging, owned); e != nil {
			return nil, e
		}
		if str(item["copy_state"]) == "staged" {
			continue
		}
		if resumed {
			if e = removeOutput(dir, str(item["output_relative_path"])); e != nil {
				return nil, e
			}
			if name := str(item["txt_output_relative_path"]); name != "" {
				if e = removeOutput(dir, name); e != nil {
					return nil, e
				}
			}
		}
		if e = s.copyExportItem(ctx, dir, item, o); e != nil {
			return nil, e
		}
		staged++
		s.exportProgress(ctx, id, staged, len(items))
		if s.afterItem != nil {
			if e = s.afterItem(id, i+1); e != nil {
				return nil, e
			}
		}
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	expected := map[string]int64{}
	for _, item := range items {
		expected[str(item["output_relative_path"])] = num(item["image_size_bytes"])
		if name := str(item["txt_output_relative_path"]); name != "" {
			expected[name] = num(item["txt_size_bytes"])
		}
	}
	if e = validateTree(ctx, dir, expected); e != nil {
		return nil, e
	}
	if e = dir.Sync(); e != nil {
		return nil, e
	}
	if e = verifyDirectory(targetPath, expectedTarget); e != nil {
		return nil, e
	}
	if e = s.exportEvent(ctx, id, "commit_started", Record{}); e != nil {
		return nil, e
	}
	// Cancellation observed before the atomic rename rolls back. Once rename
	// succeeds, this committed result wins a concurrent cancellation request.
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	if e = commitDirectory(target, staging, folder, owned); e != nil {
		if errorCode(e) == "export_target_exists" {
			return nil, failure(409, "export_target_exists", "导出目录里已经有同名文件夹", Record{"output_path": filepath.Join(targetPath, folder)})
		}
		return nil, e
	}
	if e = s.exportEvent(context.Background(), id, "committed", Record{}); e != nil {
		return nil, e
	}
	if s.afterCommit != nil {
		if e = s.afterCommit(id); e != nil {
			return nil, e
		}
	}
	return exportStats(id, o, row), nil
}
func exportStats(id string, o, row Record) Record {
	return Record{"export_id": id, "exported": num(row["sample_count"]), "image_bytes": num(row["image_bytes"]), "txt_bytes": num(row["txt_bytes"]), "layout": o["layout"], "folder_name": o["folder_name"], "output_path": filepath.Join(str(row["target_path"]), str(o["folder_name"]))}
}
func (s *Service) copyExportItem(ctx context.Context, dir *os.File, item, o Record) error {
	assetID, sourceID := str(item["asset_id"]), str(item["source_id"])
	changed := failure(409, "source_changed", "来源图片或标注已变化", Record{"asset_id": assetID})
	unlock, e := s.lockSource(ctx, sourceID)
	if e != nil {
		return e
	}
	defer unlock()
	asset, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_assets WHERE id=?", assetID)
	if e != nil {
		return e
	}
	if asset == nil || str(asset["source_id"]) != sourceID || str(asset["lifecycle_state"]) != "active" || str(asset["relative_path"]) != str(item["source_relative_path"]) || num(asset["content_version"]) != num(item["expected_content_version"]) || num(asset["txt_version"]) != num(item["expected_txt_version"]) {
		return changed
	}
	input, e := s.openSource(ctx, sourceID, str(item["source_relative_path"]))
	if e != nil {
		if errorCode(e) == "source_offline" {
			return e
		}
		return changed
	}
	defer input.Close()
	before, e := input.Stat()
	if e != nil {
		return e
	}
	if before.Size() != num(item["image_size_bytes"]) {
		return changed
	}
	output, e := createOutput(dir, str(item["output_relative_path"]))
	if e != nil {
		return targetError(e)
	}
	digest := sha256.New()
	copied, copyErr := copyContext(ctx, io.MultiWriter(output, digest), input)
	if copyErr == nil {
		copyErr = output.Sync()
	}
	if copyErr == nil {
		copyErr = verifyOutput(dir, str(item["output_relative_path"]), output)
	}
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	after, e := input.Stat()
	if e != nil {
		return e
	}
	sum := hex.EncodeToString(digest.Sum(nil))
	if copied != num(item["image_size_bytes"]) || after.Size() != before.Size() || after.ModTime() != before.ModTime() || str(item["image_sha256"]) != "" && str(item["image_sha256"]) != sum {
		return changed
	}
	if name := str(item["txt_output_relative_path"]); name != "" {
		text := ""
		if rel := str(item["txt_source_relative_path"]); rel != "" {
			text, e = s.readCaption(ctx, sourceID, rel)
			if e != nil {
				return changed
			}
		}
		data := []byte(transform(text, o))
		if hashBytes(data) != str(item["txt_sha256"]) {
			return changed
		}
		f, e := createOutput(dir, name)
		if e != nil {
			return targetError(e)
		}
		_, e = f.Write(data)
		if e == nil {
			e = f.Sync()
		}
		if e == nil {
			e = verifyOutput(dir, name, f)
		}
		closeErr := f.Close()
		if e != nil {
			return e
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if e = dir.Sync(); e != nil {
		return e
	}
	// The pair is durable before its per-file log becomes staged. An interrupted
	// pending pair is removed and recopied; completed pairs are never recopied.
	return s.exec(ctx, "UPDATE dataset_export_items SET copy_state='staged',image_sha256=?,committed_at=? WHERE job_id=? AND asset_id=?", sum, now(), item["job_id"], assetID)
}
func (s *Service) removeStaging(ctx context.Context, id string) error {
	r, e := s.exportRow(ctx, id)
	if e != nil {
		return e
	}
	owned, exists, e := s.stagingIdentity(ctx, id)
	if e != nil || !exists {
		return e
	}
	target, e := openDirectory(str(r["target_path"]))
	if e != nil {
		return e
	}
	defer target.Close()
	expected, e := readIdentity(object(r["options_json"])["target_identity"])
	if e != nil {
		return e
	}
	actual, e := identity(target)
	if e != nil {
		return e
	}
	if actual != expected {
		return failure(409, "target_root_changed", "导出目录已变化")
	}
	_, e = identityAt(target, StagingName(id))
	if errors.Is(e, unix.ENOENT) {
		return nil
	}
	if e != nil {
		return e
	}
	return removeOwned(target, StagingName(id), owned)
}
