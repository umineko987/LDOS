package authorization

import (
	"context"
	"net"
	"net/url"
	"strings"

	"ldos/backend/internal/authbrowser"
	"ldos/backend/internal/config"
	"ldos/backend/internal/downloads"
)

func (s *Service) Status(ctx context.Context, input string) (map[string]any, error) {
	site, err := normalize(input)
	if err != nil {
		return nil, err
	}
	if site == "danbooru" || site == "pawchive" {
		label, summary := "Danbooru", "公开 API 已就绪，画师和角色标签抓取无需登录。"
		if site == "pawchive" {
			label, summary = "Pawchive", "公开 API 与文件下载已就绪，画师搜索和抓取无需登录。"
		}
		return map[string]any{"site": site, "label": label, "method": "anonymous", "state": "ready", "authorized": true, "summary": summary, "actions": []string{}}, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cookie, metadata, err := s.vault.Snapshot(ctx, site)
	if err != nil {
		return nil, err
	}
	x := s.sessions[site]
	var public any
	if x != nil && !(site == "pixiv" && x.state == "authorized") {
		public = x.public()
	}
	result := map[string]any{"site": site, "browser": "project_chrome", "profile": "shared", "updated_at": metadata["updated_at"]}
	if site == "pixiv" {
		token, err := s.cache.HasToken(ctx)
		if err != nil {
			return nil, err
		}
		state, summary := "required", "完成一次 Pixiv 登录授权后即可搜索和抓取画师作品。"
		if x != nil && active(x.state) {
			state, summary = "authorizing", x.message
		} else if token {
			state, summary = "authorized", "Pixiv 登录授权有效；gallery-dl 会自动使用托管 Token。"
		} else if x != nil && x.failure != "" {
			summary = x.failure
		}
		result["label"], result["method"], result["state"], result["authorized"], result["summary"], result["oauth"], result["actions"] = "Pixiv", "oauth", state, token, summary, public, []string{"oauth", "clear"}
		return result, nil
	}
	invalidated := truthy(metadata["invalidated_at"])
	authorized := cookie.Valid && !invalidated
	state, summary := "required", "在共享授权浏览器中完成登录后会自动导出凭证。"
	if x != nil && active(x.state) {
		state, summary = "authorizing", "共享授权浏览器已打开；请在标签页内完成登录。"
	} else if authorized {
		label := "X 导出凭证"
		if site == "exhentai" {
			label = "EH 导出凭证"
		}
		state, summary = "authorized", label+"已保存；共享浏览器登录状态继续保留。"
	} else if invalidated {
		summary = "登录凭证在实际访问中失效，请重新授权。"
	}
	result["label"], result["method"], result["state"], result["authorized"], result["summary"] = authbrowser.Sites[site].Label, "managed_browser", state, authorized, summary
	result["cookies"] = map[string]any{"present": cookie.Present, "valid": cookie.Valid, "cookie_count": cookie.Count, "required_present": cookie.RequiredPresent, "missing": cookie.Missing, "updated_at": cookie.UpdatedAt}
	if !truthy(metadata["updated_at"]) {
		result["updated_at"] = cookie.UpdatedAt
	}
	result["invalidated_at"], result["invalid_reason"], result["login"], result["actions"] = metadata["invalidated_at"], nil, public, []string{"managed_browser_login", "clear"}
	if invalidated {
		result["invalid_reason"] = "登录凭证失效"
	}
	return result, nil
}
func truthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case float64:
		return v != 0
	case string:
		return v != ""
	default:
		return true
	}
}
func (s *Service) Statuses(ctx context.Context) (map[string]any, error) {
	items := []map[string]any{}
	for _, site := range sites {
		status, err := s.Status(ctx, site)
		if err != nil {
			return nil, err
		}
		items = append(items, status)
	}
	proxy, err := s.ProxyStatus(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"items": items, "browser_profile": s.ProfileStatus(), "authorization_proxy": proxy, "managed": true, "secrets_exposed": false}, nil
}
func (s *Service) ProfileStatus() map[string]any {
	s.mu.Lock()
	resetting := s.resetting
	s.mu.Unlock()
	return map[string]any{"shared": true, "present": s.browser.ProfilePresent(), "running": s.browser.Running(), "resetting": resetting, "sites": []string{"twitter", "pixiv", "exhentai"}}
}

