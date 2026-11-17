package authorization

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

type operation func(*http.Request) (map[string]any, error)
type projection func(map[string]any) map[string]any

func reply(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, err error, vault bool) {
	status, code, message := 500, "authorization_operation_failed", "授权操作失败"
	var known *Error
	if errors.As(err, &known) {
		code, message, status = known.Code, known.Message, 409
		switch {
		case code == "unsupported_auth_site" || code == "pixiv_oauth_session_not_found" || code == "browser_login_session_not_found":
			status = 404
		case strings.HasPrefix(code, "invalid_"):
			status = 422
		case code == "request_too_large":
			status = 413
		}
	}
	if vault {
		switch status {
		case 404:
			message = "授权目标或会话不存在"
		case 422:
			message = "授权请求不符合安全约束"
		case 413:
			message = "授权请求体过大"
		default:
			message = "授权状态冲突或操作暂时不可用"
		}
	}
	reply(w, status, map[string]any{"error": map[string]any{"code": code, "message": message, "details": nil, "request_id": w.Header().Get("X-Request-ID")}})
}
func wrap(status int, project projection, run operation) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		view := "legacy"
		if values, ok := r.URL.Query()["view"]; ok {
			view = values[len(values)-1]
		}
		if view != "legacy" && view != "vault" {
			fail(w, problem("invalid_auth_view", "view 必须是 legacy 或 vault"), true)
			return
		}
		result, err := run(r)
		if err != nil {
			fail(w, err, view == "vault")
			return
		}
		if view == "vault" {
			result = project(result)
		}
		reply(w, status, result)
	}
}
func bodyString(r *http.Request, key string, required bool, size int64, length int) (string, error) {
	data, err := io.ReadAll(io.LimitReader(r.Body, size+1))
	if err != nil {
		return "", problem("invalid_auth_request", "无法读取授权请求")
	}
	if int64(len(data)) > size {
		return "", problem("request_too_large", "授权请求体过大")
	}
	var raw map[string]json.RawMessage
	if !utf8.Valid(data) || json.Unmarshal(data, &raw) != nil || raw == nil {
		return "", problem("invalid_auth_request", "授权请求必须是 JSON 对象")
	}
	for k := range raw {
		if k != key {
			return "", problem("invalid_auth_request", "授权请求包含未知字段")
		}
	}
	field, ok := raw[key]
	if !ok && !required {
		return "", nil
	}
	var value string
	if !ok || string(field) == "null" || json.Unmarshal(field, &value) != nil || utf8.RuneCountInString(value) > length || (required && value == "") {
		return "", problem("invalid_auth_request", "授权请求字段无效")
	}
	return value, nil
}
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/auth", wrap(200, vaultStatuses, func(r *http.Request) (map[string]any, error) { return s.Statuses(r.Context()) }))
	mux.HandleFunc("GET /api/v1/auth/proxy", wrap(200, vaultProxy, func(r *http.Request) (map[string]any, error) { return s.ProxyStatus(r.Context()) }))
	mux.HandleFunc("PUT /api/v1/auth/proxy", wrap(200, vaultProxy, func(r *http.Request) (map[string]any, error) {
		value, err := bodyString(r, "proxy_url", false, 1024, 300)
		if err != nil {
			return nil, err
		}
		return s.SetProxy(r.Context(), value)
	}))
	mux.HandleFunc("DELETE /api/v1/auth/proxy", wrap(200, vaultProxy, func(r *http.Request) (map[string]any, error) { return s.ClearProxy(r.Context()) }))
	mux.HandleFunc("GET /api/v1/auth/browser", wrap(200, vaultRuntime, func(r *http.Request) (map[string]any, error) { return s.BrowserStatus(), nil }))
	mux.HandleFunc("PUT /api/v1/auth/browser", wrap(200, vaultRuntime, func(r *http.Request) (map[string]any, error) {
		value, err := bodyString(r, "path", true, 1<<20, 4096)
		if err != nil {
			return nil, err
		}
		return s.SetBrowser(r.Context(), value, false)
	}))
	mux.HandleFunc("DELETE /api/v1/auth/browser", wrap(200, vaultRuntime, func(r *http.Request) (map[string]any, error) { return s.SetBrowser(r.Context(), "", true) }))
	mux.HandleFunc("DELETE /api/v1/auth/browser-profile", wrap(200, func(row map[string]any) map[string]any {
		return map[string]any{"browser_profile": vaultProfile(object(row["browser_profile"])), "auth": vaultStatuses(object(row["auth"]))}
	}, func(r *http.Request) (map[string]any, error) { return s.ResetProfile(r.Context()) }))
	mux.HandleFunc("GET /api/v1/auth/{site}", wrap(200, VaultStatus, func(r *http.Request) (map[string]any, error) { return s.Status(r.Context(), r.PathValue("site")) }))
	mux.HandleFunc("DELETE /api/v1/auth/{site}", wrap(200, VaultStatus, func(r *http.Request) (map[string]any, error) { return s.Clear(r.Context(), r.PathValue("site")) }))
	mux.HandleFunc("POST /api/v1/auth/{site}/login/start", wrap(202, vaultLogin, func(r *http.Request) (map[string]any, error) {
		site, err := normalize(r.PathValue("site"))
		if err != nil {
			return nil, err
		}
		if site == "pixiv" {
			return nil, problem("managed_browser_unsupported", "Pixiv 使用 OAuth 授权")
		}
		return s.Start(r.Context(), site)
	}))
	mux.HandleFunc("GET /api/v1/auth/{site}/login/{session}", wrap(200, vaultLogin, func(r *http.Request) (map[string]any, error) {
		return s.LoginSession(r.Context(), r.PathValue("site"), r.PathValue("session"))
	}))
	mux.HandleFunc("DELETE /api/v1/auth/{site}/login/{session}", wrap(200, vaultLogin, func(r *http.Request) (map[string]any, error) {
		return s.CancelLogin(r.Context(), r.PathValue("site"), r.PathValue("session"))
	}))
	mux.HandleFunc("POST /api/v1/auth/pixiv/oauth/start", wrap(200, func(row map[string]any) map[string]any { return object(vaultSession(row, "pixiv")) }, func(r *http.Request) (map[string]any, error) { return s.Start(r.Context(), "pixiv") }))
	mux.HandleFunc("DELETE /api/v1/auth/pixiv/oauth/session", wrap(200, VaultStatus, func(r *http.Request) (map[string]any, error) { return s.CancelPixiv(r.Context()) }))
	return mux
}
