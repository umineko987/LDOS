package captions

import "context"

const batchColumns = `b.*, (SELECT count(*) FROM caption_batch_items i WHERE i.batch_id=b.id AND i.write_state='written' AND i.before_version!=i.after_version) AS changed_count, (SELECT count(*) FROM caption_batch_items i WHERE i.batch_id=b.id AND i.write_state='written' AND i.before_version!=i.after_version AND i.undo_state IS NULL) AS undoable_count`

func projectBatch(r Row) Row {
	if r == nil {
		return nil
	}
	r["batch_id"] = r["id"]
	delete(r, "id")
	r["params"] = object(r["params_json"])
	r["stats"] = object(r["stats_json"])
	r["undo_stats"] = object(r["undo_stats_json"])
	delete(r, "params_json")
	delete(r, "stats_json")
	delete(r, "undo_stats_json")
	return r
}
func (s *Service) batch(ctx context.Context, id string) (Row, error) {
	r, e := s.deps.Store.QueryRow(ctx, "SELECT "+batchColumns+" FROM caption_batches b WHERE b.id=?", id)
	return projectBatch(r), e
}
func (s *Service) markWritten(ctx context.Context, batch, asset, version string) error {
	return s.write(ctx, "UPDATE caption_batch_items SET write_state='written',after_version=? WHERE batch_id=? AND asset_id=? AND write_state='planned'", version, batch, asset)
}
func (s *Service) settle(ctx context.Context, batch string) (int, error) {
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT * FROM caption_batch_items WHERE batch_id=? AND write_state='planned' ORDER BY rowid", batch)
	if e != nil {
		return 0, e
	}
	ids := []string{}
	for _, r := range rows {
		ids = append(ids, Text(r["asset_id"]))
	}
	entries, e := s.read(ctx, ids)
	if e != nil {
		return 0, e
	}
	claimed := 0
	for _, r := range rows {
		id := Text(r["asset_id"])
		a := entries[id]
		if a.Error != "" || (!editable(a.State)) {
			continue
		}
		if a.Content != nil && *a.Content == Text(r["after_text"]) && (r["before_text"] == nil || *a.Content != Text(r["before_text"])) {
			e = s.markWritten(ctx, batch, id, a.DiskVersion)
			claimed++
		} else {
			e = s.write(ctx, "DELETE FROM caption_batch_items WHERE batch_id=? AND asset_id=? AND write_state='planned'", batch, id)
		}
		if e != nil {
			return claimed, e
		}
	}
	return claimed, nil
}
func (s *Service) Recover(ctx context.Context) (int, error) {
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT id,dataset_id FROM caption_batches WHERE state='writing' ORDER BY created_at,rowid")
	if e != nil {
		return 0, e
	}
	count := 0
	for _, r := range rows {
		unlock := s.lock(Text(r["dataset_id"]))
		err := func() error {
			defer unlock()
			id := Text(r["id"])
			if _, e = s.settle(ctx, id); e != nil {
				return e
			}
			pending, e := s.deps.Store.QueryRows(ctx, "SELECT asset_id FROM caption_batch_items WHERE batch_id=? AND write_state='planned'", id)
			if e != nil {
				return e
			}
			if len(pending) > 0 {
				return nil
			}
			b, e := s.batch(ctx, id)
			if e != nil {
				return e
			}
			if Number(b["changed_count"]) == 0 {
				e = s.write(ctx, "DELETE FROM caption_batches WHERE id=?", id)
			} else {
				stats := b["stats"].(Row)
				stats["written"] = b["changed_count"]
				stats["interrupted"] = true
				e = s.write(ctx, "UPDATE caption_batches SET state='complete',stats_json=? WHERE id=?", encode(stats), id)
			}
			if e == nil {
				count++
			}
			return e
		}()
		if err != nil {
			return count, err
		}
	}
	return count, nil
}
func (s *Service) History(ctx context.Context, id string, limit int) ([]Row, error) {
	if _, e := s.dataset(ctx, id); e != nil {
		return nil, e
	}
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT "+batchColumns+" FROM caption_batches b WHERE b.dataset_id=? ORDER BY b.created_at DESC,b.rowid DESC LIMIT ?", id, max(1, min(500, limit)))
	if e != nil {
		return nil, e
	}
	out := []Row{}
	for _, r := range rows {
		r = projectBatch(r)
		r["can_undo"] = r["undone_at"] == nil && Number(r["undoable_count"]) > 0
		delete(r, "undoable_count")
		delete(r, "state")
		out = append(out, r)
	}
	return out, nil
}
func (s *Service) Undo(ctx context.Context, id string) (Row, error) {
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	b, e := s.batch(ctx, id)
	if e != nil {
		return nil, e
	}
	if b == nil {
		return nil, Fail(404, "caption_batch_not_found", "caption 批次不存在")
	}
	dataset := Text(b["dataset_id"])
	unlock := s.lock(dataset)
	defer unlock()
	b, e = s.batch(ctx, id)
	if e != nil {
		return nil, e
	}
	if b == nil {
		return nil, Fail(404, "caption_batch_not_found", "caption 批次不存在")
	}
	if b["undone_at"] != nil {
		return nil, Fail(409, "caption_batch_already_undone", "这个批次已经撤销过了")
	}
	if Text(b["state"]) == "writing" {
		if _, e = s.settle(ctx, id); e != nil {
			return nil, e
		}
	}
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT * FROM caption_batch_items WHERE batch_id=? AND undo_state IS NULL ORDER BY rowid", id)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	items := []Row{}
	failed := []Row{}
	conflicts := []Row{}
	for _, r := range rows {
		aid := Text(r["asset_id"])
		if Text(r["write_state"]) == "planned" {
			failed = append(failed, Row{"asset_id": aid, "reason": "caption_write_pending"})
		} else if Text(r["before_version"]) != Text(r["after_version"]) {
			items = append(items, r)
			ids = append(ids, aid)
		}
	}
	entries, e := s.read(ctx, ids)
	if e != nil {
		return nil, e
	}
	total := len(items) + len(failed)
	restored := 0
	job := "captions:undo:" + id
	s.job("captions.undo", job, dataset, len(items))
	for pos, r := range items {
		if e = ctx.Err(); e != nil {
			s.finishJob(job, true)
			return nil, e
		}
		aid := Text(r["asset_id"])
		a := entries[aid]
		if a.Error != "" || !editable(a.State) {
			reason := a.Error
			if reason == "" {
				reason = a.State
			}
			failed = append(failed, Row{"asset_id": aid, "reason": reason})
			continue
		}
		if a.Content == nil || *a.Content != Text(r["after_text"]) {
			conflicts = append(conflicts, Row{"asset_id": aid, "reason": "caption_changed_since_batch"})
			continue
		}
		var before *string
		if r["before_text"] != nil {
			v := Text(r["before_text"])
			before = &v
		}
		_, err := s.deps.WriteAnnotation(ctx, aid, before, AnnotationWrite{TXTVersion: a.TXTVersion, DiskVersion: a.DiskVersion, BOM: Number(r["before_bom"]) != 0})
		if err != nil {
			category, reason := failureReason(err)
			report := Row{"asset_id": aid, "reason": reason}
			if category == "conflicts" {
				conflicts = append(conflicts, report)
			} else {
				failed = append(failed, report)
			}
		} else {
			if e = s.write(ctx, "UPDATE caption_batch_items SET undo_state='restored' WHERE batch_id=? AND asset_id=?", id, aid); e != nil {
				return nil, e
			}
			restored++
		}
		s.progress(job, pos+1, len(items))
	}
	stats := Row{"total": total, "restored": restored, "conflicts": len(conflicts), "failed": len(failed)}
	undone := len(failed) == 0
	if undone {
		e = s.write(ctx, "UPDATE caption_batches SET undone_at=?,undo_stats_json=? WHERE id=? AND undone_at IS NULL", now(), encode(stats), id)
	} else {
		e = s.write(ctx, "UPDATE caption_batches SET undo_stats_json=? WHERE id=? AND undone_at IS NULL", encode(stats), id)
	}
	s.finishJob(job, !undone || e != nil)
	if restored > 0 {
		s.publish(dataset, id, "undo", restored)
	}
	return Row{"batch_id": id, "dataset_id": dataset, "undone": undone, "stats": stats, "conflicts": capReports(conflicts), "failed": capReports(failed)}, e
}
