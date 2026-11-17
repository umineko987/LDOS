package main

import (
	"database/sql"
	"encoding/json"
	"image"
	"image/color"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ldos/backend/internal/datasets"
	"ldos/backend/internal/gallerycatalog"
)

// Start with an indexed batch whose automatic move completed before the catalog
// was notified. The manual group is still awaiting a decision.
func nativeVisibilityFixture(t *testing.T) (*businessRuntime, http.Handler, string, string, string) {
	t.Helper()
	b, root := nativeBusinessFixture(t, true)
	ctx := b.ctx
	output := filepath.Join(root, "downloads/visibility")
	for name, shade := range map[string]uint8{"kept": 10, "automatic": 20, "manual": 30} {
		nativePicture(t, filepath.Join(output, name+".png"), shade)
		nativeOK(t, os.WriteFile(filepath.Join(output, name+".txt"), []byte(name+", caption"), 0600))
	}
	nativeOK(t, b.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO crawl_batches(id,status,output_dir,concurrency,max_tasks,created_at,updated_at) VALUES('visibility','succeeded',?,1,100,1,1)`, output)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO crawl_reviews(batch_id,status,total_image_count,total_group_count,duplicate_group_count,automatic_group_count,rejected_image_count,automatic_rejected_image_count,created_at,updated_at) VALUES('visibility','ready',3,1,1,1,1,1,1,1)`)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO crawl_review_groups(batch_id,id,ordinal,kind,decided,created_at,updated_at) VALUES('visibility','manual-group',1,'duplicate',0,1,1),('visibility','automatic-group',2,'auto_exact',1,1,1)`)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO crawl_review_images(batch_id,id,group_id,ordinal,relative_path,selected,disposition,final_relative_path,created_at,updated_at) VALUES('visibility','kept','manual-group',1,'kept.png',1,'pending','',1,1),('visibility','manual','manual-group',2,'manual.png',1,'pending','',1,1),('visibility','automatic','automatic-group',3,'automatic.png',0,'rejected','duplicates/automatic.png',1,1)`)
		return err
	}))
	source, err := b.gallery.AutoRegisterBatchSource(ctx, "visibility", output, "Visibility", true)
	nativeOK(t, err)
	sid := valueString(source["source_id"])
	_, err = b.gallery.Scan(ctx, sid)
	nativeOK(t, err)
	dataset, err := b.datasets.Create(ctx, datasets.CreateOptions{Name: "Visibility", Kind: "character"})
	nativeOK(t, err)
	did := valueString(dataset["dataset_id"])
	_, _, err = b.datasets.AttachSource(ctx, did, sid)
	nativeOK(t, err)
	nativeOK(t, b.datasets.WaitHashing(ctx))
	nativeOK(t, os.MkdirAll(filepath.Join(output, "duplicates"), 0700))
	for _, ext := range []string{".png", ".txt"} {
		nativeOK(t, os.Rename(filepath.Join(output, "automatic"+ext), filepath.Join(output, "duplicates/automatic"+ext)))
	}
	mux := http.NewServeMux()
	b.register(mux)
	return b, mux, output, sid, did
}

func nativeVisibilityRequest(t *testing.T, h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("%s %s: HTTP %d: %s", method, target, w.Code, w.Body.String())
	}
	return w
}

func nativeVisibilityJSON(t *testing.T, h http.Handler, method, target, body string, out any) {
	t.Helper()
	w := nativeVisibilityRequest(t, h, method, target, body)
	if err := json.Unmarshal(w.Body.Bytes(), out); err != nil {
		t.Fatalf("decode %s: %v: %s", target, err, w.Body.String())
	}
}

func nativeVisibilityImage(t *testing.T, h http.Handler, target string) image.Image {
	t.Helper()
	w := nativeVisibilityRequest(t, h, http.MethodGet, target, "")
	im, _, err := image.Decode(w.Body)
	if err != nil || !strings.HasPrefix(w.Header().Get("Content-Type"), "image/") {
		t.Fatalf("decode image %s: content type %q, error %v", target, w.Header().Get("Content-Type"), err)
	}
	return im
}

