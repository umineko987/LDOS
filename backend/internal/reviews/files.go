package reviews

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"golang.org/x/sys/unix"
	"ldos/backend/internal/store"
)

func TrashOperationID(reviewID, imageID string, attempt int) string {
	suffix := ""
	if attempt > 0 {
		suffix = fmt.Sprintf(":%d", attempt)
	}
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("ldos:review:"+reviewID+":"+imageID+suffix)).String()
}

// AdoptGroup applies immediately and may be repeated to restore/reject images.
// allowAutomatic is reserved for dataset triage, including triage undo.
func (s *Service) AdoptGroup(ctx context.Context, id, group string, selected []string, version int64, allowAutomatic bool) (Row, error) {
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	s.op.Lock()
	defer s.op.Unlock()
	if s.deps.Gallery.TrashAsset == nil || s.deps.Gallery.RestoreTrash == nil {
		return nil, conflict("图库文件操作未配置")
	}
	i := identity{id, true}
	if e = s.decisions(ctx, i, []Decision{{GroupID: group, SelectedImageIDs: selected}}, version, allowAutomatic); e != nil {
		return nil, e
	}
	images, e := s.images(ctx, i, group, false)
	if e != nil {
		return nil, e
	}
	if e = s.processGallery(ctx, i, images, false); e != nil {
		return nil, e
	}
	if e = s.finishCounts(ctx, i, false, false); e != nil {
		return nil, e
	}
	return s.get(ctx, i)
}
func (s *Service) currentTrash(ctx context.Context, id, image string, asset Row) (string, error) {
	if text(asset["lifecycle_state"]) != "trashed" {
		return "", nil
	}
	row, e := s.deps.Store.QueryRow(ctx, "SELECT o.id FROM gallery_file_operations o JOIN gallery_file_operation_items i ON i.operation_id=o.id WHERE o.kind='trash' AND o.status='committed' AND i.asset_id=? ORDER BY o.created_at DESC LIMIT 1", image)
	if e != nil {
		return "", e
	}
	if row != nil {
		for attempt := 0; attempt < 64; attempt++ {
			if text(row["id"]) == TrashOperationID(id, image, attempt) {
				return text(row["id"]), nil
			}
		}
	}
	return "", conflict("review_operation_conflict")
}
func (s *Service) settleImage(ctx context.Context, i identity, image Row, v Snapshot) (string, string, error) {
	asset, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_assets WHERE id=?", v.AssetID)
	if e != nil {
		return "", "", e
	}
	if asset == nil {
		return "", "", conflict("review_asset_missing")
	}
	operation, e := s.currentTrash(ctx, i.id, v.AssetID, asset)
	if e != nil {
		return "", "", e
	}
	r, e := openRoot(v.RootPath)
	if e != nil {
		return "", "", e
	}
	_, e = s.validateSnapshot(ctx, v, r, operation)
	r.close()
	if e != nil {
		return "", "", e
	}
	if e = ctx.Err(); e != nil {
		return "", "", e
	}
	if truth(image["selected"]) {
		if operation != "" {
			if e = s.deps.Gallery.RestoreTrash(ctx, operation); e != nil {
				return "", "", e
			}
			if e = ctx.Err(); e != nil {
				return "", "", e
			}
			current, e := s.deps.Store.QueryRow(ctx, "SELECT content_version,txt_version FROM gallery_assets WHERE id=?", v.AssetID)
			if e != nil {
				return "", "", e
			}
			if current == nil {
				return "", "", conflict("review_asset_missing")
			}
			if e = s.refreshSnapshot(ctx, i.id, v.AssetID, number(current["content_version"]), number(current["txt_version"])); e != nil {
				return "", "", e
			}
		}
		return "kept", v.RelativePath, nil
	}
	if operation != "" {
		return "rejected", ".ldos/trash/" + operation + "/files/" + v.RelativePath, nil
	}
	for attempt := 0; attempt < 64; attempt++ {
		candidate := TrashOperationID(i.id, v.AssetID, attempt)
		row, e := s.deps.Store.QueryRow(ctx, "SELECT status FROM gallery_file_operations WHERE id=?", candidate)
		if e != nil {
			return "", "", e
		}
		if row == nil || text(row["status"]) == "rolled_back" {
			if e = ctx.Err(); e != nil {
				return "", "", e
			}
			if e = s.deps.Gallery.TrashAsset(ctx, v.AssetID, candidate, v); e != nil {
				return "", "", e
			}
			return "rejected", ".ldos/trash/" + candidate + "/files/" + v.RelativePath, nil
		}
		if text(row["status"]) == "committed" {
			continue
		}
		return "", "", conflict("review_operation_conflict")
	}
	return "", "", conflict("review_operation_slots_exhausted")
}
func (s *Service) refreshSnapshot(ctx context.Context, id, asset string, content, txt int64) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		row, e := store.QueryRowTx(ctx, tx, "SELECT snapshot_json FROM gallery_reviews WHERE review_id=?", id)
		if e != nil {
			return e
		}
		if row == nil {
			return missing()
		}
		var images []Snapshot
		if e = decodeJSON(text(row["snapshot_json"]), &images); e != nil {
			return e
		}
		for n := range images {
			if images[n].AssetID == asset {
				images[n].ContentVersion = content
				images[n].TXTVersion = txt
			}
		}
		_, e = tx.ExecContext(ctx, "UPDATE gallery_reviews SET snapshot_json=? WHERE review_id=?", encode(images), id)
		return e
	})
}
func (s *Service) processGallery(ctx context.Context, i identity, images []Row, automatic bool) error {
	if s.deps.Gallery.TrashAsset == nil || s.deps.Gallery.RestoreTrash == nil {
		return conflict("图库文件操作未配置")
	}
	input, e := s.workerInput(ctx, i.id)
	if e != nil {
		return e
	}
	snapshots := map[string]Snapshot{}
	sources := []string{}
	for _, v := range input.Images {
		snapshots[v.AssetID] = v
		sources = append(sources, v.SourceID)
	}
	return s.hold(ctx, sources, func(ctx context.Context) error {
		// Automatic cleanup validates the whole review before its first physical move.
		if automatic {
			var preflight error
			for _, v := range input.Images {
				asset, err := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_assets WHERE id=?", v.AssetID)
				if err != nil {
					preflight = err
					break
				}
				if asset == nil {
					preflight = conflict("review_asset_missing")
					break
				}
				operation, err := s.currentTrash(ctx, i.id, v.AssetID, asset)
				if err != nil {
					preflight = err
					break
				}
				r, err := openRoot(v.RootPath)
				if err != nil {
					preflight = err
					break
				}
				_, preflight = s.validateSnapshot(ctx, v, r, operation)
				r.close()
				if preflight != nil {
					break
				}
			}
			if preflight != nil {
				for _, image := range images {
					if e = s.finishImage(ctx, i, image, "failed", text(image["final_relative_path"]), preflight); e != nil {
						return e
					}
				}
				return nil
			}
		}
		for _, image := range images {
			if e = ctx.Err(); e != nil {
				return e
			}
			v, ok := snapshots[text(image["id"])]
			if !ok {
				return conflict("review_snapshot_missing")
			}
			disposition, path, err := s.settleImage(ctx, i, image, v)
			if err != nil {
				disposition = "failed"
				path = text(image["final_relative_path"])
			}
			if e = s.finishImage(ctx, i, image, disposition, path, err); e != nil {
				return e
			}
		}
		return nil
	})
}
func (s *Service) applyAutomatic(ctx context.Context, input WorkerInput) error {
	i := input.identity()
	images, e := s.images(ctx, i, "", true)
	if e != nil {
		return e
	}
	if i.gallery {
		e = s.processGallery(ctx, i, images, true)
	} else {
		e = s.processCrawl(ctx, i, input.OutputDir, images)
	}
	if e != nil {
		return e
	}
	if e = s.finishCounts(ctx, i, true, false); e != nil {
		return e
	}
	if !i.gallery {
		// Automatic moves must reach the catalog while manual groups stay ready.
		images, e = s.images(ctx, i, "", false)
		if e != nil {
			return e
		}
		if e = s.journalReconciliation(ctx, i.id, images); e != nil {
			return e
		}
		if s.deps.Gallery.ReconcileCrawl != nil {
			_ = s.deps.Gallery.ReconcileCrawl(ctx, i.id, images)
		}
	}
	return nil
}
func (s *Service) ApplyCrawl(ctx context.Context, id string) (Row, error) {
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	s.op.Lock()
	defer s.op.Unlock()
	i := identity{id, false}
	var output string
	e = s.write(ctx, func(tx *sql.Tx) error {
		batch, e := store.QueryRowTx(ctx, tx, "SELECT status,output_dir FROM crawl_batches WHERE id=?", id)
		if e != nil {
			return e
		}
		if batch == nil {
			return failure(404, "crawl_not_found", "爬取批次不存在")
		}
		if !terminal(text(batch["status"])) {
			return conflict("爬取批次尚未结束")
		}
		output = text(batch["output_dir"])
		row, e := store.QueryRowTx(ctx, tx, "SELECT status FROM crawl_reviews WHERE batch_id=?", id)
		if e != nil {
			return e
		}
		if row == nil {
			return missing()
		}
		status := text(row["status"])
		if status != "ready" && status != "apply_failed" {
			return conflict("当前审核状态不允许应用选择")
		}
		undecided, e := store.QueryRowTx(ctx, tx, "SELECT COUNT(*) n FROM crawl_review_groups WHERE batch_id=? AND decided=0", id)
		if e != nil {
			return e
		}
		if number(undecided["n"]) > 0 {
			return conflict(fmt.Sprintf("还有 %d 个图片组尚未确认", number(undecided["n"])))
		}
		_, e = tx.ExecContext(ctx, "UPDATE crawl_reviews SET status='applying',error='',updated_at=? WHERE batch_id=?", now(), id)
		return e
	})
	if e != nil {
		return nil, e
	}
	images, e := s.images(ctx, i, "", false)
	if e != nil {
		return nil, e
	}
	if e = s.processCrawl(ctx, i, output, images); e != nil {
		return nil, e
	}
	if e = s.finishCounts(ctx, i, false, true); e != nil {
		return nil, e
	}
	images, e = s.images(ctx, i, "", false)
	if e != nil {
		return nil, e
	}
	// Journal visibility reconciliation even when its consumer is temporarily down.
	if e = s.journalReconciliation(ctx, id, images); e != nil {
		return nil, e
	}
	if s.deps.Gallery.ReconcileCrawl != nil {
		_ = s.deps.Gallery.ReconcileCrawl(ctx, id, images)
	}
	return s.get(ctx, i)
}
func (s *Service) journalReconciliation(ctx context.Context, id string, images []Row) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		sources, e := store.QueryRowsTx(ctx, tx, "SELECT id FROM gallery_sources WHERE batch_id=?", id)
		if e != nil {
			return e
		}
		for _, source := range sources {
			event := uuid.NewSHA1(uuid.NameSpaceURL, []byte("ldos:review-reconciliation:"+text(source["id"])+":"+id)).String()
			_, e = tx.ExecContext(ctx, "INSERT INTO gallery_reconciliation_events(id,source_id,batch_id,status,created_at,updated_at) VALUES(?,?,?,'pending',?,?) ON CONFLICT(source_id,batch_id) DO UPDATE SET status='pending',updated_at=excluded.updated_at", event, source["id"], id, now(), now())
			if e != nil {
				return e
			}
			row, e := store.QueryRowTx(ctx, tx, "SELECT id FROM gallery_reconciliation_events WHERE source_id=? AND batch_id=?", source["id"], id)
			if e != nil {
				return e
			}
			event = text(row["id"])
			if _, e = tx.ExecContext(ctx, "DELETE FROM gallery_reconciliation_items WHERE event_id=?", event); e != nil {
				return e
			}
			rules := map[string]string{}
			for _, image := range images {
				relative := text(image["relative_path"])
				switch text(image["disposition"]) {
				case "kept":
					rules[relative] = "kept"
				case "rejected":
					rules[relative] = "excluded_original"
					if final := text(image["final_relative_path"]); final != "" {
						rules[final] = "excluded"
					}
				}
			}
			for path, disposition := range rules {
				if _, e = tx.ExecContext(ctx, "INSERT INTO gallery_reconciliation_items(event_id,relative_path,disposition) VALUES(?,?,?)", event, path, disposition); e != nil {
					return e
				}
			}
		}
		return nil
	})
}
func (s *Service) processCrawl(ctx context.Context, i identity, output string, images []Row) error {
	r, e := openRoot(output)
	if e != nil {
		for _, image := range images {
			if err := s.finishImage(ctx, i, image, "failed", text(image["final_relative_path"]), e); err != nil {
				return err
			}
		}
		return nil
	}
	defer r.close()
	for _, image := range images {
		if e = ctx.Err(); e != nil {
			return e
		}
		path := text(image["relative_path"])
		disposition := "kept"
		var err error
		if truth(image["selected"]) {
			var f *os.File
			f, err = r.open(path)
			if err == nil {
				f.Close()
			}
		} else {
			disposition = "rejected"
			path, err = s.rejectCrawl(ctx, i, image, r)
		}
		if err != nil {
			disposition = "failed"
			path = text(image["final_relative_path"])
		}
		if e = s.finishImage(ctx, i, image, disposition, path, err); e != nil {
			return e
		}
	}
	return nil
}
func captionPath(path string) string { return strings.TrimSuffix(path, filepath.Ext(path)) + ".txt" }
func regularCaption(r *safeRoot, path string) (bool, error) {
	f, e := r.open(path)
	if e == nil {
		f.Close()
		return true, nil
	}
	if errors.Is(e, unix.ENOENT) || errors.Is(e, unix.ELOOP) {
		return false, nil
	}
	return false, e
}
func (s *Service) rejectCrawl(ctx context.Context, i identity, image Row, r *safeRoot) (string, error) {
	source := text(image["relative_path"])
	staged := text(image["final_relative_path"])
	exists, e := r.exists(source)
	if e != nil {
		return "", e
	}
	sourceTXT := captionPath(source)
	if staged != "" {
		present, e := r.exists(staged)
		if e != nil {
			return "", e
		}
		if present && !exists {
			caption, e := regularCaption(r, sourceTXT)
			if e != nil {
				return "", e
			}
			if caption {
				if e = ctx.Err(); e != nil {
					return "", e
				}
				if e = r.move(sourceTXT, captionPath(staged)); e != nil {
					return "", e
				}
			}
			f, e := r.open(staged)
			if e != nil {
				return "", e
			}
			f.Close()
			return staged, nil
		}
	}
	if !exists {
		return "", fmt.Errorf("待淘汰图片不存在: %s", source)
	}
	candidate := staged
	if candidate != "" {
		present, e := r.exists(candidate)
		if e != nil {
			return "", e
		}
		caption, e := r.exists(captionPath(candidate))
		if e != nil {
			return "", e
		}
		if present || caption {
			candidate = ""
		}
	}
	if candidate == "" {
		base := "duplicates/" + source
		for n := 0; ; n++ {
			candidate = base
			if n > 0 {
				ext := filepath.Ext(base)
				candidate = strings.TrimSuffix(base, ext) + fmt.Sprintf("_%d", n) + ext
			}
			present, e := r.exists(candidate)
			if e != nil {
				return "", e
			}
			caption, e := r.exists(captionPath(candidate))
			if e != nil {
				return "", e
			}
			if !present && !caption {
				break
			}
		}
	}
	if e = s.write(ctx, func(tx *sql.Tx) error {
		_, e := tx.ExecContext(ctx, "UPDATE crawl_review_images SET disposition='moving',final_relative_path=?,error='',updated_at=? WHERE batch_id=? AND id=?", candidate, now(), i.id, image["id"])
		return e
	}); e != nil {
		return "", e
	}
	caption, e := regularCaption(r, sourceTXT)
	if e != nil {
		return "", e
	}
	if e = ctx.Err(); e != nil {
		return "", e
	}
	if e = r.move(source, candidate); e != nil {
		return "", e
	}
	if caption {
		if e = ctx.Err(); e != nil {
			return "", e
		}
		if e = r.move(sourceTXT, captionPath(candidate)); e != nil {
			if ctx.Err() == nil {
				_ = r.move(candidate, source)
			}
			return "", e
		}
	}
	return candidate, nil
}
func (s *Service) OpenCrawlImage(ctx context.Context, id, imageID string) (ImageContent, error) {
	row, e := s.deps.Store.QueryRow(ctx, "SELECT i.*,b.output_dir FROM crawl_review_images i JOIN crawl_batches b ON b.id=i.batch_id WHERE i.batch_id=? AND i.id=?", id, imageID)
	if e != nil {
		return ImageContent{}, e
	}
	if row == nil {
		return ImageContent{}, failure(404, "review_image_not_found", "审核图片不存在")
	}
	r, e := openRoot(text(row["output_dir"]))
	if e != nil {
		return ImageContent{}, failure(404, "review_image_not_found", "审核图片文件不存在")
	}
	defer r.close()
	for _, path := range []string{text(row["final_relative_path"]), text(row["relative_path"])} {
		if path == "" {
			continue
		}
		f, e := r.open(path)
		if e != nil {
			continue
		}
		st, e := f.Stat()
		if e != nil {
			f.Close()
			continue
		}
		return ImageContent{ReadSeekCloser: f, Name: filepath.Base(path), Modified: st.ModTime()}, nil
	}
	return ImageContent{}, failure(404, "review_image_not_found", "审核图片文件不存在")
}
func (s *Service) OpenGalleryImage(ctx context.Context, id, imageID string) (ImageContent, error) {
	var result ImageContent
	input, e := s.workerInput(ctx, id)
	if e != nil {
		return result, e
	}
	var snapshot *Snapshot
	for n := range input.Images {
		if input.Images[n].AssetID == imageID {
			snapshot = &input.Images[n]
			break
		}
	}
	if snapshot == nil {
		return result, missing()
	}
	e = s.hold(ctx, []string{snapshot.SourceID}, func(ctx context.Context) error {
		v := *snapshot
		asset, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_assets WHERE id=?", imageID)
		if e != nil {
			return e
		}
		if asset == nil {
			return missing()
		}
		operation, e := s.currentTrash(ctx, id, imageID, asset)
		if e != nil {
			return e
		}
		r, e := openRoot(v.RootPath)
		if e != nil {
			return e
		}
		defer r.close()
		_, e = s.validateSnapshot(ctx, v, r, operation)
		if e != nil {
			return e
		}
		path := v.RelativePath
		if operation != "" {
			path = ".ldos/trash/" + operation + "/files/" + path
		}
		f, e := r.open(path)
		if e != nil {
			return e
		}
		version, e := heldDiskVersion(ctx, f)
		if e != nil || version != v.DiskVersion {
			f.Close()
			if e != nil {
				return e
			}
			return conflict("review_image_changed")
		}
		st, e := f.Stat()
		if e != nil {
			f.Close()
			return e
		}
		result = ImageContent{ReadSeekCloser: f, Name: filepath.Base(v.RelativePath), Modified: st.ModTime()}
		return nil
	})
	return result, e
}
