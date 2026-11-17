// Package proxyapi implements the proxy HTTP contract independently of server wiring.
package proxyapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/proxysources"
	"ldos/backend/internal/redaction"
)

type Backend interface {
	Start(context.Context, string) (map[string]any, error)
	Reload(context.Context, string) (map[string]any, error)
	Stop(context.Context, bool) (map[string]any, error)
	Probe(context.Context, string, string) (proxypool.ProbeResult, error)
	Status() map[string]any
	ActiveRevision() *string
	HealthSummary() map[string]any
}

type handler struct {
	pool           Backend
	sources        *proxysources.Store
	validateTarget func(context.Context, string) error
	siteProbe      func(context.Context, string) (string, error)
}

func New(pool Backend, sources *proxysources.Store, validateTarget func(context.Context, string) error, siteProbe func(context.Context, string) (string, error)) http.Handler {
	return &handler{pool, sources, validateTarget, siteProbe}
}

func writeJSON(w http.ResponseWriter, value any) { _ = json.NewEncoder(w).Encode(value) }
func writeError(w http.ResponseWriter, status int, code, message string, details any) {
	w.WriteHeader(status)
	writeJSON(w, map[string]any{"error": map[string]any{"code": code, "message": message, "details": details, "request_id": w.Header().Get("X-Request-ID")}})
}
func poolError(w http.ResponseWriter, err error) {
	if errors.Is(err, proxypool.ErrConflict) {
		writeError(w, 409, "proxy_conflict", err.Error(), nil)
		return
	}
	writeError(w, 503, "proxy_error", redaction.Text(err.Error(), 500), nil)
}
func sourceError(w http.ResponseWriter, err error) {
	var source *proxysources.Error
	if !errors.As(err, &source) {
		writeError(w, 503, "proxy_sources_store_error", redaction.Text(err.Error(), 500), nil)
		return
	}
	status, details := 503, any(map[string]any{"reason": source.Reason})
	switch source.Category {
	case "not_found":
		status, details = 404, nil
	case "path_forbidden", "validation":
		status, details = 422, source.Details
	case "corrupt", "conflict":
		status = 409
	}
	writeError(w, status, source.Code, source.Message, details)
}
func operation() map[string]any {
	return map[string]any{"response_profile": "desktop-proxy-operation-v1"}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	const prefix = "/api/v1/proxy/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		writeError(w, 404, "not_found", "Not Found", nil)
		return
	}
	route := strings.TrimPrefix(r.URL.Path, prefix)
	id := ""
	allowed := ""
	switch route {
	case "status", "sources":
		allowed = "GET"
	case "start", "reload", "stop", "probe", "sources/subscriptions", "sources/inline-nodes":
		allowed = "POST"
	case "sources/node-file":
		allowed = "PUT, DELETE"
	case "sources/override":
		allowed = "DELETE"
	default:
		for _, base := range []string{"sources/subscriptions/", "sources/inline-nodes/"} {
			if strings.HasPrefix(route, base) {
				id = strings.TrimPrefix(route, base)
				if id != "" && !strings.Contains(id, "/") {
					route = strings.TrimSuffix(base, "/")
					allowed = "PUT, DELETE"
				}
				break
			}
		}
	}
	if allowed == "" {
		writeError(w, 404, "not_found", "Not Found", nil)
		return
	}
	if !strings.Contains(", "+allowed+",", ", "+r.Method+",") {
		w.Header().Set("Allow", allowed)
		writeError(w, 405, "method_not_allowed", "Method Not Allowed", nil)
		return
	}
	view := "legacy"
	if values, ok := r.URL.Query()["view"]; ok {
		view = values[len(values)-1]
	}
	if view != "legacy" && view != "desktop" {
		invalid(w, "view", "literal_error")
		return
	}
	desktop := view == "desktop"
	if route == "status" {
		status := h.pool.Status()
		if desktop {
			writeJSON(w, desktopStatus(status))
			return
		}
		result := selectFields(status)
		for key, value := range status {
			result[key] = value
		}
		result["health_loop"] = h.pool.HealthSummary()
		writeJSON(w, result)
		return
	}
	if route == "sources" {
		result, err := h.sources.PublicSnapshot(nil, h.pool.ActiveRevision())
		if err != nil {
			sourceError(w, err)
			return
		}
		if desktop {
			result = desktopSources(result)
		}
		writeJSON(w, result)
		return
	}
	var body map[string]any
	if r.Method == http.MethodPost || r.Method == http.MethodPut {
		var ok bool
		body, ok = decodeBody(w, r, strings.HasPrefix(route, "sources/"))
		if !ok {
			return
		}
	}
	if strings.HasPrefix(route, "sources/") {
		h.mutateSource(w, r, route, id, body, desktop)
		return
	}
	var result any
	var err error
	switch route {
	case "start", "reload":
		if _, ok := booleanField(w, body, "force_refresh", true); !ok {
			return
		}
		target, ok := httpsField(w, body, "probe_url")
		if !ok {
			return
		}
		// Sources are local snapshots; the backend always refreshes them on start/reload.
		if route == "start" {
			result, err = h.pool.Start(r.Context(), target)
		} else {
			result, err = h.pool.Reload(r.Context(), target)
		}
	case "stop":
		force, ok := booleanField(w, body, "force", false)
		if !ok {
			return
		}
		result, err = h.pool.Stop(r.Context(), force)
	case "probe":
		target, ok := httpsField(w, body, "target_url")
		if !ok {
			return
		}
		site, ok := optionalString(w, body, "site")
		if !ok {
			return
		}
		node, ok := optionalString(w, body, "node_id")
		if !ok {
			return
		}
		if site != "" && target == "" {
			site = strings.ToLower(strings.TrimSpace(site))
			switch site {
			case "danbooru", "twitter", "pixiv", "exhentai", "pawchive":
			default:
				writeError(w, 422, "invalid_site", "site 格式无效或不受支持", nil)
				return
			}
			target, err = h.siteProbe(r.Context(), site)
			if err != nil {
				poolError(w, err)
				return
			}
		}
		if target != "" {
			if err = h.validateTarget(r.Context(), target); err != nil {
				writeError(w, 422, "invalid_probe_target", err.Error(), nil)
				return
			}
		}
		result, err = h.pool.Probe(r.Context(), target, node)
	}
	if err != nil {
		poolError(w, err)
		return
	}
	if desktop {
		result = operation()
	}
	writeJSON(w, result)
}

