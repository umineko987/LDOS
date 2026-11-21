package captions

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

func Decode(w http.ResponseWriter, r *http.Request, v any, optional bool) error {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20))
	d.DisallowUnknownFields()
	e := d.Decode(v)
	if optional && e == io.EOF {
		return nil
	}
	if e != nil {
		return Fail(422, "validation_error", "请求 JSON 无效: "+e.Error())
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return Fail(422, "validation_error", "只接受一个 JSON 请求")
	}
	return nil
}
func Respond(w http.ResponseWriter, status int, v any, e error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if e != nil {
		var api *Error
		if !errors.As(e, &api) {
			api = &Error{Status: 500, Code: "internal_error", Message: "操作失败"}
		}
		status = api.Status
		detail := Row{"code": api.Code, "message": api.Message}
		if api.Details != nil {
			detail["details"] = api.Details
		}
		detail["request_id"] = w.Header().Get("X-Request-ID")
		v = Row{"error": detail}
	}
	w.WriteHeader(status)
	if status != 204 {
		_ = json.NewEncoder(w).Encode(v)
	}
}
func ETagMatches(header, etag string) bool {
	if strings.TrimSpace(header) == "*" {
		return true
	}
	for _, part := range strings.Split(header, ",") {
		if strings.TrimPrefix(strings.TrimSpace(part), "W/") == etag {
			return true
		}
	}
	return false
}
func CachedJSON(w http.ResponseWriter, r *http.Request, etag string, body []byte) {
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, no-cache")
	if ETagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(304)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

const gallerySourcePath = "/api/v1/gallery/sources/{source_id}"

func (s *Service) Register(mux *http.ServeMux) {
	s.registerScope(mux, "/api/v1/datasets/{dataset_id}", false)
	s.registerScope(mux, gallerySourcePath, true)
	mux.HandleFunc("GET "+gallerySourcePath+"/kept", func(w http.ResponseWriter, r *http.Request) {
		ids, e := s.kept(r.Context(), r.PathValue("source_id"))
		Respond(w, 200, Row{"asset_ids": ids}, e)
	})
	mux.HandleFunc("PUT "+gallerySourcePath+"/kept", func(w http.ResponseWriter, r *http.Request) {
		var o struct {
			AssetIDs []string `json:"asset_ids"`
			Kept     *bool    `json:"kept"`
		}
		e := Decode(w, r, &o, false)
		if e == nil && o.Kept == nil {
			e = Fail(422, "validation_error", "缺少 kept")
		}
		if e != nil {
			Respond(w, 200, nil, e)
			return
		}
		updated, e := s.setKept(r.Context(), r.PathValue("source_id"), o.AssetIDs, *o.Kept)
		Respond(w, 200, Row{"updated": updated}, e)
	})
	mux.HandleFunc("POST /api/v1/caption-batches/{batch_id}/undo", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.Undo(r.Context(), r.PathValue("batch_id"))
		Respond(w, 200, v, e)
	})
}

func (s *Service) registerScope(mux *http.ServeMux, base string, source bool) {
	owner := func(r *http.Request) captionOwner {
		o := captionOwner{source: source}
		o.id = r.PathValue(o.field())
		return o
	}
	mux.HandleFunc("GET "+base+"/captions", func(w http.ResponseWriter, r *http.Request) {
		var etag string
		var body []byte
		var e error
		if source {
			query := r.URL.Query()
			directory := query.Get("directory_id")
			if directory == "" && query.Has("directory_id") {
				Respond(w, 200, nil, Fail(422, "validation_error", "directory_id 无效"))
				return
			}
			etag, body, e = s.sourceListing(r.Context(), owner(r).id, directory)
		} else {
			etag, body, e = s.Listing(r.Context(), owner(r).id)
		}
		if e != nil {
			Respond(w, 200, nil, e)
			return
		}
		CachedJSON(w, r, etag, body)
	})
	mux.HandleFunc("PUT "+base+"/captions/{asset_id}", func(w http.ResponseWriter, r *http.Request) {
		var o struct {
			Text    *string `json:"text"`
			Version string  `json:"expected_version"`
		}
		e := Decode(w, r, &o, false)
		if e == nil && o.Text == nil {
			e = Fail(422, "validation_error", "缺少 text")
		}
		if e != nil {
			Respond(w, 200, nil, e)
			return
		}
		v, e := s.edit(r.Context(), owner(r), r.PathValue("asset_id"), *o.Text, o.Version)
		Respond(w, 200, v, e)
	})
	mux.HandleFunc("POST "+base+"/captions/ops", func(w http.ResponseWriter, r *http.Request) {
		o := OpsOptions{SampleLimit: 20}
		if e := Decode(w, r, &o, false); e != nil {
			Respond(w, 200, nil, e)
			return
		}
		v, e := s.runOps(r.Context(), owner(r), o)
		Respond(w, 200, v, e)
	})
	mux.HandleFunc("GET "+base+"/caption-batches", func(w http.ResponseWriter, r *http.Request) {
		limit := 50
		var e error
		if raw := r.URL.Query().Get("limit"); raw != "" {
			limit, e = strconv.Atoi(raw)
		}
		if e != nil || limit < 1 || limit > 500 {
			Respond(w, 200, nil, Fail(422, "validation_error", "limit 无效"))
			return
		}
		var rows []Row
		if source {
			rows, e = s.sourceHistory(r.Context(), owner(r).id, limit)
		} else {
			rows, e = s.History(r.Context(), owner(r).id, limit)
		}
		Respond(w, 200, Row{"items": rows}, e)
	})
}
