package policy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// Repository owns persistence and must commit each write atomically. A missing
// override is returned as (nil, nil); a missing deletion returns (false, nil).
// Policy records have site, policy and updated_at keys. Malformed stored JSON
// must return an error, not an empty policy or a missing override.
type Repository interface {
	ListSitePolicies(context.Context) ([]map[string]any, error)
	GetSitePolicy(context.Context, string) (map[string]any, error)
	PutSitePolicy(context.Context, string, map[string]any) (map[string]any, error)
	DeleteSitePolicy(context.Context, string) (bool, error)
}

type handler struct {
	defaultPolicy map[string]any
	repo          Repository
}

// New returns the handler for /api/v1/sites/policies and its /{site} routes.
// Defaults are a startup snapshot: absent fields use 20/2/2/prefer, while invalid
// fields (including unknown keys) make inherited policies unsafe, not writable
// defaults. Request identifiers are supplied by the outer X-Request-ID middleware.
func New(defaultPolicy map[string]any, repo Repository) http.Handler {
	if defaultPolicy == nil {
		defaultPolicy = defaults()
	}
	policy, _ := normalizePolicy(defaultPolicy, true)
	return &handler{defaultPolicy: policy, repo: repo}
}

const policiesPath = "/api/v1/sites/policies"

var sitePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,127}$`)

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	site := r.PathValue("site")
	listing := r.URL.Path == policiesPath && site == ""
	if !listing && site == "" {
		if !strings.HasPrefix(r.URL.Path, policiesPath+"/") {
			writeError(w, 404, "not_found", "Not Found", nil)
			return
		}
		site = strings.TrimPrefix(r.URL.Path, policiesPath+"/")
		if site == "" || strings.Contains(site, "/") {
			writeError(w, 404, "not_found", "Not Found", nil)
			return
		}
	}
	if (listing && r.Method != http.MethodGet) || (!listing && r.Method != http.MethodGet && r.Method != http.MethodPut && r.Method != http.MethodDelete) {
		allow := "GET, PUT, DELETE"
		if listing {
			allow = "GET"
		}
		w.Header().Set("Allow", allow)
		writeError(w, 405, "method_not_allowed", "Method Not Allowed", nil)
		return
	}
	view := "legacy"
	if values, present := r.URL.Query()["view"]; present {
		view = values[len(values)-1]
	}
	if view != "legacy" && view != "policy" {
		code := "invalid_policy"
		if listing {
			code = "validation_error"
		}
		writeError(w, 422, code, "请求参数校验失败", []validationDetail{{"policy", "literal_error"}})
		return
	}
	if listing {
		h.list(w, r, view)
		return
	}
	// Policies intentionally use validate_site_name, not canonical_site_name:
	// trim/lowercase only; aliases such as x and e-hentai are not supported here.
	site = strings.ToLower(strings.TrimSpace(site))
	if !sitePattern.MatchString(site) {
		writeError(w, 422, "invalid_site", "site 格式无效", nil)
		return
	}
	if !supportedSite(site) {
		writeError(w, 422, "unsupported_policy_site", "该站点不能在此处设置", nil)
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.get(w, r, site, view)
	case http.MethodPut:
		h.put(w, r, site, view)
	case http.MethodDelete:
		h.delete(w, r, site, view)
	}
}

func (h *handler) list(w http.ResponseWriter, r *http.Request, view string) {
	stored, err := h.repo.ListSitePolicies(r.Context())
	if err != nil {
		storeError(w)
		return
	}
	if view == "legacy" {
		if h.defaultPolicy == nil {
			storeError(w)
			return
		}
		items := make([]map[string]any, 0, len(stored))
		for _, raw := range stored {
			site, _ := raw["site"].(string)
			if !supportedSite(site) {
				continue
			}
			policy, issues := normalizePolicy(raw["policy"], true)
			if len(issues) != 0 {
				storeError(w)
				return
			}
			items = append(items, legacyItem(site, policy, false, raw["updated_at"]))
		}
		writeJSON(w, map[string]any{"default": h.defaultPolicy, "items": items})
		return
	}
	bySite := make(map[string]map[string]any)
	unknown := 0
	for _, raw := range stored {
		site, _ := raw["site"].(string)
		if !supportedSite(site) {
			unknown++
			continue
		}
		bySite[site] = raw
	}
	items := make([]map[string]any, 0, len(sites))
	for _, definition := range sites {
		raw, exists := bySite[definition.id]
		policy := h.defaultPolicy
		var updatedAt any
		if exists {
			policy, _ = normalizePolicy(raw["policy"], true)
			updatedAt = raw["updated_at"]
		}
		items = append(items, viewItem(definition.id, policy, !exists, updatedAt))
	}
	writeJSON(w, map[string]any{
		"response_profile": "policy", "secrets_exposed": false,
		"effect_scope": "new_requests_and_tasks", "concurrency_protection": "none",
		"default_source": "startup_snapshot", "persistence": "sqlite_atomic",
		"default": policyState(h.defaultPolicy, true), "items": items, "unknown_override_count": unknown,
	})
}

func (h *handler) get(w http.ResponseWriter, r *http.Request, site, view string) {
	stored, err := h.repo.GetSitePolicy(r.Context(), site)
	if err != nil {
		storeError(w)
		return
	}
	policy := h.defaultPolicy
	var updatedAt any
	if stored != nil {
		policy, _ = normalizePolicy(stored["policy"], true)
		updatedAt = stored["updated_at"]
	}
	if view == "policy" {
		writeJSON(w, viewItem(site, policy, stored == nil, updatedAt))
		return
	}
	if policy == nil {
		storeError(w)
		return
	}
	writeJSON(w, legacyItem(site, policy, stored == nil, updatedAt))
}

func (h *handler) put(w http.ResponseWriter, r *http.Request, site, view string) {
	raw, ok := readPolicy(w, r)
	if !ok {
		return
	}
	policy, issues := normalizePolicy(raw, false)
	if len(issues) != 0 {
		writeError(w, 422, "invalid_policy", "请求参数校验失败", issues)
		return
	}
	for _, field := range policyFields {
		if _, exists := raw[field]; !exists {
			writeError(w, 422, "invalid_policy", "站点设置中有不支持或不正确的字段", validationDetail{field, "missing_field"})
			return
		}
	}
	stored, err := h.repo.PutSitePolicy(r.Context(), site, policy)
	if err != nil {
		storeError(w)
		return
	}
	// Always project returned records; repository errors/metadata must not become
	// an accidental bypass of policy validation or expose storage-only fields.
	policy, _ = normalizePolicy(stored["policy"], true)
	if view == "policy" {
		writeJSON(w, viewItem(site, policy, false, stored["updated_at"]))
		return
	}
	if policy == nil {
		storeError(w)
		return
	}
	writeJSON(w, legacyItem(site, policy, false, stored["updated_at"]))
}

func (h *handler) delete(w http.ResponseWriter, r *http.Request, site, view string) {
	deleted, err := h.repo.DeleteSitePolicy(r.Context(), site)
	if err != nil {
		storeError(w)
		return
	}
	if !deleted {
		writeError(w, 404, "site_policy_not_found", "该站点没有单独保存的设置", nil)
		return
	}
	result := map[string]any{"deleted": true, "site": site}
	if view == "policy" {
		result["response_profile"] = "policy"
	}
	writeJSON(w, result)
}

func legacyItem(site string, policy map[string]any, inherited bool, updatedAt any) map[string]any {
	item := map[string]any{"site": site, "policy": policy}
	if inherited {
		item["inherited"] = true
	} else {
		item["updated_at"] = safeTimestamp(updatedAt)
	}
	return item
}

func readPolicy(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	if values, present := r.Header["Content-Length"]; present {
		if len(values) != 1 {
			writeError(w, 400, "invalid_content_length", "Content-Length 无效", nil)
			return nil, false
		}
		length, err := strconv.ParseInt(strings.TrimSpace(values[0]), 10, 64)
		if err != nil || length < 0 {
			writeError(w, 400, "invalid_content_length", "Content-Length 无效", nil)
			return nil, false
		}
		if length > maxRequestBytes {
			tooLarge(w)
			return nil, false
		}
	}
	if r.ContentLength > maxRequestBytes {
		tooLarge(w)
		return nil, false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes+1))
	if len(body) > maxRequestBytes {
		tooLarge(w)
		return nil, false
	}
	if err != nil {
		writeError(w, 400, "invalid_policy", "请求体无法读取", nil)
		return nil, false
	}
	invalid := func(reason string) (map[string]any, bool) {
		writeError(w, 422, "invalid_policy", "请求参数校验失败", []validationDetail{{"policy", reason}})
		return nil, false
	}
	if len(body) == 0 {
		return invalid("missing")
	}
	if contentType := r.Header.Get("Content-Type"); contentType != "" {
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err != nil || (mediaType != "application/json" && !(strings.HasPrefix(mediaType, "application/") && strings.HasSuffix(mediaType, "+json"))) {
			return invalid("model_attributes_type")
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return invalid("json_invalid")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return invalid("json_invalid")
	}
	if value == nil {
		return invalid("missing")
	}
	raw, ok := value.(map[string]any)
	if !ok {
		return invalid("model_attributes_type")
	}
	return raw, true
}

func tooLarge(w http.ResponseWriter) {
	writeError(w, 413, "policy_request_too_large", "站点策略请求体超过大小上限", nil)
}

func storeError(w http.ResponseWriter) {
	writeError(w, 503, "policy_store_error", "站点设置暂时无法保存或读取", nil)
}

func writeError(w http.ResponseWriter, status int, code, message string, details any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{
		"code": code, "message": message, "details": details,
		"request_id": w.Header().Get("X-Request-ID"),
	}})
}

func writeJSON(w http.ResponseWriter, value any) {
	_ = json.NewEncoder(w).Encode(value)
}
