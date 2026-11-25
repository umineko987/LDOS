package crawls

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"ldos/backend/internal/discovery"
	"ldos/backend/internal/redaction"
	"ldos/backend/internal/scheduler"
)

var ehGalleryRE = regexp.MustCompile(`(?i)^https?://(?:e-|ex)hentai\.org/g/([0-9]+)/([0-9a-f]{10})/?(?:[?#]|$)`)

type ehIndex struct {
	galleryID, title string
	total            int
	pages            map[int]ehPage
}

// BrowseEHPages returns the first limit page entries, in gallery order, and the
// gallery's full page count. Sprite offsets are signed CSS background positions.
func (s *Service) BrowseEHPages(ctx context.Context, target string, policy scheduler.Policy, mode, cookies string, limit int) ([]map[string]any, int, error) {
	if limit <= 0 {
		return nil, 0, invalid("EH 预览 limit 必须大于 0")
	}
	index, _, err := s.readEHIndex(ctx, target, policy, mode, cookies, nil, limit, 0)
	if err != nil {
		return nil, 0, err
	}
	items := make([]map[string]any, 0, min(index.total, limit))
	for n := 1; n <= min(index.total, limit); n++ {
		page := index.pages[n]
		item := map[string]any{"id": strconv.Itoa(n), "title": fmt.Sprintf("%s · P%d", index.title, n), "page": n, "thumbnail_url": page.thumbnail, "media_count": 1}
		if page.sprite != nil {
			item["thumbnail_sprite"] = page.sprite
		}
		items = append(items, item)
	}
	return items, index.total, nil
}

func (s *Service) planEH(ctx context.Context, target string, policy scheduler.Policy, mode, cookies string, maxTasks int) ([]Unit, map[string]any, error) {
	return s.planEHPages(ctx, target, policy, mode, cookies, maxTasks, nil)
}

func validateEHPages(pages []int) error {
	if len(pages) == 0 {
		return invalid("eh_pages 至少需要一个页码")
	}
	seen := make(map[int]bool, len(pages))
	for _, page := range pages {
		if page < 1 || seen[page] {
			return invalid("eh_pages 必须包含互不重复的正整数页码")
		}
		seen[page] = true
	}
	return nil
}
func (s *Service) planEHPages(ctx context.Context, target string, policy scheduler.Policy, mode, cookies string, maxTasks int, selected []int) ([]Unit, map[string]any, error) {
	index, route, err := s.readEHIndex(ctx, target, policy, mode, cookies, selected, 0, maxTasks)
	if err != nil {
		return nil, nil, err
	}
	unit := func(n int) Unit {
		return Unit{URL: index.pages[n].url, Site: "exhentai", Kind: "media", SourceID: fmt.Sprintf("%s:%d", index.galleryID, n), ExtraArgs: []string{"--range", "1"}}
	}
	var units []Unit
	if selected == nil {
		units = make([]Unit, 0, index.total)
		for n := 1; n <= index.total; n++ {
			units = append(units, unit(n))
		}
	} else {
		units = make([]Unit, 0, len(selected))
		for _, n := range selected {
			units = append(units, unit(n))
		}
	}
	proxy := map[string]any{"gallery_id": index.galleryID, "title": index.title, "node_id": route["node_id"]}
	if route["used"] == true {
		proxy["node_name"] = route["node_name"]
		proxy["protocol"] = route["protocol"]
	}
	return units, proxy, nil
}

