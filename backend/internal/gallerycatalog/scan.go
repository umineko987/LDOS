package gallerycatalog

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path"
	"sort"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
	"ldos/backend/internal/activity"
	"ldos/backend/internal/store"
)

func decodeCaption(b []byte) (string, bool) {
	b = []byte(strings.TrimPrefix(string(b), "\ufeff"))
	return string(b), utf8.Valid(b)
}
func captionState(data []byte, exists, readOK, conflict bool) string {
	if conflict {
		return "pair_conflict"
	}
	if !readOK {
		return "io_error"
	}
	if !exists {
		return "missing"
	}
	content, valid := decodeCaption(data)
	if !valid {
		return "invalid_encoding"
	}
	if strings.TrimSpace(content) == "" {
		return "blank"
	}
	return "normal"
}

func (s *Service) Scan(ctx context.Context, sourceID string) (Row, error) {
	release, e := s.LockSources(ctx, sourceID)
	if e != nil {
		return nil, e
	}
	stats, e := s.scanLocked(ctx, sourceID)
	release()
	if e == nil && !truth(stats, "offline") {
		s.mu.Lock()
		listeners := append([]func(string){}, s.scanListeners...)
		s.mu.Unlock()
		for _, fn := range listeners {
			fn(sourceID)
		}
		_ = s.EnqueueMissingHashes(ctx, sourceID)
	}
	return stats, e
}
func (s *Service) scanLocked(ctx context.Context, sourceID string) (Row, error) {
	source, e := s.Source(ctx, sourceID)
	if e != nil {
		return nil, e
	}
	root, e := OpenSafeRoot(str(source, "root_path"))
	stats := Row{"asset_count": 0, "candidate_count": 0, "kept_count": 0, "removed_count": 0, "directory_count": 0, "content_changed": false, "annotation_changed": false, "indexed_version": num(source, "indexed_version"), "offline": false, "skipped_temporary": 0, "skipped_unsupported": 0}
	if e != nil {
		if errors.Is(e, os.ErrNotExist) {
			if e = s.exec(ctx, "UPDATE gallery_sources SET availability='offline',updated_at=? WHERE id=?", now(), sourceID); e != nil {
				return nil, e
			}
			stats["offline"] = true
			for _, k := range []string{"asset_count", "candidate_count", "kept_count", "removed_count"} {
				stats[k] = source[k]
			}
			return stats, nil
		}
		return nil, wrapIO(e, "unsafe_source_path")
	}
	defer root.Close()
	previous, e := s.db.QueryRows(ctx, "SELECT * FROM gallery_assets WHERE source_id=?", sourceID)
	if e != nil {
		return nil, e
	}
	old := map[string]Row{}
	for _, a := range previous {
		old[str(a, "relative_path")] = a
	}
	assets := []Row{}
	dirs := map[string]bool{"": true}
	jobID := "scan:" + sourceID
	var walk func(string) error
	walk = func(relative string) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		entries, e := root.ReadDir(relative)
		if e != nil {
			return e
		}
		pairs := map[string]int{}
		for _, entry := range entries {
			if entry.Type()&os.ModeSymlink == 0 && !entry.IsDir() && SupportedImage(entry.Name()) {
				pairs[CaptionRelativePath(entry.Name())]++
			}
		}
		for _, entry := range entries {
			if e := ctx.Err(); e != nil {
				return e
			}
			rel := path.Join(relative, entry.Name())
			if reserved(rel) || strings.HasPrefix(entry.Name(), ".ldos-txt-") {
				stats["skipped_temporary"] = num(stats, "skipped_temporary") + 1
				continue
			}
			if entry.Type()&os.ModeSymlink != 0 || ValidateRelativePath(rel, false) != nil {
				continue
			}
			if entry.IsDir() {
				if e = walk(rel); e != nil {
					return e
				}
				continue
			}
			if !SupportedImage(entry.Name()) {
				stats["skipped_unsupported"] = num(stats, "skipped_unsupported") + 1
				continue
			}
			st, e := root.Stat(rel)
			if errors.Is(e, os.ErrNotExist) {
				continue
			}
			if e != nil {
				return e
			}
			if st.Mode&unix.S_IFMT != unix.S_IFREG {
				continue
			}
			txt := CaptionRelativePath(rel)
			bytes, _, ts, te := root.ReadVersion(txt, 8<<20)
			exists := te == nil && bytes != nil
			state := captionState(bytes, exists, te == nil, pairs[CaptionRelativePath(entry.Name())] > 1)
			content := ""
			if state == "normal" {
				content, _ = decodeCaption(bytes)
			}
			txtRel := txt
			format, width, height, readState, code := "", 0, 0, "ok", ""
			prior := old[rel]
			if prior != nil && num(prior, "size_bytes") == st.Size && num(prior, "modified_ns") == st.Modified && str(prior, "lifecycle_state") == "active" {
				format = str(prior, "format")
				width = int(num(prior, "width"))
				height = int(num(prior, "height"))
				readState = str(prior, "read_state")
				code = str(prior, "error_code")
			} else {
				f, e := root.Open(rel)
				if e != nil {
					readState = "failed"
					code = "image_read_failed"
				} else {
					format, width, height, e = s.probeImage(ctx, f)
					f.Close()
					if e != nil {
						readState = "failed"
						code = "image_read_failed"
					}
				}
			}
			a := Row{"relative_path": rel, "name": entry.Name(), "extension": strings.ToLower(path.Ext(rel)), "size_bytes": st.Size, "modified_ns": st.Modified, "format": format, "width": width, "height": height, "read_state": readState, "error_code": code, "txt_relative_path": txtRel, "txt_size_bytes": ts.Size, "txt_modified_ns": ts.Modified, "txt_sha256": "", "txt_state": state, "txt_content": content}
			if exists {
				a["txt_sha256"] = digest(bytes)
			}
			assets = append(assets, a)
			for d := parentRelative(rel); ; d = parentRelative(d) {
				dirs[d] = true
				if d == "" {
					break
				}
			}
			s.progressJob(jobID, len(assets), nil)
		}
		return nil
	}
	if e = walk(""); e != nil {
		return nil, wrapIO(e, "io_error")
	}
	if e = root.AssertCurrent(); e != nil {
		return nil, e
	}
	total := len(assets)
	s.progressJob(jobID, total, &total)
	sorted := make([]string, 0, len(dirs))
	for d := range dirs {
		sorted = append(sorted, d)
	}
	sort.Slice(sorted, func(i, j int) bool {
		if len(sorted[i]) != len(sorted[j]) {
			return len(sorted[i]) < len(sorted[j])
		}
		return sorted[i] < sorted[j]
	})
	e = s.commitScan(ctx, source, sorted, assets, stats)
	if e != nil {
		return nil, e
	}
	fresh, e := s.Source(ctx, sourceID)
	if e != nil {
		return nil, e
	}
	for _, k := range []string{"asset_count", "candidate_count", "kept_count", "removed_count", "indexed_version"} {
		stats[k] = fresh[k]
	}
	stats["directory_count"] = len(sorted)
	return stats, nil
}
func (s *Service) commitScan(ctx context.Context, source Row, dirs []string, assets []Row, stats Row) error {
	sid := str(source, "source_id")
	at := now()
	return s.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		current, e := store.QueryRowTx(ctx, tx, "SELECT * FROM gallery_sources WHERE id=?", sid)
		if e != nil {
			return e
		}
		if current == nil {
			return failure("source_not_found", 404)
		}
		if num(current, "indexed_version") != num(source, "indexed_version") {
			return failure("scan_snapshot_conflict", 409)
		}
		rows, e := store.QueryRowsTx(ctx, tx, "SELECT * FROM gallery_assets WHERE source_id=?", sid)
		if e != nil {
			return e
		}
		previous := map[string]Row{}
		for _, r := range rows {
			previous[str(r, "relative_path")] = r
		}
		rejected := map[string]bool{}
		original := map[string]bool{}
		kept := map[string]bool{}
		rules, e := store.QueryRowsTx(ctx, tx, `SELECT i.relative_path,i.disposition FROM gallery_reconciliation_items i JOIN gallery_reconciliation_events e ON i.event_id=e.id WHERE e.source_id=?`, sid)
		if e != nil {
			return e
		}
		for _, r := range rules {
			switch str(r, "disposition") {
			case "excluded":
				rejected[str(r, "relative_path")] = true
			case "excluded_original":
				original[str(r, "relative_path")] = true
			case "kept":
				kept[str(r, "relative_path")] = true
			}
		}
		indexed := num(current, "indexed_version") + 1
		seen := map[string]bool{}
		contentChanged, annotationChanged := false, false
		for _, a := range assets {
			rel := str(a, "relative_path")
			seen[rel] = true
			prior := previous[rel]
			if prior == nil {
				if !rejected[rel] {
					contentChanged = true
				}
			} else {
				if str(prior, "lifecycle_state") == "missing" || num(prior, "size_bytes") != num(a, "size_bytes") || num(prior, "modified_ns") != num(a, "modified_ns") {
					contentChanged = true
				}
				if num(prior, "txt_size_bytes") != num(a, "txt_size_bytes") || num(prior, "txt_modified_ns") != num(a, "txt_modified_ns") || str(prior, "txt_state") != str(a, "txt_state") {
					annotationChanged = true
				}
			}
		}
		for rel, prior := range previous {
			if !seen[rel] && str(prior, "lifecycle_state") == "active" && !(original[rel] && str(prior, "dedup_visibility") == "excluded") {
				contentChanged = true
			}
		}
		if _, e = tx.ExecContext(ctx, "UPDATE gallery_directories SET lifecycle_state='missing' WHERE source_id=? AND lifecycle_state='active'", sid); e != nil {
			return e
		}
		for _, rel := range dirs {
			var parent any
			name := str(current, "display_name")
			if rel != "" {
				parent = DirectoryID(sid, parentRelative(rel))
				name = path.Base(rel)
			}
			_, e = tx.ExecContext(ctx, `INSERT INTO gallery_directories(id,source_id,parent_id,relative_path,name,sort_key,indexed_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,relative_path) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,sort_key=excluded.sort_key,indexed_version=excluded.indexed_version,lifecycle_state='active',updated_at=excluded.updated_at`, DirectoryID(sid, rel), sid, parent, rel, name, NaturalSortKey(name), indexed, at, at)
			if e != nil {
				return e
			}
		}
		if _, e = tx.ExecContext(ctx, "DELETE FROM gallery_search_index WHERE source_id=?", sid); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, "UPDATE gallery_assets SET lifecycle_state='missing' WHERE source_id=? AND lifecycle_state='active'", sid); e != nil {
			return e
		}
		for _, a := range assets {
			rel := str(a, "relative_path")
			prior := previous[rel]
			if prior != nil && str(prior, "lifecycle_state") == "trashed" {
				continue
			}
			aid := AssetID(sid, rel)
			visibility := "candidate"
			hash := ""
			cv, fv, tv := int64(1), int64(1), int64(1)
			if prior != nil {
				aid = str(prior, "id")
				visibility = str(prior, "dedup_visibility")
				cv = num(prior, "content_version")
				fv = num(prior, "file_version")
				tv = num(prior, "txt_version")
				hash = str(prior, "content_sha256")
				if num(prior, "size_bytes") != num(a, "size_bytes") || num(prior, "modified_ns") != num(a, "modified_ns") || str(prior, "lifecycle_state") != "active" {
					hash = ""
					cv++
					fv++
				}
				if num(prior, "txt_size_bytes") != num(a, "txt_size_bytes") || num(prior, "txt_modified_ns") != num(a, "txt_modified_ns") || str(prior, "txt_state") != str(a, "txt_state") {
					tv++
				}
			}
			if original[rel] && !rejected[rel] && (prior == nil || str(prior, "lifecycle_state") == "missing") {
				visibility = "candidate"
			}
			if kept[rel] {
				visibility = "kept"
			}
			if rejected[rel] {
				visibility = "excluded"
			}
			_, e = tx.ExecContext(ctx, `INSERT INTO gallery_assets(id,source_id,directory_id,relative_path,name,extension,sort_key,size_bytes,modified_ns,file_version,content_sha256,content_version,format,width,height,read_state,error_code,txt_relative_path,txt_size_bytes,txt_modified_ns,txt_sha256,txt_version,txt_state,dedup_visibility,lifecycle_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET directory_id=excluded.directory_id,name=excluded.name,extension=excluded.extension,sort_key=excluded.sort_key,size_bytes=excluded.size_bytes,modified_ns=excluded.modified_ns,file_version=excluded.file_version,content_sha256=excluded.content_sha256,content_version=excluded.content_version,format=excluded.format,width=excluded.width,height=excluded.height,read_state=excluded.read_state,error_code=excluded.error_code,txt_relative_path=excluded.txt_relative_path,txt_size_bytes=excluded.txt_size_bytes,txt_modified_ns=excluded.txt_modified_ns,txt_sha256=excluded.txt_sha256,txt_version=excluded.txt_version,txt_state=excluded.txt_state,dedup_visibility=excluded.dedup_visibility,lifecycle_state='active',updated_at=excluded.updated_at`, aid, sid, DirectoryID(sid, parentRelative(rel)), rel, a["name"], a["extension"], NaturalSortKey(str(a, "name")), a["size_bytes"], a["modified_ns"], fv, hash, cv, a["format"], a["width"], a["height"], a["read_state"], a["error_code"], a["txt_relative_path"], a["txt_size_bytes"], a["txt_modified_ns"], a["txt_sha256"], tv, a["txt_state"], visibility, at, at)
			if e != nil {
				return e
			}
			a["id"] = aid
			a["source_id"] = sid
			a["lifecycle_state"] = "active"
			a["dedup_visibility"] = visibility
			if e = refreshFTSTx(ctx, tx, a, str(a, "txt_content")); e != nil {
				return e
			}
		}
		state := str(current, "dedup_state")
		if truth(current, "dedup_required") && contentChanged && num(current, "dedup_applied_version") > 0 {
			state = "stale"
		}
		_, e = tx.ExecContext(ctx, `UPDATE gallery_sources SET availability='available',indexed_version=?,content_version=content_version+?,annotation_version=annotation_version+?,dedup_state=?,last_scanned_at=?,updated_at=? WHERE id=?`, indexed, contentChanged, annotationChanged, state, at, at, sid)
		if e != nil {
			return e
		}
		stats["content_changed"] = contentChanged
		stats["annotation_changed"] = annotationChanged
		return refreshCountsTx(ctx, tx, sid)
	})
}
func (s *Service) StartScan(ctx context.Context, sourceID string) (Row, error) {
	source, e := s.Source(ctx, sourceID)
	if e != nil {
		return nil, e
	}
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return nil, failure("service_stopping", 503)
	}
	if str(s.scans[sourceID], "state") == "running" {
		s.mu.Unlock()
		return nil, failure("scan_in_progress", 409)
	}
	op := Row{"operation_id": id(), "source_id": sourceID, "state": "running", "started_at": now(), "finished_at": nil, "error_code": "", "stats": nil}
	s.scans[sourceID] = op
	result := clone(op)
	s.wg.Add(1)
	s.mu.Unlock()
	if s.jobs != nil {
		_, _ = s.jobs.Start("gallery.scan", "扫描 "+str(source, "display_name"), activity.StartOptions{ID: "scan:" + sourceID, Ref: map[string]string{"source_id": sourceID, "operation_id": str(op, "operation_id")}})
	}
	go func() {
		defer s.wg.Done()
		stats, e := s.Scan(s.ctx, sourceID)
		state, code := "succeeded", ""
		if e != nil {
			state = "failed"
			code = errorCode(e)
			if code == "io_error" {
				code = "scan_failed"
			}
		}
		s.mu.Lock()
		if str(s.scans[sourceID], "operation_id") == str(op, "operation_id") {
			s.scans[sourceID] = Row{"operation_id": op["operation_id"], "source_id": sourceID, "state": state, "started_at": op["started_at"], "finished_at": now(), "error_code": code, "stats": stats}
		}
		s.mu.Unlock()
		s.finishJob("scan:"+sourceID, e, int(num(stats, "asset_count")))
	}()
	return result, nil
}
func (s *Service) GetScan(ctx context.Context, sourceID string) (Row, error) {
	if _, e := s.Source(ctx, sourceID); e != nil {
		return nil, e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.scans[sourceID]; r != nil {
		return clone(r), nil
	}
	return Row{"operation_id": nil, "source_id": sourceID, "state": "idle", "started_at": nil, "finished_at": nil, "error_code": "", "stats": nil}, nil
}
