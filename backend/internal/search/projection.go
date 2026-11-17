package search

import (
	"bytes"
	"encoding/json"

	"ldos/backend/internal/redaction"
)

func values(value any) []any {
	switch list := value.(type) {
	case []any:
		return list
	case []map[string]any:
		result := make([]any, len(list))
		for i, item := range list {
			result[i] = item
		}
		return result
	case []string:
		result := make([]any, len(list))
		for i, item := range list {
			result[i] = item
		}
		return result
	}
	return nil
}
func objectValue(value any) map[string]any { row, _ := value.(map[string]any); return row }
func integer(value any) (int, bool) {
	switch n := value.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case bool:
		if n {
			return 1, true
		}
		return 0, true
	case json.Number:
		i, err := n.Int64()
		return int(i), err == nil
	}
	return 0, false
}
func shortStrings(value any, maximum, length int) []string {
	list := values(value)
	result := []string{}
	for _, item := range list[:min(maximum, len(list))] {
		if item != nil {
			result = append(result, truncate(valueText(item), length))
		}
	}
	return result
}

// The existing desktop budget measures Python ensure_ascii JSON, including one
// separator per row. Count that encoding instead of the smaller UTF-8 payload.
func asciiRowSize(row map[string]any) int {
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(row)
	data := bytes.TrimSuffix(output.Bytes(), []byte("\n"))
	size := 1
	for _, r := range string(data) {
		switch {
		case r >= 0x10000:
			size += 12
		case r >= 0x7f:
			size += 6
		default:
			size++
		}
	}
	return size
}
func bounded(input []any, project func(any) map[string]any, maximum, budget int) ([]map[string]any, int, bool) {
	result := []map[string]any{}
	used := 0
	for _, value := range input {
		if len(result) >= maximum {
			break
		}
		row := project(value)
		size := asciiRowSize(row)
		if used+size > budget {
			break
		}
		result = append(result, row)
		used += size
	}
	return result, used, len(result) < len(input)
}
func desktopCandidate(value any) map[string]any {
	row := objectValue(value)
	projected := map[string]any{}
	for key, limit := range map[string]int{"id": 200, "url": 8192, "address_type": 100, "label": 200, "tag": 200, "title": 200, "confidence": 32, "origin": 64, "thumbnail_url": 2048} {
		if field := row[key]; field != nil {
			projected[key] = truncate(valueText(field), limit)
		}
	}
	if n, ok := integer(row["media_count"]); ok {
		projected["media_count"] = max(0, n)
	}
	projected["evidence_reasons"] = shortStrings(row["evidence_reasons"], 12, 80)
	projected["related_profile_count"] = min(len(values(row["related_profiles"])), 1000)
	metadata := objectValue(row["metadata"])
	projected["metadata"] = map[string]any{"tags": shortStrings(metadata["tags"], 160, 180)}
	return projected
}
func desktopFacet(value any) map[string]any {
	row := objectValue(value)
	tags := []map[string]any{}
	list := values(row["tags"])
	for _, value := range list[:min(160, len(list))] {
		item, ok := value.(map[string]any)
		if !ok {
			continue
		}
		n, _ := integer(item["count"])
		tags = append(tags, map[string]any{"tag": truncate(valueText(item["tag"]), 180), "count": n})
	}
	n, _ := integer(row["gallery_count"])
	return map[string]any{"namespace": truncate(valueText(row["namespace"]), 80), "label": truncate(valueText(row["label"]), 80), "gallery_count": n, "tags": tags}
}
func desktopProfile(value any) map[string]any {
	row := objectValue(value)
	return map[string]any{"artist_name": truncate(valueText(row["artist_name"]), 100), "platform": truncate(valueText(row["platform"]), 40), "url": truncate(valueText(row["url"]), 2048)}
}
func Desktop(value map[string]any) map[string]any {
	sources := values(value["sources"])
	truncated := len(sources) > 5
	projected := []map[string]any{}
	candidates, bytesLeft, facets, facetBytes := 1000, 8<<20, 32, 1<<20
	for _, raw := range sources[:min(5, len(sources))] {
		source := objectValue(raw)
		detail := objectValue(source["error"])
		auth := objectValue(source["auth"])
		addresses, used, cut := bounded(values(source["addresses"]), desktopCandidate, candidates, bytesLeft)
		candidates -= len(addresses)
		bytesLeft -= used
		truncated = truncated || cut
		weak, used, cut := bounded(values(source["weak_evidence"]), desktopCandidate, candidates, bytesLeft)
		candidates -= len(weak)
		bytesLeft -= used
		truncated = truncated || cut
		tags, used, cut := bounded(values(source["tag_facets"]), desktopFacet, facets, facetBytes)
		facets -= len(tags)
		facetBytes -= used
		truncated = truncated || cut
		status := valueText(source["status"])
		if status == "" {
			status = "failed"
		}
		state := valueText(auth["state"])
		if state == "" {
			state = "unknown"
		}
		row := map[string]any{"site": truncate(valueText(source["site"]), 128), "status": truncate(status, 32), "alias_keywords": shortStrings(source["alias_keywords"], 8, 80), "error": map[string]any{"code": truncate(valueText(detail["code"]), 128), "message": redaction.Text(valueText(detail["message"]), 500)}, "enrichment_error_count": min(len(values(source["enrichment_errors"])), 1000), "auth": map[string]any{"state": truncate(state, 32), "authorized": auth["authorized"] == true}, "tag_facets": tags, "addresses": addresses, "weak_evidence": weak}
		for _, key := range []string{"evidence_count", "preview_count", "attempts"} {
			n, _ := integer(source[key])
			row[key] = n
		}
		projected = append(projected, row)
	}
	profileValues := []any{}
	for _, item := range values(value["related_profiles"]) {
		if _, ok := item.(map[string]any); ok {
			profileValues = append(profileValues, item)
		}
	}
	profiles, _, cut := bounded(profileValues, desktopProfile, 80, 512<<10)
	return map[string]any{"response_profile": "desktop", "projection_truncated": truncated || cut, "candidate_limit": 1000, "sources": projected, "related_profiles": profiles}
}
