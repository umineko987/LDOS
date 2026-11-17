// Package pixivauth implements Pixiv's native OAuth exchange and gallery-dl cache.
package pixivauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"ldos/backend/internal/proxytransport"
)

const (
	loginURL         = "https://app-api.pixiv.net/web/v1/login"
	callbackURL      = "https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback"
	tokenURL         = "https://oauth.secure.pixiv.net/auth/token"
	clientID         = "MOBrBDS8blbauoSck0ZfDbtuzpyT"
	clientSecret     = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj"
	userAgent        = "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)"
	maxCallbackBytes = 8192
	maxResponseBytes = 64 * 1024
)

// Errors deliberately contain no callback, token, proxy, or upstream body.
var (
	ErrCallback = errors.New("invalid Pixiv OAuth callback")
	ErrFlow     = errors.New("invalid Pixiv OAuth flow")
	ErrExchange = errors.New("Pixiv OAuth exchange failed")
)

type Flow struct {
	AuthorizationURL string
	Verifier         string
}

// NewFlow creates a 256-bit random PKCE verifier. Pixiv itself supplies the
// callback state; the login request has no locally generated state parameter.
func NewFlow() (Flow, error) {
	var entropy [32]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return Flow{}, ErrFlow
	}
	verifier := base64.RawURLEncoding.EncodeToString(entropy[:])
	digest := sha256.Sum256([]byte(verifier))
	query := url.Values{
		"client":                {"pixiv-android"},
		"code_challenge_method": {"S256"},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(digest[:])},
	}
	return Flow{AuthorizationURL: loginURL + "?" + query.Encode(), Verifier: verifier}, nil
}

func callbackCode(callback string) (string, error) {
	if len(callback) > maxCallbackBytes || !utf8.ValidString(callback) {
		return "", ErrCallback
	}
	u, err := url.Parse(callback)
	if err != nil || u.Scheme != "https" || u.Host != "app-api.pixiv.net" ||
		u.User != nil || u.Path != "/web/v1/users/auth/pixiv/callback" ||
		u.RawPath != "" || u.Fragment != "" || strings.Contains(callback, "#") {
		return "", ErrCallback
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return "", ErrCallback
	}
	for _, name := range []string{"code", "state"} {
		values := query[name]
		if len(values) != 1 || len(values[0]) > 1024 || strings.TrimSpace(values[0]) == "" ||
			!utf8.ValidString(values[0]) || strings.ContainsFunc(values[0], unicode.IsControl) {
			return "", ErrCallback
		}
	}
	return query.Get("code"), nil
}

func validVerifier(verifier string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	for _, c := range verifier {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~", c)) {
			return false
		}
	}
	return true
}

type clientFactory func(context.Context, string, time.Duration) (*http.Client, func(), error)

// Exchange exchanges an exact Pixiv callback URL using the explicitly selected
// proxy. An empty proxyURL means direct, ignoring environment proxy variables.
func (f Flow) Exchange(ctx context.Context, callback, proxyURL string) (string, error) {
	return f.exchange(ctx, callback, proxyURL, tokenURL, proxytransport.NewHTTPClient)
}

// The endpoint and factory are private, per-call seams for offline tests.
func (f Flow) exchange(ctx context.Context, callback, proxyURL, endpoint string, factory clientFactory) (string, error) {
	code, err := callbackCode(callback)
	if err != nil {
		return "", err
	}
	if !validVerifier(f.Verifier) {
		return "", ErrFlow
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	client, closeClient, err := factory(ctx, proxyURL, 30*time.Second)
	if err != nil {
		return "", exchangeError(ctx)
	}
	defer closeClient()
	// Copy so an injected/shared client is never mutated.
	bounded := *client
	bounded.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	data := url.Values{
		"client_id": {clientID}, "client_secret": {clientSecret},
		"code": {code}, "code_verifier": {f.Verifier},
		"grant_type": {"authorization_code"}, "include_policy": {"true"},
		"redirect_uri": {callbackURL},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(data.Encode()))
	if err != nil {
		return "", ErrExchange
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", userAgent)
	response, err := bounded.Do(req)
	if err != nil {
		return "", exchangeError(ctx)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", ErrExchange
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes || !utf8.Valid(body) {
		return "", exchangeError(ctx)
	}
	var result struct {
		RefreshToken string          `json:"refresh_token"`
		Error        json.RawMessage `json:"error"`
	}
	if json.Unmarshal(body, &result) != nil || len(result.Error) != 0 || !validSavedToken(result.RefreshToken) {
		return "", ErrExchange
	}
	return result.RefreshToken, nil
}

func exchangeError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrExchange
}
