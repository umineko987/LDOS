package reviews

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"ldos/backend/internal/store"
)

func (s *Service) get(ctx context.Context, i identity) (Row, error) {
	var r Row
	e := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error { var err error; r, err = getTx(ctx, tx, i); return err })
	return r, e
}
func getTx(ctx context.Context, tx *sql.Tx, i identity) (Row, error) {
	r, g, im, c := i.tables()
	row, e := store.QueryRowTx(ctx, tx, "SELECT * FROM "+r+" WHERE "+c+"=?", i.id)
	if e != nil {
		return nil, e
	}
	if row == nil {
		return nil, missing()
	}
	counts, e := store.QueryRowTx(ctx, tx, "SELECT COALESCE(SUM(selected=1),0) AS selected_image_count,COALESCE(SUM(disposition='kept'),0) AS kept_image_count,COALESCE(SUM(disposition='rejected'),0) AS rejected_image_count,COALESCE(SUM(disposition='failed'),0) AS failed_image_count FROM "+im+" WHERE "+c+"=?", i.id)
	if e != nil {
		return nil, e
	}
	for k, v := range counts {
		row[k] = v
	}
	decided, e := store.QueryRowTx(ctx, tx, "SELECT COUNT(*) AS n FROM "+g+" WHERE "+c+"=? AND decided=1 AND kind NOT LIKE 'auto_%'", i.id)
	if e != nil {
		return nil, e
	}
	row["decided_group_count"] = decided["n"]
	if i.gallery {
		var selection []Selection
		_ = decodeJSON(text(row["selection_json"]), &selection)
		if selection == nil {
			selection = []Selection{}
		}
		row["directories"] = selection
		var cfg *FilterConfig
		_ = decodeJSON(text(row["filter_config_json"]), &cfg)
		row["filter_config"] = cfg
		for _, k := range []string{"selection_json", "snapshot_json", "filter_config_json", "reference_snapshot_json"} {
			delete(row, k)
		}
		filtered, e := store.QueryRowTx(ctx, tx, "SELECT COUNT(*) AS n FROM "+im+" i JOIN "+g+" g ON i.review_id=g.review_id AND i.group_id=g.id WHERE i.review_id=? AND g.kind='auto_filtered'", i.id)
		if e != nil {
			return nil, e
		}
		row["filtered_image_count"] = filtered["n"]
		legacy, e := legacyTx(ctx, tx, i.id)
		if e != nil {
			return nil, e
		}
		if legacy {
			row["status"] = "failed"
			row["error"] = "旧版审核快照需要显式重试以验证当前来源"
			row["legacy_snapshot"] = true
		}
	}
	return row, nil
}
func legacyTx(ctx context.Context, tx *sql.Tx, id string) (bool, error) {
	r, e := store.QueryRowTx(ctx, tx, "SELECT value FROM meta WHERE key=?", "legacy_gallery_review:"+id)
	return r != nil, e
}
func ensureModern(ctx context.Context, tx *sql.Tx, i identity) error {
	if !i.gallery {
		return nil
	}
	legacy, e := legacyTx(ctx, tx, i.id)
	if e != nil {
		return e
	}
	if legacy {
		return conflict("旧版审核快照需要显式重试")
	}
	return nil
}
func (s *Service) GetGallery(ctx context.Context, id string) (Row, error) {
	return s.get(ctx, identity{id, true})
}
func (s *Service) GetCrawl(ctx context.Context, id string) (Row, error) {
	b, e := s.deps.Store.QueryRow(ctx, "SELECT status FROM crawl_batches WHERE id=?", id)
	if e != nil {
		return nil, e
	}
	if b == nil {
		return nil, failure(404, "crawl_not_found", "爬取批次不存在")
	}
	if !terminal(text(b["status"])) {
		return nil, failure(409, "crawl_not_finished", "爬取批次结束后才会进入图片审核")
	}
	r, e := s.get(ctx, identity{id, false})
	if err, ok := e.(*Error); ok && err.Status == 404 {
		status := "disabled"
		if s.enabled.Load() {
			status = "not_started"
		}
		return Row{"batch_id": id, "status": status}, nil
	}
	return r, e
}
func (s *Service) StartCrawl(ctx context.Context, id string) (Row, error) {
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	s.op.Lock()
	defer s.op.Unlock()
	if !s.enabled.Load() {
		return nil, failure(409, "dedup_disabled", "去重功能未启用")
	}
	e = s.write(ctx, func(tx *sql.Tx) error {
		b, e := store.QueryRowTx(ctx, tx, "SELECT status FROM crawl_batches WHERE id=?", id)
		if e != nil {
			return e
		}
		if b == nil {
			return failure(404, "crawl_not_found", "爬取批次不存在")
		}
		if !terminal(text(b["status"])) {
			return conflict("爬取批次结束后才能启动去重分析")
		}
		_, e = tx.ExecContext(ctx, "INSERT INTO crawl_reviews(batch_id,status,created_at,updated_at) VALUES (?,'pending',?,?) ON CONFLICT(batch_id) DO UPDATE SET status='pending',updated_at=excluded.updated_at,error='' WHERE crawl_reviews.status='waiting_for_crawl'", id, now(), now())
		return e
	})
	if e != nil {
		return nil, e
	}
	s.Notify()
	return s.get(ctx, identity{id, false})
}
func (s *Service) CreateGallery(ctx context.Context, dirs, assets []string, cfg *FilterConfig) (Row, error) {
	return s.createGallery(ctx, dirs, assets, cfg, 200)
}

