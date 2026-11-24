package discoverydata

import "testing"

func TestTimelineAndExactWorkAddresses(t *testing.T) {
	for _, tc := range []struct{ site, input, want, filter string }{
		{"pixiv", "https://pixiv.net/en/artworks/123?utm_source=profile", "https://www.pixiv.net/artworks/123", "id == 123"},
		{"twitter", "https://twitter.com/Some_Artist/status/1909690278356479999/photo/2?s=5", "https://x.com/some_artist/status/1909690278356479999", "tweet_id == 1909690278356479999 and not (retweet_id or quote_id)"},
		{"x", "https://x.com/i/status/123", "https://x.com/i/web/status/123", "tweet_id == 123 and not (retweet_id or quote_id)"},
	} {
		if got, err := CanonicalWorkAddress(tc.site, tc.input); err != nil || got != tc.want {
			t.Fatalf("CanonicalWorkAddress(%q, %q) = %q, %v", tc.site, tc.input, got, err)
		}
		if got, err := ExactWorkPostFilter(tc.site, tc.input); err != nil || got != tc.filter {
			t.Fatalf("ExactWorkPostFilter(%q, %q) = %q, %v", tc.site, tc.input, got, err)
		}
		if _, err := CanonicalTimelineAddress(tc.site, tc.input); err == nil {
			t.Fatalf("timeline accepted work %q", tc.input)
		}
	}
	for _, tc := range []struct{ site, input string }{
		{"pixiv", "https://www.pixiv.net/users/42/bookmarks/artworks"},
		{"pixiv", "https://www.pixiv.net/users/42/artworks/redirect"},
		{"pixiv", "https://www.pixiv.net/users/%34%32/artworks"},
		{"pixiv", "https://www.pixiv.net:999/users/42/artworks"},
		{"pixiv", "https://www.pixiv.net.evil.test/users/42/artworks"},
		{"pixiv", "https://evil.test@www.pixiv.net/users/42/artworks"},
		{"pixiv", "file://www.pixiv.net/users/42/artworks"},
		{"pixiv", "https://x.com/artist/media"},
		{"x", "https://x.com/i/media"},
		{"x", "https://x.com/login"},
		{"x", "https://x.com/artist/media/redirect"},
		{"x", "https://x.com/artist%2Fmedia"},
		{"x", "--option=fixture"},
	} {
		if _, err := CanonicalTimelineAddress(tc.site, tc.input); err == nil {
			t.Fatalf("timeline accepted %q", tc.input)
		}
		if _, err := CanonicalWorkAddress(tc.site, tc.input); err == nil {
			t.Fatalf("work accepted %q", tc.input)
		}
	}
	for _, tc := range []struct{ site, input string }{
		{"pixiv", "https://www.pixiv.net/users/42/artworks"},
		{"x", "https://x.com/artist/media"},
		{"x", "https://x.com/artist/status/42/conversation"},
		{"x", "https://x.com/artist/status/42evil"},
		{"x", "https://other.test/artist/status/42"},
		{"danbooru", "https://x.com/artist/status/42"},
	} {
		if _, err := ExactWorkPostFilter(tc.site, tc.input); err == nil {
			t.Fatalf("exact work filter accepted %q", tc.input)
		}
	}
}
