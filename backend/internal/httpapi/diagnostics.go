package httpapi

import (
	"context"
	"net/http"

	"ldos/backend/internal/config"
	"ldos/backend/internal/diagnostics"
)

type RuntimeDiagnostics struct {
	Ready    func(context.Context) map[string]any
	Settings func() config.Settings
	Tasks    func() map[string]any
	Crawls   func() map[string]any
}

func diagnosticsView(w http.ResponseWriter, r *http.Request) (string, bool) {
	view := last(r.URL.Query(), "view")
	if !r.URL.Query().Has("view") {
		view = "legacy"
	}
	if view != "legacy" && view != "diagnostics" {
		JSON(w, 422, map[string]any{"detail": []map[string]any{{"type": "literal_error", "loc": []string{"query", "view"}, "msg": "Input should be 'legacy' or 'diagnostics'", "input": view}}})
		return "", false
	}
	return view, true
}
func WithDiagnostics(runtime RuntimeDiagnostics) Option {
	return func(mux *http.ServeMux) {
		mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
			payload := runtime.Ready(r.Context())
			status := http.StatusOK
			if payload["ready"] != true {
				status = http.StatusServiceUnavailable
			}
			JSON(w, status, payload)
		})
		mux.HandleFunc("GET /api/v1/config", func(w http.ResponseWriter, r *http.Request) {
			view, ok := diagnosticsView(w, r)
			if !ok {
				return
			}
			JSON(w, 200, diagnostics.Config(runtime.Settings(), view))
		})
		mux.HandleFunc("GET /api/v1/scheduler/status", func(w http.ResponseWriter, r *http.Request) {
			view, ok := diagnosticsView(w, r)
			if !ok {
				return
			}
			tasks, crawls := runtime.Tasks(), runtime.Crawls()
			if view == "diagnostics" {
				JSON(w, 200, diagnostics.Scheduler(tasks, crawls))
			} else {
				JSON(w, 200, map[string]any{"tasks": tasks, "ordered_crawls": crawls})
			}
		})
	}
}