func maskedProxy(raw string) any {
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil
	}
	userinfo := ""
	if u.User != nil {
		userinfo = "***@"
	}
	return u.Scheme + "://" + userinfo + net.JoinHostPort(u.Hostname(), u.Port())
}
func (s *Service) ProxyStatus(ctx context.Context) (map[string]any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	selection, err := s.downloads.ProxySettings()
	if err != nil {
		return nil, err
	}
	effective, source := "", "none"
	if selection.ProxySource != "none" {
		source = "runtime"
	}
	if selection.Proxy != nil {
		effective = *selection.Proxy
	}
	if selection.ProxySource == "pool" {
		s.mu.Lock()
		for _, x := range s.sessions {
			if x.id == s.activeID && x.proxy.ProxySource == "pool" && x.proxy.Proxy != nil {
				effective = *x.proxy.Proxy
				break
			}
		}
		s.mu.Unlock()
	}
	running, browserProxy := s.browser.Running(), s.browser.Proxy()
	var browserURL any
	if running {
		browserURL = maskedProxy(browserProxy)
	}
	credentials := false
	if parsed, err := url.Parse(effective); err == nil {
		credentials = parsed.User != nil
	}
	return map[string]any{"proxy_url": maskedProxy(effective), "source": source, "config_proxy_url": nil, "credentials_redacted": credentials, "browser_running": running, "browser_proxy_url": browserURL, "restart_pending": running && browserProxy != effective, "updated_at": nil}, nil
}

// Keep the legacy endpoint as an alias for the shared login/model proxy setting.
func (s *Service) SetProxy(ctx context.Context, raw string) (map[string]any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	mode := "custom"
	if strings.TrimSpace(raw) == "" {
		mode = "none"
	}
	if _, err := s.downloads.Update(downloads.Update{ProxyMode: downloads.String(mode), CustomProxy: downloads.String(raw)}); err != nil {
		if _, invalid := err.(*downloads.Error); invalid {
			return nil, problem("invalid_authorization_proxy", "登录与模型下载共用的代理地址需为带端口的 HTTP 或 HTTPS 地址")
		}
		return nil, err
	}
	return s.ProxyStatus(ctx)
}
func (s *Service) ClearProxy(ctx context.Context) (map[string]any, error) {
	return s.SetProxy(ctx, "")
}
func (s *Service) BrowserStatus() map[string]any {
	s.mu.Lock()
	executable := s.settings.ChromeExecutable
	s.mu.Unlock()
	configured := strings.TrimSpace(executable) != ""
	_, name, err := authbrowser.Discover(executable)
	if err != nil {
		source, message := "none", "未检测到 Chrome、Chromium、Microsoft Edge 或 Firefox"
		if configured {
			source, message = "configured", "已选择的浏览器不可用，请重新选择"
		}
		return map[string]any{"available": false, "name": nil, "source": source, "message": message}
	}
	source := "auto"
	if configured {
		source = "configured"
	}
	if name == "" {
		name = "Chromium 浏览器"
	}
	return map[string]any{"available": true, "name": name, "source": source, "message": "浏览器可用于站点授权"}
}
func (s *Service) SetBrowser(ctx context.Context, value string, clear bool) (map[string]any, error) {
	path := ""
	if !clear {
		value = strings.TrimSpace(value)
		if authbrowser.BrowserName(value) == "" {
			return nil, problem("invalid_browser_executable", "请选择 Chrome、Chromium、Microsoft Edge 或 Firefox 的可执行文件")
		}
		var err error
		path, _, err = authbrowser.Discover(value)
		if err != nil {
			return nil, problem("invalid_browser_executable", "所选浏览器不可用，请重新选择")
		}
	}
	s.ops.Lock()
	defer s.ops.Unlock()
	s.mu.Lock()
	busy := s.activeID != "" || s.resetting || s.closed
	s.mu.Unlock()
	if busy {
		return nil, problem("browser_busy", "授权正在进行，请结束后再更换浏览器")
	}
	if err := s.browser.Stop(); err != nil {
		return nil, problem("browser_busy", "共享授权浏览器暂时不可用")
	}
	if err := config.SaveBrowserExecutable(ctx, s.configPath, path); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.settings.ChromeExecutable = path
	s.mu.Unlock()
	return s.BrowserStatus(), nil
}
