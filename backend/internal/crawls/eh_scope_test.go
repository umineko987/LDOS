package crawls

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"ldos/backend/internal/discovery"
)

const ehGalleryFixtureURL = "https://exhentai.org/g/42/abcdef1234/"

func serveEHFixture(s *Service, handler func(*http.Request) *http.Response) {
	s.deps.HTTPClient = func(context.Context, string, time.Duration) (*http.Client, func(), error) {
		return &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return handler(req), nil
		})}, func() {}, nil
	}
}

func ehIndexFixture(total, first, last, missing int) string {
	var html strings.Builder
	fmt.Fprintf(&html, `<h1 id="gn">Gallery</h1><td>Length:</td><td>%d pages</td>`, total)
	for n := first; n <= last; n++ {
		if n != missing {
			fmt.Fprintf(&html, `<a href="/s/abcdef1234/42-%d"></a>`, n)
		}
	}
	return html.String()
}

func TestBrowseEHPagesReturnsOrderedPrefixAndThumbnails(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	p, _ := s.deps.PolicyFor(ctx, "exhentai")
	var calls []string
	serveEHFixture(s, func(req *http.Request) *http.Response {
		q := req.URL.Query()
		if q.Get("foo") != "bar" || req.URL.Path != "/g/42/abcdef1234/" || !strings.Contains(req.Header.Get("Cookie"), "nw=1") {
			t.Fatal(req.URL, req.Header)
		}
		calls = append(calls, q.Get("p"))
		switch q.Get("p") {
		case "":
			return response(200, `<h1 class='title' id='gn'>A &amp; <b>B</b></h1><td>Length:</td> <td class="gdt2">1,024 pages</td>
<div id="gdt">
<div class="gdtm"><a href="/s/abcdef1234/42-2"><div title="Page 2" style="width: 100px; height: 146px; background:transparent url(//thumbs.example/sprite.jpg) -108px 0 no-repeat"></div></a></div>
<div class="gdtl"><a href="https://exhentai.org/s/abcdef1234/42-1"><img src="https://thumbs.example/p1.jpg?a=b&amp;c=d"></a></div>
<a href="/s/abcdef1234/99-3"><img src="/other-gallery.jpg"></a>
</div>`)
		case "1":
			return response(200, `<a href='/s/abcdef1234/42-3'><div style='background-image: url("/sprite.png");background-position: -10px -20px; width: 92px; height: 125px'></div></a>
<a href='/s/abcdef1234/42-4'><img src='data:image/png;base64,AAAA' data-src='/real-thumb.jpg'></a>`)
		default:
			t.Fatalf("unexpected request: %v", req.URL)
			return nil
		}
	})
	items, total, err := s.BrowseEHPages(ctx, ehGalleryFixtureURL+"?p=42&foo=bar", p, "direct", "", 4)
	good(t, err)
	if total != 1024 || !reflect.DeepEqual(calls, []string{"", "1"}) || len(items) != 4 {
		t.Fatal(total, calls, items)
	}
	for i, item := range items {
		n := i + 1
		if item["id"] != strconv.Itoa(n) || item["title"] != fmt.Sprintf("A & B · P%d", n) || item["page"] != n || item["media_count"] != 1 {
			t.Fatal(item)
		}
	}
	urls := []string{"https://thumbs.example/p1.jpg?a=b&c=d", "https://thumbs.example/sprite.jpg", "https://exhentai.org/sprite.png", "https://exhentai.org/real-thumb.jpg"}
	for i, want := range urls {
		if items[i]["thumbnail_url"] != want {
			t.Fatal(items[i])
		}
	}
	if items[0]["thumbnail_sprite"] != nil ||
		!reflect.DeepEqual(items[1]["thumbnail_sprite"], map[string]int{"width": 100, "height": 146, "x": -108, "y": 0}) ||
		!reflect.DeepEqual(items[2]["thumbnail_sprite"], map[string]int{"width": 92, "height": 125, "x": -10, "y": -20}) {
		t.Fatal(items)
	}
}

func TestBrowseEHPagesClassifiesFailures(t *testing.T) {
	cases := []struct {
		name, body, code string
		status           int
	}{
		{"blank login", "", "authentication", 200},
		{"login page", `<p>This gallery is only available to <b>logged in</b> users.</p>`, "authentication", 200},
		{"restricted gallery", `<h1>Gallery Not Available</h1>`, "authentication", 404},
		{"capacity page", `<p>We are currently experiencing a heavy load.</p>`, "eh_gallery_capacity", 200},
		{"bandwidth status", "", "eh_gallery_capacity", 509},
		{"malformed index", `<h1 id="gn">No total</h1>`, "eh_gallery_browse_failed", 200},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, _, _ := fixture(t)
			ctx := context.Background()
			p, _ := s.deps.PolicyFor(ctx, "exhentai")
			auth := 0
			s.deps.Discovery.Transport.AuthFailure = func(context.Context, string, string, string) (bool, error) { auth++; return true, nil }
			serveEHFixture(s, func(*http.Request) *http.Response { return response(c.status, c.body) })
			items, total, err := s.BrowseEHPages(ctx, ehGalleryFixtureURL, p, "required", "", 10)
			var failure *Error
			if items != nil || total != 0 || !errors.As(err, &failure) || failure.Code != c.code || (auth == 1) != (c.code == "authentication") {
				t.Fatal(items, total, err, auth)
			}
			pool := s.deps.Discovery.Transport.Pool.(*localPool)
			if pool.leases != 1 || pool.release != 1 {
				t.Fatal(pool)
			}
		})
	}
}

