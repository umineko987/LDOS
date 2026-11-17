package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ldos/backend/internal/config"
)

type testStore struct {
	root          string
	fail          bool
	status, site  string
	limit, offset int
}

func (s *testStore) Ping(context.Context) error {
	if s.fail {
		return errors.New("private database path")
	}
	return nil
}
func (s *testStore) ListTasks(_ context.Context, status, site string, limit, offset int) ([]map[string]any, error) {
	s.status, s.site, s.limit, s.offset = status, site, limit, offset
	return []map[string]any{{"id": "task-1", "cancel_requested": false}}, s.Ping(context.Background())
}
func (s *testStore) GetTask(_ context.Context, id string) (map[string]any, error) {
	if s.fail {
		return nil, s.Ping(context.Background())
	}
	if id != "task-1" {
		return nil, nil
	}
	return map[string]any{"id": id, "output_dir": s.root, "latest_attempt": nil, "lease": nil}, nil
}
func (*testStore) GetLogs(context.Context, string, int64, *int, int) ([]map[string]any, error) {
	return []map[string]any{}, nil
}
func (*testStore) GetEvents(context.Context, string, int64, int) ([]map[string]any, error) {
	return []map[string]any{}, nil
}

func testHandler(s *testStore) http.Handler {
	unused := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	return New(config.Settings{Server: config.Server{Host: "127.0.0.1", Port: 19091, CORSOrigins: []string{"mygo://localhost", "http://localhost:1420"}}}, s, unused, unused, unused, unused)
}
func request(h http.Handler, method, path string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:19091"+path, nil)
	for k, v := range headers {
		if k == "Host" {
			r.Host = v
		} else {
			r.Header.Set(k, v)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestOriginGuardContract(t *testing.T) {
	h := testHandler(&testStore{})
	for _, host := range []string{"127.0.0.1:19091", "localhost:19091", "[::1]:19091", "localhost.:19091", " LOCALHOST.:19091 "} {
		w := request(h, "GET", "/healthz", map[string]string{"Host": host})
		if w.Code != 200 {
			t.Errorf("%s: %d %s", host, w.Code, w.Body.String())
		}
	}
	for _, host := range []string{"evil.example.com:19091", "192.168.1.5:19091", "127.0.0.1", "127.0.0.1:19092", ""} {
		w := request(h, "POST", "/api/v1/tasks", map[string]string{"Host": host, "X-Request-ID": "known-id"})
		if w.Code != 403 || !strings.Contains(w.Body.String(), `"code":"forbidden_host"`) || w.Header().Get("X-Request-ID") != "known-id" {
			t.Fatal(w.Code, w.Body.String())
		}
		if host != "" && strings.Contains(w.Body.String(), host) {
			t.Fatal("host leaked")
		}
	}
	for _, headers := range []map[string]string{{"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}, {"Origin": "http://evil.example.com"}, {"Origin": "null"}, {"Origin": "mygo://localhost/path"}} {
		w := request(h, "GET", "/api/v1/events", headers)
		if w.Code != 403 || !strings.Contains(w.Body.String(), "forbidden_cross_site") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := request(h, "GET", "/healthz", map[string]string{"Origin": "mygo://localhost", "Sec-Fetch-Site": "cross-site"})
	if w.Code != 200 || w.Header().Get("Access-Control-Allow-Origin") != "mygo://localhost" || len(w.Header().Get("X-Request-ID")) != 32 {
		t.Fatal(w.Code, w.Header())
	}
}

func TestPreflight(t *testing.T) {
	h := testHandler(&testStore{})
	headers := map[string]string{"Origin": "mygo://localhost", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "Content-Type, X-Request-ID"}
	if w := request(h, "OPTIONS", "/api/v1/settings/downloads", headers); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	headers["Access-Control-Request-Headers"] = "Authorization"
	if w := request(h, "OPTIONS", "/api/v1/settings/downloads", headers); w.Code != 400 {
		t.Fatal(w.Code)
	}
	headers["Access-Control-Request-Headers"] = "Content-Type"
	headers["Access-Control-Request-Method"] = "CONNECT"
	if w := request(h, "OPTIONS", "/", headers); w.Code != 400 {
		t.Fatal(w.Code)
	}
}

func TestTaskQueriesAndErrors(t *testing.T) {
	s := &testStore{}
	h := testHandler(s)
	w := request(h, "GET", "/api/v1/tasks?site=exhentai&status=queued&limit=1&limit=2&offset=3", nil)
	if w.Code != 200 || s.site != "exhentai" || s.status != "queued" || s.limit != 2 || s.offset != 3 {
		t.Fatal(w.Body.String(), s)
	}
	for _, query := range []string{"limit=0", "limit=501", "limit=", "limit=abc", "offset=-1"} {
		w := request(h, "GET", "/api/v1/tasks?"+query, nil)
		if w.Code != 422 || !strings.Contains(w.Body.String(), "validation_error") {
			t.Fatal(query, w.Code, w.Body.String())
		}
	}
	for _, path := range []string{"/api/v1/tasks/missing", "/api/v1/tasks/missing/events", "/api/v1/tasks/missing/logs"} {
		if w := request(h, "GET", path, nil); w.Code != 404 || !strings.Contains(w.Body.String(), "task_not_found") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w = request(h, "GET", "/api/v1/tasks/task-1", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"latest_attempt":null`) {
		t.Fatal(w.Body.String())
	}
	s.fail = true
	w = request(h, "GET", "/api/v1/tasks", nil)
	if w.Code != 503 || strings.Contains(w.Body.String(), "private database") {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(h, "GET", "/healthz", nil); w.Code != 503 {
		t.Fatal(w.Code)
	}
}

func TestFilesDoNotEscapeRoot(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "image.png"), []byte("image-bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked-dir")); err != nil {
		t.Fatal(err)
	}
	h := testHandler(&testStore{root: root})
	w := request(h, "GET", "/api/v1/tasks/task-1/files", nil)
	var listing struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if len(listing.Items) != 1 || listing.Items[0]["path"] != "image.png" {
		t.Fatal(w.Body.String())
	}
	w = request(h, "GET", "/api/v1/tasks/task-1/files/image.png", nil)
	if w.Code != 200 || w.Body.String() != "image-bytes" || w.Header().Get("Cross-Origin-Resource-Policy") != "cross-origin" {
		t.Fatal(w.Code, w.Header(), w.Body.String())
	}
	w = request(h, "GET", "/api/v1/tasks/task-1/files/image.png", map[string]string{"Range": "bytes=0-4"})
	if w.Code != 206 || w.Body.String() != "image" {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, relative := range []string{"link", "linked-dir/secret", "%2e%2e/secret", "%2fetc/passwd"} {
		w := request(h, "GET", "/api/v1/tasks/task-1/files/"+relative, nil)
		if w.Code != 404 {
			t.Fatal(relative, w.Code, w.Body.String())
		}
	}
}

func TestCompatibleServiceIdentity(t *testing.T) {
	h := testHandler(&testStore{})
	w := request(h, "GET", "/", nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"service":"gallery-dl-backend"`) {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestUnconfiguredServicesAndUnknownRoutes(t *testing.T) {
	h := testHandler(&testStore{})
	if w := request(h, "GET", "/readyz", nil); w.Code != 503 || !strings.Contains(w.Body.String(), "services_not_configured") {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(h, "POST", "/api/v1/unknown", nil); w.Code != 404 || !strings.Contains(w.Body.String(), "route_not_found") {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestNativeDiagnosticsAndEmbeddedContract(t *testing.T) {
	settings := config.Settings{Server: config.Server{Host: "127.0.0.1", Port: 19091}, Auth: config.Auth{AuthorizationProxy: "http://user:secret@127.0.0.1:9999"}}
	unused := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	healthy := true
	h := New(settings, &testStore{}, unused, unused, unused, unused, WithDiagnostics(RuntimeDiagnostics{
		Ready: func(context.Context) map[string]any { return map[string]any{"ready": healthy} }, Settings: func() config.Settings { return settings },
		Tasks: func() map[string]any { return map[string]any{"running": true} }, Crawls: func() map[string]any { return map[string]any{"running": true} },
	}))
	if w := request(h, "GET", "/readyz", nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	healthy = false
	if w := request(h, "GET", "/readyz", nil); w.Code != 503 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, path := range []string{"/api/v1/config?view=diagnostics", "/api/v1/scheduler/status?view=diagnostics"} {
		if w := request(h, "GET", path, nil); w.Code != 200 || strings.Contains(w.Body.String(), "secret@") {
			t.Fatal(path, w.Code, w.Body.String())
		}
	}
	if w := request(h, "GET", "/api/v1/config?view=unknown", nil); w.Code != 422 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, path := range []string{"/docs", "/redoc", "/openapi.json"} {
		if w := request(h, "GET", path, nil); w.Code != 200 || !strings.Contains(w.Body.String(), "/api/v1/datasets") {
			t.Fatal(path, w.Code)
		}
	}
	if len(ContractRoutes()) < 124 {
		t.Fatal("API contract is missing endpoints")
	}
}
