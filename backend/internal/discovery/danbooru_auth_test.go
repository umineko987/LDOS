package discovery

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"ldos/backend/internal/gallery"
)

type danAuthTestCapturer struct {
	resolve func(context.Context, gallery.Request) (http.Header, error)
}

func (c danAuthTestCapturer) Capture(context.Context, gallery.CaptureRequest) (gallery.CaptureResult, error) {
	panic("unexpected gallery capture")
}
func (c danAuthTestCapturer) ResolveDanbooruAuth(ctx context.Context, request gallery.Request) (http.Header, error) {
	return c.resolve(ctx, request)
}

func TestDanbooruFallbackResolvesAuthenticationOnceForAllAttempts(t *testing.T) {
	for _, artists := range []bool{false, true} {
		for _, galleryFails := range []bool{false, true} {
			t.Run(strings.Join([]string{map[bool]string{false: "posts", true: "artists"}[artists], map[bool]string{false: "empty", true: "failed"}[galleryFails]}, "/"), func(t *testing.T) {
				a, _, _ := danTestAdapter()
				request := danTestRequest()
				request.ConfigFile, request.CookiesFile, request.CredentialsRef = "config", "cookies", "account"
				request.ExtraArgs = []string{"--netrc"}
				request.Policy.RetryLimit = 1
				resolved, called := 0, 0
				headers := http.Header{"Authorization": {"Basic fixture-auth"}, "Cookie": {"session=fixture-cookie"}}
				a.Transport.Gallery = danAuthTestCapturer{resolve: func(ctx context.Context, got gallery.Request) (http.Header, error) {
					resolved++
					if got.ConfigFile != request.ConfigFile || got.CookiesFile != request.CookiesFile || got.CredentialsRef != request.CredentialsRef || !reflect.DeepEqual(got.ExtraArgs, request.ExtraArgs) {
						t.Fatalf("lost auth inputs: %+v", got)
					}
					if artists != strings.Contains(got.URL, "/artists?") {
						t.Fatal("resolver received wrong extractor URL", got.URL)
					}
					return headers, nil
				}}
				a.GalleryDiscover = func(context.Context, Request) (map[string]any, error) {
					if galleryFails {
						return nil, &Error{Code: "discovery_failed", Message: "fixture"}
					}
					return map[string]any{"candidate_count": 0, "author_count": 0}, nil
				}
				a.Transport.HTTPRequest = func(ctx context.Context, _, target string, params url.Values, _ any, _ string, _ time.Duration) (HTTPResult, error) {
					called++
					got := danbooruRequestHeaders(ctx)
					if !reflect.DeepEqual(got, headers) || strings.Contains(target+params.Encode(), "fixture-auth") || params.Has("login") || params.Has("api_key") {
						t.Fatal("credentials lost or exposed in URL")
					}
					if called == 1 {
						return HTTPResult{StatusCode: 503}, nil
					}
					return HTTPResult{StatusCode: 200, Payload: []any{}}, nil
				}
				search := a.Search
				if artists {
					search = a.SearchArtists
				}
				result, err := search(context.Background(), request)
				if err != nil || result == nil || resolved != 1 || called != 2 {
					t.Fatalf("result %v err %v resolutions %d requests %d", result, err, resolved, called)
				}
				if danbooruRequestHeaders(context.Background()) != nil {
					t.Fatal("authentication leaked outside its request context")
				}
			})
		}
	}
}

func TestDanbooruExplicitAuthCannotFallBackAnonymously(t *testing.T) {
	for _, field := range []string{"config", "cookies", "ref", "args", "resolver"} {
		t.Run(field, func(t *testing.T) {
			a, _, _ := danTestAdapter()
			request := danTestRequest()
			switch field {
			case "config":
				request.ConfigFile = "missing"
			case "cookies":
				request.CookiesFile = "missing"
			case "ref":
				request.CredentialsRef = "missing"
			case "args":
				request.ExtraArgs = []string{"--netrc"}
			case "resolver":
				a.Transport.Gallery = danAuthTestCapturer{resolve: func(context.Context, gallery.Request) (http.Header, error) {
					return nil, errors.New("private-secret")
				}}
			}
			a.Transport.HTTPRequest = func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error) {
				t.Fatal("anonymous HTTP request after auth resolution failure")
				return HTTPResult{}, nil
			}
			_, err := a.SearchPostsAPI(context.Background(), request)
			danErrorCode(t, err, "danbooru_auth_unavailable")
			if strings.Contains(err.Error(), "private-secret") {
				t.Fatal("resolver diagnostic leaked a secret")
			}
		})
	}
}

func TestRequestJSONResponseHeadersAndAuthOriginBoundary(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("request-scoped authentication leaked")
		}
		w.Header().Set("Retry-After", "3")
		w.Header().Set("X-Rate-Limit-Remaining", "0")
		w.Write([]byte(`[]`))
	}))
	defer server.Close()
	ctx := context.WithValue(context.Background(), danbooruHeadersKey{}, http.Header{"Authorization": {"Basic private-secret"}})
	if _, err := requestJSON(ctx, "GET", server.URL, nil, nil, "", time.Second); err == nil || strings.Contains(err.Error(), "private-secret") {
		t.Fatal("expected safe rejection for another origin", err)
	}
	result, err := requestJSON(context.Background(), "GET", server.URL, nil, nil, "", time.Second)
	if err != nil || calls != 1 || result.Headers.Get("Retry-After") != "3" || result.Headers.Get("X-Rate-Limit-Remaining") != "0" {
		t.Fatalf("HTTP response headers lost: %+v %v calls %d", result, err, calls)
	}
}
