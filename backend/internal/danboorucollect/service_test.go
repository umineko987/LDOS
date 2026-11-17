package danboorucollect

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"ldos/backend/internal/crawls"
	"ldos/backend/internal/datasets"
	"ldos/backend/internal/discovery"
	"ldos/backend/internal/store"
)

type fixture struct {
	t        *testing.T
	ctx      context.Context
	db       *store.Store
	datasets *datasets.Service
	s        *Service
	id, root string
	calls    []crawls.Request
}

func newFixture(t *testing.T, posts ...discovery.DanbooruPost) *fixture {
	t.Helper()
	root := t.TempDir()
	db, err := store.Open(filepath.Join(root, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	ds, err := datasets.New(ctx, datasets.Dependencies{Store: db})
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{t: t, ctx: ctx, db: db, datasets: ds, root: root}
	t.Cleanup(func() { _ = ds.Stop(); _ = db.Close() })
	d, err := ds.Create(ctx, datasets.CreateOptions{Name: "Test dataset"})
	if err != nil {
		t.Fatal(err)
	}
	f.id = d["dataset_id"].(string)
	f.s = New(Dependencies{Store: db, Datasets: ds, Request: func(context.Context) (discovery.Request, error) {
		return discovery.Request{Site: "danbooru", ProxyMode: "direct", ConfigFile: "fixture-config.json"}, nil
	}, Browse: func(context.Context, discovery.Request, discovery.DanbooruBrowseOptions) (*discovery.DanbooruBrowsePage, error) {
		return &discovery.DanbooruBrowsePage{Items: posts, Source: discovery.DanbooruSource{Kind: "pool", ID: "123", Name: "Collection"}}, nil
	}, CreateCrawl: func(ctx context.Context, id string, raw json.RawMessage, key string) (map[string]any, error) {
		request, err := crawls.DecodeRequest(raw)
		if err != nil {
			return nil, err
		}
		f.calls = append(f.calls, request)
		f.exec(`INSERT INTO crawl_batches(id,idempotency_key,status,output_dir,concurrency,max_tasks,created_at,updated_at) VALUES(? ,?,'queued',?,4,100,1,1)`, key, key, root)
		return map[string]any{"id": key}, nil
	}})
	return f
}
func (f *fixture) exec(query string, args ...any) {
	f.t.Helper()
	if err := f.db.WriteTransaction(f.ctx, func(tx *sql.Tx) error { _, e := tx.ExecContext(f.ctx, query, args...); return e }); err != nil {
		f.t.Fatal(err)
	}
}
func post(id string) discovery.DanbooruPost {
	return discovery.DanbooruPost{ID: id, URL: "https://danbooru.donmai.us/posts/" + id, Title: "Post " + id, FileExt: "png", Downloadable: true, PreviewURL: "https://cdn.donmai.us/360x360/" + id + ".jpg", SampleURL: "https://cdn.donmai.us/720x720/" + id + ".jpg", Tags: map[string][]string{"general": {"solo"}}}
}
func (f *fixture) browse() *Page {
	f.t.Helper()
	page, err := f.s.Browse(f.ctx, BrowseRequest{DatasetID: f.id, DanbooruBrowseOptions: discovery.DanbooruBrowseOptions{Kind: "pool", Reference: "123"}})
	if err != nil {
		f.t.Fatal(err)
	}
	return page
}
func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("error=%v, want %s", err, code)
	}
}

func TestBrowseCollectOrderAndDurableRetry(t *testing.T) {
	f := newFixture(t, post("30"), post("10"))
	page := f.browse()
	if !strings.HasPrefix(page.Items[0].PreviewURL, "/api/v1/danbooru/media/") || strings.Contains(page.Items[0].PreviewURL, "cdn.") {
		t.Fatal(page.Items)
	}
	tokens := []string{page.Items[0].Token, page.Items[1].Token, page.Items[0].Token}
	result, err := f.s.Collect(f.ctx, f.id, tokens, "request-1")
	if err != nil {
		t.Fatal(err)
	}
	if result.QueuedCount != 2 || result.BatchID == nil || len(f.calls) != 1 {
		t.Fatal(result, f.calls)
	}
	addresses := f.calls[0].Sources[0].Addresses
	if addresses[0].URL != post("30").URL || addresses[1].URL != post("10").URL || !reflect.DeepEqual(addresses[0].ExtraArgs, []string{"--filename", "ldos-danbooru-0001-30.{extension}"}) {
		t.Fatal(addresses)
	}
	if f.calls[0].ConfigFile == nil || *f.calls[0].ConfigFile != "fixture-config.json" {
		t.Fatal("credentials were not preserved")
	}
	rows, err := f.db.QueryRows(f.ctx, "SELECT post_id,file_name FROM danbooru_import_items ORDER BY post_id")
	if err != nil || len(rows) != 2 || rows[0]["file_name"] != "ldos-danbooru-0002-10.png" {
		t.Fatal(rows, err)
	}
	// A lost response can be retried even after the process loses preview tokens.
	restarted := New(f.s.deps)
	again, err := restarted.Collect(f.ctx, f.id, tokens, "request-1")
	if err != nil || !reflect.DeepEqual(result, again) || len(f.calls) != 1 {
		t.Fatal(again, err)
	}
	_, err = restarted.Collect(f.ctx, f.id, []string{tokens[1]}, "request-1")
	requireCode(t, err, "idempotency_conflict")
}

