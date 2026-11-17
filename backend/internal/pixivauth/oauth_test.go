package pixivauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ldos/backend/internal/proxytransport"
)

func newTestFlow(t *testing.T) Flow {
	t.Helper()
	flow, err := NewFlow()
	if err != nil {
		t.Fatal(err)
	}
	return flow
}

func TestFlowPKCE(t *testing.T) {
	flow := newTestFlow(t)
	other := newTestFlow(t)
	if flow.Verifier == other.Verifier || len(flow.Verifier) != 43 {
		t.Fatal("verifier entropy/length")
	}
	parsed, err := url.Parse(flow.AuthorizationURL)
	if err != nil {
		t.Fatal(err)
	}
	challenge := sha256.Sum256([]byte(flow.Verifier))
	query := parsed.Query()
	if parsed.Scheme+"://"+parsed.Host+parsed.Path != loginURL || len(query) != 3 ||
		query.Get("client") != "pixiv-android" || query.Get("code_challenge_method") != "S256" ||
		query.Get("code_challenge") != base64.RawURLEncoding.EncodeToString(challenge[:]) {
		t.Fatalf("unexpected authorization URL %s", flow.AuthorizationURL)
	}
}

func TestCallbackBoundary(t *testing.T) {
	good := callbackURL + "?state=UPSTREAM&code=CODE%2BVALUE"
	if code, err := callbackCode(good); err != nil || code != "CODE+VALUE" {
		t.Fatal(code, err)
	}
	bad := []string{
		"CODE", "code=CODE", " " + good, strings.Replace(good, "https:", "http:", 1),
		strings.Replace(good, "app-api.pixiv.net", "app-api.pixiv.net.evil.invalid", 1),
		strings.Replace(good, "app-api.pixiv.net", "user@app-api.pixiv.net", 1),
		strings.Replace(good, "app-api.pixiv.net", "app-api.pixiv.net:443", 1),
		strings.Replace(good, "/callback", "/%63allback", 1),
		callbackURL + "/?state=s&code=c", callbackURL + "?state=s&code=", callbackURL + "?code=c",
		callbackURL + "?state=s&state=s2&code=c", callbackURL + "?state=s&code=c&%63ode=d",
		callbackURL + "?state=%20&code=c", callbackURL + "?state=s&code=%0Ac", good + "#fragment", good + "#",
		good + "&broken=%zz", good + "&broken;a=b", callbackURL + "?state=s&code=%FF",
		callbackURL + "?state=s&code=" + strings.Repeat("x", 1025), good + "&x=" + strings.Repeat("x", 8192),
	}
	for _, callback := range bad {
		if _, err := callbackCode(callback); !errors.Is(err, ErrCallback) {
			t.Errorf("accepted callback %q", callback)
		}
	}
}

func TestExchangeNativeRequestAndDirectIgnoresEnvironment(t *testing.T) {
	flow := newTestFlow(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.Header.Get("User-Agent") != userAgent ||
			r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			t.Error("request headers/method")
		}
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		want := url.Values{
			"client_id": {clientID}, "client_secret": {clientSecret}, "code": {"CODE+VALUE"},
			"code_verifier": {flow.Verifier}, "grant_type": {"authorization_code"},
			"include_policy": {"true"}, "redirect_uri": {callbackURL},
		}
		if r.PostForm.Encode() != want.Encode() {
			t.Error("exchange form differs from vendored OAuthPixiv")
		}
		io.WriteString(w, `{"refresh_token":"unicode-中😀"}`)
	}))
	defer server.Close()
	var proxyCalls atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyCalls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("ALL_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "")
	token, err := flow.exchange(context.Background(), callbackURL+"?state=SERVER-GENERATED&code=CODE%2BVALUE", "", server.URL, proxytransport.NewHTTPClient)
	if err != nil || token != "unicode-中😀" || calls.Load() != 1 || proxyCalls.Load() != 0 {
		t.Fatal(token, err, calls.Load(), proxyCalls.Load())
	}
}

