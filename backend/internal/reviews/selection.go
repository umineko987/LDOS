package reviews

import (
	"context"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

func excludedPath(relative string) bool {
	parts, e := relativeParts(relative)
	if e != nil {
		return true
	}
	for _, v := range parts {
		v = strings.ToLower(v)
		if v == ".ldos" || v == "duplicates" || v == "keep" || v == "trashed" || v == "trash" || strings.HasPrefix(v, ".ldos-") {
			return true
		}
	}
	return false
}
func unique(ids []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}
func (s *Service) hold(ctx context.Context, ids []string, fn func(context.Context) error) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	if s.deps.Gallery.HoldSources == nil {
		return conflict("图库来源锁未配置")
	}
	ids = unique(ids)
	sort.Strings(ids)
	return s.deps.Gallery.HoldSources(ctx, ids, func(ctx context.Context) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		return fn(ctx)
	})
}
func (s *Service) selectAssets(ctx context.Context, dirs, assets []string) ([]Selection, []Snapshot, error) {
	if len(dirs) == 0 && len(assets) == 0 {
		return nil, nil, failure(409, "review_selection_invalid", "图库审核选择为空")
	}
	if s.deps.Gallery.ScanSource == nil {
		return nil, nil, conflict("图库扫描回调未配置")
	}
	directories, explicit := []Row{}, []Row{}
	sources := []string{}
	for _, id := range unique(dirs) {
		d, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_directories WHERE id=?", id)
		if e != nil {
			return nil, nil, e
		}
		if d == nil {
			return nil, nil, missing()
		}
		if p := text(d["relative_path"]); p != "" && excludedPath(p) {
			return nil, nil, conflict("review_directory_excluded")
		}
		directories = append(directories, d)
		sources = append(sources, text(d["source_id"]))
	}
	for _, id := range unique(assets) {
		a, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_assets WHERE id=?", id)
		if e != nil {
			return nil, nil, e
		}
		if a == nil {
			return nil, nil, missing()
		}
		explicit = append(explicit, a)
		sources = append(sources, text(a["source_id"]))
	}
	sources = unique(sources)
	sort.Strings(sources)
	selection, snapshots := []Selection{}, []Snapshot{}
	err := s.hold(ctx, sources, func(ctx context.Context) error {
		for _, sid := range sources {
			if e := ctx.Err(); e != nil {
				return e
			}
			if e := s.deps.Gallery.ScanSource(ctx, sid); e != nil {
				return e
			}
		}
		seen := map[string]bool{}
		for _, sid := range sources {
			source, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_sources WHERE id=?", sid)
			if e != nil {
				return e
			}
			if source == nil {
				return conflict("review_source_changed")
			}
			if text(source["availability"]) != "available" {
				return conflict("review_source_offline")
			}
			selected := []Row{}
			for _, d := range directories {
				if text(d["source_id"]) != sid {
					continue
				}
				current, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_directories WHERE id=?", d["id"])
				if e != nil {
					return e
				}
				if current == nil || text(current["source_id"]) != sid || text(current["relative_path"]) != text(d["relative_path"]) {
					return conflict("review_directory_changed")
				}
				selected = append(selected, d)
				selection = append(selection, Selection{DirectoryID: text(d["id"]), SourceID: sid, SourceDisplayName: text(source["display_name"]), RelativePath: text(d["relative_path"]), Name: text(d["name"])})
			}
			root, e := openRoot(text(source["root_path"]))
			if e != nil {
				return e
			}
			e = func() error {
				defer root.close()
				appendAsset := func(a Row) error {
					physical := filepath.Join(root.path, text(a["relative_path"]))
					if seen[physical] {
						return nil
					}
					snapshot, e := s.snapshotAsset(ctx, source, a, root)
					if e != nil {
						return e
					}
					seen[physical] = true
					snapshots = append(snapshots, snapshot)
					return nil
				}
				rows, e := s.deps.Store.QueryRows(ctx, "SELECT * FROM gallery_assets WHERE source_id=? AND lifecycle_state='active' AND dedup_visibility!='excluded' ORDER BY relative_path", sid)
				if e != nil {
					return e
				}
				for _, a := range rows {
					path := text(a["relative_path"])
					if excludedPath(path) {
						continue
					}
					matched := false
					for _, d := range selected {
						p := text(d["relative_path"])
						if p == "" || strings.HasPrefix(path, p+"/") {
							matched = true
							break
						}
					}
					if matched {
						if e = appendAsset(a); e != nil {
							return e
						}
					}
				}
				for _, previous := range explicit {
					if text(previous["source_id"]) != sid {
						continue
					}
					a, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_assets WHERE id=?", previous["id"])
					if e != nil {
						return e
					}
					if a == nil || text(a["source_id"]) != sid {
						return conflict("review_asset_changed")
					}
					if e = appendAsset(a); e != nil {
						return e
					}
				}
				return nil
			}()
			if e != nil {
				return e
			}
		}
		if len(snapshots) == 0 {
			return failure(409, "review_selection_invalid", "图库选择没有可审核图片")
		}
		return nil
	})
	return selection, snapshots, err
}
func (s *Service) snapshotAsset(ctx context.Context, source, a Row, r *safeRoot) (Snapshot, error) {
	var v Snapshot
	if text(a["lifecycle_state"]) != "active" || text(a["dedup_visibility"]) == "excluded" {
		return v, conflict("review_asset_unavailable")
	}
	if excludedPath(text(a["relative_path"])) {
		return v, conflict("review_asset_excluded")
	}
	if text(a["txt_state"]) == "pair_conflict" {
		return v, conflict("review_txt_pair_conflict")
	}
	v = Snapshot{AssetID: text(a["id"]), SourceID: text(a["source_id"]), DirectoryID: text(a["directory_id"]), RelativePath: text(a["relative_path"]), ContentVersion: number(a["content_version"]), TXTVersion: number(a["txt_version"]), TXTRelativePath: text(a["txt_relative_path"]), TXTState: text(a["txt_state"]), RootPath: text(source["root_path"]), SourceDisplayName: text(source["display_name"])}
	var e error
	v.RootIdentity, e = r.identity()
	if e != nil {
		return v, e
	}
	v.DiskVersion, e = r.diskVersion(ctx, v.RelativePath, false)
	if e != nil {
		return v, e
	}
	v.TXTDiskVersion, e = r.diskVersion(ctx, v.TXTRelativePath, true)
	if e != nil {
		return v, e
	}
	_, e = s.validateSnapshot(ctx, v, r, "")
	return v, e
}
func (s *Service) validateSnapshot(ctx context.Context, v Snapshot, r *safeRoot, trash string) (Row, error) {
	source, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_sources WHERE id=?", v.SourceID)
	if e != nil {
		return nil, e
	}
	a, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_assets WHERE id=?", v.AssetID)
	if e != nil {
		return nil, e
	}
	if source == nil || text(source["root_path"]) != v.RootPath {
		return nil, conflict("review_source_changed")
	}
	rootID, e := r.identity()
	if e != nil {
		return nil, e
	}
	if !reflect.DeepEqual(rootID, v.RootIdentity) {
		return nil, conflict("review_source_root_changed")
	}
	// Also verify that the registered path still names the held root.
	current, e := openRoot(v.RootPath)
	if e != nil {
		return nil, e
	}
	currentID, e := current.identity()
	current.close()
	if e != nil {
		return nil, e
	}
	if !reflect.DeepEqual(currentID, rootID) {
		return nil, conflict("review_source_root_changed")
	}
	if batch := text(source["batch_id"]); batch != "" {
		b, e := s.deps.Store.QueryRow(ctx, "SELECT status FROM crawl_batches WHERE id=?", batch)
		if e != nil {
			return nil, e
		}
		if b == nil || !terminal(text(b["status"])) {
			return nil, conflict("review_source_crawl_active")
		}
	}
	if a == nil || text(a["source_id"]) != v.SourceID || text(a["directory_id"]) != v.DirectoryID || text(a["relative_path"]) != v.RelativePath || text(a["txt_relative_path"]) != v.TXTRelativePath || number(a["txt_version"]) != v.TXTVersion {
		return nil, conflict("review_asset_changed")
	}
	imagePath, txtPath := v.RelativePath, v.TXTRelativePath
	if trash != "" {
		if text(a["lifecycle_state"]) != "trashed" {
			return nil, conflict("review_trash_changed")
		}
		imagePath = ".ldos/trash/" + trash + "/files/" + imagePath
		txtPath = ".ldos/trash/" + trash + "/files/" + txtPath
	} else {
		if text(a["lifecycle_state"]) != "active" || number(a["content_version"]) != v.ContentVersion || text(a["dedup_visibility"]) == "excluded" {
			return nil, conflict("review_asset_version_conflict")
		}
	}
	disk, e := r.diskVersion(ctx, imagePath, false)
	if e != nil {
		return nil, e
	}
	if disk != v.DiskVersion {
		return nil, conflict("review_image_changed")
	}
	txt, e := r.diskVersion(ctx, txtPath, true)
	if e != nil {
		return nil, e
	}
	if txt != v.TXTDiskVersion {
		return nil, conflict("review_txt_changed")
	}
	return a, nil
}
func (s *Service) validateInput(ctx context.Context, input WorkerInput) error {
	all := append(append([]Snapshot{}, input.Images...), input.References...)
	sources := []string{}
	for _, v := range all {
		sources = append(sources, v.SourceID)
	}
	return s.hold(ctx, sources, func(ctx context.Context) error {
		for _, v := range all {
			r, e := openRoot(v.RootPath)
			if e != nil {
				return e
			}
			_, e = s.validateSnapshot(ctx, v, r, "")
			r.close()
			if e != nil {
				return e
			}
		}
		return nil
	})
}
