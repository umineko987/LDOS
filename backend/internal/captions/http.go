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
func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/datasets/{dataset_id}/captions", func(w http.ResponseWriter, r *http.Request) {
		etag, body, e := s.Listing(r.Context(), r.PathValue("dataset_id"))
		if e != nil {
			Respond(w, 200, nil, e)
			return
		}
		CachedJSON(w, r, etag, body)
	})
	mux.HandleFunc("PUT /api/v1/datasets/{dataset_id}/captions/{asset_id}", func(w http.ResponseWriter, r *http.Request) {
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
		v, e := s.Edit(r.Context(), r.PathValue("dataset_id"), r.PathValue("asset_id"), *o.Text, o.Version)
		Respond(w, 200, v, e)
	})
	mux.HandleFunc("POST /api/v1/datasets/{dataset_id}/captions/ops", func(w http.ResponseWriter, r *http.Request) {
		o := OpsOptions{SampleLimit: 20}
		if e := Decode(w, r, &o, false); e != nil {
			Respond(w, 200, nil, e)
			return
		}
		v, e := s.RunOps(r.Context(), r.PathValue("dataset_id"), o)
		Respond(w, 200, v, e)
	})
	mux.HandleFunc("GET /api/v1/datasets/{dataset_id}/caption-batches", func(w http.ResponseWriter, r *http.Request) {
		limit := 50
		var e error
		if raw := r.URL.Query().Get("limit"); raw != "" {
			limit, e = strconv.Atoi(raw)
		}
		if e != nil || limit < 1 || limit > 500 {
			Respond(w, 200, nil, Fail(422, "validation_error", "limit 无效"))
			return
		}
		rows, e := s.History(r.Context(), r.PathValue("dataset_id"), limit)
		Respond(w, 200, Row{"items": rows}, e)
	})
	mux.HandleFunc("POST /api/v1/caption-batches/{batch_id}/undo", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.Undo(r.Context(), r.PathValue("batch_id"))
		Respond(w, 200, v, e)
	})
}
