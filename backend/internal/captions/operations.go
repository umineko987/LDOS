package captions

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"slices"
	"unicode/utf8"

	"github.com/google/uuid"
)

type OpsOptions struct {
	AssetIDs         []string          `json:"asset_ids"`
	Ops              []Op              `json:"ops"`
	DryRun           bool              `json:"dry_run"`
	ExpectedVersions map[string]string `json:"expected_versions"`
	SampleLimit      int               `json:"sample_limit"`
}
type TaggerOptions struct {
	Tags        map[string][]string
	Unavailable map[string]string
	AssetIDs    []string
	Mode        string
	Params      Row
	DryRun      bool
	SampleLimit int
}
type planned struct {
	id                    string
	entry                 Annotation
	before, after, tagger []string
	change                string
}
type plan struct {
	total              int
	items              []planned
	skipped, conflicts []Row
}

func editable(state string) bool { return state == "normal" || state == "blank" || state == "missing" }
func (s *Service) makePlan(ctx context.Context, ids []string, compute func(string, []string) []string, expected map[string]string, tags map[string][]string) (plan, error) {
	p := plan{total: len(ids), items: []planned{}, skipped: []Row{}, conflicts: []Row{}}
	entries, e := s.read(ctx, ids)
	if e != nil {
		return p, e
	}
	for _, id := range ids {
		a := entries[id]
		if !editable(a.State) {
			reason := a.Error
			if reason == "" {
				reason = a.State
			}
			p.skipped = append(p.skipped, Row{"asset_id": id, "reason": reason})
			continue
		}
		if v, ok := expected[id]; ok && v != a.DiskVersion {
			p.conflicts = append(p.conflicts, Row{"asset_id": id, "reason": "caption_version_conflict"})
			continue
		}
		before := Parse(TextValue(a.Content))
		after := compute(id, before)
		change := "unchanged"
		if !slices.Equal(before, after) {
			change = "changed"
			if len(before) == 0 {
				change = "new"
			}
		}
		p.items = append(p.items, planned{id, a, before, after, tags[id], change})
	}
	return p, nil
}
func TextValue(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
func diff(a, b []string) []string {
	out := []string{}
	for _, t := range a {
		if !slices.Contains(b, t) {
			out = append(out, t)
		}
	}
	return out
}
func capReports(rows []Row) []Row { return rows[:min(200, len(rows))] }
func (s *Service) execute(ctx context.Context, id string, p plan, kind string, params Row, dry bool, sampleLimit int) (Row, error) {
	stats := map[string]int{"total": p.total, "changed": 0, "new": 0, "unchanged": 0, "skipped": len(p.skipped), "conflicts": len(p.conflicts), "written": 0, "failed": 0}
	samples := []Row{}
	writes := 0
	for _, v := range p.items {
		stats[v.change]++
		if v.change != "unchanged" {
			writes++
			if len(samples) < sampleLimit {
				samples = append(samples, Row{"asset_id": v.id, "change": v.change, "before": v.before, "after": v.after, "added": diff(v.after, v.before), "removed": diff(v.before, v.after)})
			}
		}
	}
	result := Row{"dataset_id": id, "dry_run": dry, "batch_id": nil, "stats": stats, "samples": samples, "skipped": capReports(p.skipped), "conflicts": capReports(p.conflicts), "failed": []Row{}}
	if dry || writes == 0 {
		return result, nil
	}
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	batch := uuid.NewString()
	e := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		_, e := tx.ExecContext(ctx, "INSERT INTO caption_batches(id,dataset_id,kind,params_json,stats_json,created_at,state) VALUES(?,?,?,?,?,?,'writing')", batch, id, kind, encode(params), encode(stats), now())
		if e != nil {
			return e
		}
		for _, v := range p.items {
			if v.change == "unchanged" && v.tagger == nil {
				continue
			}
			state, afterVersion, after := "planned", "", any(Format(v.after))
			if v.change == "unchanged" {
				state = "written"
				afterVersion = v.entry.DiskVersion
				after = v.entry.Content
			}
			var tags any
			if v.tagger != nil {
				tags = encode(v.tagger)
			}
			_, e = tx.ExecContext(ctx, `INSERT INTO caption_batch_items(batch_id,asset_id,before_text,before_version,after_text,after_version,tagger_tags_json,write_state,before_bom) VALUES(?,?,?,?,?,?,?,?,?)`, batch, v.id, v.entry.Content, v.entry.DiskVersion, after, afterVersion, tags, state, v.entry.BOM)
			if e != nil {
				return e
			}
		}
		return ctx.Err()
	})
	if e != nil {
		return nil, e
	}
	job := "captions:" + batch
	s.job("captions.write", job, id, writes)
	failed := []Row{}
	conflicts := slices.Clone(p.conflicts)
	done := 0
	for _, v := range p.items {
		if v.change == "unchanged" {
			continue
		}
		if e = ctx.Err(); e != nil {
			s.finishJob(job, true)
			return nil, e
		}
		text := Format(v.after)
		saved, err := s.deps.WriteAnnotation(ctx, v.id, &text, AnnotationWrite{TXTVersion: v.entry.TXTVersion, DiskVersion: v.entry.DiskVersion})
		if err != nil {
			category, reason := failureReason(err)
			r := Row{"asset_id": v.id, "reason": reason}
			if category == "conflicts" {
				conflicts = append(conflicts, r)
			} else {
				failed = append(failed, r)
			}
		} else {
			if e = s.markWritten(ctx, batch, v.id, saved.DiskVersion); e != nil {
				s.finishJob(job, true)
				return nil, e
			}
			stats["written"]++
		}
		done++
		s.progress(job, done, writes)
	}
	claimed, e := s.settle(ctx, batch)
	if e != nil {
		s.finishJob(job, true)
		return nil, e
	}
	stats["written"] += claimed
	stats["conflicts"] = len(conflicts)
	stats["failed"] = len(failed)
	pending, e := s.deps.Store.QueryRows(ctx, "SELECT asset_id FROM caption_batch_items WHERE batch_id=? AND write_state='planned'", batch)
	if e != nil {
		return nil, e
	}
	if stats["written"] > 0 || len(pending) > 0 {
		state := "complete"
		if len(pending) > 0 {
			state = "writing"
		}
		e = s.write(ctx, "UPDATE caption_batches SET stats_json=?,state=? WHERE id=?", encode(stats), state, batch)
		if stats["written"] > 0 {
			result["batch_id"] = batch
			s.publish(id, batch, kind, stats["written"])
		}
	} else {
		e = s.write(ctx, "DELETE FROM caption_batches WHERE id=?", batch)
	}
	s.finishJob(job, len(failed) > 0 || e != nil)
	result["conflicts"] = capReports(conflicts)
	result["failed"] = capReports(failed)
	return result, e
}
func (s *Service) RunOps(ctx context.Context, id string, o OpsOptions) (Row, error) {
	if e := ValidateIDs(o.AssetIDs, 1, 50000); e != nil {
		return nil, e
	}
	if e := ValidateOps(o.Ops); e != nil {
		return nil, e
	}
	if o.SampleLimit < 0 || o.SampleLimit > 200 {
		return nil, Fail(422, "validation_error", "sample_limit 无效")
	}
	for _, v := range o.ExpectedVersions {
		if v == "" || len(v) > 128 {
			return nil, Fail(422, "validation_error", "版本无效")
		}
	}
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	unlock := s.lock(id)
	defer unlock()
	d, e := s.dataset(ctx, id)
	if e != nil {
		return nil, e
	}
	ids, e := s.selectIDs(ctx, id, o.AssetIDs)
	if e != nil {
		return nil, e
	}
	p, e := s.makePlan(ctx, ids, func(_ string, b []string) []string { return ApplyOps(b, o.Ops, Text(d["trigger_word"])) }, o.ExpectedVersions, nil)
	if e != nil {
		return nil, e
	}
	return s.execute(ctx, id, p, "ops", Row{"ops": o.Ops, "asset_count": len(ids)}, o.DryRun, o.SampleLimit)
}
func (s *Service) Edit(ctx context.Context, id, asset, text, expected string) (Row, error) {
	if expected == "" || len(expected) > 128 || utf8.RuneCountInString(text) > 1000000 || !utf8.ValidString(text) {
		return nil, Fail(422, "validation_error", "caption 或版本无效")
	}
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	unlock := s.lock(id)
	defer unlock()
	if _, e = s.dataset(ctx, id); e != nil {
		return nil, e
	}
	ids, e := s.selectIDs(ctx, id, []string{asset})
	if e != nil {
		return nil, e
	}
	p, e := s.makePlan(ctx, ids, func(_ string, _ []string) []string { return Parse(text) }, map[string]string{asset: expected}, nil)
	if e != nil {
		return nil, e
	}
	if len(p.skipped) > 0 {
		return nil, &Error{422, "caption_not_editable", "caption 当前不能编辑", p.skipped[0]}
	}
	result, e := s.execute(ctx, id, p, "edit", Row{"asset_id": asset}, false, 1)
	if e != nil {
		return nil, e
	}
	if len(result["conflicts"].([]Row)) > 0 {
		return nil, Fail(409, "caption_version_conflict", "caption 已被其他操作修改")
	}
	if failed := result["failed"].([]Row); len(failed) > 0 {
		return nil, Fail(409, Text(failed[0]["reason"]), "caption 写入失败")
	}
	entries, e := s.read(ctx, ids)
	if e != nil {
		return nil, e
	}
	return Row{"batch_id": result["batch_id"], "caption": entryProjection(entries[asset])}, nil
}
func entryProjection(a Annotation) Row {
	return Row{"asset_id": a.AssetID, "state": a.State, "text": TextValue(a.Content), "tags": Parse(TextValue(a.Content)), "version": a.DiskVersion}
}
func (s *Service) ApplyTagger(ctx context.Context, id string, o TaggerOptions) (Row, error) {
	if o.Mode != "merge" && o.Mode != "overwrite" && o.Mode != "fill_empty" {
		return nil, Fail(422, "invalid_caption_mode", "未知 caption 模式")
	}
	if o.SampleLimit < 0 || o.SampleLimit > 200 {
		return nil, Fail(422, "validation_error", "sample_limit 无效")
	}
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	unlock := s.lock(id)
	defer unlock()
	d, e := s.dataset(ctx, id)
	if e != nil {
		return nil, e
	}
	ids, e := s.selectIDs(ctx, id, o.AssetIDs)
	if e != nil {
		return nil, e
	}
	previous := map[string][]string{}
	if o.Mode == "merge" {
		rows, e := s.deps.Store.QueryRows(ctx, `SELECT i.asset_id,i.tagger_tags_json FROM caption_batch_items i JOIN caption_batches b ON b.id=i.batch_id WHERE b.dataset_id=? AND b.kind='from_tagger' AND b.undone_at IS NULL AND i.tagger_tags_json IS NOT NULL AND i.write_state='written' AND i.undo_state IS NULL ORDER BY b.created_at,b.rowid`, id)
		if e != nil {
			return nil, e
		}
		for _, r := range rows {
			var tags []string
			_ = json.Unmarshal([]byte(Text(r["tagger_tags_json"])), &tags)
			previous[Text(r["asset_id"])] = tags
		}
	}
	available := []string{}
	missing := []Row{}
	for _, aid := range ids {
		if _, ok := o.Tags[aid]; ok {
			available = append(available, aid)
		} else {
			reason := o.Unavailable[aid]
			if reason == "" {
				reason = "no_tagger_result"
			}
			missing = append(missing, Row{"asset_id": aid, "reason": reason})
		}
	}
	p, e := s.makePlan(ctx, available, func(aid string, b []string) []string {
		return MergeTagger(b, o.Tags[aid], previous[aid], o.Mode, Text(d["trigger_word"]))
	}, nil, o.Tags)
	if e != nil {
		return nil, e
	}
	p.total = len(ids)
	p.skipped = append(missing, p.skipped...)
	if o.Mode == "fill_empty" {
		for i := range p.items {
			if len(p.items[i].before) > 0 {
				p.items[i].tagger = nil
			}
		}
	}
	params := Row{}
	for k, v := range o.Params {
		params[k] = v
	}
	params["mode"] = o.Mode
	params["asset_count"] = len(ids)
	return s.execute(ctx, id, p, "from_tagger", params, o.DryRun, o.SampleLimit)
}
func (s *Service) Listing(ctx context.Context, id string) (string, []byte, error) {
	d, e := s.dataset(ctx, id)
	if e != nil {
		return "", nil, e
	}
	members, e := s.deps.StageInput(ctx, id, "review")
	if e != nil {
		return "", nil, e
	}
	ids := []string{}
	for _, r := range members {
		ids = append(ids, Text(r["asset_id"]))
	}
	entries, e := s.read(ctx, ids)
	if e != nil {
		return "", nil, e
	}
	items := []Row{}
	for _, r := range members {
		p := entryProjection(entries[Text(r["asset_id"])])
		p["name"] = r["name"]
		items = append(items, p)
	}
	payload := Row{"dataset_id": id, "trigger_word": Text(d["trigger_word"]), "items": items}
	body, e := json.Marshal(payload)
	if e != nil {
		return "", nil, e
	}
	hash := sha256.Sum256(body)
	etag := "\"" + hex.EncodeToString(hash[:20]) + "\""
	payload["etag"] = etag
	body, e = json.Marshal(payload)
	return etag, body, e
}
