package discoverydata

import (
	"fmt"
	"testing"
)

func TestDanbooruCandidateDownloadability(t *testing.T) {
	const file = "https://cdn.donmai.us/original.jpg"
	const preview = "https://cdn.donmai.us/preview.jpg"
	cases := []struct {
		name         string
		fields       object
		downloadable bool
		thumbnail    any
	}{
		{"missing file", object{}, false, nil},
		{"empty file", object{"file_url": " \t "}, false, nil},
		{"preview only", object{"preview_file_url": preview}, false, preview},
		{"large only", object{"large_file_url": preview}, false, preview},
		{"normal", object{"file_url": file, "preview_file_url": preview}, true, preview},
		{"file thumbnail", object{"file_url": file, "preview_file_url": " "}, true, file},
		{"deleted with file", object{"file_url": file, "is_deleted": true}, true, file},
		{"deleted without file", object{"is_deleted": true}, false, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data := object{"id": 42, "tag_string_artist": "fixture_artist", "source": "https://www.pixiv.net/artworks/99"}
			for k, v := range tc.fields {
				data[k] = v
			}
			candidate, authors := DanbooruCandidate(data)
			if candidate["downloadable"] != tc.downloadable || candidate["thumbnail_url"] != tc.thumbnail {
				t.Fatalf("candidate: %v", candidate)
			}
			if candidate["id"] != "42" || candidate["url"] != "https://danbooru.donmai.us/posts/42" || candidate["source_url"] != data["source"] || len(authors) != 1 || authors[0]["name"] != "fixture_artist" || obj(candidate["author"])["name"] != "fixture_artist" {
				t.Fatalf("post or author evidence lost: %v %v", candidate, authors)
			}
			if tc.downloadable {
				if candidate["download_unavailable_reason"] != nil || candidate["download_url"] != candidate["url"] {
					t.Fatalf("downloadable candidate: %v", candidate)
				}
			} else if candidate["download_unavailable_reason"] != "missing_file_url" || candidate["download_url"] != nil {
				t.Fatalf("unavailable candidate: %v", candidate)
			}
		})
	}
}

func TestDanbooruMessageURLDownloadEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, media string
		preview     bool
		download    bool
	}{
		{"media without preview", "https://cdn.donmai.us/original.jpg", false, true},
		{"media with preview", "https://cdn.donmai.us/original.jpg", true, true},
		{"empty media", " \t ", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			preview := ""
			if tc.preview {
				preview = `,"preview_file_url":"https://cdn.donmai.us/preview.jpg"`
			}
			stdout := fmt.Sprintf(`[[2,{"id":42,"tags_artist":["fixture_artist"]%s}],[3,%q,{"id":42}],[2,{"id":42}]]`, preview, tc.media)
			candidates, authors, err := ParseOutput("danbooru", stdout, "", 1)
			if err != nil || len(candidates) != 1 || len(authors) != 1 {
				t.Fatalf("parse: %v %v %v", candidates, authors, err)
			}
			c := candidates[0]
			if c["downloadable"] != tc.download {
				t.Fatalf("download evidence: %v", c)
			}
			if tc.download {
				if c["download_url"] != c["url"] || c["download_unavailable_reason"] != nil {
					t.Fatalf("media evidence did not clear unavailable state: %v", c)
				}
			} else if c["download_url"] != nil || c["download_unavailable_reason"] != "missing_file_url" {
				t.Fatalf("blank media counted as evidence: %v", c)
			}
			wantThumbnail := tc.media
			if tc.preview {
				wantThumbnail = "https://cdn.donmai.us/preview.jpg"
			}
			if c["thumbnail_url"] != wantThumbnail || obj(c["author"])["name"] != "fixture_artist" {
				t.Fatalf("preview or author changed: %v", c)
			}
		})
	}
}

func TestDanbooruUnavailablePostKeepsTagAddresses(t *testing.T) {
	candidate, authors := DanbooruCandidate(object{"id": 42, "tag_string_artist": "fixture_artist", "tag_string_character": "fixture_character"})
	result := object{"candidates": []object{candidate}, "authors": authors}
	for _, tc := range []struct{ keyword, kind string }{{"fixture_artist", "artist_tag"}, {"fixture_character", "character_tag"}} {
		t.Run(tc.kind, func(t *testing.T) {
			addresses, err := Addresses("danbooru", result, tc.keyword, 10)
			if err != nil || len(addresses) != 1 || addresses[0]["address_type"] != tc.kind || addresses[0]["url"] != "https://danbooru.donmai.us/posts?tags="+tc.keyword {
				t.Fatalf("tag address lost: %v %v", addresses, err)
			}
			if _, exists := addresses[0]["downloadable"]; exists {
				t.Fatalf("post availability leaked onto tag address: %v", addresses[0])
			}
		})
	}
}
