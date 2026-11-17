package datasets

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"ldos/backend/internal/store"
)

type CreateOptions struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	TriggerWord string `json:"trigger_word"`
	Config      Record `json:"config"`
}
type MemberOptions struct {
	Stage, Decision, Query, Cursor string
	Limit                          int
}

func validKind(k string) bool { return k == "character" || k == "style" || k == "concept" }
func (s *Service) Create(ctx context.Context, o CreateOptions) (Record, error) {
	if o.Kind == "" {
		o.Kind = "character"
	}
	if strings.TrimSpace(o.Name) == "" || utf8.RuneCountInString(o.Name) > 120 || utf8.RuneCountInString(o.TriggerWord) > 120 || !validKind(o.Kind) {
		return nil, validation()
	}
	if o.Config == nil {
		o.Config = Record{}
	}
	cfg, e := jsonText(o.Config)
	if e != nil {
		return nil, e
	}
	id := uuid.NewString()
	t := now()
	e = s.exec(ctx, "INSERT INTO datasets(id,name,kind,trigger_word,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", id, strings.TrimSpace(o.Name), o.Kind, strings.TrimSpace(o.TriggerWord), cfg, t, t)
	if e != nil {
		return nil, e
	}
	s.PublishUpdated(id, "created")
	return s.Get(ctx, id)
}
func (s *Service) Update(ctx context.Context, id string, changes Record) (Record, error) {
	if e := s.Require(ctx, id); e != nil {
		return nil, e
	}
	args := []any{}
	sets := []string{}
	keys := make([]string, 0, len(changes))
	for k := range changes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		v := changes[k]
		switch k {
		case "name", "trigger_word", "kind", "cover_asset_id":
			if v == nil && k != "cover_asset_id" {
				continue
			}
			if v != nil {
				text, ok := v.(string)
				if !ok {
					return nil, validation()
				}
				limit := 120
				if k == "cover_asset_id" {
					limit = 128
				}
				if utf8.RuneCountInString(text) > limit {
					return nil, validation()
				}
				if k == "name" && strings.TrimSpace(text) == "" {
					return nil, validation()
				}
				if k == "kind" && !validKind(text) {
					return nil, validation()
				}
				if k == "name" || k == "trigger_word" {
					v = strings.TrimSpace(text)
				}
			}
			sets = append(sets, k+"=?")
			args = append(args, v)
		case "config":
			if v == nil {
				continue
			}
			if _, ok := v.(map[string]any); !ok {
				return nil, validation()
			}
			j, e := jsonText(v)
			if e != nil {
				return nil, e
			}
			sets = append(sets, "config_json=?")
			args = append(args, j)
		default:
			return nil, validation()
		}
	}
	sets = append(sets, "updated_at=?")
	args = append(args, now(), id)
	e := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if e := requireTx(ctx, tx, id); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, "UPDATE datasets SET "+strings.Join(sets, ",")+" WHERE id=?", args...)
		return e
	})
	if e != nil {
		return nil, e
	}
	s.PublishUpdated(id, "updated")
	return s.Get(ctx, id)
}
func (s *Service) Delete(ctx context.Context, id string) error {
	e := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		r, e := tx.ExecContext(ctx, "DELETE FROM datasets WHERE id=?", id)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return failure(404, "dataset_not_found", "数据集不存在")
		}
		return nil
	})
	if e == nil {
		s.PublishUpdated(id, "deleted")
	}
	return e
}
func (s *Service) Get(ctx context.Context, id string) (Record, error) {
	d, e := s.dataset(ctx, id)
	if e != nil {
		return nil, e
	}
	return s.summary(ctx, d, true)
}
func (s *Service) List(ctx context.Context) ([]Record, error) {
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT id FROM datasets ORDER BY updated_at DESC,id")
	if e != nil {
		return nil, e
	}
	out := []Record{}
	for _, r := range rows {
		d, e := s.dataset(ctx, str(r["id"]))
		if e != nil {
			return nil, e
		}
		d, e = s.summary(ctx, d, false)
		if e != nil {
			return nil, e
		}
		out = append(out, d)
	}
	return out, nil
}
func (s *Service) summary(ctx context.Context, d Record, detail bool) (Record, error) {
	id := str(d["dataset_id"])
	members, e := s.MemberRows(ctx, id)
	if e != nil {
		return nil, e
	}
	f, e := s.funnel(ctx, id, members)
	if e != nil {
		return nil, e
	}
	roots, e := s.ListRoots(ctx, id)
	if e != nil {
		return nil, e
	}
	var first, cover string
	for _, m := range members {
		if live(m) {
			if first == "" {
				first = str(m["asset_id"])
			}
			if m["asset_id"] == d["cover_asset_id"] {
				cover = str(m["asset_id"])
			}
		}
	}
	if cover == "" {
		cover = first
	}
	d["cover_asset_id"] = nil
	d["cover_thumbnail_url"] = nil
	if cover != "" {
		d["cover_asset_id"] = cover
		d["cover_thumbnail_url"] = ThumbnailURL(cover)
	}
	stages := f["stages"].([]Record)
	outputs := []Record{}
	for _, stage := range stages {
		outputs = append(outputs, Record{"stage": stage["stage"], "output": stage["output"], "stale": stage["stale"]})
	}
	d["member_count"] = len(members)
	d["output_count"] = stages[len(stages)-1]["output"]
	d["root_count"] = len(roots)
	d["stage_outputs"] = outputs
	if detail {
		d["funnel"] = stages
	}
	return d, nil
}

