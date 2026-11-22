package reviews

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"ldos/backend/internal/redaction"
)

func validID(id string) bool {
	return utf8.ValidString(id) && len([]rune(id)) > 0 && len([]rune(id)) <= 128 && strings.TrimSpace(id) == id && !strings.ContainsAny(id, "\x00\r\n")
}
func validateIDs(ids []string, max int, distinct bool) error {
	if len(ids) > max {
		return invalid("图片或目录数量超过上限")
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !validID(id) || distinct && seen[id] {
			return invalid("图片或目录 ID 无效或重复")
		}
		seen[id] = true
	}
	return nil
}
func filterName(name string) (string, error) {
	for _, r := range name {
		if r < 32 || r == 127 {
			return "", invalid("筛选预设名称不能包含控制字符")
		}
	}
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || len([]rune(name)) < 1 || len([]rune(name)) > 80 {
		return "", invalid("筛选预设名称必须包含 1..80 个字符")
	}
	return name, nil
}
func cloneConfig(cfg *FilterConfig) (*FilterConfig, error) {
	if cfg == nil {
		return nil, nil
	}
	v := *cfg
	name, e := filterName(v.PresetName)
	if e != nil {
		return nil, e
	}
	v.PresetName = name
	if e = validateIDs(v.Options.ReferenceAssetIDs, 200, false); e != nil {
		return nil, e
	}
	v.Options.ReferenceAssetIDs = append([]string{}, v.Options.ReferenceAssetIDs...)
	return &v, nil
}

