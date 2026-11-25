//go:build linux

package authbrowser

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/websocket"
)

const maxCDPBytes = 4 << 20

var loopbackHTTP = &http.Client{
	Transport:     &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 500 * time.Millisecond}).DialContext, DisableKeepAlives: true, MaxResponseHeaderBytes: 16 << 10},
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return ErrEndpoint },
}

func controlled(ctx context.Context, fallback error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fallback
}

func devtoolsJSON(ctx context.Context, port int, path string, result any) error {
	if port < 1 || port > 65535 {
		return ErrEndpoint
	}
	ctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(port)+path, nil)
	if err != nil {
		return ErrEndpoint
	}
	response, err := loopbackHTTP.Do(req)
	if err != nil {
		return controlled(ctx, ErrCDP)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ErrCDP
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxCDPBytes+1))
	if err != nil {
		return controlled(ctx, ErrCDP)
	}
	if len(data) > maxCDPBytes || json.Unmarshal(data, result) != nil {
		return ErrCDP
	}
	return nil
}

func validEndpoint(raw string, port int, kind string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "ws" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" {
		return false
	}
	if u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
		return false
	}
	p, err := strconv.Atoi(u.Port())
	if err != nil || p != port || port < 1 || port > 65535 {
		return false
	}
	if kind == "bidi" {
		return u.Path == "/session"
	}
	prefix := "/devtools/" + kind + "/"
	if !strings.HasPrefix(u.Path, prefix) {
		return false
	}
	id := strings.TrimPrefix(u.Path, prefix)
	if id == "" || id == "." || id == ".." {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func browserEndpoint(ctx context.Context, port int) (string, error) {
	var result struct {
		Endpoint string `json:"webSocketDebuggerUrl"`
	}
	if err := devtoolsJSON(ctx, port, "/json/version", &result); err != nil {
		return "", err
	}
	if !validEndpoint(result.Endpoint, port, "browser") {
		return "", ErrEndpoint
	}
	return result.Endpoint, nil
}

func pageEndpoint(ctx context.Context, port int, target string) (string, error) {
	if strings.TrimSpace(target) == "" {
		return "", ErrEndpoint
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		var pages []struct {
			ID       string `json:"id"`
			TargetID string `json:"targetId"`
			Type     string `json:"type"`
			Endpoint string `json:"webSocketDebuggerUrl"`
		}
		if err := devtoolsJSON(ctx, port, "/json/list", &pages); err != nil {
			return "", err
		}
		for _, page := range pages {
			id := page.ID
			if id == "" {
				id = page.TargetID
			}
			if page.Type != "page" || id != target {
				continue
			}
			if !validEndpoint(page.Endpoint, port, "page") {
				return "", ErrEndpoint
			}
			return page.Endpoint, nil
		}
		if err := pause(ctx, 50*time.Millisecond); err != nil {
			return "", err
		}
	}
}

// x/net/websocket requires Origin. Chromium expects native CDP clients to omit
// it. This adapter removes only that handshake header, retaining x/net's framing
// and handshake validation, and bounds the upgrade response before framing starts.
type handshakeConn struct {
	net.Conn
	pending     []byte
	sent        bool
	handshaking bool
	remaining   int
}

func (c *handshakeConn) Write(p []byte) (int, error) {
	if c.sent {
		return c.Conn.Write(p)
	}
	if len(c.pending)+len(p) > 16<<10 {
		return 0, ErrCDP
	}
	c.pending = append(c.pending, p...)
	if !bytes.Contains(c.pending, []byte("\r\n\r\n")) {
		return len(p), nil
	}
	var filtered bytes.Buffer
	for _, line := range bytes.Split(c.pending, []byte("\r\n")) {
		if bytes.HasPrefix(bytes.ToLower(line), []byte("origin:")) {
			continue
		}
		if filtered.Len() != 0 {
			filtered.WriteString("\r\n")
		}
		filtered.Write(line)
	}
	if _, err := io.Copy(c.Conn, &filtered); err != nil {
		return 0, err
	}
	c.pending = nil
	c.sent = true
	return len(p), nil
}

func (c *handshakeConn) Read(p []byte) (int, error) {
	if c.handshaking {
		if c.remaining <= 0 {
			return 0, ErrCDP
		}
		if len(p) > c.remaining {
			p = p[:c.remaining]
		}
	}
	n, err := c.Conn.Read(p)
	if c.handshaking {
		c.remaining -= n
	}
	return n, err
}

type cdp struct {
	ws    *websocket.Conn
	ctx   context.Context
	close func()
	id    int
}

type cdpMessage struct {
	ID     int             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

func dialCDP(ctx context.Context, endpoint string, port int, kind string) (*cdp, error) {
	if !validEndpoint(endpoint, port, kind) {
		return nil, ErrEndpoint
	}
	u, _ := url.Parse(endpoint)
	hostname := u.Hostname()
	// Never resolve even a trusted spelling of localhost through external DNS.
	if hostname == "localhost" {
		hostname = "127.0.0.1"
	}
	raw, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(hostname, strconv.Itoa(port)))
	if err != nil {
		return nil, controlled(ctx, ErrCDP)
	}
	stop := context.AfterFunc(ctx, func() { raw.Close() })
	cleanup := func() { stop(); raw.Close() }
	if deadline, ok := ctx.Deadline(); ok {
		raw.SetDeadline(deadline)
	}
	conn := &handshakeConn{Conn: raw, handshaking: true, remaining: 16 << 10}
	config := &websocket.Config{Location: u, Origin: &url.URL{}, Version: websocket.ProtocolVersionHybi13, Header: make(http.Header)}
	ws, err := websocket.NewClient(config, conn)
	if err != nil {
		cleanup()
		return nil, controlled(ctx, ErrCDP)
	}
	conn.handshaking = false
	ws.MaxPayloadBytes = maxCDPBytes
	return &cdp{ws: ws, ctx: ctx, close: cleanup}, nil
}

func (c *cdp) receive() (cdpMessage, error) {
	var message cdpMessage
	if err := websocket.JSON.Receive(c.ws, &message); err != nil {
		return message, controlled(c.ctx, ErrCDP)
	}
	return message, nil
}

func (c *cdp) command(method string, params any, result any, observe func(cdpMessage)) error {
	c.id++
	if params == nil {
		params = struct{}{}
	}
	request := struct {
		ID     int    `json:"id"`
		Method string `json:"method"`
		Params any    `json:"params"`
	}{c.id, method, params}
	if err := websocket.JSON.Send(c.ws, request); err != nil {
		return controlled(c.ctx, ErrCDP)
	}
	for {
		message, err := c.receive()
		if err != nil {
			return err
		}
		if observe != nil {
			observe(message)
		}
		if message.ID != c.id {
			continue
		}
		if len(message.Error) != 0 && string(message.Error) != "null" {
			return ErrCDP
		}
		if result != nil && json.Unmarshal(message.Result, result) != nil {
			return ErrCDP
		}
		return nil
	}
}

func (b *Browser) request(ctx context.Context, method string, params, result any, timeout time.Duration) error {
	ctx, cancel, endpoint, port, err := b.connection(ctx, timeout)
	if err != nil {
		return err
	}
	defer cancel()
	conn, err := dialCDP(ctx, endpoint, port, "browser")
	if err != nil {
		return err
	}
	defer conn.close()
	return conn.command(method, params, result, nil)
}

func (b *Browser) Open(ctx context.Context, loginURL string) (string, error) {
	if s := b.firefox(); s != nil {
		return s.open(ctx, loginURL)
	}
	var result struct {
		Target string `json:"targetId"`
	}
	if err := b.request(ctx, "Target.createTarget", map[string]string{"url": loginURL}, &result, 5*time.Second); err != nil {
		return "", err
	}
	if strings.TrimSpace(result.Target) == "" {
		return "", ErrCDP
	}
	return result.Target, nil
}

func (b *Browser) Cookies(ctx context.Context, site string) ([]Cookie, error) {
	spec, ok := Sites[site]
	if !ok {
		return nil, ErrSite
	}
	if s := b.firefox(); s != nil {
		return s.cookies(ctx, spec)
	}
	var result struct {
		Cookies []Cookie `json:"cookies"`
	}
	if err := b.request(ctx, "Storage.getCookies", nil, &result, 5*time.Second); err != nil {
		return nil, err
	}
	return filterCookies(result.Cookies, spec.Domains, time.Now()), nil
}

func (b *Browser) LoginReady(ctx context.Context, site, target string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if _, ok := Sites[site]; !ok {
		return false, ErrSite
	}
	if site != "twitter" {
		return true, nil
	}
	if s := b.firefox(); s != nil {
		return s.loginReady(ctx, target)
	}
	var result struct {
		Targets []struct {
			ID   string `json:"targetId"`
			Type string `json:"type"`
			URL  string `json:"url"`
		} `json:"targetInfos"`
	}
	if err := b.request(ctx, "Target.getTargets", nil, &result, 5*time.Second); err != nil {
		return false, err
	}
	for _, page := range result.Targets {
		if page.ID == target && page.Type == "page" && twitterReadyURL(page.URL) {
			return true, nil
		}
	}
	return false, nil
}

func twitterReadyURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host != "x.com" && host != "www.x.com" && host != "twitter.com" {
		return false
	}
	path := strings.ToLower(u.Path)
	return !strings.HasPrefix(path, "/i/flow/login") && !strings.HasPrefix(path, "/account/access")
}

