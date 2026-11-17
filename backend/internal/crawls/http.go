package crawls

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/redaction"
	"ldos/backend/internal/tasks"
)

func selectFields(row map[string]any, keys ...string) map[string]any {
	out := map[string]any{}
	for _, key := range keys {
		out[key] = row[key]
	}
	return out
}
func cut(v any, limit int) string {
	r := []rune(str(v))
	if len(r) > limit {
		r = r[:limit]
	}
	return string(r)
}
func truncateFields(row map[string]any, limits map[string]int) {
	for key, limit := range limits {
		if row[key] != nil {
			row[key] = cut(row[key], limit)
		}
	}
}
func visible(batch map[string]any) bool {
	if !terminal(str(batch["status"])) {
		return true
	}
	info, e := os.Stat(str(batch["output_dir"]))
	return e == nil && info.IsDir()
}
func DesktopOperation(batch map[string]any) map[string]any {
	result := map[string]any{"response_profile": "desktop-crawl-operation-v1"}
	if batch != nil {
		result["id"] = cut(batch["id"], 200)
		result["status"] = cut(batch["status"], 32)
		result["cancel_requested"] = batch["cancel_requested"]
	}
	return result
}
func Desktop(batch map[string]any) map[string]any {
	result := selectFields(batch, "id", "status", "created_at", "updated_at", "finished_at", "cancel_requested", "concurrency", "max_tasks", "task_count", "succeeded_task_count", "failed_task_count", "cancelled_task_count", "pre_dedup_skipped_count", "resumable")
	truncateFields(result, map[string]int{"id": 200, "status": 32})
	result["current"] = nil
	if current, ok := batch["current"].(map[string]any); ok {
		r := selectFields(current, "address_id", "site", "source_order", "address_order", "status")
		truncateFields(r, map[string]int{"address_id": 200, "site": 128, "status": 32})
		result["current"] = r
	}
	sources := rowsOf(batch["sources"])
	truncated := len(sources) > 20
	remaining := 2000
	out := []map[string]any{}
	for _, source := range sources[:min(20, len(sources))] {
		addresses := rowsOf(source["addresses"])
		limit := min(500, remaining)
		if len(addresses) > limit {
			truncated = true
		}
		rows := []map[string]any{}
		for _, a := range addresses[:min(limit, len(addresses))] {
			r := selectFields(a, "id", "address_order", "label", "address_type", "status", "planned_task_count", "succeeded_task_count", "failed_task_count", "cancelled_task_count", "pre_dedup_skipped_count", "probed_proxy_count", "healthy_proxy_count")
			truncateFields(r, map[string]int{"id": 200, "label": 200, "address_type": 100, "status": 32})
			message := str(a["planning_error"])
			if message == "" {
				message = str(a["last_error"])
			}
			r["planning_error"] = redaction.Text(message, 500)
			rows = append(rows, r)
		}
		remaining -= len(rows)
		out = append(out, map[string]any{"order": source["order"], "site": cut(source["site"], 128), "status": cut(source["status"], 32), "pre_dedup_skipped_count": source["pre_dedup_skipped_count"], "addresses": rows})
	}
	result["sources"] = out
	result["address_rows_limit"] = 2000
	result["address_rows_truncated"] = truncated
	result["review"] = nil
	if review, ok := batch["review"].(map[string]any); ok {
		result["review"] = selectFields(review, "status", "total_image_count", "duplicate_group_count", "decided_group_count", "total_group_count")
	}
	result["response_profile"] = "desktop-crawl-v1"
	return result
}
func TaskView(row map[string]any) map[string]any {
	out := selectFields(row, "id", "site", "status", "source_order", "address_order", "sequence_no", "attempt_count", "max_attempts", "crawl_address_id", "artifact_count", "artifact_bytes")
	out["last_error_class"] = cut(row["last_error_class"], 80)
	return out
}
func (s *Service) desktopList(ctx context.Context, limit, offset int) ([]map[string]any, error) {
	items := []map[string]any{}
	cursor, skip, pageSize := 0, offset, min(500, max(30, limit+offset))
	for len(items) < limit {
		page, err := s.List(ctx, pageSize, cursor)
		if err != nil {
			return nil, err
		}
		if len(page) == 0 {
			break
		}
		cursor += len(page)
		for _, batch := range page {
			if !visible(batch) {
				continue
			}
			if skip > 0 {
				skip--
				continue
			}
			counts, err := s.deps.Store.QueryRow(ctx, `SELECT COUNT(*) AS task_count,COALESCE(SUM(t.status='succeeded'),0) AS succeeded_task_count,COALESCE(SUM(t.status='failed'),0) AS failed_task_count FROM crawl_address_tasks cat JOIN crawl_addresses ca ON ca.id=cat.address_id JOIN tasks t ON t.id=cat.task_id WHERE ca.batch_id=?`, batch["id"])
			if err != nil {
				return nil, err
			}
			counts["id"] = cut(batch["id"], 200)
			counts["status"] = cut(batch["status"], 32)
			counts["created_at"] = batch["created_at"]
			items = append(items, counts)
			if len(items) == limit {
				break
			}
		}
		if len(page) < pageSize {
			break
		}
	}
	return items, nil
}
func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func failure(w http.ResponseWriter, err error) {
	public := &Error{Status: 500, Code: "internal_error", Message: "爬取请求失败"}
	var e *Error
	var task *tasks.Error
	var upstream *discovery.Error
	switch {
	case errors.As(err, &e):
		public = e
	case errors.As(err, &task):
		public = &Error{Status: task.Status, Code: task.Code, Message: task.Message}
	case errors.As(err, &upstream):
		public = &Error{Status: 502, Code: upstream.Code, Message: upstream.Message, Details: upstream.Details}
	}
	status := public.Status
	if status == 0 {
		status = 502
	}
	reply(w, status, map[string]any{"error": map[string]any{"code": public.Code, "message": public.Message, "details": public.Details, "request_id": w.Header().Get("X-Request-ID")}})
}
func validation(message string) error {
	return &Error{Status: 422, Code: "validation_error", Message: message}
}
func pagination(r *http.Request, defaultLimit, maxLimit int) (int, int, error) {
	limit, offset := defaultLimit, 0
	for key, dest := range map[string]*int{"limit": &limit, "offset": &offset} {
		if r.URL.Query().Has(key) {
			n, err := strconv.Atoi(r.URL.Query().Get(key))
			if err != nil {
				return 0, 0, validation(key + " 必须是整数")
			}
			*dest = n
		}
	}
	if limit < 1 || limit > maxLimit || offset < 0 {
		return 0, 0, validation("分页参数超出范围")
	}
	return limit, offset, nil
}
func readBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, &Error{Status: 413, Code: "request_too_large", Message: "请求体过大"}
		}
		return nil, validation("无法读取请求体")
	}
	return data, nil
}
func decodeRetry(data []byte, rerun bool) (int, bool, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil || raw == nil {
		return 0, false, validation("请求必须是 JSON 对象")
	}
	attempts := 1
	success := false
	for key, value := range raw {
		switch key {
		case "additional_attempts":
			if string(value) == "null" || json.Unmarshal(value, &attempts) != nil {
				return 0, false, validation("additional_attempts 必须是整数")
			}
		case "requeue_succeeded":
			if !rerun {
				continue
			}
			if string(value) == "null" || json.Unmarshal(value, &success) != nil {
				return 0, false, validation("requeue_succeeded 必须是布尔值")
			}
		default:
			if rerun {
				return 0, false, validation("未知字段: " + key)
			}
		}
	}
	if attempts < 1 || attempts > 20 {
		return 0, false, validation("additional_attempts 必须介于 1 和 20")
	}
	return attempts, success, nil
}

