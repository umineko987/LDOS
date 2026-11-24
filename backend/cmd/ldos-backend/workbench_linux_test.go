package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ldos/backend/internal/datasets"
	"ldos/backend/internal/gallery"
	"ldos/backend/internal/network"
	"ldos/backend/internal/workbench"
)

type workbenchFixtureCapture struct{ t *testing.T }

func (f workbenchFixtureCapture) Capture(_ context.Context, request gallery.CaptureRequest) (gallery.CaptureResult, error) {
	if request.URL != "https://www.pixiv.net/users/9/artworks" || request.Site != "pixiv" {
		f.t.Fatalf("unexpected discovery request %s %s", request.Site, request.URL)
	}
	return gallery.CaptureResult{Stdout: `[[2,{"id":101,"title":"Selected","page_count":2,"user":{"name":"Fixture"}}],[3,"https://i.pximg.net/img-original/img/2025/01/01/00/00/00/101_p0.jpg",{"id":101}],[2,{"id":102,"title":"Outside prefix"}]]`}, nil
}

type workbenchFixtureValidator struct{ network.URLValidator }

func (v workbenchFixtureValidator) ValidateDirect(_ context.Context, target string) ([]string, error) {
	_, err := v.ValidateStatic(target)
	return []string{"192.0.2.1"}, err
}

func TestNativeWorkbenchBrowseAndCollect(t *testing.T) {
	b, _ := nativeBusinessFixture(t, false)
	// Leave the real crawl creation and dataset registration wired, without executing queued work.
	nativeOK(t, b.crawls.Stop())
	b.discovery.Transport.Gallery = workbenchFixtureCapture{t}
	b.discovery.Transport.Validator = workbenchFixtureValidator{}
	dataset, err := b.datasets.Create(b.ctx, datasets.CreateOptions{Name: "Workbench", Kind: "character"})
	nativeOK(t, err)
	datasetID := valueString(dataset["dataset_id"])
	mux := http.NewServeMux()
	b.register(mux)
	post := func(action, body, key string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/"+datasetID+"/workbench/"+action, strings.NewReader(body))
		r.Header.Set("Idempotency-Key", key)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	browse := post("browse", `{"site":"pixiv","url":"https://pixiv.net/users/9","limit":1}`, "")
	var result workbench.BrowseResult
	if err := json.Unmarshal(browse.Body.Bytes(), &result); browse.Code != 200 || err != nil || !result.HasMore || len(result.Items) != 1 || result.Items[0].ID != "101" || result.Items[0].MediaCount != 2 || !strings.HasPrefix(result.Items[0].PreviewURL, "/api/v1/datasets/"+datasetID+"/workbench/media/") {
		t.Fatalf("browse %d: %s (%v)", browse.Code, browse.Body.String(), err)
	}
	outside := post("collect", `{"snapshot_id":"`+result.SnapshotID+`","ids":["102"]}`, "outside")
	if outside.Code != 422 {
		t.Fatalf("outside prefix %d: %s", outside.Code, outside.Body.String())
	}
	body := `{"snapshot_id":"` + result.SnapshotID + `","ids":["101"]}`
	first, replay := post("collect", body, "same-key"), post("collect", body, "same-key")
	var collected struct {
		BatchID string `json:"batch_id"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &collected); first.Code != 200 || replay.Code != 200 || err != nil || collected.BatchID == "" || first.Body.String() != replay.Body.String() {
		t.Fatalf("collect %d %s, replay %d %s (%v)", first.Code, first.Body.String(), replay.Code, replay.Body.String(), err)
	}
	rows, err := b.db.QueryRows(b.ctx, "SELECT batch_id, url, address_type FROM crawl_addresses")
	nativeOK(t, err)
	if len(rows) != 1 || rows[0]["batch_id"] != collected.BatchID || rows[0]["url"] != "https://www.pixiv.net/artworks/101" || rows[0]["address_type"] != "workbench_work" {
		t.Fatalf("unexpected crawl addresses: %+v", rows)
	}
	links, err := b.datasets.ListCrawls(b.ctx, datasetID)
	nativeOK(t, err)
	if len(links) != 1 || links[0]["batch_id"] != collected.BatchID {
		t.Fatalf("unexpected dataset links: %+v", links)
	}
}