func nativeVisibilityPicture(t *testing.T, h http.Handler, target string, shade uint8) {
	t.Helper()
	im := nativeVisibilityImage(t, h, target)
	pixel := color.NRGBAModel.Convert(im.At(0, 0)).(color.NRGBA)
	if im.Bounds() != image.Rect(0, 0, 3, 2) || pixel != (color.NRGBA{R: shade, A: 255}) {
		t.Fatalf("%s served the wrong image: bounds %v, pixel %v", target, im.Bounds(), pixel)
	}
}

func nativeVisibilityAssertLists(t *testing.T, h http.Handler, sid, did string, want map[string]uint8) {
	t.Helper()
	type asset struct {
		AssetID      string `json:"asset_id"`
		RelativePath string `json:"relative_path"`
		ThumbnailURL string `json:"thumbnail_url"`
	}
	var members struct {
		Items      []asset `json:"items"`
		Total      int     `json:"total"`
		NextCursor *string `json:"next_cursor"`
	}
	nativeVisibilityJSON(t, h, "GET", "/api/v1/datasets/"+did+"/members", "", &members)
	if members.Total != len(want) || len(members.Items) != len(want) || members.NextCursor != nil {
		t.Fatalf("unexpected member page: %+v", members)
	}
	seen := map[string]bool{}
	for _, member := range members.Items {
		shade, ok := want[member.RelativePath]
		if !ok || seen[member.RelativePath] || member.AssetID != gallerycatalog.AssetID(sid, member.RelativePath) {
			t.Fatalf("unexpected member: %+v", member)
		}
		seen[member.RelativePath] = true
		nativeVisibilityPicture(t, h, "/api/v1/gallery/assets/"+member.AssetID+"/content", shade)
		thumbnail := nativeVisibilityImage(t, h, member.ThumbnailURL)
		if thumbnail.Bounds().Empty() {
			t.Fatalf("empty thumbnail for %+v", member)
		}
	}
	var source struct {
		RootDirectoryID string `json:"root_directory_id"`
		AssetCount      int    `json:"asset_count"`
	}
	nativeVisibilityJSON(t, h, "GET", "/api/v1/gallery/sources/"+sid, "", &source)
	var entries struct {
		Assets      []asset `json:"assets"`
		AssetCursor *string `json:"asset_cursor"`
	}
	nativeVisibilityJSON(t, h, "GET", "/api/v1/gallery/directories/"+source.RootDirectoryID+"/entries?include_descendants=true", "", &entries)
	if source.AssetCount != len(want) || len(entries.Assets) != len(want) || entries.AssetCursor != nil {
		t.Fatalf("unexpected gallery page: source %+v, entries %+v", source, entries)
	}
	seen = map[string]bool{}
	for _, item := range entries.Assets {
		if _, ok := want[item.RelativePath]; !ok || seen[item.RelativePath] || item.AssetID != gallerycatalog.AssetID(sid, item.RelativePath) {
			t.Fatalf("gallery revived a rejected entry: %+v", item)
		}
		seen[item.RelativePath] = true
	}
}

func nativeVisibilityAssertCaptions(t *testing.T, h http.Handler, sid, did string, want map[string]string) {
	t.Helper()
	var captions struct {
		Items []struct {
			AssetID string `json:"asset_id"`
			State   string `json:"state"`
			Text    string `json:"text"`
		} `json:"items"`
	}
	nativeVisibilityJSON(t, h, "GET", "/api/v1/datasets/"+did+"/captions", "", &captions)
	if len(captions.Items) != len(want) {
		t.Fatalf("caption listing includes rejected assets: %+v", captions)
	}
	expected := map[string]string{}
	for path, text := range want {
		expected[gallerycatalog.AssetID(sid, path)] = text
	}
	for _, caption := range captions.Items {
		text, ok := expected[caption.AssetID]
		if !ok || caption.State != "normal" || caption.Text != text {
			t.Fatalf("caption paired with the wrong image: %+v", caption)
		}
		delete(expected, caption.AssetID)
	}
}

func nativeVisibilitySync(t *testing.T, b *businessRuntime) {
	t.Helper()
	batch, err := b.crawls.Get(b.ctx, "visibility")
	nativeOK(t, err)
	nativeOK(t, b.batchFinished(b.ctx, batch))
}