// CreateDataset reviews the full stage input; the interactive gallery API stays bounded.
func (s *Service) CreateDataset(ctx context.Context, assets []string, cfg *FilterConfig) (Row, error) {
	return s.createGallery(ctx, nil, assets, cfg, max(200, len(assets)))
}

func (s *Service) createGallery(ctx context.Context, dirs, assets []string, cfg *FilterConfig, assetLimit int) (Row, error) {
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	s.op.Lock()
	defer s.op.Unlock()
	if !s.enabled.Load() {
		return nil, failure(409, "dedup_disabled", "去重功能未启用")
	}
	if e = validateIDs(dirs, 200, false); e != nil {
		return nil, e
	}
	if e = validateIDs(assets, assetLimit, false); e != nil {
		return nil, e
	}
	cfg, e = cloneConfig(cfg)
	if e != nil {
		return nil, e
	}
	refs, e := s.prepareReferences(ctx, cfg)
	if e != nil {
		return nil, e
	}
	selection, snapshots, e := s.selectAssets(ctx, dirs, assets)
	if e != nil {
		return nil, e
	}
	id := uuid.NewString()
	var configJSON any
	if cfg != nil {
		configJSON = encode(cfg)
	}
	e = s.write(ctx, func(tx *sql.Tx) error {
		_, e := tx.ExecContext(ctx, "INSERT INTO gallery_reviews(review_id,status,selection_json,snapshot_json,total_image_count,created_at,updated_at,filter_config_json,reference_snapshot_json) VALUES (?,'pending',?,?,?,?,?,?,?)", id, encode(selection), encode(snapshots), len(snapshots), now(), now(), configJSON, encode(refs))
		return e
	})
	if e != nil {
		return nil, e
	}
	s.Notify()
	return s.get(ctx, identity{id, true})
}
func (s *Service) Snapshot(ctx context.Context, id string) ([]Snapshot, error) {
	v, e := s.workerInput(ctx, id)
	return v.Images, e
}
func (s *Service) workerInput(ctx context.Context, id string) (WorkerInput, error) {
	r, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_reviews WHERE review_id=?", id)
	if e != nil {
		return WorkerInput{}, e
	}
	if r == nil {
		return WorkerInput{}, missing()
	}
	return inputRow(r)
}
func (s *Service) RetryCrawl(ctx context.Context, id string) (Row, error) {
	return s.retry(ctx, identity{id, false})
}
func (s *Service) RetryGallery(ctx context.Context, id string) (Row, error) {
	return s.retry(ctx, identity{id, true})
}
func (s *Service) retry(ctx context.Context, i identity) (Row, error) {
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	s.op.Lock()
	defer s.op.Unlock()
	r, _, _, c := i.tables()
	old, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM "+r+" WHERE "+c+"=?", i.id)
	if e != nil {
		return nil, e
	}
	if old == nil {
		return nil, missing()
	}
	legacy := false
	var selection []Selection
	var snapshots, refs []Snapshot
	if i.gallery {
		marker, e := s.deps.Store.QueryRow(ctx, "SELECT value FROM meta WHERE key=?", "legacy_gallery_review:"+i.id)
		if e != nil {
			return nil, e
		}
		legacy = marker != nil
	}
	if !legacy && text(old["status"]) != "failed" {
		return nil, conflict("当前审核分析状态不允许重试")
	}
	if legacy {
		if e = decodeJSON(text(old["selection_json"]), &selection); e != nil {
			return nil, conflict("旧版审核选区无效")
		}
		var previous []Snapshot
		if e = decodeJSON(text(old["snapshot_json"]), &previous); e != nil {
			return nil, conflict("旧版审核快照无效")
		}
		dirs, assets := []string{}, []string{}
		for _, d := range selection {
			if d.DirectoryID != "" {
				dirs = append(dirs, d.DirectoryID)
			}
		}
		for _, a := range previous {
			if a.AssetID != "" {
				assets = append(assets, a.AssetID)
			}
		}
		selection, snapshots, e = s.selectAssets(ctx, dirs, assets)
		if e != nil {
			return nil, e
		}
		var cfg *FilterConfig
		if raw := text(old["filter_config_json"]); raw != "" {
			if e = decodeJSON(raw, &cfg); e != nil {
				return nil, e
			}
		}
		refs, e = s.prepareReferences(ctx, cfg)
		if e != nil {
			return nil, e
		}
	}
	e = s.write(ctx, func(tx *sql.Tx) error {
		if legacy {
			_, err := tx.ExecContext(ctx, "UPDATE gallery_reviews SET snapshot_json=?,selection_json=?,reference_snapshot_json=? WHERE review_id=?", encode(snapshots), encode(selection), encode(refs), i.id)
			if err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, "DELETE FROM meta WHERE key=?", "legacy_gallery_review:"+i.id); err != nil {
				return err
			}
		}
		// Preserve legacy decisions until replacement; ordinary retry resets the prior analysis.
		if !legacy {
			_, groups, _, _ := i.tables()
			if _, err := tx.ExecContext(ctx, "DELETE FROM "+groups+" WHERE "+c+"=?", i.id); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "UPDATE "+r+" SET total_image_count=0,total_group_count=0,duplicate_group_count=0,unreadable_image_count=0,automatic_group_count=0,automatic_rejected_image_count=0,kept_image_count=0,rejected_image_count=0,failed_image_count=0 WHERE "+c+"=?", i.id); err != nil {
				return err
			}
		}
		bump := ""
		if i.gallery {
			bump = ",version=version+1"
		}
		_, err := tx.ExecContext(ctx, "UPDATE "+r+" SET status='pending',error='',updated_at=?,started_at=NULL,ready_at=NULL,applied_at=NULL"+bump+" WHERE "+c+"=?", now(), i.id)
		return err
	})
	if e != nil {
		return nil, e
	}
	s.Notify()
	return s.get(ctx, i)
}
func validateQuery(q GroupQuery) (GroupQuery, error) {
	if q.Limit == 0 {
		q.Limit = 12
	}
	if q.Limit < 1 || q.Limit > 50 || q.Offset < 0 {
		return q, invalid("分页参数无效")
	}
	if q.Kind != "" && q.Kind != "duplicate" && q.Kind != "single" && q.Kind != "unreadable" {
		return q, invalid("审核组类型无效")
	}
	if q.Classification != "" && q.Classification != "rough" && q.Classification != "monochrome" {
		return q, invalid("辅助分类无效")
	}
	return q, nil
}
func (s *Service) GalleryGroups(ctx context.Context, id string, q GroupQuery) (Page, error) {
	return s.groups(ctx, identity{id, true}, q)
}
func (s *Service) CrawlGroups(ctx context.Context, id string, q GroupQuery) (Page, error) {
	return s.groups(ctx, identity{id, false}, q)
}
func (s *Service) groups(ctx context.Context, i identity, q GroupQuery) (Page, error) {
	var p Page
	var e error
	q, e = validateQuery(q)
	if e != nil {
		return p, e
	}
	e = s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error { var err error; p, err = groupsTx(ctx, tx, i, q); return err })
	return p, e
}
func groupsTx(ctx context.Context, tx *sql.Tx, i identity, q GroupQuery) (Page, error) {
	_, g, im, c := i.tables()
	p := Page{Items: []Row{}, Limit: q.Limit, Offset: q.Offset}
	where := c + "=?"
	args := []any{i.id}
	if !q.IncludeAutomatic {
		where += " AND kind NOT LIKE 'auto_%'"
	}
	if q.Kind != "" {
		where += " AND kind=?"
		args = append(args, q.Kind)
	}
	if q.Classification != "" {
		where += " AND EXISTS(SELECT 1 FROM " + im + " i WHERE i." + c + "=" + g + "." + c + " AND i.group_id=" + g + ".id AND json_extract(i.metadata_json,'$.classification')=?)"
		args = append(args, q.Classification)
	}
	count, e := store.QueryRowTx(ctx, tx, "SELECT COUNT(*) AS n FROM "+g+" WHERE "+where, args...)
	if e != nil {
		return p, e
	}
	p.Total = int(number(count["n"]))
	if q.All {
		if p.Total > MaxGroups {
			return p, failure(413, "review_groups_too_large", "全量审核组超过 10000 组上限")
		}
		p.Limit = MaxGroups
		p.Offset = 0
	}
	rows, e := store.QueryRowsTx(ctx, tx, "SELECT * FROM "+g+" WHERE "+where+" ORDER BY ordinal LIMIT ? OFFSET ?", append(args, p.Limit, p.Offset)...)
	if e != nil {
		return p, e
	}
	for _, row := range rows {
		row["decided"] = truth(row["decided"])
		var levels []any
		_ = decodeJSON(text(row["match_levels_json"]), &levels)
		if levels == nil {
			levels = []any{}
		}
		delete(row, "match_levels_json")
		row["match_levels"] = levels
		images, e := store.QueryRowsTx(ctx, tx, "SELECT * FROM "+im+" WHERE "+c+"=? AND group_id=? ORDER BY ordinal", i.id, row["id"])
		if e != nil {
			return p, e
		}
		selected := 0
		for _, im := range images {
			projectImage(im)
			if truth(im["selected"]) {
				selected++
			}
		}
		row["images"] = images
		row["image_count"] = len(images)
		row["selected_image_count"] = selected
		p.Items = append(p.Items, row)
	}
	if q.All {
		p.Limit = len(p.Items)
	}
	return p, nil
}
func projectImage(row Row) {
	var metadata Row
	_ = decodeJSON(text(row["metadata_json"]), &metadata)
	if metadata == nil {
		metadata = Row{}
	}
	delete(row, "metadata_json")
	row["metadata"] = metadata
	for _, k := range []string{"readable", "recommended", "selected"} {
		row[k] = truth(row[k])
	}
}
func (s *Service) images(ctx context.Context, i identity, group string, automatic bool) ([]Row, error) {
	_, g, im, c := i.tables()
	query := "SELECT i.* FROM " + im + " i"
	where := " WHERE i." + c + "=?"
	args := []any{i.id}
	if automatic {
		query += " JOIN " + g + " g ON i." + c + "=g." + c + " AND i.group_id=g.id"
		where += " AND g.kind LIKE 'auto_%' AND i.selected=0"
	}
	if group != "" {
		where += " AND i.group_id=?"
		args = append(args, group)
	}
	rows, e := s.deps.Store.QueryRows(ctx, query+where+" ORDER BY i.group_id,i.ordinal", args...)
	if e != nil {
		return nil, e
	}
	for _, r := range rows {
		projectImage(r)
	}
	return rows, nil
}
func (s *Service) GalleryImages(ctx context.Context, id string) ([]Row, error) {
	return s.images(ctx, identity{id, true}, "", false)
}
func (s *Service) GalleryGroupImages(ctx context.Context, id, group string) ([]Row, error) {
	return s.images(ctx, identity{id, true}, group, false)
}
func (s *Service) UpdateCrawlDecisions(ctx context.Context, id string, ds []Decision) (Row, error) {
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	s.op.Lock()
	defer s.op.Unlock()
	i := identity{id, false}
	if e = s.decisions(ctx, i, ds, 0, false); e != nil {
		return nil, e
	}
	return s.get(ctx, i)
}
func validateDecisions(ds []Decision, maxImages int) error {
	if len(ds) == 0 || len(ds) > 50 {
		return invalid("groups 必须包含 1..50 组")
	}
	seen := map[string]bool{}
	for _, d := range ds {
		if !validID(d.GroupID) || seen[d.GroupID] {
			return invalid("groups 包含无效或重复组")
		}
		seen[d.GroupID] = true
		if e := validateIDs(d.SelectedImageIDs, maxImages, true); e != nil {
			return e
		}
	}
	return nil
}
func (s *Service) decisions(ctx context.Context, i identity, ds []Decision, version int64, automatic bool) error {
	if e := validateDecisions(ds, 100000); e != nil {
		return e
	}
	return s.write(ctx, func(tx *sql.Tx) error {
		if e := ensureModern(ctx, tx, i); e != nil {
			return e
		}
		r, g, im, c := i.tables()
		review, e := store.QueryRowTx(ctx, tx, "SELECT * FROM "+r+" WHERE "+c+"=?", i.id)
		if e != nil {
			return e
		}
		if review == nil {
			return missing()
		}
		if text(review["status"]) != "ready" {
			return conflict("当前审核状态不允许修改选择")
		}
		if i.gallery && (version < 1 || number(review["version"]) != version) {
			return conflict("审核版本冲突")
		}
		for _, d := range ds {
			group, e := store.QueryRowTx(ctx, tx, "SELECT kind FROM "+g+" WHERE "+c+"=? AND id=?", i.id, d.GroupID)
			if e != nil {
				return e
			}
			if group == nil {
				return missing()
			}
			if strings.HasPrefix(text(group["kind"]), "auto_") && !automatic {
				return conflict("不能修改自动去重组的选择")
			}
			rows, e := store.QueryRowsTx(ctx, tx, "SELECT id FROM "+im+" WHERE "+c+"=? AND group_id=?", i.id, d.GroupID)
			if e != nil {
				return e
			}
			if len(rows) == 0 {
				return missing()
			}
			available := map[string]bool{}
			for _, row := range rows {
				available[text(row["id"])] = true
			}
			for _, id := range d.SelectedImageIDs {
				if !available[id] {
					return conflict("审核决策包含不属于当前组的图片 ID")
				}
			}
			if _, e = tx.ExecContext(ctx, "UPDATE "+im+" SET selected=0,updated_at=? WHERE "+c+"=? AND group_id=?", now(), i.id, d.GroupID); e != nil {
				return e
			}
			for _, id := range d.SelectedImageIDs {
				if _, e = tx.ExecContext(ctx, "UPDATE "+im+" SET selected=1,updated_at=? WHERE "+c+"=? AND group_id=? AND id=?", now(), i.id, d.GroupID, id); e != nil {
					return e
				}
			}
			if _, e = tx.ExecContext(ctx, "UPDATE "+g+" SET decided=1,updated_at=? WHERE "+c+"=? AND id=?", now(), i.id, d.GroupID); e != nil {
				return e
			}
		}
		bump := ""
		if i.gallery {
			bump = ",version=version+1"
		}
		_, e = tx.ExecContext(ctx, "UPDATE "+r+" SET updated_at=?"+bump+" WHERE "+c+"=?", now(), i.id)
		return e
	})
}

