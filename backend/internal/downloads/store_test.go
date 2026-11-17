package downloads

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

const testToken = "hf_TestToken0123456789abcd"

func newTestStore(t *testing.T) *Store {
	t.Helper()
	return New(filepath.Join(t.TempDir(), "runtime"))
}

func mustUpdate(t *testing.T, store *Store, update Update) View {
	t.Helper()
	view, err := store.Update(update)
	if err != nil {
		t.Fatal(err)
	}
	return view
}

func readTestFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestDefaultsRoundTripPartialAndNullUpdates(t *testing.T) {
	store := newTestStore(t)
	view, err := store.View()
	if err != nil || !reflect.DeepEqual(view, View{ProxyMode: "none"}) {
		t.Fatalf("defaults: %+v %v", view, err)
	}
	if _, err := os.Stat(store.runtimeDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read created directory: %v", err)
	}
	view = mustUpdate(t, store, Update{HFMirror: String(" https://hf-mirror.example/ "), ProxyMode: String("custom"), CustomProxy: String(" http://127.0.0.1:7890/ "), HFToken: String("  " + testToken + "  ")})
	if *view.HFMirror != "https://hf-mirror.example" || *view.CustomProxy != "http://127.0.0.1:7890" || !view.TokenSet {
		t.Fatalf("round trip: %+v", view)
	}
	view = mustUpdate(t, store, Update{ProxyMode: String("pool")})
	if view.ProxyMode != "pool" || *view.HFMirror != "https://hf-mirror.example" || *view.CustomProxy != "http://127.0.0.1:7890" {
		t.Fatalf("partial: %+v", view)
	}
	view = mustUpdate(t, store, Update{HFMirror: Null(), HFToken: Null(), ProxyMode: Null()})
	if view.HFMirror != nil || view.ProxyMode != "pool" || !view.TokenSet {
		t.Fatalf("null semantics: %+v", view)
	}
	reloaded, err := New(store.runtimeDir).View()
	if err != nil || !reflect.DeepEqual(view, reloaded) {
		t.Fatalf("reload: %+v %v", reloaded, err)
	}
	token, err := store.Token()
	if err != nil || token == nil || *token != testToken {
		t.Fatal("internal token not preserved")
	}
	for _, name := range []string{SettingsFilename, TokenFilename} {
		info, err := os.Stat(filepath.Join(store.runtimeDir, name))
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("private file %s: %v %v", name, info, err)
		}
	}
	info, err := os.Stat(store.runtimeDir)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("private directory: %v %v", info, err)
	}
	if strings.Contains(string(readTestFile(t, filepath.Join(store.runtimeDir, SettingsFilename))), testToken) {
		t.Fatal("token in settings")
	}
	for i := 0; i < 2; i++ {
		if mustUpdate(t, store, Update{ClearHFToken: true}).TokenSet {
			t.Fatal("token not cleared")
		}
	}
	if _, err := os.Stat(filepath.Join(store.runtimeDir, TokenFilename)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("token file remains: %v", err)
	}
}

func TestCredentialsAndTokenDoNotEscape(t *testing.T) {
	store := newTestStore(t)
	proxy := "http://alice:s3cret@127.0.0.1:7890"
	view := mustUpdate(t, store, Update{CustomProxy: String(proxy), ProxyMode: String("custom"), HFToken: String(testToken)})
	if !view.CustomProxyHasCredentials || *view.CustomProxy != "http://***:***@127.0.0.1:7890" {
		t.Fatalf("mask: %+v", view)
	}
	env, err := store.Resolve(context.Background(), "owner", Overrides{})
	if err != nil || env.Proxy == nil || *env.Proxy != proxy || env.Token == nil || *env.Token != testToken {
		t.Fatal("executor did not receive credentials")
	}
	viewJSON, _ := json.Marshal(view)
	envJSON, _ := json.Marshal(env)
	for _, text := range []string{string(viewJSON), string(envJSON), fmt.Sprintf("%v %+v %#v", env, env, env)} {
		for _, secret := range []string{testToken, "abcd", "alice", "s3cret"} {
			if strings.Contains(text, secret) {
				t.Fatal("secret leaked through representation")
			}
		}
	}
}

