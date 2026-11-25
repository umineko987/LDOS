package collect

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ldos/backend/internal/crawls"
	"ldos/backend/internal/discovery"
	"ldos/backend/internal/search"
	"ldos/backend/internal/store"
)

func openCollectTestStore(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "collect.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
	})
	return db
}

func execSQL(t *testing.T, db *store.Store, query string, args ...any) {
	t.Helper()
	err := db.WriteTransaction(context.Background(), func(tx *sql.Tx) error {
		_, e := tx.ExecContext(context.Background(), query, args...)
		return e
	})
	if err != nil {
		t.Fatalf("execSQL(%q): %v", query, err)
	}
}

func makePNGBytes(t *testing.T, w, h int, leftColor, rightColor color.RGBA) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if x < w/2 {
				img.Set(x, y, leftColor)
			} else {
				img.Set(x, y, rightColor)
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestResolveURLsAndKeywords(t *testing.T) {
	ctx := context.Background()
	searchCalls := 0
	var capturedSearchReq search.Request

	svc := New(Dependencies{
		RequireDataset: func(context.Context, string) error { return nil },
		AuthStatus: func(_ context.Context, site string) (map[string]any, error) {
			return map[string]any{
				"site":       site,
				"authorized": site == "danbooru" || site == "pixiv",
				"state":      "ready",
				"summary":    site + "-status",
			}, nil
		},
		Search: func(_ context.Context, req search.Request) (map[string]any, error) {
			searchCalls++
			capturedSearchReq = req
			return map[string]any{
				"sources": []any{
					map[string]any{
						"site": "pixiv",
						"auth": map[string]any{"authorized": true, "state": "ready"},
						"addresses": []any{
							map[string]any{
								"url":         "https://www.pixiv.net/users/42",
								"label":       "Alice",
								"works_count": 38,
							},
						},
					},
					map[string]any{
						"site":  "twitter",
						"auth":  map[string]any{"authorized": false, "state": "login_required", "summary": "需要登录"},
						"error": map[string]any{"message": "twitter 需登录后搜索"},
					},
					map[string]any{
						"site": "exhentai",
						"auth": map[string]any{"authorized": true, "state": "ready"},
						"addresses": []any{
							map[string]any{
								"url":         "https://exhentai.org/g/777/0123456789/",
								"label":       "Example Gallery",
								"media_count": 25,
							},
						},
					},
					map[string]any{
						"site": "pawchive",
						"auth": map[string]any{"authorized": true, "state": "ready"},
						"addresses": []any{
							map[string]any{
								"url":   "https://pawchive.pw/patreon/user/99",
								"label": "Patreon Creator",
							},
						},
					},
				},
			}, nil
		},
	})

	// 1. Multi-line URLs + @handle + Danbooru single post aggregation
	res, err := svc.Resolve(ctx, "ds-1", ResolveRequest{
		Input: strings.Join([]string{
			"https://danbooru.donmai.us/posts/1001",
			"https://danbooru.donmai.us/posts/1002",
			"@Artist_Handle",
			"https://e-hentai.org/g/12345/abcdef0123/",
			"https://pawchive.st/fanbox/user/7788/post/9900",
		}, "\n"),
	})
	if err != nil {
		t.Fatalf("Resolve multi-line URLs: %v", err)
	}
	if res.ResolvedMode != "url" || len(res.Sources) != 4 {
		t.Fatalf("expected 4 aggregated sources, got mode=%s len=%d (%+v)", res.ResolvedMode, len(res.Sources), res.Sources)
	}
	if res.Sources[0].Site != "twitter" || res.Sources[0].DefaultMode != "top_n" || res.Sources[0].DefaultTopN != 50 {
		t.Fatalf("unexpected twitter handle source: %+v", res.Sources[0])
	}
	if res.Sources[1].Site != "exhentai" || res.Sources[1].DefaultMode != "all" {
		t.Fatalf("unexpected eh source: %+v", res.Sources[1])
	}
	if res.Sources[2].Site != "pawchive" || res.Sources[2].Kind != "single_work" || res.Sources[2].DefaultMode != "all" {
		t.Fatalf("unexpected pawchive source: %+v", res.Sources[2])
	}
	if res.Sources[3].ID != "danbooru:posts:1001,1002" || res.Sources[3].Query != "id:1001,1002" || res.Sources[3].DefaultMode != "all" {
		t.Fatalf("unexpected aggregated danbooru posts source: %+v", res.Sources[3])
	}

	// 2. Unknown domain returns 422
	if _, err := svc.Resolve(ctx, "ds-1", ResolveRequest{Input: "https://example.com/unknown"}); err == nil {
		t.Fatal("expected unknown domain error")
	} else if own, ok := err.(*Error); !ok || own.Status != 422 {
		t.Fatalf("expected 422 collect.Error, got %v", err)
	}

	// 3. Keyword fast-path (danbooru only) skips search.Service
	fastRes, err := svc.Resolve(ctx, "ds-1", ResolveRequest{Input: "silver_hair", Sites: []string{"danbooru"}})
	if err != nil {
		t.Fatalf("Resolve fast-path: %v", err)
	}
	if searchCalls != 0 || fastRes.ResolvedMode != "keyword" || len(fastRes.Sources) != 1 || fastRes.Sources[0].Query != "silver_hair" {
		t.Fatalf("expected fast-path with 0 searchCalls, got calls=%d res=%+v", searchCalls, fastRes)
	}

	// 4. Multi-site keyword enriches via search.Service
	multiRes, err := svc.Resolve(ctx, "ds-1", ResolveRequest{
		Input: "kurosawa",
		Sites: []string{"danbooru", "pixiv", "twitter", "exhentai", "pawchive"},
	})
	if err != nil {
		t.Fatalf("Resolve multi-site: %v", err)
	}
	if searchCalls != 1 || !reflect.DeepEqual(capturedSearchReq.Sites, []string{"danbooru", "pixiv", "twitter", "exhentai", "pawchive"}) {
		t.Fatalf("expected search.Service invocation, got calls=%d req=%+v", searchCalls, capturedSearchReq)
	}
	if len(multiRes.Sources) < 4 {
		t.Fatalf("expected danbooru + enriched sources, got %+v", multiRes.Sources)
	}
	if len(multiRes.SiteStatuses) != 5 || len(multiRes.SiteStatuses[2].Warnings) != 1 || multiRes.SiteStatuses[2].Warnings[0] != "twitter 需登录后搜索" {
		t.Fatalf("unexpected site statuses: %+v", multiRes.SiteStatuses)
	}
}

func TestMediaSigningCacheCropAndRejects(t *testing.T) {
	ctx := context.Background()
	spriteBytes := makePNGBytes(t, 20, 10, color.RGBA{255, 0, 0, 255}, color.RGBA{0, 0, 255, 255})
	fetchCount := 0

	svc := New(Dependencies{
		FetchMedia: func(_ context.Context, site, rawURL string) ([]byte, error) {
			fetchCount++
			return spriteBytes, nil
		},
	})

	// Untrusted host must be rejected by signMedia
	if got := svc.signMedia("twitter", "https://pbs.twimg.com.evil.example/a.png", nil); got != "" {
		t.Fatalf("expected empty token for untrusted host, got %s", got)
	}
	if got := svc.signMedia("danbooru", "https://cdn.donmai.us/sample/a.jpg", nil); got == "" {
		t.Fatal("expected signed token for cdn.donmai.us")
	}

	// Valid EH sprite crop token (CSS negative offset -10,0,10,10) caches cropped result
	signedPath := svc.signMedia("exhentai", "https://ehgt.org/t/00/sprite.jpg", &[4]int{-10, 0, 10, 10})
	if !strings.HasPrefix(signedPath, "/api/v1/collect/media/") {
		t.Fatalf("unexpected signedPath: %s", signedPath)
	}
	token := strings.TrimPrefix(signedPath, "/api/v1/collect/media/")

	// Tampered token (flip middle signature char so decoded MAC bytes differ) -> 403
	idx := len(token) - 2
	repl := "A"
	if token[idx] == 'A' {
		repl = "B"
	}
	tampered := token[:idx] + repl + token[idx+1:]
	if _, _, err := svc.Media(ctx, tampered); err == nil {
		t.Fatal("expected tampered token error")
	} else if own, ok := err.(*Error); !ok || own.Status != 403 {
		t.Fatalf("expected 403 for tampered token, got %v", err)
	}

	data, mime, err := svc.Media(ctx, token)
	if err != nil {
		t.Fatalf("Media crop: %v", err)
	}
	if mime != "image/png" {
		t.Fatalf("expected cropped PNG mime, got %s", mime)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 10 || img.Bounds().Dy() != 10 {
		t.Fatalf("expected 10x10 cropped image, got %v", img.Bounds())
	}
	if c := color.RGBAModel.Convert(img.At(2, 2)).(color.RGBA); c.B != 255 || c.R != 0 {
		t.Fatalf("expected right-half blue crop, got %+v", c)
	}

	// Second call hits cache without calling FetchMedia again
	if _, _, err := svc.Media(ctx, token); err != nil {
		t.Fatal(err)
	}
	if fetchCount != 1 {
		t.Fatalf("expected 1 fetch due to LRU cache hit, got %d", fetchCount)
	}
}

func TestBrowseAllFiveSitesAndProvenance(t *testing.T) {
	ctx := context.Background()
	db := openCollectTestStore(t)

	// Seed dataset ds-browse with one historical danbooru asset in library (asset-lib) and one in dataset (asset-ds)
	// plus a succeeded pixiv crawl source_key "pixiv:701".
	execSQL(t, db, `INSERT INTO datasets(id,name,kind,created_at,updated_at) VALUES('ds-browse','Browse','character',1,1)`)
	execSQL(t, db, `INSERT INTO crawl_batches(id,status,output_dir,max_tasks,concurrency,created_at,updated_at) VALUES('batch-old','succeeded','/tmp/old',10,1,1,1)`)
	execSQL(t, db, `INSERT INTO danbooru_import_items(batch_id,post_id,file_name) VALUES('batch-old','101','in-ds.png'),('batch-old','102','in-lib.png')`)
	execSQL(t, db, `INSERT INTO gallery_sources(id,kind,batch_id,display_name,root_path,canonical_root_key,availability,created_at,updated_at) VALUES('src-old','crawl','batch-old','old','/tmp/old','/tmp/old','available',1,1)`)
	execSQL(t, db, `INSERT INTO gallery_directories(id,source_id,relative_path,name,sort_key,created_at,updated_at) VALUES('dir-old','src-old','','root','root',1,1)`)
	execSQL(t, db, `INSERT INTO dataset_roots(id,dataset_id,source_id,directory_id,relative_path,origin,created_at) VALUES('root-old','ds-browse','src-old','dir-old','','crawl',1)`)
	execSQL(t, db, `INSERT INTO dataset_crawls(dataset_id,batch_id,state,root_id,created_at,updated_at) VALUES('ds-browse','batch-old','attached','root-old',1,1)`)
	execSQL(t, db, `INSERT INTO gallery_assets(id,source_id,directory_id,relative_path,name,extension,sort_key,size_bytes,modified_ns,created_at,updated_at) VALUES
		('asset-ds','src-old','dir-old','in-ds.png','in-ds.png','png','in-ds.png',100,1,1,1),
		('asset-lib','src-old','dir-old','in-lib.png','in-lib.png','png','in-lib.png',100,1,1,1)`)
	execSQL(t, db, `INSERT INTO crawl_addresses(id,batch_id,site,source_order,address_order,url,status,proxy_mode,max_attempts,created_at,updated_at) VALUES('addr-1','batch-old','pixiv',0,0,'https://www.pixiv.net/users/1','succeeded','direct',1,1,1)`)
	execSQL(t, db, `INSERT INTO tasks(id,site,url,output_dir,proxy_mode,max_attempts,next_run_at,status,artifact_count,created_at,updated_at) VALUES('task-1','pixiv','https://www.pixiv.net/artworks/701','/tmp/old','direct',1,0,'succeeded',1,1,1)`)
	execSQL(t, db, `INSERT INTO crawl_address_tasks(address_id,task_id,sequence_no,created_at) VALUES('addr-1','task-1',0,1)`)
	execSQL(t, db, `INSERT INTO crawl_task_source_keys(task_id,source_key,source_url,created_at) VALUES('task-1','pixiv:701','https://www.pixiv.net/artworks/701',1)`)

	var pawchiveTargets []string
	svc := New(Dependencies{
		Store:          db,
		RequireDataset: func(context.Context, string) error { return nil },
		MemberRows: func(context.Context, string) ([]map[string]any, error) {
			return []map[string]any{{"asset_id": "asset-ds"}}, nil
		},
		DanbooruReq: func(context.Context) (discovery.Request, error) { return discovery.Request{}, nil },
		DanbooruBrowse: func(context.Context, discovery.Request, discovery.DanbooruBrowseOptions) (*discovery.DanbooruBrowsePage, error) {
			total := 3
			return &discovery.DanbooruBrowsePage{
				Total:      &total,
				NextCursor: "b100",
				Items: []discovery.DanbooruPost{
					{ID: "101", Title: "InDS", PreviewURL: "https://cdn.donmai.us/p/101.jpg", FileExt: "png", Downloadable: true, URL: "https://danbooru.donmai.us/posts/101"},
					{ID: "102", Title: "InLib", PreviewURL: "https://cdn.donmai.us/p/102.jpg", FileExt: "png", Downloadable: true, URL: "https://danbooru.donmai.us/posts/102"},
					{ID: "103", Title: "CrossKey", PreviewURL: "https://cdn.donmai.us/p/103.jpg", FileExt: "png", Downloadable: true, URL: "https://danbooru.donmai.us/posts/103", SourceURL: "https://www.pixiv.net/artworks/701"},
				},
			}, nil
		},
		BrowseTimeline: func(_ context.Context, site, _ string, limit int) ([]map[string]any, bool, error) {
			if site == "twitter" {
				return []map[string]any{
					{"id": "901", "title": "Tweet 901", "download_url": "https://x.com/alice/status/901", "thumbnail_url": "https://pbs.twimg.com/media/abc.jpg"},
				}, false, nil
			}
			// Generate 50 pixiv items so depth=48 triggers cursor "48:96"
			rows := make([]map[string]any, 50)
			for i := range rows {
				id := 701 + i
				rows[i] = map[string]any{
					"id":            fmt.Sprintf("%d", id),
					"title":         fmt.Sprintf("Artwork %d", id),
					"download_url":  fmt.Sprintf("https://www.pixiv.net/artworks/%d", id),
					"thumbnail_url": fmt.Sprintf("https://i.pximg.net/c/150/%d.jpg", id),
					"media_count":   i%3 + 1,
				}
			}
			if limit < len(rows) {
				return rows[:limit], true, nil
			}
			return rows, false, nil
		},
		BrowseEHPages: func(_ context.Context, _ string, limit int) ([]map[string]any, int, error) {
			return []map[string]any{
				{"page": 1, "title": "P1", "thumbnail_url": "https://ehgt.org/t/00/sheet.jpg", "thumbnail_sprite": map[string]int{"x": 0, "y": 0, "width": 100, "height": 140}},
				{"page": 2, "title": "P2", "thumbnail_url": "https://ehgt.org/t/00/sheet.jpg"},
			}, 42, nil
		},
		Discover: func(_ context.Context, site, target string, _ int, _ string) (map[string]any, error) {
			pawchiveTargets = append(pawchiveTargets, target)
			// Return 51 candidates on page 1 so hasMore=true and NextCursor="50".
			cands := make([]any, 51)
			for i := range cands {
				cands[i] = map[string]any{
					"id":            "pw-" + string(rune('a'+i%26)),
					"title":         "Paw Item",
					"download_url":  "https://pawchive.pw/patreon/user/9/post/1",
					"thumbnail_url": "https://img.pawchive.pw/thumbnail/a.jpg",
					"media_count":   1,
				}
			}
			return map[string]any{"candidates": cands}, nil
		},
	})

	// Danbooru provenance: in_dataset, in_library, and source_key in_dataset
	danRes, err := svc.Browse(ctx, "ds-browse", BrowseRequest{
		Source: SourceSpec{ID: "d", Site: "danbooru", Kind: "search", Query: "tag"},
		Limit:  48,
	})
	if err != nil {
		t.Fatalf("Browse danbooru: %v", err)
	}
	if len(danRes.Items) != 3 || danRes.NextCursor != "b100" ||
		danRes.Items[0].LocalState != "in_dataset" ||
		danRes.Items[1].LocalState != "in_library" ||
		danRes.Items[2].LocalState != "in_dataset" {
		t.Fatalf("unexpected danbooru provenance: %+v", danRes.Items)
	}

	// Pixiv timeline pagination + source_key provenance
	pixRes1, err := svc.Browse(ctx, "ds-browse", BrowseRequest{
		Source: SourceSpec{ID: "p", Site: "pixiv", Kind: "timeline", URL: "https://www.pixiv.net/users/1/artworks"},
		Limit:  48,
	})
	if err != nil || len(pixRes1.Items) != 48 || pixRes1.Items[0].LocalState != "in_dataset" || pixRes1.NextCursor == "" {
		t.Fatalf("unexpected pixiv page 1: err=%v len=%d cursor=%s", err, len(pixRes1.Items), pixRes1.NextCursor)
	}
	pixRes2, err := svc.Browse(ctx, "ds-browse", BrowseRequest{
		Source: SourceSpec{ID: "p", Site: "pixiv", Kind: "timeline", URL: "https://www.pixiv.net/users/1/artworks"},
		Cursor: pixRes1.NextCursor,
		Limit:  48,
	})
	if err != nil || len(pixRes2.Items) != 2 || pixRes2.Items[0].ID != "749" {
		t.Fatalf("unexpected pixiv page 2: err=%v res=%+v", err, pixRes2)
	}

	// Twitter timeline
	twRes, err := svc.Browse(ctx, "ds-browse", BrowseRequest{
		Source: SourceSpec{ID: "t", Site: "twitter", Kind: "timeline", URL: "https://x.com/alice/media"},
	})
	if err != nil || len(twRes.Items) != 1 || !strings.HasPrefix(twRes.Items[0].PreviewURL, "/api/v1/collect/media/") {
		t.Fatalf("unexpected twitter browse: err=%v res=%+v", err, twRes)
	}

	// EH gallery total + signed sprite crop
	ehRes, err := svc.Browse(ctx, "ds-browse", BrowseRequest{
		Source: SourceSpec{ID: "e", Site: "exhentai", Kind: "eh_gallery", URL: "https://exhentai.org/g/12/abcdef0123/"},
		Limit:  2,
	})
	if err != nil || ehRes.Total == nil || *ehRes.Total != 42 || ehRes.NextCursor != "2" || !strings.HasPrefix(ehRes.Items[0].PreviewURL, "/api/v1/collect/media/") {
		t.Fatalf("unexpected eh browse: err=%v res=%+v", err, ehRes)
	}

	// Pawchive o=0 and o=50 offset pagination
	paw1, err := svc.Browse(ctx, "ds-browse", BrowseRequest{
		Source: SourceSpec{ID: "pw", Site: "pawchive", Kind: "timeline", URL: "https://pawchive.pw/patreon/user/9"},
		Limit:  48,
	})
	if err != nil || len(paw1.Items) != 50 || paw1.NextCursor != "50" {
		t.Fatalf("unexpected pawchive page 1: err=%v len=%d cursor=%s", err, len(paw1.Items), paw1.NextCursor)
	}
	if _, err := svc.Browse(ctx, "ds-browse", BrowseRequest{
		Source: SourceSpec{ID: "pw", Site: "pawchive", Kind: "timeline", URL: "https://pawchive.pw/patreon/user/9"},
		Cursor: "50",
		Limit:  48,
	}); err != nil {
		t.Fatalf("unexpected pawchive page 2: %v", err)
	}
	if len(pawchiveTargets) != 2 || !strings.Contains(pawchiveTargets[0], "o=0") || !strings.Contains(pawchiveTargets[1], "o=50") {
		t.Fatalf("expected pawchive o=0 and o=50 offsets, got %v", pawchiveTargets)
	}
}

func TestSubmitIdempotencyRecheckReuseDedupAndOrdering(t *testing.T) {
	ctx := context.Background()
	db := openCollectTestStore(t)

	execSQL(t, db, `INSERT INTO datasets(id,name,kind,created_at,updated_at) VALUES('ds-sub','Submit','character',1,1)`)
	execSQL(t, db, `INSERT INTO crawl_batches(id,status,output_dir,max_tasks,concurrency,created_at,updated_at) VALUES('batch-old','succeeded','/tmp/sub',10,1,1,1)`)
	execSQL(t, db, `INSERT INTO danbooru_import_items(batch_id,post_id,file_name) VALUES('batch-old','201','reuse.png')`)
	execSQL(t, db, `INSERT INTO gallery_sources(id,kind,batch_id,display_name,root_path,canonical_root_key,availability,created_at,updated_at) VALUES('src-old','crawl','batch-old','old','/tmp/sub','/tmp/sub','available',1,1)`)
	execSQL(t, db, `INSERT INTO gallery_directories(id,source_id,relative_path,name,sort_key,created_at,updated_at) VALUES('dir-old','src-old','','root','root',1,1)`)
	execSQL(t, db, `INSERT INTO gallery_assets(id,source_id,directory_id,relative_path,name,extension,sort_key,size_bytes,modified_ns,created_at,updated_at) VALUES
		('asset-reuse','src-old','dir-old','reuse.png','reuse.png','png','reuse.png',100,1,1,1)`)

	var attachedIDs []string
	var startCalls int
	var capturedCrawl crawls.Request

	svc := New(Dependencies{
		Store:          db,
		RequireDataset: func(context.Context, string) error { return nil },
		MemberRows:     func(context.Context, string) ([]map[string]any, error) { return nil, nil },
		AttachAssets: func(_ context.Context, _ string, ids []string) (int, error) {
			attachedIDs = append(attachedIDs, ids...)
			return len(ids), nil
		},
		DanbooruReq: func(context.Context) (discovery.Request, error) { return discovery.Request{}, nil },
		DanbooruBrowse: func(_ context.Context, _ discovery.Request, opts discovery.DanbooruBrowseOptions) (*discovery.DanbooruBrowsePage, error) {
			if strings.HasPrefix(opts.Query, "id:") {
				// 201 is reused from library, 202 is valid with pixiv:800 source, 203 fails recheck (omitted).
				return &discovery.DanbooruBrowsePage{
					Items: []discovery.DanbooruPost{
						{ID: "201", Title: "Reuse", FileExt: "png", Downloadable: true, URL: "https://danbooru.donmai.us/posts/201"},
						{ID: "202", Title: "Valid", FileExt: "jpg", Downloadable: true, URL: "https://danbooru.donmai.us/posts/202", SourceURL: "https://www.pixiv.net/artworks/800"},
					},
				}, nil
			}
			return &discovery.DanbooruBrowsePage{
				Items: []discovery.DanbooruPost{
					{ID: "201", Title: "Reuse", FileExt: "png", Downloadable: true, URL: "https://danbooru.donmai.us/posts/201"},
					{ID: "202", Title: "Valid", FileExt: "jpg", Downloadable: true, URL: "https://danbooru.donmai.us/posts/202", SourceURL: "https://www.pixiv.net/artworks/800"},
					{ID: "203", Title: "Gone", FileExt: "png", Downloadable: true, URL: "https://danbooru.donmai.us/posts/203"},
				},
			}, nil
		},
		BrowseEHPages: func(context.Context, string, int) ([]map[string]any, int, error) {
			return nil, 5, nil
		},
		StartCrawl: func(_ context.Context, _ string, raw json.RawMessage, _ string) (string, error) {
			startCalls++
			if err := json.Unmarshal(raw, &capturedCrawl); err != nil {
				t.Fatal(err)
			}
			execSQL(t, db, `INSERT INTO crawl_batches(id,status,output_dir,max_tasks,concurrency,created_at,updated_at) VALUES('batch-new-1','queued','/tmp/sub',10,1,1,1)`)
			return "batch-new-1", nil
		},
	})

	req := SubmitRequest{
		Sources: []SubmitSource{
			// Intentionally scrambled order: exhentai, pixiv, danbooru -> must sort to danbooru, pixiv, exhentai
			{
				Source: SourceSpec{ID: "eh-1", Site: "exhentai", Kind: "eh_gallery", Label: "EH #1", URL: "https://exhentai.org/g/1/0123456789/"},
				Range:  SubmitRange{Mode: "pages", PageStart: 2, PageEnd: 4, ExcludedPages: []int{3}, ExtraPages: []int{6}},
			},
			{
				Source: SourceSpec{ID: "px-1", Site: "pixiv", Kind: "timeline", Label: "Pixiv #1", URL: "https://www.pixiv.net/users/1/artworks"},
				Range: SubmitRange{
					Mode:        "top_n",
					TopN:        20,
					ExcludedIDs: []string{"801"},
					// Extra item 800 duplicates Danbooru post 202's pixiv:800 source_key -> skipped!
					Items: []SubmitItem{{ID: "800", URL: "https://www.pixiv.net/artworks/800", Title: "Dup Work"}},
				},
			},
			{
				Source: SourceSpec{ID: "dan-1", Site: "danbooru", Kind: "search", Label: "tag", Query: "tag"},
				Range:  SubmitRange{Mode: "top_n", TopN: 3},
			},
		},
	}

	res, err := svc.Submit(ctx, "ds-sub", req, "idem-key-1")
	if err != nil {
		t.Fatalf("Submit failed: %v", err)
	}
	if res.BatchID == nil || *res.BatchID != "batch-new-1" || res.ReusedCount != 1 || res.SkippedCount != 2 {
		// SkippedCount: Danbooru 203 unavailable recheck (1) + Pixiv 800 cross-source dedup with Danbooru 202 (1) = 2
		t.Fatalf("unexpected submit response: %+v", res)
	}
	if !reflect.DeepEqual(attachedIDs, []string{"asset-reuse"}) {
		t.Fatalf("expected reused asset attach, got %v", attachedIDs)
	}
	if len(capturedCrawl.Sources) != 3 ||
		capturedCrawl.Sources[0].Site != "danbooru" ||
		capturedCrawl.Sources[1].Site != "pixiv" ||
		capturedCrawl.Sources[2].Site != "exhentai" {
		t.Fatalf("unexpected site order: %+v", capturedCrawl.Sources)
	}
	if got := capturedCrawl.Sources[2].Addresses[0].EHPages; !reflect.DeepEqual(got, []int{2, 4, 6}) {
		t.Fatalf("unexpected EH pages after exclusion + extra: %v", got)
	}
	if got := capturedCrawl.Sources[1].Addresses[0]; got.ItemLimit == nil || *got.ItemLimit != 20 || !reflect.DeepEqual(got.ExcludedIDs, []string{"801"}) {
		t.Fatalf("unexpected pixiv address limit/exclusions: %+v", got)
	}
	// Extra item 800 should NOT be added to pixiv addresses due to danbooru->pixiv source_key dedup.
	if len(capturedCrawl.Sources[1].Addresses) != 1 {
		t.Fatalf("expected cross-source dedup to skip pixiv extra 800, got %+v", capturedCrawl.Sources[1].Addresses)
	}

	// Idempotent replay with same key returns cached response without re-running StartCrawl
	replay, err := svc.Submit(ctx, "ds-sub", req, "idem-key-1")
	if err != nil || startCalls != 1 || replay.BatchID == nil || *replay.BatchID != "batch-new-1" {
		t.Fatalf("unexpected replay: err=%v startCalls=%d replay=%+v", err, startCalls, replay)
	}

	// Same key with different payload -> 409 Conflict
	otherReq := SubmitRequest{
		Sources: []SubmitSource{{
			Source: SourceSpec{ID: "eh-2", Site: "exhentai", Kind: "eh_gallery", Label: "EH #2", URL: "https://exhentai.org/g/2/0123456789/"},
			Range:  SubmitRange{Mode: "all"},
		}},
	}
	if _, err := svc.Submit(ctx, "ds-sub", otherReq, "idem-key-1"); err == nil {
		t.Fatal("expected 409 conflict on reused key with different body")
	} else if own, ok := err.(*Error); !ok || own.Status != 409 {
		t.Fatalf("expected 409, got %v", err)
	}

	// Verify HTTP Register routes & error mapping quickly
	mux := http.NewServeMux()
	svc.Register(mux)
	badReq := httptest.NewRequest("POST", "/api/v1/datasets/ds-sub/collect/resolve", strings.NewReader(`{"input":"   ","unknown":1}`))
	badRec := httptest.NewRecorder()
	mux.ServeHTTP(badRec, badReq)
	if badRec.Code != 422 {
		t.Fatalf("expected 422 for unknown JSON field, got %d", badRec.Code)
	}
}
