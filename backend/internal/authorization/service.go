// Package authorization owns local authorization state and login lifecycles.
package authorization

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"ldos/backend/internal/authbrowser"
	"ldos/backend/internal/config"
	"ldos/backend/internal/credentials"
	"ldos/backend/internal/downloads"
	"ldos/backend/internal/pixivauth"
)

type Browser interface {
	Ensure(context.Context, string, string) error
	Running() bool
	Proxy() string
	Open(context.Context, string) (string, error)
	Cookies(context.Context, string) ([]authbrowser.Cookie, error)
	LoginReady(context.Context, string, string) (bool, error)
	CapturePixiv(context.Context, string, string) (string, error)
	CloseTarget(context.Context, string) error
	Stop() error
	ResetProfile() error
	ProfilePresent() bool
}
type TokenCache interface {
	HasToken(context.Context) (bool, error)
	SaveToken(context.Context, string) error
	Clear(context.Context) error
}
type Error struct{ Code, Message string }

func (e *Error) Error() string           { return e.Message }
func problem(code, message string) error { return &Error{code, message} }

var sites = []string{"danbooru", "twitter", "pixiv", "exhentai", "pawchive"}

func normalize(site string) (string, error) {
	site = strings.ToLower(strings.TrimSpace(site))
	switch site {
	case "x":
		site = "twitter"
	case "eh", "e-hentai":
		site = "exhentai"
	}
	for _, allowed := range sites {
		if site == allowed {
			return site, nil
		}
	}
	return "", problem("unsupported_auth_site", "不支持的授权来源")
}

type session struct {
	id, site, state, message, failure, url string
	created, expires                       time.Time
	cookieCount                            int
	missing                                []string
	cancel                                 context.CancelFunc
	done                                   chan struct{}
	proxy                                  downloads.Environment
}

func (s *session) public() map[string]any {
	result := map[string]any{"session_id": s.id, "state": s.state, "message": s.message, "created_at": timestamp(s.created), "expires_at": timestamp(s.expires), "error": nullable(s.failure)}
	if s.site == "pixiv" {
		result["authorization_url"], result["browser"], result["profile"], result["automatic_callback"] = nullable(s.url), "project_chrome", "shared", true
	} else {
		result["site"], result["cookie_count"], result["recommended_missing"] = s.site, s.cookieCount, append([]string{}, s.missing...)
	}
	return result
}
func timestamp(t time.Time) float64 { return float64(t.UnixNano()) / 1e9 }
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func active(state string) bool {
	switch state {
	case "starting", "starting_browser", "awaiting_login", "awaiting_code", "exchanging":
		return true
	}
	return false
}

type Service struct {
	ops               sync.Mutex
	mu                sync.Mutex
	ctx               context.Context
	cancel            context.CancelFunc
	settings          config.Auth
	configPath        string
	vault             *credentials.Store
	cache             TokenCache
	browser           Browser
	downloads         *downloads.Store
	sessions          map[string]*session
	activeID          string
	resetting, closed bool
	exchange          func(context.Context, pixivauth.Flow, string, string) (string, error)
}

func New(parent context.Context, settings config.Auth, configPath string, vault *credentials.Store, cache TokenCache, browser Browser, downloadSettings *downloads.Store) *Service {
	ctx, cancel := context.WithCancel(parent)
	return &Service{ctx: ctx, cancel: cancel, settings: settings, configPath: configPath, vault: vault, cache: cache, browser: browser, downloads: downloadSettings, sessions: map[string]*session{}, exchange: func(ctx context.Context, f pixivauth.Flow, callback, proxy string) (string, error) {
		return f.Exchange(ctx, callback, proxy)
	}}
}

