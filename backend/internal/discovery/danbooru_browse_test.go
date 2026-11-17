package discovery

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"ldos/backend/internal/danboorurate"
	"ldos/backend/internal/gallery"
)

func danBrowseTestPost(id int) map[string]any {
	return map[string]any{"id": id, "file_url": fmt.Sprintf("https://cdn.donmai.us/%d.jpg", id)}
}

func danBrowseTestIDs(page *DanbooruBrowsePage) []string {
	ids := []string{}
	for _, post := range page.Items {
		ids = append(ids, post.ID)
	}
	return ids
}

func TestDanbooruBrowseSearchPagination(t *testing.T) {
	for _, tc := range []struct {
		query      string
		first      []int
		second     []int
		secondPage string
		want       []string
	}{
		{"fixture", []int{10, 9}, []int{8, 7}, "b9", []string{"8", "7"}},
		{"fixture order:id_desc", []int{10, 9}, []int{8, 7}, "b9", []string{"8", "7"}},
		{"fixture order:id", []int{1, 2}, []int{4, 3}, "a2", []string{"3", "4"}},
		{"fixture order:id_asc", []int{1, 2}, []int{4, 3}, "a2", []string{"3", "4"}},
		{"fixture order:score", []int{40, 10}, []int{20, 30}, "2", []string{"20", "30"}},
		{"id:40,10,20,30", []int{40, 10}, []int{20, 30}, "2", []string{"20", "30"}},
	} {
		t.Run(tc.query, func(t *testing.T) {
			a, pool, _ := danTestAdapter()
			calls := 0
			a.GalleryDiscover = func(context.Context, Request) (map[string]any, error) {
				t.Fatal("Browse must not use gallery-dl extraction")
				return nil, nil
			}
			a.Transport.HTTPRequest = func(_ context.Context, method, target string, params url.Values, _ any, endpoint string, _ time.Duration) (HTTPResult, error) {
				calls++
				wantPage := ""
				if danPagePrefix(tc.query) == "" {
					wantPage = "1"
				}
				ids := tc.first
				if calls == 2 {
					wantPage, ids = tc.secondPage, tc.second
				}
				if calls > 2 || method != "GET" || target != danBaseURL+"/posts.json" || params.Get("tags") != tc.query || params.Get("limit") != "2" || params.Get("page") != wantPage || endpoint != "" {
					t.Fatalf("call %d: %s %s %v endpoint=%q", calls, method, target, params, endpoint)
				}
				rows := []map[string]any{}
				for _, id := range ids {
					rows = append(rows, danBrowseTestPost(id))
				}
				return HTTPResult{StatusCode: 200, Payload: rows}, nil
			}
			opt := DanbooruBrowseOptions{Kind: "search", Query: tc.query, Limit: 2}
			first, err := a.Browse(context.Background(), danTestRequest(), opt)
			if err != nil || first.NextCursor == "" {
				t.Fatalf("first=%+v error=%v", first, err)
			}
			opt.Cursor = first.NextCursor
			second, err := a.Browse(context.Background(), danTestRequest(), opt)
			if err != nil || !reflect.DeepEqual(danBrowseTestIDs(second), tc.want) || len(pool.acquired) != 0 {
				t.Fatalf("second=%+v error=%v proxy acquisitions=%d", second, err, len(pool.acquired))
			}
			changed := opt
			changed.Limit = 1
			_, err = a.Browse(context.Background(), danTestRequest(), changed)
			danErrorCode(t, err, "invalid_danbooru_browse")
			changed = opt
			changed.Query += " other"
			_, err = a.Browse(context.Background(), danTestRequest(), changed)
			danErrorCode(t, err, "invalid_danbooru_browse")
		})
	}
}

