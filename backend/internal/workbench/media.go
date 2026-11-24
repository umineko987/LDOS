package workbench

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/draw"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	_ "golang.org/x/image/webp"
	"ldos/backend/internal/discovery"
	"ldos/backend/internal/proxytransport"
	"ldos/backend/internal/scheduler"
)

const maxPreviewBytes = 8 << 20

func previewTarget(site, raw string) string {
	if len(raw) > 4096 {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Path == "" || u.Path == "/" || u.Fragment != "" {
		return ""
	}
	// Keep only the known Twitter CDN format and resize arguments. Other
	// previews are fetched without URL arguments or credentials.
	query := url.Values{}
	switch site {
	case "pixiv":
		if u.Host != "i.pximg.net" {
			return ""
		}
	case "twitter":
		if u.Host != "pbs.twimg.com" {
			return ""
		}
		values := u.Query()
		if format := values.Get("format"); slices.Contains([]string{"jpg", "jpeg", "png", "webp", "gif"}, format) {
			query.Set("format", format)
		}
		if name := values.Get("name"); slices.Contains([]string{"thumb", "small", "medium", "large", "orig", "360x360", "4096x4096", "900x900"}, name) {
			query.Set("name", name)
		}
	case "exhentai":
		if u.Host != "ehgt.org" && !(u.Host == u.Hostname() && strings.HasSuffix(u.Host, ".ehgt.org")) && u.Host != "s.exhentai.org" {
			return ""
		}
	default:
		return ""
	}
	u.RawQuery, u.ForceQuery = query.Encode(), false
	return u.String()
}

func (s *Service) preview(ctx context.Context, dataset, snapshotID, itemID string) ([]byte, string, error) {
	if err := s.deps.RequireDataset(ctx, dataset); err != nil {
		return nil, "", err
	}
	s.mu.Lock()
	snap, err := s.lookupLocked(dataset, snapshotID)
	s.mu.Unlock()
	if err != nil {
		return nil, "", err
	}
	record := snap.entries[itemID]
	if record.preview == "" {
		return nil, "", problem(404, "workbench_preview_unavailable", "此项目没有可用预览")
	}
	select {
	case s.previewSlots <- struct{}{}:
	case <-ctx.Done():
		return nil, "", ctx.Err()
	}
	defer func() { <-s.previewSlots }()
	data, err := s.deps.FetchPreview(ctx, snap.site, record.preview)
	if err != nil {
		return nil, "", err
	}
	mime := http.DetectContentType(data)
	if len(data) > maxPreviewBytes || !slices.Contains([]string{"image/jpeg", "image/png", "image/webp", "image/gif"}, mime) {
		return nil, "", problem(502, "invalid_workbench_preview", "站点未返回受支持的图片预览")
	}
	if !record.crop.Empty() {
		return cropPreview(data, record.crop)
	}
	return data, mime, nil
}

func spriteCrop(sprite map[string]int) image.Rectangle {
	const limit = 8192
	x, y, width, height := sprite["x"], sprite["y"], sprite["width"], sprite["height"]
	if x > 0 || x < -limit || y > 0 || y < -limit || width < 1 || width > 1024 || height < 1 || height > 1024 {
		return image.Rectangle{}
	}
	return image.Rect(-x, -y, -x+width, -y+height)
}

func cropPreview(data []byte, rect image.Rectangle) ([]byte, string, error) {
	invalid := problem(502, "invalid_workbench_preview", "站点未返回受支持的图片预览")
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height > (16<<20)/config.Width || !rect.In(image.Rect(0, 0, config.Width, config.Height)) {
		return nil, "", invalid
	}
	sprite, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", invalid
	}
	crop := image.NewRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
	draw.Draw(crop, crop.Bounds(), sprite, rect.Min, draw.Src)
	var dst bytes.Buffer
	if err := png.Encode(&dst, crop); err != nil {
		return nil, "", err
	}
	return dst.Bytes(), "image/png", nil
}

// FetchHTTPPreview applies the site's proxy policy without sending site credentials.
func FetchHTTPPreview(ctx context.Context, transport *discovery.Transport, policy scheduler.Policy, site, target string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	result, err := transport.Execute(ctx, discovery.ExecuteOptions{
		URL: target, Mode: policy.ProxyMode, Policy: policy, Prefix: "workbench-preview", Secure: true, AcquireErrorFatal: true,
		Operation: func(ctx context.Context, attempt discovery.Attempt) (any, error) {
			if attempt.Mode == "prefer" && attempt.Lease == nil {
				if err := transport.ValidateDirect(ctx, target); err != nil {
					return nil, err
				}
			}
			client, closeClient, err := proxytransport.NewHTTPClient(ctx, attempt.Endpoint(), 15*time.Second)
			if err != nil {
				return nil, err
			}
			defer closeClient()
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
			if err != nil {
				return nil, err
			}
			req.Header.Set("Accept", "image/jpeg, image/png, image/webp, image/gif")
			req.Header.Set("User-Agent", "LDOS/0.1")
			if site == "pixiv" {
				req.Header.Set("Referer", "https://www.pixiv.net/")
			}
			response, err := client.Do(req)
			if err != nil {
				return nil, err
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK || response.ContentLength > maxPreviewBytes {
				return nil, errors.New("preview response rejected")
			}
			return io.ReadAll(io.LimitReader(response.Body, maxPreviewBytes+1))
		},
		Classify: func(error, discovery.Attempt) *discovery.Failure {
			return &discovery.Failure{Message: "无法获取站点图片预览", ErrorClass: "preview_failed"}
		},
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, problem(502, "workbench_preview_failed", "无法获取站点图片预览")
	}
	return result.Value.([]byte), nil
}
