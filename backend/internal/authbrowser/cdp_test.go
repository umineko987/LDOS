//go:build linux

package authbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

func fakeCDP(t *testing.T, handler func(*websocket.Conn)) (*Browser, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/json/version":
			json.NewEncoder(w).Encode(map[string]string{"webSocketDebuggerUrl": "ws://" + r.Host + "/devtools/browser/test"})
		case "/json/list":
			json.NewEncoder(w).Encode([]map[string]string{{"type": "page", "id": "target", "webSocketDebuggerUrl": "ws://" + r.Host + "/devtools/page/target"}})
		default:
			if _, present := r.Header["Origin"]; present {
				t.Error("CDP upgrade included Origin header")
			}
			ws := websocket.Server{Handshake: func(*websocket.Config, *http.Request) error { return nil }, Handler: handler}
			ws.ServeHTTP(w, r)
		}
	}))
	t.Cleanup(server.Close)
	port := server.Listener.Addr().(*net.TCPAddr).Port
	life, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	b := New(t.TempDir() + "/profile")
	b.host = &host{port: port, endpoint: "ws://" + server.Listener.Addr().String() + "/devtools/browser/test", ctx: life, cancel: cancel, done: make(chan struct{})}
	return b, server
}

func TestCapturePixivEarlyCallback(t *testing.T) {
	callback := "https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback?code=private&state=unique"
	for _, method := range []string{"Network.requestWillBeSent", "Network.responseReceived"} {
		t.Run(method, func(t *testing.T) {
			b, _ := fakeCDP(t, func(ws *websocket.Conn) {
				defer ws.Close()
				for _, expected := range []string{"Network.enable", "Page.enable", "Page.navigate"} {
					var request cdpMessage
					if err := websocket.JSON.Receive(ws, &request); err != nil {
						t.Error(err)
						return
					}
					if request.Method != expected {
						t.Errorf("method = %s, want %s", request.Method, expected)
						return
					}
					if expected == "Page.navigate" {
						key := "request"
						if method == "Network.responseReceived" {
							key = "response"
						}
						websocket.JSON.Send(ws, map[string]any{"method": method, "params": map[string]any{key: map[string]string{"url": callback}}})
					}
					websocket.JSON.Send(ws, map[string]any{"id": request.ID, "result": map[string]any{}})
				}
			})
			got, err := b.CapturePixiv(context.Background(), "target", "https://app-api.pixiv.net/web/v1/login?state=unique")
			if err != nil || got != callback {
				t.Fatalf("capture = %q, %v", got, err)
			}
		})
	}
}

