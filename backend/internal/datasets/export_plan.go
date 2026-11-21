package datasets

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

const captionMaxBytes = 1024 * 1024
const previewLimit = 100

var kaomoji = map[string]bool{"0_0": true, "(o)_(o)": true, "+_+": true, "+_-": true, "._.": true, "<o>_<o>": true, "<|>_<|>": true, "=_=": true, ">_<": true, "3_3": true, "6_9": true, ">_o": true, "@_@": true, "^_^": true, "o_o": true, "u_u": true, "x_x": true, "|_|": true, "||_||": true}

func NormalizeTag(tag string) string {
	return cases.Fold().String(strings.Join(strings.Fields(strings.ReplaceAll(tag, "_", " ")), " "))
}
func portableName(name string) string { return cases.Fold().String(norm.NFC.String(name)) }
func TransformCaption(text, trigger string, pin bool, blacklist []string, underscoreToSpace bool) string {
	blocked := map[string]bool{}
	for _, tag := range blacklist {
		blocked[NormalizeTag(tag)] = true
	}
	trigger = strings.TrimSpace(trigger)
	keyTrigger := NormalizeTag(trigger)
	seen := map[string]bool{}
	result := []string{}
	text = strings.NewReplacer("\r", ",", "\n", ",").Replace(text)
	for _, raw := range strings.Split(text, ",") {
		tag := strings.TrimSpace(raw)
		key := NormalizeTag(tag)
		if key == "" || blocked[key] || seen[key] || pin && key == keyTrigger {
			continue
		}
		if underscoreToSpace && !kaomoji[tag] {
			tag = strings.ReplaceAll(tag, "_", " ")
		}
		seen[key] = true
		result = append(result, tag)
	}
	if pin && trigger != "" {
		result = append([]string{trigger}, result...)
	}
	return strings.Join(result, ", ")
}
func SafeFolderName(name string) string {
	clean := strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune("<>:\"/\\|?*", r) {
			return '_'
		}
		return r
	}, name)
	clean = strings.Trim(strings.Join(strings.Fields(clean), " "), " .")
	r := []rune(clean)
	if len(r) > 120 {
		clean = strings.Trim(string(r[:120]), " .")
	}
	if clean == "" {
		return "dataset"
	}
	base := strings.ToLower(strings.SplitN(clean, ".", 2)[0])
	reserved := base == "con" || base == "prn" || base == "aux" || base == "nul"
	if len(base) == 4 && (strings.HasPrefix(base, "com") || strings.HasPrefix(base, "lpt")) && base[3] >= '1' && base[3] <= '9' {
		reserved = true
	}
	if reserved {
		clean += "_"
	}
	return clean
}
func StagingName(id string) string { return ".ldos-copy-dataset-" + id }
func hashBytes(b []byte) string    { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }
func boolOption(o Record, k string, def bool) bool {
	if v, ok := o[k].(bool); ok {
		return v
	}
	return def
}
func stringList(v any) []string {
	out := []string{}
	switch list := v.(type) {
	case []string:
		return list
	case []any:
		for _, x := range list {
			if text, ok := x.(string); ok {
				out = append(out, text)
			}
		}
	}
	return out
}
func (s *Service) normalizeExport(d, raw Record) (Record, error) {
	layout := str(raw["layout"])
	if layout == "" {
		layout = "kohya"
	}
	if layout != "kohya" && layout != "flat" {
		return nil, failure(422, "export_layout_invalid", "导出布局只能是 kohya 或 flat")
	}
	rename := str(raw["rename"])
	if rename == "" {
		rename = "none"
	}
	if rename != "none" && rename != "sequential" {
		return nil, failure(422, "export_rename_invalid", "重命名只能是 none 或 sequential")
	}
	repeats := num(raw["repeats"])
	if repeats == 0 {
		repeats = 10
	}
	if repeats < 1 || repeats > 10000 {
		return nil, failure(422, "export_repeats_invalid", "repeats 必须在 1–10000 之间")
	}
	trigger := str(d["trigger_word"])
	if v, ok := raw["trigger_word"]; ok && v != nil {
		trigger = str(v)
	}
	trigger = strings.TrimSpace(trigger)
	requested := strings.TrimSpace(str(raw["folder_name"]))
	if requested != "" && SafeFolderName(requested) != requested {
		return nil, failure(422, "export_folder_name_invalid", "文件夹名含有不能用的字符", Record{"suggestion": SafeFolderName(requested)})
	}
	folder := requested
	if layout == "kohya" {
		if requested == "" && trigger == "" {
			return nil, failure(422, "export_trigger_required", "kohya 布局需要触发词（或指定文件夹名）")
		}
		if folder == "" {
			folder = SafeFolderName(trigger)
		}
		folder = fmt.Sprintf("%d_%s", repeats, folder)
	} else if folder == "" {
		folder = SafeFolderName(str(d["name"]))
	}
	if strings.HasPrefix(folder, ".ldos") || !safeLeaf(folder) {
		return nil, failure(422, "export_folder_name_invalid", "文件夹名不能以 .ldos 开头")
	}
	blacklist := []string{}
	for _, tag := range stringList(raw["tag_blacklist"]) {
		if v := strings.TrimSpace(tag); v != "" {
			blacklist = append(blacklist, v)
		}
	}
	return Record{"target_path": str(raw["target_path"]), "layout": layout, "repeats": repeats, "trigger_word": trigger, "folder_name": folder, "rename": rename, "include_captions": boolOption(raw, "include_captions", true), "pin_trigger": boolOption(raw, "pin_trigger", true), "tag_blacklist": blacklist, "underscore_to_space": boolOption(raw, "underscore_to_space", false)}, nil
}
func transform(text string, o Record) string {
	return TransformCaption(text, str(o["trigger_word"]), boolOption(o, "pin_trigger", true), stringList(o["tag_blacklist"]), boolOption(o, "underscore_to_space", false))
}