const memberColumns = `a.id AS asset_id,a.source_id,a.directory_id,a.relative_path,a.name,a.extension,a.sort_key,a.size_bytes,a.modified_ns,a.content_sha256,a.content_version,a.format,a.width,a.height,a.txt_relative_path,a.txt_size_bytes,a.txt_modified_ns,a.txt_version,a.txt_state,a.dedup_visibility,a.lifecycle_state`

func memberPredicate() string {
	p := `EXISTS(SELECT 1 FROM dataset_roots r WHERE r.dataset_id=? AND r.source_id=a.source_id AND (r.relative_path='' OR a.relative_path=r.relative_path OR substr(a.relative_path,1,length(r.relative_path)+1)=r.relative_path||'/')) AND ((a.lifecycle_state='active' AND a.dedup_visibility!='excluded') OR (a.lifecycle_state IN ('active','trashed') AND EXISTS(SELECT 1 FROM dataset_decisions d WHERE d.dataset_id=? AND d.asset_id=a.id AND d.decision='exclude')))`
	for _, part := range []string{".ldos", "duplicates", "keep", "trashed", "trash"} {
		p += ` AND ('/'||lower(a.relative_path)||'/') NOT LIKE '%/` + part + `/%'`
	}
	return p + ` AND ('/'||lower(a.relative_path)) NOT LIKE '%/.ldos-%'`
}
func (s *Service) MemberRows(ctx context.Context, id string) ([]Record, error) {
	if e := s.Require(ctx, id); e != nil {
		return nil, e
	}
	return s.deps.Store.QueryRows(ctx, "SELECT "+memberColumns+" FROM gallery_assets a WHERE "+memberPredicate()+" ORDER BY a.sort_key,a.name,a.id", id, id)
}
func (s *Service) ListDecisions(ctx context.Context, id string, assetIDs ...[]string) ([]Record, error) {
	q := "SELECT stage,asset_id,decision,reason,updated_at FROM dataset_decisions WHERE dataset_id=?"
	args := []any{id}
	if len(assetIDs) > 0 {
		ids := unique(assetIDs[0])
		if len(ids) == 0 {
			return []Record{}, nil
		}
		q += " AND asset_id IN (" + strings.TrimRight(strings.Repeat("?,", len(ids)), ",") + ")"
		for _, a := range ids {
			args = append(args, a)
		}
	}
	return s.deps.Store.QueryRows(ctx, q, args...)
}
func (s *Service) decisionMap(ctx context.Context, id string) (map[string]map[string]string, error) {
	rows, e := s.ListDecisions(ctx, id)
	if e != nil {
		return nil, e
	}
	m := map[string]map[string]string{}
	for _, r := range rows {
		a := str(r["asset_id"])
		if m[a] == nil {
			m[a] = map[string]string{}
		}
		m[a][str(r["stage"])] = str(r["decision"])
	}
	return m, nil
}
func InputDigest(stage string, members []Record) string {
	lines := make([]string, 0, len(members))
	for _, m := range members {
		line := fmt.Sprintf("%s:%d:%d", str(m["asset_id"]), num(m["size_bytes"]), num(m["modified_ns"]))
		if stage == "export" {
			line += fmt.Sprintf(":%s:%d:%d", str(m["txt_state"]), num(m["txt_size_bytes"]), num(m["txt_modified_ns"]))
		}
		lines = append(lines, line)
	}
	sort.Strings(lines)
	h := sha256.New()
	h.Write([]byte(stage))
	for _, line := range lines {
		h.Write([]byte("\n" + line))
	}
	return hex.EncodeToString(h.Sum(nil))
}
func (s *Service) StageInput(ctx context.Context, id, stage string, liveOnly ...bool) ([]Record, error) {
	idx, e := StageIndex(stage)
	if e != nil {
		return nil, e
	}
	members, e := s.MemberRows(ctx, id)
	if e != nil {
		return nil, e
	}
	decisions, e := s.decisionMap(ctx, id)
	if e != nil {
		return nil, e
	}
	onlyLive := len(liveOnly) == 0 || liveOnly[0]
	out := []Record{}
	for _, m := range members {
		if onlyLive && !live(m) {
			continue
		}
		excluded := false
		for _, earlier := range Stages[:idx] {
			if decisions[str(m["asset_id"])][earlier] == "exclude" {
				excluded = true
				break
			}
		}
		if !excluded {
			out = append(out, m)
		}
	}
	return out, nil
}
func (s *Service) StageInputDigest(ctx context.Context, id, stage string) (string, error) {
	m, e := s.StageInput(ctx, id, stage, false)
	if e != nil {
		return "", e
	}
	return InputDigest(stage, m), nil
}
func (s *Service) Funnel(ctx context.Context, id string) (Record, error) {
	m, e := s.MemberRows(ctx, id)
	if e != nil {
		return nil, e
	}
	return s.funnel(ctx, id, m)
}
func (s *Service) funnel(ctx context.Context, id string, members []Record) (Record, error) {
	decisions, e := s.decisionMap(ctx, id)
	if e != nil {
		return nil, e
	}
	runs, e := s.LatestStageRuns(ctx, id)
	if e != nil {
		return nil, e
	}
	stages := []Record{}
	current := members
	for _, stage := range Stages {
		excluded, approved := 0, 0
		next := []Record{}
		for _, m := range current {
			switch decisions[str(m["asset_id"])][stage] {
			case "exclude":
				excluded++
				continue
			case "approve":
				approved++
			}
			next = append(next, m)
		}
		digest := InputDigest(stage, current)
		var last any
		status := "idle"
		stale := false
		if r := runs[stage]; r != nil {
			last = r
			status = str(r["status"])
			stale = status == "succeeded" && str(r["input_digest"]) != digest
		}
		stages = append(stages, Record{"stage": stage, "input": len(current), "excluded": excluded, "approved": approved, "output": len(next), "input_digest": digest, "status": status, "stale": stale, "last_run": last})
		current = next
	}
	return Record{"dataset_id": id, "member_count": len(members), "stages": stages}, nil
}
func (s *Service) MembersPage(ctx context.Context, id string, o MemberOptions) (Record, error) {
	if e := s.Require(ctx, id); e != nil {
		return nil, e
	}
	idx := 0
	var e error
	if o.Stage != "" {
		idx, e = StageIndex(o.Stage)
		if e != nil {
			return nil, e
		}
	} else if o.Decision != "" {
		return nil, failure(422, "invalid_dataset_member_filter", "按决定过滤时必须指定阶段")
	}
	limit := o.Limit
	if limit == 0 {
		limit = 100
	}
	limit = max(1, min(limit, 500))
	args := []any{id, id}
	where := memberPredicate()
	for _, stage := range Stages[:idx] {
		where += ` AND NOT EXISTS(SELECT 1 FROM dataset_decisions d WHERE d.dataset_id=? AND d.asset_id=a.id AND d.stage=? AND d.decision='exclude')`
		args = append(args, id, stage)
	}
	if o.Decision != "" {
		pred := ""
		switch o.Decision {
		case "excluded":
			pred = "EXISTS"
		case "approved":
			pred = "EXISTS"
		case "undecided", "kept":
			pred = "NOT EXISTS"
		default:
			return nil, validation()
		}
		where += " AND " + pred + "(SELECT 1 FROM dataset_decisions d WHERE d.dataset_id=? AND d.asset_id=a.id AND d.stage=?"
		args = append(args, id, o.Stage)
		if o.Decision == "excluded" || o.Decision == "kept" {
			where += " AND d.decision='exclude'"
		}
		if o.Decision == "approved" {
			where += " AND d.decision='approve'"
		}
		where += ")"
	}
	if q := strings.TrimSpace(o.Query); q != "" {
		where += ` AND lower(a.relative_path) LIKE ? ESCAPE '\'`
		q = strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(strings.ToLower(q))
		args = append(args, "%"+q+"%")
	}
	total, e := s.deps.Store.QueryRow(ctx, "SELECT COUNT(*) AS total FROM gallery_assets a WHERE "+where, args...)
	if e != nil {
		return nil, e
	}
	if o.Cursor != "" {
		var c map[string]string
		b, e := base64.RawURLEncoding.DecodeString(strings.TrimRight(o.Cursor, "="))
		if e == nil {
			e = json.Unmarshal(b, &c)
		}
		_, a := c["sort_key"]
		_, n := c["name"]
		_, i := c["id"]
		if e != nil || c["kind"] != "dataset-member" || !a || !n || !i {
			return nil, failure(422, "invalid_dataset_cursor", "分页游标无效")
		}
		where += " AND (a.sort_key,a.name,a.id)>(?,?,?)"
		args = append(args, c["sort_key"], c["name"], c["id"])
	}
	args = append(args, limit+1)
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT "+memberColumns+" FROM gallery_assets a WHERE "+where+" ORDER BY a.sort_key,a.name,a.id LIMIT ?", args...)
	if e != nil {
		return nil, e
	}
	var cursor any
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		b, _ := json.Marshal(Record{"kind": "dataset-member", "sort_key": last["sort_key"], "name": last["name"], "id": last["asset_id"]})
		cursor = base64.RawURLEncoding.EncodeToString(b)
	}
	ids := []string{}
	for _, m := range rows {
		ids = append(ids, str(m["asset_id"]))
	}
	decs, e := s.ListDecisions(ctx, id, ids)
	if e != nil {
		return nil, e
	}
	byID := map[string][]Record{}
	for _, d := range decs {
		a := str(d["asset_id"])
		byID[a] = append(byID[a], Record{"stage": d["stage"], "decision": d["decision"], "reason": d["reason"]})
	}
	items := []Record{}
	for _, m := range rows {
		item := Record{}
		for _, k := range []string{"asset_id", "source_id", "directory_id", "relative_path", "name", "format", "width", "height", "size_bytes", "content_sha256", "txt_state", "lifecycle_state", "dedup_visibility"} {
			item[k] = m[k]
		}
		a := str(m["asset_id"])
		d := byID[a]
		if d == nil {
			d = []Record{}
		}
		sort.Slice(d, func(i, j int) bool {
			a, _ := StageIndex(str(d[i]["stage"]))
			b, _ := StageIndex(str(d[j]["stage"]))
			return a < b
		})
		item["decisions"] = d
		item["thumbnail_url"] = ThumbnailURL(a)
		items = append(items, item)
	}
	return Record{"items": items, "next_cursor": cursor, "total": total["total"], "limit": limit}, nil
}