func TestCapturePixivCancellation(t *testing.T) {
	navigated := make(chan struct{})
	b, _ := fakeCDP(t, func(ws *websocket.Conn) {
		defer ws.Close()
		for {
			var request cdpMessage
			if websocket.JSON.Receive(ws, &request) != nil {
				return
			}
			if request.Method == "Page.navigate" {
				close(navigated)
				continue
			}
			websocket.JSON.Send(ws, map[string]any{"id": request.ID, "result": map[string]any{}})
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := b.CapturePixiv(ctx, "target", "https://app-api.pixiv.net/web/v1/login")
		result <- err
	}()
	select {
	case <-navigated:
	case <-time.After(2 * time.Second):
		t.Fatal("navigation not observed")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("capture error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("capture ignored cancellation")
	}
}

func TestCDPRequestCancellationAndSafeErrors(t *testing.T) {
	for _, mode := range []string{"cancel", "error", "oversize"} {
		t.Run(mode, func(t *testing.T) {
			received := make(chan struct{})
			b, _ := fakeCDP(t, func(ws *websocket.Conn) {
				defer ws.Close()
				var request cdpMessage
				if websocket.JSON.Receive(ws, &request) != nil {
					return
				}
				close(received)
				switch mode {
				case "error":
					websocket.JSON.Send(ws, map[string]any{"id": request.ID, "error": map[string]string{"message": "secret credential https://user:password@private.invalid/"}})
				case "oversize":
					websocket.Message.Send(ws, strings.Repeat("x", maxCDPBytes+1))
				case "cancel":
					websocket.JSON.Receive(ws, &request)
				}
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			go func() { _, err := b.Open(ctx, "about:blank"); result <- err }()
			select {
			case <-received:
			case <-time.After(2 * time.Second):
				t.Fatal("request not received")
			}
			if mode == "cancel" {
				cancel()
			}
			select {
			case err := <-result:
				want := ErrCDP
				if mode == "cancel" {
					want = context.Canceled
				}
				if !errors.Is(err, want) {
					t.Fatalf("error = %v, want %v", err, want)
				}
			case <-time.After(time.Second):
				t.Fatal("request did not finish")
			}
		})
	}
}

func TestCDPHandshakeCancellation(t *testing.T) {
	accepted := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(accepted)
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	port := server.Listener.Addr().(*net.TCPAddr).Port
	result := make(chan error, 1)
	go func() {
		_, err := dialCDP(ctx, "ws://"+server.Listener.Addr().String()+"/devtools/browser/test", port, "browser")
		result <- err
	}()
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("handshake not received")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("handshake ignored cancellation")
	}
}

func TestEndpointValidation(t *testing.T) {
	for _, raw := range []string{
		"ws://127.0.0.1:9222/devtools/browser/abc-123",
		"ws://localhost:9222/devtools/browser/abc",
		"ws://[::1]:9222/devtools/browser/abc",
	} {
		if !validEndpoint(raw, 9222, "browser") {
			t.Errorf("rejected %s", raw)
		}
	}
	for _, raw := range []string{
		"wss://127.0.0.1:9222/devtools/browser/abc", "ws://127.0.0.1:9223/devtools/browser/abc",
		"ws://example.org:9222/devtools/browser/abc", "ws://127.0.0.1.evil:9222/devtools/browser/abc",
		"ws://user:secret@127.0.0.1:9222/devtools/browser/abc", "ws://127.0.0.1:9222/devtools/page/abc",
		"ws://127.0.0.1:9222/devtools/browser/", "ws://127.0.0.1:9222/devtools/browser/../secret",
		"ws://127.0.0.1:9222/devtools/browser/a%2Fb", "ws://127.0.0.1:9222/devtools/browser/a?secret=1",
	} {
		if validEndpoint(raw, 9222, "browser") {
			t.Errorf("accepted %s", raw)
		}
	}
}

func TestDiscoveryAndPageListingRejectRemoteEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/json/version" {
			fmt.Fprint(w, `{"webSocketDebuggerUrl":"ws://remote.invalid:9222/devtools/browser/abc"}`)
		} else {
			fmt.Fprint(w, `[{"type":"page","id":"target","webSocketDebuggerUrl":"ws://remote.invalid:9222/devtools/page/target"}]`)
		}
	}))
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port
	if _, err := browserEndpoint(context.Background(), port); !errors.Is(err, ErrEndpoint) {
		t.Fatalf("discovery = %v", err)
	}
	if _, err := pageEndpoint(context.Background(), port, "target"); !errors.Is(err, ErrEndpoint) {
		t.Fatalf("page listing = %v", err)
	}
}

func TestDevtoolsNoProxyRedirectOrOversizedRead(t *testing.T) {
	var requests atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); http.Error(w, "unexpected proxy", 502) }))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("ALL_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, proxy.URL, 302)
		case "/large":
			fmt.Fprint(w, strings.Repeat("x", maxCDPBytes+1))
		default:
			fmt.Fprintf(w, `{"webSocketDebuggerUrl":"ws://%s/devtools/browser/test"}`, r.Host)
		}
	}))
	defer server.Close()
	port := server.Listener.Addr().(*net.TCPAddr).Port
	if _, err := browserEndpoint(context.Background(), port); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/redirect", "/large"} {
		var result any
		if err := devtoolsJSON(context.Background(), port, path, &result); !errors.Is(err, ErrCDP) {
			t.Fatalf("%s error = %v", path, err)
		}
	}
	if requests.Load() != 0 {
		t.Fatal("request reached proxy or redirect destination")
	}
}

