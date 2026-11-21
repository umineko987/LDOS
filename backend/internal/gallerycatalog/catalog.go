package gallerycatalog

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"ldos/backend/internal/store"
)

// Source returns the internal projection, including root_path, for trusted peers.
// HTTP projects roots only in the explicit source_roots asset-protocol map.
func (s *Service) Source(ctx context.Context, sourceID string) (Row, error) {
	r, e := s.db.QueryRow(ctx, "SELECT * FROM gallery_sources WHERE id=?", sourceID)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, failure("source_not_found", 404)
	}
	r["source_id"] = r["id"]
	r["crawl_complete"] = truth(r, "crawl_complete")
	r["dedup_required"] = truth(r, "dedup_required")
	return s.sourceCounts(ctx, r)
}
func (s *Service) GetSource(ctx context.Context, sourceID string) (Row, error) {
	r, e := s.Source(ctx, sourceID)
	if e != nil {
		return nil, e
	}
	return publicSource(r), nil
}
func publicSource(r Row) Row {
	r = clone(r)
	delete(r, "id")
	delete(r, "root_path")
	delete(r, "canonical_root_key")
	if str(r, "dedup_state") == "reconciliation_pending" {
		r["dedup_state"] = "review_pending"
	}
	return r
}
func (s *Service) sourceCounts(ctx context.Context, r Row) (Row, error) {
	sid := str(r, "source_id")
	counts, e := s.db.QueryRow(ctx, `SELECT COUNT(CASE WHEN lifecycle_state='active' AND dedup_visibility!='excluded' THEN 1 END) asset_count,
 COUNT(CASE WHEN lifecycle_state='active' AND dedup_visibility='candidate' THEN 1 END) candidate_count,
 COUNT(CASE WHEN lifecycle_state='active' AND dedup_visibility='kept' THEN 1 END) kept_count,
 COUNT(CASE WHEN dedup_visibility='excluded' THEN 1 END) removed_count FROM gallery_assets WHERE source_id=?`, sid)
	if e != nil {
		return nil, e
	}
	for k, v := range counts {
		r[k] = v
	}
	root, e := s.db.QueryRow(ctx, "SELECT id FROM gallery_directories WHERE source_id=? AND relative_path='' AND lifecycle_state='active'", sid)
	if e != nil {
		return nil, e
	}
	r["root_directory_id"] = nil
	if root != nil {
		r["root_directory_id"] = root["id"]
	}
	r["reconciliation_state"] = "none"
	r["reconciliation_error_code"] = ""
	r["reconciliation_attempt_count"] = 0
	r["reconciliation_updated_at"] = nil
	event, e := s.db.QueryRow(ctx, "SELECT * FROM gallery_reconciliation_events WHERE source_id=? ORDER BY updated_at DESC LIMIT 1", sid)
	if e != nil {
		return nil, e
	}
	if event != nil {
		r["reconciliation_state"] = event["status"]
		r["reconciliation_error_code"] = event["error_code"]
		r["reconciliation_attempt_count"] = event["attempt_count"]
		r["reconciliation_updated_at"] = event["updated_at"]
		count, e := s.db.QueryRow(ctx, `SELECT COUNT(*) n FROM gallery_reconciliation_items WHERE event_id=? AND disposition='excluded_original'`, event["id"])
		if e != nil {
			return nil, e
		}
		if num(count, "n") > 0 {
			r["removed_count"] = num(count, "n")
		}
	}
	if !truth(r, "dedup_required") {
		r["dedup_state"] = "not_required"
	} else if r["reconciliation_state"] == "pending" || r["reconciliation_state"] == "failed" {
		r["dedup_state"] = "reconciliation_pending"
	} else if r["dedup_state"] == "applied" {
		if num(r, "dedup_applied_version") < num(r, "content_version") {
			r["dedup_state"] = "stale"
		}
	} else {
		review, err := s.db.QueryRow(ctx, "SELECT status FROM crawl_reviews WHERE batch_id=?", r["batch_id"])
		if err != nil {
			return nil, err
		}
		r["dedup_state"] = "pending_analysis"
		if review != nil && (review["status"] == "pending" || review["status"] == "ready") {
			r["dedup_state"] = "review_pending"
		}
	}
	return r, nil
}
func (s *Service) ListSources(ctx context.Context) ([]Row, error) {
	rows, e := s.db.QueryRows(ctx, "SELECT id FROM gallery_sources ORDER BY created_at,id")
	if e != nil {
		return nil, e
	}
	out := []Row{}
	for _, row := range rows {
		r, e := s.GetSource(ctx, str(row, "id"))
		if e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, nil
}
func (s *Service) ImportSource(ctx context.Context, rootPath, displayName string) (Row, error) {
	return s.registerSource(ctx, "imported", "", rootPath, displayName, false)
}
func (s *Service) RegisterBatchSource(ctx context.Context, batchID, rootPath, displayName string, dedupRequired bool) (Row, error) {
	return s.registerSource(ctx, "crawl_batch", batchID, rootPath, displayName, dedupRequired)
}
func validateRoot(rootPath string) (string, error) {
	if strings.TrimSpace(rootPath) == "" || len(rootPath) > 4096 {
		return "", failure("source_root_missing", 422)
	}
	abs, e := filepath.Abs(rootPath)
	if e != nil {
		return "", failure("source_root_missing", 422)
	}
	r, e := OpenSafeRoot(abs)
	if e != nil {
		return "", failure("source_root_missing", 422)
	}
	defer r.Close()
	return r.path, nil
}
func (s *Service) registerSource(ctx context.Context, kind, batchID, rootPath, displayName string, dedup bool) (Row, error) {
	root, e := validateRoot(rootPath)
	if e != nil {
		return nil, e
	}
	if displayName == "" {
		displayName = filepath.Base(root)
	}
	displayName = strings.TrimSpace(displayName)
	if displayName == "" || len([]rune(displayName)) > 200 {
		return nil, failure("invalid_display_name", 422)
	}
	sid := id()
	at := now()
	state := "not_required"
	if dedup {
		state = "pending_analysis"
	}
	var batch any
	if batchID != "" {
		batch = batchID
	}
	e = s.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		rows, e := store.QueryRowsTx(ctx, tx, "SELECT id,canonical_root_key FROM gallery_sources")
		if e != nil {
			return e
		}
		for _, other := range rows {
			relation := rootRelation(root, str(other, "canonical_root_key"))
			if relation != "disjoint" {
				return &Error{Code: "source_conflict", Status: 409, Details: Row{"conflicting_source_id": other["id"], "relation": relation}}
			}
		}
		_, e = tx.ExecContext(ctx, `INSERT INTO gallery_sources(id,kind,batch_id,display_name,root_path,canonical_root_key,crawl_complete,dedup_required,dedup_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, sid, kind, batch, displayName, root, root, kind == "crawl_batch", dedup, state, at, at)
		return e
	})
	if e != nil {
		return nil, e
	}
	return s.GetSource(ctx, sid)
}
func (s *Service) AutoRegisterBatchSource(ctx context.Context, batchID, rootPath, displayName string, dedupRequired bool) (Row, error) {
	old, e := s.db.QueryRow(ctx, "SELECT id FROM gallery_sources WHERE batch_id=?", batchID)
	if e != nil {
		return nil, e
	}
	if old != nil {
		return nil, nil
	}
	source, e := s.RegisterBatchSource(ctx, batchID, rootPath, displayName, dedupRequired)
	if e != nil {
		if errorCode(e) == "source_root_missing" || errorCode(e) == "source_conflict" {
			return nil, nil
		}
		return nil, e
	}
	_, e = s.StartScan(ctx, str(source, "source_id"))
	return source, e
}
func (s *Service) UpdateSource(ctx context.Context, sourceID, displayName string) (Row, error) {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" || len([]rune(displayName)) > 200 {
		return nil, failure("invalid_display_name", 422)
	}
	if _, e := s.Source(ctx, sourceID); e != nil {
		return nil, e
	}
	e := s.exec(ctx, "UPDATE gallery_sources SET display_name=?,updated_at=? WHERE id=?", displayName, now(), sourceID)
	if e != nil {
		return nil, e
	}
	return s.GetSource(ctx, sourceID)
}
func (s *Service) sourceBusy(ctx context.Context, sourceID string) error {
	s.mu.Lock()
	scan := s.scans[sourceID]
	running := scan != nil && str(scan.row, "state") == "running"
	s.mu.Unlock()
	if running {
		return failure("scan_in_progress", 409)
	}
	row, e := s.db.QueryRow(ctx, `SELECT 1 FROM gallery_file_operations WHERE status IN ('planned','applying','rolling_back','failed') AND EXISTS(SELECT 1 FROM json_each(source_ids_json) WHERE value=?) LIMIT 1`, sourceID)
	if e != nil {
		return e
	}
	if row != nil {
		return failure("operation_in_progress", 409)
	}
	return nil
}
func (s *Service) RelinkSource(ctx context.Context, sourceID, rootPath string) (Row, error) {
	if e := s.sourceBusy(ctx, sourceID); e != nil {
		return nil, e
	}
	release, e := s.LockSources(ctx, sourceID)
	if e != nil {
		return nil, e
	}
	defer release()
	root, e := validateRoot(rootPath)
	if e != nil {
		return nil, e
	}
	e = s.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		rows, e := store.QueryRowsTx(ctx, tx, "SELECT id,canonical_root_key FROM gallery_sources WHERE id!=?", sourceID)
		if e != nil {
			return e
		}
		for _, r := range rows {
			relation := rootRelation(root, str(r, "canonical_root_key"))
			if relation != "disjoint" {
				return &Error{Code: "source_conflict", Status: 409, Details: Row{"conflicting_source_id": r["id"], "relation": relation}}
			}
		}
		result, e := tx.ExecContext(ctx, "UPDATE gallery_sources SET root_path=?,canonical_root_key=?,availability='available',updated_at=? WHERE id=?", root, root, now(), sourceID)
		return checkRows(result, e, "source_not_found")
	})
	if e != nil {
		return nil, e
	}
	return s.GetSource(ctx, sourceID)
}
func (s *Service) UnregisterSource(ctx context.Context, sourceID string) error {
	return s.removeSource(ctx, sourceID, false)
}
func (s *Service) DeleteBatchSource(ctx context.Context, sourceID string) error {
	return s.removeSource(ctx, sourceID, true)
}
func (s *Service) removeSource(ctx context.Context, sourceID string, deleteFiles bool) error {
	if e := s.sourceBusy(ctx, sourceID); e != nil {
		return e
	}
	release, e := s.LockSources(ctx, sourceID)
	if e != nil {
		return e
	}
	defer release()
	source, e := s.Source(ctx, sourceID)
	if e != nil {
		return e
	}
	if deleteFiles && str(source, "kind") != "crawl_batch" {
		return failure("gallery_batch_source_required", 409)
	}
	if deleteFiles {
		root, e := OpenSafeRoot(str(source, "root_path"))
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			return wrapIO(e, "unsafe_source_path")
		}
		if e == nil {
			owned := root.identity
			root.Close()
			parent, e := OpenSafeRoot(filepath.Dir(str(source, "root_path")))
			if e != nil {
				return wrapIO(e, "unsafe_source_path")
			}
			defer parent.Close()
			if e = parent.removeTree(filepath.Base(str(source, "root_path")), owned); e != nil {
				return wrapIO(e, "source_delete_failed")
			}
		}
	}
	return s.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, "DELETE FROM gallery_search_index WHERE source_id=?", sourceID); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, "DELETE FROM gallery_sources WHERE id=?", sourceID)
		return e
	})
}
func projectAsset(r Row) Row { r = clone(r); r["asset_id"] = r["id"]; delete(r, "id"); return r }
func publicAsset(r Row) Row {
	r = clone(r)
	for _, k := range []string{"sort_key", "file_version", "txt_sha256", "created_at", "txt_content"} {
		delete(r, k)
	}
	if str(r, "txt_relative_path") == "" {
		r["txt_relative_path"] = nil
	}
	return r
}
func projectDirectory(r Row) Row {
	r = clone(r)
	r["directory_id"] = r["id"]
	delete(r, "id")
	var covers []string
	_ = json.Unmarshal([]byte(str(r, "cover_asset_ids_json")), &covers)
	if covers == nil {
		covers = []string{}
	}
	r["cover_asset_ids"] = covers
	for _, k := range []string{"sort_key", "cover_asset_ids_json", "lifecycle_state", "created_at", "updated_at"} {
		delete(r, k)
	}
	return r
}
func (s *Service) GetImage(ctx context.Context, assetID string) (Row, error) {
	r, e := s.db.QueryRow(ctx, "SELECT * FROM gallery_assets WHERE id=?", assetID)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, failure("asset_not_found", 404)
	}
	return projectAsset(r), nil
}
func (s *Service) GetDirectory(ctx context.Context, directoryID string) (Row, error) {
	r, e := s.db.QueryRow(ctx, "SELECT * FROM gallery_directories WHERE id=? AND lifecycle_state='active'", directoryID)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, failure("directory_not_found", 404)
	}
	return projectDirectory(r), nil
}
func (s *Service) RootDirectory(ctx context.Context, sourceID string) (Row, error) {
	r, e := s.db.QueryRow(ctx, "SELECT * FROM gallery_directories WHERE source_id=? AND relative_path='' AND lifecycle_state='active'", sourceID)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, failure("directory_not_found", 404)
	}
	return projectDirectory(r), nil
}

type ImageQuery struct {
	Scope, SourceID, DirectoryID, Query, TxtState, ReadState, AssetCursor, DirectoryCursor string
	IncludeDescendants                                                                     bool
	Limit                                                                                  int
}
type ImagePage struct {
	Assets      []Row             `json:"assets"`
	AssetCursor *string           `json:"asset_cursor"`
	Limit       int               `json:"limit"`
	SourceRoots map[string]string `json:"source_roots"`
}

func pageLimit(n int) (int, error) {
	if n == 0 {
		n = 100
	}
	if n < 1 || n > 200 {
		return 0, failure("invalid_limit", 422)
	}
	return n, nil
}

type pageCursor struct {
	Sort string `json:"s"`
	Name string `json:"n"`
	ID   string `json:"i"`
}

func encodeCursor(r Row) string {
	return base64.RawURLEncoding.EncodeToString([]byte(jsonText(pageCursor{str(r, "sort_key"), str(r, "name"), str(r, "id")})))
}
func decodeCursor(v string) (pageCursor, error) {
	var c pageCursor
	if len(v) > 512 {
		return c, failure("invalid_cursor", 422)
	}
	b, e := base64.RawURLEncoding.DecodeString(strings.TrimRight(v, "="))
	if e == nil {
		e = json.Unmarshal(b, &c)
	}
	if e != nil || c.ID == "" {
		return c, failure("invalid_cursor", 422)
	}
	return c, nil
}
func escapeLike(v string) string {
	r := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_")
	return r.Replace(v)
}
func (s *Service) ListImages(ctx context.Context, q ImageQuery) (ImagePage, error) {
	result := ImagePage{Assets: []Row{}, SourceRoots: map[string]string{}}
	limit, e := pageLimit(q.Limit)
	if e != nil {
		return result, e
	}
	result.Limit = limit
	where := []string{"a.lifecycle_state='active'", "a.dedup_visibility!='excluded'"}
	args := []any{}
	if q.DirectoryID != "" {
		d, e := s.GetDirectory(ctx, q.DirectoryID)
		if e != nil {
			return result, e
		}
		if q.SourceID != "" && q.SourceID != str(d, "source_id") {
			return result, failure("source_mismatch", 409)
		}
		q.SourceID = str(d, "source_id")
		if !q.IncludeDescendants {
			where = append(where, "a.directory_id=?")
			args = append(args, q.DirectoryID)
		} else if rel := str(d, "relative_path"); rel != "" {
			where = append(where, `a.relative_path LIKE ? ESCAPE '\'`)
			args = append(args, escapeLike(rel)+"/%")
		}
	}
	if q.SourceID != "" {
		if _, e = s.Source(ctx, q.SourceID); e != nil {
			return result, e
		}
		where = append(where, "a.source_id=?")
		args = append(args, q.SourceID)
	}
	if q.Scope == "source" && q.SourceID == "" {
		return result, failure("source_id_required", 422)
	}
	if q.Scope == "directory" && q.DirectoryID == "" {
		return result, failure("directory_id_required", 422)
	}
	if q.TxtState != "" {
		switch q.TxtState {
		case "normal", "missing", "blank", "invalid_encoding", "pair_conflict", "io_error":
		default:
			return result, failure("invalid_txt_state", 422)
		}
		where = append(where, "a.txt_state=?")
		args = append(args, q.TxtState)
	}
	if q.ReadState != "" {
		switch q.ReadState {
		case "pending", "ok", "failed":
		default:
			return result, failure("invalid_read_state", 422)
		}
		where = append(where, "a.read_state=?")
		args = append(args, q.ReadState)
	}
	for _, term := range strings.Fields(q.Query) {
		where = append(where, `(a.name LIKE ? ESCAPE '\' OR a.relative_path LIKE ? ESCAPE '\' OR EXISTS(SELECT 1 FROM gallery_search_index f WHERE f.asset_id=a.id AND f.txt_content LIKE ? ESCAPE '\'))`)
		v := "%" + escapeLike(term) + "%"
		args = append(args, v, v, v)
	}
	if q.AssetCursor != "" {
		c, e := decodeCursor(q.AssetCursor)
		if e != nil {
			return result, e
		}
		where = append(where, "(a.sort_key,a.name,a.id)>(?,?,?)")
		args = append(args, c.Sort, c.Name, c.ID)
	}
	args = append(args, limit+1)
	rows, e := s.db.QueryRows(ctx, "SELECT a.* FROM gallery_assets a WHERE "+strings.Join(where, " AND ")+" ORDER BY a.sort_key,a.name,a.id LIMIT ?", args...)
	if e != nil {
		return result, e
	}
	if len(rows) > limit {
		cursor := encodeCursor(rows[limit-1])
		result.AssetCursor = &cursor
		rows = rows[:limit]
	}
	for _, r := range rows {
		result.Assets = append(result.Assets, projectAsset(r))
		sid := str(r, "source_id")
		if _, ok := result.SourceRoots[sid]; !ok {
			source, e := s.db.QueryRow(ctx, "SELECT root_path FROM gallery_sources WHERE id=?", sid)
			if e != nil {
				return result, e
			}
			result.SourceRoots[sid] = str(source, "root_path")
		}
	}
	return result, nil
}
func (s *Service) DirectoryEntries(ctx context.Context, directoryID string, q ImageQuery) (Row, error) {
	d, e := s.GetDirectory(ctx, directoryID)
	if e != nil {
		return nil, e
	}
	q.DirectoryID = directoryID
	page, e := s.ListImages(ctx, q)
	if e != nil {
		return nil, e
	}
	args := []any{directoryID}
	where := "parent_id=? AND lifecycle_state='active'"
	if q.DirectoryCursor != "" {
		c, e := decodeCursor(q.DirectoryCursor)
		if e != nil {
			return nil, e
		}
		where += " AND (sort_key,name,id)>(?,?,?)"
		args = append(args, c.Sort, c.Name, c.ID)
	}
	args = append(args, page.Limit+1)
	rows, e := s.db.QueryRows(ctx, "SELECT * FROM gallery_directories WHERE "+where+" ORDER BY sort_key,name,id LIMIT ?", args...)
	if e != nil {
		return nil, e
	}
	var next *string
	if len(rows) > page.Limit {
		c := encodeCursor(rows[page.Limit-1])
		next = &c
		rows = rows[:page.Limit]
	}
	dirs := []Row{}
	for _, r := range rows {
		dirs = append(dirs, projectDirectory(r))
	}
	source, e := s.Source(ctx, str(d, "source_id"))
	if e != nil {
		return nil, e
	}
	page.SourceRoots[str(d, "source_id")] = str(source, "root_path")
	for i, a := range page.Assets {
		page.Assets[i] = publicAsset(a)
	}
	return Row{"directory": d, "directories": dirs, "assets": page.Assets, "directory_cursor": next, "asset_cursor": page.AssetCursor, "include_descendants": q.IncludeDescendants, "limit": page.Limit, "source_roots": page.SourceRoots}, nil
}
func (s *Service) Ancestors(ctx context.Context, directoryID string) (Row, error) {
	d, e := s.GetDirectory(ctx, directoryID)
	if e != nil {
		return nil, e
	}
	out := []Row{}
	for str(d, "parent_id") != "" {
		d, e = s.GetDirectory(ctx, str(d, "parent_id"))
		if e != nil {
			return nil, e
		}
		out = append([]Row{{"directory_id": d["directory_id"], "name": d["name"]}}, out...)
	}
	return Row{"directory_id": directoryID, "ancestors": out}, nil
}

