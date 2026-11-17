package discoverydata

import (
	"encoding/json"
	"testing"
)

func TestAdapterExports(t *testing.T) {
	post, authors := DanbooruCandidate(map[string]any{"id": float64(10), "tags_artist": []any{"artist"}})
	if post["id"] != "10" || len(authors) != 1 || authors[0]["name"] != "artist" {
		t.Fatal(post, authors)
	}
	candidate, authors := DanbooruArtistQueue("https://danbooru.donmai.us/posts?tags=artist", map[string]any{"id": json.Number("55"), "name": "artist", "other_names": []string{"別名"}})
	if candidate != nil || len(authors) != 1 || authors[0]["origin"] != "danbooru_artist_directory" {
		t.Fatal(candidate, authors)
	}
	gallery, authors := ExhentaiDirectoryCandidate(map[string]any{"gid": float64(12), "token": "aaaaaaaaaa", "tags": []string{"artist:fixture"}}, "https://exhentai.org/")
	if gallery["url"] != "https://exhentai.org/g/12/aaaaaaaaaa/" || authors == nil || len(authors) != 0 {
		t.Fatal(gallery, authors)
	}
	if TagKey("  Artist--Name_ ") != "artist_name" {
		t.Fatal("tag normalization")
	}
	for id, want := range map[int]string{0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta", 2: "general", 99: "general"} {
		if TagCategoryName(id) != want {
			t.Fatalf("category %d", id)
		}
	}
	for _, code := range []string{"invalid_network_target", "proxy_dns_failed", "encrypted_dns_unavailable", "encrypted_dns_redirect", "encrypted_dns_http_error", "encrypted_dns_protocol", "encrypted_dns_status_error", "encrypted_dns_nxdomain", "encrypted_dns_no_answer", "encrypted_dns_response_too_large"} {
		if !IsDNSErrorCode(code) {
			t.Fatal(code)
		}
	}
	for _, code := range []string{"", "extractor_error", "encrypted_dns_fake"} {
		if IsDNSErrorCode(code) {
			t.Fatal(code)
		}
	}
	_, _, err := ParseOutput("pixiv", `[[-1,{"message":"fixture"}]]`, "", 1)
	de := err.(*Error)
	if _, ok := de.Details.(map[string]any)["errors"].([]string); !ok {
		t.Fatal("adapter requires []string errors")
	}
}

func TestIntegerIdentityPrecision(t *testing.T) {
	for raw, want := range map[string]string{"18446744073709551616": "18446744073709551616", "１２３": "123", "١٢٣": "123", "1_234": "1234", "-42": "-42"} {
		candidate, _ := DanbooruCandidate(map[string]any{"id": raw})
		if candidate["id"] != want {
			t.Fatalf("%q: %v", raw, candidate)
		}
	}
	for _, raw := range []string{"_12", "12_", "1__2", "+_12", "1.2", "bad"} {
		candidate, _ := DanbooruCandidate(map[string]any{"id": raw})
		if candidate != nil {
			t.Fatalf("invalid id %q: %v", raw, candidate)
		}
	}
}
