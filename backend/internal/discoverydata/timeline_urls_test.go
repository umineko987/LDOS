package discoverydata

import (
	"net/url"
	"strings"
	"testing"
)

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

func TestCanonicalTimelineSearchAddress(t *testing.T) {
	for _, tc := range []struct{ site, input, want string }{
		{"pixiv", "https://pixiv.net/search.php?word=猫+C%2B%2B+%23fan&order=popular_d&s_mode=s_tc&q=ignored&token=secret#fragment", "https://www.pixiv.net/search.php?order=date_d&s_mode=s_tag&word=%E7%8C%AB+C%2B%2B+%23fan"},
		{"x", "https://mobile.twitter.com/search?q=%23猫%20C%2B%2B&f=user&token=secret#fragment", "https://x.com/search?q=%23%E7%8C%AB+C%2B%2B+filter%3Amedia"},
		{"twitter", "https://x.com/search?q=art+FILTER%3Amedia+filter%3Amedia", "https://x.com/search?q=art+filter%3Amedia"},
		{"x", "https://x.com/search?q=%22art++filter%3Amedia%22", "https://x.com/search?q=%22art++filter%3Amedia%22+filter%3Amedia"},
		{"x", "https://x.com/search?q=" + url.QueryEscape(strings.Repeat("猫", 500)), "https://x.com/search?q=" + url.QueryEscape(strings.Repeat("猫", 500)+" filter:media")},
	} {
		if got, err := CanonicalTimelineAddress(tc.site, tc.input); err != nil || got != tc.want {
			t.Fatalf("CanonicalTimelineAddress(%q, %q) = %q, %v; want %q", tc.site, tc.input, got, err, tc.want)
		}
		if got, err := CanonicalTimelineAddress(tc.site, tc.want); err != nil || got != tc.want {
			t.Fatalf("canonical URL changed on reuse: %q, %v", got, err)
		}
		if _, err := ExactWorkPostFilter(tc.site, tc.want); err == nil {
			t.Fatalf("exact work filter accepted a search URL: %q", tc.want)
		}
	}
	for _, tc := range []struct{ site, input string }{
		{"pixiv", "https://www.pixiv.net/search.php?word=+++"},
		{"pixiv", "https://www.pixiv.net/search.php?word=cat&%77ord=dog"},
		{"pixiv", "https://www.pixiv.net/search.php?word=%ff"},
		{"pixiv", "https://www.pixiv.net/search.php?word=%"},
		{"pixiv", "https://www.pixiv.net/search.php?q=cat"},
		{"pixiv", "https://www.pixiv.net/search?word=cat"},
		{"pixiv", "https://x.com/search?q=cat"},
		{"x", "https://www.pixiv.net/search.php?word=cat"},
		{"x", "https://x.com.evil.test/search?q=cat"},
		{"x", "https://user:secret@x.com/search?q=cat"},
		{"x", "https://x.com/search?q=cat&token=%"},
		{"x", "https://x.com/search?q=cat%0Adog"},
		{"x", "https://x.com/search?q=filter%3Amedia"},
		{"x", "https://x.com/search?q=" + url.QueryEscape(strings.Repeat("猫", 501))},
		{"x", "https://x.com/%73earch?q=cat"},
		{"x", "https://x.com/search/other?q=cat"},
	} {
		if got, err := CanonicalTimelineAddress(tc.site, tc.input); err == nil || got != "" {
			t.Fatalf("accepted invalid search URL %q: %q, %v", tc.input, got, err)
		}
	}
}