func (s *Service) Start(ctx context.Context, input string) (map[string]any, error) {
	site, err := normalize(input)
	if err != nil {
		return nil, err
	}
	if site != "twitter" && site != "exhentai" && site != "pixiv" {
		return nil, problem("managed_browser_unsupported", "此来源使用其他授权方式")
	}
	s.ops.Lock()
	defer s.ops.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	if s.closed || s.ctx.Err() != nil || s.activeID != "" || s.resetting {
		s.mu.Unlock()
		return nil, problem("shared_browser_busy", "共享授权浏览器正在执行其他授权或清空操作，请稍候。")
	}
	settings := s.settings
	s.mu.Unlock()
	var flow pixivauth.Flow
	if site == "pixiv" {
		flow, err = pixivauth.NewFlow()
		if err != nil {
			return nil, problem("pixiv_oauth_start_failed", "启动 Pixiv 登录授权失败")
		}
	}
	id := strings.ReplaceAll(uuid.NewString(), "-", "")
	proxy, err := s.downloads.Resolve(ctx, "authorization:"+id, downloads.Overrides{Token: downloads.Null(), HFMirror: downloads.Null()})
	if err != nil {
		if errors.Is(err, downloads.ErrProxyUnavailable) {
			return nil, problem("authorization_proxy_unavailable", "登录与模型下载共用的代理池不可用，请先启动代理池或修改代理设置")
		}
		return nil, problem("authorization_proxy_unavailable", "无法读取登录与模型下载的代理设置")
	}
	now := time.Now()
	timeout := time.Duration(settings.BrowserLoginTimeoutSeconds * float64(time.Second))
	if site == "pixiv" {
		timeout = min(timeout, 600*time.Second)
	}
	worker, cancel := context.WithDeadline(s.ctx, now.Add(timeout))
	x := &session{id: id, proxy: proxy, site: site, state: "starting", message: "正在启动项目专属登录窗口。", created: now, expires: now.Add(timeout), missing: []string{}, cancel: cancel, done: make(chan struct{})}
	if site == "pixiv" {
		x.url, x.state, x.message, x.expires = flow.AuthorizationURL, "starting_browser", "正在共享授权浏览器中打开 Pixiv。", now.Add(600*time.Second)
	}
	s.mu.Lock()
	s.sessions[site], s.activeID = x, x.id
	initial := x.public()
	s.mu.Unlock()
	go s.monitor(worker, x, settings, flow)
	if site == "pixiv" {
		return initial, nil
	}
	status, err := s.Status(ctx, site)
	return map[string]any{"session": initial, "status": status}, err
}

