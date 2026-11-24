package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func workbenchRequest(mux *http.ServeMux, method, path, payload, key string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(payload))
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

func TestTimelineSnapshotSelectionAndMediaScope(t *testing.T) {
	const prefix = "/api/v1/datasets/one/workbench"
	rows := []map[string]any{
		{"id": "21", "title": "Fixture", "author": "Alice", "media_count": 2, "download_url": "https://twitter.com/Alice/status/21?token=private", "thumbnail_url": "https://pbs.twimg.com/media/fixture?format=png&name=small&token=private"},
		{"id": "20", "title": "Second", "download_url": "https://x.com/i/web/status/20", "thumbnail_url": "https://pbs.twimg.com.evil.example/asset"},
		{"id": "19", "download_url": "https://x.com/i/web/status/42"},
	}
	var calls, fetched int
	var crawlKey string
	s := New(Dependencies{
		RequireDataset: func(context.Context, string) error { return nil },
		BrowseTimeline: func(_ context.Context, site, _ string, limit int) ([]map[string]any, bool, error) {
			if site != "twitter" || limit > len(rows) {
				t.Fatalf("timeline request: %s %d", site, limit)
			}
			return rows[:limit], limit < len(rows), nil
		},
		FetchPreview: func(_ context.Context, site, target string) ([]byte, error) {
			fetched++
			if site != "twitter" || target != "https://pbs.twimg.com/media/fixture?format=png&name=small" {
				t.Fatalf("unexpected preview target %s %s", site, target)
			}
			return []byte("\x89PNG\r\n\x1a\nfixture"), nil
		},
		StartCrawl: func(_ context.Context, dataset string, raw json.RawMessage, key string) (string, error) {
			calls++
			var body struct{ Sources []crawlSource }
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatal(err)
			}
			want := []crawlSource{{Site: "twitter", Addresses: []crawlAddress{{URL: "https://x.com/i/web/status/20", AddressType: "workbench_work"}, {URL: "https://x.com/alice/status/21", AddressType: "workbench_work"}}}}
			if dataset != "one" || key == "client-key" || !reflect.DeepEqual(body.Sources, want) {
				t.Fatalf("crawl request: %s %v %s", dataset, body.Sources, key)
			}
			if calls == 1 {
				crawlKey = key
				return "", errors.New("fixture lost the first response after persisting")
			}
			if key != crawlKey {
				t.Fatal("retry changed the native queue key")
			}
			return "batch", nil
		},
	})
	now := time.Unix(5000, 0)
	s.now = func() time.Time { return now }
	mux := http.NewServeMux()
	s.Register(mux)
	browse := func(limit string) BrowseResult {
		t.Helper()
		w := workbenchRequest(mux, "POST", prefix+"/browse", `{"site":"x","url":"https://x.com/Alice/media","limit":`+limit+`}`, "")
		var result BrowseResult
		if err := json.Unmarshal(w.Body.Bytes(), &result); w.Code != 200 || err != nil || strings.Contains(w.Body.String(), "private") || strings.Contains(w.Body.String(), "twimg.com") {
			t.Fatalf("browse: %d %s (%v)", w.Code, w.Body.String(), err)
		}
		return result
	}
	first, expanded := browse("1"), browse("3")
	if first.SnapshotID == expanded.SnapshotID || !first.HasMore || expanded.HasMore || len(first.Items) != 1 || len(expanded.Items) != 2 || expanded.Items[0].ID != first.Items[0].ID || expanded.Items[1].PreviewURL != "" {
		t.Fatalf("snapshots: %+v %+v", first, expanded)
	}
	collect := func(mux *http.ServeMux, base, snapshot, ids, key string, status int) {
		t.Helper()
		w := workbenchRequest(mux, "POST", base+"/collect", `{"snapshot_id":"`+snapshot+`","ids":`+ids+`}`, key)
		if w.Code != status || (status == 200 && !strings.Contains(w.Body.String(), `"batch_id":"batch"`)) {
			t.Fatalf("collect: %d %s", w.Code, w.Body.String())
		}
	}
	collect(mux, prefix, first.SnapshotID, `["20"]`, "client-key", 422)
	collect(mux, prefix, expanded.SnapshotID, `["21","21"]`, "client-key", 422)
	collect(mux, prefix, expanded.SnapshotID, `["19"]`, "client-key", 422)
	collect(mux, prefix, expanded.SnapshotID, `["21"]`, "", 422)
	collect(mux, strings.Replace(prefix, "/one/", "/two/", 1), expanded.SnapshotID, `["21"]`, "client-key", 410)
	collect(mux, prefix, expanded.SnapshotID, `["21","20"]`, "client-key", 500)
	collect(mux, prefix, expanded.SnapshotID, `["20","21"]`, "client-key", 200)
	collect(mux, prefix, expanded.SnapshotID, `["21","20"]`, "client-key", 200)
	collect(mux, prefix, expanded.SnapshotID, `["21"]`, "client-key", 409)
	if calls != 2 {
		t.Fatalf("native queue calls = %d", calls)
	}
	mediaPath := expanded.Items[0].PreviewURL
	if !strings.HasPrefix(mediaPath, prefix+"/media/") {
		t.Fatalf("preview route: %s", mediaPath)
	}
	w := workbenchRequest(mux, "GET", mediaPath+"?url=https://evil.example/asset", "", "")
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("preview: %d %v", w.Code, w.Header())
	}
	wrongDataset := strings.Replace(mediaPath, "/one/", "/two/", 1)
	if got := workbenchRequest(mux, "GET", wrongDataset, "", "").Code; got != 410 {
		t.Fatalf("cross-dataset preview: %d", got)
	}
	if got := workbenchRequest(mux, "GET", strings.TrimSuffix(mediaPath, "/21")+"/19", "", "").Code; got != 404 {
		t.Fatalf("unlisted item preview: %d", got)
	}
	restarted := http.NewServeMux()
	New(s.deps).Register(restarted)
	collect(restarted, prefix, expanded.SnapshotID, `["20","21"]`, "client-key", 410)
	now = now.Add(snapshotTTL)
	collect(mux, prefix, expanded.SnapshotID, `["20","21"]`, "client-key", 410)
	if got := workbenchRequest(mux, "GET", mediaPath, "", "").Code; got != 410 || fetched != 1 {
		t.Fatalf("expired preview: %d, fetches = %d", got, fetched)
	}
}