func (s *Service) readEHIndex(ctx context.Context, target string, policy scheduler.Policy, mode, cookies string, selected []int, previewLimit, maxTasks int) (ehIndex, map[string]any, error) {
	match := ehGalleryRE.FindStringSubmatch(target)
	base, parseErr := url.Parse(target)
	if match == nil || parseErr != nil {
		return ehIndex{}, nil, &Error{Status: 422, Code: "invalid_eh_gallery", Message: "EH 画廊 URL 格式无效"}
	}
	galleryID := strings.TrimLeft(match[1], "0")
	if galleryID == "" {
		galleryID = "0"
	}
	if !strings.HasSuffix(base.Path, "/") {
		base.Path += "/"
	}
	base.Fragment = ""
	query := base.Query()
	query.Del("p")
	base.RawQuery = query.Encode()
	wanted := make(map[int]bool, len(selected))
	for _, n := range selected {
		wanted[n] = true
	}
	transport := s.deps.Discovery.Transport
	outcome, err := transport.Execute(ctx, discovery.ExecuteOptions{URL: target, Mode: mode, Policy: policy, Prefix: "eh-plan", AcquireErrorFatal: mode == "required", RequiredMessage: "当前没有可用于 EH 索引规划的健康代理节点", Operation: func(ctx context.Context, attempt discovery.Attempt) (any, error) {
		timeoutSeconds := policy.HTTPTimeout
		if timeoutSeconds <= 0 {
			timeoutSeconds = s.deps.Settings.Gallery.DefaultHTTPTimeout
		}
		timeout := time.Duration(timeoutSeconds * float64(time.Second))
		client, close, err := s.httpClient(ctx, attempt.Endpoint(), timeout)
		if err != nil {
			return nil, err
		}
		defer close()
		clone := *client
		jar, err := loadCookies(cookies)
		if err != nil {
			return nil, &discovery.Error{Code: "cookies_error", Message: "读取 Cookie 文件失败: " + redaction.Text(err.Error(), 1000)}
		}
		clone.Jar = jar
		clone.CheckRedirect = func(req *http.Request, via []*http.Request) error {
			if len(via) >= 30 {
				return errors.New("stopped after 30 redirects")
			}
			return s.validateHTTP(ctx, req.URL.String(), attempt.Endpoint())
		}
		result := ehIndex{galleryID: galleryID, pages: map[int]ehPage{}}
		expected, found, emptyPages := 0, 0, 0
		for index := 0; index < 1000; index++ {
			pageURL := *base
			if index > 0 {
				q := base.Query()
				q.Set("p", strconv.Itoa(index))
				pageURL.RawQuery = q.Encode()
			}
			body, err := s.fetchEH(ctx, &clone, pageURL.String(), attempt.Endpoint())
			if err != nil {
				return nil, err
			}
			title, total, entries := parseEH(body, &pageURL, galleryID)
			if title == "" || total <= 0 {
				if err := ehIndexPageError(body); err != nil {
					return nil, err
				}
			}
			if index == 0 {
				if title == "" || total <= 0 {
					return nil, errors.New("EH 画廊首页缺少标题或图片总数")
				}
				result.title, result.total = title, total
				expected = total
				switch {
				case previewLimit > 0:
					expected = min(total, previewLimit)
				case selected != nil:
					expected = len(selected)
					for _, n := range selected {
						if n > total {
							return nil, &discovery.Error{Code: "invalid_eh_pages", Message: fmt.Sprintf("EH 页码 %d 超出画廊总页数 %d", n, total), Details: map[string]any{"page": n, "total": total}}
						}
					}
				}
				if previewLimit == 0 && expected > maxTasks {
					return nil, &discovery.Error{Code: "crawl_plan_too_large", Message: fmt.Sprintf("EH 画廊图片数 %d 超过剩余 max_tasks=%d", expected, maxTasks), Details: map[string]any{"gallery_id": galleryID, "planned": expected, "max_tasks": maxTasks}}
				}
			}
			before := len(result.pages)
			for n, page := range entries {
				if n > result.total {
					continue
				}
				previous, exists := result.pages[n]
				if !exists && ((selected == nil && n <= expected) || wanted[n]) {
					found++
				}
				if page.thumbnail == "" {
					page.thumbnail, page.sprite = previous.thumbnail, previous.sprite
				}
				result.pages[n] = page
			}
			if found == expected {
				return result, nil
			}
			if len(result.pages) == before {
				emptyPages++
				if emptyPages >= 2 {
					break
				}
			} else {
				emptyPages = 0
			}
		}
		return nil, fmt.Errorf("EH 画廊索引缺少所需页面: collected=%d, expected=%d", found, expected)
	}, Classify: func(err error, a discovery.Attempt) *discovery.Failure {
		message := redaction.Text(err.Error(), 1000, a.Endpoint())
		decision := scheduler.Classify(ptr(1), message, false, false)
		return &discovery.Failure{Message: message, ErrorClass: decision.ErrorClass, Retryable: decision.Retryable || decision.ProxyFault, ProxyFault: decision.ProxyFault}
	}})
	if err != nil {
		var exhausted *discovery.Exhausted
		if errors.As(err, &exhausted) {
			code, status := "eh_gallery_plan_failed", 0
			if previewLimit > 0 {
				code, status = "eh_gallery_browse_failed", 502
			}
			switch exhausted.Failure.ErrorClass {
			case "authentication":
				code, status = "authentication", 401
				transport.NotifyAuthFailure(ctx, "exhentai", cookies, exhausted.Failure.Message)
			case "eh_gallery_capacity":
				code, status = "eh_gallery_capacity", 503
			}
			return ehIndex{}, nil, &Error{Status: status, Code: code, Message: exhausted.Failure.Message, Details: map[string]any{"gallery_id": galleryID, "attempts": exhausted.Attempts}}
		}
		return ehIndex{}, nil, err
	}
	return outcome.Value.(ehIndex), outcome.Proxy, nil
}

func ehCapacity() *discovery.Failure {
	return &discovery.Failure{ErrorClass: "eh_gallery_capacity", Message: "EH 画廊服务暂时超出容量", Retryable: true}
}