func TestDanbooruBrowseCountAndDefaultLimit(t *testing.T) {
	for _, status := range []int{200, 403} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			a, _, _ := danTestAdapter()
			postCalls, countCalls := 0, 0
			a.Transport.HTTPRequest = func(_ context.Context, _ string, target string, params url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
				if params.Get("tags") != "fixture" {
					t.Fatal(params)
				}
				if target == danBaseURL+"/counts/posts.json" {
					countCalls++
					return HTTPResult{StatusCode: status, Payload: map[string]any{"counts": map[string]any{"posts": 123}}}, nil
				}
				postCalls++
				if params.Get("limit") != "48" {
					t.Fatal(params)
				}
				rows := []any{}
				for id := 100; id > 52; id-- {
					if postCalls > 1 {
						rows = append(rows, danBrowseTestPost(id-48))
					} else {
						rows = append(rows, danBrowseTestPost(id))
					}
				}
				return HTTPResult{StatusCode: 200, Payload: rows}, nil
			}
			opt := DanbooruBrowseOptions{Kind: "search", Query: "fixture", Count: true}
			page, err := a.Browse(context.Background(), danTestRequest(), opt)
			if err != nil || len(page.Items) != 48 || countCalls != 1 {
				t.Fatalf("page=%+v count=%d error=%v", page, countCalls, err)
			}
			if status == 200 {
				if page.Total == nil || *page.Total != 123 || len(page.Warnings) != 0 {
					t.Fatal(page)
				}
			} else if page.Total != nil || len(page.Warnings) != 1 {
				t.Fatal(page)
			}
			opt.Cursor = page.NextCursor
			page, err = a.Browse(context.Background(), danTestRequest(), opt)
			if err != nil || countCalls != 1 || page.Total != nil {
				t.Fatalf("page=%+v count=%d error=%v", page, countCalls, err)
			}
		})
	}
}

func TestDanbooruBrowseCollectionsOrderMissingAndBeyond100(t *testing.T) {
	for _, kind := range []string{"pool", "favorite_group"} {
		t.Run(kind, func(t *testing.T) {
			a, _, _ := danTestAdapter()
			path := "/pools/7"
			if kind == "favorite_group" {
				path = "/favorite_groups/7"
			}
			ids := []any{}
			for id := 120; id > 0; id-- {
				ids = append(ids, id)
			}
			metadataCalls, batchCalls := 0, 0
			a.Transport.HTTPRequest = func(_ context.Context, _ string, target string, params url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
				if target == danBaseURL+path+".json" {
					metadataCalls++
					return HTTPResult{StatusCode: 200, Payload: map[string]any{"name": "ordered fixture", "post_ids": ids, "updated_at": "2026-11-17T00:00:00Z"}}, nil
				}
				batchCalls++
				if target != danBaseURL+"/posts.json" {
					t.Fatal(target)
				}
				batch := strings.Split(strings.TrimPrefix(params.Get("tags"), "id:"), ",")
				if len(batch) > 50 || params.Get("limit") != strconv.Itoa(len(batch)) {
					t.Fatal(params)
				}
				rows := []map[string]any{}
				for i := len(batch) - 1; i >= 0; i-- {
					id, _ := strconv.Atoi(batch[i])
					if id != 119 {
						rows = append(rows, danBrowseTestPost(id))
					}
				}
				return HTTPResult{StatusCode: 200, Payload: rows}, nil
			}
			opt := DanbooruBrowseOptions{Kind: kind, Reference: danBaseURL + path, Limit: 100}
			first, err := a.Browse(context.Background(), danTestRequest(), opt)
			if err != nil || len(first.Items) != 100 || *first.Total != 120 || first.Source.Name != "ordered fixture" || first.Source.ID != "7" || first.Items[0].ID != "120" || first.Items[99].ID != "21" {
				t.Fatalf("page=%+v error=%v", first, err)
			}
			missing := first.Items[1]
			if missing.ID != "119" || missing.Downloadable || missing.UnavailableReason != "post_unavailable" || missing.URL != danBaseURL+"/posts/119" {
				t.Fatal(missing)
			}
			cursor, err := danBrowseDecode(first.NextCursor)
			if err != nil || cursor.Offset != 100 || cursor.UpdatedAt == "" {
				t.Fatalf("cursor=%+v error=%v", cursor, err)
			}
			opt.Cursor = first.NextCursor
			second, err := a.Browse(context.Background(), danTestRequest(), opt)
			if err != nil || len(second.Items) != 20 || second.Items[0].ID != "20" || second.Items[19].ID != "1" || second.NextCursor != "" || metadataCalls != 2 || batchCalls != 3 {
				t.Fatalf("page=%+v error=%v metadata=%d batches=%d", second, err, metadataCalls, batchCalls)
			}
		})
	}
}

