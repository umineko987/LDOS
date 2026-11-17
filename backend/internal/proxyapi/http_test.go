package proxyapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/proxysources"
)

type fakeBackend struct {
	calls        []string
	target, node string
	force        bool
	err          error
	status       map[string]any
}

func (b *fakeBackend) Start(_ context.Context, target string) (map[string]any, error) {
	b.calls = append(b.calls, "start")
	b.target = target
	return map[string]any{"running": true}, b.err
}
func (b *fakeBackend) Reload(_ context.Context, target string) (map[string]any, error) {
	b.calls = append(b.calls, "reload")
	b.target = target
	return map[string]any{"running": true}, b.err
}
func (b *fakeBackend) Stop(_ context.Context, force bool) (map[string]any, error) {
	b.calls = append(b.calls, "stop")
	b.force = force
	return map[string]any{"running": false}, b.err
}
func (b *fakeBackend) Probe(_ context.Context, target, node string) (proxypool.ProbeResult, error) {
	b.calls = append(b.calls, "probe")
	b.target, b.node = target, node
	return proxypool.ProbeResult{Total: 1, Healthy: 1, Target: target, Results: []proxypool.ProbeNode{{ID: node, Healthy: true}}}, b.err
}
func (b *fakeBackend) Status() map[string]any        { return b.status }
func (b *fakeBackend) ActiveRevision() *string       { return nil }
func (b *fakeBackend) HealthSummary() map[string]any { return map[string]any{"running": true} }

