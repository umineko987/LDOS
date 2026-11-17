package danboorucollect

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/proxytransport"
)

const maxMediaBytes = 12 << 20
const maxMediaCacheBytes = 64 << 20

type cachedMedia struct {
	data        []byte
	contentType string
	expires     time.Time
}

func allowedMediaURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.User == nil && u.Port() == "" && u.Fragment == "" && (u.Host == "cdn.donmai.us" || u.Host == "danbooru.donmai.us") && u.Path != "" && u.RawQuery == ""
}

func (s *Service) Media(ctx context.Context, token, size string) ([]byte, string, error) {
	if size == "" {
		size = "preview"
	}
	if size != "preview" && size != "sample" {
		return nil, "", problem(422, "invalid_preview_size", "预览尺寸无效")
	}
	s.mu.Lock()
	item, ok := s.entries[token]
	s.mu.Unlock()
	if !ok || time.Now().After(item.expires) {
		return nil, "", problem(410, "danbooru_preview_expired", "预览已过期，请重新加载候选")
	}
	target := item.post.PreviewURL
	if size == "sample" {
		target = item.post.SampleURL
	}
	if !allowedMediaURL(target) {
		return nil, "", problem(404, "danbooru_preview_unavailable", "此图片没有可用的预览")
	}
	s.mu.Lock()
	cached, hit := s.media[target]
	s.mu.Unlock()
	if hit && time.Now().Before(cached.expires) {
		return cached.data, cached.contentType, nil
	}
	select {
	case s.mediaSlots <- struct{}{}:
	case <-ctx.Done():
		return nil, "", ctx.Err()
	}
	defer func() { <-s.mediaSlots }()
	// Recheck after waiting for a slot, so simultaneous cards can share a fetch.
	s.mu.Lock()
	cached, hit = s.media[target]
	s.mu.Unlock()
	if hit && time.Now().Before(cached.expires) {
		return cached.data, cached.contentType, nil
	}
	request, err := s.deps.Request(ctx)
	if err != nil {
		return nil, "", err
	}
	fetch := s.deps.FetchMedia
	if fetch == nil {
		fetch = s.fetchMedia
	}
	data, contentType, err := fetch(ctx, target, request)
	if err != nil {
		return nil, "", err
	}
	if len(data) > maxMediaBytes || !safeImageType(http.DetectContentType(data)) {
		return nil, "", problem(502, "invalid_danbooru_preview", "站点未返回受支持的图片预览")
	}
	contentType = http.DetectContentType(data)
	s.mu.Lock()
	if old, ok := s.media[target]; ok {
		s.mediaBytes -= len(old.data)
		delete(s.media, target)
		for i, key := range s.mediaOrder {
			if key == target {
				s.mediaOrder = append(s.mediaOrder[:i], s.mediaOrder[i+1:]...)
				break
			}
		}
	}
	for s.mediaBytes+len(data) > maxMediaCacheBytes && len(s.mediaOrder) > 0 {
		key := s.mediaOrder[0]
		s.mediaOrder = s.mediaOrder[1:]
		s.mediaBytes -= len(s.media[key].data)
		delete(s.media, key)
	}
	s.media[target] = cachedMedia{data, contentType, time.Now().Add(10 * time.Minute)}
	s.mediaOrder = append(s.mediaOrder, target)
	s.mediaBytes += len(data)
	s.mu.Unlock()
	return data, contentType, nil
}

func safeImageType(value string) bool {
	return value == "image/jpeg" || value == "image/png" || value == "image/gif" || value == "image/webp"
}

func (s *Service) fetchMedia(ctx context.Context, target string, request discovery.Request) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	policy := request.Policy
	result, err := s.deps.Transport.Execute(ctx, discovery.ExecuteOptions{
		URL: target, Mode: request.ProxyMode, Policy: policy, Prefix: "danbooru-preview-", Secure: true, AcquireErrorFatal: true,
		Operation: func(ctx context.Context, attempt discovery.Attempt) (any, error) {
			endpoint := ""
			if attempt.Lease != nil {
				endpoint = attempt.Lease.Endpoint
			}
			client, closeClient, err := proxytransport.NewHTTPClient(ctx, endpoint, 15*time.Second)
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
			// Never forward API credentials or cookies to media hosts. Redirects are disabled.
			response, err := client.Do(req)
			if err != nil {
				return nil, errors.New("无法获取 Danbooru 图片预览")
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				return nil, problem(502, "danbooru_preview_failed", "站点暂时无法提供图片预览")
			}
			if response.ContentLength > maxMediaBytes {
				return nil, problem(502, "danbooru_preview_too_large", "站点图片预览超过大小限制")
			}
			data, err := io.ReadAll(io.LimitReader(response.Body, maxMediaBytes+1))
			if err != nil {
				return nil, err
			}
			mime := http.DetectContentType(data)
			if len(data) > maxMediaBytes || !safeImageType(mime) {
				return nil, problem(502, "invalid_danbooru_preview", "站点未返回受支持的图片预览")
			}
			return cachedMedia{data: data, contentType: mime}, nil
		},
		Classify: func(err error, _ discovery.Attempt) *discovery.Failure {
			return &discovery.Failure{Message: "无法获取 Danbooru 图片预览", ErrorClass: "preview_failed", Retryable: false, ProxyFault: false}
		},
	})
	if err != nil {
		return nil, "", problem(502, "danbooru_preview_failed", "无法获取 Danbooru 图片预览")
	}
	media := result.Value.(cachedMedia)
	return media.data, strings.TrimSpace(media.contentType), nil
}