func (s *Service) monitor(ctx context.Context, x *session, settings config.Auth, flow pixivauth.Flow) {
	var target string
	proxy := ""
	if x.proxy.Proxy != nil {
		proxy = *x.proxy.Proxy
	}
	defer func() {
		x.cancel()
		cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		if target != "" {
			_ = s.browser.CloseTarget(cleanup, target)
		}
		cancel()
		_ = s.browser.Stop()
		_ = s.downloads.Release(context.Background(), x.proxy)
		s.mu.Lock()
		if s.activeID == x.id {
			s.activeID = ""
		}
		if x.site == "pixiv" && x.state == "authorized" && s.sessions[x.site] == x {
			delete(s.sessions, x.site)
		}
		s.mu.Unlock()
		close(x.done)
	}()
	err := s.browser.Ensure(ctx, settings.ChromeExecutable, proxy)
	if err == nil {
		loginURL := "about:blank"
		if x.site != "pixiv" {
			loginURL = authbrowser.Sites[x.site].LoginURL
		}
		target, err = s.browser.Open(ctx, loginURL)
	}
	if err == nil && s.transition(ctx, x, "awaiting_login", "请在共享授权浏览器中完成登录。") {
		if x.site == "pixiv" {
			err = s.authorizePixiv(ctx, x, target, proxy, flow)
		} else {
			err = s.authorizeCookies(ctx, x, target, settings)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if x.state == "cancelled" || x.state == "authorized" {
		return
	}
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		x.state, x.failure = "timed_out", "登录等待超时，请重新打开授权标签页。"
	case ctx.Err() != nil:
		x.state, x.message = "cancelled", "登录窗口已关闭。"
		return
	default:
		x.state, x.failure = "failed", "共享授权浏览器登录失败"
		if x.site == "pixiv" {
			x.failure = "Pixiv 共享浏览器授权失败"
		}
		var controlled *Error
		if errors.As(err, &controlled) {
			x.failure = controlled.Message
		}
	}
	x.message = x.failure
}
func (s *Service) transition(ctx context.Context, x *session, state, message string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil || s.sessions[x.site] != x || x.state == "cancelled" {
		return false
	}
	x.state, x.message = state, message
	return true
}
func (s *Service) authorizeCookies(ctx context.Context, x *session, target string, settings config.Auth) error {
	spec := authbrowser.Sites[x.site]
	poll := time.NewTicker(max(100*time.Millisecond, time.Duration(settings.BrowserPollIntervalSeconds*float64(time.Second))))
	defer poll.Stop()
	for {
		cookies, err := s.browser.Cookies(ctx, x.site)
		if err != nil {
			return err
		}
		names := map[string]bool{}
		for _, cookie := range cookies {
			names[cookie.Name] = true
		}
		ready := true
		for _, name := range spec.Required {
			ready = ready && names[name]
		}
		if ready {
			ready, err = s.browser.LoginReady(ctx, x.site, target)
			if err != nil {
				return err
			}
		}
		if ready {
			missing := []string{}
			for _, name := range spec.Recommended {
				if !names[name] {
					missing = append(missing, name)
				}
			}
			sort.Strings(missing)
			s.mu.Lock()
			defer s.mu.Unlock()
			if err := ctx.Err(); err != nil {
				return err
			}
			if s.sessions[x.site] != x || x.state == "cancelled" {
				return context.Canceled
			}
			err := s.vault.SaveCookies(ctx, x.site, authbrowser.Netscape(cookies), map[string]any{"method": "managed_browser", "browser": "shared_project_chrome", "updated_at": timestamp(time.Now()), "cookie_count": len(cookies), "recommended_missing": missing})
			if err != nil {
				return err
			}
			x.cookieCount, x.missing, x.state, x.message = len(cookies), missing, "authorized", "登录成功，导出凭证已保存。"
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-poll.C:
		}
	}
}
func (s *Service) authorizePixiv(ctx context.Context, x *session, target, proxy string, flow pixivauth.Flow) error {
	callback, err := s.browser.CapturePixiv(ctx, target, flow.AuthorizationURL)
	if err != nil {
		return err
	}
	if !s.transition(ctx, x, "exchanging", "已捕获 Pixiv 回调，正在交换授权码。") {
		return context.Canceled
	}
	exchangeCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	token, err := s.exchange(exchangeCtx, flow, callback, proxy)
	if err != nil {
		return problem("pixiv_oauth_exchange_failed", "Pixiv 授权确认失败")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.sessions[x.site] != x || x.state == "cancelled" {
		return context.Canceled
	}
	if err := s.cache.SaveToken(ctx, token); err != nil {
		return problem("pixiv_oauth_cache_failed", "保存 Pixiv 登录授权失败")
	}
	if err := s.vault.SetMetadata(ctx, "pixiv", map[string]any{"method": "oauth", "updated_at": timestamp(time.Now())}); err != nil {
		return err
	}
	x.state, x.message = "authorized", "Pixiv 登录授权完成。"
	return nil
}

// cancelSite is called with ops held. Waiting outside mu allows the monitor to
// drain browser/network work before clear or profile replacement can proceed.
func (s *Service) cancelSite(site, id string, remove bool) (*session, error) {
	s.mu.Lock()
	x := s.sessions[site]
	if id != "" && (x == nil || x.id != id) {
		s.mu.Unlock()
		return nil, problem("browser_login_session_not_found", "项目专属浏览器登录会话不存在")
	}
	if x != nil {
		x.state, x.message = "cancelled", "登录窗口已关闭。"
		x.cancel()
		if remove {
			delete(s.sessions, site)
		}
	}
	s.mu.Unlock()
	if x != nil {
		<-x.done
	}
	return x, nil
}
func (s *Service) LoginSession(ctx context.Context, input, id string) (map[string]any, error) {
	site, err := normalize(input)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	x := s.sessions[site]
	if x == nil || x.id != id || site == "pixiv" {
		s.mu.Unlock()
		return nil, problem("browser_login_session_not_found", "项目专属浏览器登录会话不存在")
	}
	public := x.public()
	s.mu.Unlock()
	status, err := s.Status(ctx, site)
	return map[string]any{"session": public, "status": status}, err
}
func (s *Service) CancelLogin(ctx context.Context, input, id string) (map[string]any, error) {
	site, err := normalize(input)
	if err != nil {
		return nil, err
	}
	s.ops.Lock()
	defer s.ops.Unlock()
	if site == "pixiv" {
		return nil, problem("browser_login_session_not_found", "项目专属浏览器登录会话不存在")
	}
	if _, err := s.cancelSite(site, id, false); err != nil {
		return nil, err
	}
	return s.LoginSession(ctx, site, id)
}
func (s *Service) CancelPixiv(ctx context.Context) (map[string]any, error) {
	s.ops.Lock()
	defer s.ops.Unlock()
	_, _ = s.cancelSite("pixiv", "", true)
	return s.Status(ctx, "pixiv")
}
func (s *Service) Clear(ctx context.Context, input string) (map[string]any, error) {
	site, err := normalize(input)
	if err != nil {
		return nil, err
	}
	s.ops.Lock()
	defer s.ops.Unlock()
	_, _ = s.cancelSite(site, "", true)
	if site == "pixiv" {
		if err := s.cache.Clear(ctx); err != nil {
			return nil, problem("auth_cache_clear_failed", "清除 Pixiv 授权缓存失败")
		}
	}
	if err := s.vault.Clear(ctx, site); err != nil {
		return nil, err
	}
	return s.Status(ctx, site)
}
func (s *Service) ResetProfile(ctx context.Context) (map[string]any, error) {
	s.ops.Lock()
	defer s.ops.Unlock()
	s.mu.Lock()
	s.resetting = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.resetting = false; s.mu.Unlock() }()
	for _, site := range sites {
		_, _ = s.cancelSite(site, "", true)
	}
	if err := s.browser.ResetProfile(); err != nil {
		return nil, problem("invalid_browser_profile_path", "共享授权浏览器目录安全校验失败")
	}
	s.mu.Lock()
	s.resetting = false
	s.mu.Unlock()
	auth, err := s.Statuses(ctx)
	return map[string]any{"browser_profile": s.ProfileStatus(), "auth": auth}, err
}
func (s *Service) Stop() error {
	s.ops.Lock()
	defer s.ops.Unlock()
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	s.cancel()
	for _, site := range sites {
		_, _ = s.cancelSite(site, "", true)
	}
	return s.browser.Stop()
}
