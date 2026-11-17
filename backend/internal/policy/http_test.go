package policy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type memoryRepository struct {
	rows   map[string]map[string]any
	fail   bool
	writes int
}

func (m *memoryRepository) ListSitePolicies(context.Context) ([]map[string]any, error) {
	if m.fail {
		return nil, errors.New("private database")
	}
	rows := []map[string]any{}
	for _, row := range m.rows {
		rows = append(rows, row)
	}
	return rows, nil
}
func (m *memoryRepository) GetSitePolicy(_ context.Context, site string) (map[string]any, error) {
	if m.fail {
		return nil, errors.New("private database")
	}
	return m.rows[site], nil
}
func (m *memoryRepository) PutSitePolicy(_ context.Context, site string, policy map[string]any) (map[string]any, error) {
	if m.fail {
		return nil, errors.New("private database")
	}
	m.writes++
	row := map[string]any{"site": site, "policy": policy, "updated_at": float64(1000)}
	m.rows[site] = row
	return row, nil
}
func (m *memoryRepository) DeleteSitePolicy(_ context.Context, site string) (bool, error) {
	if m.fail {
		return false, errors.New("private database")
	}
	_, exists := m.rows[site]
	delete(m.rows, site)
	return exists, nil
}
func call(h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, policiesPath+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	w.Header().Set("X-Request-ID", "policy-request")
	h.ServeHTTP(w, r)
	return w
}
func payload(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
		t.Fatal(err, w.Body.String())
	}
	return value
}

const validPolicy = `{"max_concurrency":3,"retry_limit":1,"backoff_base_seconds":2.5,"proxy_mode":"direct"}`

func TestPolicyCRUDAndViews(t *testing.T) {
	repo := &memoryRepository{rows: map[string]map[string]any{}}
	h := New(nil, repo)
	w := call(h, "GET", "/danbooru", "")
	if w.Code != 200 || payload(t, w)["inherited"] != true {
		t.Fatal(w.Code, w.Body.String())
	}
	w = call(h, "PUT", "/danbooru?view=policy", validPolicy)
	v := payload(t, w)
	if w.Code != 200 || v["has_override"] != true || v["inherited"] != false || v["editable"] != true || repo.writes != 1 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = call(h, "GET", "?view=policy", "")
	v = payload(t, w)
	if w.Code != 200 || len(v["items"].([]any)) != 5 || v["persistence"] != "sqlite_atomic" {
		t.Fatal(w.Code, w.Body.String())
	}
	w = call(h, "GET", "", "")
	v = payload(t, w)
	if len(v["items"].([]any)) != 1 || v["default"] == nil {
		t.Fatal(w.Body.String())
	}
	w = call(h, "DELETE", "/danbooru?view=policy", "")
	v = payload(t, w)
	if w.Code != 200 || v["deleted"] != true || v["response_profile"] != "policy" {
		t.Fatal(w.Code, w.Body.String())
	}
	w = call(h, "DELETE", "/danbooru", "")
	if w.Code != 404 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = call(h, "GET", "/danbooru?view=policy", "")
	if payload(t, w)["inherited"] != true {
		t.Fatal(w.Body.String())
	}
}

func TestInvalidPolicyNeverWritesOrLeaks(t *testing.T) {
	repo := &memoryRepository{rows: map[string]map[string]any{}}
	h := New(nil, repo)
	invalid := []string{`{}`, `null`, `[]`, `{`, validPolicy + ` {}`, strings.Replace(validPolicy, `"max_concurrency":3`, `"max_concurrency":3.0`, 1), strings.Replace(validPolicy, `"max_concurrency":3`, `"max_concurrency":true`, 1), strings.Replace(validPolicy, `"max_concurrency":3`, `"max_concurrency":0`, 1), strings.Replace(validPolicy, `"retry_limit":1`, `"retry_limit":21`, 1), strings.Replace(validPolicy, `"backoff_base_seconds":2.5`, `"backoff_base_seconds":1e999`, 1), strings.Replace(validPolicy, `"direct"`, `"secret-password"`, 1), strings.TrimSuffix(validPolicy, "}") + `,"secret-password":"token"}`}
	for _, body := range invalid {
		w := call(h, "PUT", "/danbooru", body)
		if w.Code != 422 || strings.Contains(w.Body.String(), "secret-password") || strings.Contains(w.Body.String(), "token") {
			t.Errorf("%s => %d %s", body, w.Code, w.Body.String())
		}
		err := payload(t, w)["error"].(map[string]any)
		if err["request_id"] != "policy-request" {
			t.Fatal(err)
		}
	}
	if repo.writes != 0 {
		t.Fatal("invalid request wrote settings")
	}
	if w := call(h, "PUT", "/danbooru", strings.Repeat(" ", maxRequestBytes+1)); w.Code != 413 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestUnsafeRecordsAndDefaultAreNotProjected(t *testing.T) {
	repo := &memoryRepository{rows: map[string]map[string]any{
		"danbooru":       {"site": "danbooru", "policy": map[string]any{"secret-password": "token"}, "updated_at": -1},
		"unknown-secret": {"site": "unknown-secret", "policy": map[string]any{"credentials": "secret-password"}},
	}}
	h := New(map[string]any{"secret-password": "token"}, repo)
	w := call(h, "GET", "?view=policy", "")
	v := payload(t, w)
	if w.Code != 200 || v["unknown_override_count"] != float64(1) || strings.Contains(w.Body.String(), "secret-password") || strings.Contains(w.Body.String(), "unknown-secret") {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, item := range v["items"].([]any) {
		p := item.(map[string]any)
		if p["editable"] != false || p["policy"] != nil {
			t.Fatal(p)
		}
	}
	if w := call(h, "GET", "", ""); w.Code != 503 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestPolicySiteAndStoreErrors(t *testing.T) {
	repo := &memoryRepository{rows: map[string]map[string]any{}}
	h := New(nil, repo)
	for _, site := range []string{"x", "e-hentai", "unknown"} {
		w := call(h, "PUT", "/"+site, validPolicy)
		if w.Code != 422 || !strings.Contains(w.Body.String(), "unsupported_policy_site") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if w := call(h, "GET", "/DANBOORU", ""); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call(h, "GET", "/danbooru?view=secrets", ""); w.Code != 422 {
		t.Fatal(w.Code, w.Body.String())
	}
	repo.fail = true
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		w := call(h, method, "/danbooru", validPolicy)
		if w.Code != 503 || strings.Contains(w.Body.String(), "private database") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}