func ehIndexPageError(body string) error {
	message := strings.ToLower(strings.Join(strings.Fields(ehTagRE.ReplaceAllString(body, " ")), " "))
	for _, marker := range []string{"login required", "please log in", "only accessible to logged in users", "only available to logged in users", "only available to users who are logged in"} {
		if strings.Contains(message, marker) {
			return errors.New("AuthorizationError: EH 画廊需要登录或 Cookie 已失效")
		}
	}
	for _, marker := range []string{"experiencing a heavy load", "currently overloaded", "currently at capacity", "bandwidth limit exceeded"} {
		if strings.Contains(message, marker) {
			return ehCapacity()
		}
	}
	return nil
}
func (s *Service) validateHTTP(ctx context.Context, target, endpoint string) error {
	validator := s.deps.Discovery.Transport.Validator
	if endpoint != "" {
		_, e := validator.ValidateProxy(ctx, target, endpoint)
		return e
	}
	_, e := validator.ValidateDirect(ctx, target)
	return e
}
func (s *Service) httpClient(ctx context.Context, endpoint string, timeout time.Duration) (*http.Client, func(), error) {
	if s.deps.HTTPClient != nil {
		return s.deps.HTTPClient(ctx, endpoint, timeout)
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	if endpoint != "" {
		proxy, err := url.Parse(endpoint)
		if err != nil {
			return nil, nil, err
		}
		tr.Proxy = http.ProxyURL(proxy)
	}
	return &http.Client{Transport: tr, Timeout: timeout}, tr.CloseIdleConnections, nil
}
func (s *Service) fetchEH(ctx context.Context, client *http.Client, target, endpoint string) (string, error) {
	if err := s.validateHTTP(ctx, target, endpoint); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "gallery-dl-backend/crawl-planner")
	response, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusUnauthorized:
		return "", errors.New("AuthorizationError: EH 画廊需要登录或 Cookie 已失效")
	case 509: // Bandwidth Limit Exceeded
		return "", ehCapacity()
	}
	if response.StatusCode >= 400 && response.StatusCode != http.StatusNotFound {
		return "", fmt.Errorf("HTTP %d %s", response.StatusCode, http.StatusText(response.StatusCode))
	}
	b, err := io.ReadAll(io.LimitReader(response.Body, (32<<20)+1))
	if err != nil {
		return "", err
	}
	if len(b) > 32<<20 {
		return "", errors.New("画廊索引超过大小限制")
	}
	if response.StatusCode == http.StatusNotFound {
		if strings.Contains(string(b), "Gallery Not Available") {
			return "", errors.New("AuthorizationError: EH 画廊需要登录或 Cookie 已失效")
		}
		return "", errors.New("HTTP 404 Not Found")
	}
	if len(b) == 0 && len(response.Header.Values("Cache-Control")) == 0 {
		return "", errors.New("AuthorizationError: ExHentai 登录已失效（返回空白页）")
	}
	return string(b), nil
}
func loadCookies(filename string) (http.CookieJar, error) {
	jar, _ := cookiejar.New(nil)
	for _, host := range []string{"e-hentai.org", "exhentai.org"} {
		u, _ := url.Parse("https://" + host)
		jar.SetCookies(u, []*http.Cookie{{Name: "nw", Value: "1", Domain: "." + host, Path: "/"}})
	}
	if filename == "" {
		return jar, nil
	}
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	limited := &io.LimitedReader{R: file, N: (8 << 20) + 1}
	scanner := bufio.NewScanner(limited)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	if !scanner.Scan() || !strings.Contains(scanner.Text(), "HTTP Cookie File") {
		return nil, errors.New("invalid cookie header")
	}
	for scanner.Scan() {
		line := strings.TrimPrefix(scanner.Text(), "#HttpOnly_")
		if strings.TrimSpace(line) == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) != 7 || (parts[1] == "TRUE") != strings.HasPrefix(parts[0], ".") {
			return nil, errors.New("invalid cookie row")
		}
		domain := strings.TrimPrefix(parts[0], ".")
		scheme := "http"
		if parts[3] == "TRUE" {
			scheme = "https"
		}
		u, err := url.Parse(scheme + "://" + domain + "/")
		if err != nil {
			return nil, err
		}
		cookie := &http.Cookie{Name: parts[5], Value: parts[6], Path: parts[2], Secure: parts[3] == "TRUE"}
		if cookie.Name == "" {
			cookie.Name, cookie.Value = cookie.Value, ""
		}
		if parts[1] == "TRUE" {
			cookie.Domain = parts[0]
		}
		jar.SetCookies(u, []*http.Cookie{cookie})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if limited.N == 0 {
		return nil, errors.New("cookie file too large")
	}
	return jar, nil
}
