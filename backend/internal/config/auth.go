package config

import (
	"context"
	"errors"
	"math"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type Auth struct {
	ChromeExecutable           string  `json:"chrome_executable"`
	BrowserLoginTimeoutSeconds float64 `json:"browser_login_timeout_seconds"`
	BrowserPollIntervalSeconds float64 `json:"browser_poll_interval_seconds"`
	AuthorizationProxy         string  `json:"authorization_proxy"`
}

func (a *Auth) normalize() error {
	for _, n := range []float64{a.BrowserLoginTimeoutSeconds, a.BrowserPollIntervalSeconds} {
		if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 || n >= float64(math.MaxInt64)/float64(time.Second) {
			return errors.New("auth browser durations must be positive and finite")
		}
	}
	var err error
	a.AuthorizationProxy, err = NormalizeAuthorizationProxy(a.AuthorizationProxy)
	return err
}

func NormalizeAuthorizationProxy(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	invalid := errors.New("授权代理需要有效的 scheme://host:port 地址")
	if utf8.RuneCountInString(value) > 300 {
		return "", invalid
	}
	for _, r := range value {
		if r <= 32 || r == 127 {
			return "", invalid
		}
	}
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", invalid
	}
	switch u.Scheme {
	case "http", "https", "socks4", "socks5", "socks5h":
	default:
		return "", invalid
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 0 || port > 65535 {
		return "", invalid
	}
	if strings.HasPrefix(u.Scheme, "socks") && u.User != nil {
		password, _ := u.User.Password()
		if u.User.Username() != "" || password != "" {
			return "", errors.New("Chrome 不支持带账号密码的 SOCKS 代理")
		}
	}
	u.Host = net.JoinHostPort(strings.ToLower(u.Hostname()), strconv.Itoa(port))
	u.Path, u.RawPath, u.ForceQuery = "", "", false
	return u.String(), nil
}

// SaveBrowserExecutable preserves unrelated sections and shares the config write
// gate with model setup. Validation remains the authorization service's job.
func SaveBrowserExecutable(ctx context.Context, path, executable string) error {
	if err := UpdateSection(ctx, path, "auth", map[string]any{"chrome_executable": executable}); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("保存浏览器配置失败")
	}
	return nil
}
