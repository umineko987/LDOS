package datasetstages

import (
	"context"
	"path"
	"slices"
	"strings"
)

type PageOptions struct {
	State, Reason    string
	IncludeAutomatic bool
	Offset, Limit    int
}

const assetColumns = `a.name AS asset_name,a.relative_path AS asset_relative_path,a.source_id AS asset_source_id,a.width AS asset_width,a.height AS asset_height,a.size_bytes AS asset_size,a.format AS asset_format,a.lifecycle_state AS asset_lifecycle`

func member(reviewID string, r Row, decisions map[string]Row) Row {
	metadata := object(r["metadata_json"])
	asset := text(r["id"])
	reviewPath := text(r["relative_path"])
	source, relative, _ := strings.Cut(reviewPath, "/")
	if text(r["asset_relative_path"]) != "" {
		relative = text(r["asset_relative_path"])
	}
	if text(r["asset_source_id"]) != "" {
		source = text(r["asset_source_id"])
	}
	name := text(r["asset_name"])
	if name == "" {
		name = path.Base(relative)
	}
	quality := Row{}
	for _, k := range []string{"sharpness", "blockiness", "noise_sigma", "jpeg_quality"} {
		switch v := metadata[k].(type) {
		case float64, int, int64:
			quality[k] = v
		}
	}
	width, height, size := number(metadata["w"]), number(metadata["h"]), number(metadata["size"])
	if width == 0 {
		width = number(r["asset_width"])
	}
	if height == 0 {
		height = number(r["asset_height"])
	}
	if size == 0 {
		size = number(r["asset_size"])
	}
	format := text(metadata["format"])
	if format == "" {
		format = text(r["asset_format"])
	}
	var classification, decision, metrics any
	if c := text(metadata["classification"]); c == "rough" || c == "monochrome" {
		classification = c
	}
	if d := decisions[asset]; d != nil {
		decision = d["decision"]
	}
	if m, ok := metadata["review_metrics"].(map[string]any); ok {
		metrics = m
	}
	return Row{"asset_id": asset, "source_id": source, "name": name, "relative_path": relative, "thumbnail_url": "/api/v1/gallery/assets/" + asset + "/thumbnail?size=256", "image_url": "/api/v1/gallery/reviews/" + reviewID + "/images/" + asset, "width": width, "height": height, "size_bytes": size, "format": format, "readable": truth(r["readable"]), "recommended": truth(r["recommended"]), "selected": truth(r["selected"]), "disposition": text(r["disposition"]), "trashed": text(r["asset_lifecycle"]) == "trashed", "classification": classification, "quality": quality, "review_metrics": metrics, "decision": decision, "error": text(r["error"])}
}
func pageValidate(o PageOptions, max int) error {
	if o.State != "" && o.State != "all" && o.State != "pending" && o.State != "decided" {
		return fail(422, "validation_error", "state 无效")
	}
	if o.Offset < 0 || o.Limit < 1 || o.Limit > max {
		return fail(422, "validation_error", "分页参数无效")
	}
	return nil
}
func (s *Service) DedupGroups(ctx context.Context, id string, o PageOptions) (Row, error) {
	if e := pageValidate(o, 100); e != nil {
		return nil, e
	}
	s.triage.Lock()
	defer s.triage.Unlock()
	run, _, e := s.contextLocked(ctx, id, "dedup", "")
	if e != nil {
		return nil, e
	}
	rid := text(run["ref_id"])
	groups, e := s.deps.Store.QueryRows(ctx, "SELECT * FROM gallery_review_groups WHERE review_id=? ORDER BY ordinal", rid)
	if e != nil {
		return nil, e
	}
	selected := []Row{}
	for _, g := range groups {
		kind := text(g["kind"])
		if kind != "duplicate" && kind != "unreadable" && !(o.IncludeAutomatic && (kind == "auto_exact" || kind == "auto_compression")) {
			continue
		}
		if o.State == "pending" && truth(g["decided"]) || o.State == "decided" && !truth(g["decided"]) {
			continue
		}
		selected = append(selected, g)
	}
	total := len(selected)
	selected = selected[min(o.Offset, total):min(o.Offset+o.Limit, total)]
	decisions, e := s.decisions(ctx, id, "dedup")
	if e != nil {
		return nil, e
	}
	items := []Row{}
	for _, g := range selected {
		rows, e := s.deps.Store.QueryRows(ctx, "SELECT i.*,"+assetColumns+" FROM gallery_review_images i LEFT JOIN gallery_assets a ON a.id=i.id WHERE i.review_id=? AND i.group_id=? ORDER BY i.ordinal", rid, g["id"])
		if e != nil {
			return nil, e
		}
		members := []Row{}
		suggested := []string{}
		for _, r := range rows {
			m := member(rid, r, decisions)
			members = append(members, m)
			if truth(m["recommended"]) {
				suggested = append(suggested, text(m["asset_id"]))
			}
		}
		var winner any
		auto := strings.HasPrefix(text(g["kind"]), "auto_")
		if auto && len(rows) > 0 {
			wanted := text(object(object(rows[0]["metadata_json"])["automatic_dedup"])["winner_relative_path"])
			if wanted != "" {
				r, e := s.deps.Store.QueryRow(ctx, "SELECT id FROM gallery_review_images WHERE review_id=? AND relative_path=?", rid, wanted)
				if e != nil {
					return nil, e
				}
				if r != nil {
					winner = r["id"]
				}
			}
		}
		levels := stringsOfJSON(g["match_levels_json"])
		items = append(items, Row{"group_id": g["id"], "kind": g["kind"], "automatic": auto, "decided": truth(g["decided"]), "match_levels": levels, "reason": text(g["reason"]), "suggested_keep": suggested, "winner_asset_id": winner, "members": members})
	}
	return Row{"run_id": run["run_id"], "review_id": rid, "total": total, "offset": o.Offset, "limit": o.Limit, "items": items}, nil
}
func (s *Service) CleanItems(ctx context.Context, id string, o PageOptions) (Row, error) {
	if e := pageValidate(o, 200); e != nil {
		return nil, e
	}
	if o.Reason != "" && !slices.Contains([]string{"monochrome", "rough", "filter_character", "unreadable"}, o.Reason) {
		return nil, fail(422, "validation_error", "reason 无效")
	}
	s.triage.Lock()
	defer s.triage.Unlock()
	run, _, e := s.contextLocked(ctx, id, "clean", "")
	if e != nil {
		return nil, e
	}
	rid := text(run["ref_id"])
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT i.*,g.kind,g.decided,"+assetColumns+" FROM gallery_review_images i JOIN gallery_review_groups g ON g.review_id=i.review_id AND g.id=i.group_id LEFT JOIN gallery_assets a ON a.id=i.id WHERE i.review_id=? ORDER BY g.ordinal,i.ordinal", rid)
	if e != nil {
		return nil, e
	}
	decisions, e := s.decisions(ctx, id, "clean")
	if e != nil {
		return nil, e
	}
	items := []Row{}
	for _, r := range rows {
		if !flagged(r) || o.State == "pending" && truth(r["decided"]) || o.State == "decided" && !truth(r["decided"]) {
			continue
		}
		reasons := []string{}
		if text(r["kind"]) == "auto_filtered" {
			reasons = append(reasons, "filter_character")
		}
		if c := text(object(r["metadata_json"])["classification"]); c == "rough" || c == "monochrome" {
			reasons = append(reasons, c)
		}
		if !truth(r["readable"]) || text(r["kind"]) == "unreadable" {
			reasons = append(reasons, "unreadable")
		}
		if o.Reason != "" && !slices.Contains(reasons, o.Reason) {
			continue
		}
		m := member(rid, r, decisions)
		m["group_id"] = r["group_id"]
		m["group_kind"] = r["kind"]
		m["automatic"] = strings.HasPrefix(text(r["kind"]), "auto_")
		m["decided"] = truth(r["decided"])
		m["reasons"] = reasons
		items = append(items, m)
	}
	total := len(items)
	items = items[min(o.Offset, total):min(o.Offset+o.Limit, total)]
	return Row{"run_id": run["run_id"], "review_id": rid, "total": total, "offset": o.Offset, "limit": o.Limit, "items": items}, nil
}
