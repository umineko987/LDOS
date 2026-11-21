package gallerycatalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path"
	"sort"
	"strings"

	"golang.org/x/sys/unix"
	"ldos/backend/internal/store"
)

type Selection struct {
	AssetIDs     []string `json:"asset_ids"`
	DirectoryIDs []string `json:"directory_ids"`
}
type FileOperation struct {
	OperationID string   `json:"operation_id"`
	Kind        string   `json:"kind"`
	Status      string   `json:"status"`
	ItemCount   int      `json:"item_count"`
	HasTxtCount int      `json:"has_txt_count"`
	SourceIDs   []string `json:"-"`
}
type operationItem struct {
	SourceID, TargetSourceID, ItemType, DirectoryID, AssetID, Origin, Target string
	HasTxt                                                                   bool
	ExpectedAssetVersion, ExpectedTxtVersion                                 int64
	Ordinal                                                                  int
	Status                                                                   string
	Snapshot                                                                 Row
	Native                                                                   itemNative
}
type itemNative struct {
	TargetSourceID string       `json:"target_source_id,omitempty"`
	SourceRoot     fileIdentity `json:"source_root"`
	TargetRoot     fileIdentity `json:"target_root"`
	BtrfsFSID      *[2]int32    `json:"btrfs_fsid,omitempty"`
	Image          fileIdentity `json:"image"`
	Caption        fileIdentity `json:"caption"`
	TrashOperation string       `json:"trash_operation,omitempty"`
	Stage          string       `json:"stage,omitempty"`
	StageIdentity  fileIdentity `json:"stage_identity"`
	Copied         []copiedFile `json:"copied,omitempty"`
}

