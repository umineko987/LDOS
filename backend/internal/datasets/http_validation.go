package datasets

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// These request rules mirror the dataset-owned Python request models. Crawl
// validation remains the responsibility of the native crawl callback.
type requestField struct {
	name, kind               string
	required, nullable, trim bool
	min, max                 int
	values                   []string
	item                     *requestField
}
type requestSchema struct {
	fields []requestField
	root   bool
}

func stringRule(name string, min, max int, required, nullable bool) requestField {
	return requestField{name: name, kind: "string", min: min, max: max, required: required, nullable: nullable}
}
func literalRule(name string, required, nullable bool, values ...string) requestField {
	return requestField{name: name, kind: "literal", required: required, nullable: nullable, values: values}
}
func datasetSchema(create bool) requestSchema {
	name := stringRule("name", 1, 120, create, !create)
	name.trim = true
	fields := []requestField{name, literalRule("kind", false, !create, "character", "style", "concept"), stringRule("trigger_word", 0, 120, false, !create), {name: "config", kind: "dict", nullable: !create}}
	if !create {
		fields = append(fields, stringRule("cover_asset_id", 0, 128, false, true))
	}
	return requestSchema{fields: fields}
}
func rootsSchema() requestSchema {
	return requestSchema{root: true, fields: []requestField{stringRule("directory_id", 1, 128, false, true), stringRule("source_id", 1, 128, false, true), stringRule("path", 1, 4096, false, true), stringRule("display_name", 1, 255, false, true)}}
}
func decisionsSchema() requestSchema {
	item := stringRule("", 1, 128, false, false)
	return requestSchema{fields: []requestField{literalRule("stage", true, false, Stages[:]...), {name: "asset_ids", kind: "list", min: 1, max: 5000, required: true, item: &item}, literalRule("decision", true, false, "exclude", "approve", "clear"), stringRule("reason", 0, 500, false, false)}}
}
func exportSchema() requestSchema {
	item := stringRule("", 1, 200, false, false)
	return requestSchema{fields: []requestField{
		stringRule("target_path", 1, 4096, true, false), literalRule("layout", false, false, "kohya", "flat"), {name: "repeats", kind: "int", min: 1, max: 10000},
		stringRule("trigger_word", 0, 120, false, true), stringRule("folder_name", 0, 120, false, true), literalRule("rename", false, false, "none", "sequential"),
		{name: "include_captions", kind: "bool"}, {name: "pin_trigger", kind: "bool"}, {name: "tag_blacklist", kind: "list", max: 500, item: &item},
		{name: "underscore_to_space", kind: "bool"}, {name: "dry_run", kind: "bool"},
	}}
}
func validationError(details ...Record) *Error {
	return &Error{Status: 422, Code: "validation_error", Message: "请求参数校验失败", Details: details}
}
func validationDetail(kind string, loc []any, message string, input any, extra Record) Record {
	r := Record{"type": kind, "loc": loc, "msg": message, "input": input}
	if extra != nil {
		r["ctx"] = extra
	}
	return r
}
func expectedLiteral(values []string) string {
	quoted := make([]string, len(values))
	for i, v := range values {
		quoted[i] = "'" + v + "'"
	}
	if len(quoted) < 2 {
		return strings.Join(quoted, "")
	}
	return strings.Join(quoted[:len(quoted)-1], ", ") + " or " + quoted[len(quoted)-1]
}
func (f requestField) validate(value any, loc []any) (any, []Record) {
	bad := func(kind, message string, extra Record) (any, []Record) {
		return value, []Record{validationDetail(kind, loc, message, value, extra)}
	}
	if value == nil && f.nullable {
		return nil, nil
	}
	switch f.kind {
	case "string":
		text, ok := value.(string)
		if !ok {
			return bad("string_type", "Input should be a valid string", nil)
		}
		length := utf8.RuneCountInString(text)
		if length < f.min {
			word := "characters"
			if f.min == 1 {
				word = "character"
			}
			return bad("string_too_short", fmt.Sprintf("String should have at least %d %s", f.min, word), Record{"min_length": f.min})
		}
		if length > f.max {
			word := "characters"
			if f.max == 1 {
				word = "character"
			}
			return bad("string_too_long", fmt.Sprintf("String should have at most %d %s", f.max, word), Record{"max_length": f.max})
		}
		if f.trim {
			text = strings.TrimSpace(text)
			if text == "" {
				return bad("value_error", "Value error, 不能为空", Record{"error": Record{}})
			}
		}
		return text, nil
	case "literal":
		for _, candidate := range f.values {
			if text, ok := value.(string); ok && text == candidate {
				return text, nil
			}
		}
		expected := expectedLiteral(f.values)
		return bad("literal_error", "Input should be "+expected, Record{"expected": expected})
	case "dict":
		if _, ok := value.(map[string]any); !ok {
			return bad("dict_type", "Input should be a valid dictionary", nil)
		}
		return value, nil
	case "bool":
		if _, ok := value.(bool); ok {
			return value, nil
		}
		text := ""
		switch v := value.(type) {
		case string:
			text = strings.ToLower(v)
		case json.Number:
			n, err := v.Float64()
			if err == nil && (n == 0 || n == 1) {
				return n == 1, nil
			}
			text = v.String()
		default:
			return bad("bool_type", "Input should be a valid boolean", nil)
		}
		switch text {
		case "1", "true", "t", "on", "y", "yes":
			return true, nil
		case "0", "false", "f", "off", "n", "no":
			return false, nil
		}
		return bad("bool_parsing", "Input should be a valid boolean, unable to interpret input", nil)
	case "int":
		var number float64
		switch v := value.(type) {
		case bool:
			if v {
				number = 1
			}
		case json.Number:
			var err error
			number, err = v.Float64()
			if err != nil {
				return bad("int_parsing", "Input should be a valid integer, unable to parse string as an integer", nil)
			}
			if math.IsInf(number, 0) || math.IsNaN(number) {
				return bad("finite_number", "Input should be a finite number", nil)
			}
			if number != math.Trunc(number) {
				return bad("int_from_float", "Input should be a valid integer, got a number with a fractional part", nil)
			}
		case string:
			text := strings.TrimSpace(v)
			// Pydantic accepts integral decimal strings, but not exponents.
			clean := strings.ReplaceAll(text, "_", "")
			if strings.ContainsAny(clean, "eExXoObB") || strings.HasPrefix(text, "_") || strings.HasSuffix(text, "_") || strings.Contains(text, "__") {
				return bad("int_parsing", "Input should be a valid integer, unable to parse string as an integer", nil)
			}
			var err error
			number, err = strconv.ParseFloat(clean, 64)
			if err != nil || math.IsInf(number, 0) || math.IsNaN(number) || number != math.Trunc(number) {
				return bad("int_parsing", "Input should be a valid integer, unable to parse string as an integer", nil)
			}
		default:
			return bad("int_type", "Input should be a valid integer", nil)
		}
		if number < float64(f.min) {
			return bad("greater_than_equal", fmt.Sprintf("Input should be greater than or equal to %d", f.min), Record{"ge": f.min})
		}
		if number > float64(f.max) {
			return bad("less_than_equal", fmt.Sprintf("Input should be less than or equal to %d", f.max), Record{"le": f.max})
		}
		return int64(number), nil
	case "list":
		list, ok := value.([]any)
		if !ok {
			return bad("list_type", "Input should be a valid list", nil)
		}
		if len(list) > f.max {
			return bad("too_long", fmt.Sprintf("List should have at most %d items after validation, not %d", f.max, len(list)), Record{"field_type": "List", "max_length": f.max, "actual_length": len(list)})
		}
		result := make([]any, len(list))
		var issues []Record
		for i, item := range list {
			next := append(append([]any{}, loc...), i)
			v, errs := f.item.validate(item, next)
			result[i] = v
			issues = append(issues, errs...)
		}
		if len(issues) > 0 {
			return value, issues
		}
		if len(list) < f.min {
			word := "items"
			if f.min == 1 {
				word = "item"
			}
			return bad("too_short", fmt.Sprintf("List should have at least %d %s after validation, not %d", f.min, word, len(list)), Record{"field_type": "List", "min_length": f.min, "actual_length": len(list)})
		}
		return result, nil
	}
	panic("unknown dataset request field rule")
}
func decodeRequest(r *http.Request, schema requestSchema) (Record, error) {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		if err == io.EOF {
			return nil, validationError(validationDetail("missing", []any{"body"}, "Field required", nil, nil))
		}
		return nil, jsonRequestError(err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			err = fmt.Errorf("Extra data")
		}
		return nil, jsonRequestError(err)
	}
	if value == nil {
		return nil, validationError(validationDetail("missing", []any{"body"}, "Field required", nil, nil))
	}
	body, ok := value.(map[string]any)
	if !ok {
		return nil, validationError(validationDetail("model_attributes_type", []any{"body"}, "Input should be a valid dictionary or object to extract fields from", value, nil))
	}
	original := Record{}
	for key, v := range body {
		original[key] = v
	}
	valid := map[string]bool{}
	var issues []Record
	for _, field := range schema.fields {
		valid[field.name] = true
		v, exists := body[field.name]
		loc := []any{"body", field.name}
		if !exists {
			if field.required {
				issues = append(issues, validationDetail("missing", loc, "Field required", original, nil))
			}
			continue
		}
		parsed, errs := field.validate(v, loc)
		issues = append(issues, errs...)
		if len(errs) == 0 {
			body[field.name] = parsed
		}
	}
	var unknown []string
	for key := range body {
		if !valid[key] {
			unknown = append(unknown, key)
		}
	}
	sort.Strings(unknown)
	for _, key := range unknown {
		issues = append(issues, validationDetail("extra_forbidden", []any{"body", key}, "Extra inputs are not permitted", body[key], nil))
	}
	if len(issues) > 0 {
		return nil, validationError(issues...)
	}
	if schema.root {
		chosen := 0
		for _, key := range []string{"directory_id", "source_id", "path"} {
			if body[key] != nil {
				chosen++
			}
		}
		message := ""
		if chosen != 1 {
			message = "directory_id、source_id、path 必须且只能提供一个"
		} else if body["display_name"] != nil && body["path"] == nil {
			message = "display_name 只用于从文件夹导入"
		}
		if message != "" {
			return nil, validationError(validationDetail("value_error", []any{"body"}, "Value error, "+message, original, Record{"error": Record{}}))
		}
	}
	return body, nil
}
func jsonRequestError(err error) *Error {
	position := int64(0)
	if syntax, ok := err.(*json.SyntaxError); ok {
		position = max(0, syntax.Offset-1)
	}
	return validationError(validationDetail("json_invalid", []any{"body", position}, "JSON decode error", Record{}, Record{"error": err.Error()}))
}
func queryLimit(r *http.Request, def, max int) (int, error) {
	q := r.URL.Query()
	if !q.Has("limit") {
		return def, nil
	}
	value, issues := (requestField{kind: "int", min: 1, max: max}).validate(q.Get("limit"), []any{"query", "limit"})
	if len(issues) > 0 {
		return 0, validationError(issues...)
	}
	return int(value.(int64)), nil
}
func queryStage(r *http.Request) (string, error) {
	q := r.URL.Query()
	if !q.Has("stage") {
		return "", nil
	}
	value, issues := literalRule("stage", false, false, Stages[:]...).validate(q.Get("stage"), []any{"query", "stage"})
	if len(issues) > 0 {
		return "", validationError(issues...)
	}
	return value.(string), nil
}
