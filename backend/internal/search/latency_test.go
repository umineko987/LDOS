package search

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/scheduler"
)

func ehResult() map[string]any {
	r := emptyResult()
	r["candidate_count"] = 1
	r["candidates"] = []map[string]any{{"id": "123", "url": "https://e-hentai.org/g/123/abcdef/", "title": "fixture", "metadata": map[string]any{"gallery_token": "abcdef", "title": "fixture"}}}
	return r
}

func TestSearchDeadlineBoundsPrimaryRequest(t *testing.T) {
	var active atomic.Int32
	s := fixtureService(t, fakeEngine{search: func(ctx context.Context, _ discovery.Request) (map[string]any, error) {
		active.Add(1)
		defer active.Add(-1)
		<-ctx.Done()
		return nil, ctx.Err()
	}})
	body := request(t, `{"keyword":"fixture","sites":["exhentai"]}`)
	body.TimeoutSeconds = .025
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	result, err := s.Perform(ctx, body)
	if err != nil {
		t.Fatalf("source timeout escaped as whole request failure: %v", err)
	}
	source := rows(result["sources"])[0]
	if source["status"] != "failed" || source["error"].(map[string]any)["code"] != "search_timeout" || active.Load() != 0 {
		t.Fatal(source, active.Load())
	}
}

func TestSlowAliasesDoNotHoldPrimaryEHResults(t *testing.T) {
	var active atomic.Int32
	s := fixtureService(t, fakeEngine{artists: func(context.Context, discovery.Request) (map[string]any, error) { return directory(), nil }, search: func(ctx context.Context, r discovery.Request) (map[string]any, error) {
		if *r.Keyword == "fixture" {
			return ehResult(), nil
		}
		active.Add(1)
		defer active.Add(-1)
		<-ctx.Done()
		return nil, ctx.Err()
	}})
	s.aliasWait = 15 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	result, err := s.Perform(ctx, request(t, `{"keyword":"fixture","sites":["exhentai"]}`))
	if err != nil {
		t.Fatal("primary result was held by optional alias searches", err)
	}
	source := rows(result["sources"])[0]
	if source["status"] != "partial" || count(source["evidence_count"]) != 1 || active.Load() != 0 {
		t.Fatal(source, active.Load())
	}
}

type slowPreviewEngine struct{ fakeEngine }

func (e slowPreviewEngine) EnrichPreviews(ctx context.Context, _ map[string]any, _ scheduler.Policy, _ string, _ float64) (map[string]any, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}
func TestSlowPreviewsKeepEHResults(t *testing.T) {
	engine := fakeEngine{search: func(context.Context, discovery.Request) (map[string]any, error) { return ehResult(), nil }}
	s := fixtureService(t, engine)
	s.deps.Discovery = slowPreviewEngine{engine}
	s.previewWait = 15 * time.Millisecond
	// The parent deadline keeps a regression from hanging the test process.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	result, err := s.Perform(ctx, request(t, `{"keyword":"fixture","sites":["exhentai"]}`))
	if err != nil {
		t.Fatal("primary result was held by optional previews", err)
	}
	source := rows(result["sources"])[0]
	if source["status"] != "partial" || count(source["evidence_count"]) != 1 || count(source["preview_missing_count"]) != 1 {
		t.Fatal(source)
	}
}