func (item operationItem) snapshotJSON() string {
	r := clone(item.Snapshot)
	r["_native"] = item.Native
	return jsonText(r)
}
func (s *Service) selection(ctx context.Context, selected Selection) ([]operationItem, []string, error) {
	if len(selected.AssetIDs) > 2000 || len(selected.DirectoryIDs) > 200 || len(selected.AssetIDs)+len(selected.DirectoryIDs) == 0 {
		return nil, nil, failure("selection_required", 422)
	}
	items := []operationItem{}
	sources := []string{}
	dirs := []Row{}
	for _, did := range unique(selected.DirectoryIDs) {
		d, e := s.GetDirectory(ctx, did)
		if e != nil {
			return nil, nil, e
		}
		if str(d, "relative_path") == "" {
			return nil, nil, failure("directory_root_not_deletable", 409)
		}
		dirs = append(dirs, d)
	}
	sort.Slice(dirs, func(i, j int) bool { return str(dirs[i], "relative_path") < str(dirs[j], "relative_path") })
	for i, d := range dirs {
		for j := 0; j < i; j++ {
			if str(d, "source_id") == str(dirs[j], "source_id") && strings.HasPrefix(str(d, "relative_path"), str(dirs[j], "relative_path")+"/") {
				return nil, nil, failure("directory_selection_overlap", 409)
			}
		}
		items = append(items, operationItem{SourceID: str(d, "source_id"), TargetSourceID: str(d, "source_id"), ItemType: "directory", DirectoryID: str(d, "directory_id"), AssetID: "", Origin: str(d, "relative_path"), ExpectedAssetVersion: 1, ExpectedTxtVersion: 1, Snapshot: Row{}})
		sources = append(sources, str(d, "source_id"))
	}
	for _, aid := range unique(selected.AssetIDs) {
		a, e := s.GetImage(ctx, aid)
		if e != nil {
			return nil, nil, e
		}
		if str(a, "lifecycle_state") != "active" {
			return nil, nil, failure("asset_not_active", 409)
		}
		covered := false
		for _, d := range dirs {
			if str(d, "source_id") == str(a, "source_id") && strings.HasPrefix(str(a, "relative_path"), str(d, "relative_path")+"/") {
				covered = true
			}
		}
		if covered {
			continue
		}
		items = append(items, operationItem{SourceID: str(a, "source_id"), TargetSourceID: str(a, "source_id"), ItemType: "asset", AssetID: aid, Origin: str(a, "relative_path"), HasTxt: str(a, "txt_relative_path") != "" && str(a, "txt_state") != "missing" && str(a, "txt_state") != "pair_conflict", ExpectedAssetVersion: num(a, "content_version"), ExpectedTxtVersion: num(a, "txt_version"), Snapshot: Row{}})
		sources = append(sources, str(a, "source_id"))
	}
	return items, unique(sources), nil
}
func (s *Service) openRoots(ctx context.Context, sourceIDs []string) (map[string]*SafeRoot, func(), error) {
	roots := map[string]*SafeRoot{}
	close := func() {
		for _, r := range roots {
			r.Close()
		}
	}
	for _, sid := range unique(sourceIDs) {
		r, e := s.OpenSource(ctx, sid)
		if e != nil {
			close()
			return nil, nil, e
		}
		roots[sid] = r
	}
	return roots, close, nil
}
func (s *Service) prepareItems(ctx context.Context, items []operationItem, roots map[string]*SafeRoot, kind string) error {
	destinations := map[string]bool{}
	for i := range items {
		it := &items[i]
		it.Ordinal = i
		r := roots[it.SourceID]
		target := roots[it.TargetSourceID]
		if e := r.AssertCurrent(); e != nil {
			return e
		}
		if e := target.AssertCurrent(); e != nil {
			return e
		}
		st, e := r.Stat(it.Origin)
		if e != nil {
			return wrapIO(e, "asset_file_missing")
		}
		if it.ItemType == "directory" {
			if st.Mode&unix.S_IFMT != unix.S_IFDIR {
				return failure("directory_missing", 409)
			}
			if e = validateTree(r, it.Origin); e != nil {
				return e
			}
		} else if st.Mode&unix.S_IFMT != unix.S_IFREG {
			return failure("unsafe_source_path", 409)
		}
		if kind == "trash" {
			it.Native.BtrfsFSID, e = r.btrfsFSID()
			if e != nil {
				return e
			}
		}
		it.Native.SourceRoot = r.identity
		it.Native.TargetRoot = target.identity
		it.Native.TargetSourceID = it.TargetSourceID
		it.Native.Image = st
		if it.HasTxt {
			txt, e := r.Stat(CaptionRelativePath(it.Origin))
			if errors.Is(e, os.ErrNotExist) {
				it.HasTxt = false
			} else if e != nil {
				return e
			} else if txt.Mode&unix.S_IFMT != unix.S_IFREG {
				return failure("unsafe_source_path", 409)
			} else {
				it.Native.Caption = txt
			}
		}
		for _, dest := range itemPaths(*it, false) {
			key := it.TargetSourceID + ":" + dest
			if destinations[key] {
				return failure(conflictCode(kind), 409)
			}
			destinations[key] = true
			exists, e := target.Exists(dest)
			if e != nil {
				return e
			}
			if exists {
				return failure(conflictCode(kind), 409)
			}
		}
	}
	return nil
}
func conflictCode(kind string) string {
	switch kind {
	case "rename":
		return "rename_target_conflict"
	case "restore":
		return "restore_target_conflict"
	default:
		return "transfer_target_conflict"
	}
}
func validateTree(r *SafeRoot, relative string) error {
	entries, e := r.ReadDir(relative)
	if e != nil {
		return e
	}
	for _, entry := range entries {
		rel := path.Join(relative, entry.Name())
		if e = ValidateRelativePath(rel, false); e != nil {
			return e
		}
		st, e := r.Stat(rel)
		if e != nil {
			return e
		}
		switch st.Mode & unix.S_IFMT {
		case unix.S_IFREG:
		case unix.S_IFDIR:
			if e = validateTree(r, rel); e != nil {
				return e
			}
		default:
			return failure("unsafe_source_path", 409)
		}
	}
	return nil
}
func itemPaths(item operationItem, origin bool) []string {
	p := item.Target
	if origin {
		p = item.Origin
	}
	out := []string{p}
	if item.HasTxt && item.ItemType != "directory" {
		out = append(out, CaptionRelativePath(p))
	}
	return out
}
func itemIdentities(item operationItem) []fileIdentity {
	out := []fileIdentity{item.Native.Image}
	if item.HasTxt && item.ItemType != "directory" {
		out = append(out, item.Native.Caption)
	}
	return out
}
func (s *Service) persistOperation(ctx context.Context, operationID, kind string, sourceIDs []string, items []operationItem) error {
	return s.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		for _, sid := range sourceIDs {
			busy, e := store.QueryRowTx(ctx, tx, `SELECT id FROM gallery_file_operations WHERE status IN ('planned','applying','rolling_back','failed') AND EXISTS(SELECT 1 FROM json_each(source_ids_json) WHERE value=?) LIMIT 1`, sid)
			if e != nil {
				return e
			}
			if busy != nil {
				return failure("operation_in_progress", 409)
			}
		}
		if _, e := tx.ExecContext(ctx, "INSERT INTO gallery_file_operations(id,kind,status,source_ids_json,created_at,updated_at) VALUES(?,?,'planned',?,?,?)", operationID, kind, jsonText(sourceIDs), now(), now()); e != nil {
			return e
		}
		for _, it := range items {
			_, e := tx.ExecContext(ctx, `INSERT INTO gallery_file_operation_items(operation_id,ordinal,source_id,item_type,directory_id,asset_id,origin_relative_path,target_relative_path,has_txt,expected_asset_version,expected_txt_version,review_snapshot_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, operationID, it.Ordinal, it.SourceID, it.ItemType, it.DirectoryID, it.AssetID, it.Origin, it.Target, it.HasTxt, it.ExpectedAssetVersion, it.ExpectedTxtVersion, it.snapshotJSON())
			if e != nil {
				return e
			}
		}
		return nil
	})
}
func (s *Service) updateItem(ctx context.Context, operationID string, it operationItem) error {
	return s.exec(ctx, "UPDATE gallery_file_operation_items SET status=?,review_snapshot_json=? WHERE operation_id=? AND ordinal=?", it.Status, it.snapshotJSON(), operationID, it.Ordinal)
}
func (s *Service) operation(ctx context.Context, operationID string) (Row, []operationItem, error) {
	op, e := s.db.QueryRow(ctx, "SELECT * FROM gallery_file_operations WHERE id=?", operationID)
	if e != nil {
		return nil, nil, e
	}
	if op == nil {
		return nil, nil, failure("operation_not_found", 404)
	}
	rows, e := s.db.QueryRows(ctx, "SELECT * FROM gallery_file_operation_items WHERE operation_id=? ORDER BY ordinal", operationID)
	if e != nil {
		return nil, nil, e
	}
	items := []operationItem{}
	for _, r := range rows {
		snapshot := Row{}
		decoder := json.NewDecoder(strings.NewReader(str(r, "review_snapshot_json")))
		decoder.UseNumber()
		if e = decoder.Decode(&snapshot); e != nil {
			return nil, nil, failure("operation_recovery_required", 500)
		}
		var native itemNative
		if raw := snapshot["_native"]; raw != nil {
			if e = json.Unmarshal([]byte(jsonText(raw)), &native); e != nil {
				return nil, nil, e
			}
		}
		sid := str(r, "source_id")
		target := native.TargetSourceID
		if target == "" {
			target = sid
		}
		it := operationItem{SourceID: sid, TargetSourceID: target, ItemType: str(r, "item_type"), DirectoryID: str(r, "directory_id"), AssetID: str(r, "asset_id"), Origin: str(r, "origin_relative_path"), Target: str(r, "target_relative_path"), HasTxt: truth(r, "has_txt"), ExpectedAssetVersion: num(r, "expected_asset_version"), ExpectedTxtVersion: num(r, "expected_txt_version"), Ordinal: int(num(r, "ordinal")), Status: str(r, "status"), Snapshot: snapshot, Native: native}
		if str(op, "kind") == "trash" && it.Target == "" {
			it.Target = path.Join(".ldos/trash", operationID, "files", it.Origin)
		}
		items = append(items, it)
	}
	return op, items, nil
}
func operationSources(items []operationItem) []string {
	ids := []string{}
	for _, it := range items {
		ids = append(ids, it.SourceID, it.TargetSourceID)
	}
	return unique(ids)
}
func operationResult(operationID, kind string, items []operationItem) FileOperation {
	out := FileOperation{OperationID: operationID, Kind: kind, Status: "committed", ItemCount: len(items), SourceIDs: operationSources(items)}
	for _, it := range items {
		if it.HasTxt {
			out.HasTxtCount++
		}
	}
	return out
}
func (s *Service) Rename(ctx context.Context, assetID, newStem string) (FileOperation, error) {
	if newStem == "" || len([]rune(newStem)) > 255 || strings.HasPrefix(newStem, ".") || strings.ContainsAny(newStem, "/\\<>:\"|?*") || ValidateRelativePath(newStem, false) != nil {
		return FileOperation{}, failure("invalid_rename_target", 422)
	}
	items, sourceIDs, e := s.selection(ctx, Selection{AssetIDs: []string{assetID}})
	if e != nil {
		return FileOperation{}, e
	}
	release, e := s.LockSources(ctx, sourceIDs...)
	if e != nil {
		return FileOperation{}, e
	}
	defer release()
	items, _, e = s.selection(ctx, Selection{AssetIDs: []string{assetID}})
	if e != nil {
		return FileOperation{}, e
	}
	it := &items[0]
	it.Target = path.Join(parentRelative(it.Origin), newStem+path.Ext(it.Origin))
	if it.Target == it.Origin {
		return FileOperation{}, failure("rename_noop", 422)
	}
	return s.runNewOperation(ctx, id(), "rename", items, sourceIDs)
}
func (s *Service) Trash(ctx context.Context, selection Selection) (FileOperation, error) {
	return s.TrashForReview(ctx, "", selection, nil)
}

// TrashForReview accepts the review's deterministic operation ID and per-asset
// snapshot. The native ownership record is a private key in the existing JSON.
func (s *Service) TrashForReview(ctx context.Context, operationID string, selection Selection, snapshots map[string]Row) (FileOperation, error) {
	if operationID != "" {
		existing, e := s.db.QueryRow(ctx, "SELECT id FROM gallery_file_operations WHERE id=?", operationID)
		if e != nil {
			return FileOperation{}, e
		}
		if existing != nil {
			op, items, e := s.operation(ctx, operationID)
			if e != nil {
				return FileOperation{}, e
			}
			release, e := s.LockSources(ctx, operationSources(items)...)
			if e != nil {
				return FileOperation{}, e
			}
			defer release()
			op, items, e = s.operation(ctx, operationID)
			if e != nil {
				return FileOperation{}, e
			}
			if str(op, "kind") != "trash" || str(op, "status") != "committed" {
				return FileOperation{}, failure("operation_in_progress", 409)
			}
			wanted := map[string]bool{}
			for _, aid := range selection.AssetIDs {
				wanted["asset:"+aid] = true
			}
			for _, did := range selection.DirectoryIDs {
				wanted["directory:"+did] = true
			}
			if len(wanted) != len(items) {
				return FileOperation{}, failure("operation_id_conflict", 409)
			}
			for _, it := range items {
				key := "asset:" + it.AssetID
				if it.ItemType == "directory" {
					key = "directory:" + it.DirectoryID
				}
				if !wanted[key] {
					return FileOperation{}, failure("operation_id_conflict", 409)
				}
			}
			return operationResult(operationID, "trash", items), nil
		}
	}
	items, sources, e := s.selection(ctx, selection)
	if e != nil {
		return FileOperation{}, e
	}
	release, e := s.LockSources(ctx, sources...)
	if e != nil {
		return FileOperation{}, e
	}
	defer release()
	if operationID == "" {
		operationID = id()
	}
	if ValidateRelativePath(operationID, false) != nil || strings.Contains(operationID, "/") || strings.Contains(operationID, "..") {
		return FileOperation{}, failure("invalid_operation_id", 422)
	}
	existing, e := s.db.QueryRow(ctx, "SELECT kind,status FROM gallery_file_operations WHERE id=?", operationID)
	if e != nil {
		return FileOperation{}, e
	}
	if existing != nil {
		if str(existing, "kind") == "trash" && str(existing, "status") == "committed" {
			_, old, e := s.operation(ctx, operationID)
			return operationResult(operationID, "trash", old), e
		}
		return FileOperation{}, failure("operation_in_progress", 409)
	}
	items, _, e = s.selection(ctx, selection)
	if e != nil {
		return FileOperation{}, e
	}
	for i := range items {
		it := &items[i]
		it.Target = path.Join(".ldos/trash", operationID, "files", it.Origin)
		if snapshot := snapshots[it.AssetID]; snapshot != nil {
			it.Snapshot = clone(snapshot)
		}
	}
	return s.runNewOperation(ctx, operationID, "trash", items, sources)
}
func (s *Service) Transfer(ctx context.Context, selection Selection, targetDirectoryID, kind string) (FileOperation, error) {
	if kind != "copy" && kind != "move" {
		return FileOperation{}, failure("invalid_operation_kind", 422)
	}
	if len(selection.AssetIDs) != len(unique(selection.AssetIDs)) {
		return FileOperation{}, failure("asset_selection_invalid", 422)
	}
	if len(selection.DirectoryIDs) != len(unique(selection.DirectoryIDs)) {
		return FileOperation{}, failure("directory_selection_invalid", 422)
	}
	target, e := s.GetDirectory(ctx, targetDirectoryID)
	if e != nil {
		if errorCode(e) == "directory_not_found" {
			return FileOperation{}, failure("target_directory_not_found", 404)
		}
		return FileOperation{}, e
	}
	items, sources, e := s.selection(ctx, selection)
	if e != nil {
		if errorCode(e) == "directory_root_not_deletable" {
			return FileOperation{}, failure("directory_root_not_movable", 409)
		}
		return FileOperation{}, e
	}
	sources = unique(append(sources, str(target, "source_id")))
	if len(sources) != 1 {
		return FileOperation{}, failure("source_mismatch", 409)
	}
	release, e := s.LockSources(ctx, sources...)
	if e != nil {
		return FileOperation{}, e
	}
	defer release()
	items, _, e = s.selection(ctx, selection)
	if e != nil {
		return FileOperation{}, e
	}
	for i := range items {
		it := &items[i]
		it.TargetSourceID = str(target, "source_id")
		it.Target = path.Join(str(target, "relative_path"), path.Base(it.Origin))
		if it.SourceID == it.TargetSourceID && (it.Target == it.Origin || it.ItemType == "directory" && strings.HasPrefix(it.Target, it.Origin+"/")) {
			return FileOperation{}, failure("target_inside_source", 409)
		}
	}
	return s.runNewOperation(ctx, id(), kind, items, sources)
}
func (s *Service) runNewOperation(ctx context.Context, operationID, kind string, items []operationItem, sources []string) (FileOperation, error) {
	roots, close, e := s.openRoots(ctx, sources)
	if e != nil {
		return FileOperation{}, e
	}
	defer close()
	if e = s.prepareItems(ctx, items, roots, kind); e != nil {
		return FileOperation{}, e
	}
	if e = s.persistOperation(ctx, operationID, kind, sources, items); e != nil {
		return FileOperation{}, e
	}
	if e = s.applyOperation(ctx, operationID, kind, items, roots); e != nil {
		// Once purge starts it can only roll forward. Every other kind is reversible
		// until the DB commit; retries compare held inode identities before cleanup.
		recoveryCtx := context.WithoutCancel(ctx)
		if kind == "purge" {
			_ = s.exec(recoveryCtx, "UPDATE gallery_file_operations SET status='applying',updated_at=? WHERE id=?", now(), operationID)
			return FileOperation{}, e
		}
		_ = s.exec(recoveryCtx, "UPDATE gallery_file_operations SET status='rolling_back',updated_at=? WHERE id=?", now(), operationID)
		rollback := s.rollbackOperation(recoveryCtx, operationID, kind, items, roots)
		if rollback != nil {
			_ = s.exec(recoveryCtx, "UPDATE gallery_file_operations SET status='failed',updated_at=? WHERE id=?", now(), operationID)
			return FileOperation{}, &Error{Code: "operation_recovery_required", Status: 500, Cause: errors.Join(e, rollback)}
		}
		return FileOperation{}, wrapIO(e, "operation_failed")
	}
	return operationResult(operationID, kind, items), nil
}
func (s *Service) applyOperation(ctx context.Context, operationID, kind string, items []operationItem, roots map[string]*SafeRoot) error {
	if e := s.exec(ctx, "UPDATE gallery_file_operations SET status='applying',updated_at=? WHERE id=?", now(), operationID); e != nil {
		return e
	}
	for i := range items {
		if e := ctx.Err(); e != nil {
			return e
		}
		it := &items[i]
		source, target := roots[it.SourceID], roots[it.TargetSourceID]
		if it.Native.SourceRoot.Inode != 0 && !it.Native.SourceRoot.sameFile(source.identity) {
			return failure("source_changed", 409)
		}
		if it.Native.TargetRoot.Inode != 0 && !it.Native.TargetRoot.sameFile(target.identity) {
			return failure("source_changed", 409)
		}
		switch kind {
		case "copy":
			if e := s.copyOperationItem(ctx, operationID, it, source, target); e != nil {
				return e
			}
		case "purge":
			for j, rel := range itemPaths(*it, true) {
				st, e := source.Stat(rel)
				if errors.Is(e, os.ErrNotExist) {
					continue
				}
				if e != nil {
					return e
				}
				expected := itemIdentities(*it)[j]
				if expected.Inode != 0 && !expected.sameFile(st) {
					return failure("target_path_changed", 409)
				}
				if e = source.removeTree(rel, st); e != nil {
					return e
				}
			}
		default:
			for j, origin := range itemPaths(*it, true) {
				dest := itemPaths(*it, false)[j]
				expected := itemIdentities(*it)[j]
				if e := moveStep(source, origin, target, dest, expected); e != nil {
					return e
				}
			}
		}
		it.Status = "done"
		if e := s.updateItem(ctx, operationID, *it); e != nil {
			return e
		}
	}
	if kind == "trash" {
		for sid, root := range roots {
			manifest := Row{"operation_id": operationID, "kind": "trash", "source_id": sid, "items": []Row{}}
			list := []Row{}
			for _, it := range items {
				if it.SourceID == sid {
					list = append(list, Row{"item_type": it.ItemType, "asset_id": it.AssetID, "directory_id": it.DirectoryID, "origin_relative_path": it.Origin, "target_relative_path": it.Target, "has_txt": it.HasTxt})
				}
			}
			manifest["items"] = list
			rel := path.Join(".ldos/trash", operationID, "operation.json")
			_, version, _, e := root.ReadVersion(rel, 8<<20)
			if e != nil {
				return e
			}
			if version == MissingDiskVersion {
				if _, _, e = root.AtomicWrite(rel, []byte(jsonText(manifest)), version); e != nil {
					return e
				}
			}
		}
	}
	if kind == "copy" || kind == "move" {
		for _, sid := range operationSources(items) {
			if _, e := s.scanLocked(ctx, sid); e != nil {
				return e
			}
		}
	}
	return s.commitOperation(ctx, operationID, kind, items, roots)
}
func moveStep(source *SafeRoot, origin string, target *SafeRoot, dest string, expected fileIdentity) error {
	st, se := source.Stat(origin)
	dt, de := target.Stat(dest)
	if se != nil && !errors.Is(se, os.ErrNotExist) {
		return se
	}
	if de != nil && !errors.Is(de, os.ErrNotExist) {
		return de
	}
	if se == nil && de == nil {
		return failure("target_name_conflict", 409)
	}
	if errors.Is(se, os.ErrNotExist) && de == nil {
		if expected.Inode != 0 && !expected.sameFile(dt) {
			return failure("target_path_changed", 409)
		}
		return nil
	}
	if se != nil {
		return failure("asset_file_missing", 409)
	}
	if expected.Inode != 0 && !expected.sameSnapshot(st) && st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return failure("source_changed", 409)
	}
	if expected.Inode == 0 {
		expected = st
	}
	return source.RenameTo(origin, target, dest, &expected)
}
func (s *Service) rollbackOperation(ctx context.Context, operationID, kind string, items []operationItem, roots map[string]*SafeRoot) error {
	for i := len(items) - 1; i >= 0; i-- {
		it := items[i]
		source, target := roots[it.SourceID], roots[it.TargetSourceID]
		if kind == "copy" {
			if e := s.rollbackCopy(target, it); e != nil {
				return e
			}
			continue
		}
		origins, dests, identities := itemPaths(it, true), itemPaths(it, false), itemIdentities(it)
		for j := len(origins) - 1; j >= 0; j-- {
			origin, dest := origins[j], dests[j]
			dt, de := target.Stat(dest)
			if errors.Is(de, os.ErrNotExist) {
				continue
			}
			if de != nil {
				return de
			}
			expected := identities[j]
			if expected.Inode != 0 && !expected.sameFile(dt) {
				return failure("target_path_changed", 409)
			}
			exists, e := source.Exists(origin)
			if e != nil {
				return e
			}
			if exists {
				return failure("restore_target_conflict", 409)
			}
			if e = target.RenameTo(dest, source, origin, &dt); e != nil {
				return e
			}
		}
	}
	return s.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, "UPDATE gallery_file_operation_items SET status='rolled_back' WHERE operation_id=?", operationID); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, "UPDATE gallery_file_operations SET status='rolled_back',updated_at=?,finished_at=? WHERE id=?", now(), now(), operationID)
		return e
	})
}
func (s *Service) commitOperation(ctx context.Context, operationID, kind string, items []operationItem, roots map[string]*SafeRoot) error {
	captions := map[string]string{}
	if kind == "rename" || kind == "restore" {
		for _, it := range items {
			if it.ItemType == "asset" {
				b, _, _, e := roots[it.TargetSourceID].ReadVersion(CaptionRelativePath(it.Target), 8<<20)
				if e == nil {
					captions[it.AssetID], _ = decodeCaption(b)
				}
			} else {
				rows, e := s.db.QueryRows(ctx, `SELECT id,relative_path FROM gallery_assets WHERE source_id=? AND relative_path LIKE ? ESCAPE '\'`, it.SourceID, escapeLike(it.Target)+"/%")
				if e != nil {
					return e
				}
				for _, a := range rows {
					b, _, _, e := roots[it.SourceID].ReadVersion(CaptionRelativePath(str(a, "relative_path")), 8<<20)
					if e == nil {
						captions[str(a, "id")], _ = decodeCaption(b)
					}
				}
			}
		}
	}
	return s.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		for _, it := range items {
			switch kind {
			case "rename":
				txt := CaptionRelativePath(it.Target)
				_, e := tx.ExecContext(ctx, "UPDATE gallery_assets SET relative_path=?,name=?,sort_key=?,txt_relative_path=?,file_version=file_version+1,updated_at=? WHERE id=?", it.Target, path.Base(it.Target), NaturalSortKey(path.Base(it.Target)), txt, now(), it.AssetID)
				if e != nil {
					return e
				}
				a, e := store.QueryRowTx(ctx, tx, "SELECT * FROM gallery_assets WHERE id=?", it.AssetID)
				if e != nil {
					return e
				}
				if e = refreshFTSTx(ctx, tx, a, captions[it.AssetID]); e != nil {
					return e
				}
			case "trash", "restore", "purge":
				relative := it.Origin
				if kind != "trash" {
					relative = it.Target
				}
				where := "id=?"
				args := []any{it.AssetID}
				if it.ItemType == "directory" {
					where = `source_id=? AND relative_path LIKE ? ESCAPE '\'`
					args = []any{it.SourceID, escapeLike(relative) + "/%"}
				}
				rows, e := store.QueryRowsTx(ctx, tx, "SELECT * FROM gallery_assets WHERE "+where, args...)
				if e != nil {
					return e
				}
				for _, a := range rows {
					aid := str(a, "id")
					if kind == "purge" {
						if str(a, "lifecycle_state") != "trashed" {
							continue
						}
						if _, e = tx.ExecContext(ctx, "DELETE FROM gallery_search_index WHERE asset_id=?", aid); e != nil {
							return e
						}
						if _, e = tx.ExecContext(ctx, "DELETE FROM gallery_assets WHERE id=?", aid); e != nil {
							return e
						}
					} else {
						life := "trashed"
						if kind == "restore" {
							life = "active"
						}
						if _, e = tx.ExecContext(ctx, "UPDATE gallery_assets SET lifecycle_state=?,updated_at=? WHERE id=?", life, now(), aid); e != nil {
							return e
						}
						a["lifecycle_state"] = life
						if e = refreshFTSTx(ctx, tx, a, captions[aid]); e != nil {
							return e
						}
					}
				}
				if it.ItemType == "directory" {
					condition := `source_id=? AND (relative_path=? OR relative_path LIKE ? ESCAPE '\')`
					args := []any{it.SourceID, relative, escapeLike(relative) + "/%"}
					if kind == "purge" {
						_, e = tx.ExecContext(ctx, "DELETE FROM gallery_directories WHERE lifecycle_state='trashed' AND "+condition, args...)
					} else {
						life := "trashed"
						if kind == "restore" {
							life = "active"
						}
						args = append([]any{life, now()}, args...)
						_, e = tx.ExecContext(ctx, "UPDATE gallery_directories SET lifecycle_state=?,updated_at=? WHERE "+condition, args...)
					}
					if e != nil {
						return e
					}
				}
			}
		}
		if kind != "copy" && kind != "move" {
			for _, sid := range operationSources(items) {
				if _, e := tx.ExecContext(ctx, "UPDATE gallery_sources SET content_version=content_version+1,indexed_version=indexed_version+1,updated_at=?,dedup_state=CASE WHEN dedup_required=1 AND dedup_applied_version>0 THEN 'stale' ELSE dedup_state END WHERE id=?", now(), sid); e != nil {
					return e
				}
				if e := refreshCountsTx(ctx, tx, sid); e != nil {
					return e
				}
			}
		}
		if kind == "restore" || kind == "purge" {
			prior := ""
			if len(items) > 0 {
				prior = items[0].Native.TrashOperation
			}
			if prior != "" {
				status := "restored"
				if kind == "purge" {
					status = "purged"
				}
				if _, e := tx.ExecContext(ctx, "UPDATE gallery_file_operations SET status=?,updated_at=? WHERE id=?", status, now(), prior); e != nil {
					return e
				}
			}
		}
		if _, e := tx.ExecContext(ctx, "UPDATE gallery_file_operation_items SET status='done' WHERE operation_id=?", operationID); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, "UPDATE gallery_file_operations SET status='committed',updated_at=?,finished_at=? WHERE id=?", now(), now(), operationID)
		return e
	})
}
func (s *Service) Restore(ctx context.Context, trashOperationID string) (FileOperation, error) {
	return s.restoreOrPurge(ctx, trashOperationID, false)
}
func (s *Service) Undo(ctx context.Context, trashOperationID string) (FileOperation, error) {
	return s.Restore(ctx, trashOperationID)
}
func (s *Service) Purge(ctx context.Context, trashOperationID string) (FileOperation, error) {
	return s.restoreOrPurge(ctx, trashOperationID, true)
}
func (s *Service) restoreOrPurge(ctx context.Context, trashOperationID string, purge bool) (FileOperation, error) {
	op, items, e := s.operation(ctx, trashOperationID)
	if e != nil {
		return FileOperation{}, e
	}
	if str(op, "kind") != "trash" || str(op, "status") != "committed" {
		return FileOperation{}, failure("operation_not_reversible", 409)
	}
	sources := operationSources(items)
	release, e := s.LockSources(ctx, sources...)
	if e != nil {
		return FileOperation{}, e
	}
	defer release()
	op, items, e = s.operation(ctx, trashOperationID)
	if e != nil {
		return FileOperation{}, e
	}
	if str(op, "status") != "committed" {
		return FileOperation{}, failure("operation_not_reversible", 409)
	}
	kind := "restore"
	if purge {
		kind = "purge"
	}
	operationID := id()
	roots, close, e := s.openRoots(ctx, sources)
	if e != nil {
		return FileOperation{}, e
	}
	defer close()
	for i := range items {
		it := &items[i]
		if e := s.rebindTrashMount(ctx, roots[it.SourceID], it); e != nil {
			return FileOperation{}, e
		}
		it.Origin, it.Target = it.Target, it.Origin
		it.Native.TrashOperation = trashOperationID
		it.Status = "planned"
		it.Ordinal = i
		for j, rel := range itemPaths(*it, true) {
			st, e := roots[it.SourceID].Stat(rel)
			if e != nil {
				if purge && errors.Is(e, os.ErrNotExist) {
					continue
				}
				return FileOperation{}, wrapIO(e, "trash_file_missing")
			}
			expected := itemIdentities(*it)[j]
			if expected.Inode != 0 && !expected.sameFile(st) {
				return FileOperation{}, failure("target_path_changed", 409)
			}
			if j == 0 {
				it.Native.Image = st
			} else {
				it.Native.Caption = st
			}
		}
		if !purge {
			for _, dest := range itemPaths(*it, false) {
				exists, e := roots[it.SourceID].Exists(dest)
				if e != nil {
					return FileOperation{}, e
				}
				if exists {
					return FileOperation{}, failure("restore_target_conflict", 409)
				}
			}
		}
	}
	if e = s.persistOperation(ctx, operationID, kind, sources, items); e != nil {
		return FileOperation{}, e
	}
	if e = s.applyOperation(ctx, operationID, kind, items, roots); e != nil {
		if !purge {
			_ = s.exec(context.WithoutCancel(ctx), "UPDATE gallery_file_operations SET status='rolling_back' WHERE id=?", operationID)
			if rollback := s.rollbackOperation(context.WithoutCancel(ctx), operationID, kind, items, roots); rollback != nil {
				return FileOperation{}, &Error{Code: "operation_recovery_required", Status: 500, Cause: errors.Join(e, rollback)}
			}
		}
		return FileOperation{}, wrapIO(e, "operation_failed")
	}
	return operationResult(operationID, kind, items), nil
}