func TestURLNormalizationBoundaries(t *testing.T) {
	for _, test := range []struct{ input, want string }{
		{" HTTPS://User:p%40ss@Example.com:443/ ", "https://User:p%40ss@Example.com:443"},
		{"http://[::1]:7890/", "http://[::1]:7890"},
		{"http://[fe80::1%25eth0]:7890", "http://[fe80::1%25eth0]:7890"},
		{"http://localhost:0", "http://localhost:0"},
		{"http://localhost:65535/?#", "http://localhost:65535"},
	} {
		got, err := normalizeProxy(&test.input)
		if err != nil || got == nil || *got != test.want {
			t.Fatalf("proxy normalization: %v %v", got, err)
		}
	}
	for _, input := range []string{"http://[localhost]:7890", "http://[127.0.0.1]:7890", "http://::1:7890", "http://host:1:7890"} {
		if _, err := normalizeProxy(&input); err == nil {
			t.Fatalf("accepted invalid proxy host %q", input)
		}
		if _, err := normalizeMirror(&input); err == nil {
			t.Fatalf("accepted invalid mirror host %q", input)
		}
	}
	input := " HTTP://[::1]:8080/hf/ "
	got, err := normalizeMirror(&input)
	if err != nil || got == nil || *got != "HTTP://[::1]:8080/hf" {
		t.Fatalf("mirror normalization: %v %v", got, err)
	}
}

func TestValidationNeverWrites(t *testing.T) {
	store := newTestStore(t)
	cases := []struct {
		update Update
		code   string
	}{
		{Update{ProxyMode: String("socks")}, "invalid_download_proxy_mode"},
		{Update{ProxyMode: String("custom")}, "invalid_download_proxy"},
		{Update{ClearHFToken: true, HFToken: String(testToken)}, "invalid_hf_token"},
	}
	for _, mirror := range []string{"file:///tmp", "https://user:pass@mirror.example", "https://mirror.example?token=x", "https://mirror.example#frag", "https://mirror.example:bad", "https://mirror.example:99999", "ftp://mirror.example", "https://mirror .example", "https://" + strings.Repeat("a", 300) + ".example"} {
		cases = append(cases, struct {
			update Update
			code   string
		}{Update{HFMirror: String(mirror)}, "invalid_hf_mirror"})
	}
	for _, proxy := range []string{"socks5://127.0.0.1:7890", "file:///tmp", "127.0.0.1:7890", "http://localhost", "http://localhost:bad", "http://localhost:99999", "http://localhost:7890/path", "http://localhost:7890/%2f", "http://localhost:7890?key=value", "http://localhost:7890#fragment", "http://local host:7890"} {
		cases = append(cases, struct {
			update Update
			code   string
		}{Update{CustomProxy: String(proxy)}, "invalid_download_proxy"})
	}
	for _, token := range []string{"", "   ", "hf_bad token", "hf_\x00", strings.Repeat("x", 8193)} {
		cases = append(cases, struct {
			update Update
			code   string
		}{Update{HFToken: String(token)}, "invalid_hf_token"})
	}
	for i, test := range cases {
		_, err := store.Update(test.update)
		var validation *Error
		if !errors.As(err, &validation) || validation.Code != test.code {
			t.Fatalf("case %d: %v", i, err)
		}
	}
	if _, err := os.Stat(store.runtimeDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid update created files: %v", err)
	}
	mustUpdate(t, store, Update{ProxyMode: String("custom"), CustomProxy: String("http://localhost:7890"), HFToken: String(testToken)})
	before := string(readTestFile(t, filepath.Join(store.runtimeDir, SettingsFilename)))
	if _, err := store.Update(Update{HFMirror: String("https://valid.example"), CustomProxy: Null()}); err == nil {
		t.Fatal("custom mode accepted missing proxy")
	}
	if _, err := store.Update(Update{HFMirror: String("https://valid.example"), HFToken: String("bad token")}); err == nil {
		t.Fatal("invalid token accepted")
	}
	if after := string(readTestFile(t, filepath.Join(store.runtimeDir, SettingsFilename))); before != after {
		t.Fatal("failed validation changed settings")
	}
	if token, _ := store.Token(); token == nil || *token != testToken {
		t.Fatal("failed validation changed token")
	}
	view := mustUpdate(t, store, Update{ProxyMode: String("none"), CustomProxy: String("")})
	if view.CustomProxy != nil {
		t.Fatal("proxy not cleared")
	}
}