func TestDanbooruBrowseFavoriteGroupRevisionAndPrivateErrors(t *testing.T) {
	for _, kind := range []string{"pool", "favorite_group"} {
		t.Run(kind, func(t *testing.T) {
			a, _, _ := danTestAdapter()
			revision := "first"
			status := 200
			postCalls := 0
			a.Transport.HTTPRequest = func(_ context.Context, _ string, target string, _ url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
				if strings.HasSuffix(target, "/posts.json") {
					postCalls++
					return HTTPResult{StatusCode: 200, Payload: []any{danBrowseTestPost(1)}}, nil
				}
				return HTTPResult{StatusCode: status, Payload: map[string]any{"post_ids": []int{1, 2}, "updated_at": revision}}, nil
			}
			opt := DanbooruBrowseOptions{Kind: kind, Reference: "7", Limit: 1}
			page, err := a.Browse(context.Background(), danTestRequest(), opt)
			if err != nil {
				t.Fatal(err)
			}
			opt.Cursor, revision = page.NextCursor, "second"
			_, err = a.Browse(context.Background(), danTestRequest(), opt)
			public := danErrorCode(t, err, "invalid_danbooru_browse")
			if !strings.Contains(public.Message, "重新加载") || postCalls != 1 {
				t.Fatal(public, postCalls)
			}
			status = 403
			page, err = a.Browse(context.Background(), danTestRequest(), opt)
			danErrorCode(t, err, "danbooru_api_failed")
			if page != nil {
				t.Fatal("private collection must not appear empty", page)
			}
		})
	}
}

func TestDanbooruBrowseFavoritesIdentityAndOrder(t *testing.T) {
	for _, tc := range []struct {
		reference string
		identity  string
	}{
		{"fixture_user", ""},
		{"", "/profile.json"},
		{danBaseURL + "/favorites", "/profile.json"},
		{danBaseURL + "/users/42", "/users/42.json"},
		{danBaseURL + "/users/42/favorites", "/users/42.json"},
		{danBaseURL + "/favorites?user_id=42", "/users/42.json"},
		{danBaseURL + "/posts?tags=ordfav%3Afixture_user", ""},
	} {
		t.Run(tc.reference, func(t *testing.T) {
			a, _, _ := danTestAdapter()
			identityCalls, postsCalls := 0, 0
			a.Transport.HTTPRequest = func(_ context.Context, _ string, target string, params url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
				if tc.identity != "" && target == danBaseURL+tc.identity {
					identityCalls++
					return HTTPResult{StatusCode: 200, Payload: map[string]any{"id": 42, "name": "fixture_user", "level": 20}}, nil
				}
				postsCalls++
				if target != danBaseURL+"/posts.json" || params.Get("tags") != "ordfav:fixture_user" || params.Get("page") != strconv.Itoa(postsCalls) || params.Get("limit") != "2" {
					t.Fatalf("%s %v", target, params)
				}
				return HTTPResult{StatusCode: 200, Payload: []any{danBrowseTestPost(3), danBrowseTestPost(99)}}, nil
			}
			opt := DanbooruBrowseOptions{Kind: "favorites", Reference: tc.reference, Limit: 2}
			page, err := a.Browse(context.Background(), danTestRequest(), opt)
			if err != nil || page.Source.Name != "fixture_user" || !reflect.DeepEqual(danBrowseTestIDs(page), []string{"3", "99"}) {
				t.Fatalf("page=%+v error=%v", page, err)
			}
			opt.Cursor = page.NextCursor
			_, err = a.Browse(context.Background(), danTestRequest(), opt)
			wantIdentity := 0
			if tc.identity != "" {
				wantIdentity = 2
			}
			if err != nil || identityCalls != wantIdentity || postsCalls != 2 {
				t.Fatalf("error=%v identity=%d posts=%d", err, identityCalls, postsCalls)
			}
		})
	}
}

