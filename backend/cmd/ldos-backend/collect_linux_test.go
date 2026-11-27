package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/collect"
	"ldos/backend/internal/datasets"
	"ldos/backend/internal/downloads"
	"ldos/backend/internal/httpapi"
	"ldos/backend/internal/policy"
)

func TestCollectEndpointsWiredWithOriginGuard(t *testing.T) {
	b, _ := nativeBusinessFixture(t, false)
	settings := b.settings.snapshot()
	bus := activity.NewBus(0)
	defer bus.Close()
	jobs := activity.NewRegistry(bus)
	proxy, err := newProxyRuntime(settings)
	nativeOK(t, err)
	defer proxy.stop()
	downloadSettings := downloads.NewWithPool(settings.RuntimeDir, downloadPool{pool: proxy.pool})

	handler := httpapi.New(
		settings,
		b.db,
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { httpapi.JSON(w, 200, jobs.List()) }),
		bus,
		downloadSettings,
		policy.New(settings.DefaultSitePolicy, b.db),
		httpapi.WithProxy(proxy.handler),
		b.register,
	)

	created, err := b.datasets.Create(b.ctx, datasets.CreateOptions{Name: "Collect HTTP", Kind: "character"})
	nativeOK(t, err)
	dsID := fmt.Sprint(created["dataset_id"])
	if dsID == "" || dsID == "<nil>" {
		t.Fatalf("missing dataset id in %+v", created)
	}

	doJSON := func(method, path, body, origin string, headers map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://127.0.0.1:8787"+path, strings.NewReader(body))
		req.Host = "127.0.0.1:8787"
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	// Cross-origin untrusted caller must be blocked by Origin guard
	blocked := doJSON("POST", "/api/v1/datasets/"+dsID+"/collect/resolve", `{"input":"silver_hair"}`, "https://evil.example", nil)
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("expected 403 from origin guard, got %d", blocked.Code)
	}

	// Danbooru fast-path keyword resolve returns 200
	resRec := doJSON("POST", "/api/v1/datasets/"+dsID+"/collect/resolve", `{"input":"silver_hair","sites":["danbooru"]}`, "http://127.0.0.1:8787", nil)
	if resRec.Code != http.StatusOK {
		t.Fatalf("resolve failed status=%d body=%s", resRec.Code, resRec.Body.String())
	}
	var resolved collect.ResolveResponse
	nativeOK(t, json.Unmarshal(resRec.Body.Bytes(), &resolved))
	if resolved.ResolvedMode != "keyword" || len(resolved.Sources) != 1 || resolved.Sources[0].Site != "danbooru" {
		t.Fatalf("unexpected resolve response: %+v", resolved)
	}

	// Multi-line URL resolve returns Pixiv + EH gallery with smart defaults
	urlRec := doJSON("POST", "/api/v1/datasets/"+dsID+"/collect/resolve", `{"input":"@alice\nhttps://exhentai.org/g/12345/abcdef0123/"}`, "http://127.0.0.1:8787", nil)
	if urlRec.Code != http.StatusOK {
		t.Fatalf("url resolve failed status=%d body=%s", urlRec.Code, urlRec.Body.String())
	}
	var urlResolved collect.ResolveResponse
	nativeOK(t, json.Unmarshal(urlRec.Body.Bytes(), &urlResolved))
	if len(urlResolved.Sources) != 2 || urlResolved.Sources[0].DefaultMode != "top_n" || urlResolved.Sources[1].DefaultMode != "all" {
		t.Fatalf("expected 2 URL sources with smart defaults, got %+v", urlResolved.Sources)
	}

	// Browse validation & dataset guard wired properly
	browseRec := doJSON("POST", "/api/v1/datasets/"+dsID+"/collect/browse", `{"source":{"id":"x","site":"pixiv","kind":"timeline","label":"a","unit_kind":"work","default_mode":"top_n"},"limit":999}`, "http://127.0.0.1:8787", nil)
	if browseRec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 on browse limit overflow, got %d body=%s", browseRec.Code, browseRec.Body.String())
	}

	// Submit without idempotency key returns 422 validation error (and 404 on unknown dataset)
	subRec := doJSON("POST", "/api/v1/datasets/"+dsID+"/collect/submit", `{"sources":[{"source":{"id":"x","site":"pixiv","kind":"timeline","label":"a","unit_kind":"work","default_mode":"top_n"},"range":{"mode":"top_n","top_n":10}}]}`, "http://127.0.0.1:8787", nil)
	if subRec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 on missing idempotency key, got %d body=%s", subRec.Code, subRec.Body.String())
	}

	missingDS := doJSON("POST", "/api/v1/datasets/does-not-exist/collect/resolve", `{"input":"silver_hair","sites":["danbooru"]}`, "http://127.0.0.1:8787", nil)
	if missingDS.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing dataset, got %d body=%s", missingDS.Code, missingDS.Body.String())
	}

	capacity := doJSON("GET", "/api/v1/collect/preview-capacity/pixiv", "", "http://127.0.0.1:8787", nil)
	var window map[string]int
	nativeOK(t, json.Unmarshal(capacity.Body.Bytes(), &window))
	if limit, ok := window["limit"]; capacity.Code != http.StatusOK || !ok || limit < 0 || limit > 8 {
		t.Fatalf("unexpected preview capacity: %d %v", capacity.Code, window)
	}

	// Media endpoint responds 400 cleanly for invalid token when wired
	mediaRec := doJSON("GET", "/api/v1/collect/media/invalid", "", "http://127.0.0.1:8787", nil)
	if mediaRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on invalid media token, got %d body=%s", mediaRec.Code, mediaRec.Body.String())
	}
}