func TestCorruptSettingsUseDefaultsAndPreserveValidFields(t *testing.T) {
	store := newTestStore(t)
	if err := os.MkdirAll(store.runtimeDir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, content := range []string{"{not json", "[]", "null", "{\"hf_mirror\":\"https://mirror.example/\xff\"}", `{"proxy_mode":"custom","custom_proxy":"socks5://x:1"}`, `{"proxy_mode":"bogus","hf_mirror":"file:///etc"}`, `{"proxy_mode":{},"hf_mirror":42,"custom_proxy":true}`} {
		if err := os.WriteFile(filepath.Join(store.runtimeDir, SettingsFilename), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		view, err := store.View()
		if err != nil || !reflect.DeepEqual(view, View{ProxyMode: "none"}) {
			t.Fatalf("corrupt defaults: %+v %v", view, err)
		}
	}
	if err := os.WriteFile(filepath.Join(store.runtimeDir, SettingsFilename), []byte(`{"proxy_mode":"bogus","hf_mirror":"https://mirror.example"}`), 0600); err != nil {
		t.Fatal(err)
	}
	view, err := store.View()
	if err != nil || view.HFMirror == nil || *view.HFMirror != "https://mirror.example" || view.ProxyMode != "none" {
		t.Fatalf("valid field lost: %+v %v", view, err)
	}
}

func TestSymlinksRejectedForReadWriteAndClear(t *testing.T) {
	for _, name := range []string{SettingsFilename, TokenFilename} {
		for _, dangling := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/dangling=%t", name, dangling), func(t *testing.T) {
				store := newTestStore(t)
				mustUpdate(t, store, Update{})
				target := filepath.Join(t.TempDir(), "outside")
				if !dangling {
					if err := os.WriteFile(target, []byte(testToken), 0644); err != nil {
						t.Fatal(err)
					}
				}
				path := filepath.Join(store.runtimeDir, name)
				if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
				if _, err := store.View(); !errors.Is(err, errUnsafePath) {
					t.Fatalf("symlink read accepted: %v", err)
				}
				if name == TokenFilename {
					if _, err := store.Token(); !errors.Is(err, errUnsafePath) {
						t.Fatalf("token read accepted: %v", err)
					}
				}
				for _, update := range []Update{{HFToken: String("new-token")}, {ClearHFToken: true}} {
					if _, err := store.Update(update); !errors.Is(err, errUnsafePath) {
						t.Fatalf("symlink mutation accepted: %v", err)
					}
				}
				if !dangling && string(readTestFile(t, target)) != testToken {
					t.Fatal("symlink target modified")
				}
				if dangling {
					if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
						t.Fatal("dangling target created")
					}
				}
				if _, err := os.Readlink(path); err != nil {
					t.Fatal("symlink removed")
				}
			})
		}
	}
	t.Run("ancestor", func(t *testing.T) {
		root, target := t.TempDir(), t.TempDir()
		link := filepath.Join(root, "linked")
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		store := New(filepath.Join(link, "runtime"))
		if _, err := store.View(); !errors.Is(err, errUnsafePath) {
			t.Fatalf("ancestor read accepted: %v", err)
		}
		if _, err := store.Update(Update{HFToken: String(testToken)}); !errors.Is(err, errUnsafePath) {
			t.Fatalf("ancestor write accepted: %v", err)
		}
		entries, err := os.ReadDir(target)
		if err != nil || len(entries) != 0 {
			t.Fatalf("ancestor target modified: %v", err)
		}
	})
}

