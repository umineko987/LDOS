package tasks

import (
	"bytes"
	"encoding/json"
	"errors"
	"unicode/utf8"

	"ldos/backend/internal/scheduler"
)

// DecodeCreate preserves omitted-versus-null semantics at the HTTP boundary.
// Unknown keys are rejected, including private scheduler-only overrides.
func DecodeCreate(data []byte) (Create, error) {
	var body Create
	var fields map[string]json.RawMessage
	if !utf8.Valid(data) || json.Unmarshal(data, &fields) != nil || fields == nil {
		return body, errors.New("请求必须是 UTF-8 JSON 对象")
	}
	if _, ok := fields["url"]; !ok {
		return body, errors.New("缺少 url")
	}
	for _, key := range []string{"url", "priority", "extra_args"} {
		if raw, ok := fields[key]; ok && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return body, errors.New(key + " 不能为 null")
		}
	}
	if raw, ok := fields["eh_download"]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		var options map[string]json.RawMessage
		if json.Unmarshal(raw, &options) != nil || options == nil {
			return body, errors.New("eh_download 必须是对象")
		}
		for _, value := range options {
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return body, errors.New("eh_download 字段不能为 null")
			}
		}
		body.EHDownload = &scheduler.EHOptions{ImageMode: "original", GPPolicy: "stop"}
	}
	if raw, ok := fields["extra_args"]; ok {
		var args []json.RawMessage
		if json.Unmarshal(raw, &args) != nil {
			return body, errors.New("extra_args 必须是字符串数组")
		}
		for _, arg := range args {
			if bytes.Equal(bytes.TrimSpace(arg), []byte("null")) {
				return body, errors.New("extra_args 不能包含 null")
			}
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		return body, errors.New("任务字段类型无效或包含未知字段")
	}
	if err := body.validate(); err != nil {
		return body, err
	}
	return body, nil
}
