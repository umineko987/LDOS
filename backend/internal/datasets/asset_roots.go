package datasets

import (
	"context"
	"database/sql"
	"strings"

	"github.com/google/uuid"
	"ldos/backend/internal/store"
)

// AttachAssets adds only the selected library files, without changing their source.
func (s *Service) AttachAssets(ctx context.Context, datasetID string, assetIDs []string) (int, error) {
	if len(assetIDs) == 0 || len(assetIDs) > 1000 {
		return 0, validation()
	}
	ids := unique(assetIDs)
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	added := 0
	e := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if e := requireTx(ctx, tx, datasetID); e != nil {
			return e
		}
		assets, e := store.QueryRowsTx(ctx, tx, `SELECT a.source_id,a.relative_path,a.lifecycle_state,a.dedup_visibility,s.availability AS source_availability FROM gallery_assets a JOIN gallery_sources s ON s.id=a.source_id WHERE a.id IN (`+strings.TrimRight(strings.Repeat("?,", len(ids)), ",")+`)`, args...)
		if e != nil {
			return e
		}
		if len(assets) != len(ids) {
			return failure(404, "gallery_asset_not_found", "图库图片不存在")
		}
		for _, a := range assets {
			if !live(a) {
				return failure(409, "gallery_asset_unavailable", "图库图片不可用")
			}
			if str(a["source_availability"]) != "available" {
				return failure(409, "source_offline", "图库来源离线", Record{"source_id": a["source_id"]})
			}
			relative := str(a["relative_path"])
			if !safeRelative(relative) {
				return failure(422, "dataset_root_path_invalid", "根目录路径不安全")
			}
			if excludedPath(relative) {
				return failure(422, "dataset_root_path_excluded", "回收区、keep、duplicates 等目录不能作为数据集根目录")
			}
		}
		t := now()
		for _, a := range assets {
			source, relative := str(a["source_id"]), str(a["relative_path"])
			r, e := tx.ExecContext(ctx, `INSERT INTO dataset_roots(id,dataset_id,source_id,directory_id,relative_path,origin,created_at) SELECT ?,?,?,?,?,'library',? WHERE NOT EXISTS(SELECT 1 FROM dataset_roots r WHERE r.dataset_id=? AND r.source_id=? AND (r.relative_path='' OR r.relative_path=? OR substr(?,1,length(r.relative_path)+1)=r.relative_path||'/'))`, uuid.NewString(), datasetID, source, DirectoryID(source, relative), relative, t, datasetID, source, relative, relative)
			if e != nil {
				return e
			}
			n, e := r.RowsAffected()
			if e != nil {
				return e
			}
			added += int(n)
		}
		if added == 0 {
			return nil
		}
		return touch(ctx, tx, datasetID)
	})
	if e != nil {
		return 0, e
	}
	if added > 0 {
		if _, e = s.EnqueueHashing(ctx, datasetID); e != nil {
			return added, e
		}
		s.PublishUpdated(datasetID, "roots")
	}
	return added, nil
}
