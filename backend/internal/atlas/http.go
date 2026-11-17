package atlas

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"ldos/backend/internal/datasets"
	"net/http"
	"strconv"
	"unicode/utf8"
)

func (s *Service) Register(mux *http.ServeMux) {
	prefix := "/api/v1/datasets/{dataset_id}/atlas"
	mux.HandleFunc("GET "+prefix, func(w http.ResponseWriter, r *http.Request) {
		v, etag, e := s.Payload(r.Context(), r.PathValue("dataset_id"), r.Header.Get("If-None-Match"))
		if e != nil {
			respond(w, 0, nil, e)
			return
		}
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", "private, no-cache")
		if v == nil {
			w.WriteHeader(304)
			return
		}
		respond(w, 200, v, nil)
	})
	mux.HandleFunc("POST "+prefix+"/run", func(w http.ResponseWriter, r *http.Request) {
		var body RunRequest
		e := decode(w, r, &body, true)
		var v Record
		if e == nil {
			v, e = s.Run(r.Context(), r.PathValue("dataset_id"), body)
		}
		respond(w, 202, v, e)
	})
	mux.HandleFunc("POST "+prefix+"/cancel", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.Cancel(r.Context(), r.PathValue("dataset_id"))
		respond(w, 200, v, e)
	})
	for _, action := range []string{"remove", "restore"} {
		mux.HandleFunc("POST "+prefix+"/"+action, func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				IDs []string `json:"asset_ids"`
			}
			e := decode(w, r, &body, false)
			if e == nil {
				if len(body.IDs) < 1 || len(body.IDs) > 5000 {
					e = validation()
				}
				for _, id := range body.IDs {
					if !utf8.ValidString(id) || utf8.RuneCountInString(id) < 1 || utf8.RuneCountInString(id) > 128 {
						e = validation()
					}
				}
			}
			var v Record
			if e == nil {
				if action == "remove" {
					v, e = s.Remove(r.Context(), r.PathValue("dataset_id"), body.IDs)
				} else {
					v, e = s.Restore(r.Context(), r.PathValue("dataset_id"), body.IDs)
				}
			}
			respond(w, 200, v, e)
		})
	}
	mux.HandleFunc("GET "+prefix+"/sprites/{index}", func(w http.ResponseWriter, r *http.Request) {
		index, e := strconv.Atoi(r.PathValue("index"))
		run := r.URL.Query().Get("run")
		if e != nil || index < 0 || index > 9999 || r.URL.Query().Has("run") && !runID.MatchString(run) {
			respond(w, 0, nil, validation())
			return
		}
		sprite, e := s.Sprite(r.Context(), r.PathValue("dataset_id"), index, run)
		if e != nil {
			respond(w, 0, nil, e)
			return
		}
		defer sprite.File.Close()
		w.Header().Set("Content-Type", sprite.MediaType)
		w.Header().Set("ETag", sprite.ETag)
		cache := "private, no-cache"
		if sprite.Immutable {
			cache = "private, max-age=31536000, immutable"
		}
		w.Header().Set("Cache-Control", cache)
		if ETagMatches(r.Header.Get("If-None-Match"), sprite.ETag) {
			w.WriteHeader(304)
			return
		}
		st, e := sprite.File.Stat()
		if e != nil {
			respond(w, 0, nil, e)
			return
		}
		http.ServeContent(w, r, st.Name(), st.ModTime(), sprite.File)
	})
}
func validation() error { return failure(422, "validation_error", "请求参数校验失败") }
func decode(w http.ResponseWriter, r *http.Request, v any, optional bool) error {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	var raw json.RawMessage
	if e := d.Decode(&raw); e != nil {
		if optional && e == io.EOF {
			return nil
		}
		return validation()
	}
	var trailing any
	if d.Decode(&trailing) != io.EOF {
		return validation()
	}
	if optional && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return validation()
	}
	if force, exists := fields["force"]; exists && bytes.Equal(bytes.TrimSpace(force), []byte("null")) {
		return validation()
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
	if w.Header().Get("Cache-Control") == "" {
		w.Header().Set("Cache-Control", "no-store")
	}
	if e != nil {
		api := &Error{500, "atlas_internal", "语义地图操作失败"}
		var specific *Error
		var dataset *datasets.Error
		if errors.As(e, &specific) {
			api = specific
		} else if errors.As(e, &dataset) {
			api = &Error{dataset.Status, dataset.Code, dataset.Message}
		}
		status = api.Status
		v = Record{"error": Record{"code": api.Code, "message": api.Message, "details": nil, "request_id": w.Header().Get("X-Request-ID")}}
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