func TestDanbooruBrowseFavoritesAnonymousAndPrivate(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		user   map[string]any
		code   string
	}{
		{"anonymous", 200, map[string]any{"name": "Anonymous", "level": 0}, "danbooru_auth_required"},
		{"anonymous flag", 200, map[string]any{"id": 42, "name": "fixture_user", "is_anonymous": true}, "danbooru_auth_required"},
		{"denied identity", 403, nil, "danbooru_api_failed"},
		{"denied favorites", 200, map[string]any{"id": 42, "name": "fixture_user"}, "danbooru_api_failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, _, _ := danTestAdapter()
			postsCalls := 0
			a.Transport.HTTPRequest = func(_ context.Context, _ string, target string, _ url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
				if target == danBaseURL+"/profile.json" {
					return HTTPResult{StatusCode: tc.status, Payload: tc.user}, nil
				}
				postsCalls++
				return HTTPResult{StatusCode: 403}, nil
			}
			page, err := a.Browse(context.Background(), danTestRequest(), DanbooruBrowseOptions{Kind: "favorites"})
			danErrorCode(t, err, tc.code)
			if page != nil || (postsCalls > 0) != (tc.name == "denied favorites") {
				t.Fatal(page, postsCalls)
			}
		})
	}
}

func TestDanbooruBrowseAuthenticationAndTimeout(t *testing.T) {
	for _, kind := range []string{"search", "pool", "favorite_group", "favorites"} {
		t.Run(kind, func(t *testing.T) {
			a, _, _ := danTestAdapter()
			request := danTestRequest()
			request.TimeoutSeconds = 0
			request.CredentialsRef = "fixture-credential"
			resolved, calls := 0, 0
			headers := http.Header{"Authorization": {"Basic fixture-secret"}, "Cookie": {"session=fixture-cookie"}}
			a.Transport.Gallery = danAuthTestCapturer{resolve: func(ctx context.Context, got gallery.Request) (http.Header, error) {
				resolved++
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) < 59*time.Second || got.CredentialsRef != request.CredentialsRef || got.Site != "danbooru" {
					t.Fatalf("auth request=%+v deadline=%v", got, deadline)
				}
				return headers, nil
			}}
			a.Transport.HTTPRequest = func(ctx context.Context, _ string, target string, params url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
				calls++
				if !reflect.DeepEqual(danbooruRequestHeaders(ctx), headers) || strings.Contains(target+params.Encode(), "fixture-secret") {
					t.Fatalf("auth context missing or auth leaked into URL: %s", target)
				}
				if strings.HasSuffix(target, "profile.json") {
					return HTTPResult{StatusCode: 200, Payload: map[string]any{"id": 42, "name": "fixture_user"}}, nil
				}
				if strings.Contains(target, "/pools/") || strings.Contains(target, "/favorite_groups/") {
					return HTTPResult{StatusCode: 200, Payload: map[string]any{"post_ids": []int{1}, "updated_at": "v1"}}, nil
				}
				if strings.Contains(target, "/counts/") {
					return HTTPResult{StatusCode: 200, Payload: map[string]any{"counts": map[string]any{"posts": 1}}}, nil
				}
				return HTTPResult{StatusCode: 200, Payload: []any{danBrowseTestPost(1)}}, nil
			}
			opt := DanbooruBrowseOptions{Kind: kind, Count: true}
			if kind == "pool" || kind == "favorite_group" {
				opt.Reference = "7"
			}
			page, err := a.Browse(context.Background(), request, opt)
			if err != nil || resolved != 1 || calls < 2 {
				t.Fatalf("page=%+v error=%v resolved=%d calls=%d", page, err, resolved, calls)
			}
			data, _ := json.Marshal(page)
			if strings.Contains(string(data), "fixture-secret") || strings.Contains(string(data), "fixture-cookie") {
				t.Fatal("credential leaked into response")
			}
		})
	}
	for _, cancelParent := range []bool{false, true} {
		t.Run(fmt.Sprintf("cancel=%v", cancelParent), func(t *testing.T) {
			a, _, _ := danTestAdapter()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			a.Transport.HTTPRequest = func(ctx context.Context, _ string, _ string, _ url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
				if cancelParent {
					cancel()
				}
				<-ctx.Done()
				return HTTPResult{}, ctx.Err()
			}
			request := danTestRequest()
			request.TimeoutSeconds = .01
			_, err := a.Browse(ctx, request, DanbooruBrowseOptions{Kind: "search"})
			if cancelParent {
				if !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
			} else {
				danErrorCode(t, err, "discovery_failed")
			}
		})
	}
}