// Recover resumes planned/applying operations and completes interrupted rollback.
// Legacy plans lack native identities, so recovery accepts only unambiguous
// source-or-target presence; occupied source AND target is always a conflict.
func (s *Service) Recover(ctx context.Context) ([]Row, error) {
	rows, e := s.db.QueryRows(ctx, "SELECT id FROM gallery_file_operations WHERE status IN ('planned','applying','rolling_back','failed') ORDER BY created_at,id")
	if e != nil {
		return nil, e
	}
	out := []Row{}
	for _, row := range rows {
		operationID := str(row, "id")
		op, items, e := s.operation(ctx, operationID)
		if e != nil {
			return out, e
		}
		release, e := s.LockSources(ctx, operationSources(items)...)
		if e != nil {
			return out, e
		}
		roots, close, e := s.openRoots(ctx, operationSources(items))
		outcome := "failed"
		if e == nil {
			if str(op, "status") == "rolling_back" || str(op, "status") == "failed" {
				e = s.rollbackOperation(ctx, operationID, str(op, "kind"), items, roots)
				outcome = "rolled_back"
			} else {
				e = s.applyOperation(ctx, operationID, str(op, "kind"), items, roots)
				outcome = "committed"
			}
			close()
		}
		release()
		if e != nil {
			outcome = "failed"
			_ = s.exec(context.WithoutCancel(ctx), "UPDATE gallery_file_operation_items SET error_code=? WHERE operation_id=? AND status!='done'", errorCode(e), operationID)
		}
		out = append(out, Row{"operation_id": operationID, "outcome": outcome, "error_code": jobMessage(e)})
	}
	return out, nil
}
func (s *Service) GetOperation(ctx context.Context, operationID string) (Row, error) {
	op, items, e := s.operation(ctx, operationID)
	if e != nil {
		return nil, e
	}
	result := operationResult(operationID, str(op, "kind"), items)
	return Row{"operation_id": operationID, "kind": result.Kind, "status": op["status"], "item_count": result.ItemCount, "has_txt_count": result.HasTxtCount}, nil
}
