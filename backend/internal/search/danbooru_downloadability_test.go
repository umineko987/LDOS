package search

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/discoverydata"
)

func TestDesktopSearchKeepsUnavailableDanbooruPostTags(t *testing.T) {
	for _, tc := range []struct{ keyword, kind string }{{"fixture_artist", "artist_tag"}, {"fixture_character", "character_tag"}} {
		t.Run(tc.kind, func(t *testing.T) {
			candidate, authors := discoverydata.DanbooruCandidate(map[string]any{
				"id": 42, "tag_string_artist": "fixture_artist", "tag_string_character": "fixture_character",
			})
			if candidate["downloadable"] != false {
				t.Fatal("fixture must be unavailable")
			}
			s := fixtureService(t, fakeEngine{search: func(context.Context, discovery.Request) (map[string]any, error) {
				return map[string]any{"candidates": []map[string]any{candidate}, "authors": authors, "candidate_count": 1}, nil
			}})
			body := fmt.Sprintf(`{"keyword":%q,"sites":["danbooru"]}`, tc.keyword)
			r := httptest.NewRequest("POST", "/api/v1/search?view=desktop", strings.NewReader(body))
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != 200 {
				t.Fatalf("search status %d: %s", w.Code, w.Body)
			}
			var result map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			sources := rows(result["sources"])
			if result["response_profile"] != "desktop" || len(sources) != 1 || sources[0]["status"] != "succeeded" {
				t.Fatalf("search result: %v", result)
			}
			addresses := rows(sources[0]["addresses"])
			if len(addresses) != 1 || addresses[0]["address_type"] != tc.kind || addresses[0]["url"] != "https://danbooru.donmai.us/posts?tags="+tc.keyword {
				t.Fatalf("tag address lost: %v", addresses)
			}
			if _, exists := addresses[0]["downloadable"]; exists {
				t.Fatalf("post availability leaked onto tag: %v", addresses[0])
			}
		})
	}
}