func TestExistingPermissionsAreRepaired(t *testing.T) {
	store := newTestStore(t)
	mustUpdate(t, store, Update{HFToken: String(testToken)})
	if err := os.Chmod(store.runtimeDir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{SettingsFilename, TokenFilename} {
		if err := os.Chmod(filepath.Join(store.runtimeDir, name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	mustUpdate(t, store, Update{HFToken: String(testToken)})
	for path, want := range map[string]os.FileMode{store.runtimeDir: 0700, filepath.Join(store.runtimeDir, SettingsFilename): 0600, filepath.Join(store.runtimeDir, TokenFilename): 0600} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != want {
			t.Fatalf("permissions %s: %v %v", path, info, err)
		}
	}
}

type testPool struct {
	endpoint   string
	err        error
	acquired   []string
	released   []string
	fault      bool
	reason     string
	releaseErr error
}

func (p *testPool) Acquire(_ context.Context, owner string) (string, error) {
	p.acquired = append(p.acquired, owner)
	return p.endpoint, p.err
}
func (p *testPool) Release(ctx context.Context, owner string, fault bool, reason string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	p.released = append(p.released, owner)
	p.fault, p.reason = fault, reason
	return p.releaseErr
}

func TestResolveOverridesAndPoolLifecycle(t *testing.T) {
	pool := &testPool{endpoint: "http://127.0.0.1:20001"}
	store := NewWithPool(filepath.Join(t.TempDir(), "runtime"), pool)
	mustUpdate(t, store, Update{HFMirror: String("https://mirror.example"), HFToken: String(testToken), ProxyMode: String("pool")})
	ctx, cancel := context.WithCancel(context.Background())
	env, err := store.Resolve(ctx, "models:test", Overrides{})
	if err != nil || env.ProxySource != "pool" || env.Proxy == nil || *env.Proxy != pool.endpoint || env.LeaseOwner == nil || *env.LeaseOwner != "models:test" {
		t.Fatalf("resolve: %v %v", env, err)
	}
	if env.HFEndpoint == nil || *env.HFEndpoint != "https://mirror.example" || env.Token == nil || *env.Token != testToken {
		t.Fatal("stored settings not resolved")
	}
	cancel()
	if err := store.Release(ctx, env); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(pool.released, []string{"models:test"}) || pool.fault || pool.reason != "model_download_finished" {
		t.Fatalf("bad release: %+v", pool)
	}
	env, err = store.Resolve(context.Background(), "explicit", Overrides{Token: Null(), HFMirror: Null(), Proxy: Null()})
	if err != nil || env.Token != nil || env.HFEndpoint != nil || env.Proxy != nil || env.ProxySource != "none" || env.LeaseOwner != nil {
		t.Fatalf("explicit null: %v %v", env, err)
	}
	if err := store.Release(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	env, err = store.Resolve(context.Background(), "explicit", Overrides{Token: String("override"), HFMirror: String("https://override.example"), Proxy: String("http://localhost:7890")})
	if err != nil || *env.Token != "override" || *env.HFEndpoint != "https://override.example" || *env.Proxy != "http://localhost:7890" || env.ProxySource != "custom" || len(pool.acquired) != 1 || len(pool.released) != 1 {
		t.Fatal("explicit override unexpectedly leased")
	}
}

func TestMissingOrFailingPoolIsAnError(t *testing.T) {
	for _, pool := range []Pool{nil, &testPool{}, &testPool{err: errors.New("secret " + testToken + " http://u:p@x:1")}} {
		store := NewWithPool(filepath.Join(t.TempDir(), "runtime"), pool)
		mustUpdate(t, store, Update{ProxyMode: String("pool")})
		_, err := store.Resolve(context.Background(), "owner", Overrides{})
		if !errors.Is(err, ErrProxyUnavailable) || strings.Contains(err.Error(), testToken) || strings.Contains(err.Error(), "u:p@") {
			t.Fatalf("unsafe pool error: %v", err)
		}
		if pool, ok := pool.(*testPool); ok && pool.err == nil && len(pool.released) != 1 {
			t.Fatal("empty lease was not released")
		}
	}
	pool := &testPool{endpoint: "http://localhost:1", releaseErr: errors.New(testToken)}
	store := NewWithPool(filepath.Join(t.TempDir(), "runtime"), pool)
	mustUpdate(t, store, Update{ProxyMode: String("pool")})
	env, err := store.Resolve(context.Background(), "owner", Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Release(context.Background(), env); !errors.Is(err, ErrProxyUnavailable) {
		t.Fatalf("release: %v", err)
	}
	if err := New(t.TempDir()).Release(context.Background(), env); !errors.Is(err, ErrProxyUnavailable) {
		t.Fatalf("missing pool release: %v", err)
	}
}

func TestConcurrentPartialUpdatesAndReaders(t *testing.T) {
	store := newTestStore(t)
	mustUpdate(t, store, Update{})
	var wg sync.WaitGroup
	for worker := 0; worker < 12; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				var err error
				switch worker % 6 {
				case 0:
					_, err = store.Update(Update{HFMirror: String(fmt.Sprintf("https://mirror%d.example", i))})
				case 1:
					_, err = store.Update(Update{CustomProxy: String(fmt.Sprintf("http://localhost:%d", 1000+i))})
				case 2:
					_, err = store.Update(Update{HFToken: String(testToken)})
				case 3:
					_, err = store.View()
				case 4:
					_, err = store.Token()
				case 5:
					_, err = store.Resolve(context.Background(), "owner", Overrides{})
				}
				if err != nil {
					t.Error(err)
					return
				}
			}
		}(worker)
	}
	wg.Wait()
	view, err := store.View()
	if err != nil || view.HFMirror == nil || *view.HFMirror != "https://mirror19.example" || view.CustomProxy == nil || *view.CustomProxy != "http://localhost:1019" || !view.TokenSet {
		t.Fatalf("concurrent updates lost fields: %+v %v", view, err)
	}
	entries, err := os.ReadDir(store.runtimeDir)
	if err != nil || len(entries) != 2 {
		t.Fatalf("temporary files remain: %v %v", entries, err)
	}
}
