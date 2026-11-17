package authorization

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ldos/backend/internal/authbrowser"
	"ldos/backend/internal/config"
	"ldos/backend/internal/credentials"
	"ldos/backend/internal/downloads"
	"ldos/backend/internal/pixivauth"
)

type fakeBrowser struct {
	mu               sync.Mutex
	running, present bool
	proxy            string
	cookies          func(context.Context, string) ([]authbrowser.Cookie, error)
	callback         func(context.Context) (string, error)
	stops            int
}

func (b *fakeBrowser) Ensure(ctx context.Context, _, proxy string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.running, b.present, b.proxy = true, true, proxy
	return ctx.Err()
}
func (b *fakeBrowser) Running() bool                                      { b.mu.Lock(); defer b.mu.Unlock(); return b.running }
func (b *fakeBrowser) Proxy() string                                      { b.mu.Lock(); defer b.mu.Unlock(); return b.proxy }
func (b *fakeBrowser) Open(ctx context.Context, _ string) (string, error) { return "target", ctx.Err() }
func (b *fakeBrowser) Cookies(ctx context.Context, site string) ([]authbrowser.Cookie, error) {
	if b.cookies != nil {
		return b.cookies(ctx, site)
	}
	<-ctx.Done()
	return nil, ctx.Err()
}
func (b *fakeBrowser) LoginReady(ctx context.Context, _, _ string) (bool, error) {
	return true, ctx.Err()
}
func (b *fakeBrowser) CapturePixiv(ctx context.Context, _, _ string) (string, error) {
	if b.callback != nil {
		return b.callback(ctx)
	}
	<-ctx.Done()
	return "", ctx.Err()
}
func (b *fakeBrowser) CloseTarget(context.Context, string) error { return nil }
func (b *fakeBrowser) Stop() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.running = false
	b.stops++
	return nil
}
func (b *fakeBrowser) ResetProfile() error {
	_ = b.Stop()
	b.mu.Lock()
	b.present = false
	b.mu.Unlock()
	return nil
}
func (b *fakeBrowser) ProfilePresent() bool { b.mu.Lock(); defer b.mu.Unlock(); return b.present }

type fakeCache struct {
	mu    sync.Mutex
	token string
}

