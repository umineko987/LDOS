package crawls

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"html"
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

var ehGalleryRE = regexp.MustCompile(`(?i)^https?://(?:e-|ex)hentai\.org/g/([0-9]+)/([0-9a-f]{10})/?`)
var ehPageRE = regexp.MustCompile(`(?i)^https?://(?:e-|ex)hentai\.org/s/[0-9a-f]{10}/([0-9]+)-([0-9]+)`)
var hrefRE = regexp.MustCompile(`(?i)href=["']([^"']+/s/[0-9a-f]{10}/[0-9]+-[0-9]+)["']`)
var lengthRE = regexp.MustCompile(`(?i)>Length:</td><td[^>]*>\s*([0-9]+)\s+(?:pages?|files?)`)
var titleRE = regexp.MustCompile(`(?is)<h1\s+id="gn">(.*?)</h1>`)
var tagRE = regexp.MustCompile(`<[^>]+>`)

func parseEH(page, base, galleryID string) (string, int, map[int]string) {
	title := ""
	if m := titleRE.FindStringSubmatch(page); m != nil {
		title = strings.TrimSpace(html.UnescapeString(tagRE.ReplaceAllString(m[1], "")))
	}
	total := 0
	if m := lengthRE.FindStringSubmatch(page); m != nil {
		total, _ = strconv.Atoi(m[1])
	}
	out := map[int]string{}
	u, _ := url.Parse(base)
	for _, m := range hrefRE.FindAllStringSubmatch(page, -1) {
		link, e := url.Parse(html.UnescapeString(m[1]))
		if e != nil {
			continue
		}
		target := u.ResolveReference(link).String()
		match := ehPageRE.FindStringSubmatch(target)
		if match == nil || strings.TrimLeft(match[1], "0") != strings.TrimLeft(galleryID, "0") {
			continue
		}
		n, _ := strconv.Atoi(match[2])
		out[n] = target
	}
	return title, total, out
}

type ehResult struct {
	units []Unit
	title string
}

func (s *Service) planEH(ctx context.Context, target string, policy scheduler.Policy, mode, cookies string, maxTasks int) ([]Unit, map[string]any, error) {
	match := ehGalleryRE.FindStringSubmatch(target)
	if match == nil {
		return nil, nil, &Error{Code: "invalid_eh_gallery", Message: "EH 画廊 URL 格式无效"}
	}
	galleryID := strings.TrimLeft(match[1], "0")
	if galleryID == "" {
		galleryID = "0"
	}
	normalized := target
	if !strings.HasSuffix(normalized, "/") {
		normalized += "/"
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
		title, expected, emptyPages := "", 0, 0
		links := map[int]string{}
		for index := 0; index < 1000; index++ {
			pageURL := normalized
			if index > 0 {
				pageURL += "?p=" + strconv.Itoa(index)
			}
			page, err := s.fetchEH(ctx, &clone, pageURL, attempt.Endpoint())
			if err != nil {
				return nil, err
			}
			pageTitle, pageTotal, pageLinks := parseEH(page, normalized, galleryID)
			if index == 0 {
				title, expected = pageTitle, pageTotal
				if title == "" || expected <= 0 {
					return nil, errors.New("EH 画廊首页缺少标题或图片总数")
				}
				if expected > maxTasks {
					return nil, &discovery.Error{Code: "crawl_plan_too_large", Message: fmt.Sprintf("EH 画廊图片数 %d 超过剩余 max_tasks=%d", expected, maxTasks), Details: map[string]any{"gallery_id": galleryID, "planned": expected, "max_tasks": maxTasks}}
				}
			}
			before := len(links)
			for n, v := range pageLinks {
				links[n] = v
			}
			if len(links) == before {
				emptyPages++
			} else {
				emptyPages = 0
			}
			if len(links) >= expected {
				break
			}
			if emptyPages >= 2 {
				return nil, fmt.Errorf("EH 画廊索引提前结束: collected=%d, expected=%d", len(links), expected)
			}
		}
		missing, first := 0, 0
		for n := 1; n <= expected; n++ {
			if _, ok := links[n]; !ok {
				missing++
				if first == 0 {
					first = n
				}
			}
		}
		if missing > 0 {
			return nil, fmt.Errorf("EH 画廊索引缺少 %d 页，首个缺页=%d", missing, first)
		}
		units := make([]Unit, 0, expected)
		for n := 1; n <= expected; n++ {
			units = append(units, Unit{URL: links[n], Site: "exhentai", Kind: "media", SourceID: fmt.Sprintf("%s:%d", galleryID, n), ExtraArgs: []string{"--range", "1"}})
		}
		return ehResult{units, title}, nil
	}, Classify: func(err error, a discovery.Attempt) *discovery.Failure {
		message := redaction.Text(err.Error(), 1000, a.Endpoint())
		decision := scheduler.Classify(ptr(1), message, false, false)
		return &discovery.Failure{Message: message, ErrorClass: decision.ErrorClass, Retryable: decision.Retryable || decision.ProxyFault, ProxyFault: decision.ProxyFault}
	}})
	if err != nil {
		var exhausted *discovery.Exhausted
		if errors.As(err, &exhausted) {
			code := "eh_gallery_plan_failed"
			if exhausted.Failure.ErrorClass == "authentication" {
				code = "authentication"
				transport.NotifyAuthFailure(ctx, "exhentai", cookies, exhausted.Failure.Message)
			}
			return nil, nil, &Error{Code: code, Message: exhausted.Failure.Message, Details: map[string]any{"gallery_id": galleryID, "attempts": exhausted.Attempts}}
		}
		return nil, nil, err
	}
	result := outcome.Value.(ehResult)
	proxy := map[string]any{"gallery_id": galleryID, "title": result.title, "node_id": outcome.Proxy["node_id"]}
	if outcome.Proxy["used"] == true {
		proxy["node_name"] = outcome.Proxy["node_name"]
		proxy["protocol"] = outcome.Proxy["protocol"]
	}
	return result.units, proxy, nil
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
	if response.StatusCode >= 400 {
		return "", fmt.Errorf("HTTP %d %s", response.StatusCode, http.StatusText(response.StatusCode))
	}
	b, err := io.ReadAll(io.LimitReader(response.Body, (32<<20)+1))
	if err != nil {
		return "", err
	}
	if len(b) > 32<<20 {
		return "", errors.New("画廊索引超过大小限制")
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
