package discovery

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"ldos/backend/internal/gallery"
	"ldos/backend/internal/scheduler"
)

func TestBrowseTimelineFixtures(t *testing.T) {
	for _, tc := range []struct {
		site, source, target, fixture string
		args                          []string
		want                          []map[string]any
	}{
		{
			site: "pixiv", source: "http://pixiv.net/en/users/42/?from=profile", target: "https://www.pixiv.net/users/42/artworks", fixture: "timeline-pixiv.json",
			args: []string{"--dump-json", "--post-range", "1-11", "--filter", "num == 0"},
			want: []map[string]any{
				work("904", "Manga", "Pixiv Artist", 3, "https://www.pixiv.net/artworks/904", "https://i.pximg.net/img-master/img/2025/04/07/03/02/01/904_p0_master1200.jpg"),
				work("901", "Animation", "Pixiv Artist", 1, "https://www.pixiv.net/artworks/901", ""),
				work("902", "Locked", "Pixiv Artist", 0, "https://www.pixiv.net/artworks/902", ""),
				work("910", "Unsafe thumbnail", "Pixiv Artist", 1, "https://www.pixiv.net/artworks/910", ""),
			},
		},
		{
			site: "x", source: "https://twitter.com/Some_Artist/media/?s=12", target: "https://x.com/some_artist/media", fixture: "timeline-x.json",
			args: []string{"--dump-json", "--post-range", "1-11", "--post-filter", "not (retweet_id or quote_id)"},
			want: []map[string]any{
				work("1909690278356479999", "Own photo in a quote", "X Artist", 2, "https://x.com/some_artist/status/1909690278356479999", "https://pbs.twimg.com/media/Photo_One?format=jpg&name=small"),
				work("1909690278356470001", "Video without poster", "X Artist", 1, "https://x.com/some_artist/status/1909690278356470001", ""),
				work("1909690278356459999", "Video with poster", "X Artist", 1, "https://x.com/some_artist/status/1909690278356459999", "https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/Poster?format=jpg&name=small"),
			},
		},
	} {
		t.Run(tc.site, func(t *testing.T) {
			fixture, err := os.ReadFile("testdata/" + tc.fixture)
			if err != nil {
				t.Fatal(err)
			}
			validator := &transportValidator{}
			tr := nativeTransport(t, &transportPool{}, validator)
			tr.Gallery = captureFunc(func(_ context.Context, req gallery.CaptureRequest) (gallery.CaptureResult, error) {
				if req.URL != tc.target || !reflect.DeepEqual(req.ExtraArgs, tc.args) || req.TaskTimeout != 60*time.Second || req.CookiesFile != "fixture-cookies" || req.ConfigFile != "fixture-config" {
					t.Fatalf("unexpected capture request: %+v", req)
				}
				return gallery.CaptureResult{Stdout: string(fixture)}, nil
			})
			rangeOverride := 99999
			items, more, err := New(tr).BrowseTimeline(context.Background(), Request{Site: tc.site, URL: tc.source, Limit: 10, RangeKind: "file", RangeLimit: &rangeOverride, ProxyMode: "direct", CookiesFile: "fixture-cookies", ConfigFile: "fixture-config"})
			if err != nil || more || validator.direct != 1 || !reflect.DeepEqual(items, tc.want) {
				t.Fatalf("items=%#v, more=%v, err=%v, validations=%d", items, more, err, validator.direct)
			}
		})
	}
}

func work(id, title, author string, mediaCount int, url, thumbnail string) map[string]any {
	return map[string]any{"id": id, "title": title, "author": author, "media_count": mediaCount, "download_url": url, "thumbnail_url": thumbnail}
}