func TestDanbooruBrowseValidation(t *testing.T) {
	badCursor := func(page string) string {
		return danBrowseEncode(danBrowseCursor{Version: 1, Kind: "search", Key: "", Limit: 48, Page: page})
	}
	cases := []DanbooruBrowseOptions{
		{Kind: "other"}, {Kind: "search", Limit: -1}, {Kind: "search", Limit: 101},
		{Kind: "search", Query: strings.Repeat("x", 1001)}, {Kind: "search", Reference: strings.Repeat("x", 1001)},
		{Kind: "search", Cursor: strings.Repeat("x", 2049)}, {Kind: "search", Cursor: "broken"},
		{Kind: "search", Cursor: badCursor("a9")}, {Kind: "search", Cursor: badCursor("b0")},
		{Kind: "search", Cursor: badCursor("b-1")}, {Kind: "search", Cursor: badCursor("b1&limit=1")},
		{Kind: "search", Cursor: base64.RawURLEncoding.EncodeToString([]byte(`{"v":1} garbage`))},
	}
	for _, reference := range []string{"", "0", "-1", "https://evil.example/pools/1", "https://danbooru.donmai.us.evil.example/pools/1", "https://secret@danbooru.donmai.us/pools/1", "https://danbooru.donmai.us:99/pools/1", "//danbooru.donmai.us/pools/1", "https://danbooru.donmai.us/favorite_groups/1", "https://danbooru.donmai.us/pools/1?api_key=secret", "https://danbooru.donmai.us/pools/1/posts"} {
		cases = append(cases, DanbooruBrowseOptions{Kind: "pool", Reference: reference})
	}
	for _, reference := range []string{"https://evil.example/users/1", "https://danbooru.donmai.us/posts?tags=ordfav:name+order:id", "https://danbooru.donmai.us/posts?tags=ordfav:name&api_key=secret", "name order:id", "ordfav:name", "https://danbooru.donmai.us/users/0", "https://danbooru.donmai.us/pools/1"} {
		cases = append(cases, DanbooruBrowseOptions{Kind: "favorites", Reference: reference})
	}
	for i, opt := range cases {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			a, _, _ := danTestAdapter()
			a.Transport.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
				t.Fatal("invalid request reached HTTP")
				return HTTPResult{}, nil
			}
			_, err := a.Browse(context.Background(), danTestRequest(), opt)
			danErrorCode(t, err, "invalid_danbooru_browse")
		})
	}
}