// refreshCountsTx keeps physical directory visibility separate from visible image
// counts; excluded assets never become covers or appear in an ancestor count.
func refreshCountsTx(ctx context.Context, tx *sql.Tx, sourceID string) error {
	dirs, e := store.QueryRowsTx(ctx, tx, "SELECT id,relative_path FROM gallery_directories WHERE source_id=? AND lifecycle_state='active'", sourceID)
	if e != nil {
		return e
	}
	for _, d := range dirs {
		rel := str(d, "relative_path")
		prefix := "%"
		if rel != "" {
			prefix = escapeLike(rel) + "/%"
		}
		direct, e := store.QueryRowTx(ctx, tx, `SELECT (SELECT count(*) FROM gallery_directories WHERE parent_id=? AND lifecycle_state='active') dirs,(SELECT count(*) FROM gallery_assets WHERE directory_id=? AND lifecycle_state='active' AND dedup_visibility!='excluded') assets`, d["id"], d["id"])
		if e != nil {
			return e
		}
		count, e := store.QueryRowTx(ctx, tx, `SELECT count(*) n FROM gallery_assets WHERE source_id=? AND relative_path LIKE ? ESCAPE '\' AND lifecycle_state='active' AND dedup_visibility!='excluded'`, sourceID, prefix)
		if e != nil {
			return e
		}
		covers, e := store.QueryRowsTx(ctx, tx, `SELECT id FROM gallery_assets WHERE source_id=? AND relative_path LIKE ? ESCAPE '\' AND lifecycle_state='active' AND dedup_visibility!='excluded' ORDER BY sort_key,name,id LIMIT 9`, sourceID, prefix)
		if e != nil {
			return e
		}
		ids := []string{}
		for _, a := range covers {
			ids = append(ids, str(a, "id"))
		}
		_, e = tx.ExecContext(ctx, "UPDATE gallery_directories SET direct_directory_count=?,direct_asset_count=?,recursive_asset_count=?,cover_asset_ids_json=?,updated_at=? WHERE id=?", direct["dirs"], direct["assets"], count["n"], jsonText(ids), now(), d["id"])
		if e != nil {
			return e
		}
	}
	return nil
}
func refreshFTSTx(ctx context.Context, tx *sql.Tx, asset Row, content string) error {
	aid := str(asset, "id")
	if aid == "" {
		aid = str(asset, "asset_id")
	}
	if _, e := tx.ExecContext(ctx, "DELETE FROM gallery_search_index WHERE asset_id=?", aid); e != nil {
		return e
	}
	if str(asset, "lifecycle_state") != "active" || str(asset, "dedup_visibility") == "excluded" {
		return nil
	}
	if str(asset, "txt_state") != "normal" {
		content = ""
	}
	_, e := tx.ExecContext(ctx, "INSERT INTO gallery_search_index(asset_id,source_id,file_name,relative_path,txt_content) VALUES(?,?,?,?,?)", aid, asset["source_id"], asset["name"], asset["relative_path"], content)
	return e
}