func (s *Service) requireMembersTx(ctx context.Context, tx *sql.Tx, id string, ids []string) error {
	if e := requireTx(ctx, tx, id); e != nil {
		return e
	}
	rows, e := store.QueryRowsTx(ctx, tx, "SELECT a.id FROM gallery_assets a WHERE "+memberPredicate(), id, id)
	if e != nil {
		return e
	}
	have := map[string]bool{}
	for _, r := range rows {
		have[str(r["id"])] = true
	}
	unknown := []string{}
	for _, a := range unique(ids) {
		if !have[a] {
			unknown = append(unknown, a)
		}
	}
	if len(unknown) > 0 {
		return failure(422, "dataset_asset_not_member", "有图片不属于这个数据集", Record{"asset_ids": unknown[:min(20, len(unknown))]})
	}
	return nil
}
func (s *Service) Decide(ctx context.Context, id, stage string, ids []string, decision, reason string) (Record, error) {
	return s.decide(ctx, id, stage, ids, decision, reason, false)
}
func (s *Service) SetAside(ctx context.Context, id, stage string, ids []string, reason string) (Record, error) {
	return s.decide(ctx, id, stage, ids, "set_aside", reason, false)
}
func (s *Service) PutBack(ctx context.Context, id, stage string, ids []string, reason string) (Record, error) {
	return s.decide(ctx, id, stage, ids, "put_back", reason, true)
}

