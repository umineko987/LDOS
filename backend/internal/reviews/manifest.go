package reviews

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"

	"ldos/backend/internal/store"
)

func validateManifest(input WorkerInput, m Manifest) error {
	if m.SchemaVersion < 1 || m.SchemaVersion > 3 {
		return fmt.Errorf("去重审核清单版本无效")
	}
	var options *FilterOptions
	var inputs map[string]Snapshot
	if input.ReviewID != "" {
		if m.SchemaVersion != 3 || m.ReviewID != input.ReviewID {
			return fmt.Errorf("图库审核清单身份不匹配")
		}
		inputs = map[string]Snapshot{}
		for _, v := range input.Images {
			inputs[v.AssetID] = v
		}
	} else {
		root, e := filepath.Abs(m.Root)
		expected, e2 := filepath.Abs(input.OutputDir)
		if e != nil || e2 != nil || m.Root == "" || root != expected {
			return fmt.Errorf("审核清单批次目录不匹配")
		}
	}
	if input.FilterConfig != nil {
		if !reflect.DeepEqual(input.FilterConfig, m.FilterConfig) {
			return fmt.Errorf("图库审核过滤配置快照不匹配")
		}
		options = &input.FilterConfig.Options
	} else if m.FilterConfig != nil {
		return fmt.Errorf("清单包含未请求的过滤配置")
	}
	if options != nil && !options.BasicDedup && len(m.AutoGroups) > 0 {
		return fmt.Errorf("基础去重已关闭，但清单仍自动淘汰重复图片")
	}
	if m.Groups == nil {
		return fmt.Errorf("审核清单缺少 groups")
	}
	groups, images, paths := map[string]bool{}, map[string]bool{}, map[string]bool{}
	manual, filtered := map[string]bool{}, map[string]bool{}
	groupCheck := func(g ManifestGroup) error {
		if !validID(g.ID) || groups[g.ID] {
			return fmt.Errorf("审核组 ID 无效或重复")
		}
		groups[g.ID] = true
		return nil
	}
	imageCheck := func(im ManifestImage, count bool) error {
		if !validID(im.ID) || im.RelativePath == "" {
			return fmt.Errorf("审核图片身份无效")
		}
		if inputs != nil {
			v, ok := inputs[im.ID]
			if !ok || im.RelativePath != v.SourceID+"/"+v.RelativePath {
				return fmt.Errorf("清单包含快照范围外图片")
			}
		} else {
			if e := checkPath(input.OutputDir, im.RelativePath); e != nil {
				return e
			}
		}
		classification := text(im.Metadata["classification"])
		if classification != "" {
			if options == nil || (classification != "rough" && classification != "monochrome") || classification == "rough" && !options.FilterSketch || classification == "monochrome" && !options.FilterMonochrome {
				return fmt.Errorf("清单包含无效或未启用的辅助分类")
			}
		}
		if count {
			if images[im.ID] || paths[im.RelativePath] {
				return fmt.Errorf("清单图片 ID 或路径重复")
			}
			images[im.ID] = true
			paths[im.RelativePath] = true
		}
		if _, e := json.Marshal(im.Metadata); e != nil {
			return fmt.Errorf("清单包含无效元数据")
		}
		return nil
	}
	ordinals := map[int]bool{}
	for n, g := range m.Groups {
		if e := groupCheck(g); e != nil {
			return e
		}
		if g.Kind != "single" && g.Kind != "duplicate" && g.Kind != "unreadable" {
			return fmt.Errorf("人工审核组类型无效")
		}
		if len(g.Items) == 0 || g.Kind == "duplicate" && len(g.Items) < 2 {
			return fmt.Errorf("审核组图片数量无效")
		}
		if options != nil && !options.SimilarityGroups && len(g.Items) != 1 {
			return fmt.Errorf("相似分组已关闭")
		}
		ordinal := g.Ordinal
		if ordinal == 0 {
			ordinal = n + 1
		}
		if ordinal < 1 || ordinals[ordinal] {
			return fmt.Errorf("审核组序号无效或重复")
		}
		ordinals[ordinal] = true
		for _, im := range g.Items {
			if e := imageCheck(im, true); e != nil {
				return e
			}
			manual[im.RelativePath] = true
		}
	}
	for _, im := range m.FilteredItems {
		if im.Reason != "filter_character" || options == nil || !options.FilterCharacter {
			return fmt.Errorf("清单包含未启用的自动过滤")
		}
		if e := imageCheck(im, true); e != nil {
			return e
		}
		filtered[im.RelativePath] = true
	}
	for _, g := range m.AutoGroups {
		if e := groupCheck(g); e != nil {
			return e
		}
		if g.Kind != "exact" && g.Kind != "compression" {
			return fmt.Errorf("自动去重组类型无效")
		}
		if e := imageCheck(g.Winner, false); e != nil {
			return e
		}
		if len(g.RejectedItems) == 0 {
			return fmt.Errorf("自动去重组没有淘汰图片")
		}
		for _, im := range g.RejectedItems {
			if e := imageCheck(im, true); e != nil {
				return e
			}
		}
		if !manual[g.Winner.RelativePath] && !filtered[g.Winner.RelativePath] {
			return fmt.Errorf("自动去重保留图未进入人工审核或自动过滤")
		}
	}
	if inputs != nil && len(inputs) != len(images) {
		return fmt.Errorf("图库审核清单未完整覆盖所选快照")
	}
	if m.Counts["images"] != len(images) {
		return fmt.Errorf("审核清单图片计数不一致")
	}
	// Derived filtered group identities also share the same namespace.
	for _, im := range m.FilteredItems {
		if groups["filtered:"+im.ID] {
			return fmt.Errorf("自动过滤组 ID 冲突")
		}
	}
	return nil
}