func (b *Browser) CloseTarget(ctx context.Context, target string) error {
	if target == "" {
		return nil
	}
	if s := b.firefox(); s != nil {
		return s.request(ctx, "browsingContext.close", map[string]string{"context": target}, nil)
	}
	return b.request(ctx, "Target.closeTarget", map[string]string{"targetId": target}, nil, 2*time.Second)
}

func pixivURL(raw, path string) (*url.URL, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || strings.ToLower(u.Hostname()) != "app-api.pixiv.net" || u.Path != path || u.RawPath != "" || u.User != nil || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") {
		return nil, false
	}
	return u, true
}

func pixivCallback(raw string) bool {
	u, ok := pixivURL(raw, "/web/v1/users/auth/pixiv/callback")
	if !ok {
		return false
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return false
	}
	for _, key := range []string{"code", "state"} {
		values := query[key]
		if len(values) != 1 || strings.TrimSpace(values[0]) == "" {
			return false
		}
	}
	return true
}

func (b *Browser) CapturePixiv(ctx context.Context, target, loginURL string) (string, error) {
	if _, ok := pixivURL(loginURL, "/web/v1/login"); !ok {
		return "", ErrLoginURL
	}
	if s := b.firefox(); s != nil {
		return s.capturePixiv(ctx, target, loginURL)
	}
	ctx, cancel, _, port, err := b.connection(ctx, 600*time.Second)
	if err != nil {
		return "", err
	}
	defer cancel()
	endpoint, err := pageEndpoint(ctx, port, target)
	if err != nil {
		return "", err
	}
	conn, err := dialCDP(ctx, endpoint, port, "page")
	if err != nil {
		return "", err
	}
	defer conn.close()
	captured := ""
	observe := func(message cdpMessage) {
		if captured != "" {
			return
		}
		var params struct {
			Request struct {
				URL string `json:"url"`
			} `json:"request"`
			Response struct {
				URL string `json:"url"`
			} `json:"response"`
		}
		if json.Unmarshal(message.Params, &params) != nil {
			return
		}
		candidate := ""
		switch message.Method {
		case "Network.requestWillBeSent":
			candidate = params.Request.URL
		case "Network.responseReceived":
			candidate = params.Response.URL
		}
		if pixivCallback(candidate) {
			captured = candidate
		}
	}
	if err := conn.command("Network.enable", nil, nil, observe); err != nil {
		return "", err
	}
	if err := conn.command("Page.enable", nil, nil, observe); err != nil {
		return "", err
	}
	if err := conn.command("Page.navigate", map[string]string{"url": loginURL}, nil, observe); err != nil {
		return "", err
	}
	for captured == "" {
		message, err := conn.receive()
		if err != nil {
			return "", err
		}
		observe(message)
	}
	return captured, nil
}
