package crawls

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"ldos/backend/internal/gallery"
)

func TestWorkbenchExactWorkActivation(t *testing.T) {
	cases := []struct {
		name, site, url, stdout string
		wantURL                 string
		wantArgs                []string
	}{
		{
			name: "pixiv with extra artwork", site: "pixiv", url: "https://www.pixiv.net/artworks/101",
			stdout:  `[[2,{"id":999,"page_count":12}],[2,{"id":101,"page_count":1}]]`,
			wantURL: "https://www.pixiv.net/artworks/101", wantArgs: []string{"--post-filter", "id == 101", "--filter", "id == 101", "--child-filter", "False"},
		},
		{
			name: "twitter uses only matched post media", site: "twitter", url: "https://x.com/example/status/101",
			stdout:  `[[2,{"tweet_id":999,"count":1}],[3,"https://pbs.twimg.com/media/extra.jpg",{"tweet_id":999}],[2,{"tweet_id":101,"count":1}],[3,"https://pbs.twimg.com/media/selected.jpg",{"tweet_id":101}]]`,
			wantURL: "https://pbs.twimg.com/media/selected.jpg", wantArgs: []string{},
		},
		{
			name: "twitter fallback restricts extractor output", site: "twitter", url: "https://x.com/example/status/101",
			stdout:  `[[2,{"tweet_id":999,"count":1}],[2,{"tweet_id":101,"count":1}],[3,"ytdl:https://x.com/i/web/status/101",{"tweet_id":101}]]`,
			wantURL: "https://x.com/i/web/status/101", wantArgs: []string{"--post-filter", "tweet_id == 101 and not (retweet_id or quote_id)", "--filter", "tweet_id == 101 and not (retweet_id or quote_id)", "--child-filter", "False"},
		},
		{
			name: "no matching work", site: "twitter", url: "https://x.com/example/status/101",
			stdout: `[[2,{"tweet_id":999,"count":1}]]`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, _, _ := fixture(t)
			ctx := context.Background()
			s.deps.Discovery.Transport.Gallery = captureFunc(func(_ context.Context, req gallery.CaptureRequest) (gallery.CaptureResult, error) {
				filter := "id == 101"
				if c.site == "twitter" {
					filter = "tweet_id == 101 and not (retweet_id or quote_id)"
				}
				want := []string{"--post-filter", filter, "--child-filter", "False"}
				if len(req.ExtraArgs) < 7 || !reflect.DeepEqual(req.ExtraArgs[3:7], want) {
					t.Fatalf("discovery args = %v, want %v after post range", req.ExtraArgs, want)
				}
				return gallery.CaptureResult{Stdout: c.stdout}, nil
			})
			batch := createBatch(t, s, Request{Concurrency: 1, MaxTasks: 1, Sources: []Source{{Site: c.site, Addresses: []Address{{URL: c.url, AddressType: ptr("workbench_work")}}}}})
			id := str(batch["id"])
			good(t, s.RunOnce(ctx))
			rows, err := s.ListTasks(ctx, id, "", 10, 0)
			good(t, err)
			if c.wantURL == "" {
				updated, err := s.Get(ctx, id)
				good(t, err)
				if len(rows) != 0 || updated["status"] != "completed_with_errors" {
					t.Fatal(rows, updated["status"])
				}
				return
			}
			if len(rows) != 1 || rows[0]["url"] != c.wantURL || !reflect.DeepEqual(stringsOf(rows[0]["extra_args"]), c.wantArgs) {
				t.Fatal(rows)
			}
		})
	}
}

func TestWorkbenchWorkRequiresSiteIDAndURLToMatch(t *testing.T) {
	target := "https://x.com/example/status/101"
	for _, c := range []map[string]any{
		{"site": "pixiv", "id": "101", "url": target},
		{"site": "twitter", "id": "999", "url": target},
		{"site": "twitter", "id": "101", "url": "https://x.com/example/status/999"},
	} {
		_, err := exactWorkCandidates("twitter", target, []map[string]any{c})
		var failure *Error
		if !errors.As(err, &failure) || failure.Code != "selected_work_not_found" {
			t.Fatal(c, err)
		}
	}
}
