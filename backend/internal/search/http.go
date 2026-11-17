package search

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strings"
	"unicode/utf8"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/discoverydata"
)

func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func failure(w http.ResponseWriter, err error) {
	public := &Error{Status: 500, Code: "internal_error", Message: "搜索请求失败"}
	var defined *Error
	var upstream *discovery.Error
	switch {
	case errors.As(err, &defined):
		public = defined
	case errors.As(err, &upstream):
		public = &Error{Status: 502, Code: upstream.Code, Message: upstream.Message}
	}
	reply(w, public.Status, map[string]any{"error": map[string]any{"code": public.Code, "message": public.Message, "details": public.Details, "request_id": w.Header().Get("X-Request-ID")}})
}
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	method := "GET"
	switch r.URL.Path {
	case "/api/v1/search":
		method = "POST"
	case "/api/v1/search/sites", "/api/v1/search/autocomplete":
	default:
		failure(w, &Error{Status: 404, Code: "not_found", Message: "接口不存在"})
		return
	}
	if r.Method != method {
		w.Header().Set("Allow", method)
		failure(w, &Error{Status: 405, Code: "method_not_allowed", Message: "请求方法不支持"})
		return
	}
	switch r.URL.Path {
	case "/api/v1/search/sites":
		reply(w, 200, map[string]any{"items": discoverydata.SearchSiteCatalog()})
	case "/api/v1/search/autocomplete":
		if !r.URL.Query().Has("q") {
			failure(w, invalid("缺少 q 参数"))
			return
		}
		query := strings.TrimSpace(r.URL.Query().Get("q"))
		if query == "" || utf8.RuneCountInString(query) > 200 {
			failure(w, &Error{Status: 422, Code: "invalid_autocomplete", Message: "补全关键词不能为空且不能超过 200 字符"})
			return
		}
		limit := 10
		if r.URL.Query().Has("limit") {
			raw, _ := json.Marshal(r.URL.Query().Get("limit"))
			n, err := number(raw)
			if err != nil || math.Trunc(n) != n {
				failure(w, invalid("limit 必须是整数"))
				return
			}
			limit = int(min(20, max(1, n)))
		}
		policy, err := s.deps.Policy(r.Context(), "danbooru")
		if err != nil {
			failure(w, err)
			return
		}
		result, err := s.deps.Discovery.Autocomplete(r.Context(), query, limit, policy, "")
		if err != nil {
			failure(w, err)
			return
		}
		reply(w, 200, map[string]any{"query": result["query"], "source": "danbooru", "items": result["items"]})
	case "/api/v1/search":
		view := "legacy"
		if r.URL.Query().Has("view") {
			view = r.URL.Query().Get("view")
		}
		if view != "legacy" && view != "desktop" {
			failure(w, invalid("view 必须是 legacy 或 desktop"))
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				failure(w, &Error{Status: 413, Code: "request_too_large", Message: "请求体过大"})
			} else {
				failure(w, invalid("无法读取请求体"))
			}
			return
		}
		body, err := DecodeRequest(data)
		if err != nil {
			failure(w, err)
			return
		}
		result, err := s.Perform(r.Context(), body)
		if r.Context().Err() != nil {
			return
		}
		if err != nil {
			failure(w, err)
			return
		}
		if view == "desktop" {
			result = Desktop(result)
		}
		reply(w, 200, result)
	}
}
