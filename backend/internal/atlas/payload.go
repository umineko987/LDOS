package atlas

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

func text(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	}
	return ""
}
func number(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case json.Number:
		n, _ := x.Float64()
		return n
	}
	return 0
}
func object(v any) Record {
	if r, ok := v.(map[string]any); ok {
		return r
	}
	return Record{}
}
func array(v any) []any {
	switch a := v.(type) {
	case []any:
		return a
	case []Record:
		out := make([]any, len(a))
		for i, v := range a {
			out[i] = v
		}
		return out
	}
	return []any{}
}
func scalar(v any) string {
	if v == nil {
		return "None"
	}
	return fmt.Sprint(v)
}
func Fingerprint(member Record) string {
	if hash := text(member["content_sha256"]); hash != "" {
		return hash
	}
	return scalar(member["size_bytes"]) + ":" + scalar(member["modified_ns"])
}
func inputs(members []Record) map[string]string {
	v := map[string]string{}
	for _, m := range members {
		v[text(m["asset_id"])] = Fingerprint(m)
	}
	return v
}

// Digest preserves Python json.dumps(sort_keys=True) formatting for the two
// supported numeric options, so existing run.json results remain reusable.
func Digest(in map[string]string, options Record) string {
	h := sha256.New()
	ids := make([]string, 0, len(in))
	for id := range in {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		h.Write([]byte(id + "\x00" + in[id] + "\n"))
	}
	keys := make([]string, 0, len(options))
	for k := range options {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := []string{}
	for _, k := range keys {
		v := options[k]
		if k == "perplexity" {
			v = number(v)
		}
		value := ""
		switch n := v.(type) {
		case float64:
			value = strconv.FormatFloat(n, 'f', -1, 64)
			if !strings.Contains(value, ".") {
				value += ".0"
			}
		default:
			b, _ := json.Marshal(v)
			value = string(b)
		}
		key, _ := json.Marshal(k)
		parts = append(parts, string(key)+": "+value)
	}
	h.Write([]byte("{" + strings.Join(parts, ", ") + "}"))
	return hex.EncodeToString(h.Sum(nil))
}
func ETagMatches(condition, etag string) bool {
	for _, v := range strings.Split(condition, ",") {
		v = strings.TrimSpace(v)
		if v == etag || v == "*" {
			return true
		}
	}
	return false
}
func (s *Service) Status(ctx context.Context, id string) (Record, error) {
	v, _, e := s.build(ctx, id, false, "")
	return v, e
}
func (s *Service) Payload(ctx context.Context, id, condition string) (Record, string, error) {
	return s.build(ctx, id, true, condition)
}
func (s *Service) build(ctx context.Context, id string, full bool, condition string) (Record, string, error) {
	dataset, e := s.require(ctx, id)
	if e != nil {
		return nil, "", e
	}
	snapshot := s.State(id)
	run := s.current(id)
	loaded, ok := s.loadRun(id, run)
	members, e := s.members(ctx, id)
	if e != nil {
		return nil, "", e
	}
	current := inputs(members)
	old := object(loaded.meta["inputs"])
	options := object(loaded.meta["options"])
	digest := Digest(current, options)
	added, changed := 0, 0
	for id, v := range current {
		previous, exists := old[id]
		if !exists {
			added++
		} else if text(previous) != v {
			changed++
		}
	}
	atlasItems := array(loaded.payload["items"])
	removed := []string{}
	for _, v := range atlasItems {
		item := object(v)
		if _, exists := current[text(item["asset_id"])]; !exists {
			removed = append(removed, text(item["asset_id"]))
		}
	}
	stale := ok && (added > 0 || changed > 0)
	status := "none"
	if snapshot["running"] == true {
		status = "running"
	} else if snapshot["error"] != nil {
		status = "failed"
	} else if ok {
		status = "ready"
		if stale {
			status = "stale"
		}
	}
	trigger := strings.TrimSpace(text(dataset["trigger_word"]))
	captionSignature := sha1.New()
	captionSignature.Write([]byte(trigger + "\n"))
	for _, m := range members {
		parts := []string{}
		for _, k := range []string{"asset_id", "name", "txt_version", "txt_state", "txt_size_bytes", "txt_modified_ns"} {
			parts = append(parts, scalar(m[k]))
		}
		captionSignature.Write([]byte(strings.Join(parts, "\x00") + "\n"))
	}
	var runValue any
	if run != "" {
		runValue = run
	}
	etagInput, _ := json.Marshal([]any{runValue, status, snapshot["progress"], snapshot["error"], digest, snapshot["availability"], hex.EncodeToString(captionSignature.Sum(nil))})
	sum := sha1.Sum(etagInput)
	etag := "W/\"" + hex.EncodeToString(sum[:])[:32] + "\""
	if full && ETagMatches(condition, etag) {
		return nil, etag, nil
	}
	result := Record{"dataset_id": id, "status": status, "progress": snapshot["progress"], "error": snapshot["error"], "availability": snapshot["availability"], "running_run_id": snapshot["run_id"], "cached": false, "run": nil, "stale": stale, "current_digest": digest, "delta": Record{"added": added, "changed": changed, "removed_asset_ids": removed}}
	if ok {
		result["run"] = Record{"run_id": run, "input_digest": loaded.meta["input_digest"], "started_at": loaded.meta["started_at"], "finished_at": loaded.meta["finished_at"], "options": options, "method": loaded.payload["method"], "params": object(loaded.payload["params"]), "counts": object(loaded.payload["counts"])}
	}
	if !full {
		return result, etag, nil
	}
	names := map[string]string{}
	for _, m := range members {
		names[text(m["asset_id"])] = text(m["name"])
	}
	items := []Record{}
	live := []Record{}
	sizes := map[int]int{}
	for _, v := range atlasItems {
		item := clone(object(v))
		id := text(item["asset_id"])
		item["name"] = nil
		if name, exists := names[id]; exists {
			item["name"] = name
		}
		items = append(items, item)
		if _, exists := current[id]; exists {
			live = append(live, item)
			sizes[int(number(item["cluster"]))]++
		}
	}
	captions, e := s.captions(ctx, live)
	if e != nil {
		return nil, "", e
	}
	top := topTags(live, captions, trigger)
	clusters := []Record{}
	over := []Record{}
	for _, v := range array(loaded.payload["clusters"]) {
		cluster := clone(object(v))
		key := int(number(cluster["id"]))
		size := sizes[key]
		share := 0.0
		if len(live) > 0 {
			share = math.RoundToEven(float64(size)/float64(len(live))*1e6) / 1e6
		}
		tags := top[key]
		if tags == nil {
			tags = []string{}
		}
		cluster["live_size"], cluster["live_share"], cluster["top_tags"] = size, share, tags
		clusters = append(clusters, cluster)
		if share > .08 {
			over = append(over, Record{"cluster": cluster["id"], "share": share, "size": size})
		}
	}
	params := object(loaded.payload["params"])
	threshold := 1.0
	if v, exists := params["outlier_threshold"]; exists {
		threshold = number(v)
	}
	outliers := []Record{}
	for _, v := range live {
		if number(v["outlier"]) >= threshold {
			outliers = append(outliers, v)
		}
	}
	sort.SliceStable(outliers, func(i, j int) bool {
		a, b := number(outliers[i]["outlier"]), number(outliers[j]["outlier"])
		if a != b {
			return a > b
		}
		return text(outliers[i]["asset_id"]) < text(outliers[j]["asset_id"])
	})
	outlierIDs := []string{}
	for _, v := range outliers {
		outlierIDs = append(outlierIDs, text(v["asset_id"]))
	}
	var sprites any
	if v, exists := loaded.payload["sprites"].(map[string]any); exists {
		out := Record{}
		for _, key := range []string{"format", "sheet_size", "cell_size", "columns", "per_sheet"} {
			out[key] = v[key]
		}
		urls := []string{}
		for i := range array(v["sheets"]) {
			urls = append(urls, fmt.Sprintf("/api/v1/datasets/%s/atlas/sprites/%d?run=%s", id, i, run))
		}
		out["urls"] = urls
		sprites = out
	}
	skipped := append(append([]any{}, array(loaded.meta["skipped"])...), array(loaded.payload["skipped"])...)
	result["items"], result["clusters"], result["vectors"], result["sprites"], result["skipped"] = items, clusters, loaded.payload["vectors"], sprites, skipped
	result["hints"] = Record{"share_threshold": .08, "outlier_threshold": threshold, "over_represented": over, "outliers": outlierIDs}
	return result, etag, nil
}
func (s *Service) captions(ctx context.Context, items []Record) (map[string]string, error) {
	ids := []string{}
	for _, v := range items {
		ids = append(ids, text(v["asset_id"]))
	}
	if s.deps.Gallery.Captions != nil {
		return s.deps.Gallery.Captions(ctx, ids)
	}
	result := map[string]string{}
	for start := 0; start < len(ids); start += 400 {
		end := min(start+400, len(ids))
		args := []any{}
		marks := []string{}
		for _, id := range ids[start:end] {
			args = append(args, id)
			marks = append(marks, "?")
		}
		rows, e := s.deps.Store.QueryRows(ctx, "SELECT asset_id,txt_content FROM gallery_search_index WHERE asset_id IN ("+strings.Join(marks, ",")+")", args...)
		if e != nil {
			return nil, e
		}
		for _, r := range rows {
			result[text(r["asset_id"])] = text(r["txt_content"])
		}
	}
	return result, nil
}
func topTags(items []Record, captions map[string]string, trigger string) map[int][]string {
	counts := map[int]map[string]int{}
	for _, item := range items {
		cluster := int(number(item["cluster"]))
		if counts[cluster] == nil {
			counts[cluster] = map[string]int{}
		}
		seen := map[string]bool{}
		for _, tag := range strings.FieldsFunc(captions[text(item["asset_id"])], func(r rune) bool { return r == ',' || r == '\r' || r == '\n' }) {
			tag = strings.TrimSpace(tag)
			if tag != "" && tag != trigger && !seen[tag] {
				seen[tag] = true
				counts[cluster][tag]++
			}
		}
	}
	result := map[int][]string{}
	for cluster, counts := range counts {
		tags := []string{}
		for tag := range counts {
			tags = append(tags, tag)
		}
		sort.Slice(tags, func(i, j int) bool {
			if counts[tags[i]] != counts[tags[j]] {
				return counts[tags[i]] > counts[tags[j]]
			}
			return tags[i] < tags[j]
		})
		result[cluster] = tags[:min(3, len(tags))]
	}
	return result
}