func TestNativeReviewVisibilityHTTPAfterAutomaticRecovery(t *testing.T) {
	b, h, _, sid, did := nativeVisibilityFixture(t)
	nativeVisibilitySync(t, b)
	nativeVisibilityAssertLists(t, h, sid, did, map[string]uint8{"kept.png": 10, "manual.png": 30})
	nativeVisibilityAssertCaptions(t, h, sid, did, map[string]string{"kept.png": "kept, caption", "manual.png": "manual, caption"})
	// Automatic groups are hidden from the manual page, but their moved files
	// must still be readable through the production review image endpoint.
	nativeVisibilityPicture(t, h, "/api/v1/crawls/visibility/review/images/automatic", 20)
	var review struct {
		Status                 string `json:"status"`
		AutomaticRejectedCount int    `json:"automaticRejectedImageCount"`
	}
	nativeVisibilityJSON(t, h, "GET", "/api/v1/crawls/visibility/review?view=desktop", "", &review)
	if review.Status != "ready" || review.AutomaticRejectedCount != 1 {
		t.Fatalf("recovery prematurely completed the manual review: %+v", review)
	}
}

func TestNativeReviewVisibilityCaptionPairsSurviveApplyAndRescan(t *testing.T) {
	for _, collision := range []bool{false, true} {
		name := "free_destination"
		if collision {
			name = "existing_destination_caption"
		}
		t.Run(name, func(t *testing.T) {
			b, h, output, sid, did := nativeVisibilityFixture(t)
			nativeVisibilitySync(t, b)
			if collision {
				// An orphan caption reserves the unsuffixed destination. The image
				// and its own caption must move together without overwriting it.
				nativeOK(t, os.WriteFile(filepath.Join(output, "duplicates/manual.txt"), []byte("unrelated caption"), 0600))
			}
			var operation struct {
				Status   string `json:"status"`
				Failed   int    `json:"failed_image_count"`
				Rejected int    `json:"rejected_image_count"`
			}
			nativeVisibilityJSON(t, h, "PUT", "/api/v1/crawls/visibility/review/decisions", `{"groups":[{"group_id":"manual-group","selected_image_ids":["kept"]}]}`, &operation)
			nativeVisibilityJSON(t, h, "POST", "/api/v1/crawls/visibility/review/apply", "", &operation)
			if operation.Status != "applied" || operation.Failed != 0 || operation.Rejected != 2 {
				t.Fatalf("apply failed: %+v", operation)
			}
			finalStem := "duplicates/manual"
			if collision {
				finalStem += "_1"
			}
			assertPairs := func() {
				t.Helper()
				_, err := os.Stat(filepath.Join(output, finalStem+".png"))
				nativeOK(t, err)
				for path, want := range map[string]string{"kept.txt": "kept, caption", "duplicates/automatic.txt": "automatic, caption", finalStem + ".txt": "manual, caption"} {
					data, err := os.ReadFile(filepath.Join(output, path))
					nativeOK(t, err)
					if string(data) != want {
						t.Fatalf("%s caption = %q, want %q", path, data, want)
					}
				}
				for _, path := range []string{"manual.png", "manual.txt", "automatic.png", "automatic.txt"} {
					if _, err := os.Stat(filepath.Join(output, path)); !os.IsNotExist(err) {
						t.Fatalf("rejected original %s still exists: %v", path, err)
					}
				}
				if collision {
					data, err := os.ReadFile(filepath.Join(output, "duplicates/manual.txt"))
					nativeOK(t, err)
					if string(data) != "unrelated caption" {
						t.Fatalf("overwrote existing destination caption: %q", data)
					}
				}
			}
			assertVisible := func() {
				t.Helper()
				nativeVisibilityAssertLists(t, h, sid, did, map[string]uint8{"kept.png": 10})
				nativeVisibilityAssertCaptions(t, h, sid, did, map[string]string{"kept.png": "kept, caption"})
				nativeVisibilityPicture(t, h, "/api/v1/crawls/visibility/review/images/manual", 30)
				nativeVisibilityPicture(t, h, "/api/v1/crawls/visibility/review/images/automatic", 20)
				assertPairs()
			}
			assertVisible()
			for range 2 {
				_, err := b.gallery.Scan(b.ctx, sid)
				nativeOK(t, err)
				// Check the scan itself before a later synchronization can mask it.
				assertVisible()
				nativeVisibilitySync(t, b)
				assertVisible()
			}
		})
	}
}
