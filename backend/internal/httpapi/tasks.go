package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"ldos/backend/internal/scheduler"
	"ldos/backend/internal/store"
	"ldos/backend/internal/tasks"
)

type Option func(*http.ServeMux)

// WithTasks installs the native task service and scheduler controls.
func WithTasks(service *tasks.Service) Option {
	return func(mux *http.ServeMux) {
		mux.HandleFunc("POST /api/v1/tasks", func(w http.ResponseWriter, r *http.Request) {
			data, ok := taskBody(w, r)
			if !ok {
				return
			}
			body, err := tasks.DecodeCreate(data)
			if err != nil {
				Error(w, 422, "validation_error", "请求参数校验失败", nil)
				return
			}
			var key *string
			if values, present := r.Header["Idempotency-Key"]; present && len(values) > 0 {
				key = &values[0]
			}
			row, created, err := service.Enqueue(r.Context(), body, key)
			if taskMutationError(w, err) {
				return
			}
			status := http.StatusOK
			if created {
				status = http.StatusAccepted
			}
			JSON(w, status, row)
		})
		mux.HandleFunc("POST /api/v1/tasks/{task_id}/cancel", func(w http.ResponseWriter, r *http.Request) {
			row, err := service.Cancel(r.Context(), r.PathValue("task_id"))
			if taskMutationError(w, err) {
				return
			}
			if row == nil {
				Error(w, 404, "task_not_found", "任务不存在", nil)
				return
			}
			JSON(w, http.StatusOK, row)
		})
		mux.HandleFunc("POST /api/v1/tasks/{task_id}/retry", func(w http.ResponseWriter, r *http.Request) {
			data, ok := taskBody(w, r)
			if !ok {
				return
			}
			var fields map[string]json.RawMessage
			if !utf8.Valid(data) || json.Unmarshal(data, &fields) != nil || fields == nil {
				Error(w, 422, "validation_error", "请求参数校验失败", nil)
				return
			}
			attempts := 1
			if raw, present := fields["additional_attempts"]; present {
				if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &attempts) != nil {
					Error(w, 422, "validation_error", "请求参数校验失败", nil)
					return
				}
			}
			row, err := service.Retry(r.Context(), r.PathValue("task_id"), attempts)
			if taskMutationError(w, err) {
				return
			}
			if row == nil {
				Error(w, 404, "task_not_found", "任务不存在", nil)
				return
			}
			JSON(w, http.StatusAccepted, row)
		})
	}
}

func taskBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			Error(w, 413, "request_too_large", "请求体过大", nil)
		} else {
			Error(w, 400, "invalid_request", "无法读取请求体", nil)
		}
		return nil, false
	}
	return data, true
}

func taskMutationError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	var taskError *tasks.Error
	switch {
	case errors.As(err, &taskError):
		Error(w, taskError.Status, taskError.Code, taskError.Message, nil)
	case errors.Is(err, scheduler.ErrCrawlOwned):
		batch := strings.TrimPrefix(err.Error(), scheduler.ErrCrawlOwned.Error()+": ")
		Error(w, 409, "task_belongs_to_crawl", "该任务属于爬取批次，请通过 /crawls/"+batch+"/retry 重试以保持批次统计一致", nil)
	case errors.Is(err, store.ErrInvalidState):
		Error(w, 409, "task_state_conflict", "仅终态任务可重试", nil)
	default:
		Error(w, 503, "task_service_unavailable", "任务服务暂时不可用", nil)
	}
	return true
}
