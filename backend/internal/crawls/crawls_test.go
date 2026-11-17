package crawls

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/config"
	"ldos/backend/internal/discovery"
	"ldos/backend/internal/gallery"
	"ldos/backend/internal/network"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/scheduler"
	"ldos/backend/internal/store"
	"ldos/backend/internal/tasks"
)

type captureFunc func(context.Context, gallery.CaptureRequest) (gallery.CaptureResult, error)

func (f captureFunc) Capture(ctx context.Context, r gallery.CaptureRequest) (gallery.CaptureResult, error) {
	return f(ctx, r)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type validator struct{}

func (validator) ValidateStatic(string) (network.Target, error) { return network.Target{}, nil }
func (validator) ValidateDirect(context.Context, string) ([]string, error) {
	return []string{"93.184.216.34"}, nil
}
func (validator) ValidateProxy(context.Context, string, string) ([]string, error) {
	return []string{"93.184.216.34"}, nil
}

type localPool struct {
	mu              sync.Mutex
	leases, release int
}

func (p *localPool) Acquire(context.Context, proxypool.Request) (*proxypool.Lease, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.leases++
	return &proxypool.Lease{NodeID: "node-1", Name: "local", Protocol: "http", Endpoint: "http://127.0.0.1:12345"}, nil
}
func (p *localPool) Release(context.Context, string, bool, string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.release++
	return nil
}
func (p *localPool) Status() map[string]any { return map[string]any{} }

type control struct {
	db     *store.Store
	notify atomic.Int64
}

func (c *control) Notify() { c.notify.Add(1) }
func (c *control) Cancel(ctx context.Context, id string) (map[string]any, error) {
	return c.db.RequestCancel(ctx, id)
}
func (c *control) Retry(ctx context.Context, id string, n int) (map[string]any, error) {
	return c.db.RetryTask(ctx, id, n)
}
func (c *control) Summary() map[string]any { return map[string]any{} }
func good(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func fixture(t *testing.T) (*Service, *store.Store, *control) {
	t.Helper()
	root := t.TempDir()
	db, err := store.Open(filepath.Join(root, "test.sqlite3"))
	good(t, err)
	t.Cleanup(func() { good(t, db.Close()) })
	output := filepath.Join(root, "downloads")
	good(t, os.Mkdir(output, 0700))
	runtime := filepath.Join(root, "runtime")
	good(t, os.Mkdir(runtime, 0700))
	cfg := config.Settings{ProjectDir: root, RuntimeDir: runtime, DefaultOutputRoot: output, AllowedOutputRoots: []string{output}, AllowedConfigRoots: []string{root}, AllowedCookieRoots: []string{root}, Scheduler: config.Scheduler{MaxConcurrentTasks: 20, MaxConcurrentBatches: 4}, Gallery: config.Gallery{DefaultHTTPTimeout: 30, DefaultRetries: 2}, DefaultSitePolicy: map[string]any{"proxy_mode": "direct", "retry_limit": 0, "backoff_base_seconds": 0}}
	resolve := func(_ context.Context, target string) (tasks.SiteInfo, error) {
		site := "pixiv"
		switch {
		case strings.Contains(target, "danbooru"):
			site = "danbooru"
		case strings.Contains(target, "hentai"):
			site = "exhentai"
		case strings.Contains(target, "x.com") || strings.Contains(target, "twimg.com"):
			site = "twitter"
		case strings.Contains(target, "pawchive"):
			site = "pawchive"
		}
		return tasks.SiteInfo{Site: site, Supported: true, Extractor: site + ":fixture"}, nil
	}
	c := &control{db: db}
	validateArgs := func(v []string) ([]string, error) {
		for _, arg := range v {
			if arg == "--exec" {
				return nil, errors.New("不安全参数")
			}
		}
		return v, nil
	}
	taskService, err := tasks.New(db, tasks.Dependencies{Resolve: resolve, Credentials: func(context.Context, string) (tasks.Credentials, error) { return tasks.Credentials{}, nil }, ValidateArgs: validateArgs, Control: c}, tasks.Config{RuntimeDir: runtime, ProjectDir: root, OutputRoot: output, AllowedOutputRoots: cfg.AllowedOutputRoots, AllowedConfigRoots: cfg.AllowedConfigRoots, AllowedCookieRoots: cfg.AllowedCookieRoots, DefaultPolicy: cfg.DefaultSitePolicy})
	good(t, err)
	transport, err := discovery.NewTransport(captureFunc(func(context.Context, gallery.CaptureRequest) (gallery.CaptureResult, error) {
		return capturePixiv(101, 2), nil
	}), &localPool{}, validator{}, runtime, nil)
	good(t, err)
	s, err := New(context.Background(), Dependencies{Store: db, Settings: cfg, Jobs: activity.NewRegistry(activity.NewBus(20)), Discovery: discovery.New(transport), Tasks: taskService, PolicyFor: func(context.Context, string) (scheduler.Policy, error) {
		p := scheduler.DefaultPolicy()
		p.ProxyMode = "direct"
		p.RetryLimit = 0
		p.BackoffBase = 0
		return p, nil
	}, Credentials: func(_ context.Context, _ string, r CredentialsRequest) (Credentials, error) {
		return Credentials{Reference: text(r.Reference), CookiesFile: text(r.CookiesFile), ConfigFile: text(r.ConfigFile)}, nil
	}, ValidateArgs: validateArgs, ValidateTarget: func(context.Context, string, string, scheduler.Policy) error { return nil }, Resolve: resolve, ProbeForTarget: func(context.Context, string) (proxypool.ProbeResult, error) {
		return proxypool.ProbeResult{Total: 2, Results: []proxypool.ProbeNode{{ID: "node-1", Healthy: true}, {ID: "node-2", Healthy: false}}}, nil
	}, NotifyTasks: c.Notify, PollInterval: 5 * time.Millisecond})
	good(t, err)
	t.Cleanup(func() { good(t, s.Stop()) })
	return s, db, c
}
func capturePixiv(id, count int) gallery.CaptureResult {
	return gallery.CaptureResult{ProcessResult: gallery.ProcessResult{ExitCode: 0}, Stdout: fmt.Sprintf(`[[2,{"id":%d,"page_count":%d,"user":{"id":17,"name":"artist"}}]]`, id, count)}
}
func batchRequest(addresses ...string) Request {
	r := Request{Concurrency: 20, MaxTasks: 10000}
	source := Source{Site: "pixiv"}
	for _, address := range addresses {
		source.Addresses = append(source.Addresses, Address{URL: address})
	}
	r.Sources = []Source{source}
	return r
}
func createBatch(t *testing.T, s *Service, r Request) map[string]any {
	t.Helper()
	b, created, err := s.Create(context.Background(), r, nil)
	good(t, err)
	if !created {
		t.Fatal("not created")
	}
	return b
}
func batchAddresses(batch map[string]any) []map[string]any {
	out := []map[string]any{}
	for _, source := range rowsOf(batch["sources"]) {
		out = append(out, rowsOf(source["addresses"])...)
	}
	return out
}
func markTasks(t *testing.T, s *Service, batchID, status string) {
	t.Helper()
	good(t, s.exec(context.Background(), `UPDATE tasks SET status=?,finished_at=?,updated_at=? WHERE id IN(SELECT task_id FROM crawl_address_tasks cat JOIN crawl_addresses ca ON ca.id=cat.address_id WHERE ca.batch_id=?)`, status, now(), now(), batchID))
}
func request(t *testing.T, s *Service, method, path, body string) (int, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	mux := http.NewServeMux()
	s.Register(mux)
	mux.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
	var result map[string]any
	good(t, json.Unmarshal(w.Body.Bytes(), &result))
	return w.Code, result
}

func TestCreationContractsAndIdempotency(t *testing.T) {
	s, db, _ := fixture(t)
	body := `{"concurrency":128,"priority":5,"extra_args":["--verbose"],"sources":[{"site":"PIXIV","priority":0,"ignored":"source echo","addresses":[{"url":"https://www.pixiv.net/users/17","label":"A","unrelated":42}]}]}`
	r, err := DecodeRequest([]byte(body))
	good(t, err)
	key := "same-key"
	b, created, err := s.Create(context.Background(), r, &key)
	good(t, err)
	if !created || integer(b["concurrency"]) != 20 || integer(b["requested_concurrency"]) != 128 {
		t.Fatal(b)
	}
	a := batchAddresses(b)[0]
	if integer(a["priority"]) != 0 || str(a["url"]) != "https://www.pixiv.net/users/17/artworks" {
		t.Fatal(a)
	}
	replay, newly, err := s.Create(context.Background(), r, &key)
	good(t, err)
	if newly || replay["id"] != b["id"] {
		t.Fatal(replay)
	}
	if _, ok := replay["created"]; ok {
		t.Fatal("replay gained create-only fields")
	}
	rows, err := db.QueryRows(context.Background(), "SELECT * FROM crawl_addresses")
	good(t, err)
	if len(rows) != 1 {
		t.Fatal(rows)
	}
	statuses := map[string]int{`{"sources":[]}`: 422, `{"sources":[{"site":"pixiv","addresses":[{"url":"https://www.pixiv.net/users/17"}]}],"extra":1}`: 422, `{"sources":[{"site":"pixiv","addresses":[{"url":"https://www.pixiv.net/users/17"}]}],"extra_args":["--range","1"]}`: 422}
	for raw, want := range statuses {
		status, _ := request(t, s, "POST", "/api/v1/crawls", raw)
		if status != want {
			t.Fatalf("status=%d for %s", status, raw)
		}
	}
}
func TestOrderedAddressDrainAndTerminalAggregation(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	b := createBatch(t, s, batchRequest("https://www.pixiv.net/users/17", "https://www.pixiv.net/users/18"))
	id := str(b["id"])
	good(t, s.RunOnce(ctx))
	rows, err := s.ListTasks(ctx, id, "", 100, 0)
	good(t, err)
	if len(rows) != 2 {
		b, _ = s.Get(ctx, id)
		t.Fatalf("tasks=%v batch=%v", rows, b)
	}
	for _, task := range rows {
		if integer(task["address_order"]) != 0 || task["output_dir"] != b["output_dir"] {
			t.Fatal(task)
		}
	}
	good(t, s.RunOnce(ctx))
	b, err = s.Get(ctx, id)
	good(t, err)
	a := batchAddresses(b)
	if a[0]["status"] != "running" || a[1]["status"] != "pending" {
		t.Fatal(a)
	}
	markTasks(t, s, id, "succeeded")
	good(t, s.RunOnce(ctx))
	good(t, s.RunOnce(ctx))
	rows, err = s.ListTasks(ctx, id, "", 100, 0)
	good(t, err)
	if len(rows) != 4 {
		t.Fatal(rows)
	}
	markTasks(t, s, id, "succeeded")
	good(t, s.RunOnce(ctx))
	b, err = s.Get(ctx, id)
	good(t, err)
	if b["status"] != "succeeded" || integer(b["succeeded_task_count"]) != 4 || b["current"] != nil || b["resumable"] != false {
		t.Fatal(b)
	}
	stamp := b["finished_at"]
	b, err = s.Cancel(ctx, id)
	good(t, err)
	if b["finished_at"] != stamp {
		t.Fatal("terminal timestamp changed")
	}
}
func TestConcurrentCreateIsOneBatch(t *testing.T) {
	s, db, _ := fixture(t)
	key := "concurrent"
	var wg sync.WaitGroup
	var created atomic.Int64
	errs := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, fresh, e := s.Create(context.Background(), batchRequest("https://www.pixiv.net/users/17"), &key)
			if fresh {
				created.Add(1)
			}
			if e != nil {
				errs <- e
			}
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
	if created.Load() != 1 {
		t.Fatal(created.Load())
	}
	row, e := db.QueryRow(context.Background(), "SELECT COUNT(*) AS n FROM crawl_batches")
	good(t, e)
	if integer(row["n"]) != 1 {
		t.Fatal(row)
	}
}
func TestRetryRerunKeepsLinksAndOrdersRetries(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	b := createBatch(t, s, batchRequest("https://www.pixiv.net/users/17", "https://www.pixiv.net/users/18"))
	id := str(b["id"])
	good(t, s.RunOnce(ctx))
	markTasks(t, s, id, "failed")
	good(t, s.RunOnce(ctx))
	good(t, s.RunOnce(ctx))
	markTasks(t, s, id, "failed")
	good(t, s.RunOnce(ctx))
	old, err := s.ListTasks(ctx, id, "", 100, 0)
	good(t, err)
	result, err := s.Retry(ctx, id, 2)
	good(t, err)
	if integer(result["retried_count"]) != 4 {
		t.Fatal(result)
	}
	good(t, s.RunOnce(ctx))
	rows, err := s.ListTasks(ctx, id, "", 100, 0)
	good(t, err)
	for _, task := range rows {
		if integer(task["max_attempts"]) != 2 {
			t.Fatal(task)
		}
		if integer(task["address_order"]) == 1 && number(task["next_run_at"]) != heldUntil {
			t.Fatal("later retry runnable", task)
		}
	}
	markTasks(t, s, id, "succeeded")
	good(t, s.RunOnce(ctx))
	good(t, s.RunOnce(ctx))
	_, err = s.Rerun(ctx, id, 1, false)
	good(t, err)
	good(t, s.RunOnce(ctx))
	good(t, s.RunOnce(ctx))
	good(t, s.RunOnce(ctx))
	good(t, s.RunOnce(ctx))
	rows, err = s.ListTasks(ctx, id, "", 100, 0)
	good(t, err)
	if len(rows) != len(old) {
		t.Fatalf("replanned duplicates: %d", len(rows))
	}
	for i, row := range rows {
		if row["id"] != old[i]["id"] {
			t.Fatal("idempotent identity changed")
		}
	}
}
func TestReorderedCandidatesKeepSequenceLinks(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	s.deps.Discovery.Transport.Gallery = captureFunc(func(context.Context, gallery.CaptureRequest) (gallery.CaptureResult, error) {
		return gallery.CaptureResult{Stdout: `[[2,{"id":101}],[2,{"id":102}]]`}, nil
	})
	b := createBatch(t, s, batchRequest("https://www.pixiv.net/users/17"))
	id := str(b["id"])
	good(t, s.RunOnce(ctx))
	old, err := s.ListTasks(ctx, id, "", 100, 0)
	good(t, err)
	markTasks(t, s, id, "succeeded")
	good(t, s.RunOnce(ctx))
	s.deps.Discovery.Transport.Gallery = captureFunc(func(context.Context, gallery.CaptureRequest) (gallery.CaptureResult, error) {
		return gallery.CaptureResult{Stdout: `[[2,{"id":103}],[2,{"id":102}],[2,{"id":101}]]`}, nil
	})
	_, err = s.Rerun(ctx, id, 1, false)
	good(t, err)
	good(t, s.RunOnce(ctx))
	rows, err := s.ListTasks(ctx, id, "", 100, 0)
	good(t, err)
	if len(rows) != 3 || rows[0]["id"] != old[0]["id"] || rows[1]["id"] != old[1]["id"] || integer(rows[2]["sequence_no"]) != 3 {
		t.Fatal(rows)
	}
}
func TestPauseResumeAndRestart(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	b := createBatch(t, s, batchRequest("https://www.pixiv.net/users/17", "https://www.pixiv.net/users/18"))
	id := str(b["id"])
	good(t, s.RunOnce(ctx))
	_, err := s.Pause(ctx, id)
	good(t, err)
	markTasks(t, s, id, "succeeded")
	good(t, s.Recover(ctx))
	good(t, s.RunOnce(ctx))
	b, err = s.Get(ctx, id)
	good(t, err)
	if b["status"] != "paused" || batchAddresses(b)[1]["status"] != "pending" {
		t.Fatal(b)
	}
	_, err = s.Resume(ctx, id)
	good(t, err)
	good(t, s.RunOnce(ctx))
	good(t, s.RunOnce(ctx))
	rows, err := s.ListTasks(ctx, id, "", 100, 0)
	good(t, err)
	if len(rows) != 4 {
		t.Fatal(rows)
	}
}
func TestCancelRacingPlanningCannotAppendTasks(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	entered, release := make(chan struct{}), make(chan struct{})
	s.deps.Discovery.Transport.Gallery = captureFunc(func(context.Context, gallery.CaptureRequest) (gallery.CaptureResult, error) {
		close(entered)
		<-release
		return capturePixiv(101, 2), nil
	})
	b := createBatch(t, s, batchRequest("https://www.pixiv.net/users/17"))
	id := str(b["id"])
	done := make(chan error, 1)
	go func() { done <- s.RunOnce(ctx) }()
	<-entered
	result, err := s.Cancel(ctx, id)
	good(t, err)
	if result["status"] != "cancelled" {
		t.Fatal(result)
	}
	close(release)
	good(t, <-done)
	rows, err := s.ListTasks(ctx, id, "", 100, 0)
	good(t, err)
	if len(rows) != 0 {
		t.Fatal("late tasks after cancel", rows)
	}
}
func TestPartialPlanningFailureDrainsThenRetryFillsGap(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	s.deps.Discovery.Transport.Gallery = captureFunc(func(context.Context, gallery.CaptureRequest) (gallery.CaptureResult, error) {
		return capturePixiv(101, 52), nil
	})
	resolve := s.deps.Resolve
	var calls atomic.Int64
	s.deps.Resolve = func(ctx context.Context, url string) (tasks.SiteInfo, error) {
		if calls.Add(1) == 53 {
			return tasks.SiteInfo{}, errors.New("fixture prepare failure")
		}
		return resolve(ctx, url)
	}
	b := createBatch(t, s, batchRequest("https://www.pixiv.net/users/17", "https://www.pixiv.net/users/18"))
	id := str(b["id"])
	good(t, s.RunOnce(ctx))
	b, err := s.Get(ctx, id)
	good(t, err)
	a := batchAddresses(b)
	if a[0]["status"] != "running" || str(a[0]["planning_error"]) == "" || a[1]["status"] != "pending" {
		t.Fatal(b)
	}
	rows, err := s.ListTasks(ctx, id, "", 100, 0)
	good(t, err)
	if len(rows) != 50 {
		t.Fatalf("partial task count=%d", len(rows))
	}
	for _, task := range rows {
		if task["status"] != "cancelled" {
			t.Fatal(task)
		}
	}
	good(t, s.RunOnce(ctx))
	good(t, s.RunOnce(ctx))
	markTasks(t, s, id, "succeeded")
	good(t, s.RunOnce(ctx))
	_, err = s.Retry(ctx, id, 1)
	good(t, err)
	good(t, s.RunOnce(ctx))
	rows, err = s.ListTasks(ctx, id, str(a[0]["id"]), 100, 0)
	good(t, err)
	if len(rows) != 52 {
		t.Fatalf("did not fill plan: %d", len(rows))
	}
}
func TestRecoveryKeepsPartiallyLinkedAddressBeforeNext(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	b := createBatch(t, s, batchRequest("https://www.pixiv.net/users/17", "https://www.pixiv.net/users/18"))
	id := str(b["id"])
	good(t, s.RunOnce(ctx))
	a := batchAddresses(b)[0]
	good(t, s.exec(ctx, "UPDATE crawl_addresses SET status='planning' WHERE id=?", a["id"]))
	good(t, s.Recover(ctx))
	b, err := s.Get(ctx, id)
	good(t, err)
	addresses := batchAddresses(b)
	if addresses[0]["status"] != "running" || str(addresses[0]["planning_error"]) == "" {
		t.Fatal(addresses)
	}
	good(t, s.RunOnce(ctx))
	rows, err := s.ListTasks(ctx, id, "", 100, 0)
	good(t, err)
	if len(rows) != 2 {
		t.Fatal(rows)
	}
}
func TestProbeScopeAndFrozenPolicy(t *testing.T) {
	s, db, _ := fixture(t)
	ctx := context.Background()
	r := batchRequest("https://www.pixiv.net/users/17")
	r.ProxyMode = ptr("required")
	b := createBatch(t, s, r)
	good(t, s.RunOnce(ctx))
	rows, err := s.ListTasks(ctx, str(b["id"]), "", 100, 0)
	good(t, err)
	if len(rows) != 2 {
		t.Fatal(rows)
	}
	for _, task := range rows {
		p := task["policy"].(map[string]any)
		if p["proxy_probe_scope"] != batchAddresses(b)[0]["id"] || integer(p["max_concurrency"]) != 20 {
			t.Fatal(p)
		}
		if _, exists := p["allowed_proxy_ids"]; exists {
			t.Fatal("allowlist leaked in projection")
		}
	}
	ids, err := db.ProbeNodeIDs(ctx, str(batchAddresses(b)[0]["id"]))
	good(t, err)
	if !reflect.DeepEqual(ids, []string{"node-1"}) {
		t.Fatal(ids)
	}
}
func TestOutputBoundaryRejectsTraversalAndSymlinks(t *testing.T) {
	s, _, _ := fixture(t)
	for _, path := range []string{"../escape", filepath.Join(t.TempDir(), "outside")} {
		r := batchRequest("https://www.pixiv.net/users/17")
		r.OutputDir = &path
		if _, _, e := s.Create(context.Background(), r, nil); e == nil {
			t.Fatal("escaped output", path)
		}
	}
	outside := t.TempDir()
	link := filepath.Join(s.deps.Settings.DefaultOutputRoot, "link")
	good(t, os.Symlink(outside, link))
	r := batchRequest("https://www.pixiv.net/users/17")
	r.OutputDir = ptr(filepath.Join(link, "escape"))
	if _, _, e := s.Create(context.Background(), r, nil); e == nil {
		t.Fatal("symlink escaped output")
	}
}
func TestHTTPViewsPaginationAndActions(t *testing.T) {
	s, _, _ := fixture(t)
	status, b := request(t, s, "POST", "/api/v1/crawls?view=desktop", `{"sources":[{"site":"pixiv","addresses":[{"url":"https://www.pixiv.net/users/17"}]}]}`)
	if status != 202 || len(b) != 4 || b["response_profile"] != "desktop-crawl-operation-v1" {
		t.Fatal(status, b)
	}
	id := str(b["id"])
	good(t, s.RunOnce(context.Background()))
	status, b = request(t, s, "GET", "/api/v1/crawls/"+id+"?view=desktop", "")
	if status != 200 || b["response_profile"] != "desktop-crawl-v1" || len(batchAddresses(b)) != 1 {
		t.Fatal(status, b)
	}
	if _, exists := b["output_dir"]; exists {
		t.Fatal("desktop path leak")
	}
	status, b = request(t, s, "GET", "/api/v1/crawls/"+id+"/tasks?view=tasks&limit=1&offset=1", "")
	if status != 200 || len(rowsOf(b["items"])) != 1 {
		t.Fatal(status, b)
	}
	task := rowsOf(b["items"])[0]
	if _, exists := task["url"]; exists {
		t.Fatal("task URL leak")
	}
	if len(task) != 12 {
		t.Fatal(task)
	}
	status, b = request(t, s, "POST", "/api/v1/crawls/"+id+"/retry", `{}`)
	if status != 409 || b["error"].(map[string]any)["code"] != "crawl_not_finished" {
		t.Fatal(status, b)
	}
	status, _ = request(t, s, "POST", "/api/v1/crawls/"+id+"/cancel?view=desktop", "")
	if status != 200 {
		t.Fatal(status)
	}
	good(t, s.RunOnce(context.Background()))
	status, b = request(t, s, "POST", "/api/v1/crawls/"+id+"/retry?view=desktop", `{}`)
	if status != 202 || len(b) != 4 {
		t.Fatal(status, b)
	}
	for _, path := range []string{"/api/v1/crawls?limit=501", "/api/v1/crawls?offset=-1", "/api/v1/crawls/" + id + "?view=tasks", "/api/v1/crawls/" + id + "/tasks?limit=1001"} {
		status, _ = request(t, s, "GET", path, "")
		if status != 422 {
			t.Fatalf("%s: %d", path, status)
		}
	}
}
func TestDesktopListFiltersBeforePaginationAndUsesLiveCounts(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	first := createBatch(t, s, batchRequest("https://www.pixiv.net/users/17"))
	good(t, s.RunOnce(ctx))
	markTasks(t, s, str(first["id"]), "succeeded")
	second := createBatch(t, s, batchRequest("https://www.pixiv.net/users/18"))
	_, err := s.Cancel(ctx, str(second["id"]))
	good(t, err)
	good(t, os.RemoveAll(str(second["output_dir"])))
	status, b := request(t, s, "GET", "/api/v1/crawls?view=desktop&limit=1", "")
	items := rowsOf(b["items"])
	if status != 200 || len(items) != 1 || items[0]["id"] != first["id"] || integer(items[0]["succeeded_task_count"]) != 2 {
		t.Fatal(status, b)
	}
	status, _ = request(t, s, "GET", "/api/v1/crawls/"+str(second["id"])+"?view=desktop", "")
	if status != 404 {
		t.Fatal(status)
	}
}
func TestReviewBlocksMutationsAndRerunClearsStaleReview(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	b := createBatch(t, s, batchRequest("https://www.pixiv.net/users/17"))
	id := str(b["id"])
	_, err := s.Cancel(ctx, id)
	good(t, err)
	good(t, s.exec(ctx, "INSERT INTO crawl_reviews(batch_id,status,created_at,updated_at) VALUES(?,'analyzing',?,?)", id, now(), now()))
	if _, err = s.Rerun(ctx, id, 1, false); err == nil {
		t.Fatal("active review did not block")
	}
	good(t, s.exec(ctx, "UPDATE crawl_reviews SET status='failed' WHERE batch_id=?", id))
	_, err = s.Rerun(ctx, id, 1, false)
	good(t, err)
	b, err = s.Get(ctx, id)
	good(t, err)
	if b["review"] != nil {
		t.Fatal(b)
	}
}
func TestSupervisorIndependentSitesAndLifecycle(t *testing.T) {
	s, _, _ := fixture(t)
	blocked, release := make(chan struct{}), make(chan struct{})
	var blockOnce sync.Once
	s.deps.Discovery.Transport.Gallery = captureFunc(func(ctx context.Context, r gallery.CaptureRequest) (gallery.CaptureResult, error) {
		if r.Site == "pixiv" {
			blockOnce.Do(func() { close(blocked) })
			select {
			case <-ctx.Done():
				return gallery.CaptureResult{}, ctx.Err()
			case <-release:
			}
			return capturePixiv(1, 1), nil
		}
		return gallery.CaptureResult{Stdout: `[[2,{"tweet_id":42,"author":{"name":"artist"},"count":1}]]`}, nil
	})
	createBatch(t, s, batchRequest("https://www.pixiv.net/users/17"))
	r := batchRequest("https://x.com/artist/media")
	r.Sources[0].Site = "twitter"
	b := createBatch(t, s, r)
	good(t, s.Start())
	good(t, s.Start())
	select {
	case <-blocked:
	case <-time.After(3 * time.Second):
		t.Fatal("planner did not start")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		rows, err := s.ListTasks(context.Background(), str(b["id"]), "", 100, 0)
		good(t, err)
		if len(rows) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("blocked site held unrelated batch")
		}
		time.Sleep(5 * time.Millisecond)
	}
	close(release)
	good(t, s.Stop())
	if s.deps.Jobs.HasActive() {
		t.Fatal("activity leaked")
	}
	good(t, s.Start())
	good(t, s.Stop())
}
func TestCompletionHandoffRetriesAndRecovers(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	var calls int
	s.deps.BatchComplete = func(_ context.Context, b map[string]any) error {
		calls++
		if !terminal(str(b["status"])) {
			t.Fatal(b)
		}
		if calls == 1 {
			return errors.New("temporary catalog failure")
		}
		return nil
	}
	b := createBatch(t, s, batchRequest("https://www.pixiv.net/users/17"))
	_, err := s.Cancel(ctx, str(b["id"]))
	good(t, err)
	if s.RunOnce(ctx) == nil {
		t.Fatal("callback failure lost")
	}
	good(t, s.RunOnce(ctx))
	good(t, s.RunOnce(ctx))
	if calls != 2 {
		t.Fatal(calls)
	}
	s.notified = map[string]float64{}
	good(t, s.RunOnce(ctx))
	if calls != 3 {
		t.Fatal("restart did not replay handoff")
	}
}

func TestAtomicChunkRollback(t *testing.T) {
	s, db, _ := fixture(t)
	ctx := context.Background()
	b := createBatch(t, s, batchRequest("https://www.pixiv.net/users/17"))
	a := batchAddresses(b)[0]
	_, err := s.beginPlanning(ctx, str(a["id"]))
	good(t, err)
	token, err := db.QueryRow(ctx, "SELECT started_at FROM crawl_addresses WHERE id=?", a["id"])
	good(t, err)
	a["started_at"] = token["started_at"]
	good(t, db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		_, e := tx.Exec(`CREATE TRIGGER fail_second BEFORE INSERT ON tasks WHEN NEW.url LIKE '%/102' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`)
		return e
	}))
	p, _ := s.deps.PolicyFor(ctx, "pixiv")
	_, err = s.enqueueChunk(ctx, b, a, p, Deduplicate([]Unit{{Site: "pixiv", URL: "https://www.pixiv.net/artworks/101", ExtraArgs: []string{}}, {Site: "pixiv", URL: "https://www.pixiv.net/artworks/102", ExtraArgs: []string{}}}), 0)
	if err == nil {
		t.Fatal("expected transaction rollback")
	}
	row, err := db.QueryRow(ctx, "SELECT COUNT(*) AS n FROM tasks")
	good(t, err)
	if integer(row["n"]) != 0 {
		t.Fatal("orphan task committed", row)
	}
}

func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
}
