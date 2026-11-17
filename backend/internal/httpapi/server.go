package httpapi

import (
	"context"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ldos/backend/internal/config"
)

type TaskStore interface {
	Ping(context.Context) error
	ListTasks(context.Context, string, string, int, int) ([]map[string]any, error)
	GetTask(context.Context, string) (map[string]any, error)
	GetLogs(context.Context, string, int64, *int, int) ([]map[string]any, error)
	GetEvents(context.Context, string, int64, int) ([]map[string]any, error)
}

// New composes native business services behind the existing local-origin guard.
func New(settings config.Settings, db TaskStore, jobs, events, downloads, policies http.Handler, options ...Option) http.Handler {
	mux := http.NewServeMux()
	for _, option := range options {
		option(mux)
	}
	mountDocs(mux)
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		JSON(w, 200, map[string]any{"service": "gallery-dl-backend", "version": "0.1.0", "docs": "/docs"})
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		status, databaseStatus := http.StatusOK, "ok"
		if db.Ping(r.Context()) != nil {
			status, databaseStatus = http.StatusServiceUnavailable, "error"
		}
		JSON(w, status, map[string]any{"ok": status == 200, "components": map[string]any{"process": map[string]string{"status": "ok"}, "database": map[string]string{"status": databaseStatus}}, "time": float64(time.Now().UnixMilli()) / 1000})
	})
	if _, pattern := mux.Handler(&http.Request{Method: "GET", URL: &url.URL{Path: "/readyz"}}); pattern == "" {
		mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
			JSON(w, http.StatusServiceUnavailable, map[string]any{"ready": false, "reason": "services_not_configured"})
		})
	}
	mux.Handle("GET /api/v1/jobs", jobs)
	mux.Handle("GET /api/v1/events", events)
	mux.Handle("GET /api/v1/settings/downloads", downloads)
	mux.Handle("PUT /api/v1/settings/downloads", downloads)
	mux.Handle("/api/v1/sites/policies", policies)
	mux.Handle("/api/v1/sites/policies/{site}", policies)
	mux.HandleFunc("GET /api/v1/tasks", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		limit, ok := queryInt(w, q, "limit", 50, 1, 500)
		if !ok {
			return
		}
		offset, ok := queryInt(w, q, "offset", 0, 0, 0)
		if !ok {
			return
		}
		items, err := db.ListTasks(r.Context(), last(q, "status"), last(q, "site"), limit, offset)
		if storeError(w, err) {
			return
		}
		JSON(w, 200, map[string]any{"items": items, "limit": limit, "offset": offset})
	})
	mux.HandleFunc("GET /api/v1/tasks/{task_id}", func(w http.ResponseWriter, r *http.Request) {
		if task := getTask(w, r, db); task != nil {
			JSON(w, 200, task)
		}
	})
	mux.HandleFunc("GET /api/v1/tasks/{task_id}/logs", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		since, ok := queryInt(w, q, "since", 0, 0, 0)
		if !ok {
			return
		}
		limit, ok := queryInt(w, q, "limit", 1000, 1, 5000)
		if !ok {
			return
		}
		var tail *int
		if q.Has("tail") {
			n, ok := queryInt(w, q, "tail", 0, 1, 5000)
			if !ok {
				return
			}
			tail = &n
		}
		if getTask(w, r, db) == nil {
			return
		}
		items, err := db.GetLogs(r.Context(), r.PathValue("task_id"), int64(since), tail, limit)
		if !storeError(w, err) {
			JSON(w, 200, map[string]any{"items": items})
		}
	})
	mux.HandleFunc("GET /api/v1/tasks/{task_id}/events", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		since, ok := queryInt(w, q, "since", 0, 0, 0)
		if !ok {
			return
		}
		limit, ok := queryInt(w, q, "limit", 1000, 1, 5000)
		if !ok {
			return
		}
		if getTask(w, r, db) == nil {
			return
		}
		items, err := db.GetEvents(r.Context(), r.PathValue("task_id"), int64(since), limit)
		if !storeError(w, err) {
			JSON(w, 200, map[string]any{"items": items})
		}
	})
	mux.HandleFunc("GET /api/v1/tasks/{task_id}/files", func(w http.ResponseWriter, r *http.Request) {
		task := getTask(w, r, db)
		if task == nil {
			return
		}
		root, _ := task["output_dir"].(string)
		JSON(w, 200, map[string]any{"items": taskFiles(root)})
	})
	mux.HandleFunc("GET /api/v1/tasks/{task_id}/files/{relative_path...}", func(w http.ResponseWriter, r *http.Request) {
		task := getTask(w, r, db)
		if task == nil {
			return
		}
		rootPath, _ := task["output_dir"].(string)
		relative := r.PathValue("relative_path")
		root, err := os.OpenRoot(rootPath)
		if err != nil {
			fileNotFound(w)
			return
		}
		defer root.Close()
		if !fs.ValidPath(relative) {
			fileNotFound(w)
			return
		}
		parts := strings.Split(relative, "/")
		for i := range parts {
			info, err := root.Lstat(strings.Join(parts[:i+1], "/"))
			if err != nil || info.Mode()&os.ModeSymlink != 0 {
				fileNotFound(w)
				return
			}
		}
		file, err := root.Open(relative)
		if err != nil {
			fileNotFound(w)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			fileNotFound(w)
			return
		}
		contentType := mime.TypeByExtension(filepath.Ext(relative))
		if contentType == "" {
			var buf [512]byte
			n, _ := file.ReadAt(buf[:], 0)
			contentType = http.DetectContentType(buf[:n])
		}
		w.Header().Set("Content-Type", contentType)
		if strings.HasPrefix(contentType, "image/") || strings.HasPrefix(contentType, "audio/") || strings.HasPrefix(contentType, "video/") {
			w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
		}
		http.ServeContent(w, r, info.Name(), info.ModTime(), file)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		Error(w, http.StatusNotFound, "route_not_found", "接口不存在", nil)
	})
	return Guard(settings.Server, mux)
}

