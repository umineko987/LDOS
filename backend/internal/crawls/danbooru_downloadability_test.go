package crawls

import (
	"context"
	"net/url"
	"reflect"
	"testing"
	"time"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/gallery"
	"ldos/backend/internal/scheduler"
)

func TestPlanMediaSkipsUnavailableCandidates(t *testing.T) {
	missing, _ := discoverydata.DanbooruCandidate(map[string]any{"id": 1, "source": "https://www.pixiv.net/artworks/99"})
	preview, _ := discoverydata.DanbooruCandidate(map[string]any{"id": 2, "preview_file_url": "https://cdn.donmai.us/preview.jpg"})
	available, _ := discoverydata.DanbooruCandidate(map[string]any{"id": 3, "file_url": "https://cdn.donmai.us/original.jpg"})
	deleted, _ := discoverydata.DanbooruCandidate(map[string]any{"id": 4, "file_url": "https://cdn.donmai.us/deleted.jpg", "is_deleted": true})
	items := []map[string]any{missing, preview, {"downloadable": false, "media_count": 1000000}, available, deleted}
	s := &Service{}
	units, _, err := s.PlanMedia(context.Background(), items, scheduler.DefaultPolicy(), "direct", "", 2)
	if err != nil || len(units) != 2 || units[0].SourceID != "3" || units[1].SourceID != "4" {
		t.Fatalf("unavailable candidates consumed quota or reached planning: %v %v", units, err)
	}
	units, _, err = s.PlanMedia(context.Background(), items[:3], scheduler.DefaultPolicy(), "direct", "", 0)
	if err != nil || len(units) != 0 {
		t.Fatalf("unavailable-only plan: %v %v", units, err)
	}
}

func TestPlanMediaUnflaggedSitesRemainCompatible(t *testing.T) {
	s := &Service{}
	items := []map[string]any{
		{"id": "1", "site": "pixiv", "url": "https://www.pixiv.net/artworks/1"},
		{"id": "2", "site": "twitter", "url": "https://x.com/fixture/status/2"},
		{"id": "3", "site": "pawchive", "url": "https://pawchive.pw/patreon/user/fixture/post/3"},
		{"id": "4", "site": "danbooru", "url": "https://danbooru.donmai.us/posts/4"},
	}
	units, _, err := s.PlanMedia(context.Background(), items, scheduler.DefaultPolicy(), "direct", "", len(items))
	if err != nil || len(units) != len(items) {
		t.Fatalf("unflagged candidates rejected: %v %v", units, err)
	}
	for i, unit := range units {
		if unit.URL != items[i]["url"] || unit.Site != items[i]["site"] {
			t.Fatalf("candidate changed: %v", unit)
		}
	}
}

func TestDanbooruActivationFiltersUnavailablePosts(t *testing.T) {
	for _, tc := range []struct {
		name      string
		gallery   bool
		available bool
	}{
		{"API mixed", false, true},
		{"API unavailable only", false, false},
		{"DataJob mixed", true, true},
		{"DataJob unavailable only", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, db, _ := fixture(t)
			calls := 0
			s.deps.Discovery.Transport.HTTPRequest = func(_ context.Context, method, target string, params url.Values, body any, proxy string, timeout time.Duration) (discovery.HTTPResult, error) {
				if tc.gallery || target != "https://danbooru.donmai.us/posts.json" || method != "GET" {
					t.Fatalf("unexpected API request: %s %s", method, target)
				}
				calls++
				posts := []any{
					map[string]any{"id": 1, "tag_string_artist": "fixture_artist"},
					map[string]any{"id": 2, "preview_file_url": "https://cdn.donmai.us/preview.jpg"},
				}
				if tc.available {
					posts = append(posts,
						map[string]any{"id": 3, "file_url": "https://cdn.donmai.us/original.jpg"},
						map[string]any{"id": 4, "file_url": "https://cdn.donmai.us/deleted.jpg", "is_deleted": true},
					)
				}
				return discovery.HTTPResult{StatusCode: 200, Payload: posts}, nil
			}
			s.deps.Discovery.Transport.Gallery = captureFunc(func(context.Context, gallery.CaptureRequest) (gallery.CaptureResult, error) {
				if !tc.gallery {
					t.Fatal("unexpected gallery fallback")
				}
				calls++
				stdout := `[[2,{"id":1,"tags_artist":["fixture_artist"]}],[2,{"id":2,"preview_file_url":"https://cdn.donmai.us/preview.jpg"}]]`
				if tc.available {
					stdout = `[[2,{"id":1}],[2,{"id":2,"preview_file_url":"https://cdn.donmai.us/preview.jpg"}],[2,{"id":3,"preview_file_url":"https://cdn.donmai.us/preview.jpg"}],[3,"https://cdn.donmai.us/original.jpg",{"id":3}],[2,{"id":4,"file_url":"https://cdn.donmai.us/deleted.jpg","is_deleted":true}]]`
				}
				return gallery.CaptureResult{Stdout: stdout}, nil
			})
			target := "https://danbooru.donmai.us/posts?tags=fixture_artist"
			if tc.gallery {
				target = "https://danbooru.donmai.us/posts/42"
			}
			r := batchRequest(target)
			r.Sources[0].Site = "danbooru"
			b := createBatch(t, s, r)
			ctx := context.Background()
			good(t, s.RunOnce(ctx))
			rows, err := db.QueryRows(ctx, "SELECT url FROM tasks ORDER BY url")
			good(t, err)
			got := []string{}
			for _, row := range rows {
				got = append(got, str(row["url"]))
			}
			want := []string{}
			if tc.available {
				want = []string{"https://danbooru.donmai.us/posts/3", "https://danbooru.donmai.us/posts/4"}
			}
			if !reflect.DeepEqual(got, want) || calls != 1 {
				t.Fatalf("scheduled URLs: %v; want: %v; discovery calls: %d", got, want, calls)
			}
			b, err = s.Get(ctx, str(b["id"]))
			good(t, err)
			a := batchAddresses(b)[0]
			if tc.available {
				if a["status"] != "running" || integer(a["planned_task_count"]) != 2 {
					t.Fatalf("mixed address blocked: %v", a)
				}
			} else if a["status"] != "failed" || integer(a["planned_task_count"]) != 0 || a["last_error"] != "该地址没有发现可下载图片" {
				t.Fatalf("unavailable-only address: %v", a)
			}
		})
	}
}
