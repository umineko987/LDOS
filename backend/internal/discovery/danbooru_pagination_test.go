package discovery

import (
	"context"
	"net/url"
	"strconv"
	"testing"
	"time"
)

func TestDanbooruAscendingPaginationReversesLaterPages(t *testing.T) {
	for _, order := range []string{"order:id", "order:id_asc"} {
		t.Run(order, func(t *testing.T) {
			a, _, _ := danTestAdapter()
			request := danTestRequest()
			keyword := "fixture " + order
			request.Keyword, request.Limit = &keyword, 402
			calls := 0
			a.Transport.HTTPRequest = func(_ context.Context, _, _ string, params url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
				calls++
				rows := []map[string]any{}
				switch calls {
				case 1:
					if params.Get("page") != "" || params.Get("limit") != "200" {
						t.Fatal(params)
					}
					for id := 1; id <= 200; id++ {
						rows = append(rows, map[string]any{"id": id})
					}
				case 2:
					if params.Get("page") != "a200" || params.Get("limit") != "200" {
						t.Fatal(params)
					}
					for id := 400; id >= 201; id-- {
						rows = append(rows, map[string]any{"id": id})
					}
				case 3:
					if params.Get("page") != "a400" || params.Get("limit") != "2" {
						t.Fatal(params)
					}
					rows = []map[string]any{{"id": 402}, {"id": 401}}
				default:
					t.Fatal("unbounded pagination")
				}
				return HTTPResult{StatusCode: 200, Payload: rows}, nil
			}
			result, err := a.SearchPostsAPI(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			rows := result["candidates"].([]map[string]any)
			if len(rows) != 402 || calls != 3 {
				t.Fatalf("posts %d requests %d", len(rows), calls)
			}
			for i, row := range rows {
				if row["id"] != strconv.Itoa(i+1) {
					t.Fatalf("ascending position %d = %v", i, row["id"])
				}
			}
		})
	}
}

func TestDanbooruOrderedPaginationKeepsPageSize(t *testing.T) {
	for _, term := range []string{"order:score", "order:updated_at", "id:1,2,3", "md5:fixture", "ordfav:fixture", "ordfavgroup:1", "ordpool:1 order:id_desc"} {
		t.Run(term, func(t *testing.T) {
			a, _, _ := danTestAdapter()
			request := danTestRequest()
			keyword := "fixture " + term
			request.Keyword, request.Limit = &keyword, 202
			calls := 0
			a.Transport.HTTPRequest = func(_ context.Context, _, _ string, params url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
				calls++
				if calls > 2 || params.Get("limit") != "200" || params.Get("page") != strconv.Itoa(calls) {
					t.Fatal(params)
				}
				rows := []map[string]any{}
				for i := (calls - 1) * 200; i < calls*200; i++ {
					rows = append(rows, map[string]any{"id": 1000 - i})
				}
				return HTTPResult{StatusCode: 200, Payload: rows}, nil
			}
			result, err := a.SearchPostsAPI(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			rows := result["candidates"].([]map[string]any)
			if len(rows) != 202 || rows[200]["id"] != "800" || rows[201]["id"] != "799" || calls != 2 {
				t.Fatal("ordered pagination skipped posts", result)
			}
		})
	}
}

func TestDanbooruPaginationStopsWhenIDsDoNotProgress(t *testing.T) {
	for _, term := range []string{"order:score", "order:id_asc", "order:id_desc"} {
		t.Run(term, func(t *testing.T) {
			a, _, _ := danTestAdapter()
			request := danTestRequest()
			keyword := "fixture " + term
			request.Keyword, request.Limit = &keyword, 202
			calls := 0
			a.Transport.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
				calls++
				if calls > 2 {
					t.Fatal("pagination failed to stop")
				}
				rows := []map[string]any{}
				for i := 0; i < 200; i++ {
					rows = append(rows, map[string]any{"id": 1000 - i})
				}
				return HTTPResult{StatusCode: 200, Payload: rows}, nil
			}
			_, err := a.SearchPostsAPI(context.Background(), request)
			danErrorCode(t, err, "danbooru_api_protocol")
			if calls != 2 {
				t.Fatalf("requests %d", calls)
			}
		})
	}
}