func TestCollectRechecksRemoteAvailability(t *testing.T) {
	f := newFixture(t, post("1"))
	page := f.browse()
	f.s.deps.Browse = func(_ context.Context, _ discovery.Request, options discovery.DanbooruBrowseOptions) (*discovery.DanbooruBrowsePage, error) {
		if options.Query != "id:1" || options.Count {
			t.Fatal(options)
		}
		return &discovery.DanbooruBrowsePage{Items: []discovery.DanbooruPost{}}, nil
	}
	_, err := f.s.Collect(f.ctx, f.id, []string{page.Items[0].Token}, "changed-permission")
	requireCode(t, err, "danbooru_post_unavailable")
	rows, err := f.db.QueryRows(f.ctx, "SELECT * FROM danbooru_collect_requests")
	if err != nil || len(rows) != 0 || len(f.calls) != 0 {
		t.Fatal(rows, f.calls, err)
	}
}

func TestSelectionValidationBeforeSideEffects(t *testing.T) {
	unavailable := post("2")
	unavailable.Downloadable = false
	f := newFixture(t, post("1"), unavailable)
	page := f.browse()
	_, err := f.s.Collect(f.ctx, f.id, []string{page.Items[0].Token, page.Items[1].Token}, "invalid")
	requireCode(t, err, "danbooru_post_unavailable")
	if len(f.calls) != 0 {
		t.Fatal("partially queued an invalid selection")
	}
	other, err := f.datasets.Create(f.ctx, datasets.CreateOptions{Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.s.Collect(f.ctx, other["dataset_id"].(string), []string{page.Items[0].Token}, "cross-dataset")
	requireCode(t, err, "danbooru_selection_expired")
	item := f.s.entries[page.Items[0].Token]
	item.expires = time.Now().Add(-time.Second)
	f.s.entries[page.Items[0].Token] = item
	_, err = f.s.Collect(f.ctx, f.id, []string{page.Items[0].Token}, "expired")
	requireCode(t, err, "danbooru_selection_expired")
}

func TestReuseOnlySelectedAssetAndSkipExisting(t *testing.T) {
	f := newFixture(t, post("7"), post("8"))
	f.exec(`INSERT INTO crawl_batches(id,status,output_dir,concurrency,max_tasks,created_at,updated_at) VALUES('previous','succeeded',?,1,10,1,1)`, f.root)
	f.exec(`INSERT INTO gallery_sources(id,kind,batch_id,display_name,root_path,canonical_root_key,created_at,updated_at) VALUES('source','crawl','previous','Previous',?,?,1,1)`, f.root, f.root)
	f.exec(`INSERT INTO gallery_directories(id,source_id,relative_path,name,sort_key,created_at,updated_at) VALUES('dir','source','','Previous','',1,1)`)
	for _, id := range []string{"7", "8"} {
		name := "ldos-danbooru-" + id + ".png"
		if err := os.WriteFile(filepath.Join(f.root, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		f.exec(`INSERT INTO gallery_assets(id,source_id,directory_id,relative_path,name,extension,sort_key,size_bytes,modified_ns,created_at,updated_at) VALUES(?,'source','dir',?,?,'.png',?,7,1,1,1)`, id, name, name, id)
		f.exec(`INSERT INTO danbooru_import_items(batch_id,post_id,file_name) VALUES('previous',?,?)`, id, name)
	}
	page := f.browse()
	if page.Items[0].LocalAssetID == nil || page.Items[0].InDataset {
		t.Fatal(page.Items[0])
	}
	result, err := f.s.Collect(f.ctx, f.id, []string{page.Items[0].Token}, "reuse")
	if err != nil || result.ReusedCount != 1 || result.BatchID != nil || len(f.calls) != 0 {
		t.Fatal(result, err)
	}
	members, err := f.datasets.MemberRows(f.ctx, f.id)
	if err != nil || len(members) != 1 || members[0]["asset_id"] != "7" {
		t.Fatal(members, err)
	}
	page = f.browse()
	if !page.Items[0].InDataset || page.Items[1].InDataset {
		t.Fatal(page.Items)
	}
	result, err = f.s.Collect(f.ctx, f.id, []string{page.Items[0].Token}, "skip")
	if err != nil || result.SkippedCount != 1 || result.QueuedCount != 0 {
		t.Fatal(result, err)
	}
}

func TestPendingCollectCanResume(t *testing.T) {
	f := newFixture(t, post("1"))
	page := f.browse()
	tokens := []string{page.Items[0].Token}
	original := f.s.deps.CreateCrawl
	f.s.deps.CreateCrawl = func(context.Context, string, json.RawMessage, string) (map[string]any, error) {
		return nil, errors.New("temporary failure")
	}
	if _, err := f.s.Collect(f.ctx, f.id, tokens, "resume"); err == nil {
		t.Fatal("expected failure")
	}
	f.s.deps.CreateCrawl = original
	restarted := New(f.s.deps)
	result, err := restarted.Collect(f.ctx, f.id, tokens, "resume")
	if err != nil || result.QueuedCount != 1 || len(f.calls) != 1 {
		t.Fatal(result, err)
	}
}

func TestMediaRestrictionCacheAndHTTP(t *testing.T) {
	f := newFixture(t, post("1"))
	page := f.browse()
	calls := 0
	var pngData bytes.Buffer
	_ = png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	f.s.deps.FetchMedia = func(context.Context, string, discovery.Request) ([]byte, string, error) {
		calls++
		return pngData.Bytes(), "application/octet-stream", nil
	}
	for range 2 {
		req := httptest.NewRequest(http.MethodGet, page.Items[0].PreviewURL, nil)
		response := httptest.NewRecorder()
		f.s.Handler().ServeHTTP(response, req)
		if response.Code != 200 || response.Header().Get("Content-Type") != "image/png" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	if calls != 1 {
		t.Fatalf("fetches=%d", calls)
	}
	for _, target := range []string{"http://cdn.donmai.us/a.jpg", "https://cdn.donmai.us.evil/a.jpg", "https://127.0.0.1/a.jpg", "https://user:pass@cdn.donmai.us/a.jpg", "https://cdn.donmai.us/a.jpg?api_key=secret", "https://cdn.donmai.us:443/a.jpg"} {
		if allowedMediaURL(target) {
			t.Fatal(target)
		}
	}
	item := f.s.entries[page.Items[0].Token]
	item.post.SampleURL = "https://localhost/private"
	f.s.entries[page.Items[0].Token] = item
	_, _, err := f.s.Media(f.ctx, page.Items[0].Token, "sample")
	requireCode(t, err, "danbooru_preview_unavailable")
	if calls != 1 {
		t.Fatal("attempted an untrusted media request")
	}
	f.s.media = map[string]cachedMedia{}
	f.s.mediaOrder = nil
	f.s.mediaBytes = 0
	f.s.deps.FetchMedia = func(context.Context, string, discovery.Request) ([]byte, string, error) {
		return []byte("<svg onload=alert(1)>"), "image/svg+xml", nil
	}
	_, _, err = f.s.Media(f.ctx, page.Items[0].Token, "preview")
	requireCode(t, err, "invalid_danbooru_preview")
}

func TestHTTPValidatesAndPreservesUpstreamStatus(t *testing.T) {
	f := newFixture(t, post("1"))
	for _, body := range []string{`{"dataset_id":"x","url":"http://localhost"}`, `{} {}`, `null`} {
		response := httptest.NewRecorder()
		f.s.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/danbooru/browse", strings.NewReader(body)))
		if response.Code < 400 {
			t.Fatal(body, response.Code)
		}
	}
	f.s.deps.Browse = func(context.Context, discovery.Request, discovery.DanbooruBrowseOptions) (*discovery.DanbooruBrowsePage, error) {
		return nil, &discovery.Error{Code: "danbooru_api_failed", Message: "forbidden", Details: map[string]any{"status_code": 403}}
	}
	body, _ := json.Marshal(BrowseRequest{DatasetID: f.id, DanbooruBrowseOptions: discovery.DanbooruBrowseOptions{Kind: "favorites"}})
	response := httptest.NewRecorder()
	f.s.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/danbooru/browse", bytes.NewReader(body)))
	if response.Code != 403 || !strings.Contains(response.Body.String(), "danbooru_api_failed") {
		t.Fatal(response.Code, response.Body.String())
	}
}