type exportPlan struct {
	datasetID            string
	options              Record
	target, key          string
	identity             fileIdentity
	targetExists         bool
	items                []Record
	collisions, blockers []Record
	imageBytes, txtBytes int64
}

func (s *Service) PreviewExport(ctx context.Context, id string, options Record) (Record, error) {
	p, e := s.planExport(ctx, id, options)
	if e != nil {
		return nil, e
	}
	return p.public(), nil
}
func (s *Service) planExport(ctx context.Context, id string, raw Record) (*exportPlan, error) {
	d, e := s.dataset(ctx, id)
	if e != nil {
		return nil, e
	}
	if e = checkExportInput(ctx, s.deps.Store.QueryRow, id); e != nil {
		return nil, e
	}
	o, e := s.normalizeExport(d, raw)
	if e != nil {
		return nil, e
	}
	target := str(o["target_path"])
	if target == "" || strings.ContainsRune(target, 0) {
		return nil, failure(422, "target_path_invalid", "导出目录无效")
	}
	if !filepath.IsAbs(target) {
		return nil, failure(422, "target_path_not_absolute", "导出目录必须是绝对路径")
	}
	root, e := openDirectory(target)
	if e != nil {
		if st, err := os.Stat(target); err == nil && st.IsDir() {
			return nil, failure(409, "target_path_unsafe", "导出目录不安全或已变化")
		}
		return nil, failure(409, "target_unavailable", "导出目录不存在、不安全或不是文件夹")
	}
	defer root.Close()
	ident, e := identity(root)
	if e != nil {
		return nil, e
	}
	key, e := filepath.EvalSymlinks(target)
	if e != nil {
		return nil, e
	}
	p := &exportPlan{datasetID: id, options: o, target: filepath.Clean(target), key: key, identity: ident, items: []Record{}, collisions: []Record{}, blockers: []Record{}}
	var st unix.Stat_t
	e = unix.Fstatat(int(root.Fd()), str(o["folder_name"]), &st, unix.AT_SYMLINK_NOFOLLOW)
	if e == nil {
		p.targetExists = true
	} else if !errors.Is(e, unix.ENOENT) {
		return nil, e
	}
	members, e := s.StageInput(ctx, id, "export")
	if e != nil {
		return nil, e
	}
	decisions, e := s.decisionMap(ctx, id)
	if e != nil {
		return nil, e
	}
	selected := []Record{}
	for _, m := range members {
		if decisions[str(m["asset_id"])]["export"] != "exclude" {
			selected = append(selected, m)
		}
	}
	if len(selected) == 0 {
		return nil, failure(409, "export_empty", "导出阶段没有可导出的图片")
	}
	offline := []string{}
	badCaptions := []string{}
	sources := map[string]bool{}
	roots, e := s.deps.Store.QueryRows(ctx, `SELECT DISTINCT s.id,s.availability,s.canonical_root_key,s.root_path FROM dataset_roots r JOIN gallery_sources s ON s.id=r.source_id WHERE r.dataset_id=?`, id)
	if e != nil {
		return nil, e
	}
	for _, src := range roots {
		sid := str(src["id"])
		base := str(src["canonical_root_key"])
		if base == "" {
			base = str(src["root_path"])
		}
		if _, ok := within(key, base); ok {
			return nil, failure(409, "target_inside_source", "导出目录不能在图库来源里面", Record{"source_id": sid})
		}
		sources[sid] = str(src["availability"]) == "available"
	}
	seenSources := map[string]bool{}
	for _, m := range selected {
		sid := str(m["source_id"])
		if !seenSources[sid] && !sources[sid] {
			offline = append(offline, sid)
		}
		seenSources[sid] = true
	}
	used := map[string]bool{}
	width := max(4, len(strconv.Itoa(len(selected))))
	for index, m := range selected {
		a := str(m["asset_id"])
		name := str(m["name"])
		if !safeLeaf(name) || !safeRelative(str(m["relative_path"])) {
			return nil, failure(409, "source_changed", "图片路径不安全", Record{"asset_id": a})
		}
		ext := filepath.Ext(name)
		stem := strings.TrimSuffix(name, ext)
		if str(o["rename"]) == "sequential" {
			stem = fmt.Sprintf("%0*d", width, index+1)
			ext = strings.ToLower(ext)
		}
		candidate := stem
		for n := 2; used[portableName(candidate)]; n++ {
			candidate = fmt.Sprintf("%s_%d", stem, n)
		}
		used[portableName(candidate)] = true
		output := candidate + ext
		if !safeLeaf(output) {
			return nil, failure(409, "source_changed", "图片名称不安全")
		}
		if candidate != stem {
			p.collisions = append(p.collisions, Record{"asset_id": a, "name": name, "output_name": output})
		}
		item := Record{"asset_id": a, "source_id": m["source_id"], "name": name, "source_relative_path": m["relative_path"], "output_relative_path": output, "txt_source_relative_path": str(m["txt_relative_path"]), "txt_output_relative_path": candidate + ".txt", "caption": "", "image_size_bytes": num(m["size_bytes"]), "expected_content_version": num(m["content_version"]), "expected_txt_version": num(m["txt_version"]), "image_sha256": str(m["content_sha256"]), "txt_sha256": "", "txt_size_bytes": int64(0)}
		if !boolOption(o, "include_captions", true) {
			item["txt_output_relative_path"] = ""
		} else {
			state := str(m["txt_state"])
			switch state {
			case "invalid_encoding", "io_error", "pair_conflict":
				badCaptions = append(badCaptions, a)
			default:
				text := ""
				if state == "missing" {
					item["txt_source_relative_path"] = ""
				}
				if relative := str(item["txt_source_relative_path"]); relative != "" && sources[str(m["source_id"])] {
					text, e = s.readCaption(ctx, str(m["source_id"]), relative)
					if e != nil {
						badCaptions = append(badCaptions, a)
						break
					}
				}
				caption := transform(text, o)
				item["caption"] = caption
				if caption == "" {
					item["txt_output_relative_path"] = ""
				} else {
					item["txt_size_bytes"] = int64(len(caption))
					item["txt_sha256"] = hashBytes([]byte(caption))
				}
			}
		}
		p.imageBytes += num(item["image_size_bytes"])
		p.txtBytes += num(item["txt_size_bytes"])
		p.items = append(p.items, item)
	}
	if len(offline) > 0 {
		p.blockers = append(p.blockers, Record{"code": "source_offline", "count": len(offline), "ids": offline[:min(50, len(offline))]})
	}
	if len(badCaptions) > 0 {
		p.blockers = append(p.blockers, Record{"code": "caption_unreadable", "count": len(badCaptions), "ids": badCaptions[:min(50, len(badCaptions))]})
	}
	return p, nil
}
func (s *Service) readCaption(ctx context.Context, source, relative string) (string, error) {
	f, e := s.openSource(ctx, source, relative)
	if e != nil {
		return "", e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, captionMaxBytes+1))
	if e != nil {
		return "", e
	}
	if len(b) > captionMaxBytes {
		return "", errors.New("caption_too_large")
	}
	text := strings.TrimPrefix(string(b), "\ufeff")
	if !utf8.ValidString(text) {
		return "", errors.New("caption_invalid_encoding")
	}
	return text, nil
}
func (p *exportPlan) public() Record {
	items := []Record{}
	captions := 0
	for i, m := range p.items {
		var captionPath any
		if v := str(m["txt_output_relative_path"]); v != "" {
			captions++
			captionPath = v
		}
		if i >= previewLimit {
			continue
		}
		runes := []rune(str(m["caption"]))
		items = append(items, Record{"asset_id": m["asset_id"], "name": m["name"], "source_relative_path": m["source_relative_path"], "output_relative_path": m["output_relative_path"], "caption_output_relative_path": captionPath, "caption_preview": string(runes[:min(300, len(runes))]), "size_bytes": m["image_size_bytes"]})
	}
	return Record{"dataset_id": p.datasetID, "layout": p.options["layout"], "folder_name": p.options["folder_name"], "target_path": p.target, "output_path": filepath.Join(p.target, str(p.options["folder_name"])), "target_exists": p.targetExists, "options": p.options, "image_count": len(p.items), "caption_count": captions, "image_bytes": p.imageBytes, "txt_bytes": p.txtBytes, "total_bytes": p.imageBytes + p.txtBytes, "collision_count": len(p.collisions), "collisions": p.collisions[:min(previewLimit, len(p.collisions))], "blockers": p.blockers, "items": items}
}
func readIdentity(v any) (fileIdentity, error) {
	switch a := v.(type) {
	case fileIdentity:
		return a, nil
	case []any:
		if len(a) == 2 {
			var id fileIdentity
			data, err := json.Marshal(a)
			if err == nil && json.Unmarshal(data, &id) == nil {
				return id, nil
			}
		}
	}
	return fileIdentity{}, failure(409, "target_root_changed", "导出目标身份记录无效")
}
func targetError(e error) error {
	if errors.Is(e, os.ErrPermission) {
		return failure(409, "target_not_writable", "没有权限写入导出目录")
	}
	return e
}
