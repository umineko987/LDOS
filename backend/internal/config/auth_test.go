package config

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAuthorizationProxyAndBrowserSettings(t *testing.T) {
	for _, test := range []struct{ input, want string }{
		{"  ", ""}, {"HTTP://user:secret@LOCALHOST:1234/", "http://user:secret@localhost:1234"}, {"socks5h://[::1]:7890", "socks5h://[::1]:7890"},
	} {
		got, err := NormalizeAuthorizationProxy(test.input)
		if err != nil || got != test.want {
			t.Fatalf("normalized proxy mismatch: %v", err)
		}
	}
	for _, input := range []string{"http://localhost", "file://localhost:1234", "http://localhost:1234/path", "http://localhost:1234?q=secret", "socks5://user:secret@localhost:1234", "http://local host:1234", "http://localhost:99999", strings.Repeat("x", 301)} {
		if _, err := NormalizeAuthorizationProxy(input); err == nil {
			t.Fatal("invalid proxy accepted")
		}
	}
	root := t.TempDir()
	path := filepath.Join(root, "config.json")
	data := []byte(`{"auth":{"authorization_proxy":"http://localhost:1234","unknown":{"keep":true}},"gallery":{"migrate_default_auth":false},"server":{"port":8787},"unrelated":[1,2,3]}`)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := SaveBrowserExecutable(context.Background(), path, "/usr/bin/chromium"); err != nil {
		t.Fatal(err)
	}
	settings, err := Load(path, func(string) string { return "" })
	if err != nil || settings.Auth.ChromeExecutable != "/usr/bin/chromium" || settings.Auth.BrowserLoginTimeoutSeconds != 900 || settings.Gallery.MigrateDefaultAuth {
		t.Fatal(settings.Auth, err)
	}
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(stored, &object); err != nil {
		t.Fatal(err)
	}
	if len(object["unrelated"].([]any)) != 3 || object["auth"].(map[string]any)["unknown"].(map[string]any)["keep"] != true {
		t.Fatal("configuration fields lost")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := SaveBrowserExecutable(ctx, path, ""); err == nil {
		t.Fatal("cancelled write accepted")
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(stored) {
		t.Fatal("cancelled write changed configuration")
	}
	link := filepath.Join(root, "symlink.json")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if err := SaveBrowserExecutable(context.Background(), link, ""); err == nil {
		t.Fatal("symlink accepted")
	}
}
