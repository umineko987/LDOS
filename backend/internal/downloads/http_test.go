package downloads

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func request(store *Store, method, body string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	recorder.Header().Set("X-Request-ID", "request-test")
	store.ServeHTTP(recorder, httptest.NewRequest(method, "/api/v1/settings/downloads", strings.NewReader(body)))
	return recorder
}

func responseView(t *testing.T, response *httptest.ResponseRecorder) View {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	var view View
	if err := json.Unmarshal(response.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	return view
}

func TestHTTPGetPutAndNullContract(t *testing.T) {
	store := newTestStore(t)
	response := request(store, "GET", "")
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Content-Type") != "application/json" {
		t.Fatal("response headers")
	}
	if view := responseView(t, response); !reflect.DeepEqual(view, View{ProxyMode: "none"}) {
		t.Fatalf("defaults: %+v", view)
	}
	view := responseView(t, request(store, "PUT", `{"hf_mirror":"https://mirror.example/","proxy_mode":"custom","custom_proxy":"http://alice:s3cret@127.0.0.1:7890","hf_token":"`+testToken+`"}`))
	if !view.TokenSet || !view.CustomProxyHasCredentials || *view.CustomProxy != "http://***:***@127.0.0.1:7890" {
		t.Fatalf("view: %+v", view)
	}
	view = responseView(t, request(store, "PUT", `{"hf_mirror":null,"hf_token":null,"proxy_mode":null}`))
	if view.HFMirror != nil || view.ProxyMode != "custom" || !view.TokenSet || view.CustomProxy == nil {
		t.Fatalf("null fields: %+v", view)
	}
	view = responseView(t, request(store, "PUT", `{"proxy_mode":"pool"}`))
	if view.ProxyMode != "pool" || view.CustomProxy == nil || !view.TokenSet {
		t.Fatalf("partial fields: %+v", view)
	}
	if got := responseView(t, request(store, "GET", "")); !reflect.DeepEqual(view, got) {
		t.Fatalf("GET differs: %+v", got)
	}
	for _, response := range []*httptest.ResponseRecorder{request(store, "GET", ""), request(store, "PUT", `{}`)} {
		for _, secret := range []string{testToken, "abcd", "alice", "s3cret", "token_hint"} {
			if strings.Contains(response.Body.String(), secret) {
				t.Fatal("secret in response")
			}
		}
	}
	view = responseView(t, request(store, "PUT", `{"hf_token":null,"clear_hf_token":true}`))
	if view.TokenSet {
		t.Fatal("token not cleared")
	}
}

func TestHTTPRejectsInvalidRequestsWithoutEchoOrWrites(t *testing.T) {
	store := newTestStore(t)
	mustUpdate(t, store, Update{HFToken: String(testToken)})
	before := string(readTestFile(t, filepath.Join(store.runtimeDir, SettingsFilename)))
	cases := []struct{ body, code string }{
		{`{"proxy_mode":"custom"}`, "invalid_download_proxy"},
		{`{"proxy_mode":"custom","custom_proxy":"socks5://127.0.0.1:1080"}`, "invalid_download_proxy"},
		{`{"hf_mirror":"file:///etc"}`, "invalid_hf_mirror"},
		{`{"hf_token":"   "}`, "invalid_hf_token"},
		{`{"hf_token":"` + testToken + `","clear_hf_token":true}`, "invalid_hf_token"},
		{`{"hf_token":"` + testToken + ` x"}`, "invalid_hf_token"},
		{`{"proxy_mode":"socks"}`, "validation_error"},
		{`{"unexpected":"` + testToken + `"}`, "validation_error"},
		{`{"HF_TOKEN":"` + testToken + `"}`, "validation_error"},
		{`{"hf_token":"` + testToken + strings.Repeat("x", 8192) + `","extra":"` + testToken + `"}`, "validation_error"},
		{`{"hf_token":42}`, "validation_error"},
		{`{"hf_mirror":[]}`, "validation_error"},
		{`{"clear_hf_token":null}`, "validation_error"},
		{`{"clear_hf_token":"true"}`, "validation_error"},
		{`{"clear_hf_token":1}`, "validation_error"},
		{`{"hf_mirror":"` + strings.Repeat("x", 301) + `"}`, "validation_error"},
		{`{"hf_token":"` + testToken + ``, "validation_error"},
		{`{} {}`, "validation_error"},
		{`null`, "validation_error"},
		{`[]`, "validation_error"},
		{``, "validation_error"},
		{strings.Repeat(" ", 128<<10) + `{}`, "validation_error"},
	}
	for i, test := range cases {
		response := request(store, "PUT", test.body)
		if response.Code != 422 {
			t.Fatalf("case %d: status %d", i, response.Code)
		}
		var body struct {
			Error struct {
				Code      string `json:"code"`
				RequestID string `json:"request_id"`
				Details   any    `json:"details"`
				Message   string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Error.Code != test.code || body.Error.RequestID != "request-test" || body.Error.Message == "" {
			t.Fatalf("case %d: %s", i, response.Body.String())
		}
		if strings.Contains(response.Body.String(), testToken) {
			t.Fatal("validation exposed token")
		}
	}
	if after := string(readTestFile(t, filepath.Join(store.runtimeDir, SettingsFilename))); after != before {
		t.Fatal("rejected HTTP update changed settings")
	}
	if token, _ := store.Token(); token == nil || *token != testToken {
		t.Fatal("rejected HTTP update changed token")
	}
}

func TestHTTPFilesystemErrorAndMethodEnvelope(t *testing.T) {
	store := newTestStore(t)
	if err := os.MkdirAll(store.runtimeDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(t.TempDir(), testToken), filepath.Join(store.runtimeDir, TokenFilename)); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		response := request(store, method, `{}`)
		want := 500
		if method == "DELETE" {
			want = 405
		}
		if response.Code != want {
			t.Fatalf("%s status: %d", method, response.Code)
		}
		if strings.Contains(response.Body.String(), testToken) {
			t.Fatal("filesystem error exposed path secret")
		}
		var body map[string]map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		fields := body["error"]
		if len(fields) != 4 || fields["request_id"] != "request-test" || fields["details"] != nil {
			t.Fatalf("invalid envelope: %v", body)
		}
	}
}