func TestEHAddressSelectionValidation(t *testing.T) {
	payload := func(site, target, pages string) []byte {
		return fmt.Appendf(nil, `{"sources":[{"site":%q,"addresses":[{"url":%q,"eh_pages":%s}]}]}`, site, target, pages)
	}
	for _, pages := range []string{`[]`, `null`, `[0]`, `[-1]`, `[1,null]`, `[1,1]`, `["1"]`, `[1.5]`, `"1-3"`, `{}`} {
		if _, err := DecodeRequest(payload("eh", ehGalleryFixtureURL, pages)); err == nil {
			t.Fatalf("accepted eh_pages=%s", pages)
		}
	}
	for _, target := range []string{"https://exhentai.org/s/abcdef1234/42-2", ehGalleryFixtureURL + "extra"} {
		if _, err := DecodeRequest(payload("exhentai", target, "[1]")); err == nil {
			t.Fatal(target)
		}
	}
	if _, err := DecodeRequest(payload("pixiv", "https://www.pixiv.net/artworks/42", "[1]")); err == nil {
		t.Fatal("accepted EH pages for Pixiv")
	}
	_, err := DecodeRequest(payload("eh", ehGalleryFixtureURL, "[2,4]"))
	good(t, err)
}

func TestEHSelectedPagesPersistAcrossRecoveryAndRetry(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	selected := make([]int, 0, 26)
	for n := 12; n <= 38; n++ {
		if n != 17 {
			selected = append(selected, n)
		}
	}
	missing, requests := 18, 0
	token := "abcdef1234"
	serveEHFixture(s, func(req *http.Request) *http.Response {
		requests++
		p, _ := strconv.Atoi(req.URL.Query().Get("p"))
		if p > 3 {
			t.Fatal("pagination did not stop", req.URL)
		}
		if p >= 2 {
			return response(200, ehIndexFixture(5000, 1, 0, missing))
		}
		body := ehIndexFixture(5000, 1+p*20, 20+p*20, missing)
		return response(200, strings.ReplaceAll(body, "abcdef1234", token))
	})
	batch := createBatch(t, s, Request{Concurrency: 1, MaxTasks: 26, Sources: []Source{{Site: "eh", Addresses: []Address{{URL: ehGalleryFixtureURL, EHPages: selected}}}}})
	id := str(batch["id"])
	address := batchAddresses(batch)[0]
	if jsonText(address["eh_pages"]) != jsonText(selected) {
		t.Fatal(address)
	}
	good(t, s.exec(ctx, "UPDATE crawl_addresses SET status='planning' WHERE id=?", address["id"]))
	good(t, s.Recover(ctx))
	good(t, s.RunOnce(ctx))
	failed, err := s.Get(ctx, id)
	good(t, err)
	if failed["status"] != "completed_with_errors" || integer(batchAddresses(failed)[0]["planned_task_count"]) != 0 || requests != 4 {
		t.Fatal(failed, requests)
	}
	missing, requests = 0, 0
	_, err = s.Retry(ctx, id, 1)
	good(t, err)
	good(t, s.RunOnce(ctx))
	rows, err := s.ListTasks(ctx, id, "", 100, 0)
	good(t, err)
	if len(rows) != 26 || requests != 2 {
		t.Fatal(len(rows), requests)
	}
	for i, row := range rows {
		if row["url"] != fmt.Sprintf("https://exhentai.org/s/abcdef1234/42-%d", selected[i]) || !reflect.DeepEqual(stringsOf(row["extra_args"]), []string{"--range", "1"}) {
			t.Fatal(row)
		}
	}
	markTasks(t, s, id, "failed")
	good(t, s.RunOnce(ctx))
	retried, err := s.Retry(ctx, id, 1)
	good(t, err)
	address = batchAddresses(retried["batch"].(map[string]any))[0]
	if jsonText(address["eh_pages"]) != jsonText(selected) || integer(address["planned_task_count"]) != 26 || requests != 2 {
		t.Fatal(address, requests)
	}

	markTasks(t, s, id, "succeeded")
	good(t, s.RunOnce(ctx))
	token, requests = "0123456789", 0
	_, err = s.Rerun(ctx, id, 1, true)
	good(t, err)
	good(t, s.RunOnce(ctx))
	rerunRows, err := s.ListTasks(ctx, id, "", 100, 0)
	good(t, err)
	if len(rerunRows) != len(rows) || requests != 2 {
		t.Fatal(len(rerunRows), requests)
	}
	for i, row := range rerunRows {
		if row["id"] != rows[i]["id"] || row["status"] != "queued" || row["url"] != fmt.Sprintf("https://exhentai.org/s/%s/42-%d", token, selected[i]) {
			t.Fatal(row)
		}
	}
}

func TestEHPlanScopeAndLegacyLimit(t *testing.T) {
	s, _, _ := fixture(t)
	ctx := context.Background()
	p, _ := s.deps.PolicyFor(ctx, "exhentai")
	calls := 0
	serveEHFixture(s, func(*http.Request) *http.Response {
		calls++
		return response(200, ehIndexFixture(5000, 1, 20, 0))
	})
	units, _, err := s.planEHPages(ctx, ehGalleryFixtureURL, p, "direct", "", 1, []int{13})
	good(t, err)
	if len(units) != 1 || units[0].SourceID != "42:13" || calls != 1 {
		t.Fatal(units, calls)
	}
	var upstream *discovery.Error
	_, _, err = s.planEH(ctx, ehGalleryFixtureURL, p, "direct", "", 1)
	if !errors.As(err, &upstream) || upstream.Code != "crawl_plan_too_large" || calls != 2 {
		t.Fatal(err, calls)
	}
	_, _, err = s.planEHPages(ctx, ehGalleryFixtureURL, p, "direct", "", 1, []int{5001})
	if !errors.As(err, &upstream) || upstream.Code != "invalid_eh_pages" || calls != 3 {
		t.Fatal(err, calls)
	}
}