// Strict option decoding rejects missing fields, null, integer/string booleans,
// and unknown options, matching FilterOptions' public JSON contract.
func (o *FilterOptions) UnmarshalJSON(b []byte) error {
	var fields map[string]json.RawMessage
	if e := json.Unmarshal(b, &fields); e != nil {
		return e
	}
	keys := []string{"basic_dedup", "filter_monochrome", "filter_sketch", "filter_character", "similarity_groups", "reference_asset_ids"}
	if len(fields) != len(keys) {
		return fmt.Errorf("filter options require all six fields")
	}
	for _, key := range keys {
		raw, ok := fields[key]
		if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fmt.Errorf("filter option %s is required", key)
		}
	}
	type plain FilterOptions
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	var v plain
	if e := d.Decode(&v); e != nil {
		return e
	}
	if e := validateIDs(v.ReferenceAssetIDs, 200, false); e != nil {
		return e
	}
	*o = FilterOptions(v)
	return nil
}
func (c *FilterConfig) UnmarshalJSON(b []byte) error {
	var fields map[string]json.RawMessage
	if e := json.Unmarshal(b, &fields); e != nil {
		return e
	}
	if len(fields) != 2 || fields["preset_name"] == nil || fields["options"] == nil || string(bytes.TrimSpace(fields["options"])) == "null" {
		return fmt.Errorf("filter configuration requires preset_name and options")
	}
	type plain FilterConfig
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	var v plain
	if e := d.Decode(&v); e != nil {
		return e
	}
	name, e := filterName(v.PresetName)
	if e != nil {
		return e
	}
	v.PresetName = name
	*c = FilterConfig(v)
	return nil
}
func (d *Decision) UnmarshalJSON(b []byte) error {
	var fields map[string]json.RawMessage
	if e := json.Unmarshal(b, &fields); e != nil {
		return e
	}
	if raw, ok := fields["selected_image_ids"]; ok && string(bytes.TrimSpace(raw)) == "null" {
		return fmt.Errorf("selected_image_ids cannot be null")
	}
	type plain Decision
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	var v plain
	if e := decoder.Decode(&v); e != nil {
		return e
	}
	*d = Decision(v)
	return nil
}
func builtins() []Preset {
	return []Preset{{ID: "builtin-style", Name: "画风", Builtin: true, Options: FilterOptions{BasicDedup: true, FilterMonochrome: true, FilterSketch: true, SimilarityGroups: true, ReferenceAssetIDs: []string{}}}, {ID: "builtin-character", Name: "角色", Builtin: true, Options: FilterOptions{BasicDedup: true, FilterCharacter: true, SimilarityGroups: true, ReferenceAssetIDs: []string{}}}}
}
func builtin(id string) bool { return id == "builtin-style" || id == "builtin-character" }
func (s *Service) ListPresets(ctx context.Context) ([]Preset, error) {
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT * FROM gallery_review_presets ORDER BY name,id")
	if e != nil {
		return nil, e
	}
	result := builtins()
	for _, r := range rows {
		p := Preset{ID: text(r["id"]), Name: text(r["name"]), Builtin: builtin(text(r["id"]))}
		if e = decodeJSON(text(r["options_json"]), &p.Options); e != nil {
			return nil, e
		}
		replaced := false
		for n, v := range result {
			if v.ID == p.ID {
				result[n] = p
				replaced = true
				break
			}
		}
		if !replaced {
			result = append(result, p)
		}
	}
	return result, nil
}
func (s *Service) SavePreset(ctx context.Context, id, name string, options FilterOptions) (Preset, error) {
	p := Preset{}
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return p, e
	}
	defer done()
	name, e = filterName(name)
	if e != nil {
		return p, e
	}
	if e = validateIDs(options.ReferenceAssetIDs, 200, false); e != nil {
		return p, e
	}
	options.ReferenceAssetIDs = append([]string{}, options.ReferenceAssetIDs...)
	create := id == ""
	if create {
		id = uuid.NewString()
	}
	p = Preset{ID: id, Name: name, Builtin: builtin(id), Options: options}
	e = s.write(ctx, func(tx *sql.Tx) error {
		if create || p.Builtin {
			_, e := tx.ExecContext(ctx, "INSERT INTO gallery_review_presets(id,name,options_json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,options_json=excluded.options_json", id, name, encode(options))
			return e
		}
		r, e := tx.ExecContext(ctx, "UPDATE gallery_review_presets SET name=?,options_json=? WHERE id=?", name, encode(options), id)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return failure(404, "review_preset_not_found", "筛选预设不存在")
		}
		return nil
	})
	return p, e
}
func (s *Service) DeletePreset(ctx context.Context, id string) error {
	ctx, done, e := s.begin(ctx)
	if e != nil {
		return e
	}
	defer done()
	if builtin(id) {
		return failure(409, "review_preset_builtin", "内置预设不可删除")
	}
	return s.write(ctx, func(tx *sql.Tx) error {
		r, e := tx.ExecContext(ctx, "DELETE FROM gallery_review_presets WHERE id=?", id)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return failure(404, "review_preset_not_found", "筛选预设不存在")
		}
		return nil
	})
}
func (s *Service) prepareReferences(ctx context.Context, cfg *FilterConfig) ([]Snapshot, error) {
	refs := []Snapshot{}
	if cfg == nil {
		return refs, nil
	}
	o := cfg.Options
	if o.FilterCharacter && len(o.ReferenceAssetIDs) == 0 {
		return nil, failure(422, "filter_reference_required", "角色过滤必须指定有效参考图")
	}
	if len(o.ReferenceAssetIDs) > 0 {
		_, selected, e := s.selectAssets(ctx, nil, o.ReferenceAssetIDs)
		if e == nil {
			refs = selected
			sids := []string{}
			for _, v := range refs {
				sids = append(sids, v.SourceID)
			}
			e = s.hold(ctx, sids, func(ctx context.Context) error {
				for _, v := range refs {
					root, e := openRoot(v.RootPath)
					if e != nil {
						return e
					}
					_, e = s.validateSnapshot(ctx, v, root, "")
					root.close()
					if e != nil {
						return e
					}
					if s.deps.Gallery.ValidateReference != nil {
						e = s.deps.Gallery.ValidateReference(ctx, v, o.FilterCharacter)
					} else {
						e = validateReference(ctx, v, o.FilterCharacter)
					}
					if e != nil {
						return e
					}
				}
				return nil
			})
		}
		if e != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, failure(422, "filter_reference_invalid", "参考图不存在、不可读取或安全快照无效")
		}
	}
	names := []string{}
	if o.FilterMonochrome {
		names = append(names, "monochrome")
	}
	if o.FilterSketch {
		names = append(names, "completeness")
	}
	if o.FilterCharacter {
		names = append(names, "ccip")
	}
	if len(names) == 0 {
		return refs, nil
	}
	caps, e := s.checkFilters(ctx, names)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	blocked := []Row{}
	for _, item := range []struct {
		option, model string
		enabled       bool
	}{{"filter_monochrome", "monochrome", o.FilterMonochrome}, {"filter_sketch", "completeness", o.FilterSketch}, {"filter_character", "ccip", o.FilterCharacter}} {
		if !item.enabled {
			continue
		}
		cap, ok := caps[item.model]
		if e != nil || !ok || !cap.Available {
			reason := cap.Reason
			if reason == "" {
				reason = "过滤模型或独立 ONNX 执行器未通过离线验证，请先准备模型"
			}
			blocked = append(blocked, Row{"option": item.option, "reason": safeText(reason)})
		}
	}
	if len(blocked) > 0 {
		return nil, &Error{Status: 409, Code: "review_filter_unavailable", Message: "启用的自动过滤尚不可用", Details: Row{"filters": blocked}}
	}
	return refs, nil
}
func (s *Service) checkFilters(ctx context.Context, names []string) (map[string]Capability, error) {
	if s.deps.Gallery.CheckFilters != nil {
		return s.deps.Gallery.CheckFilters(ctx, names)
	}
	script := s.deps.Dedup.FilterModelsScript
	if script == "" {
		script = filepath.Join(filepath.Dir(s.deps.Dedup.WorkerScript), "review_filter_models.py")
	}
	args := []string{script, "--model-dir", s.deps.Dedup.ModelDir, "--models"}
	args = append(args, names...)
	ctx, cancel := context.WithTimeout(ctx, 60e9)
	defer cancel()
	var out limitedBuffer
	err := s.command(ctx, s.pythonExecutable(), args, filepath.Dir(script), &out, &out)
	var result map[string]Capability
	if e := json.Unmarshal(out.Bytes(), &result); e != nil {
		return nil, e
	}
	if len(result) != len(names) {
		return nil, fmt.Errorf("invalid capability response")
	}
	all := true
	for _, name := range names {
		cap, ok := result[name]
		if !ok || !cap.Available && cap.Reason == "" {
			return nil, fmt.Errorf("invalid capability")
		}
		all = all && cap.Available
	}
	if err != nil && all {
		return nil, err
	}
	return result, nil
}
func safeText(v string) string { return redaction.Text(v, 4000) }
func safeError(e error) string {
	if e == nil {
		return ""
	}
	return safeText(e.Error())
}
