package discoverydata

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

// Expected values were recorded from the original pure Python transforms and
// their tests. The fixture is checked in; running these tests needs only Go.
func TestPythonOracle(t *testing.T) {
	data, err := os.ReadFile("testdata/oracle.json")
	if err != nil {
		t.Fatal(err)
	}
	var records []struct {
		Op     string `json:"op"`
		Input  object `json:"input"`
		Output any    `json:"output"`
		Error  object `json:"error"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	if err = decoder.Decode(&records); err != nil {
		t.Fatal(err)
	}
	for i, r := range records {
		t.Run(fmt.Sprintf("%03d_%s", i, r.Op), func(t *testing.T) {
			a := r.Input
			var actual any
			var err error
			switch r.Op {
			case "canonical_gallery_address":
				actual, err = CanonicalAddress(str(a["site"]), str(a["url"]))
			case "classify_external_profile":
				actual = ClassifyExternalProfile(str(a["url"]))
			case "discovery_addresses":
				actual, err = Addresses(str(a["site"]), obj(a["result"]), str(a["keyword"]), intValue(a["limit"]))
			case "danbooru_alias_terms":
				actual = AliasTerms(obj(a["artist_result"]), str(a["keyword"]), intValue(a["cap"]))
			case "merge_alias_search_results":
				aliases := []AliasResult{}
				for _, v := range sequence(a["alias_results"]) {
					pair := sequence(v)
					aliases = append(aliases, AliasResult{str(pair[0]), obj(pair[1])})
				}
				actual = MergeAliasResults(str(a["keyword"]), obj(a["primary"]), aliases, intValue(a["limit"]))
			case "exhentai_tag_facets":
				actual = ExhentaiTagFacets(objects(a["addresses"]))
			case "parse_discovery_output":
				var candidates, authors []object
				candidates, authors, err = ParseOutput(str(a["site"]), str(a["stdout"]), str(a["source_url"]), intValue(a["limit"]))
				actual = []any{candidates, authors}
			case "validate_discovery_args":
				actual, err = ValidateArgs(stringsOf(a["args"]))
			case "_pixiv_first_media_args":
				actual, err = PixivFirstMediaArgs(stringsOf(a["args"]))
			case "search_site_catalog":
				actual = SearchSiteCatalog()
			default:
				t.Fatalf("unknown fixture operation %q", r.Op)
			}
			if r.Error != nil {
				if err == nil {
					t.Fatalf("expected %v, got success: %v", r.Error, actual)
				}
				got := object{"message": err.Error(), "code": "", "details": nil}
				var de *Error
				if errors.As(err, &de) {
					got["code"] = de.Code
					got["details"] = de.Details
				}
				assertJSON(t, got, r.Error)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			assertJSON(t, actual, r.Output)
		})
	}
}
func assertJSON(t *testing.T, actual, expected any) {
	t.Helper()
	a, e := json.Marshal(actual)
	if e != nil {
		t.Fatal(e)
	}
	b, e := json.Marshal(expected)
	if e != nil {
		t.Fatal(e)
	}
	if string(a) != string(b) {
		t.Fatalf("got:  %s\nwant: %s", a, b)
	}
}

func TestSiteAndArgumentIsolation(t *testing.T) {
	for alias, canonical := range map[string]string{" X ": "twitter", "e_hentai": "exhentai", "EH": "exhentai", "e-hentai": "exhentai", "pixiv": "pixiv", "danbooru": "danbooru", "pawchive": "pawchive"} {
		s, err := SearchSite(alias)
		if err != nil || s.Site != canonical {
			t.Fatalf("%q: %v %v", alias, s, err)
		}
		s.Aliases[0] = "mutated"
		again, _ := SearchSite(canonical)
		if again.Aliases[0] == "mutated" {
			t.Fatal("mutable site aliases escaped")
		}
	}
	for site, want := range map[string]string{"twitter": "https://x.com/search?q=%E5%AD%97+%26+art&f=live", "danbooru": "https://danbooru.donmai.us/posts?tags=%E5%AD%97+%26+art", "exhentai": "https://e-hentai.org/?f_search=%E5%AD%97+%26+art", "pawchive": "https://pawchive.pw/artists?q=%E5%AD%97+%26+art"} {
		s, _ := SearchSite(site)
		got, err := s.SearchURL("字 & art")
		if err != nil || got != want {
			t.Fatalf("%s: %q %v", site, got, err)
		}
	}
	s, _ := SearchSite("pixiv")
	if _, err := s.SearchURL("fixture"); err == nil {
		t.Fatal("Pixiv must reject native keyword URL")
	}
	if _, err := SearchSite("unsupported"); err == nil {
		t.Fatal("unknown site accepted")
	}
	args := []string{"--filter", "rating == 'g'"}
	copy, err := PixivFirstMediaArgs(args)
	if err != nil {
		t.Fatal(err)
	}
	if args[1] != "rating == 'g'" || copy[1] != "(rating == 'g') and (num == 0)" {
		t.Fatal("filter composition/mutation")
	}
}

func TestMergeDoesNotMutateInputs(t *testing.T) {
	primary := object{"candidates": []object{{"id": "1", "matched_keywords": []string{"old"}}}, "attempts": 1}
	before, _ := json.Marshal(primary)
	got := MergeAliasResults("main", primary, []AliasResult{{"別名", object{"candidates": []object{{"id": "1"}, {"id": "2"}}, "attempts": 2}}}, 1)
	after, _ := json.Marshal(primary)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("primary mutated")
	}
	assertJSON(t, objects(got["candidates"])[0]["matched_keywords"], []string{"main", "別名"})
	if got["attempts"] != 3 {
		t.Fatal(got)
	}
}

func TestExtractorRedactsCredentials(t *testing.T) {
	_, _, err := ParseOutput("pixiv", `[[-1,{"message":"Authorization: Bearer fixture-secret https://user:pass@fixture.invalid/?token=fixture-token"}]]`, "", 10)
	var de *Error
	if !errors.As(err, &de) || de.Code != "extractor_error" {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(de)
	for _, secret := range []string{"fixture-secret", "fixture-token", "user:pass"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("leaked %s", secret)
		}
	}
}

func FuzzParseOutput(f *testing.F) {
	for _, seed := range []string{`[]`, `[[2,{"tweet_id":42,"author":{"name":"artist"}}],[3,"thumb",{"tweet_id":42}]]`, `[[-1,{"message":"token=secret"}]]`, `[null,{},[],[2,{}],[6,"u",{}]]`} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, s string) {
		for _, site := range []string{"twitter", "pixiv", "danbooru", "exhentai", "pawchive"} {
			_, _, _ = ParseOutput(site, s, "https://fixture.invalid/", 3)
		}
	})
}
