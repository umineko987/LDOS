package datasets

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestRequestValidationReportsAllFieldErrors(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/v1/datasets", strings.NewReader(`{"name":" ","kind":"bad","config":[],"unknown":true}`))
	_, err := decodeRequest(r, datasetSchema(true))
	var public *Error
	if !errors.As(err, &public) || public.Status != 422 || public.Code != "validation_error" {
		t.Fatal(err)
	}
	issues := public.Details.([]Record)
	if len(issues) != 4 {
		t.Fatal(issues)
	}
	for i, want := range []struct{ kind, field string }{{"value_error", "name"}, {"literal_error", "kind"}, {"dict_type", "config"}, {"extra_forbidden", "unknown"}} {
		if issues[i]["type"] != want.kind || !reflect.DeepEqual(issues[i]["loc"], []any{"body", want.field}) {
			t.Fatal(issues[i])
		}
		if _, ok := issues[i]["input"]; !ok {
			t.Fatal("missing original input", issues[i])
		}
	}
	if issues[1]["msg"] != "Input should be 'character', 'style' or 'concept'" {
		t.Fatal(issues[1])
	}
}
func TestRequestValidationNestedListsNullsAndCoercions(t *testing.T) {
	for _, tc := range []struct {
		body, kind string
		loc        []any
		schema     requestSchema
	}{
		{`{}`, "missing", []any{"body", "stage"}, decisionsSchema()},
		{`{"stage":"tag","asset_ids":["ok",0,""],"decision":"exclude"}`, "string_type", []any{"body", "asset_ids", 1}, decisionsSchema()},
		{`{"stage":"tag","asset_ids":[],"decision":"exclude"}`, "too_short", []any{"body", "asset_ids"}, decisionsSchema()},
		{`{"target_path":"/tmp","repeats":0}`, "greater_than_equal", []any{"body", "repeats"}, exportSchema()},
		{`{"target_path":"/tmp","repeats":1.1}`, "int_from_float", []any{"body", "repeats"}, exportSchema()},
		{`{"target_path":"/tmp","repeats":"1e1"}`, "int_parsing", []any{"body", "repeats"}, exportSchema()},
		{`{"target_path":"/tmp","dry_run":null}`, "bool_type", []any{"body", "dry_run"}, exportSchema()},
		{`{"path":"/tmp","source_id":"source"}`, "value_error", []any{"body"}, rootsSchema()},
		{`null`, "missing", []any{"body"}, datasetSchema(true)},
	} {
		_, err := decodeRequest(httptest.NewRequest("POST", "/", strings.NewReader(tc.body)), tc.schema)
		var public *Error
		if !errors.As(err, &public) {
			t.Fatalf("%s: %v", tc.body, err)
		}
		issues := public.Details.([]Record)
		if len(issues) == 0 || issues[0]["type"] != tc.kind || !reflect.DeepEqual(issues[0]["loc"], tc.loc) {
			t.Fatal(tc.body, issues)
		}
	}
	row, err := decodeRequest(httptest.NewRequest("POST", "/", strings.NewReader(`{"target_path":"/tmp","repeats":"12.0","dry_run":"YES","pin_trigger":0.0,"folder_name":null}`)), exportSchema())
	if err != nil || row["repeats"] != int64(12) || row["dry_run"] != true || row["pin_trigger"] != false || row["folder_name"] != nil {
		t.Fatal(row, err)
	}
	row, err = decodeRequest(httptest.NewRequest("PATCH", "/", strings.NewReader(`{"name":null,"kind":null,"config":null,"cover_asset_id":null}`)), datasetSchema(false))
	if err != nil || len(row) != 4 {
		t.Fatal(row, err)
	}
}
func TestValidationDoesNotRoundConfigurationIntegers(t *testing.T) {
	row, err := decodeRequest(httptest.NewRequest("POST", "/", strings.NewReader(`{"name":" name ","config":{"large":9007199254740993}}`)), datasetSchema(true))
	if err != nil || row["name"] != "name" {
		t.Fatal(row, err)
	}
	if row["config"].(map[string]any)["large"] != json.Number("9007199254740993") {
		t.Fatal(row)
	}
}
