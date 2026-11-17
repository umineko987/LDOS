package gallerycatalog

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type jsonHandler func(*http.Request) (any, error)

func (s *Service) route(mux *http.ServeMux, pattern string, status int, requiredView bool, handler jsonHandler) {
	mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		if value := r.URL.Query().Get("view"); value != "" && value != "desktop" || requiredView && value != "desktop" {
			writeError(w, failure("invalid_view", 422))
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if e := validateIdempotency(r.Header.Get("Idempotency-Key")); e != nil {
				writeError(w, e)
				return
			}
		}
		data, e := handler(r)
		if e != nil {
			writeError(w, e)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(data)
	})
}
func decodeRequest(r *http.Request, out any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(r.Body, 10<<20))
	if e := decoder.Decode(out); e != nil {
		return failure("invalid_request", 422)
	}
	var extra any
	if e := decoder.Decode(&extra); e != io.EOF {
		return failure("invalid_request", 422)
	}
	return nil
}
func validateIdempotency(key string) error {
	if key == "" {
		return nil
	}
	if len(key) > 128 {
		return failure("invalid_idempotency_key", 422)
	}
	for _, r := range key {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || strings.ContainsRune("._:-", r)) {
			return failure("invalid_idempotency_key", 422)
		}
	}
	return nil
}
func writeError(w http.ResponseWriter, err error) {
	code, status, details := "gallery_operation_failed", 500, Row{}
	var e *Error
	if errors.As(err, &e) {
		code, status = e.Code, e.Status
		if e.Details != nil {
			details = e.Details
		}
	}
	switch code {
	case "source_root_missing":
		code, status = "source_path_not_found", 404
	case "source_conflict":
		code = "source_path_conflict"
	case "scan_in_progress":
		code = "source_scan_in_progress"
	case "reconciliation_not_retryable":
		code = "gallery_reconciliation_not_retryable"
	case "directory_id_required":
		code = "gallery_search_directory_required"
	case "source_id_required":
		code = "gallery_search_source_required"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(Row{"error": Row{"code": code, "message": code, "details": details, "retryable": false}})
}
func queryOptions(r *http.Request, defaultLimit int) (ImageQuery, error) {
	v := r.URL.Query()
	q := ImageQuery{Scope: v.Get("scope"), SourceID: v.Get("source_id"), DirectoryID: v.Get("directory_id"), Query: v.Get("query"), TxtState: v.Get("txt_state"), ReadState: v.Get("read_state"), AssetCursor: v.Get("asset_cursor"), DirectoryCursor: v.Get("directory_cursor"), Limit: defaultLimit}
	if len([]rune(q.Query)) > 256 || len(q.AssetCursor) > 512 || len(q.DirectoryCursor) > 512 {
		return q, failure("invalid_gallery_request", 422)
	}
	if raw := v.Get("limit"); raw != "" {
		n, e := strconv.Atoi(raw)
		if e != nil || n < 1 || n > 200 {
			return q, failure("invalid_page_limit", 422)
		}
		q.Limit = n
	}
	if raw := v.Get("include_descendants"); raw != "" {
		b, e := strconv.ParseBool(raw)
		if e != nil {
			return q, failure("invalid_gallery_request", 422)
		}
		q.IncludeDescendants = b
	}
	return q, nil
}

// Register installs only gallery routes. The application owns the common origin,
// host and authentication middleware and the Service start/stop lifecycle.
func (s *Service) Register(mux *http.ServeMux) {
	const base = "/api/v1/gallery"
	s.route(mux, "GET "+base+"/sources", 200, false, func(r *http.Request) (any, error) {
		rows, e := s.ListSources(r.Context())
		return Row{"sources": rows}, e
	})
	s.route(mux, "GET "+base+"/sources/{source_id}", 200, false, func(r *http.Request) (any, error) { return s.GetSource(r.Context(), r.PathValue("source_id")) })
	s.route(mux, "POST "+base+"/imports", 201, false, func(r *http.Request) (any, error) {
		var body struct {
			Root string `json:"root_path"`
			Name string `json:"display_name"`
		}
		if e := decodeRequest(r, &body); e != nil {
			return nil, e
		}
		source, e := s.ImportSource(r.Context(), body.Root, body.Name)
		if e != nil {
			return nil, e
		}
		_, e = s.StartScan(r.Context(), str(source, "source_id"))
		return source, e
	})
	s.route(mux, "PATCH "+base+"/sources/{source_id}", 200, false, func(r *http.Request) (any, error) {
		var body struct {
			Name string `json:"display_name"`
		}
		if e := decodeRequest(r, &body); e != nil {
			return nil, e
		}
		return s.UpdateSource(r.Context(), r.PathValue("source_id"), body.Name)
	})
	s.route(mux, "DELETE "+base+"/sources/{source_id}", 200, false, func(r *http.Request) (any, error) {
		sid := r.PathValue("source_id")
		removeFiles := false
		if raw := r.URL.Query().Get("delete_files"); raw != "" {
			var e error
			removeFiles, e = strconv.ParseBool(raw)
			if e != nil {
				return nil, failure("invalid_request", 422)
			}
		}
		var e error
		if removeFiles {
			e = s.DeleteBatchSource(r.Context(), sid)
		} else {
			e = s.UnregisterSource(r.Context(), sid)
		}
		return Row{"source_id": sid, "removed": true}, e
	})
	s.route(mux, "POST "+base+"/sources/{source_id}/relink", 200, false, func(r *http.Request) (any, error) {
		var body struct {
			Root string `json:"root_path"`
		}
		if e := decodeRequest(r, &body); e != nil {
			return nil, e
		}
		sid := r.PathValue("source_id")
		source, e := s.RelinkSource(r.Context(), sid, body.Root)
		if e != nil {
			return nil, e
		}
		_, e = s.StartScan(r.Context(), sid)
		return source, e
	})
	s.route(mux, "POST "+base+"/sources/{source_id}/scan", 202, false, func(r *http.Request) (any, error) { return s.StartScan(r.Context(), r.PathValue("source_id")) })
	s.route(mux, "GET "+base+"/sources/{source_id}/scan", 200, false, func(r *http.Request) (any, error) { return s.GetScan(r.Context(), r.PathValue("source_id")) })
	s.route(mux, "POST "+base+"/sources/{source_id}/reconciliation/retry", 202, false, func(r *http.Request) (any, error) {
		return s.RetryReviewReconciliation(r.Context(), r.PathValue("source_id"))
	})
	s.route(mux, "GET "+base+"/directories/{directory_id}/entries", 200, false, func(r *http.Request) (any, error) {
		q, e := queryOptions(r, 100)
		if e != nil {
			return nil, e
		}
		result, e := s.DirectoryEntries(r.Context(), r.PathValue("directory_id"), q)
		if errorCode(e) == "invalid_cursor" {
			return nil, failure("invalid_gallery_cursor", 422)
		}
		return result, e
	})
	s.route(mux, "GET "+base+"/directories/{directory_id}/ancestors", 200, false, func(r *http.Request) (any, error) { return s.Ancestors(r.Context(), r.PathValue("directory_id")) })
	s.route(mux, "GET "+base+"/search", 200, false, func(r *http.Request) (any, error) {
		q, e := queryOptions(r, 100)
		if e != nil {
			return nil, e
		}
		if strings.TrimSpace(q.Query) == "" {
			return nil, failure("gallery_search_query_required", 422)
		}
		if q.Scope != "directory" && q.Scope != "source" && q.Scope != "library" {
			return nil, failure("invalid_gallery_search", 422)
		}
		page, e := s.ListImages(r.Context(), q)
		if errorCode(e) == "invalid_cursor" {
			return nil, failure("invalid_gallery_cursor", 422)
		}
		if e != nil {
			return nil, e
		}
		for i, a := range page.Assets {
			page.Assets[i] = publicAsset(a)
		}
		return Row{"scope": q.Scope, "assets": page.Assets, "asset_cursor": page.AssetCursor, "limit": page.Limit, "source_roots": page.SourceRoots}, nil
	})
	s.route(mux, "GET "+base+"/assets/{asset_id}", 200, false, func(r *http.Request) (any, error) {
		asset, e := s.GetImage(r.Context(), r.PathValue("asset_id"))
		if e != nil {
			return nil, e
		}
		source, e := s.Source(r.Context(), str(asset, "source_id"))
		if e != nil {
			return nil, e
		}
		return Row{"asset": publicAsset(asset), "source_roots": Row{str(asset, "source_id"): source["root_path"]}}, nil
	})
	s.route(mux, "GET "+base+"/assets/{asset_id}/annotation", 200, false, func(r *http.Request) (any, error) { return s.GetAnnotation(r.Context(), r.PathValue("asset_id")) })
	s.route(mux, "PUT "+base+"/assets/{asset_id}/annotation", 200, false, func(r *http.Request) (any, error) {
		var body struct {
			Content *string `json:"content"`
			Version int64   `json:"expected_txt_version"`
			Disk    string  `json:"expected_disk_version"`
		}
		if e := decodeRequest(r, &body); e != nil {
			return nil, e
		}
		if body.Content == nil {
			return nil, failure("invalid_request", 422)
		}
		return s.SaveAnnotation(r.Context(), r.PathValue("asset_id"), *body.Content, body.Version, body.Disk)
	})
	s.route(mux, "DELETE "+base+"/assets/{asset_id}/annotation", 200, false, func(r *http.Request) (any, error) {
		var body struct {
			Version int64  `json:"expected_txt_version"`
			Disk    string `json:"expected_disk_version"`
		}
		if e := decodeRequest(r, &body); e != nil {
			return nil, e
		}
		return s.RemoveAnnotation(r.Context(), r.PathValue("asset_id"), body.Version, body.Disk)
	})
	s.route(mux, "POST "+base+"/assets/{asset_id}/rename", 200, false, func(r *http.Request) (any, error) {
		var body struct {
			Stem string `json:"new_stem"`
		}
		if e := decodeRequest(r, &body); e != nil {
			return nil, e
		}
		return s.Rename(r.Context(), r.PathValue("asset_id"), body.Stem)
	})
	s.route(mux, "POST "+base+"/file-operations/trash", 200, false, func(r *http.Request) (any, error) {
		var body Selection
		if e := decodeRequest(r, &body); e != nil {
			return nil, e
		}
		return s.Trash(r.Context(), body)
	})
	s.route(mux, "POST "+base+"/file-operations/{kind}", 200, false, func(r *http.Request) (any, error) {
		var body struct {
			Selection
			Target string `json:"target_directory_id"`
		}
		if e := decodeRequest(r, &body); e != nil {
			return nil, e
		}
		if body.Target == "" {
			return nil, failure("invalid_request", 422)
		}
		return s.Transfer(r.Context(), body.Selection, body.Target, r.PathValue("kind"))
	})
	s.route(mux, "POST "+base+"/file-operations/{operation_id}/undo", 200, false, func(r *http.Request) (any, error) { return s.Undo(r.Context(), r.PathValue("operation_id")) })
	s.route(mux, "GET "+base+"/trash", 200, true, func(r *http.Request) (any, error) {
		q, e := queryOptions(r, 50)
		if e != nil {
			return nil, e
		}
		return s.ListTrash(r.Context(), r.URL.Query().Get("cursor"), q.Limit)
	})
	s.route(mux, "POST "+base+"/trash/{operation_id}/restore", 200, false, func(r *http.Request) (any, error) { return s.Restore(r.Context(), r.PathValue("operation_id")) })
	s.route(mux, "DELETE "+base+"/trash/{operation_id}", 200, false, func(r *http.Request) (any, error) { return s.Purge(r.Context(), r.PathValue("operation_id")) })
	s.route(mux, "DELETE "+base+"/trash", 200, false, func(r *http.Request) (any, error) { return s.PurgeAllTrash(r.Context()) })
	s.route(mux, "POST "+base+"/directory-exports", 202, false, func(r *http.Request) (any, error) {
		var body struct {
			DirectoryIDs []string `json:"directory_ids"`
			Target       string   `json:"target_path"`
		}
		if e := decodeRequest(r, &body); e != nil {
			return nil, e
		}
		return s.StartDirectoryExport(r.Context(), body.DirectoryIDs, body.Target, r.Header.Get("Idempotency-Key"))
	})
	s.route(mux, "GET "+base+"/directory-exports/{operation_id}", 200, true, func(r *http.Request) (any, error) { return s.GetDirectoryExport(r.PathValue("operation_id")) })
	s.route(mux, "DELETE "+base+"/directory-exports/{operation_id}", 200, false, func(r *http.Request) (any, error) { return s.CancelDirectoryExport(r.PathValue("operation_id")) })
	mux.HandleFunc("GET "+base+"/assets/{asset_id}/content", s.serveContent)
	mux.HandleFunc("GET "+base+"/assets/{asset_id}/thumbnail", s.serveThumbnail)
}
func (s *Service) serveContent(w http.ResponseWriter, r *http.Request) {
	assetID := r.PathValue("asset_id")
	f, a, e := s.OpenImage(r.Context(), assetID)
	if e != nil {
		if errorCode(e) == "asset_file_missing" {
			e = failure("asset_file_missing", 404)
		}
		writeError(w, e)
		return
	}
	defer f.Close()
	st, e := fileStat(f)
	if e != nil {
		writeError(w, e)
		return
	}
	types := map[string]string{".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
	w.Header().Set("Content-Type", types[str(a, "extension")])
	w.Header().Set("ETag", contentETag(assetID, st.Modified, st.Size))
	w.Header().Set("Cache-Control", "private, max-age=60")
	http.ServeContent(w, r, str(a, "name"), time.Unix(0, st.Modified), f)
}
func (s *Service) serveThumbnail(w http.ResponseWriter, r *http.Request) {
	size := 256
	var e error
	if raw := r.URL.Query().Get("size"); raw != "" {
		size, e = strconv.Atoi(raw)
		if e != nil {
			writeError(w, failure("invalid_thumbnail_size", 422))
			return
		}
	}
	data, etag, e := s.Thumbnail(r.Context(), r.PathValue("asset_id"), size)
	if e != nil {
		writeError(w, e)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(304)
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	if r.Method != "HEAD" {
		_, _ = w.Write(data)
	}
}
