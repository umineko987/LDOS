package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExistingConfigurationAndEnvironment(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"runtime_dir":"runtime","database_path":"runtime/backend.sqlite3","server":{"host":"127.0.0.1","port":8787,"cors_origins":["mygo://localhost"]},"gallery":{"repo_path":"../gallery-dl-codeberg"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"GDL_BACKEND_PORT": "19091", "LDOS_DESKTOP_ORIGIN": "http://localhost:1420"}
	s, err := Load(path, func(key string) string { return env[key] })
	if err != nil {
		t.Fatal(err)
	}
	if s.Server.Address() != "127.0.0.1:19091" {
		t.Fatal(s.Server)
	}
	if s.DatabasePath != filepath.Join(dir, "runtime", "backend.sqlite3") || s.DefaultOutputRoot != filepath.Join(dir, "runtime", "downloads") {
		t.Fatal(s)
	}
	if len(s.Server.CORSOrigins) != 2 || s.Server.CORSOrigins[1] != "http://localhost:1420" {
		t.Fatal(s.Server.CORSOrigins)
	}
	if !s.Server.StrictTargetDNS {
		t.Fatal("DNS validation default lost")
	}
}

func TestInvalidConfigurationDoesNotFallBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	for _, data := range []string{`null`, `[]`, `{`, `{"server":{"host":"0.0.0.0"}}`, `{"server":{"port":0}}`, `{"server":{"port":65536}}`, `{"server":{"cors_origins":["https://evil.example"]}}`} {
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path, func(string) string { return "" }); err == nil {
			t.Errorf("accepted %s", data)
		}
	}
	if _, err := Load(filepath.Join(t.TempDir(), "missing.json"), func(string) string { return "" }); err == nil {
		t.Fatal("missing config accepted")
	}
	if _, err := Load("", func(string) string { return "" }); err == nil {
		t.Fatal("implicit database path accepted")
	}
}

func TestNormalizeOrigin(t *testing.T) {
	for _, raw := range []string{"mygo://localhost", "http://mygo.localhost", "http://localhost:1420", "http://[::1]:1420", "tauri://localhost"} {
		if got, err := NormalizeOrigin(raw); err != nil || got != raw {
			t.Errorf("%s: %s %v", raw, got, err)
		}
	}
	for _, raw := range []string{"*", "null", "https://evil.example", "http://localhost", "http://localhost:0", "http://localhost:65536", "mygo://localhost:123", "mygo://user@localhost", "mygo://localhost/path", "mygo://localhost?", "mygo://localhost#", "mygo://localhost:"} {
		if _, err := NormalizeOrigin(raw); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}
