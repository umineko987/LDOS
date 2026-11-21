package captions

import (
	"context"
	"database/sql"
)

type captionOwner struct {
	id     string
	source bool
}

func ownerOfBatch(batch Row) captionOwner {
	if batch["source_id"] != nil {
		return captionOwner{id: Text(batch["source_id"]), source: true}
	}
	return captionOwner{id: Text(batch["dataset_id"])}
}

func (o captionOwner) field() string {
	if o.source {
		return "source_id"
	}
	return "dataset_id"
}

func (o captionOwner) project(r Row) Row {
	if o.source {
		r["dataset_id"] = nil
	}
	r[o.field()] = o.id
	return r
}

func (o captionOwner) batchIDs() (dataset, source any) {
	if o.source {
		return nil, o.id
	}
	return o.id, nil
}

// Use the catalog's source lock for the entire source operation. The shared
// context allows annotation callbacks to reuse it and prevents membership from
// changing between selection and the sidecar write.
func withCaptionOwner[T any](ctx context.Context, s *Service, owner captionOwner, fn func(context.Context) (T, error)) (result T, err error) {
	if !owner.source {
		unlock := s.lock(owner.id)
		defer unlock()
		return fn(ctx)
	}
	err = s.deps.WithSources(ctx, []string{owner.id}, func(held context.Context) error {
		var e error
		result, e = fn(held)
		return e
	})
	return
}

func (s *Service) selectForOwner(ctx context.Context, owner captionOwner, ids []string) (string, []string, error) {
	if owner.source {
		if e := s.ensureSource(ctx, owner.id); e != nil {
			return "", nil, e
		}
		selected, e := s.selectSourceIDs(ctx, owner, ids)
		return "", selected, e
	}
	d, e := s.dataset(ctx, owner.id)
	if e != nil {
		return "", nil, e
	}
	selected, e := s.selectDatasetIDs(ctx, owner.id, ids)
	return Text(d["trigger_word"]), selected, e
}
func (s *Service) ensureSource(ctx context.Context, id string) error {
	r, e := s.deps.Store.QueryRow(ctx, "SELECT id FROM gallery_sources WHERE id=?", id)
	if e == nil && r == nil {
		e = Fail(404, "source_not_found", "图库来源不存在")
	}
	return e
}

const sourceAssetWhere = "a.source_id=? AND a.lifecycle_state='active' AND a.dedup_visibility!='excluded'"

func (s *Service) sourceMembers(ctx context.Context, id, directory string) ([]Row, error) {
	if e := s.ensureSource(ctx, id); e != nil {
		return nil, e
	}
	const listing = "SELECT a.id AS asset_id,a.name FROM gallery_assets a WHERE " + sourceAssetWhere
	const order = " ORDER BY a.sort_key,a.name,a.id"
	if directory == "" {
		return s.deps.Store.QueryRows(ctx, listing+order, id)
	}
	d, e := s.deps.Store.QueryRow(ctx, "SELECT source_id FROM gallery_directories WHERE id=? AND lifecycle_state='active'", directory)
	if e != nil {
		return nil, e
	}
	if d == nil {
		return nil, Fail(404, "directory_not_found", "图库目录不存在")
	}
	if Text(d["source_id"]) != id {
		return nil, Fail(409, "source_mismatch", "图库目录不属于此来源")
	}
	return s.deps.Store.QueryRows(ctx, `WITH RECURSIVE dirs(id) AS (
		SELECT ? UNION ALL SELECT d.id FROM gallery_directories d JOIN dirs ON d.parent_id=dirs.id
		WHERE d.source_id=? AND d.lifecycle_state='active'
	)`+listing+" AND a.directory_id IN (SELECT id FROM dirs)"+order, directory, id, id)
}

func (s *Service) eligibleIDs(ctx context.Context, owner captionOwner, ids []string) ([]string, error) {
	if !owner.source || len(ids) == 0 {
		return ids, nil
	}
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT a.id FROM gallery_assets a WHERE "+sourceAssetWhere+" AND a.id IN (SELECT value FROM json_each(?))", owner.id, encode(ids))
	if e != nil {
		return nil, e
	}
	present := make(map[string]bool, len(rows))
	for _, r := range rows {
		present[Text(r["id"])] = true
	}
	out := make([]string, 0, len(rows))
	for _, id := range ids {
		if present[id] {
			out = append(out, id)
		}
	}
	return out, nil
}

const notInSource = "caption_asset_not_in_source"

func (s *Service) selectSourceIDs(ctx context.Context, owner captionOwner, ids []string) ([]string, error) {
	ids = Dedupe(ids)
	eligible, e := s.eligibleIDs(ctx, owner, ids)
	if e != nil {
		return nil, e
	}
	if len(eligible) == len(ids) {
		return eligible, nil
	}
	present := make(map[string]bool, len(eligible))
	for _, id := range eligible {
		present[id] = true
	}
	missing := []string{}
	for _, id := range ids {
		if !present[id] {
			missing = append(missing, id)
			if len(missing) == 20 {
				break
			}
		}
	}
	return nil, &Error{422, notInSource, "有图片不在此图库来源中或当前不可见", Row{"source_id": owner.id, "asset_ids": missing}}
}

func (s *Service) kept(ctx context.Context, sourceID string) ([]string, error) {
	if e := s.ensureSource(ctx, sourceID); e != nil {
		return nil, e
	}
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT a.id FROM gallery_assets a JOIN gallery_asset_keeps k ON k.asset_id=a.id WHERE "+sourceAssetWhere+" ORDER BY a.id", sourceID)
	if e != nil {
		return nil, e
	}
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, Text(r["id"]))
	}
	return ids, nil
}

func (s *Service) setKept(ctx context.Context, sourceID string, ids []string, kept bool) (int64, error) {
	if e := ValidateIDs(ids, 1, 50000); e != nil {
		return 0, e
	}
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return 0, e
	}
	defer done()
	owner := captionOwner{id: sourceID, source: true}
	return withCaptionOwner(ctx, s, owner, func(ctx context.Context) (int64, error) {
		if e := s.ensureSource(ctx, sourceID); e != nil {
			return 0, e
		}
		ids, e := s.selectSourceIDs(ctx, owner, ids)
		if e != nil {
			return 0, e
		}
		q := "DELETE FROM gallery_asset_keeps WHERE asset_id IN (SELECT value FROM json_each(?))"
		if kept {
			q = "INSERT OR IGNORE INTO gallery_asset_keeps(asset_id) SELECT value FROM json_each(?)"
		}
		var n int64
		e = s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
			r, e := tx.ExecContext(ctx, q, encode(ids))
			if e != nil {
				return e
			}
			n, e = r.RowsAffected()
			return e
		})
		return n, e
	})
}
