package proxyapi

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"ldos/backend/internal/proxysources"
)

func invalid(w http.ResponseWriter, field, reason string) {
	writeError(w, 422, "validation_error", "请求参数校验失败", []map[string]string{{"field": field, "reason": reason}})
}
func decodeBody(w http.ResponseWriter, r *http.Request, source bool) (map[string]any, bool) {
	var reader io.Reader = r.Body
	if source {
		if raw := r.Header.Get("Content-Length"); raw != "" {
			n, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || n < 0 {
				writeError(w, 400, "invalid_content_length", "Content-Length 无效", nil)
				return nil, false
			}
			if n > proxysources.MaxSourceRequestBytes {
				tooLarge(w)
				return nil, false
			}
		}
		if r.ContentLength > proxysources.MaxSourceRequestBytes {
			tooLarge(w)
			return nil, false
		}
		reader = io.LimitReader(r.Body, proxysources.MaxSourceRequestBytes+1)
	}
	data, err := io.ReadAll(reader)
	if source && len(data) > proxysources.MaxSourceRequestBytes {
		tooLarge(w)
		return nil, false
	}
	if err != nil {
		invalid(w, "body", "json_invalid")
		return nil, false
	}
	if raw := r.Header.Get("Content-Type"); raw != "" {
		media, _, err := mime.ParseMediaType(raw)
		if err != nil || !(media == "application/json" || strings.HasPrefix(media, "application/") && strings.HasSuffix(media, "+json")) {
			invalid(w, "body", "model_attributes_type")
			return nil, false
		}
	}
	var body map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&body); err != nil || body == nil {
		invalid(w, "body", "json_invalid")
		return nil, false
	}
	if decoder.Decode(new(any)) != io.EOF {
		invalid(w, "body", "json_invalid")
		return nil, false
	}
	return body, true
}
func tooLarge(w http.ResponseWriter) {
	writeError(w, 413, "proxy_sources_request_too_large", "代理源请求体超过大小上限", nil)
}
func optionalString(w http.ResponseWriter, body map[string]any, field string) (string, bool) {
	value := body[field]
	if value == nil {
		return "", true
	}
	text, ok := value.(string)
	if !ok {
		invalid(w, field, "string_type")
	}
	return text, ok
}
func requiredString(w http.ResponseWriter, body map[string]any, field string, limit int) (string, bool) {
	text, ok := body[field].(string)
	if !ok {
		invalid(w, field, "string_type")
		return "", false
	}
	count := utf8.RuneCountInString(text)
	if count < 1 || count > limit {
		invalid(w, field, "string_length")
		return "", false
	}
	return text, true
}
func httpsField(w http.ResponseWriter, body map[string]any, field string) (string, bool) {
	text, ok := optionalString(w, body, field)
	if !ok {
		return "", false
	}
	text = strings.TrimSpace(text)
	if text != "" && !strings.HasPrefix(strings.ToLower(text), "https://") {
		invalid(w, field, "value_error")
		return "", false
	}
	return text, true
}

// Pydantic's non-strict bool accepts these JSON boolean, string and numeric forms.
func booleanField(w http.ResponseWriter, body map[string]any, field string, fallback bool) (bool, bool) {
	value, present := body[field]
	if !present {
		return fallback, true
	}
	switch v := value.(type) {
	case bool:
		return v, true
	case json.Number:
		n, err := v.Float64()
		if err == nil {
			if n == 0 {
				return false, true
			}
			if n == 1 {
				return true, true
			}
		}
	case string:
		switch strings.ToLower(v) {
		case "0", "off", "f", "false", "n", "no":
			return false, true
		case "1", "on", "t", "true", "y", "yes":
			return true, true
		}
	}
	invalid(w, field, "bool_parsing")
	return false, false
}
func inlineNodes(w http.ResponseWriter, body map[string]any) ([]string, bool) {
	values, ok := body["nodes"].([]any)
	if !ok || len(values) < 1 || len(values) > proxysources.MaxInlineNodes {
		invalid(w, "nodes", "list_length")
		return nil, false
	}
	result := make([]string, 0, len(values))
	total := 0
	for _, raw := range values {
		text, ok := raw.(string)
		n := utf8.RuneCountInString(text)
		if !ok || strings.TrimSpace(text) == "" || n > proxysources.MaxInlineNodeLength {
			invalid(w, "nodes", "value_error")
			return nil, false
		}
		total += n
		result = append(result, text)
	}
	if total > proxysources.MaxInlineNodeTotalChars {
		invalid(w, "nodes", "value_error")
		return nil, false
	}
	return result, true
}
