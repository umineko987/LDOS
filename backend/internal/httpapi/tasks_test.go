package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ldos/backend/internal/config"
	"ldos/backend/internal/scheduler"
	"ldos/backend/internal/store"
	"ldos/backend/internal/tasks"
)

type taskTestRunner struct {
	started   chan struct{}
	cancelled chan struct{}
}

func (f taskTestRunner) Run(ctx context.Context, _ string, r scheduler.RunRequest) (scheduler.RunResult, error) {
	if strings.Contains(r.URL, "/blocking") {
		close(f.started)
		<-ctx.Done()
		close(f.cancelled)
		return scheduler.RunResult{}, ctx.Err()
	}
	if err := r.OnLine("stdout", "native task output"); err != nil {
		return scheduler.RunResult{}, err
	}
	exit := 0
	return scheduler.RunResult{ExitCode: &exit}, nil
}

type taskTestPool struct{}

func (taskTestPool) Acquire(context.Context, scheduler.ProxyRequest) (*scheduler.Lease, error) {
	return nil, errors.New("direct tasks must not acquire a proxy")
}
func (taskTestPool) Release(context.Context, string, bool, string) error { return nil }

func TestTaskHTTPLifecycle(t *testing.T) {
	root := t.TempDir()
	db, err := store.Open(filepath.Join(root, "backend.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	runner := taskTestRunner{make(chan struct{}), make(chan struct{})}
	settings := scheduler.DefaultSettings()
	settings.PollInterval = 5 * time.Millisecond
	control, err := scheduler.New(db, scheduler.Dependencies{Runner: runner, Proxy: taskTestPool{}, ValidateCredentials: func(context.Context, string, string) (bool, error) { return true, nil }}, settings)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := control.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	var resolutions atomic.Int32
	service, err := tasks.New(db, tasks.Dependencies{
		Control: control,
		Resolve: func(context.Context, string) (tasks.SiteInfo, error) {
			resolutions.Add(1)
			return tasks.SiteInfo{Site: "example.org"}, nil
		},
		Credentials:  func(context.Context, string) (tasks.Credentials, error) { return tasks.Credentials{}, nil },
		ValidateArgs: func(args []string) ([]string, error) { return args, nil },
		LookupIP:     func(context.Context, string) ([]string, error) { return []string{"8.8.8.8"}, nil },
	}, tasks.Config{RuntimeDir: root, ProjectDir: root, OutputRoot: filepath.Join(root, "downloads"), AllowedOutputRoots: []string{root}, StrictTargetDNS: true, DefaultPolicy: map[string]any{"proxy_mode": "direct"}})
	if err != nil {
		t.Fatal(err)
	}
	unused := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })
	handler := New(config.Settings{Server: config.Server{Host: "127.0.0.1", Port: 19091, CORSOrigins: []string{"mygo://localhost"}}}, db, unused, unused, unused, unused, WithTasks(service))
	post := func(path, body, key, origin string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("POST", "http://127.0.0.1:19091"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Request-ID", "task-lifecycle-test")
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	decode := func(w *httptest.ResponseRecorder, code int) map[string]any {
		t.Helper()
		if w.Code != code {
			t.Fatalf("HTTP %d, want %d: %s", w.Code, code, w.Body.String())
		}
		var row map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &row); err != nil {
			t.Fatal(err)
		}
		return row
	}
	body := `{"url":"https://example.org/file"}`
	if w := post("/api/v1/tasks", body, "", "https://evil.example"); w.Code != 403 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, invalid := range []string{`{}`, `null`, body + `{}`, `{"url":"https://example.org/file","priority":null}`, `{"url":"https://example.org/file","_policy_override":{}}`} {
		w := post("/api/v1/tasks", invalid, "", "mygo://localhost")
		row := decode(w, 422)
		detail := row["error"].(map[string]any)
		if detail["code"] != "validation_error" || detail["request_id"] != "task-lifecycle-test" {
			t.Fatal(row)
		}
	}
	if w := post("/api/v1/tasks", strings.Repeat("x", 1024*1024+1), "", "mygo://localhost"); w.Code != 413 {
		t.Fatal(w.Code)
	}
	row := decode(post("/api/v1/tasks", body, "once", "mygo://localhost"), 202)
	id := row["id"].(string)
	if row["status"] != "queued" {
		t.Fatal(row)
	}
	again := decode(post("/api/v1/tasks", body, "once", "mygo://localhost"), 200)
	if again["id"] != id || resolutions.Load() != 1 {
		t.Fatal(again, resolutions.Load())
	}
	path := "/api/v1/tasks/" + id
	if w := post(path+"/retry", `{}`, "", ""); w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, invalid := range []string{`null`, `{"additional_attempts":null}`, `{"additional_attempts":0}`, `{"additional_attempts":21}`} {
		if w := post(path+"/retry", invalid, "", ""); w.Code != 422 {
			t.Fatal(invalid, w.Code, w.Body.String())
		}
	}
	cancelled := decode(post(path+"/cancel", ``, "", ""), 200)
	if cancelled["status"] != "cancelled" {
		t.Fatal(cancelled)
	}
	decode(post(path+"/retry", `{"additional_attempts":2}`, "", ""), 202)
	if err := control.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitStatus := func(id, status string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			row, err := db.GetTask(context.Background(), id)
			if err != nil {
				t.Fatal(err)
			}
			if row["status"] == status {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("wanted %s, got %#v", status, row)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	waitStatus(id, "succeeded")
	blocking := decode(post("/api/v1/tasks", `{"url":"https://example.org/blocking"}`, "", ""), 202)
	blockID := blocking["id"].(string)
	select {
	case <-runner.started:
	case <-time.After(5 * time.Second):
		t.Fatal("runner did not start")
	}
	decode(post("/api/v1/tasks/"+blockID+"/cancel", ``, "", ""), 200)
	select {
	case <-runner.cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("runner context not cancelled")
	}
	waitStatus(blockID, "cancelled")
	decode(post("/api/v1/tasks/missing/cancel", ``, "", ""), 404)
	decode(post("/api/v1/tasks/missing/retry", `{}`, "", ""), 404)
}