func TestDanbooruBrowseMediaAndTags(t *testing.T) {
	a, _, _ := danTestAdapter()
	a.Transport.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
		return HTTPResult{StatusCode: 200, Payload: []any{map[string]any{
			"id": 7, "image_width": 1920, "image_height": 1080, "rating": "g", "score": 17, "file_ext": "png", "file_size": int64(5000000000),
			"tag_string_general": "one two", "tag_string_character": "character", "tag_string_artist": "artist", "tag_string_copyright": "work", "tag_string_meta": "highres",
			"source": "https://artist.example/art/7", "preview_file_url": "https://cdn.donmai.us/fallback-preview.jpg", "large_file_url": "https://cdn.donmai.us/fallback-sample.jpg",
			"media_asset": map[string]any{"variants": []any{
				map[string]any{"type": "180x180", "width": 180, "url": "https://cdn.donmai.us/180.jpg"},
				map[string]any{"type": "720x720", "width": 500, "url": "https://cdn.donmai.us/720.jpg"},
				map[string]any{"type": "360x360", "width": 250, "url": "https://cdn.donmai.us/360.jpg"},
				map[string]any{"type": "original", "width": 1920, "url": "https://cdn.donmai.us/original.png"},
			}},
		}, map[string]any{"id": 8, "source": "https://artist.example/not-a-preview", "preview_file_url": "https://cdn.donmai.us/preview.jpg", "large_file_url": "https://cdn.donmai.us/large.jpg"},
			map[string]any{"id": 9, "source": "https://artist.example/not-a-preview", "file_url": "https://user:secret@cdn.donmai.us/file.jpg", "preview_file_url": "https://cdn.donmai.us/p.jpg?api_key=secret"}}}, nil
	}
	page, err := a.Browse(context.Background(), danTestRequest(), DanbooruBrowseOptions{Kind: "search"})
	if err != nil {
		t.Fatal(err)
	}
	post := page.Items[0]
	if post.PreviewURL != "https://cdn.donmai.us/360.jpg" || post.SampleURL != "https://cdn.donmai.us/720.jpg" || !post.Downloadable || post.Width != 1920 || post.Height != 1080 || post.Score != 17 || post.FileSize != 5000000000 || post.FileExt != "png" || post.Rating != "g" || post.Title != "work" {
		t.Fatal(post)
	}
	if len(post.Tags) != 5 || !reflect.DeepEqual(post.Tags["general"], []string{"one", "two"}) || post.Tags["meta"][0] != "highres" {
		t.Fatal(post.Tags)
	}
	fallback := page.Items[1]
	if fallback.Downloadable || fallback.UnavailableReason == "" || fallback.PreviewURL != "https://cdn.donmai.us/preview.jpg" || fallback.SampleURL != "https://cdn.donmai.us/large.jpg" {
		t.Fatal(fallback)
	}
	unavailable := page.Items[2]
	if unavailable.Downloadable || unavailable.PreviewURL != "" || unavailable.SampleURL != "" {
		t.Fatal(unavailable)
	}
}

func TestDanbooruBrowseLongQueryCursor(t *testing.T) {
	for _, query := range []string{strings.Repeat("<", 1000), strings.Repeat("\"", 1000), "x" + strings.Repeat("\n", 998) + "y"} {
		a, _, _ := danTestAdapter()
		calls := 0
		a.Transport.HTTPRequest = func(_ context.Context, _ string, _ string, _ url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
			calls++
			return HTTPResult{StatusCode: 200, Payload: []any{danBrowseTestPost(10 - calls)}}, nil
		}
		opt := DanbooruBrowseOptions{Kind: "search", Query: query, Limit: 1}
		page, err := a.Browse(context.Background(), danTestRequest(), opt)
		if err != nil || len(page.NextCursor) > 2048 || page.NextCursor == "" {
			t.Fatalf("cursor length=%d error=%v", len(page.NextCursor), err)
		}
		opt.Cursor = page.NextCursor
		_, err = a.Browse(context.Background(), danTestRequest(), opt)
		if err != nil || calls != 2 {
			t.Fatalf("continuation failed: calls=%d error=%v", calls, err)
		}
	}
}

