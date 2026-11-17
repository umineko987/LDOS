package datasetstages

import (
	"context"
	"database/sql"
	"slices"
	"strings"

	"github.com/google/uuid"
	"ldos/backend/internal/captions"
)

type GroupDecision struct {
	GroupID string   `json:"group_id"`
	Keep    []string `json:"keep"`
}
type undoGroup struct {
	id                 string
	automatic, decided bool
	selected           []string
	decisions          map[string]Row
}
type undoBatch struct {
	id, runID string
	groups    []undoGroup
}
type groupPlan struct {
	group  Row
	images []Row
	keep   []string
}

func (s *Service) adopt(ctx context.Context, reviewID, groupID string, keep []string, automatic bool) error {
	if s.deps.Reviews.Adopt == nil {
		return fail(503, "reviews_unavailable", "审核服务未接入")
	}
	r, e := s.review(ctx, reviewID)
	if e != nil {
		return e
	}
	if r == nil {
		return fail(409, "stage_triage_expired", "分组已失效")
	}
	_, e = s.deps.Reviews.Adopt(ctx, reviewID, groupID, keep, number(r["version"]), automatic)
	return e
}
func (s *Service) Apply(ctx context.Context, id, stage, runID string, groups []GroupDecision) (Row, error) {
	if runID == "" || len(runID) > 128 || len(groups) < 1 || len(groups) > 200 {
		return nil, fail(422, "validation_error", "run_id 或分组数量无效")
	}
	seen := map[string]bool{}
	for _, g := range groups {
		if g.GroupID == "" || len(g.GroupID) > 200 {
			return nil, fail(422, "validation_error", "group_id 无效")
		}
		if seen[g.GroupID] {
			return nil, &Error{Status: 422, Code: "triage_group_duplicate", Message: "同一组重复出现", Details: Row{"group_id": g.GroupID}}
		}
		seen[g.GroupID] = true
		if e := captions.ValidateIDs(g.Keep, 0, 500); e != nil {
			return nil, e
		}
	}
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	s.triage.Lock()
	defer s.triage.Unlock()
	run, _, e := s.contextLocked(ctx, id, stage, runID)
	if e != nil {
		return nil, e
	}
	rid := text(run["ref_id"])
	plans := []groupPlan{}
	for _, g := range groups {
		r, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_review_groups WHERE review_id=? AND id=?", rid, g.GroupID)
		if e != nil {
			return nil, e
		}
		if r == nil {
			return nil, &Error{Status: 404, Code: "triage_group_not_found", Message: "分组不存在", Details: Row{"group_id": g.GroupID}}
		}
		images, e := s.groupImages(ctx, rid, g.GroupID)
		if e != nil {
			return nil, e
		}
		known := map[string]bool{}
		for _, image := range images {
			known[text(image["id"])] = true
		}
		keep := captions.Dedupe(g.Keep)
		for _, aid := range keep {
			if !known[aid] {
				return nil, &Error{Status: 422, Code: "triage_asset_not_in_group", Message: "保留的图不在这一组里", Details: Row{"group_id": g.GroupID, "asset_ids": []string{aid}}}
			}
		}
		plans = append(plans, groupPlan{r, images, keep})
	}
	kept, rejected := []string{}, []string{}
	failed := []Row{}
	entries := []undoGroup{}
	var batchError any
	for _, p := range plans {
		if e = ctx.Err(); e != nil {
			batchError = Row{"group_id": p.group["id"], "code": "triage_group_rejected", "message": "操作已取消"}
			break
		}
		gid := text(p.group["id"])
		auto := strings.HasPrefix(text(p.group["kind"]), "auto_")
		all, e := s.decisions(ctx, id, stage)
		if e != nil {
			return nil, e
		}
		old := map[string]Row{}
		selected := []string{}
		for _, i := range p.images {
			aid := text(i["id"])
			old[aid] = all[aid]
			if truth(i["selected"]) {
				selected = append(selected, aid)
			}
		}
		if e = s.adopt(ctx, rid, gid, p.keep, auto); e != nil {
			batchError = Row{"group_id": gid, "code": "triage_group_rejected", "message": e.Error()}
			break
		}
		entry := undoGroup{gid, auto, truth(p.group["decided"]), selected, old}
		entries = append(entries, entry)
		// Project actual settled dispositions, including per-file failures.
		settled, e := s.groupImages(ctx, rid, gid)
		if e != nil {
			return nil, e
		}
		e = s.write(ctx, func(tx *sql.Tx) error {
			for _, i := range settled {
				aid := text(i["id"])
				switch text(i["disposition"]) {
				case "kept":
					if e := setDecision(ctx, tx, id, stage, aid, "approve", "triage"); e != nil {
						return e
					}
					kept = append(kept, aid)
				case "rejected":
					reason := "triage"
					if prev := old[aid]; auto && prev != nil && text(prev["decision"]) == "exclude" {
						reason = text(prev["reason"])
					}
					if e := setDecision(ctx, tx, id, stage, aid, "exclude", reason); e != nil {
						return e
					}
					rejected = append(rejected, aid)
				case "failed":
					failed = append(failed, Row{"asset_id": aid, "error": text(i["error"])})
				}
			}
			return nil
		})
		if e != nil {
			batchError = Row{"group_id": gid, "code": "triage_group_rejected", "message": e.Error()}
			break
		}
	}
	var batchID any
	if len(entries) > 0 {
		b := &undoBatch{id: uuid.NewString(), runID: runID, groups: entries}
		batchID = b.id
		key := id + ":" + stage
		stack := append(s.undo[key], b)
		if len(stack) > 50 {
			stack = stack[len(stack)-50:]
		}
		s.undo[key] = stack
		s.publishStage(run)
		s.publishDataset(id)
	}
	summary, e := s.summaryLocked(context.WithoutCancel(ctx), id, stage)
	return Row{"batch_id": batchID, "applied_groups": len(entries), "kept": kept, "rejected": rejected, "failed": failed, "error": batchError, "summary": summary}, e
}
func (s *Service) Undo(ctx context.Context, id, stage, batchID string) (Row, error) {
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	s.triage.Lock()
	defer s.triage.Unlock()
	run, _, e := s.contextLocked(ctx, id, stage, "")
	if e != nil {
		return nil, e
	}
	key := id + ":" + stage
	stack := s.undo[key]
	if len(stack) == 0 || stack[len(stack)-1].runID != text(run["run_id"]) {
		return nil, fail(409, "triage_nothing_to_undo", "没有可撤销的定夺")
	}
	b := stack[len(stack)-1]
	if batchID != "" && batchID != b.id {
		return nil, &Error{Status: 409, Code: "triage_undo_not_latest", Message: "只能撤销最近一批定夺", Details: Row{"latest_batch_id": b.id}}
	}
	rid := text(run["ref_id"])
	undone := 0
	var batchError any
	for len(b.groups) > 0 {
		entry := b.groups[len(b.groups)-1]
		if e = s.adopt(ctx, rid, entry.id, entry.selected, entry.automatic); e != nil {
			batchError = Row{"group_id": entry.id, "code": "triage_undo_failed", "message": e.Error()}
			break
		}
		settled, e := s.groupImages(ctx, rid, entry.id)
		if e != nil {
			return nil, e
		}
		hasFailure := false
		for _, i := range settled {
			if text(i["disposition"]) == "failed" || slices.Contains(entry.selected, text(i["id"])) != (text(i["disposition"]) == "kept") {
				hasFailure = true
				break
			}
		}
		if hasFailure {
			batchError = Row{"group_id": entry.id, "code": "triage_undo_failed", "message": "部分图片恢复失败"}
			break
		}
		e = s.write(ctx, func(tx *sql.Tx) error {
			if !entry.decided {
				if _, e := tx.ExecContext(ctx, "UPDATE gallery_review_groups SET decided=0,updated_at=? WHERE review_id=? AND id=?", now(), rid, entry.id); e != nil {
					return e
				}
			}
			for aid, old := range entry.decisions {
				if e := restoreDecision(ctx, tx, id, stage, aid, old); e != nil {
					return e
				}
			}
			_, e := tx.ExecContext(ctx, "UPDATE datasets SET updated_at=? WHERE id=?", now(), id)
			return e
		})
		if e != nil {
			batchError = Row{"group_id": entry.id, "code": "triage_undo_failed", "message": e.Error()}
			break
		}
		b.groups = b.groups[:len(b.groups)-1]
		undone++
	}
	if len(b.groups) == 0 {
		s.undo[key] = stack[:len(stack)-1]
	}
	if undone > 0 {
		s.publishStage(run)
		s.publishDataset(id)
	}
	if batchError != nil && undone == 0 {
		return nil, &Error{Status: 409, Code: "triage_undo_failed", Message: "撤销失败", Details: batchError}
	}
	summary, e := s.summaryLocked(ctx, id, stage)
	return Row{"batch_id": b.id, "undone_groups": undone, "error": batchError, "summary": summary}, e
}
