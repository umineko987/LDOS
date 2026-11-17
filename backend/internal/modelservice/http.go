package modelservice

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"unicode/utf8"
)

func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/models", func(w http.ResponseWriter, r *http.Request) { v, e := s.ListModels(r.Context()); respond(w, 200, v, e) })
	mux.HandleFunc("POST /api/v1/models/install", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Keys   []string `json:"keys"`
			Accept bool     `json:"accept_license"`
		}
		e := decode(w, r, &body)
		if e == nil && !validIDs(body.Keys, 16, 64) {
			e = validation()
		}
		var v Record
		if e == nil {
			v, e = s.Install(r.Context(), body.Keys, body.Accept)
		}
		respond(w, 202, v, e)
	})
	mux.HandleFunc("GET /api/v1/setup/models", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.SetupStatus(r.Context())
		respond(w, 200, v, e)
	})
	mux.HandleFunc("POST /api/v1/setup/models/install", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Proxy  *string  `json:"proxy_url"`
			Models []string `json:"models"`
		}
		e := decode(w, r, &body)
		if len(body.Models) > 3 || body.Proxy != nil && utf8.RuneCountInString(*body.Proxy) > 300 {
			e = validation()
		}
		proxy := ""
		if body.Proxy != nil {
			proxy = *body.Proxy
		}
		var v Record
		if e == nil {
			v, e = s.InstallSetup(r.Context(), proxy, body.Models)
		}
		respond(w, 202, v, e)
	})
	mux.HandleFunc("GET /api/v1/tagger/models", func(w http.ResponseWriter, r *http.Request) {
		if !s.deps.Settings.Tagger.Enabled {
			respond(w, 0, nil, failure(409, "tagger_disabled", "打标功能未启用"))
			return
		}
		respond(w, 200, s.ModelCatalog(), nil)
	})
	mux.HandleFunc("POST /api/v1/tagger/cancel", func(w http.ResponseWriter, r *http.Request) { v, e := s.Cancel(r.Context()); respond(w, 200, v, e) })
}
func validation() error { return failure(422, "validation_error", "请求参数校验失败") }
func validIDs(values []string, maxCount, maxLength int) bool {
	if len(values) < 1 || len(values) > maxCount {
		return false
	}
	for _, v := range values {
		if !utf8.ValidString(v) || utf8.RuneCountInString(v) < 1 || utf8.RuneCountInString(v) > maxLength {
			return false
		}
	}
	return true
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	var raw json.RawMessage
	if d.Decode(&raw) != nil {
		return validation()
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return validation()
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return validation()
	}
	for _, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return validation()
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(v) != nil {
		return validation()
	}
	return nil
}
func respond(w http.ResponseWriter, status int, v any, e error) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if e != nil {
		api := &Error{500, "internal_error", "模型服务操作失败"}
		var specific *Error
		if errors.As(e, &specific) {
			api = specific
		}
		status = api.Status
		v = Record{"error": Record{"code": api.Code, "message": api.Message, "details": nil, "request_id": w.Header().Get("X-Request-ID")}}
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
