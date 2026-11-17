package discovery

import (
	"context"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"ldos/backend/internal/gallery"
)

// Exercise the real worker and vendor extractor matching, without network I/O.
// A stubbed auth resolver cannot detect an unrecognized extraction URL.
func TestDanbooruBrowseWithRealAuthResolver(t *testing.T) {
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	python := filepath.Join(root, "gallery-dl-backend", ".venv", "bin", "python")
	if _, err := os.Stat(python); err != nil {
		python, err = exec.LookPath("python3")
		if err != nil {
			t.Skip("gallery executor Python is required")
		}
	}
	if err := exec.Command(python, "-c", "import requests").Run(); err != nil {
		t.Skip("gallery executor requests dependency is required")
	}
	for _, authenticated := range []bool{false, true} {
		mode := "anonymous"
		if authenticated {
			mode = "configured"
		}
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			runner, err := gallery.New(gallery.Settings{
				RepoPath:         filepath.Join(root, "gallery-dl-codeberg"),
				CacheFile:        filepath.Join(dir, "cache.sqlite3"),
				PythonExecutable: python,
			}, filepath.Join(root, "backend", "executors"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(runner.StopAll)
			request := danTestRequest()
			request.TimeoutSeconds = 10
			if authenticated {
				request.ConfigFile = filepath.Join(dir, "auth.json")
				if err := os.WriteFile(request.ConfigFile, []byte(`{"extractor":{"danbooru":{"tag":{"username":"fixture","password":"fixture-key"}}}}`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			for _, options := range []DanbooruBrowseOptions{
				{Kind: "search"},
				{Kind: "search", Query: "scenery rating:g"},
				{Kind: "pool", Reference: "7"},
				{Kind: "favorite_group", Reference: "7"},
				{Kind: "favorites", Reference: "fixture"},
			} {
				t.Run(options.Kind+"/"+options.Query, func(t *testing.T) {
					a, _, _ := danTestAdapter()
					a.Transport.Gallery = runner
					calls := 0
					a.Transport.HTTPRequest = func(ctx context.Context, method, target string, params url.Values, payload any, endpoint string, timeout time.Duration) (HTTPResult, error) {
						calls++
						if got := danbooruRequestHeaders(ctx).Get("Authorization") != ""; got != authenticated {
							t.Fatalf("authentication preserved = %v, want %v", got, authenticated)
						}
						var body any = []any{}
						if options.Kind == "pool" || options.Kind == "favorite_group" {
							body = map[string]any{"id": 7, "name": "fixture", "post_ids": []int{}, "updated_at": "2026-11-17T00:00:00Z"}
						}
						return HTTPResult{StatusCode: 200, Payload: body}, nil
					}
					page, err := a.Browse(context.Background(), request, options)
					if err != nil || page == nil || calls == 0 {
						t.Fatalf("browse failed before metadata: page=%v calls=%d err=%v", page != nil, calls, err)
					}
				})
			}
		})
	}
}
