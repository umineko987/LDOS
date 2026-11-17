package datasetstages

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"

	"ldos/backend/internal/captions"
)

const CandidateFloor = 0.01

var categories = []string{"general", "character", "copyright", "quality", "meta", "rating", "style"}
var plainTag = regexp.MustCompile(`^[a-z0-9_]+$`)

type FromTaggerOptions struct {
	Models          []string                      `json:"models"`
	Mode            string                        `json:"mode"`
	Thresholds      map[string]map[string]float64 `json:"thresholds"`
	Categories      []string                      `json:"categories"`
	KeepUnderscores bool                          `json:"keep_underscores"`
	EscapeParens    bool                          `json:"escape_parens"`
	AssetIDs        []string                      `json:"asset_ids"`
	DryRun          bool                          `json:"dry_run"`
	SampleLimit     int                           `json:"sample_limit"`
}

func modelList(models []string) ([]string, error) {
	if len(models) < 1 || len(models) > 8 {
		return nil, fail(422, "invalid_tagger_models", "需要 1 到 8 个模型")
	}
	for _, m := range models {
		if m == "" || len(m) > 64 {
			return nil, fail(422, "invalid_tagger_models", "模型 key 无效")
		}
	}
	return captions.Dedupe(models), nil
}
func (s *Service) catalog(ctx context.Context, models []string) ([]Row, error) {
	if !s.deps.Settings.Tagger.Enabled {
		return nil, fail(409, "tagger_disabled", "打标功能未启用")
	}
	if s.deps.Tagger.Catalog == nil {
		return nil, fail(503, "tagger_unavailable", "打标服务未接入")
	}
	rows, e := s.deps.Tagger.Catalog(ctx)
	if e != nil {
		return nil, e
	}
	lookup := map[string]Row{}
	for _, r := range rows {
		lookup[text(r["key"])] = r
	}
	entries := []Row{}
	for _, m := range models {
		r := lookup[m]
		if r == nil {
			return nil, &Error{Status: 422, Code: "unknown_tagger_model", Message: "未登记的模型", Details: Row{"models": []string{m}}}
		}
		if !truth(r["installed"]) {
			return nil, &Error{Status: 409, Code: "tagger_model_missing", Message: "模型未安装", Details: Row{"models": []string{m}}}
		}
		entries = append(entries, r)
	}
	return entries, nil
}
func (s *Service) RunTag(ctx context.Context, id string, models []string, batchSize int) (Row, error) {
	models, e := modelList(models)
	if e != nil {
		return nil, e
	}
	if batchSize < 1 || batchSize > 64 {
		return nil, fail(422, "validation_error", "batch_size 无效")
	}
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	if e = s.require(ctx, id); e != nil {
		return nil, e
	}
	if _, e = s.catalog(ctx, models); e != nil {
		return nil, e
	}
	if s.deps.Tagger.Tag == nil || s.deps.Tagger.Cancel == nil {
		return nil, fail(503, "tagger_unavailable", "打标服务未接入")
	}
	inputs, e := s.Inputs(ctx, id, "tag", nil)
	if e != nil {
		return nil, e
	}
	paths := []string{}
	for _, in := range inputs {
		if in.Unavailable == "" {
			paths = append(paths, in.Path)
		}
	}
	if len(paths) == 0 {
		return nil, fail(422, "dataset_stage_empty", "tag 这一步没有可打标的图片")
	}
	s.mu.Lock()
	if s.starting[id+":tag"] {
		s.mu.Unlock()
		return nil, fail(409, "tagger_busy", "打标正在启动")
	}
	s.starting[id+":tag"] = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.starting, id+":tag"); s.mu.Unlock() }()
	tagCtx, cancel := context.WithCancel(s.ctx)
	stopRequest := context.AfterFunc(ctx, cancel)
	defer stopRequest()
	completion := make(chan Row, 1)
	var once sync.Once
	jobID, e := s.deps.Tagger.Tag(tagCtx, models, paths, batchSize, Row{"dataset_id": id, "stage": "tag"}, func(summary Row) {
		once.Do(func() { copy := Row{}; _ = json.Unmarshal([]byte(encode(summary)), &copy); completion <- copy })
	})
	if e != nil {
		cancel()
		return nil, e
	}
	run, e := s.startRun(ctx, id, "tag", jobID, Row{"models": models, "total": len(paths), "skipped": len(inputs) - len(paths)})
	if e != nil {
		cancel()
		_ = s.deps.Tagger.Cancel(context.Background(), jobID)
		return nil, e
	}
	j := &tagJob{runID: text(run["run_id"]), jobID: jobID, cancel: cancel, done: make(chan struct{})}
	s.mu.Lock()
	if s.stopped {
		cancel()
	}
	s.tags[j.runID] = j
	s.wg.Add(1)
	s.mu.Unlock()
	stopRequest()
	go func() {
		defer s.wg.Done()
		defer close(j.done)
		defer cancel()
		var summary Row
		select {
		case summary = <-completion:
		case <-tagCtx.Done():
			summary = Row{"status": "cancelled"}
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		status := text(summary["status"])
		if tagCtx.Err() != nil {
			status = "cancelled"
		}
		if status != "succeeded" && status != "failed" && status != "cancelled" {
			status = "failed"
		}
		last := object(summary["last_result"])
		total := number(last["total"])
		if total == 0 {
			total = int64(len(paths))
		}
		stats := Row{"models": models, "total": total, "skipped": len(inputs) - len(paths), "per_model": object(last["per_model"]), "decode_errors": len(anySlice(last["decode_errors"])), "unreadable": len(anySlice(last["unreadable"]))}
		code := ""
		if status == "failed" {
			code = "tagger_failed"
			if msg := text(summary["message"]); msg != "" {
				r := []rune(msg)
				stats["message"] = string(r[max(0, len(r)-500):])
			}
		}
		if status == "cancelled" {
			code = "tagger_cancelled"
		}
		_, _ = s.finishRun(context.Background(), j.runID, status, code, stats)
		delete(s.tags, j.runID)
	}()
	return run, nil
}
func (s *Service) CancelTag(ctx context.Context, runID string) (Row, error) {
	s.mu.Lock()
	j := s.tags[runID]
	if j != nil {
		j.cancel()
	}
	s.mu.Unlock()
	if j != nil {
		if s.deps.Tagger.Cancel != nil {
			if e := s.deps.Tagger.Cancel(ctx, j.jobID); e != nil {
				return nil, e
			}
		}
		select {
		case <-j.done:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return s.getRun(ctx, runID)
}
func (s *Service) WaitTag(ctx context.Context, runID string) (Row, error) {
	s.mu.Lock()
	j := s.tags[runID]
	s.mu.Unlock()
	if j != nil {
		select {
		case <-j.done:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return s.getRun(ctx, runID)
}
func anySlice(v any) []any {
	if v == nil {
		return nil
	}
	if a, ok := v.([]any); ok {
		return a
	}
	b, _ := json.Marshal(v)
	var a []any
	_ = json.Unmarshal(b, &a)
	return a
}
func stringsOf(v any) []string {
	out := []string{}
	for _, x := range anySlice(v) {
		out = append(out, text(x))
	}
	return out
}
func float(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case float32:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	case int:
		return float64(n)
	case int64:
		return float64(n)
	}
	return 0
}
func (s *Service) query(ctx context.Context, models []string, inputs []TagInput, floor float64) ([]Row, error) {
	lines := []string{}
	for _, in := range inputs {
		if in.Unavailable == "" {
			lines = append(lines, in.Line())
		}
	}
	if len(lines) == 0 {
		return []Row{}, nil
	}
	if s.deps.Tagger.Query == nil {
		return nil, fail(503, "tagger_unavailable", "打标服务未接入")
	}
	return s.deps.Tagger.Query(ctx, "candidates", models, lines, []string{"--floor", strconv.FormatFloat(floor, 'g', -1, 64)})
}
func headers(entries, lines []Row) []Row {
	for _, line := range lines {
		if text(line["type"]) == "models" {
			out := []Row{}
			for _, v := range anySlice(line["models"]) {
				r := object(encode(v))
				out = append(out, r)
			}
			return out
		}
	}
	out := []Row{}
	for _, e := range entries {
		defaults := object(e["default_thresholds"])
		cats := stringsOf(e["categories"])
		if len(cats) == 0 {
			for _, c := range categories {
				if _, ok := defaults[c]; ok {
					cats = append(cats, c)
				}
			}
		}
		out = append(out, Row{"key": e["key"], "adapter": e["adapter"], "revision": e["revision"], "fingerprint": "", "vocabulary_fingerprint": "", "vocabulary_size": 0, "categories": cats, "default_thresholds": defaults})
	}
	return out
}
func (s *Service) Candidates(ctx context.Context, id string, models []string, floor float64) (string, []byte, error) {
	ctx, done, err := s.begin(ctx)
	if err != nil {
		return "", nil, err
	}
	defer done()
	models, e := modelList(models)
	if e != nil {
		return "", nil, e
	}
	if math.IsNaN(floor) || floor < CandidateFloor || floor > 1 {
		return "", nil, fail(422, "validation_error", "floor 无效")
	}
	entries, e := s.catalog(ctx, models)
	if e != nil {
		return "", nil, e
	}
	inputs, e := s.Inputs(ctx, id, "tag", nil)
	if e != nil {
		return "", nil, e
	}
	s.candidateMu.Lock()
	defer s.candidateMu.Unlock()
	key := s.candidateKey(id, entries, inputs, floor)
	if etag, body, ok := s.cachedCandidate(key); ok {
		return etag, body, nil
	}
	lines, e := s.query(ctx, models, inputs, floor)
	if e != nil {
		return "", nil, e
	}
	body, e := CandidateBody(id, entries, inputs, lines, floor)
	if e != nil {
		return "", nil, e
	}
	sum := sha256.Sum256(body)
	etag := "\"" + hex.EncodeToString(sum[:20]) + "\""
	if e := ctx.Err(); e != nil {
		return "", nil, e
	}
	s.cacheCandidate(key, etag, body)
	return etag, body, nil
}
func CandidateBody(id string, entries []Row, inputs []TagInput, lines []Row, floor float64) ([]byte, error) {
	models := headers(entries, lines)
	keys := []string{}
	vocab := map[string][][2]string{}
	indexes := map[string]map[[2]string]int{}
	for _, m := range models {
		k := text(m["key"])
		keys = append(keys, k)
		vocab[k] = [][2]string{}
		indexes[k] = map[[2]string]int{}
	}
	byPath := map[string]Row{}
	for _, r := range lines {
		if text(r["type"]) == "candidates" {
			byPath[text(r["path"])] = r
		}
	}
	items := Row{}
	stats := map[string]int{"total": len(inputs), "ok": 0, "missing_scores": 0, "decode_error": 0, "unreadable": 0, "unavailable": 0}
	for _, in := range inputs {
		line := byPath[in.Path]
		if in.Unavailable != "" || line == nil {
			status, reason := "unreadable", "no_result"
			if in.Unavailable != "" {
				status = "unavailable"
				reason = in.Unavailable
			}
			items[in.AssetID] = Row{"status": status, "reason": reason, "missing_models": keys, "scores": Row{}}
			stats[status]++
			continue
		}
		scores := Row{}
		raw := object(line["models"])
		for _, key := range keys {
			if raw[key] == nil {
				continue
			}
			pairs := [][]any{}
			for _, candidate := range anySlice(raw[key]) {
				c := anySlice(candidate)
				if len(c) != 3 {
					return nil, fail(502, "tagger_query_failed", "候选分数格式无效")
				}
				name, category, score := text(c[0]), text(c[1]), float(c[2])
				if math.IsNaN(score) || math.IsInf(score, 0) {
					return nil, fail(502, "tagger_query_failed", "候选分数无效")
				}
				if category != "rating" && score < floor {
					continue
				}
				pair := [2]string{name, category}
				index, ok := indexes[key][pair]
				if !ok {
					index = len(vocab[key])
					indexes[key][pair] = index
					vocab[key] = append(vocab[key], pair)
				}
				pairs = append(pairs, []any{index, score})
			}
			scores[key] = pairs
		}
		status := text(line["status"])
		if status == "" {
			status = "ok"
		}
		if _, ok := stats[status]; !ok || status == "total" {
			return nil, fail(502, "tagger_query_failed", "候选状态无效")
		}
		stats[status]++
		items[in.AssetID] = Row{"status": status, "reason": "", "missing_models": stringsOf(line["missing_models"]), "scores": scores}
	}
	for _, m := range models {
		m["tags"] = vocab[text(m["key"])]
	}
	return json.Marshal(Row{"dataset_id": id, "floor": floor, "models": models, "items": items, "stats": stats})
}
func (s *Service) CaptionsFromTagger(ctx context.Context, id string, o FromTaggerOptions) (Row, error) {
	models, e := modelList(o.Models)
	if e != nil {
		return nil, e
	}
	if o.Mode != "merge" && o.Mode != "overwrite" && o.Mode != "fill_empty" {
		return nil, fail(422, "invalid_caption_mode", "未知 caption 模式")
	}
	if o.SampleLimit < 0 || o.SampleLimit > 200 {
		return nil, fail(422, "validation_error", "sample_limit 无效")
	}
	if o.Categories != nil && len(o.Categories) == 0 {
		return nil, fail(422, "validation_error", "类别不能为空")
	}
	for _, c := range o.Categories {
		if !slices.Contains(categories, c) {
			return nil, fail(422, "validation_error", "标签类别无效")
		}
	}
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer done()
	entries, e := s.catalog(ctx, models)
	if e != nil {
		return nil, e
	}
	defaults := map[string]Row{}
	for _, m := range entries {
		defaults[text(m["key"])] = object(m["default_thresholds"])
	}
	for model, values := range o.Thresholds {
		d, ok := defaults[model]
		if !ok {
			return nil, fail(422, "invalid_tagger_thresholds", "阈值对应的模型未选中")
		}
		for c, t := range values {
			if _, ok = d[c]; !ok {
				return nil, fail(422, "invalid_tagger_thresholds", "模型不支持该阈值类别")
			}
			if math.IsNaN(t) || t < .01 || t > .99 {
				return nil, fail(422, "validation_error", "阈值无效")
			}
		}
	}
	inputs, e := s.Inputs(ctx, id, "review", o.AssetIDs)
	if e != nil {
		return nil, e
	}
	lines, e := s.query(ctx, models, inputs, CandidateFloor)
	if e != nil {
		return nil, e
	}
	heads := headers(entries, lines)
	byPath := map[string]Row{}
	for _, r := range lines {
		if text(r["type"]) == "candidates" {
			byPath[text(r["path"])] = r
		}
	}
	effective := Row{}
	headByKey := map[string]Row{}
	for _, m := range heads {
		headByKey[text(m["key"])] = m
	}
	for _, key := range models {
		m := headByKey[key]
		thresholds := Row{}
		for c, t := range defaults[key] {
			thresholds[c] = t
		}
		for c, t := range o.Thresholds[key] {
			thresholds[c] = t
		}
		cats := o.Categories
		if len(cats) == 0 {
			cats = stringsOf(m["categories"])
		}
		effective[key] = Row{"fingerprint": m["fingerprint"], "thresholds": thresholds, "selected_categories": cats}
	}
	ids := []string{}
	tags := map[string][]string{}
	unavailable := map[string]string{}
	for _, in := range inputs {
		ids = append(ids, in.AssetID)
		if in.Unavailable != "" {
			unavailable[in.AssetID] = in.Unavailable
			continue
		}
		line := byPath[in.Path]
		if line == nil {
			unavailable[in.AssetID] = "no_tagger_result"
			continue
		}
		if text(line["status"]) != "ok" {
			unavailable[in.AssetID] = text(line["status"])
			continue
		}
		out := []string{}
		raw := object(line["models"])
		for _, key := range models {
			eff := object(effective[key])
			thresholds := object(eff["thresholds"])
			for _, category := range stringsOf(eff["selected_categories"]) {
				threshold := .5
				if category == "rating" {
					threshold = 0
				}
				if value, ok := thresholds[category]; ok {
					threshold = float(value)
				}
				bestScore := -1.0
				best := ""
				selected := []string{}
				for _, v := range anySlice(raw[key]) {
					c := anySlice(v)
					if len(c) != 3 {
						return nil, fail(502, "tagger_query_failed", "候选分数格式无效")
					}
					if text(c[1]) != category {
						continue
					}
					score := float(c[2])
					name := text(c[0])
					if category == "rating" {
						if score > bestScore {
							bestScore = score
							best = name
						}
					} else if score >= threshold {
						selected = append(selected, name)
					}
				}
				if category == "rating" && best != "" && bestScore >= threshold {
					selected = append(selected, best)
				}
				for _, name := range selected {
					if !o.KeepUnderscores && plainTag.MatchString(name) {
						name = strings.ReplaceAll(name, "_", " ")
					}
					if o.EscapeParens {
						name = strings.ReplaceAll(strings.ReplaceAll(name, "(", `\(`), ")", `\)`)
					}
					out = append(out, name)
				}
			}
		}
		tags[in.AssetID] = captions.Parse(captions.Format(captions.Dedupe(out)))
	}
	if s.deps.ApplyCaptions == nil {
		return nil, fail(503, "captions_unavailable", "caption 服务未接入")
	}
	params := Row{"models": models, "thresholds": o.Thresholds, "categories": o.Categories, "keep_underscores": o.KeepUnderscores, "escape_parens": o.EscapeParens, "effective": effective}
	return s.deps.ApplyCaptions(ctx, id, captions.TaggerOptions{Tags: tags, Unavailable: unavailable, AssetIDs: ids, Mode: o.Mode, Params: params, DryRun: o.DryRun, SampleLimit: o.SampleLimit})
}