func (h *handler) mutateSource(w http.ResponseWriter, r *http.Request, route, id string, body map[string]any, desktop bool) {
	var snapshot proxysources.Snapshot
	var err error
	if r.Method == http.MethodDelete {
		switch route {
		case "sources/subscriptions":
			snapshot, err = h.sources.DeleteSubscription(id)
		case "sources/inline-nodes":
			snapshot, err = h.sources.DeleteInlineNode(id)
		case "sources/node-file":
			snapshot, err = h.sources.ClearNodeFile()
		case "sources/override":
			snapshot, err = h.sources.ResetOverride()
		}
	} else {
		field, limit := "url", proxysources.MaxSubscriptionURLLength
		switch route {
		case "sources/node-file":
			field, limit = "path", proxysources.MaxSourcePathLength
		case "sources/inline-nodes":
			field, limit = "node", proxysources.MaxInlineNodeLength
			if r.Method == http.MethodPost {
				field = "nodes"
			}
		}
		for key := range body {
			if key != field {
				invalid(w, "body", "extra_forbidden")
				return
			}
		}
		if field == "nodes" {
			nodes, ok := inlineNodes(w, body)
			if !ok {
				return
			}
			snapshot, err = h.sources.AddInlineNodes(nodes)
		} else {
			value, ok := requiredString(w, body, field, limit)
			if !ok {
				return
			}
			switch route {
			case "sources/subscriptions":
				if r.Method == http.MethodPost {
					snapshot, err = h.sources.AddSubscription(value)
				} else {
					snapshot, err = h.sources.ReplaceSubscription(id, value)
				}
			case "sources/node-file":
				snapshot, err = h.sources.SetNodeFile(value)
			case "sources/inline-nodes":
				snapshot, err = h.sources.ReplaceInlineNode(id, value)
			}
		}
	}
	if err != nil {
		sourceError(w, err)
		return
	}
	if desktop {
		writeJSON(w, operation())
		return
	}
	result, err := h.sources.PublicSnapshot(&snapshot, h.pool.ActiveRevision())
	if err != nil {
		sourceError(w, err)
		return
	}
	writeJSON(w, result)
}