func (c *fakeCache) HasToken(ctx context.Context) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.token != "", ctx.Err()
}
func (c *fakeCache) SaveToken(ctx context.Context, token string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	c.token = token
	return nil
}
func (c *fakeCache) Clear(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.token = ""
	return ctx.Err()
}
func fixture(t *testing.T, browser *fakeBrowser) (*Service, *fakeCache) {
	t.Helper()
	root := t.TempDir()
	vault, err := credentials.New(filepath.Join(root, "managed"))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "config.json")
	if err := os.WriteFile(path, []byte(`{"auth":{"unknown":"preserve"},"keep":123}`), 0600); err != nil {
		t.Fatal(err)
	}
	cache := &fakeCache{}
	s := New(context.Background(), config.Auth{BrowserLoginTimeoutSeconds: 10, BrowserPollIntervalSeconds: .1}, path, vault, cache, browser, downloads.New(filepath.Join(root, "runtime")))
	t.Cleanup(func() {
		if err := s.Stop(); err != nil {
			t.Error(err)
		}
	})
	return s, cache
}
func sessionFor(t *testing.T, s *Service, site string) *session {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	x := s.sessions[site]
	if x == nil {
		t.Fatal("missing session")
	}
	return x
}
func waitDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("operation did not drain")
	}
}
func cookiesFor(site string) []authbrowser.Cookie {
	result := []authbrowser.Cookie{}
	for _, name := range authbrowser.Sites[site].Required {
		result = append(result, authbrowser.Cookie{Domain: "." + authbrowser.Sites[site].Domains[0], Path: "/", Name: name, Value: "private-value"})
	}
	return result
}
func waitState(t *testing.T, s *Service, x *session, state string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		found := x.state == state
		s.mu.Unlock()
		if found {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("state transition timeout")
}
func TestManagedLoginPersistsAndRevalidates(t *testing.T) {
	browser := &fakeBrowser{cookies: func(_ context.Context, site string) ([]authbrowser.Cookie, error) { return cookiesFor(site), nil }}
	s, _ := fixture(t, browser)
	ctx := context.Background()
	if err := s.vault.SetMetadata(ctx, "twitter", map[string]any{"invalidated_at": 5.0}); err != nil {
		t.Fatal(err)
	}
	result, err := s.Start(ctx, "x")
	if err != nil {
		t.Fatal(err)
	}
	id := result["session"].(map[string]any)["session_id"].(string)
	x := sessionFor(t, s, "twitter")
	waitDone(t, x.done)
	status, err := s.Status(ctx, "twitter")
	if err != nil || status["authorized"] != true || status["invalidated_at"] != nil {
		t.Fatal(status, err)
	}
	path, err := s.vault.CookiesFor(ctx, "twitter")
	if err != nil || path == "" {
		t.Fatal(path, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal(info, err)
	}
	poll, err := s.LoginSession(ctx, "twitter", id)
	if err != nil || object(poll["session"])["state"] != "authorized" || browser.Running() {
		t.Fatal(poll, err)
	}
	encoded, _ := json.Marshal(vaultLogin(poll))
	for _, secret := range []string{"private-value", "auth_token", "ct0", "authorization_url", "message"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("vault contains %s", secret)
		}
	}
	if _, err := s.vault.Invalidate(ctx, "twitter", path, "remote secret"); err != nil {
		t.Fatal(err)
	}
	status, _ = s.Status(ctx, "twitter")
	if status["authorized"] != false {
		t.Fatal(status)
	}
}
func TestCancellationBlocksLateCookieWriteAndReleasesClaim(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	browser := &fakeBrowser{cookies: func(_ context.Context, site string) ([]authbrowser.Cookie, error) {
		close(entered)
		<-release
		return cookiesFor(site), nil
	}}
	s, _ := fixture(t, browser)
	ctx := context.Background()
	if _, err := s.Start(ctx, "twitter"); err != nil {
		t.Fatal(err)
	}
	waitDone(t, entered)
	x := sessionFor(t, s, "twitter")
	if _, err := s.Start(ctx, "exhentai"); err == nil {
		t.Fatal("overlapping authorization accepted")
	}
	cancelled := make(chan struct{})
	go func() {
		defer close(cancelled)
		_, err := s.CancelLogin(ctx, "twitter", x.id)
		if err != nil {
			t.Error(err)
		}
	}()
	waitState(t, s, x, "cancelled")
	close(release)
	waitDone(t, cancelled)
	path, err := s.vault.CookiesFor(ctx, "twitter")
	if err != nil || path != "" {
		t.Fatal("cancelled login wrote cookies", err)
	}
	s.mu.Lock()
	id := s.activeID
	s.mu.Unlock()
	if id != "" || browser.Running() {
		t.Fatal("authorization not released")
	}
}
func TestPixivCancelPreservesPreviousToken(t *testing.T) {
	browser := &fakeBrowser{callback: func(context.Context) (string, error) { return "callback", nil }}
	s, cache := fixture(t, browser)
	cache.token = "previous"
	entered, release := make(chan struct{}), make(chan struct{})
	s.exchange = func(context.Context, pixivauth.Flow, string, string) (string, error) {
		close(entered)
		<-release
		return "late-token", nil
	}
	if _, err := s.Start(context.Background(), "pixiv"); err != nil {
		t.Fatal(err)
	}
	waitDone(t, entered)
	x := sessionFor(t, s, "pixiv")
	cancelled := make(chan struct{})
	go func() {
		defer close(cancelled)
		if _, err := s.CancelPixiv(context.Background()); err != nil {
			t.Error(err)
		}
	}()
	waitState(t, s, x, "cancelled")
	close(release)
	waitDone(t, cancelled)
	cache.mu.Lock()
	token := cache.token
	cache.mu.Unlock()
	if token != "previous" {
		t.Fatal("cancelled exchange overwrote token")
	}
}
func TestProfileResetKeepsExportsAndSiteClearKeepsProfile(t *testing.T) {
	browser := &fakeBrowser{present: true}
	s, cache := fixture(t, browser)
	ctx := context.Background()
	cache.token = "saved"
	if err := s.vault.SaveCookies(ctx, "twitter", authbrowser.Netscape(cookiesFor("twitter")), map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetProxy(ctx, "http://username:password@127.0.0.1:1234"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResetProfile(ctx); err != nil {
		t.Fatal(err)
	}
	status, _ := s.Status(ctx, "twitter")
	if status["authorized"] != true || browser.ProfilePresent() {
		t.Fatal(status)
	}
	if present, _ := cache.HasToken(ctx); !present {
		t.Fatal("profile reset cleared token")
	}
	browser.mu.Lock()
	browser.present = true
	browser.mu.Unlock()
	if _, err := s.Clear(ctx, "twitter"); err != nil {
		t.Fatal(err)
	}
	status, _ = s.Status(ctx, "twitter")
	if status["authorized"] != false || !browser.ProfilePresent() {
		t.Fatal(status)
	}
	proxy, _ := s.ProxyStatus(ctx)
	if proxy["source"] != "runtime" {
		t.Fatal(proxy)
	}
}
func TestTimeoutAndOpaqueBrowserFailures(t *testing.T) {
	for _, failBrowser := range []bool{false, true} {
		browser := &fakeBrowser{}
		if failBrowser {
			browser.cookies = func(context.Context, string) ([]authbrowser.Cookie, error) {
				return nil, errors.New("private-url-and-token")
			}
		}
		s, _ := fixture(t, browser)
		s.settings.BrowserLoginTimeoutSeconds = .02
		if _, err := s.Start(context.Background(), "twitter"); err != nil {
			t.Fatal(err)
		}
		x := sessionFor(t, s, "twitter")
		waitDone(t, x.done)
		want := "timed_out"
		if failBrowser {
			want = "failed"
		}
		s.mu.Lock()
		state, message := x.state, x.message
		s.mu.Unlock()
		if state != want || strings.Contains(message, "private") {
			t.Fatal(state, message)
		}
	}
}
func TestAuthorizationHTTPContract(t *testing.T) {
	s, _ := fixture(t, &fakeBrowser{})
	handler := s.Handler()
	request := func(method, route, body string, code int) map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		r := httptest.NewRequest(method, route, strings.NewReader(body))
		handler.ServeHTTP(w, r)
		if w.Code != code {
			t.Fatalf("%s %s: %d %s", method, route, w.Code, w.Body.String())
		}
		if code == http.StatusNotFound && !strings.HasPrefix(w.Body.String(), "{") {
			return nil
		}
		var result map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(w.Body.String(), "password") {
			t.Fatal("secret in response")
		}
		return result
	}
	snapshot := request("GET", "/api/v1/auth?view=vault", "", 200)
	if len(snapshot["items"].([]any)) != 5 || snapshot["response_profile"] != "vault" {
		t.Fatal(snapshot)
	}
	proxy := request("PUT", "/api/v1/auth/proxy?view=vault", `{"proxy_url":"http://username:password@127.0.0.1:1234"}`, 200)
	if proxy["proxy_url"] != "http://***@127.0.0.1:1234" || proxy["credentials_redacted"] != true || len(proxy) != 6 {
		t.Fatal(proxy)
	}
	request("PUT", "/api/v1/auth/proxy?view=vault", `{"proxy_url":"password"}`, 422)
	request("PUT", "/api/v1/auth/proxy?view=vault", `{"unknown":"password"}`, 422)
	request("PUT", "/api/v1/auth/proxy?view=vault", strings.Repeat(" ", 1025), 413)
	request("DELETE", "/api/v1/auth/proxy?view=vault", "", 200)
	request("GET", "/api/v1/auth/no-site?view=vault", "", 404)
	request("POST", "/api/v1/auth/pixiv/login/start", "", 409)
	request("POST", "/api/v1/auth/pixiv/oauth/complete", `{}`, 404)
	request("GET", "/api/v1/auth?view=bad", "", 422)
}

func TestPixivSuccessCommitsAndDisposesSession(t *testing.T) {
	callback := make(chan struct{})
	browser := &fakeBrowser{callback: func(ctx context.Context) (string, error) {
		select {
		case <-callback:
			return "callback", nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}}
	s, cache := fixture(t, browser)
	s.exchange = func(ctx context.Context, flow pixivauth.Flow, _, proxy string) (string, error) {
		if flow.Verifier == "" || !strings.HasPrefix(flow.AuthorizationURL, "https://app-api.pixiv.net/web/v1/login?") || proxy != "http://user:password@127.0.0.1:1234" {
			t.Error("OAuth dependencies were not carried into the exchange")
		}
		return "fixture-token", ctx.Err()
	}
	ctx := context.Background()
	if _, err := s.SetProxy(ctx, "http://user:password@127.0.0.1:1234"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(ctx, "pixiv"); err != nil {
		t.Fatal(err)
	}
	x := sessionFor(t, s, "pixiv")
	close(callback)
	waitDone(t, x.done)
	status, err := s.Status(ctx, "pixiv")
	if err != nil || status["authorized"] != true || status["oauth"] != nil || status["updated_at"] == nil {
		t.Fatal(status, err)
	}
	s.mu.Lock()
	released := s.activeID == "" && s.sessions["pixiv"] == nil
	s.mu.Unlock()
	if !released || browser.Running() {
		t.Fatal("successful OAuth kept its session/host")
	}
	if _, err := s.Clear(ctx, "pixiv"); err != nil {
		t.Fatal(err)
	}
	if present, err := cache.HasToken(ctx); err != nil || present {
		t.Fatal("clear kept token", err)
	}
}

func TestLoginAndModelDownloadsShareProxySettings(t *testing.T) {
	ctx := context.Background()
	browser := &fakeBrowser{cookies: func(_ context.Context, site string) ([]authbrowser.Cookie, error) { return cookiesFor(site), nil }}
	s, _ := fixture(t, browser)
	s.settings.AuthorizationProxy = "http://legacy-config:1234"
	if err := s.vault.SetMetadata(ctx, "_authorization_proxy", map[string]any{"url": "http://legacy-runtime:1234"}); err != nil {
		t.Fatal(err)
	}
	const custom = "http://user:password@127.0.0.1:7890"
	for _, mode := range []string{"custom", "none"} {
		if _, err := s.downloads.Update(downloads.Update{ProxyMode: downloads.String(mode), CustomProxy: downloads.String(custom)}); err != nil {
			t.Fatal(err)
		}
		env, err := s.downloads.Resolve(ctx, "model-test", downloads.Overrides{})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.Start(ctx, "twitter"); err != nil {
			t.Fatal(err)
		}
		waitDone(t, sessionFor(t, s, "twitter").done)
		want := ""
		if env.Proxy != nil {
			want = *env.Proxy
		}
		if browser.Proxy() != want {
			t.Fatal("login did not use the shared download proxy selection")
		}
		status, err := s.ProxyStatus(ctx)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(status)
		if strings.Contains(string(raw), "password") || strings.Contains(string(raw), "legacy-") {
			t.Fatal("proxy status exposed credentials or legacy settings")
		}
	}
	if _, err := s.SetProxy(ctx, custom); err != nil {
		t.Fatal(err)
	}
	view, err := s.downloads.View()
	if err != nil || view.ProxyMode != "custom" {
		t.Fatal("legacy proxy update did not update shared settings", err)
	}
	if _, err := s.ClearProxy(ctx); err != nil {
		t.Fatal(err)
	}
	view, err = s.downloads.View()
	if err != nil || view.ProxyMode != "none" {
		t.Fatal("legacy proxy clear did not update shared settings", err)
	}
}

type loginProxyPool struct{ acquired, released []string }

func (p *loginProxyPool) Acquire(_ context.Context, owner string) (string, error) {
	p.acquired = append(p.acquired, owner)
	return "http://127.0.0.1:7891", nil
}
func (p *loginProxyPool) Release(_ context.Context, owner string, _ bool, _ string) error {
	p.released = append(p.released, owner)
	return nil
}

func TestLoginReleasesSharedPoolLease(t *testing.T) {
	for _, outcome := range []string{"success", "failure", "cancel", "shutdown"} {
		t.Run(outcome, func(t *testing.T) {
			ctx := context.Background()
			browser := &fakeBrowser{}
			if outcome == "success" {
				browser.cookies = func(_ context.Context, site string) ([]authbrowser.Cookie, error) { return cookiesFor(site), nil }
			}
			if outcome == "failure" {
				browser.cookies = func(context.Context, string) ([]authbrowser.Cookie, error) { return nil, errors.New("browser failed") }
			}
			s, _ := fixture(t, browser)
			pool := &loginProxyPool{}
			s.downloads = downloads.NewWithPool(t.TempDir(), pool)
			if _, err := s.downloads.Update(downloads.Update{ProxyMode: downloads.String("pool")}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.ProxyStatus(ctx); err != nil {
				t.Fatal(err)
			}
			if len(pool.acquired) != 0 {
				t.Fatal("reading proxy status borrowed a node")
			}
			if _, err := s.Start(ctx, "twitter"); err != nil {
				t.Fatal(err)
			}
			x := sessionFor(t, s, "twitter")
			if x.proxy.Proxy == nil || *x.proxy.Proxy != "http://127.0.0.1:7891" {
				t.Fatal("login did not borrow the configured pool node")
			}
			switch outcome {
			case "cancel":
				if _, err := s.CancelLogin(ctx, "twitter", x.id); err != nil {
					t.Fatal(err)
				}
			case "shutdown":
				if err := s.Stop(); err != nil {
					t.Fatal(err)
				}
			}
			waitDone(t, x.done)
			if len(pool.acquired) != 1 || len(pool.released) != 1 || pool.acquired[0] != pool.released[0] {
				t.Fatal("login did not release exactly its own proxy lease")
			}
		})
	}
}

func TestLoginDoesNotFallBackToDirectWhenSharedPoolUnavailable(t *testing.T) {
	browser := &fakeBrowser{}
	s, _ := fixture(t, browser)
	if _, err := s.downloads.Update(downloads.Update{ProxyMode: downloads.String("pool")}); err != nil {
		t.Fatal(err)
	}
	_, err := s.Start(context.Background(), "twitter")
	var known *Error
	if !errors.As(err, &known) || known.Code != "authorization_proxy_unavailable" || browser.Running() {
		t.Fatal("unavailable shared proxy pool did not prevent login")
	}
}