// RecordDecisions permits peer reconciliation after moving assets out of live
// membership. Callers must already have validated their operation's identities.
func (s *Service) RecordDecisions(ctx context.Context, id, stage string, ids []string, decision, reason string) (Record, error) {
	return s.decide(ctx, id, stage, ids, decision, reason, true)
}
func (s *Service) decide(ctx context.Context, id, stage string, ids []string, decision, reason string, allowDetached bool) (Record, error) {
	idx, e := StageIndex(stage)
	if e != nil {
		return nil, e
	}
	if decision != "exclude" && decision != "approve" && decision != "clear" && decision != "set_aside" && decision != "put_back" {
		return nil, failure(422, "invalid_dataset_decision", "未知决定")
	}
	updated := int64(0)
	ids = unique(ids)
	e = s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if allowDetached {
			if e := requireTx(ctx, tx, id); e != nil {
				return e
			}
		} else if e := s.requireMembersTx(ctx, tx, id, ids); e != nil {
			return e
		}
		t := now()
		for _, a := range ids {
			switch decision {
			case "clear":
				r, e := tx.ExecContext(ctx, "DELETE FROM dataset_decisions WHERE dataset_id=? AND stage=? AND asset_id=?", id, stage, a)
				if e != nil {
					return e
				}
				n, _ := r.RowsAffected()
				updated += n
			case "put_back":
				r, e := store.QueryRowTx(ctx, tx, "SELECT previous_decision FROM dataset_decisions WHERE dataset_id=? AND stage=? AND asset_id=? AND decision='exclude' AND reason=?", id, stage, a, reason)
				if e != nil {
					return e
				}
				if r == nil {
					continue
				}
				if r["previous_decision"] == nil {
					_, e = tx.ExecContext(ctx, "DELETE FROM dataset_decisions WHERE dataset_id=? AND stage=? AND asset_id=?", id, stage, a)
				} else {
					_, e = tx.ExecContext(ctx, "UPDATE dataset_decisions SET decision=previous_decision,reason=previous_reason,previous_decision=NULL,previous_reason='',updated_at=? WHERE dataset_id=? AND stage=? AND asset_id=?", t, id, stage, a)
				}
				if e != nil {
					return e
				}
				updated++
			case "set_aside":
				args := []any{id, a}
				for _, v := range Stages[:idx+1] {
					args = append(args, v)
				}
				r, e := store.QueryRowTx(ctx, tx, "SELECT 1 FROM dataset_decisions WHERE dataset_id=? AND asset_id=? AND decision='exclude' AND stage IN ("+strings.TrimRight(strings.Repeat("?,", idx+1), ",")+")", args...)
				if e != nil {
					return e
				}
				if r != nil {
					continue
				}
				_, e = tx.ExecContext(ctx, `INSERT INTO dataset_decisions(dataset_id,stage,asset_id,decision,reason,previous_decision,previous_reason,created_at,updated_at) VALUES(?,?,?,'exclude',?,NULL,'',?,?) ON CONFLICT(dataset_id,stage,asset_id) DO UPDATE SET previous_decision=dataset_decisions.decision,previous_reason=dataset_decisions.reason,decision=excluded.decision,reason=excluded.reason,updated_at=excluded.updated_at`, id, stage, a, reason, t, t)
				if e != nil {
					return e
				}
				updated++
			default:
				_, e := tx.ExecContext(ctx, `INSERT INTO dataset_decisions(dataset_id,stage,asset_id,decision,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(dataset_id,stage,asset_id) DO UPDATE SET decision=excluded.decision,reason=excluded.reason,updated_at=excluded.updated_at`, id, stage, a, decision, reason, t, t)
				if e != nil {
					return e
				}
				updated++
			}
		}
		if updated > 0 || decision == "clear" {
			return touch(ctx, tx, id)
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	event := "decisions"
	if decision == "set_aside" || decision == "put_back" {
		event = reason
	}
	if updated > 0 {
		s.PublishUpdated(id, event)
	}
	f, e := s.Funnel(ctx, id)
	if e != nil {
		return nil, e
	}
	return Record{"updated": updated, "funnel": f}, nil
}

type StageRunOptions struct {
	RefID       string
	Stats       Record
	InputDigest string
}
type FinishStageRunOptions struct {
	Status    string
	Stats     Record
	ErrorCode string
	RefID     *string
}

func projectRun(r Record) Record {
	if r == nil {
		return nil
	}
	r["run_id"] = r["id"]
	delete(r, "id")
	r["stats"] = object(r["stats_json"])
	delete(r, "stats_json")
	return r
}
func (s *Service) StartStageRun(ctx context.Context, id, stage string, opts ...StageRunOptions) (Record, error) {
	var o StageRunOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	digest, e := s.StageInputDigest(ctx, id, stage)
	if e != nil {
		return nil, e
	}
	if o.InputDigest != "" {
		digest = o.InputDigest
	}
	if o.Stats == nil {
		o.Stats = Record{}
	}
	j, e := jsonText(o.Stats)
	if e != nil {
		return nil, e
	}
	runID := uuid.NewString()
	t := now()
	e = s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if e := requireTx(ctx, tx, id); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, `INSERT INTO dataset_stage_runs(id,dataset_id,stage,status,ref_id,input_digest,stats_json,error_code,created_at,updated_at) VALUES(?,?,?,'running',?,?,?,'',?,?)`, runID, id, stage, o.RefID, digest, j, t, t)
		if e != nil {
			return e
		}
		return touch(ctx, tx, id)
	})
	if e != nil {
		return nil, e
	}
	s.PublishUpdated(id, "stage_run")
	return s.GetStageRun(ctx, runID)
}
func (s *Service) GetStageRun(ctx context.Context, id string) (Record, error) {
	r, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM dataset_stage_runs WHERE id=?", id)
	return projectRun(r), e
}
func (s *Service) FinishStageRun(ctx context.Context, id string, o FinishStageRunOptions) (Record, error) {
	if o.Status != "succeeded" && o.Status != "failed" && o.Status != "cancelled" {
		return nil, failure(422, "invalid_dataset_stage_run_status", "需要终止状态")
	}
	t := now()
	sets := "status=?,updated_at=?,finished_at=?,error_code=?"
	args := []any{o.Status, t, t, o.ErrorCode}
	if o.Stats != nil {
		j, e := jsonText(o.Stats)
		if e != nil {
			return nil, e
		}
		sets += ",stats_json=?"
		args = append(args, j)
	}
	if o.RefID != nil {
		sets += ",ref_id=?"
		args = append(args, *o.RefID)
	}
	args = append(args, id)
	if e := s.exec(ctx, "UPDATE dataset_stage_runs SET "+sets+" WHERE id=?", args...); e != nil {
		return nil, e
	}
	r, e := s.GetStageRun(ctx, id)
	if r != nil {
		s.PublishUpdated(str(r["dataset_id"]), "stage_run")
	}
	return r, e
}
func (s *Service) ListStageRuns(ctx context.Context, id, stage string, limit int) ([]Record, error) {
	if e := s.Require(ctx, id); e != nil {
		return nil, e
	}
	q := "SELECT * FROM dataset_stage_runs WHERE dataset_id=?"
	args := []any{id}
	if stage != "" {
		if _, e := StageIndex(stage); e != nil {
			return nil, e
		}
		q += " AND stage=?"
		args = append(args, stage)
	}
	if limit == 0 {
		limit = 50
	}
	args = append(args, max(1, min(limit, 500)))
	rows, e := s.deps.Store.QueryRows(ctx, q+" ORDER BY created_at DESC,id DESC LIMIT ?", args...)
	if e != nil {
		return nil, e
	}
	for _, r := range rows {
		projectRun(r)
	}
	return rows, nil
}
func (s *Service) LatestStageRuns(ctx context.Context, id string) (map[string]Record, error) {
	rows, e := s.deps.Store.QueryRows(ctx, `SELECT * FROM dataset_stage_runs r WHERE r.dataset_id=? AND r.rowid=(SELECT l.rowid FROM dataset_stage_runs l WHERE l.dataset_id=r.dataset_id AND l.stage=r.stage ORDER BY l.created_at DESC,l.rowid DESC LIMIT 1)`, id)
	if e != nil {
		return nil, e
	}
	out := map[string]Record{}
	for _, r := range rows {
		out[str(r["stage"])] = projectRun(r)
	}
	return out, nil
}