// Register owns precisely the seven legacy crawl endpoints. Pause/Resume are
// exported integration methods; they do not invent new public route contracts.
func (s *Service) Register(mux *http.ServeMux) {
	mux.Handle("/api/v1/crawls", s)
	mux.Handle("/api/v1/crawls/", s)
}
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/crawls")
	if path == r.URL.Path {
		failure(w, &Error{Status: 404, Code: "not_found", Message: "接口不存在"})
		return
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	id, action := "", ""
	if path != "" {
		id = parts[0]
		if len(parts) > 1 {
			action = parts[1]
		}
		if id == "" || len(parts) > 2 || action != "" && action != "tasks" && action != "cancel" && action != "retry" && action != "rerun" {
			failure(w, &Error{Status: 404, Code: "not_found", Message: "接口不存在"})
			return
		}
	}
	allow := "GET"
	if id == "" {
		allow = "GET, POST"
	} else if action != "" && action != "tasks" {
		allow = "POST"
	}
	if r.Method != "GET" && r.Method != "POST" || r.Method == "GET" && allow == "POST" || r.Method == "POST" && allow == "GET" {
		w.Header().Set("Allow", allow)
		failure(w, &Error{Status: 405, Code: "method_not_allowed", Message: "请求方法不支持"})
		return
	}
	view := "legacy"
	if r.URL.Query().Has("view") {
		view = r.URL.Query().Get("view")
	}
	alternative := "desktop"
	if action == "tasks" {
		alternative = "tasks"
	}
	if view != "legacy" && view != alternative {
		failure(w, validation("view 必须是 legacy 或 "+alternative))
		return
	}
	ctx := r.Context()
	if id == "" && r.Method == "POST" {
		data, err := readBody(w, r)
		if err != nil {
			failure(w, err)
			return
		}
		body, err := DecodeRequest(data)
		if err != nil {
			failure(w, err)
			return
		}
		var key *string
		if values, ok := r.Header["Idempotency-Key"]; ok && len(values) > 0 {
			key = &values[0]
		}
		result, created, err := s.Create(ctx, body, key)
		if err != nil {
			failure(w, err)
			return
		}
		if view == "desktop" {
			result = DesktopOperation(result)
		}
		status := 200
		if created {
			status = 202
		}
		reply(w, status, result)
		return
	}
	if id == "" {
		limit, offset, err := pagination(r, 50, 500)
		if err != nil {
			failure(w, err)
			return
		}
		var items []map[string]any
		if view == "desktop" {
			items, err = s.desktopList(ctx, limit, offset)
		} else {
			items, err = s.List(ctx, limit, offset)
		}
		if err != nil {
			failure(w, err)
			return
		}
		reply(w, 200, map[string]any{"items": items, "limit": limit, "offset": offset})
		return
	}
	if action == "tasks" {
		limit, offset, err := pagination(r, 100, 1000)
		if err != nil {
			failure(w, err)
			return
		}
		b, err := s.tickView(ctx, id)
		if err != nil {
			failure(w, err)
			return
		}
		if b == nil {
			failure(w, missing())
			return
		}
		items, err := s.ListTasks(ctx, id, r.URL.Query().Get("address_id"), limit, offset)
		if err != nil {
			failure(w, err)
			return
		}
		if view == "tasks" {
			for i, row := range items {
				items[i] = TaskView(row)
			}
		}
		reply(w, 200, map[string]any{"items": items, "limit": limit, "offset": offset})
		return
	}
	var result map[string]any
	var err error
	status := 200
	switch action {
	case "":
		result, err = s.Get(ctx, id)
		if err == nil && (result == nil || view == "desktop" && !visible(result)) {
			err = missing()
		}
		if err == nil {
			if terminal(str(result["status"])) && result["review"] == nil {
				reviewStatus := "disabled"
				if s.deps.ReviewEnabled || s.deps.Settings.Dedup.Enabled {
					reviewStatus = "not_started"
				}
				result["review"] = map[string]any{"batch_id": id, "status": reviewStatus}
			}
			if view == "desktop" {
				result = Desktop(result)
			}
		}
	case "cancel":
		result, err = s.Cancel(ctx, id)
		if err == nil && view == "desktop" {
			result = DesktopOperation(result)
		}
	case "retry", "rerun":
		data, e := readBody(w, r)
		if e != nil {
			failure(w, e)
			return
		}
		attempts, success, e := decodeRetry(data, action == "rerun")
		if e != nil {
			failure(w, e)
			return
		}
		if action == "retry" {
			result, err = s.Retry(ctx, id, attempts)
		} else {
			result, err = s.Rerun(ctx, id, attempts, success)
		}
		status = 202
		if err == nil && view == "desktop" {
			result = DesktopOperation(result["batch"].(map[string]any))
		}
	}
	if err != nil {
		failure(w, err)
		return
	}
	reply(w, status, result)
}