func TestExchangeProxyNoFallbackAndNoRedirect(t *testing.T) {
	flow := newTestFlow(t)
	callback := callbackURL + "?state=s&code=SECRET_CODE"
	var destinationCalls atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		destinationCalls.Add(1)
		io.WriteString(w, `{"refresh_token":"SECRET_TOKEN"}`)
	}))
	defer destination.Close()
	var proxyCalls atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyCalls.Add(1)
		if !r.URL.IsAbs() || r.Header.Get("Proxy-Authorization") != "Basic dXNlcjpwYXNz" {
			t.Error("explicit proxy request/auth missing")
		}
		w.WriteHeader(http.StatusBadGateway)
		io.WriteString(w, "SECRET_BODY")
	}))
	proxyURL := strings.Replace(proxy.URL, "http://", "http://user:pass@", 1)
	_, err := flow.exchange(context.Background(), callback, proxyURL, destination.URL, proxytransport.NewHTTPClient)
	if !errors.Is(err, ErrExchange) || proxyCalls.Load() != 1 || destinationCalls.Load() != 0 {
		t.Fatal(err)
	}
	proxy.Close()
	_, err = flow.exchange(context.Background(), callback, proxyURL, destination.URL, proxytransport.NewHTTPClient)
	if !errors.Is(err, ErrExchange) || destinationCalls.Load() != 0 {
		t.Fatal("proxy failure fell back", err)
	}
	for _, status := range []int{301, 302, 303, 307, 308} {
		redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", destination.URL+"?leak=SECRET_CODE")
			w.WriteHeader(status)
		}))
		_, err := flow.exchange(context.Background(), callback, "", redirect.URL, proxytransport.NewHTTPClient)
		redirect.Close()
		if !errors.Is(err, ErrExchange) || destinationCalls.Load() != 0 {
			t.Fatal("redirect followed", status, err)
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

func TestExchangeBoundsErrorsAndCancellation(t *testing.T) {
	flow := newTestFlow(t)
	for _, body := range []string{
		`{"error":"SECRET","refresh_token":"SECRET_TOKEN"}`, `{"refresh_token":""}`,
		`{"refresh_token":"  "}`, `{"refresh_token":123}`, `{"access_token":"SECRET"}`,
		`{"refresh_token":"token"} trailing`, `{"refresh_token":"` + strings.Repeat("x", 1017) + `"}`,
		`{"refresh_token":"ok","padding":"` + strings.Repeat("x", maxResponseBytes) + `"}`,
	} {
		closed := false
		factory := func(context.Context, string, time.Duration) (*http.Client, func(), error) {
			return &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
			})}, func() { closed = true }, nil
		}
		token, err := flow.exchange(context.Background(), callbackURL+"?state=s&code=SECRET_CODE", "", tokenURL, factory)
		if token != "" || !errors.Is(err, ErrExchange) || !closed {
			t.Fatal("uncontrolled response", err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := flow.exchange(ctx, callbackURL+"?state=s&code=c", "", "http://127.0.0.1:1", proxytransport.NewHTTPClient)
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	_, err = flow.Exchange(context.Background(), callbackURL+"?state=s&code=c", "invalid://SECRET_PROXY")
	if !errors.Is(err, ErrExchange) {
		t.Fatal(err)
	}
	// Invalid callbacks/flows are rejected before constructing any client.
	never := func(context.Context, string, time.Duration) (*http.Client, func(), error) {
		t.Fatal("unexpected client construction")
		return nil, nil, nil
	}
	if _, err := flow.exchange(context.Background(), "invalid", "", "", never); !errors.Is(err, ErrCallback) {
		t.Fatal(err)
	}
	if _, err := (Flow{}).exchange(context.Background(), callbackURL+"?state=s&code=c", "", "", never); !errors.Is(err, ErrFlow) {
		t.Fatal(err)
	}
}

func TestExchangeHTTPSConnectProxy(t *testing.T) {
	flow := newTestFlow(t)
	var calls atomic.Int32
	// Reject CONNECT locally: no external DNS or upstream socket is involved.
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodConnect || r.Host != "oauth.secure.pixiv.net:443" {
			t.Error("wrong CONNECT destination")
		}
		w.WriteHeader(http.StatusForbidden)
	}))
	defer proxy.Close()
	_, err := flow.Exchange(context.Background(), callbackURL+"?state=s&code=c", proxy.URL)
	if !errors.Is(err, ErrExchange) || calls.Load() != 1 {
		t.Fatal(err, calls.Load())
	}
	// A failing factory is sanitized even if its error includes credential data.
	factory := func(context.Context, string, time.Duration) (*http.Client, func(), error) {
		return nil, nil, &net.OpError{Op: "SECRET_PROXY", Net: "tcp", Err: errors.New("SECRET")}
	}
	_, err = flow.exchange(context.Background(), callbackURL+"?state=s&code=c", "", tokenURL, factory)
	if err != ErrExchange {
		t.Fatal(err)
	}
}
