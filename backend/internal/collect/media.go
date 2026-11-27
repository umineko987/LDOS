package collect

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/draw"
	_ "image/jpeg"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	_ "golang.org/x/image/webp"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/proxytransport"
)

type Service struct {
	deps       Dependencies
	mediaKey   []byte
	mu         sync.Mutex
	submitMu   sync.Mutex
	cache      map[string]cachedMedia
	cacheOrder []string
	cacheBytes int
	mediaSlots chan struct{}
}

type cachedMedia struct {
	data        []byte
	contentType string
}

type mediaClaims struct {
	Site string  `json:"s"`
	URL  string  `json:"u"`
	Crop *[4]int `json:"c,omitempty"`
}

func New(deps Dependencies) *Service {
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	return &Service{
		deps:       deps,
		mediaKey:   key,
		cache:      make(map[string]cachedMedia),
		mediaSlots: make(chan struct{}, 8),
	}
}

func (s *Service) signMedia(site, raw string, crop *[4]int) string {
	normalized, ok := allowedMediaURL(site, raw)
	if !ok {
		return ""
	}
	var safeCrop *[4]int
	if crop != nil {
		rect := spriteRect(crop[0], crop[1], crop[2], crop[3])
		if rect.Empty() {
			return ""
		}
		copyCrop := *crop
		safeCrop = &copyCrop
	}
	payload, err := json.Marshal(mediaClaims{Site: site, URL: normalized, Crop: safeCrop})
	if err != nil {
		return ""
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, s.mediaKey)
	_, _ = mac.Write([]byte(encoded))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return "/api/v1/collect/media/" + encoded + "." + sig
}

func (s *Service) verifyMediaToken(token string) (mediaClaims, error) {
	encoded, sigRaw, ok := strings.Cut(token, ".")
	if !ok || encoded == "" || sigRaw == "" || len(token) > 8192 {
		return mediaClaims{}, problem(400, "invalid_media_token", "媒体预览令牌无效")
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigRaw)
	if err != nil {
		return mediaClaims{}, problem(400, "invalid_media_token", "媒体预览令牌无效")
	}
	mac := hmac.New(sha256.New, s.mediaKey)
	_, _ = mac.Write([]byte(encoded))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return mediaClaims{}, problem(403, "invalid_media_token", "媒体预览签名无效")
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return mediaClaims{}, problem(400, "invalid_media_token", "媒体预览令牌无效")
	}
	var claims mediaClaims
	if err := json.Unmarshal(raw, &claims); err != nil {
		return mediaClaims{}, problem(400, "invalid_media_token", "媒体预览令牌无效")
	}
	normalized, ok := allowedMediaURL(claims.Site, claims.URL)
	if !ok {
		return mediaClaims{}, problem(403, "invalid_media_target", "媒体来源地址不受支持")
	}
	claims.URL = normalized
	if claims.Crop != nil {
		if spriteRect(claims.Crop[0], claims.Crop[1], claims.Crop[2], claims.Crop[3]).Empty() {
			return mediaClaims{}, problem(400, "invalid_media_crop", "媒体裁剪参数无效")
		}
	}
	return claims, nil
}

