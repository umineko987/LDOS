package downloads

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"unicode/utf8"
)

// ServeHTTP is mounted by the application at /api/v1/settings/downloads.
// The outer middleware supplies X-Request-ID on the response header.
func (s *Store) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	var view View
	var err error
	switch r.Method {
	case http.MethodGet:
		view, err = s.View()
	case http.MethodPut:
		var change Update
		change, err = decodeUpdate(http.MaxBytesReader(w, r.Body, 128<<10))
		if err == nil {
			view, err = s.Update(change)
		}
	default:
		w.Header().Set("Allow", "GET, PUT")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "请求方法不受支持")
		return
	}
	if err != nil {
		var validation *Error
		if errors.As(err, &validation) {
			writeError(w, http.StatusUnprocessableEntity, validation.Code, validation.Message)
		} else {
			writeError(w, http.StatusInternalServerError, "internal_error", "无法读写下载设置")
		}
		return
	}
	_ = json.NewEncoder(w).Encode(view)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{
		"code": code, "message": message, "details": nil,
		"request_id": w.Header().Get("X-Request-ID"),
	}})
}

func decodeUpdate(reader io.Reader) (Update, error) {
	invalid := &Error{"validation_error", "请求参数无效"}
	var raw map[string]json.RawMessage
	decoder := json.NewDecoder(reader)
	if decoder.Decode(&raw) != nil || raw == nil {
		return Update{}, invalid
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return Update{}, invalid
	}
	var change Update
	for name, value := range raw {
		var field *OptionalString
		maxLength := 300
		switch name {
		case "hf_mirror":
			field = &change.HFMirror
		case "proxy_mode":
			field = &change.ProxyMode
		case "custom_proxy":
			field = &change.CustomProxy
		case "hf_token":
			field, maxLength = &change.HFToken, MaxHFTokenLength
		case "clear_hf_token":
			// JSON bool only: null is not an instruction to clear a secret.
			if string(value) != "true" && string(value) != "false" {
				return Update{}, invalid
			}
			change.ClearHFToken = string(value) == "true"
			continue
		default:
			return Update{}, invalid
		}
		field.Set = true
		if err := json.Unmarshal(value, &field.Value); err != nil {
			return Update{}, invalid
		}
		if field.Value != nil {
			if utf8.RuneCountInString(*field.Value) > maxLength {
				return Update{}, invalid
			}
			if name == "proxy_mode" && !validMode(*field.Value) {
				return Update{}, invalid
			}
		}
	}
	if change.ClearHFToken && change.HFToken.Value != nil {
		return Update{}, &Error{"invalid_hf_token", "不能同时保存和清除 HF token"}
	}
	return change, nil
}