func TestDanbooruBrowseProtocolErrors(t *testing.T) {
	for _, tc := range []struct {
		name    string
		opt     DanbooruBrowseOptions
		payload any
	}{
		{"search shape", DanbooruBrowseOptions{Kind: "search"}, map[string]any{}},
		{"missing post ID", DanbooruBrowseOptions{Kind: "search"}, []any{map[string]any{"file_url": "https://cdn.donmai.us/file.jpg"}}},
		{"fractional post ID", DanbooruBrowseOptions{Kind: "search"}, []any{map[string]any{"id": 1.5}}},
		{"missing members", DanbooruBrowseOptions{Kind: "pool", Reference: "7"}, map[string]any{}},
		{"missing revision", DanbooruBrowseOptions{Kind: "favorite_group", Reference: "7", Limit: 1}, map[string]any{"post_ids": []int{1, 2}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, _, _ := danTestAdapter()
			a.Transport.HTTPRequest = func(_ context.Context, _ string, target string, _ url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
				payload := tc.payload
				if tc.opt.Kind != "search" && strings.HasSuffix(target, "/posts.json") {
					payload = []any{}
				}
				return HTTPResult{StatusCode: 200, Payload: payload}, nil
			}
			_, err := a.Browse(context.Background(), danTestRequest(), tc.opt)
			danErrorCode(t, err, "danbooru_api_protocol")
		})
	}
}

func TestDanbooruBrowseStopsOnAuthFailure(t *testing.T) {
	a, _, _ := danTestAdapter()
	a.Transport.Gallery = danAuthTestCapturer{resolve: func(context.Context, gallery.Request) (http.Header, error) {
		return nil, errors.New("fixture-secret")
	}}
	a.Transport.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
		t.Fatal("HTTP after auth failure")
		return HTTPResult{}, nil
	}
	_, err := a.Browse(context.Background(), danTestRequest(), DanbooruBrowseOptions{Kind: "search"})
	danErrorCode(t, err, "danbooru_auth_unavailable")
	if strings.Contains(err.Error(), "fixture-secret") {
		t.Fatal("credential leaked into error")
	}
}

func TestDanbooruBrowseSharesNativeRateLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), danboorurate.FileName)
	observed := []time.Time{}
	request := danTestRequest()
	request.TimeoutSeconds = 5
	for i := range 2 {
		a, _, _ := danTestAdapter()
		a.Transport.DanbooruRatePath = path
		a.Transport.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
			observed = append(observed, time.Now())
			return HTTPResult{StatusCode: 200, Payload: []any{}}, nil
		}
		var err error
		if i == 0 {
			_, err = a.Browse(context.Background(), request, DanbooruBrowseOptions{Kind: "search"})
		} else {
			_, err = a.SearchPostsAPI(context.Background(), request)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(observed) != 2 || observed[1].Sub(observed[0]) < 950*time.Millisecond {
		t.Fatal("Browse bypassed the native shared limiter", observed)
	}
}

func TestDanbooruBrowseCountTimeoutKeepsPosts(t *testing.T) {
	a, _, _ := danTestAdapter()
	a.Transport.HTTPRequest = func(ctx context.Context, method, target string, params url.Values, payload any, endpoint string, timeout time.Duration) (HTTPResult, error) {
		if strings.HasSuffix(target, "/counts/posts.json") {
			<-ctx.Done()
			return HTTPResult{}, ctx.Err()
		}
		return HTTPResult{StatusCode: 200, Payload: []map[string]any{danBrowseTestPost(1)}}, nil
	}
	request := danTestRequest()
	request.TimeoutSeconds = 1
	page, err := a.Browse(context.Background(), request, DanbooruBrowseOptions{Kind: "search", Query: "test", Count: true})
	if err != nil || page == nil || len(page.Items) != 1 || page.Total != nil || len(page.Warnings) == 0 {
		t.Fatalf("page=%+v err=%v", page, err)
	}
}
