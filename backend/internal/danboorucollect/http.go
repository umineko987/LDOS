package danboorucollect

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"ldos/backend/internal/crawls"
	"ldos/backend/internal/datasets"
	"ldos/backend/internal/discovery"
)

func (s *Service) Handler() http.Handler { return http.HandlerFunc(s.serveHTTP) }

func (s *Service) serveHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSuffix(r.URL.Path, "/")
	switch {
	case path == "/api/v1/danbooru/browse" && r.Method == http.MethodPost:
		var body BrowseRequest
		if err := decodeBody(w, r, &body); err != nil {
			writeError(w, err)
			return
		}
		page, err := s.Browse(r.Context(), body)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, page)
	case strings.HasPrefix(path, "/api/v1/danbooru/media/") && r.Method == http.MethodGet:
		token := strings.TrimPrefix(path, "/api/v1/danbooru/media/")
		data, mime, err := s.Media(r.Context(), token, r.URL.Query().Get("size"))
		if err != nil {
			writeError(w, err)
			return
		}
		w.Header().Set("Content-Type", mime)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "private, max-age=300")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	case strings.HasPrefix(path, "/api/v1/datasets/") && strings.HasSuffix(path, "/danbooru/collect") && r.Method == http.MethodPost:
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/api/v1/datasets/"), "/danbooru/collect")
		if id == "" || strings.Contains(id, "/") {
			writeError(w, problem(404, "not_found", "接口不存在"))
			return
		}
		var body struct {
			Tokens []string `json:"tokens"`
		}
		if err := decodeBody(w, r, &body); err != nil {
			writeError(w, err)
			return
		}
		result, err := s.Collect(r.Context(), id, body.Tokens, strings.TrimSpace(r.Header.Get("Idempotency-Key")))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	default:
		writeError(w, problem(404, "not_found", "接口不存在"))
	}
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return problem(422, "validation_error", "请求必须是有效 JSON，且只能包含支持的字段")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return problem(422, "validation_error", "请求包含多余 JSON")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, err error) {
	status, code, message, details := 500, "internal_error", "服务内部错误", any(nil)
	var own *Error
	var remote *discovery.Error
	var dataset *datasets.Error
	var crawl *crawls.Error
	switch {
	case errors.As(err, &own):
		status, code, message = own.Status, own.Code, own.Message
	case errors.As(err, &remote):
		status, code, message, details = 502, remote.Code, remote.Message, remote.Details
		if strings.HasPrefix(remote.Code, "invalid_") {
			status = 422
		}
		if info, ok := remote.Details.(map[string]any); ok {
			if upstream, ok := info["status_code"].(int); ok && (upstream == 401 || upstream == 403 || upstream == 404 || upstream == 422 || upstream == 429) {
				status = upstream
			}
		}
	case errors.As(err, &dataset):
		status, code, message, details = dataset.Status, dataset.Code, dataset.Message, dataset.Details
	case errors.As(err, &crawl):
		status, code, message, details = crawl.Status, crawl.Code, crawl.Message, crawl.Details
	case errors.Is(err, context.Canceled):
		status, code, message = 499, "request_cancelled", "请求已取消"
	case errors.Is(err, context.DeadlineExceeded):
		status, code, message = 504, "request_timeout", "请求超时，请重试"
	}
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message, "details": details, "request_id": w.Header().Get("X-Request-ID")}})
}
