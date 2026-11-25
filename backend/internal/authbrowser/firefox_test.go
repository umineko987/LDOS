//go:build linux

package authbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

func TestFirefoxDiscovery(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"firefox", "firefox-esr", "chromium"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, nil, 0700); err != nil {
			t.Fatal(err)
		}
		if name != "chromium" {
			if got, family, err := Discover(path); got != path || family != "Firefox" || err != nil {
				t.Fatalf("Discover(%s) = %s, %s, %v", name, got, family, err)
			}
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("GDL_BACKEND_CHROME", "")
	if _, family, err := Discover(""); family != "Chromium" || err != nil {
		t.Fatalf("existing browser priority changed: %s, %v", family, err)
	}
}

func TestFirefoxPixivCallback(t *testing.T) {
	const callback = "https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback?code=test&state=test"
	for _, cancelLogin := range []bool{false, true} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		b, server := fakeCDP(t, func(ws *websocket.Conn) {
			defer ws.Close()
			for _, method := range []string{"session.new", "session.subscribe", "browsingContext.navigate"} {
				var cmd cdpMessage
				if websocket.JSON.Receive(ws, &cmd) != nil || cmd.Method != method {
					t.Errorf("expected %s, got %s", method, cmd.Method)
					return
				}
				if method == "session.subscribe" {
					var p struct{ Events, Contexts []string }
					if json.Unmarshal(cmd.Params, &p) != nil || len(p.Events) != 1 || p.Events[0] != "network.beforeRequestSent" || len(p.Contexts) != 1 || p.Contexts[0] != "login" {
						t.Error("subscription not scoped to login tab")
						return
					}
				}
				if method == "browsingContext.navigate" {
					if cancelLogin {
						cancel()
						return
					}
					// Firefox can emit the callback before acknowledging navigation.
					for _, tab := range []string{"login", "unrelated"} {
						websocket.JSON.Send(ws, map[string]any{"method": "network.beforeRequestSent", "params": map[string]any{"context": tab, "request": map[string]string{"url": callback + "&tab=" + tab}}})
					}
				}
				websocket.JSON.Send(ws, map[string]any{"id": cmd.ID, "type": "success", "result": struct{}{}})
			}
		})
		s, err := startFirefox(ctx, b.host, "ws://"+server.Listener.Addr().String()+"/session", "")
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		b.host.firefox = s
		got, err := b.CapturePixiv(ctx, "login", "https://app-api.pixiv.net/web/v1/login")
		s.close()
		cancel()
		if cancelLogin && !errors.Is(err, context.Canceled) || !cancelLogin && (err != nil || got != callback+"&tab=login") {
			t.Fatalf("callback = %q, %v", got, err)
		}
	}
}

// Opt in with LDOS_TEST_FIREFOX=/usr/bin/firefox. No live account is needed:
// a loopback proxy serves a synthetic site in an isolated headless profile.
func TestFirefoxLocalLogin(t *testing.T) {
	executable := os.Getenv("LDOS_TEST_FIREFOX")
	if executable == "" {
		t.Skip("set LDOS_TEST_FIREFOX to a Firefox executable")
	}
	t.Setenv("MOZ_HEADLESS", "1")
	t.Setenv("HOME", t.TempDir())
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "login.invalid" {
			http.NotFound(w, r)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "fixture", Value: "session", HttpOnly: true, Path: "/"})
		w.Write([]byte("test login"))
	}))
	defer proxy.Close()
	b := New(filepath.Join(t.TempDir(), "shared"))
	t.Cleanup(func() { b.Stop() })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := b.Ensure(ctx, executable, proxy.URL); err != nil {
		t.Fatal(err)
	}
	tab, err := b.Open(ctx, "http://login.invalid/")
	if err != nil {
		t.Fatal(err)
	}
	for {
		cookies, err := b.firefox().cookies(ctx, Spec{Domains: []string{"login.invalid"}})
		if err != nil {
			t.Fatal(err)
		}
		if len(cookies) == 1 && cookies[0].Name == "fixture" && cookies[0].Value == "session" {
			break
		}
		if err := pause(ctx, 50*time.Millisecond); err != nil {
			t.Fatal("login cookie not observed", err)
		}
	}
	if cookies, err := b.Cookies(ctx, "twitter"); err != nil || len(cookies) != 0 {
		t.Fatal("unrelated cookies leaked", err)
	}
	if ready, err := b.LoginReady(ctx, "twitter", tab); err != nil || ready {
		t.Fatal("unrelated page counted as a login", err)
	}
	if err := b.CloseTarget(ctx, tab); err != nil {
		t.Fatal(err)
	}
	if err := b.Stop(); err != nil || b.Running() {
		t.Fatal("browser did not stop", err)
	}
	if _, err := os.Stat(filepath.Join(b.profileDir, "firefox", "prefs.js")); err != nil {
		t.Fatal("Firefox did not use its project profile", err)
	}
	if err := b.ResetProfile(); err != nil || b.ProfilePresent() {
		t.Fatal("profile reset failed", err)
	}
}
