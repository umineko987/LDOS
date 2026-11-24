package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"ldos/backend/internal/crawls"
	"ldos/backend/internal/datasets"
	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/httpapi"
	"ldos/backend/internal/redaction"
)

const route = "/api/v1/datasets/{dataset_id}/workbench"

func previewPath(dataset, snapshot, item string) string {
	return "/api/v1/datasets/" + url.PathEscape(dataset) + "/workbench/media/" + snapshot + "/" + item
}

func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST "+route+"/browse", func(w http.ResponseWriter, r *http.Request) {
		var request BrowseRequest
		if err := decodeBody(w, r, &request); err != nil {
			writeError(w, err)
			return
		}
		result, err := s.Browse(r.Context(), r.PathValue("dataset_id"), request)
		if err != nil {
			writeError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		httpapi.JSON(w, http.StatusOK, result)
	})
	mux.HandleFunc("POST "+route+"/collect", func(w http.ResponseWriter, r *http.Request) {
		var request CollectRequest
		if err := decodeBody(w, r, &request); err != nil {
			writeError(w, err)
			return
		}
		batch, err := s.Collect(r.Context(), r.PathValue("dataset_id"), request, r.Header.Get("Idempotency-Key"))
		if err != nil {
			writeError(w, err)
			return
		}
		httpapi.JSON(w, http.StatusOK, map[string]string{"batch_id": batch})
	})
	mux.HandleFunc("GET "+route+"/media/{snapshot_id}/{item_id}", func(w http.ResponseWriter, r *http.Request) {
		data, mime, err := s.preview(r.Context(), r.PathValue("dataset_id"), r.PathValue("snapshot_id"), r.PathValue("item_id"))
		if err != nil {
			writeError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Type", mime)
		_, _ = w.Write(data)
	})
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil || decoder.Decode(new(any)) != io.EOF {
		return problem(422, "validation_error", "请求必须是有效 JSON，且只能包含支持的字段")
	}
	return nil
}

type requestError struct {
	status  int
	code    string
	message string
}

func (e *requestError) Error() string { return e.message }

func problem(status int, code, message string) error {
	return &requestError{status: status, code: code, message: message}
}

func writeError(w http.ResponseWriter, err error) {
	status, code, message := 500, "internal_error", "服务内部错误"
	var own *requestError
	var remote *discoverydata.Error
	var dataset *datasets.Error
	var crawl *crawls.Error
	switch {
	case errors.Is(err, context.Canceled):
		status, code, message = 499, "request_cancelled", "请求已取消"
	case errors.Is(err, context.DeadlineExceeded):
		status, code, message = 504, "request_timeout", "请求超时，请重试"
	case errors.As(err, &own):
		status, code, message = own.status, own.code, own.message
	case errors.As(err, &dataset) && dataset.Status >= 400 && dataset.Status < 600:
		status, code, message = dataset.Status, dataset.Code, dataset.Message
	case errors.As(err, &crawl) && crawl.Status >= 400 && crawl.Status < 600:
		status, code, message = crawl.Status, crawl.Code, crawl.Message
	case errors.As(err, &remote):
		status, code, message = 502, remote.Code, "无法加载站点预览"
		if strings.HasPrefix(code, "invalid_") {
			status, message = 422, remote.Message
		}
	}
	httpapi.Error(w, status, code, redaction.Text(message, 500), nil)
}
