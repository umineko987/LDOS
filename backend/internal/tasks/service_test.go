package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ldos/backend/internal/store"
)

type taskTestControl struct {
	notifications int
}

func (c *taskTestControl) Notify() { c.notifications++ }
func (*taskTestControl) Cancel(context.Context, string) (map[string]any, error) {
	return nil, errors.New("unexpected Cancel")
}
func (*taskTestControl) Retry(context.Context, string, int) (map[string]any, error) {
	return nil, errors.New("unexpected Retry")
}
func (*taskTestControl) Summary() map[string]any { return map[string]any{} }

type taskTestDeps struct {
	control         taskTestControl
	resolveCalls    int
	lookupCalls     int
	credentialSites []string
	validatedArgs   [][]string
	managed         Credentials
}

func newTaskTestService(t *testing.T) (*Service, *store.Store, *taskTestDeps) {
	t.Helper()
	root := t.TempDir()
	db, err := store.Open(filepath.Join(root, "test.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close temporary store: %v", err)
		}
	})
	project := filepath.Join(root, "project")
	credentialRoot := filepath.Join(project, "credentials")
	fake := &taskTestDeps{managed: Credentials{
		Reference:   "managed-twitter",
		CookiesFile: writeTaskTestFile(t, filepath.Join(credentialRoot, "managed.cookies")),
		ConfigFile:  writeTaskTestFile(t, filepath.Join(credentialRoot, "managed.json")),
	}}
	runtime := filepath.Join(root, "runtime")
	output := filepath.Join(runtime, "downloads")
	service, err := New(db, Dependencies{
		Resolve: func(_ context.Context, _ string) (SiteInfo, error) {
			fake.resolveCalls++
			return SiteInfo{Site: "twitter", Subcategory: "tweet", Extractor: "twitter:tweet", Supported: true}, nil
		},
		Credentials: func(_ context.Context, site string) (Credentials, error) {
			fake.credentialSites = append(fake.credentialSites, site)
			return fake.managed, nil
		},
		LookupIP: func(_ context.Context, _ string) ([]string, error) {
			fake.lookupCalls++
			return []string{"8.8.8.8"}, nil
		},
		ValidateArgs: func(args []string) ([]string, error) {
			fake.validatedArgs = append(fake.validatedArgs, append([]string{}, args...))
			for _, arg := range args {
				if arg == "--exec" {
					return nil, errors.New("forbidden extraArgs: --exec")
				}
			}
			return args, nil
		},
		Control: &fake.control,
	}, Config{
		RuntimeDir: runtime, ProjectDir: project, OutputRoot: output,
		AllowedOutputRoots: []string{output},
		AllowedCookieRoots: []string{credentialRoot},
		AllowedConfigRoots: []string{credentialRoot},
		StrictTargetDNS:    true,
		DefaultPolicy: map[string]any{
			"max_concurrency": 2, "retry_limit": 2,
			"backoff_base_seconds": 2, "proxy_mode": "prefer",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return service, db, fake
}

func writeTaskTestFile(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("test-only credential"), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func assertTaskJSON(t *testing.T, got, want any) {
	t.Helper()
	actual, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if string(actual) != string(expected) {
		t.Errorf("got %s, want %s", actual, expected)
	}
}

func TestEnqueueCreatesAndDeduplicates(t *testing.T) {
	service, db, fake := newTaskTestService(t)
	ctx := context.Background()
	site, key := " X ", " request-key "
	body := Create{URL: " https://gallery.example/item ", Site: &site, Priority: 7, ExtraArgs: []string{"--verbose"}}
	row, created, err := service.Enqueue(ctx, body, &key)
	if err != nil || !created {
		t.Fatalf("first Enqueue: created=%v err=%v", created, err)
	}
	id, ok := row["id"].(string)
	if !ok || id == "" {
		t.Fatalf("missing task ID: %#v", row)
	}
	for field, want := range map[string]any{
		"url": "https://gallery.example/item", "site": "twitter",
		"status": "queued", "priority": 7, "max_attempts": 3,
		"subcategory": "tweet", "extractor": "twitter:tweet",
		"proxy_mode": "prefer", "extra_args": []string{"--verbose"},
		"output_dir":      filepath.Join(service.config.OutputRoot, id),
		"credentials_ref": fake.managed.Reference,
		"cookies_file":    fake.managed.CookiesFile, "config_file": fake.managed.ConfigFile,
	} {
		t.Run(field, func(t *testing.T) { assertTaskJSON(t, row[field], want) })
	}
	if info, err := os.Stat(row["output_dir"].(string)); err != nil || !info.IsDir() {
		t.Fatalf("output directory was not created: %v", err)
	}
	key = "request-key"
	duplicate, created, err := service.Enqueue(ctx, Create{URL: "https://different.example/item", Priority: 99}, &key)
	if err != nil || created || duplicate["id"] != id {
		t.Fatalf("duplicate Enqueue: row=%#v created=%v err=%v", duplicate, created, err)
	}
	if duplicate["url"] != row["url"] {
		t.Fatalf("duplicate overwrote original URL: %#v", duplicate)
	}
	if fake.resolveCalls != 1 || fake.lookupCalls != 0 || len(fake.credentialSites) != 1 || len(fake.validatedArgs) != 1 || fake.control.notifications != 1 {
		t.Fatalf("idempotency must skip all dependencies on repeat: %+v", fake)
	}
	if !reflect.DeepEqual(fake.credentialSites, []string{"twitter"}) {
		t.Fatalf("credentials did not receive canonical site: %v", fake.credentialSites)
	}
	rows, err := db.ListTasks(ctx, "", "", 10, 0)
	if err != nil || len(rows) != 1 || rows[0]["id"] != id {
		t.Fatalf("stored tasks: %#v, err=%v", rows, err)
	}
}

func TestEnqueueFreezesOnlyEditablePolicyFields(t *testing.T) {
	service, db, fake := newTaskTestService(t)
	ctx := context.Background()
	legacyPolicy := map[string]any{
		"max_concurrency": 3, "retry_limit": 4,
		"backoff_base_seconds": 1.25, "proxy_mode": "required",
		"probe_url": "https://old.example/probe", "probe_before_use": false,
		"node_tags": []string{"legacy"}, "http_timeout": 999,
		"gallery_retries": 49, "task_timeout_seconds": 99,
		"download_stall_timeout_seconds": 11,
		"eh_download":                    map[string]any{"image_mode": "resample", "gp_policy": "resized"},
		"extra_args":                     []string{"--exec", "legacy-command"},
		"proxy_probe_scope":              "legacy-scope", "allowed_proxy_ids": []string{"legacy-node"},
	}
	if _, err := db.PutSitePolicy(ctx, "twitter", legacyPolicy); err != nil {
		t.Fatal(err)
	}
	row, created, err := service.Enqueue(ctx, Create{URL: "https://gallery.example/item"}, nil)
	if err != nil || !created {
		t.Fatalf("Enqueue with old advanced fields: created=%v err=%v", created, err)
	}
	want := map[string]any{
		"max_concurrency": 3, "retry_limit": 4,
		"backoff_base_seconds": 1.25, "proxy_mode": "required",
		"probe_url": nil, "probe_before_use": true, "node_tags": []string{},
		"http_timeout": 60, "gallery_retries": 2, "task_timeout_seconds": 7200,
		"download_stall_timeout_seconds": 300, "eh_download": nil,
		"extra_args": []string{}, "proxy_probe_scope": nil,
	}
	assertTaskJSON(t, row["policy"], want)
	assertTaskJSON(t, row["max_attempts"], 5)
	assertTaskJSON(t, row["proxy_mode"], "required")
	assertTaskJSON(t, fake.validatedArgs, [][]string{{}})
	if _, err := db.PutSitePolicy(ctx, "twitter", map[string]any{
		"max_concurrency": 1, "retry_limit": 0,
		"backoff_base_seconds": 9, "proxy_mode": "direct",
	}); err != nil {
		t.Fatal(err)
	}
	persisted, err := db.GetTask(ctx, row["id"].(string))
	if err != nil || persisted == nil {
		t.Fatalf("read frozen task: %#v, %v", persisted, err)
	}
	assertTaskJSON(t, persisted["policy"], want)
	assertTaskJSON(t, persisted["max_attempts"], 5)
	assertTaskJSON(t, persisted["proxy_mode"], "required")
}

func TestEnqueueExplicitCredentialsOverrideManagedPerField(t *testing.T) {
	service, db, fake := newTaskTestService(t)
	relativeCookies := filepath.Join("credentials", "explicit.cookies")
	explicitCookies := writeTaskTestFile(t, filepath.Join(service.config.ProjectDir, relativeCookies))
	reference := " explicit-account "
	row, created, err := service.Enqueue(context.Background(), Create{
		URL:         "https://gallery.example/item",
		CookiesFile: &relativeCookies, CredentialsRef: &reference,
	}, nil)
	if err != nil || !created {
		t.Fatalf("Enqueue explicit credentials: created=%v err=%v", created, err)
	}
	persisted, err := db.GetTask(context.Background(), row["id"].(string))
	if err != nil || persisted == nil {
		t.Fatalf("read task: %#v, %v", persisted, err)
	}
	assertTaskJSON(t, persisted["cookies_file"], explicitCookies)
	assertTaskJSON(t, persisted["credentials_ref"], "explicit-account")
	assertTaskJSON(t, persisted["config_file"], fake.managed.ConfigFile)
	assertTaskJSON(t, fake.credentialSites, []string{"twitter"})
}

func TestEnqueueBoundaryFailuresDoNotPersist(t *testing.T) {
	for _, name := range []string{"site conflict", "forbidden args", "output traversal", "credential escape"} {
		t.Run(name, func(t *testing.T) {
			service, db, fake := newTaskTestService(t)
			body := Create{URL: "https://gallery.example/item"}
			var message string
			switch name {
			case "site conflict":
				site := "pixiv"
				body.Site = &site
				message = "site"
			case "forbidden args":
				body.ExtraArgs = []string{"--exec", "never-run"}
				message = "forbidden extraArgs"
			case "output traversal":
				output := "../escaped"
				body.OutputDir = &output
				message = "allowed_output_roots"
			case "credential escape":
				cookies := writeTaskTestFile(t, filepath.Join(service.config.ProjectDir, "outside.cookies"))
				body.CookiesFile = &cookies
				message = "cookies_file"
			}
			key := "must-not-exist"
			row, created, err := service.Enqueue(context.Background(), body, &key)
			var invalidTask *Error
			if !errors.As(err, &invalidTask) || invalidTask.Status != 422 || invalidTask.Code != "invalid_task" || !strings.Contains(invalidTask.Message, message) {
				t.Fatalf("expected invalid_task containing %q, got %v", message, err)
			}
			if row != nil || created || fake.control.notifications != 0 {
				t.Fatalf("rejected input returned task or notified: row=%#v created=%v notifications=%d", row, created, fake.control.notifications)
			}
			rows, err := db.ListTasks(context.Background(), "", "", 10, 0)
			if err != nil || len(rows) != 0 {
				t.Fatalf("rejected input persisted tasks: %#v, %v", rows, err)
			}
			stored, err := db.GetTaskByIdempotency(context.Background(), key)
			if err != nil || stored != nil {
				t.Fatalf("rejected input consumed idempotency key: %#v, %v", stored, err)
			}
		})
	}
}
