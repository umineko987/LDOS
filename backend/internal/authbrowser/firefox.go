//go:build linux

package authbrowser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strconv"
	"time"
)

// Unlike CDP, a Firefox BiDi session belongs to one live WebSocket. Keep it
// with the project-owned process, not the user's running Firefox instance.
type firefoxSession struct {
	wire  *cdp
	gate  chan struct{}
	close func()
}

func (b *Browser) firefox() *firefoxSession {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.host == nil {
		return nil
	}
	return b.host.firefox
}

func startFirefox(ctx context.Context, h *host, endpoint, proxy string) (*firefoxSession, error) {
	life, cancel := context.WithCancel(h.ctx)
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	wire, err := dialCDP(life, endpoint, h.port, "bidi")
	if err != nil {
		cancel()
		return nil, err
	}
	s := &firefoxSession{wire: wire, gate: make(chan struct{}, 1), close: func() { cancel(); wire.close() }}
	caps := map[string]any{"alwaysMatch": map[string]any{"proxy": firefoxProxy(proxy)}}
	if err := wire.command("session.new", map[string]any{"capabilities": caps}, nil, nil); err != nil {
		s.close()
		return nil, controlled(ctx, err)
	}
	return s, nil
}

// proxy is the already validated, credential-free browser proxy. PAC lets
// Firefox distinguish an HTTPS proxy from a plaintext proxy for HTTPS URLs.
func firefoxProxy(proxy string) map[string]string {
	if proxy == "" {
		return map[string]string{"proxyType": "direct"}
	}
	u, _ := url.Parse(proxy)
	kind := map[string]string{"http": "PROXY", "https": "HTTPS", "socks4": "SOCKS4", "socks5": "SOCKS5"}[u.Scheme]
	script := "function FindProxyForURL() { return " + strconv.Quote(kind+" "+u.Host) + "; }"
	return map[string]string{"proxyType": "pac", "proxyAutoconfigUrl": "data:application/x-ns-proxy-autoconfig;base64," + base64.StdEncoding.EncodeToString([]byte(script))}
}

func (s *firefoxSession) run(ctx context.Context, timeout time.Duration, fn func(*cdp) error) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case s.gate <- struct{}{}:
	}
	defer func() { <-s.gate }()
	// Cancelling a command abandons the outstanding response and its socket;
	// the authorization monitor disposes the host rather than reusing that stream.
	stop := context.AfterFunc(ctx, s.close)
	defer stop()
	err := fn(s.wire)
	return controlled(ctx, err)
}

func (s *firefoxSession) request(ctx context.Context, method string, params, result any) error {
	return s.run(ctx, 5*time.Second, func(w *cdp) error { return w.command(method, params, result, nil) })
}

func (s *firefoxSession) open(ctx context.Context, loginURL string) (string, error) {
	var tab struct{ Context string }
	if err := s.request(ctx, "browsingContext.create", map[string]string{"type": "tab"}, &tab); err != nil {
		return "", err
	}
	if tab.Context == "" {
		return "", ErrCDP
	}
	if loginURL != "about:blank" {
		if err := s.request(ctx, "browsingContext.navigate", map[string]string{"context": tab.Context, "url": loginURL, "wait": "none"}, nil); err != nil {
			return "", err
		}
	}
	return tab.Context, nil
}

func (s *firefoxSession) cookies(ctx context.Context, spec Spec) ([]Cookie, error) {
	var result struct {
		Cookies []struct {
			Domain, Path, Name string
			Value              struct{ Type, Value string }
			Secure             bool
			Expiry             float64
		}
	}
	if err := s.request(ctx, "storage.getCookies", nil, &result); err != nil {
		return nil, err
	}
	var cookies []Cookie
	for _, c := range result.Cookies {
		if !domainMatches(c.Domain, spec.Domains) {
			continue
		}
		value := c.Value.Value
		switch c.Value.Type {
		case "string":
		case "base64":
			decoded, err := base64.StdEncoding.DecodeString(value)
			if err != nil {
				return nil, ErrCDP
			}
			value = string(decoded)
		default:
			return nil, ErrCDP
		}
		cookies = append(cookies, Cookie{Domain: c.Domain, Path: c.Path, Name: c.Name, Value: value, Secure: c.Secure, Expires: c.Expiry})
	}
	return filterCookies(cookies, spec.Domains, time.Now()), nil
}

func (s *firefoxSession) loginReady(ctx context.Context, target string) (bool, error) {
	var tree struct {
		Contexts []struct{ Context, URL string }
	}
	if err := s.request(ctx, "browsingContext.getTree", map[string]any{"root": target, "maxDepth": 0}, &tree); err != nil {
		return false, err
	}
	for _, tab := range tree.Contexts {
		if tab.Context == target && twitterReadyURL(tab.URL) {
			return true, nil
		}
	}
	return false, nil
}

func (s *firefoxSession) capturePixiv(ctx context.Context, target, loginURL string) (string, error) {
	var callback string
	err := s.run(ctx, 600*time.Second, func(w *cdp) error {
		const event = "network.beforeRequestSent"
		if err := w.command("session.subscribe", map[string][]string{"events": {event}, "contexts": {target}}, nil, nil); err != nil {
			return err
		}
		observe := func(m cdpMessage) {
			var request struct {
				Context string
				Request struct{ URL string }
			}
			if m.Method == event && json.Unmarshal(m.Params, &request) == nil && request.Context == target && pixivCallback(request.Request.URL) {
				callback = request.Request.URL
			}
		}
		if err := w.command("browsingContext.navigate", map[string]string{"context": target, "url": loginURL, "wait": "none"}, nil, observe); err != nil {
			return err
		}
		for callback == "" {
			m, err := w.receive()
			if err != nil {
				return err
			}
			observe(m)
		}
		return nil
	})
	return callback, err
}