// ResetGroupDecided is the final step of triage undo, after AdoptGroup restores files.
func (s *Service) ResetGroupDecided(ctx context.Context, id, group string) error {
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return e
	}
	defer done()
	s.op.Lock()
	defer s.op.Unlock()
	return s.write(ctx, func(tx *sql.Tx) error {
		if e := ensureModern(ctx, tx, identity{id, true}); e != nil {
			return e
		}
		r, e := tx.ExecContext(ctx, "UPDATE gallery_review_groups SET decided=0,updated_at=? WHERE review_id=? AND id=? AND EXISTS(SELECT 1 FROM gallery_reviews WHERE review_id=? AND status='ready')", now(), id, group, id)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return conflict("审核组不存在或当前状态不允许撤销")
		}
		_, e = tx.ExecContext(ctx, "UPDATE gallery_reviews SET version=version+1,updated_at=? WHERE review_id=?", now(), id)
		return e
	})
}
func (s *Service) FinishGallery(ctx context.Context, id string) error {
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return e
	}
	defer done()
	s.op.Lock()
	var finished <-chan struct{}
	s.mu.Lock()
	if s.current == (identity{id, true}) && s.currentCancel != nil {
		s.currentCancel()
		finished = s.currentDone
	}
	s.mu.Unlock()
	e = s.write(ctx, func(tx *sql.Tx) error {
		r, e := tx.ExecContext(ctx, "DELETE FROM gallery_reviews WHERE review_id=?", id)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return missing()
		}
		_, e = tx.ExecContext(ctx, "DELETE FROM meta WHERE key=?", "legacy_gallery_review:"+id)
		return e
	})
	s.op.Unlock()
	if finished != nil {
		select {
		case <-finished:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if e == nil {
		s.Notify()
	}
	return e
}
func (s *Service) finishImage(ctx context.Context, i identity, image Row, disposition, path string, err error) error {
	_, _, im, c := i.tables()
	message := ""
	if err != nil {
		message = safeError(err)
	}
	return s.write(ctx, func(tx *sql.Tx) error {
		if e := ensureModern(ctx, tx, i); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, "UPDATE "+im+" SET disposition=?,final_relative_path=?,error=?,updated_at=? WHERE "+c+"=? AND id=?", disposition, path, clip(message, 2000), now(), i.id, image["id"])
		return e
	})
}
func (s *Service) finishCounts(ctx context.Context, i identity, automatic, applied bool) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		if e := ensureModern(ctx, tx, i); e != nil {
			return e
		}
		r, _, im, c := i.tables()
		counts, e := store.QueryRowTx(ctx, tx, "SELECT COALESCE(SUM(disposition='kept'),0) kept,COALESCE(SUM(disposition='rejected'),0) rejected,COALESCE(SUM(disposition='failed'),0) failed,COALESCE(SUM(disposition NOT IN ('kept','rejected')),0) unfinished FROM "+im+" WHERE "+c+"=?", i.id)
		if e != nil {
			return e
		}
		status := "ready"
		failed := number(counts["failed"])
		var at any
		if applied {
			failed = number(counts["unfinished"])
			status = "applied"
			at = now()
			if failed > 0 {
				status = "apply_failed"
				at = nil
			}
		}
		message := ""
		if failed > 0 {
			message = fmt.Sprintf("%d 张图片处理失败", failed)
		}
		bump := ""
		if i.gallery {
			bump = ",version=version+1"
		}
		_, e = tx.ExecContext(ctx, "UPDATE "+r+" SET status=?,kept_image_count=?,rejected_image_count=?,failed_image_count=?,error=?,updated_at=?,ready_at=COALESCE(ready_at,?),applied_at=?"+bump+" WHERE "+c+"=?", status, counts["kept"], counts["rejected"], failed, message, now(), now(), at, i.id)
		return e
	})
}
func decodeJSON(raw string, dst any) error {
	d := json.NewDecoder(strings.NewReader(raw))
	d.UseNumber()
	return d.Decode(dst)
}
