package collect

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
	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/httpapi"
	"ldos/backend/internal/redaction"
	"ldos/backend/internal/search"
)

func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/collect/preview-capacity/{site}", func(w http.ResponseWriter, r *http.Request) {
		limit, err := s.previewCapacity(r.Context(), r.PathValue("site"))
		if err != nil {
			writeError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		httpapi.JSON(w, http.StatusOK, map[string]int{"limit": limit})
	})
	mux.HandleFunc("POST /api/v1/datasets/{dataset_id}/collect/resolve", func(w http.ResponseWriter, r *http.Request) {
		var body ResolveRequest
		if err := decodeBody(w, r, &body, 64<<10); err != nil {
			writeError(w, err)
			return
		}
		res, err := s.Resolve(r.Context(), r.PathValue("dataset_id"), body)
		if err != nil {
			writeError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		httpapi.JSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("POST /api/v1/datasets/{dataset_id}/collect/browse", func(w http.ResponseWriter, r *http.Request) {
		var body BrowseRequest
		if err := decodeBody(w, r, &body, 64<<10); err != nil {
			writeError(w, err)
			return
		}
		res, err := s.Browse(r.Context(), r.PathValue("dataset_id"), body)
		if err != nil {
			writeError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		httpapi.JSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("POST /api/v1/datasets/{dataset_id}/collect/submit", func(w http.ResponseWriter, r *http.Request) {
		var body SubmitRequest
		if err := decodeBody(w, r, &body, 2<<20); err != nil {
			writeError(w, err)
			return
		}
		res, err := s.Submit(r.Context(), r.PathValue("dataset_id"), body, r.Header.Get("Idempotency-Key"))
		if err != nil {
			writeError(w, err)
			return
		}
		httpapi.JSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("GET /api/v1/collect/media/{token}", func(w http.ResponseWriter, r *http.Request) {
		data, mime, err := s.Media(r.Context(), r.PathValue("token"))
		if err != nil {
			writeError(w, err)
			return
		}
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "private, max-age=300")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	})
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any, limit int64) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil || decoder.Decode(new(any)) != io.EOF {
		return problem(422, "validation_error", "请求必须是有效 JSON，且只能包含支持的字段")
	}
	return nil
}

func writeError(w http.ResponseWriter, err error) {
	status, code, message, details := 500, "internal_error", "服务内部错误", any(nil)
	var own *Error
	var remote *discovery.Error
	var remoteData *discoverydata.Error
	var searchErr *search.Error
	var dataset *datasets.Error
	var crawl *crawls.Error
	switch {
	case errors.Is(err, context.Canceled):
		status, code, message = 499, "request_cancelled", "请求已取消"
	case errors.Is(err, context.DeadlineExceeded):
		status, code, message = 504, "request_timeout", "请求超时，请重试"
	case errors.As(err, &own):
		status, code, message, details = own.Status, own.Code, own.Message, own.Details
	case errors.As(err, &dataset) && dataset.Status >= 400 && dataset.Status < 600:
		status, code, message, details = dataset.Status, dataset.Code, dataset.Message, dataset.Details
	case errors.As(err, &crawl) && crawl.Status >= 400 && crawl.Status < 600:
		status, code, message, details = crawl.Status, crawl.Code, crawl.Message, crawl.Details
	case errors.As(err, &searchErr) && searchErr.Status >= 400 && searchErr.Status < 600:
		status, code, message = searchErr.Status, searchErr.Code, searchErr.Message
	case errors.As(err, &remote):
		status, code, message, details = 502, remote.Code, remote.Message, remote.Details
		if strings.HasPrefix(remote.Code, "invalid_") {
			status = 422
		} else if remote.Code == "authentication" || remote.Code == "danbooru_auth_required" {
			status = 401
		}
		if info, ok := remote.Details.(map[string]any); ok {
			if upstream, ok := info["status_code"].(int); ok && (upstream == 401 || upstream == 403 || upstream == 404 || upstream == 422 || upstream == 429) {
				status = upstream
			}
		}
	case errors.As(err, &remoteData):
		status, code, message = 502, remoteData.Code, remoteData.Message
		if strings.HasPrefix(code, "invalid_") {
			status = 422
		}
	}
	httpapi.Error(w, status, code, redaction.Text(message, 500), details)
}