func allowedMediaURL(site, raw string) (string, bool) {
	if len(raw) == 0 || len(raw) > 4096 {
		return "", false
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Path == "" || u.Path == "/" || u.Fragment != "" {
		return "", false
	}
	host := strings.ToLower(u.Host)
	query := url.Values{}
	switch site {
	case "danbooru":
		if (host != "cdn.donmai.us" && host != "danbooru.donmai.us") || u.RawQuery != "" {
			return "", false
		}
	case "pixiv":
		if host != "i.pximg.net" || u.RawQuery != "" {
			return "", false
		}
	case "twitter":
		if host != "pbs.twimg.com" {
			return "", false
		}
		values := u.Query()
		if format := values.Get("format"); slices.Contains([]string{"jpg", "jpeg", "png", "webp", "gif"}, format) {
			query.Set("format", format)
		}
		if name := values.Get("name"); slices.Contains([]string{"thumb", "small", "medium", "large", "orig", "360x360", "900x900", "4096x4096"}, name) {
			query.Set("name", name)
		}
	case "exhentai":
		if (host != "ehgt.org" && !strings.HasSuffix(host, ".ehgt.org") && host != "s.exhentai.org") || u.RawQuery != "" {
			return "", false
		}
	case "pawchive":
		if u.RawQuery != "" {
			return "", false
		}
		if !(host == "img.pawchive.pw" && strings.HasPrefix(u.Path, "/thumbnail/")) &&
			!(host == "pawchive.pw" && strings.HasPrefix(u.Path, "/icons/")) {
			return "", false
		}
	default:
		return "", false
	}
	u.Host = host
	u.RawQuery, u.ForceQuery = query.Encode(), false
	return u.String(), true
}

func (s *Service) Media(ctx context.Context, token string) ([]byte, string, error) {
	claims, err := s.verifyMediaToken(token)
	if err != nil {
		return nil, "", err
	}

	s.mu.Lock()
	if cached, hit := s.cache[token]; hit {
		s.mu.Unlock()
		return cached.data, cached.contentType, nil
	}
	s.mu.Unlock()

	select {
	case s.mediaSlots <- struct{}{}:
	case <-ctx.Done():
		return nil, "", ctx.Err()
	}
	defer func() { <-s.mediaSlots }()

	s.mu.Lock()
	if cached, hit := s.cache[token]; hit {
		s.mu.Unlock()
		return cached.data, cached.contentType, nil
	}
	s.mu.Unlock()

	fetch := s.deps.FetchMedia
	if fetch == nil {
		fetch = s.fetchHTTPMedia
	}
	raw, err := fetch(ctx, claims.Site, claims.URL)
	if err != nil {
		return nil, "", err
	}
	mime := http.DetectContentType(raw)
	if len(raw) > maxMediaBytes || !safeImageType(mime) {
		return nil, "", problem(502, "invalid_collect_preview", "站点未返回受支持的图片预览")
	}
	data, contentType := raw, mime
	if claims.Crop != nil {
		rect := spriteRect(claims.Crop[0], claims.Crop[1], claims.Crop[2], claims.Crop[3])
		data, contentType, err = cropPreview(raw, rect)
		if err != nil {
			return nil, "", err
		}
	}

	s.mu.Lock()
	if old, ok := s.cache[token]; ok {
		s.cacheBytes -= len(old.data)
		delete(s.cache, token)
		for i, k := range s.cacheOrder {
			if k == token {
				s.cacheOrder = append(s.cacheOrder[:i], s.cacheOrder[i+1:]...)
				break
			}
		}
	}
	for s.cacheBytes+len(data) > maxCacheBytes && len(s.cacheOrder) > 0 {
		oldest := s.cacheOrder[0]
		s.cacheOrder = s.cacheOrder[1:]
		s.cacheBytes -= len(s.cache[oldest].data)
		delete(s.cache, oldest)
	}
	s.cache[token] = cachedMedia{data: data, contentType: contentType}
	s.cacheOrder = append(s.cacheOrder, token)
	s.cacheBytes += len(data)
	s.mu.Unlock()

	return data, contentType, nil
}

func (s *Service) fetchHTTPMedia(ctx context.Context, site, target string) ([]byte, error) {
	if s.deps.Transport == nil || s.deps.PolicyFor == nil {
		return nil, problem(503, "media_unavailable", "媒体预览服务尚未就绪")
	}
	policy, err := s.deps.PolicyFor(ctx, site)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	result, err := s.deps.Transport.Execute(ctx, discovery.ExecuteOptions{
		URL:               target,
		Mode:              policy.ProxyMode,
		Policy:            policy,
		Prefix:            "collect-preview",
		Secure:            true,
		AcquireErrorFatal: true,
		Operation: func(ctx context.Context, attempt discovery.Attempt) (any, error) {
			if attempt.Mode == "prefer" && attempt.Lease == nil {
				if err := s.deps.Transport.ValidateDirect(ctx, target); err != nil {
					return nil, err
				}
			}
			client, closeClient, err := proxytransport.NewHTTPClient(ctx, attempt.Endpoint(), 15*time.Second)
			if err != nil {
				return nil, err
			}
			defer closeClient()
			// Never follow arbitrary redirects or send user credentials to media CDNs.
			client.CheckRedirect = func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			}
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
			if response.StatusCode != http.StatusOK || response.ContentLength > maxMediaBytes {
				return nil, errors.New("preview response rejected")
			}
			return io.ReadAll(io.LimitReader(response.Body, maxMediaBytes+1))
		},
		Classify: func(err error, attempt discovery.Attempt) *discovery.Failure {
			var op *net.OpError
			var timeout net.Error
			fault := attempt.Lease != nil && (errors.Is(err, proxytransport.ErrProxyConnect) ||
				errors.As(err, &op) || (errors.As(err, &timeout) && timeout.Timeout()) ||
				errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF))
			return &discovery.Failure{Message: "无法获取站点图片预览", ErrorClass: "preview_failed", Retryable: fault, ProxyFault: fault}
		},
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, problem(502, "collect_preview_failed", "无法获取站点图片预览")
	}
	return result.Value.([]byte), nil
}

func safeImageType(value string) bool {
	return value == "image/jpeg" || value == "image/png" || value == "image/gif" || value == "image/webp"
}

func spriteRect(x, y, width, height int) image.Rectangle {
	const limit = 8192
	if x > 0 || x < -limit || y > 0 || y < -limit || width < 1 || width > 1024 || height < 1 || height > 1024 {
		return image.Rectangle{}
	}
	return image.Rect(-x, -y, -x+width, -y+height)
}

func cropPreview(data []byte, rect image.Rectangle) ([]byte, string, error) {
	invalid := problem(502, "invalid_collect_preview", "站点未返回受支持的图片预览")
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 1 || cfg.Height > (16<<20)/cfg.Width || !rect.In(image.Rect(0, 0, cfg.Width, cfg.Height)) {
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