func TestBrowseTimelineLookahead(t *testing.T) {
	for _, tc := range []struct {
		limit, posts int
	}{
		{1, 0}, {1, 1}, {1, 2}, {1000, 1001},
	} {
		t.Run(fmt.Sprintf("%d_of_%d", tc.limit, tc.posts), func(t *testing.T) {
			tr := nativeTransport(t, &transportPool{}, &transportValidator{})
			tr.Gallery = captureFunc(func(_ context.Context, req gallery.CaptureRequest) (gallery.CaptureResult, error) {
				if got, want := req.ExtraArgs[2], fmt.Sprintf("1-%d", tc.limit+1); got != want {
					t.Fatalf("post range = %q, want %q", got, want)
				}
				var json strings.Builder
				json.WriteByte('[')
				for i := 1; i <= tc.posts; i++ {
					if i != 1 {
						json.WriteByte(',')
					}
					fmt.Fprintf(&json, `[2,{"id":%d,"count":1}]`, i)
				}
				json.WriteByte(']')
				return gallery.CaptureResult{Stdout: json.String()}, nil
			})
			items, more, err := New(tr).BrowseTimeline(context.Background(), Request{Site: "pixiv", URL: "https://www.pixiv.net/users/42/artworks", Limit: tc.limit, ProxyMode: "direct"})
			if err != nil || items == nil || len(items) != min(tc.limit, tc.posts) || more != (tc.posts > tc.limit) {
				t.Fatalf("count=%d, more=%v, err=%v", len(items), more, err)
			}
			for i, item := range items {
				if item["id"] != fmt.Sprint(i+1) {
					t.Fatal(item)
				}
			}
		})
	}
}

func TestBrowseTimelineRejectsUnsafeRequestsBeforeCapture(t *testing.T) {
	svc := &Service{}
	for _, req := range []Request{
		{Site: "pixiv", URL: "https://www.pixiv.net/users/42/artworks", Limit: 1001},
		{Site: "pixiv", URL: "https://www.pixiv.net/users/42/artworks", Limit: 0},
		{Site: "pixiv", URL: "https://www.pixiv.net/users/42/artworks", Limit: 1, ExtraArgs: []string{"--post-range=1-999999"}},
		{Site: "twitter", URL: "https://www.pixiv.net/users/42/artworks", Limit: 1},
		{Site: "twitter", URL: "https://user:secret@x.com/artist/media", Limit: 1},
	} {
		if items, more, err := svc.BrowseTimeline(context.Background(), req); err == nil || items != nil || more {
			t.Fatalf("browse(%+v) returned %v, %v, %v", req, items, more, err)
		}
	}
}

func TestBrowseTimelineFailsClosedOnExtractorErrors(t *testing.T) {
	const secret = "fixture-secret"
	for _, tc := range []struct {
		name, stdout, stderr, wantCode string
		exit                           int
	}{
		{"authentication", `[[-1,{"error":"AuthorizationError","message":"protected cookie ` + secret + `"}]]`, "", "authentication", 0},
		{"stderr error", `[]`, `[twitter][error] login required, ` + secret, "authentication", 0},
		{"late timeout", `[[2,{"tweet_id":42,"count":1}],[-1,{"error":"HttpError","message":"connection timed out ` + secret + `"}]]`, "", "discovery_failed", 0},
		{"network exit", `[]`, "connection reset " + secret, "discovery_failed", 128},
		{"redirect", `[[6,"https://evil.test/",{}]]`, "", "invalid_gallery_output", 0},
		{"ambiguous range", `[[2,{"tweet_id":42,"count":1}],[2,{"tweet_id":42,"count":1}]]`, "", "invalid_gallery_output", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tr := nativeTransport(t, &transportPool{}, &transportValidator{})
			tr.Gallery = captureFunc(func(context.Context, gallery.CaptureRequest) (gallery.CaptureResult, error) {
				return gallery.CaptureResult{Stdout: tc.stdout, Stderr: tc.stderr, ProcessResult: gallery.ProcessResult{ExitCode: tc.exit}}, nil
			})
			policy := scheduler.DefaultPolicy()
			policy.RetryLimit = 0
			items, more, err := New(tr).BrowseTimeline(context.Background(), Request{Site: "twitter", URL: "https://x.com/search?q=art", Limit: 1, ProxyMode: "direct", Policy: policy})
			var public *Error
			if !errors.As(err, &public) || public.Code != tc.wantCode || strings.Contains(public.Error(), secret) || public.Details != nil || items != nil || more {
				t.Fatalf("items=%v, more=%v, err=%#v", items, more, err)
			}
		})
	}
}