func TestCookiesAndTwitterLoginReady(t *testing.T) {
	var page atomic.Value
	page.Store("https://x.com/home")
	b, _ := fakeCDP(t, func(ws *websocket.Conn) {
		defer ws.Close()
		var request cdpMessage
		if websocket.JSON.Receive(ws, &request) != nil {
			return
		}
		var result any
		switch request.Method {
		case "Storage.getCookies":
			result = map[string]any{"cookies": []Cookie{
				{Domain: ".x.com", Name: "auth_token", Value: "secret", Expires: -1},
				{Domain: "api.twitter.com", Name: "ct0", Value: "secret"},
				{Domain: "evilx.com", Name: "bad", Value: "secret"},
				{Domain: "x.com.evil", Name: "bad", Value: "secret"},
				{Domain: ".x.com", Name: "expired", Expires: 1},
				{Domain: ".x.com", Name: "inject", Value: "value\nline"},
			}}
		case "Target.getTargets":
			result = map[string]any{"targetInfos": []map[string]string{{"targetId": "target", "type": "page", "url": page.Load().(string)}}}
		}
		websocket.JSON.Send(ws, map[string]any{"id": request.ID, "result": result})
	})
	cookies, err := b.Cookies(context.Background(), "twitter")
	if err != nil || len(cookies) != 2 || cookies[0].Path != "/" {
		t.Fatalf("cookies = %#v, %v", cookies, err)
	}
	for _, test := range []struct {
		url   string
		ready bool
	}{
		{"https://x.com/i/flow/login", false}, {"https://x.com/I/FLOW/LOGIN/challenge", false},
		{"https://twitter.com/account/access?next=home", false}, {"https://evilx.com/home", false},
		{"https://x.com/home", true}, {"https://www.x.com/", true}, {"https://twitter.com/home", true},
	} {
		page.Store(test.url)
		ready, err := b.LoginReady(context.Background(), "twitter", "target")
		if err != nil || ready != test.ready {
			t.Errorf("ready(%s) = %v, %v", test.url, ready, err)
		}
	}
}

func TestPixivCallbackValidation(t *testing.T) {
	base := "https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback"
	if !pixivCallback(base + "?code=one&state=two") {
		t.Fatal("valid callback rejected")
	}
	for _, raw := range []string{
		base + "?code=one&code=two&state=s", base + "?code=one&state=s&state=t", base + "?code=&state=s",
		base + "?code=c&state=%20", base + "?code=c", base + "/?code=c&state=s",
		strings.Replace(base, "https:", "http:", 1) + "?code=c&state=s",
		strings.Replace(base, "app-api.pixiv.net", "app-api.pixiv.net.evil", 1) + "?code=c&state=s",
		strings.Replace(base, "app-api.pixiv.net", "app-api.pixiv.net:444", 1) + "?code=c&state=s",
		strings.Replace(base, "app-api.pixiv.net", "user@ app-api.pixiv.net", 1) + "?code=c&state=s",
	} {
		if pixivCallback(raw) {
			t.Errorf("accepted %q", raw)
		}
	}
}

func TestNetscapeDeterministicAndSafe(t *testing.T) {
	cookies := []Cookie{
		{Domain: "x.com", Name: "z", Value: "last", Expires: -1},
		{Domain: ".twitter.com", Path: "/", Name: "auth", Value: "first", Expires: 123.9, Secure: true},
		{Domain: "x.com", Name: "bad", Value: "inject\tline"},
		{Domain: "#HttpOnly_x.com", Name: "bad", Value: "comment"},
	}
	want := "# Netscape HTTP Cookie File\n\n.twitter.com\tTRUE\t/\tTRUE\t123\tauth\tfirst\nx.com\tFALSE\t/\tFALSE\t0\tz\tlast\n"
	if got := string(Netscape(cookies)); got != want {
		t.Fatalf("export = %q", got)
	}
	if cookies[0].Path != "" || cookies[0].Name != "z" {
		t.Fatal("export mutated input")
	}
	cookies[0], cookies[1] = cookies[1], cookies[0]
	if got := string(Netscape(cookies)); got != want {
		t.Fatal("export depends on input order")
	}
}
