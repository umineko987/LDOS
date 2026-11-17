package datasetstages

import (
	"context"
	"database/sql"
	"slices"
	"strings"

	"ldos/backend/internal/captions"
)

type RunOptions struct {
	PresetID string         `json:"preset_id"`
	Options  map[string]any `json:"options"`
}

func validStage(stage string) error {
	if stage != "clean" && stage != "dedup" {
		return fail(422, "invalid_triage_stage", "只有清洗和去重阶段支持定夺")
	}
	return nil
}
func (s *Service) options(ctx context.Context, stage string, o RunOptions) (string, Row, error) {
	name := "数据集清洗"
	opts := Row{"basic_dedup": false, "similarity_groups": false, "filter_monochrome": true, "filter_sketch": true, "filter_character": false, "reference_asset_ids": []string{}}
	if stage == "dedup" {
		name = "数据集去重"
		opts["basic_dedup"] = true
		opts["similarity_groups"] = true
		opts["filter_monochrome"] = false
		opts["filter_sketch"] = false
	}
	if o.PresetID != "" {
		if s.deps.Reviews.Presets == nil {
			return "", nil, fail(503, "reviews_unavailable", "审核服务未接入")
		}
		presets, e := s.deps.Reviews.Presets(ctx)
		if e != nil {
			return "", nil, e
		}
		found := false
		for _, p := range presets {
			if text(p["id"]) == o.PresetID {
				name = text(p["name"])
				opts = Row{}
				for k, v := range object(p["options"]) {
					opts[k] = v
				}
				found = true
				break
			}
		}
		if !found {
			return "", nil, fail(404, "review_preset_not_found", "过滤预设不存在")
		}
	}
	for k, v := range o.Options {
		if !slices.Contains([]string{"basic_dedup", "similarity_groups", "filter_monochrome", "filter_sketch", "filter_character", "reference_asset_ids"}, k) {
			return "", nil, fail(422, "validation_error", "未知过滤选项")
		}
		if v == nil {
			continue
		}
		if k == "reference_asset_ids" {
			list := stringsOf(v)
			if e := captions.ValidateIDs(list, 0, 200); e != nil {
				return "", nil, e
			}
			for _, x := range anySlice(v) {
				if _, ok := x.(string); !ok {
					return "", nil, fail(422, "validation_error", "参考图片 ID 无效")
				}
			}
			opts[k] = list
		} else {
			b, ok := v.(bool)
			if !ok {
				return "", nil, fail(422, "validation_error", "过滤选项必须是布尔值")
			}
			opts[k] = b
		}
	}
	if opts["reference_asset_ids"] == nil {
		opts["reference_asset_ids"] = []string{}
	}
	if stage == "clean" {
		opts["basic_dedup"] = false
		opts["similarity_groups"] = false
		if !truth(opts["filter_monochrome"]) && !truth(opts["filter_sketch"]) && !truth(opts["filter_character"]) {
			return "", nil, fail(422, "clean_stage_no_filters", "清洗至少要开一个过滤器")
		}
	} else {
		for _, k := range []string{"filter_monochrome", "filter_sketch", "filter_character"} {
			opts[k] = false
		}
		opts["reference_asset_ids"] = []string{}
		if !truth(opts["basic_dedup"]) && !truth(opts["similarity_groups"]) {
			return "", nil, fail(422, "dedup_stage_no_checks", "去重至少要开一种检查")
		}
	}
	return name, opts, nil
}
func (s *Service) Run(ctx context.Context, id, stage string, o RunOptions) (Row, error) {
	if e := validStage(stage); e != nil {
		return nil, e
	}
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	if e = s.require(ctx, id); e != nil {
		return nil, e
	}
	if !s.dedupEnabled() {
		return nil, fail(409, "dedup_disabled", "去重功能未启用")
	}
	if s.deps.Reviews.Create == nil || s.deps.Reviews.Adopt == nil {
		return nil, fail(503, "reviews_unavailable", "审核服务未接入")
	}
	s.triage.Lock()
	defer s.triage.Unlock()
	previous, e := s.latest(ctx, id, stage)
	if e != nil {
		return nil, e
	}
	if previous != nil && text(previous["status"]) == "running" {
		previous, e = s.finalize(ctx, previous, false)
		if e != nil {
			return nil, e
		}
		if text(previous["status"]) == "running" {
			return nil, &Error{Status: 409, Code: "stage_run_active", Message: "这一段正在运行", Details: Row{"run_id": previous["run_id"]}}
		}
	}
	name, opts, e := s.options(ctx, stage, o)
	if e != nil {
		return nil, e
	}
	members, e := s.deps.StageInput(ctx, id, stage)
	if e != nil {
		return nil, e
	}
	if len(members) == 0 {
		return nil, fail(409, "stage_input_empty", "这一段没有可处理的图片")
	}
	ids := []string{}
	for _, r := range members {
		ids = append(ids, text(r["asset_id"]))
	}
	s.reviewBinding.Lock()
	review, e := s.deps.Reviews.Create(ctx, ids, Row{"preset_name": name, "options": opts})
	if e != nil {
		s.reviewBinding.Unlock()
		return nil, e
	}
	rid := text(review["review_id"])
	run, e := s.startRun(ctx, id, stage, rid, Row{"mode": stage, "preset_name": name, "options": opts, "input_count": len(members)})
	if e != nil {
		s.reviewBinding.Unlock()
		if s.deps.Reviews.Finish != nil {
			_ = s.deps.Reviews.Finish(context.Background(), rid)
		}
		return nil, e
	}
	s.mu.Lock()
	s.owners[rid] = Row{"dataset_id": id, "stage": stage, "run_id": run["run_id"]}
	s.mu.Unlock()
	s.reviewBinding.Unlock()
	delete(s.undo, id+":"+stage)
	if previous != nil && text(previous["ref_id"]) != "" && s.deps.Reviews.Finish != nil {
		old := text(previous["ref_id"])
		if e = s.deps.Reviews.Finish(ctx, old); e == nil {
			s.mu.Lock()
			delete(s.owners, old)
			s.mu.Unlock()
		}
	}
	if _, e = s.finalize(ctx, run, false); e != nil {
		return nil, e
	}
	return s.summaryLocked(ctx, id, stage)
}
func (s *Service) review(ctx context.Context, id string) (Row, error) {
	return s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_reviews WHERE review_id=?", id)
}
func (s *Service) finalize(ctx context.Context, run Row, interrupted bool) (Row, error) {
	current, e := s.getRun(ctx, text(run["run_id"]))
	if e != nil {
		return nil, e
	}
	if current == nil || text(current["status"]) != "running" {
		return current, nil
	}
	review, e := s.review(ctx, text(current["ref_id"]))
	if e != nil {
		return nil, e
	}
	stats := current["stats"].(Row)
	if review == nil {
		code := "review_lost"
		if interrupted {
			code = "interrupted"
		}
		return s.finishRun(ctx, text(current["run_id"]), "failed", code, stats)
	}
	switch text(review["status"]) {
	case "failed":
		msg := []rune(text(review["error"]))
		stats["error"] = string(msg[:min(500, len(msg))])
		return s.finishRun(ctx, text(current["run_id"]), "failed", "review_failed", stats)
	case "ready":
		rows, e := s.deps.Store.QueryRows(ctx, `SELECT i.id,g.kind FROM gallery_review_images i JOIN gallery_review_groups g ON g.review_id=i.review_id AND g.id=i.group_id WHERE i.review_id=? AND g.kind LIKE 'auto_%' AND i.disposition='rejected'`, current["ref_id"])
		if e != nil {
			return nil, e
		}
		e = s.write(ctx, func(tx *sql.Tx) error {
			for _, r := range rows {
				reason := text(r["kind"])
				if reason == "auto_filtered" {
					reason = "filter_character"
				}
				if e := setDecision(ctx, tx, text(current["dataset_id"]), text(current["stage"]), text(r["id"]), "exclude", reason); e != nil {
					return e
				}
			}
			return nil
		})
		if e != nil {
			return nil, e
		}
		counts, e := s.counts(ctx, text(current["stage"]), text(current["ref_id"]))
		if e != nil {
			return nil, e
		}
		stats["review"] = counts
		result, e := s.finishRun(ctx, text(current["run_id"]), "succeeded", "", stats)
		if len(rows) > 0 {
			s.publishDataset(text(current["dataset_id"]))
		}
		return result, e
	}
	return current, nil
}
func setDecision(ctx context.Context, tx *sql.Tx, id, stage, asset, decision, reason string) error {
	t := now()
	_, e := tx.ExecContext(ctx, `INSERT INTO dataset_decisions(dataset_id,stage,asset_id,decision,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(dataset_id,stage,asset_id) DO UPDATE SET decision=excluded.decision,reason=excluded.reason,updated_at=excluded.updated_at`, id, stage, asset, decision, reason, t, t)
	if e != nil {
		return e
	}
	_, e = tx.ExecContext(ctx, "UPDATE datasets SET updated_at=? WHERE id=?", t, id)
	return e
}
func (s *Service) contextLocked(ctx context.Context, id, stage, runID string) (Row, Row, error) {
	if e := validStage(stage); e != nil {
		return nil, nil, e
	}
	if e := s.require(ctx, id); e != nil {
		return nil, nil, e
	}
	run, e := s.latest(ctx, id, stage)
	if e != nil {
		return nil, nil, e
	}
	if run == nil {
		return nil, nil, fail(404, "stage_run_not_found", "这一段还没有运行过")
	}
	if runID != "" && text(run["run_id"]) != runID {
		return nil, nil, &Error{Status: 409, Code: "stage_run_superseded", Message: "这次运行已被更新的运行取代", Details: Row{"run_id": run["run_id"]}}
	}
	if text(run["status"]) == "running" {
		run, e = s.finalize(ctx, run, false)
		if e != nil {
			return nil, nil, e
		}
	}
	if text(run["status"]) == "running" {
		return nil, nil, fail(409, "stage_run_active", "这一段还在分析")
	}
	if text(run["status"]) != "succeeded" {
		return nil, nil, &Error{Status: 409, Code: "stage_run_failed", Message: "最近一次运行没有成功", Details: Row{"run_id": run["run_id"], "error_code": run["error_code"]}}
	}
	review, e := s.review(ctx, text(run["ref_id"]))
	if e != nil {
		return nil, nil, e
	}
	if review == nil {
		return nil, nil, fail(409, "stage_triage_expired", "后端重启后分组已失效，请重跑这一段")
	}
	return run, review, nil
}
func (s *Service) Summary(ctx context.Context, id, stage string) (Row, error) {
	s.triage.Lock()
	defer s.triage.Unlock()
	return s.summaryLocked(ctx, id, stage)
}
func (s *Service) summaryLocked(ctx context.Context, id, stage string) (Row, error) {
	if e := validStage(stage); e != nil {
		return nil, e
	}
	if e := s.require(ctx, id); e != nil {
		return nil, e
	}
	run, e := s.latest(ctx, id, stage)
	if e != nil {
		return nil, e
	}
	var review Row
	var reviewID, status, last any
	errText := ""
	counts := emptyCounts()
	stack := s.undo[id+":"+stage]
	if run != nil {
		if text(run["status"]) == "running" {
			run, e = s.finalize(ctx, run, false)
			if e != nil {
				return nil, e
			}
		}
		reviewID = run["ref_id"]
		review, e = s.review(ctx, text(reviewID))
		if e != nil {
			return nil, e
		}
		if review != nil {
			status = review["status"]
			errText = text(review["error"])
			counts, e = s.counts(ctx, stage, text(reviewID))
			if e != nil {
				return nil, e
			}
		} else {
			status = "expired"
			stats := object(run["stats"])
			for k, v := range object(stats["review"]) {
				if _, ok := counts[k]; ok {
					counts[k] = int(number(v))
				}
			}
			if n := number(stats["input_count"]); n != 0 {
				counts["input"] = int(n)
			}
		}
	}
	depth := 0
	for _, b := range stack {
		if run != nil && b.runID == text(run["run_id"]) {
			depth++
			last = b.id
		}
	}
	return Row{"dataset_id": id, "stage": stage, "run": run, "review_id": reviewID, "review_status": status, "review_error": errText, "counts": counts, "undo_depth": depth, "last_batch_id": last}, nil
}
func emptyCounts() map[string]int {
	return map[string]int{"input": 0, "groups": 0, "pending_groups": 0, "decided_groups": 0, "flagged": 0, "automatic_excluded": 0, "kept": 0, "rejected": 0, "failed": 0}
}
func flagged(r Row) bool {
	c := text(object(r["metadata_json"])["classification"])
	return text(r["kind"]) == "auto_filtered" || !truth(r["readable"]) || text(r["kind"]) == "unreadable" || c == "rough" || c == "monochrome"
}
func (s *Service) counts(ctx context.Context, stage, reviewID string) (map[string]int, error) {
	c := emptyCounts()
	r, e := s.review(ctx, reviewID)
	if e != nil {
		return nil, e
	}
	if r != nil {
		c["input"] = int(number(r["total_image_count"]))
	}
	groups, e := s.deps.Store.QueryRows(ctx, "SELECT * FROM gallery_review_groups WHERE review_id=? ORDER BY ordinal", reviewID)
	if e != nil {
		return nil, e
	}
	images, e := s.deps.Store.QueryRows(ctx, "SELECT i.*,g.kind,g.decided FROM gallery_review_images i JOIN gallery_review_groups g ON g.review_id=i.review_id AND g.id=i.group_id WHERE i.review_id=?", reviewID)
	if e != nil {
		return nil, e
	}
	flaggedGroups := map[string]bool{}
	for _, i := range images {
		auto := strings.HasPrefix(text(i["kind"]), "auto_")
		if flagged(i) {
			if stage == "clean" {
				c["flagged"]++
			}
			if !auto {
				flaggedGroups[text(i["group_id"])] = true
			}
		}
		switch text(i["disposition"]) {
		case "rejected":
			if auto {
				c["automatic_excluded"]++
			} else {
				c["rejected"]++
			}
		case "kept":
			if !auto && truth(i["decided"]) {
				c["kept"]++
			}
		case "failed":
			c["failed"]++
		}
	}
	for _, g := range groups {
		included := flaggedGroups[text(g["id"])]
		if stage == "dedup" {
			included = text(g["kind"]) == "duplicate" || text(g["kind"]) == "unreadable"
		}
		if !included {
			continue
		}
		c["groups"]++
		if truth(g["decided"]) {
			c["decided_groups"]++
		} else {
			c["pending_groups"]++
		}
	}
	if stage == "dedup" {
		c["flagged"] = c["groups"]
	}
	return c, nil
}
func (s *Service) decisions(ctx context.Context, id, stage string) (map[string]Row, error) {
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT * FROM dataset_decisions WHERE dataset_id=? AND stage=?", id, stage)
	if e != nil {
		return nil, e
	}
	out := map[string]Row{}
	for _, r := range rows {
		out[text(r["asset_id"])] = r
	}
	return out, nil
}
func (s *Service) groupImages(ctx context.Context, reviewID, groupID string) ([]Row, error) {
	return s.deps.Store.QueryRows(ctx, "SELECT * FROM gallery_review_images WHERE review_id=? AND group_id=? ORDER BY ordinal", reviewID, groupID)
}
func restoreDecision(ctx context.Context, tx *sql.Tx, id, stage, asset string, old Row) error {
	if old == nil {
		_, e := tx.ExecContext(ctx, "DELETE FROM dataset_decisions WHERE dataset_id=? AND stage=? AND asset_id=?", id, stage, asset)
		return e
	}
	_, e := tx.ExecContext(ctx, `INSERT INTO dataset_decisions(dataset_id,stage,asset_id,decision,reason,previous_decision,previous_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset_id,stage,asset_id) DO UPDATE SET decision=excluded.decision,reason=excluded.reason,previous_decision=excluded.previous_decision,previous_reason=excluded.previous_reason,created_at=excluded.created_at,updated_at=excluded.updated_at`, id, stage, asset, old["decision"], old["reason"], old["previous_decision"], old["previous_reason"], old["created_at"], old["updated_at"])
	return e
}