func (s *Service) replaceManifest(ctx context.Context, i identity, m Manifest, logPath string) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		if e := ensureModern(ctx, tx, i); e != nil {
			return e
		}
		r, g, im, c := i.tables()
		row, e := store.QueryRowTx(ctx, tx, "SELECT status FROM "+r+" WHERE "+c+"=?", i.id)
		if e != nil {
			return e
		}
		if row == nil || text(row["status"]) != "analyzing" {
			return conflict("审核任务未处于分析状态")
		}
		if _, e = tx.ExecContext(ctx, "DELETE FROM "+g+" WHERE "+c+"=?", i.id); e != nil {
			return e
		}
		imageCount, duplicateCount, unreadableCount, autoRejected, maxOrdinal := 0, 0, 0, 0, 0
		writeGroup := func(id, kind string, ordinal int, levels []any, reason string, items []ManifestImage, decided bool, extra Row) error {
			if levels == nil {
				levels = []any{}
			}
			if _, e := tx.ExecContext(ctx, "INSERT INTO "+g+"("+c+",id,ordinal,kind,match_levels_json,reason,decided,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", i.id, strings.TrimSpace(id), ordinal, kind, encode(levels), clip(safeText(reason), 1000), decided, now(), now()); e != nil {
				return e
			}
			for n, v := range items {
				metadata := Row{}
				for key, value := range v.Metadata {
					metadata[key] = value
				}
				for key, value := range extra {
					metadata[key] = value
				}
				if v.ReviewMetrics != nil {
					metadata["review_metrics"] = v.ReviewMetrics
				}
				readable := v.Readable == nil || *v.Readable
				imageCount++
				if !readable {
					unreadableCount++
				}
				ord := v.Ordinal
				if ord == 0 {
					ord = n + 1
				}
				b, e := json.Marshal(metadata)
				if e != nil {
					return e
				}
				if _, e = tx.ExecContext(ctx, "INSERT INTO "+im+"("+c+",id,group_id,ordinal,relative_path,file_hash,metadata_json,readable,recommended,selected,disposition,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)", i.id, strings.TrimSpace(v.ID), strings.TrimSpace(id), ord, v.RelativePath, text(metadata["file_hash"]), string(b), readable, v.Recommended, !decided, now(), now()); e != nil {
					return e
				}
			}
			return nil
		}
		for n, v := range m.Groups {
			ord := v.Ordinal
			if ord == 0 {
				ord = n + 1
			}
			if ord > maxOrdinal {
				maxOrdinal = ord
			}
			if v.Kind == "duplicate" {
				duplicateCount++
			}
			if e = writeGroup(v.ID, v.Kind, ord, v.MatchLevels, v.Reason, v.Items, false, nil); e != nil {
				return e
			}
		}
		for _, v := range m.AutoGroups {
			maxOrdinal++
			autoRejected += len(v.RejectedItems)
			if e = writeGroup(v.ID, "auto_"+v.Kind, maxOrdinal, v.MatchLevels, v.Reason, v.RejectedItems, true, Row{"automatic_dedup": Row{"kind": v.Kind, "winner_relative_path": v.Winner.RelativePath, "reason": v.Reason}}); e != nil {
				return e
			}
		}
		for _, v := range m.FilteredItems {
			maxOrdinal++
			autoRejected++
			if e = writeGroup("filtered:"+v.ID, "auto_filtered", maxOrdinal, nil, v.Reason, []ManifestImage{v}, true, Row{"automatic_filter": Row{"reason": v.Reason}}); e != nil {
				return e
			}
		}
		state := "ready"
		var ready any = now()
		if autoRejected > 0 {
			state = "auto_applying"
			ready = nil
		}
		_, e = tx.ExecContext(ctx, "UPDATE "+r+" SET status=?,total_image_count=?,total_group_count=?,duplicate_group_count=?,unreadable_image_count=?,automatic_group_count=?,automatic_rejected_image_count=?,kept_image_count=0,rejected_image_count=0,failed_image_count=0,error='',analysis_log_path=?,ready_at=?,updated_at=? WHERE "+c+"=?", state, imageCount, len(m.Groups), duplicateCount, unreadableCount, len(m.AutoGroups), autoRejected, logPath, ready, now(), i.id)
		return e
	})
}