func request(t *testing.T, h http.Handler, method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	r := httptest.NewRequest(method, "/api/v1/proxy/"+path, strings.NewReader(body))
	r.Header.Set("X-Request-ID", "untrusted")
	w := httptest.NewRecorder()
	w.Header().Set("X-Request-ID", "trusted")
	h.ServeHTTP(w, r)
	var result map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err, w.Body.String())
	}
	return w, result
}
func checkCode(t *testing.T, w *httptest.ResponseRecorder, result map[string]any, status int, code string) {
	t.Helper()
	e, _ := result["error"].(map[string]any)
	if w.Code != status || e["code"] != code || e["request_id"] != "trusted" {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if _, ok := e["details"]; !ok {
		t.Fatal("missing details")
	}
}
func TestLifecycleProbeAndErrors(t *testing.T) {
	b := &fakeBackend{}
	var validations, sites int
	h := New(b, nil, func(_ context.Context, target string) error {
		validations++
		if target == "https://private" {
			return errors.New("private target")
		}
		return nil
	}, func(_ context.Context, site string) (string, error) {
		sites++
		if site != "pixiv" {
			t.Fatal(site)
		}
		return "https://site.example/probe", nil
	})
	for _, route := range []string{"start", "reload"} {
		w, _ := request(t, h, "POST", route, `{"probe_url":" HTTPS://private ","force_refresh":false,"ignored":1}`)
		if w.Code != 200 || b.target != "HTTPS://private" || validations != 0 {
			t.Fatal(w.Body.String(), b.target, validations)
		}
	}
	w, result := request(t, h, "POST", "stop?view=desktop", `{"force":"yes"}`)
	if w.Code != 200 || !b.force || len(result) != 1 || result["response_profile"] != "desktop-proxy-operation-v1" {
		t.Fatal(w.Body.String())
	}
	w, result = request(t, h, "POST", "probe", `{"site":" PIXIV ","node_id":"node"}`)
	if w.Code != 200 || sites != 1 || validations != 1 || b.target != "https://site.example/probe" || b.node != "node" || result["total"] != float64(1) {
		t.Fatal(w.Body.String())
	}
	w, _ = request(t, h, "POST", "probe?view=desktop", `{"site":"ignored","target_url":"https://explicit"}`)
	if w.Code != 200 || sites != 1 || validations != 2 {
		t.Fatal(w.Body.String())
	}
	before := len(b.calls)
	w, result = request(t, h, "POST", "probe", `{"target_url":"https://private"}`)
	checkCode(t, w, result, 422, "invalid_probe_target")
	w, result = request(t, h, "POST", "probe", `{"site":"unknown"}`)
	checkCode(t, w, result, 422, "invalid_site")
	if len(b.calls) != before {
		t.Fatal("invalid probe reached backend")
	}
	for _, route := range []string{"start", "reload", "stop", "probe"} {
		b.err = fmt.Errorf("wrapped: %w", proxypool.ErrConflict)
		w, result = request(t, h, "POST", route+"?view=desktop", `{}`)
		checkCode(t, w, result, 409, "proxy_conflict")
		b.err = errors.New("failed https://user:secret@example.test/?token=hidden")
		w, result = request(t, h, "POST", route, `{}`)
		checkCode(t, w, result, 503, "proxy_error")
		if strings.Contains(w.Body.String(), "secret") || strings.Contains(w.Body.String(), "hidden") {
			t.Fatal(w.Body.String())
		}
	}
}
func TestSourceCRUD(t *testing.T) {
	dir := t.TempDir()
	store, err := proxysources.New(proxysources.Settings{AllowedNodeRoots: []string{dir}}, filepath.Join(dir, "runtime"), dir)
	if err != nil {
		t.Fatal(err)
	}
	h := New(&fakeBackend{}, store, nil, nil)
	w, result := request(t, h, "POST", "sources/subscriptions", `{"url":"https://user:secret@example.test/sub?token=hidden"}`)
	if w.Code != 200 || strings.Contains(w.Body.String(), "hidden") || strings.Contains(w.Body.String(), "secret") {
		t.Fatal(w.Body.String())
	}
	id := result["subscriptions"].([]any)[0].(map[string]any)["id"].(string)
	w, result = request(t, h, "PUT", "sources/subscriptions/"+id+"?view=desktop", `{"url":"https://example.test/replaced"}`)
	if w.Code != 200 || len(result) != 1 {
		t.Fatal(w.Body.String())
	}
	_, result = request(t, h, "GET", "sources", "")
	id = result["subscriptions"].([]any)[0].(map[string]any)["id"].(string)
	w, _ = request(t, h, "DELETE", "sources/subscriptions/"+id, "")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w, result = request(t, h, "POST", "sources/inline-nodes", `{"nodes":["http://user:secret@127.0.0.1:8080"]}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	id = result["inline_nodes"].([]any)[0].(map[string]any)["id"].(string)
	w, _ = request(t, h, "PUT", "sources/inline-nodes/"+id, `{"node":"http://127.0.0.1:8081"}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	_, result = request(t, h, "GET", "sources?view=desktop", "")
	id = result["inline_nodes"].([]any)[0].(map[string]any)["id"].(string)
	if result["response_profile"] != "desktop-proxy-sources-v1" {
		t.Fatal(result)
	}
	w, _ = request(t, h, "DELETE", "sources/inline-nodes/"+id, "")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	file := filepath.Join(dir, "nodes.txt")
	if err := os.WriteFile(file, []byte("http://127.0.0.1:8082\n"), 0600); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"path": file})
	w, _ = request(t, h, "PUT", "sources/node-file", string(body))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for _, route := range []string{"sources/node-file", "sources/override"} {
		w, result = request(t, h, "DELETE", route+"?view=desktop", "")
		if w.Code != 200 || len(result) != 1 {
			t.Fatal(w.Body.String())
		}
	}
	w, result = request(t, h, "DELETE", "sources/subscriptions/sub_"+strings.Repeat("0", 64), "")
	checkCode(t, w, result, 404, "proxy_source_not_found")
	w, result = request(t, h, "DELETE", "sources/subscriptions/bad", "")
	checkCode(t, w, result, 422, "invalid_proxy_source_id")
	w, result = request(t, h, "POST", "sources/subscriptions", `{"url":"ftp://example.test"}`)
	checkCode(t, w, result, 422, "invalid_proxy_subscription")
	w, result = request(t, h, "PUT", "sources/node-file", `{"path":"/not-allowed"}`)
	checkCode(t, w, result, 422, "proxy_source_path_forbidden")
}
func TestValidationAndRouting(t *testing.T) {
	b := &fakeBackend{}
	h := New(b, nil, nil, nil)
	for _, tc := range []struct{ route, body string }{
		{"start", ""}, {"start", "null"}, {"start", "[]"}, {"start", "{} {}"}, {"start", `{"probe_url":12}`}, {"start", `{"probe_url":"http://bad"}`}, {"start", `{"force_refresh":null}`}, {"stop", `{"force":"perhaps"}`}, {"probe", `{"node_id":3}`}, {"probe", `{"target_url":"http://bad"}`}, {"probe", `{"site":[]}`},
		{"sources/subscriptions", `{"url":"https://example.test","secret":"never-echo"}`}, {"sources/subscriptions", `{"url":null}`}, {"sources/inline-nodes", `{"nodes":[]}`}, {"sources/inline-nodes", `{"nodes":[null]}`}, {"sources/inline-nodes", `{"nodes":[" "]}`},
	} {
		w, result := request(t, h, "POST", tc.route, tc.body)
		checkCode(t, w, result, 422, "validation_error")
		if strings.Contains(w.Body.String(), "never-echo") {
			t.Fatal(w.Body.String())
		}
	}
	if len(b.calls) != 0 {
		t.Fatal(b.calls)
	}
	w, result := request(t, h, "GET", "status?view=wrong", "")
	checkCode(t, w, result, 422, "validation_error")
	w, result = request(t, h, "GET", "missing", "")
	checkCode(t, w, result, 404, "not_found")
	w, result = request(t, h, "POST", "status", `{}`)
	checkCode(t, w, result, 405, "method_not_allowed")
	if w.Header().Get("Allow") != "GET" {
		t.Fatal(w.Header())
	}
	for _, length := range []int64{-1, 1, proxysources.MaxSourceRequestBytes + 1} {
		r := httptest.NewRequest("POST", "/api/v1/proxy/sources/inline-nodes", strings.NewReader(strings.Repeat(" ", proxysources.MaxSourceRequestBytes+1)))
		r.ContentLength = length
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 413 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}
func TestStatusProfilesAndProjectionLimits(t *testing.T) {
	node := map[string]any{"id": strings.Repeat("界", 140), "name": "password=hidden", "endpoint": "http://user:secret@host", "tags": make([]string, 20), "healthy": true, "retry_eligible": false, "last_error": strings.Repeat("界", 400), "private": "never-echo"}
	nodes := make([]map[string]any, 501)
	for i := range nodes {
		nodes[i] = node
	}
	b := &fakeBackend{status: map[string]any{"nodes": nodes, "private": "legacy-only", "sources": map[string]any{"warnings": make([]string, 21)}, "transport_core": map[string]any{"private": "never-echo"}}}
	h := New(b, nil, nil, nil)
	_, legacy := request(t, h, "GET", "status", "")
	if legacy["health_loop"] == nil || legacy["private"] != "legacy-only" {
		t.Fatal(legacy)
	}
	if _, ok := b.status["health_loop"]; ok {
		t.Fatal("mutated pool status")
	}
	w, result := request(t, h, "GET", "status?view=desktop", "")
	if strings.Contains(w.Body.String(), "hidden") || strings.Contains(w.Body.String(), "secret") || strings.Contains(w.Body.String(), "never-echo") || result["health_loop"] != nil || result["private"] != nil {
		t.Fatal("projection leaked")
	}
	projected := result["nodes"].([]any)
	row := projected[0].(map[string]any)
	if len(projected) != 500 || result["node_rows_total"] != float64(501) || result["node_rows_truncated"] != true || utf8.RuneCountInString(row["id"].(string)) != 128 || utf8.RuneCountInString(row["last_error"].(string)) != 300 || len(row["tags"].([]any)) != 16 {
		t.Fatal("projection bounds")
	}
	if len(result["sources"].(map[string]any)["warnings"].([]any)) != 20 {
		t.Fatal("warnings bound")
	}
	subs := make([]map[string]any, 129)
	inlines := make([]map[string]any, 513)
	for i := range subs {
		subs[i] = map[string]any{"url": "never-echo", "host": strings.Repeat("x", 260)}
	}
	for i := range inlines {
		inlines[i] = map[string]any{"node": "never-echo"}
	}
	sources := desktopSources(map[string]any{"subscriptions": subs, "inline_nodes": inlines})
	encoded, _ := json.Marshal(sources)
	if strings.Contains(string(encoded), "never-echo") || len(sources["subscriptions"].([]map[string]any)) != 128 || len(sources["inline_nodes"].([]map[string]any)) != 512 || sources["subscription_rows_truncated"] != true || sources["inline_node_rows_truncated"] != true {
		t.Fatal("source projection bounds")
	}
}
func TestWrappedSourceErrors(t *testing.T) {
	for _, tc := range []struct {
		category string
		status   int
	}{{"not_found", 404}, {"path_forbidden", 422}, {"validation", 422}, {"corrupt", 409}, {"conflict", 409}, {"store_error", 503}} {
		w := httptest.NewRecorder()
		w.Header().Set("X-Request-ID", "trusted")
		sourceError(w, fmt.Errorf("wrapped: %w", &proxysources.Error{Category: tc.category, Code: "original", Message: "original message", Reason: "reason", Details: map[string]any{"reason": "reason"}}))
		var result map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &result)
		checkCode(t, w, result, tc.status, "original")
	}
}
