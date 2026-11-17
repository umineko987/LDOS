// Package search implements the multi-source search contract independently of HTTP and authorization storage.
package search

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

type SourceOptions struct {
	ProxyMode      *string
	CredentialsRef *string
	CookiesFile    *string
	ConfigFile     *string
	ExtraArgs      []string
	TimeoutSeconds float64
	present        map[string]bool
}
type Request struct {
	SourceOptions
	Keyword string
	Sites   []string
	Limit   int
	Options map[string]SourceOptions
}
type Error struct {
	Status        int
	Code, Message string
	Details       any
}

func (e *Error) Error() string { return e.Message }
func invalid(message string) error {
	return &Error{Status: 422, Code: "validation_error", Message: message}
}

var siteName = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,127}$`)
var referenceName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)

func object(data []byte) (map[string]json.RawMessage, error) {
	var raw map[string]json.RawMessage
	if !utf8.Valid(data) || json.Unmarshal(data, &raw) != nil || raw == nil {
		return nil, invalid("请求必须是有效的 JSON 对象")
	}
	return raw, nil
}
func null(raw json.RawMessage) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }
func decodeStrings(raw json.RawMessage) ([]string, error) {
	var values []json.RawMessage
	if null(raw) || json.Unmarshal(raw, &values) != nil {
		return nil, invalid("参数必须是字符串列表")
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		var text string
		if null(value) || json.Unmarshal(value, &text) != nil {
			return nil, invalid("列表包含非字符串")
		}
		result = append(result, text)
	}
	return result, nil
}
func number(raw json.RawMessage) (float64, error) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return 0, invalid("数字格式无效")
	}
	var text string
	switch v := value.(type) {
	case json.Number:
		text = v.String()
	case string:
		text = strings.TrimSpace(v)
	case bool:
		if v {
			return 1, nil
		}
		return 0, nil
	default:
		return 0, invalid("数字格式无效")
	}
	n, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, invalid("数字格式无效")
	}
	return n, nil
}
func decodeOptions(raw map[string]json.RawMessage, root bool) (SourceOptions, error) {
	result := SourceOptions{ExtraArgs: []string{}, TimeoutSeconds: 180, present: map[string]bool{}}
	stringsByKey := map[string]**string{"proxy_mode": &result.ProxyMode, "credentials_ref": &result.CredentialsRef, "cookies_file": &result.CookiesFile, "config_file": &result.ConfigFile}
	for key, value := range raw {
		if ptr, ok := stringsByKey[key]; ok {
			result.present[key] = true
			if null(value) {
				continue
			}
			var text string
			if json.Unmarshal(value, &text) != nil {
				return result, invalid(key + " 必须是字符串或 null")
			}
			maximum := 2048
			if key == "credentials_ref" {
				maximum = 128
			}
			if utf8.RuneCountInString(text) > maximum {
				return result, invalid(key + " 过长")
			}
			if key == "proxy_mode" && text != "direct" && text != "prefer" && text != "required" {
				return result, invalid("proxy_mode 无效")
			}
			if key == "credentials_ref" {
				text = strings.TrimSpace(text)
				if text != "" && !referenceName.MatchString(text) {
					return result, invalid("credentials_ref 格式无效")
				}
			}
			*ptr = &text
			continue
		}
		switch key {
		case "search_extra_args":
			args, err := decodeStrings(value)
			if err != nil {
				return result, err
			}
			if len(args) > 128 {
				return result, invalid("search_extra_args 超出上限")
			}
			result.ExtraArgs = args
			result.present[key] = true
		case "timeout_seconds":
			n, err := number(value)
			if err != nil || n < 5 || n > 3600 {
				return result, invalid("timeout_seconds 超出范围")
			}
			result.TimeoutSeconds = n
			result.present[key] = true
		case "keyword", "sites", "limit", "source_options":
			if !root {
				return result, invalid("未知字段: " + key)
			}
		default:
			return result, invalid("未知字段: " + key)
		}
	}
	return result, nil
}
func DecodeRequest(data []byte) (Request, error) {
	raw, err := object(data)
	if err != nil {
		return Request{}, err
	}
	opts, err := decodeOptions(raw, true)
	if err != nil {
		return Request{}, err
	}
	result := Request{SourceOptions: opts, Sites: []string{"danbooru", "twitter", "pixiv", "exhentai", "pawchive"}, Limit: 20, Options: map[string]SourceOptions{}}
	value, ok := raw["keyword"]
	if !ok || null(value) || json.Unmarshal(value, &result.Keyword) != nil || utf8.RuneCountInString(result.Keyword) < 1 || utf8.RuneCountInString(result.Keyword) > 1000 {
		return result, invalid("keyword 长度或类型无效")
	}
	result.Keyword = strings.TrimSpace(result.Keyword)
	if result.Keyword == "" {
		return result, invalid("keyword 为空")
	}
	if value, ok := raw["sites"]; ok {
		sites, err := decodeStrings(value)
		if err != nil {
			return result, err
		}
		if len(sites) < 1 || len(sites) > 5 {
			return result, invalid("sites 数量无效")
		}
		result.Sites = []string{}
		seen := map[string]bool{}
		for _, site := range sites {
			site = strings.ToLower(strings.TrimSpace(site))
			if !siteName.MatchString(site) {
				return result, invalid("sites 中包含格式无效的站点名")
			}
			if !seen[site] {
				seen[site] = true
				result.Sites = append(result.Sites, site)
			}
		}
	}
	if value, ok := raw["limit"]; ok {
		n, err := number(value)
		if err != nil || n != math.Trunc(n) || n < 1 || n > 200 {
			return result, invalid("limit 超出范围")
		}
		result.Limit = int(n)
	}
	if value, ok := raw["source_options"]; ok {
		options, err := object(value)
		if err != nil {
			return result, err
		}
		if len(options) > 8 {
			return result, invalid("source_options 超出上限")
		}
		for key, value := range options {
			source, err := object(value)
			if err != nil {
				return result, err
			}
			opt, err := decodeOptions(source, false)
			if err != nil {
				return result, err
			}
			result.Options[key] = opt
		}
	}
	return result, nil
}
func (o SourceOptions) override(base SourceOptions) SourceOptions {
	result := base
	for key, pair := range map[string][2]**string{"proxy_mode": {&result.ProxyMode, &o.ProxyMode}, "credentials_ref": {&result.CredentialsRef, &o.CredentialsRef}, "cookies_file": {&result.CookiesFile, &o.CookiesFile}, "config_file": {&result.ConfigFile, &o.ConfigFile}} {
		if o.present[key] {
			*pair[0] = *pair[1]
		}
	}
	if o.present["timeout_seconds"] {
		result.TimeoutSeconds = o.TimeoutSeconds
	}
	result.ExtraArgs = append(append([]string{}, base.ExtraArgs...), o.ExtraArgs...)
	return result
}
func text(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
func valueText(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	if boolean, ok := value.(bool); ok {
		if boolean {
			return "True"
		}
		return "False"
	}
	data, _ := json.Marshal(value)
	return string(data)
}

var errDependencies = errors.New("search dependencies are incomplete")