func getTask(w http.ResponseWriter, r *http.Request, db TaskStore) map[string]any {
	task, err := db.GetTask(r.Context(), r.PathValue("task_id"))
	if storeError(w, err) {
		return nil
	}
	if task == nil {
		Error(w, 404, "task_not_found", "任务不存在", nil)
	}
	return task
}

func storeError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	Error(w, 503, "database_unavailable", "数据库暂时不可用", nil)
	return true
}

func fileNotFound(w http.ResponseWriter) {
	Error(w, 404, "file_not_found", "任务文件不存在", nil)
}

func last(q url.Values, key string) string {
	values := q[key]
	if len(values) == 0 {
		return ""
	}
	return values[len(values)-1]
}

func queryInt(w http.ResponseWriter, q url.Values, key string, fallback, min, max int) (int, bool) {
	if !q.Has(key) {
		return fallback, true
	}
	raw := last(q, key)
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	kind, message := "", ""
	var ctx any
	if err != nil {
		kind, message = "int_parsing", "Input should be a valid integer, unable to parse string as an integer"
	} else if value < min {
		kind, message = "greater_than_equal", "Input should be greater than or equal to "+strconv.Itoa(min)
		ctx = map[string]int{"ge": min}
	} else if max != 0 && value > max {
		kind, message = "less_than_equal", "Input should be less than or equal to "+strconv.Itoa(max)
		ctx = map[string]int{"le": max}
	}
	if kind == "" {
		return value, true
	}
	detail := map[string]any{"type": kind, "loc": []string{"query", key}, "msg": message, "input": raw}
	if ctx != nil {
		detail["ctx"] = ctx
	}
	Error(w, 422, "validation_error", "请求参数校验失败", []any{detail})
	return 0, false
}

func taskFiles(root string) []map[string]any {
	files := []map[string]any{}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return files
	}
	_ = filepath.WalkDir(resolved, func(path string, entry fs.DirEntry, err error) error {
		if len(files) >= 2000 {
			return fs.SkipAll
		}
		if err != nil || entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		relative, err := filepath.Rel(resolved, path)
		if err == nil {
			files = append(files, map[string]any{"path": filepath.ToSlash(relative), "size": info.Size(), "modified_at": float64(info.ModTime().UnixNano()) / 1e9})
		}
		return nil
	})
	return files
}