func TestBrowseAndCollectHaveSeparateLimits(t *testing.T) {
	ctx := context.Background()
	s := New(Dependencies{
		RequireDataset: func(context.Context, string) error { return nil },
		BrowseTimeline: func(_ context.Context, _ string, _ string, limit int) ([]map[string]any, bool, error) {
			if limit != 1000 {
				t.Fatalf("timeline browse limit = %d", limit)
			}
			return nil, true, nil
		},
	})
	result, err := s.Browse(ctx, "one", BrowseRequest{Site: "pixiv", URL: "https://www.pixiv.net/users/123/artworks", Limit: 1000})
	if err != nil || !result.HasMore {
		t.Fatalf("max timeline prefix: %+v, %v", result, err)
	}
	_, err = s.Browse(ctx, "one", BrowseRequest{Site: "eh", URL: "https://e-hentai.org/g/5/0123456789/", Limit: 501})
	var requestErr *requestError
	if !errors.As(err, &requestErr) || requestErr.code != "invalid_workbench_limit" {
		t.Fatalf("EH browse limit: %v", err)
	}
	_, err = s.Collect(ctx, "one", CollectRequest{SnapshotID: result.SnapshotID, IDs: make([]string, 501)}, "client-key")
	if !errors.As(err, &requestErr) || requestErr.code != "invalid_workbench_selection" || !strings.Contains(requestErr.message, "500") {
		t.Fatalf("collection limit: %v", err)
	}
}

func TestEHSnapshotCropsSpritesAndQueuesOnlySelectedPages(t *testing.T) {
	var body struct{ Sources []crawlSource }
	imageFixture := image.NewRGBA(image.Rect(0, 0, 2, 1))
	imageFixture.Set(0, 0, color.Black)
	imageFixture.Set(1, 0, color.White)
	var sprite bytes.Buffer
	if err := png.Encode(&sprite, imageFixture); err != nil {
		t.Fatal(err)
	}
	s := New(Dependencies{
		RequireDataset: func(context.Context, string) error { return nil },
		BrowseEHPages: func(_ context.Context, target string, limit int) ([]map[string]any, int, error) {
			if target != "https://e-hentai.org/g/5/0123456789/" || limit != 3 {
				t.Fatalf("EH browse: %s %d", target, limit)
			}
			return []map[string]any{
				{"id": "1", "page": 1, "media_count": 1},
				{"id": "2", "page": 2, "media_count": 1, "thumbnail_url": "https://ehgt.org/sprite.png", "thumbnail_sprite": map[string]int{"x": -1, "y": 0, "width": 1, "height": 1}},
				{"id": "10", "page": 10, "media_count": 1},
			}, 12, nil
		},
		FetchPreview: func(_ context.Context, _, _ string) ([]byte, error) { return sprite.Bytes(), nil },
		StartCrawl: func(_ context.Context, _ string, raw json.RawMessage, _ string) (string, error) {
			return "batch", json.Unmarshal(raw, &body)
		},
	})
	ctx := context.Background()
	result, err := s.Browse(ctx, "one", BrowseRequest{Site: "eh", URL: "https://e-hentai.org/g/5/0123456789?p=2", Limit: 3})
	if err != nil || result.Total == nil || *result.Total != 12 || !result.HasMore || result.Items[1].Page != 2 {
		t.Fatalf("result = %+v, err = %v", result, err)
	}
	buf, mime, err := s.preview(ctx, "one", result.SnapshotID, "2")
	if err != nil || mime != "image/png" {
		t.Fatalf("EH preview: %s %v", mime, err)
	}
	cropped, err := png.Decode(bytes.NewReader(buf))
	if err != nil || cropped.Bounds() != image.Rect(0, 0, 1, 1) || !reflect.DeepEqual(cropped.At(0, 0), color.RGBA{255, 255, 255, 255}) {
		t.Fatalf("wrong crop: %v %v", cropped, err)
	}
	_, err = s.Collect(ctx, "one", CollectRequest{SnapshotID: result.SnapshotID, IDs: []string{"10", "2"}}, "client-key")
	want := []crawlSource{{Site: "exhentai", Addresses: []crawlAddress{{URL: "https://e-hentai.org/g/5/0123456789/", EHPages: []int{2, 10}}}}}
	if err != nil || !reflect.DeepEqual(body.Sources, want) {
		t.Fatalf("EH crawl: %+v %v", body, err)
	}
}
