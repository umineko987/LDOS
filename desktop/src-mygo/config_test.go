package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func noEnv(string) string { return "" }
func mapEnv(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}
func fixtureFile(t *testing.T, path, value string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(value), mode); err != nil {
		t.Fatal(err)
	}
}

func TestEndpointContract(t *testing.T) {
	for _, test := range []struct{ data, origin string }{
		{`{}`, "http://127.0.0.1:8787"},
		{`{"server":null}`, "http://127.0.0.1:8787"},
		{`{"server":{"host":" LOCALHOST ","port":9123},"auth":{"token":"private"}}`, "http://localhost:9123"},
		{`{"server":{"host":"::1","port":9123}}`, "http://localhost:9123"},
	} {
		ep, err := endpointFromConfig([]byte(test.data), noEnv)
		if err != nil || ep.apiOrigin() != test.origin {
			t.Fatalf("%s: %v, %v", test.data, ep, err)
		}
	}
	for _, data := range []string{"{\"extra\":\"\xff\"}", `null`, `[]`, `{"server":[]}`, `{"server":{"host":null}}`, `{"server":{"host":"0.0.0.0"}}`, `{"server":{"host":"evil.example"}}`, `{"server":{"port":null}}`, `{"server":{"port":0}}`, `{"server":{"port":65536}}`, `{"server":{"port":1.5}}`, `{"server":{"port":"8787"}}`} {
		if _, err := endpointFromConfig([]byte(data), noEnv); err == nil {
			t.Errorf("accepted %s", data)
		}
	}
	ep, err := endpointFromConfig([]byte(`{}`), mapEnv(map[string]string{"GDL_BACKEND_HOST": "::1", "GDL_BACKEND_PORT": "9124"}))
	if err != nil || ep.authority() != "[::1]:9124" {
		t.Fatal(ep, err)
	}
	for _, port := range []string{"0", "65536", "-1", " 8787"} {
		if _, err := endpointFromConfig([]byte(`{}`), mapEnv(map[string]string{"GDL_BACKEND_PORT": port})); err == nil {
			t.Errorf("accepted port %q", port)
		}
	}
	if _, err := endpointFromConfig([]byte(`{"server":{"port":0}}`), mapEnv(map[string]string{"GDL_BACKEND_PORT": "8787"})); err == nil {
		t.Fatal("environment rescued invalid file")
	}
}

func TestProductionSourceModeIsExplicitAndKeepsEmbeddedOrigin(t *testing.T) {
	for _, test := range []struct {
		development bool
		flag        string
		want        bool
	}{{true, "", true}, {false, "", false}, {false, "1", true}, {false, "true", false}, {false, "0", false}} {
		if got := usesSourceBackend(test.development, mapEnv(map[string]string{"LDOS_DESKTOP_SOURCE": test.flag})); got != test.want {
			t.Fatal(test, got)
		}
	}
	root := t.TempDir()
	backend := filepath.Join(root, "gallery-dl-backend")
	fixtureFile(t, filepath.Join(root, "backend/build/ldos-backend"), "#!/bin/sh\nexit 0\n", 0700)
	fixtureFile(t, filepath.Join(root, "backend/executors/ldos_gallery/worker_entry.py"), "", 0600)
	fixtureFile(t, filepath.Join(backend, "config.json"), `{}`, 0600)
	config := filepath.Join(root, "isolated.json")
	fixtureFile(t, config, `{}`, 0600)
	devOrigin, desktopOrigin, err := frontendOrigins(false, "http://localhost:1421/development-only")
	if err != nil || devOrigin != "" || desktopOrigin != "mygo://localhost" {
		t.Fatal(devOrigin, desktopOrigin, err)
	}
	spec, err := developmentSpec(filepath.Join(root, "desktop"), desktopOrigin, mapEnv(map[string]string{"GDL_BACKEND_CONFIG": config}))
	if err != nil {
		t.Fatal(err)
	}
	if spec.desktopOrigin != "mygo://localhost" || spec.configPath != config {
		t.Fatal(spec)
	}
}

func TestDevelopmentConfigLookupAndLaunchCommand(t *testing.T) {
	root := t.TempDir()
	project, backend := filepath.Join(root, "desktop"), filepath.Join(root, "gallery-dl-backend")
	executable := filepath.Join(root, "backend", "build", "ldos-backend")
	executors := filepath.Join(root, "backend", "executors")
	python := filepath.Join(root, "executor-python")
	fixtureFile(t, executable, "#!/bin/sh\nexit 0\n", 0700)
	fixtureFile(t, filepath.Join(executors, "ldos_gallery", "worker_entry.py"), "", 0600)
	config := filepath.Join(backend, "isolated", "config.json")
	fixtureFile(t, config, `{"server":{"port":9234}}`, 0600)
	spec, err := developmentSpec(project, "http://localhost:1421", mapEnv(map[string]string{"GDL_BACKEND_CONFIG": "isolated/config.json", "PYTHON": python}))
	if err != nil {
		t.Fatal(err)
	}
	if spec.configPath != config || spec.backendDir != backend || spec.executable != executable || spec.executorsDir != executors {
		t.Fatalf("unexpected spec: %+v", spec)
	}
	t.Setenv("PYTHONHOME", "wrong-home")
	t.Setenv("PYTHONPATH", "wrong-path")
	t.Setenv("LDOS_DESKTOP_ORIGIN", "https://evil.example")
	t.Setenv("LDOS_DESKTOP_PYTHON", "/stale/runtime/python")
	t.Setenv("LDOS_DESKTOP_RESOURCE_ROOT", "/stale/resources")
	t.Setenv("LDOS_DESKTOP_DATA_ROOT", "/stale/data")
	cmd := spec.command()
	if !reflect.DeepEqual(cmd.Args, []string{executable, "--config", config, "--executors-dir", executors}) || cmd.Dir != backend {
		t.Fatal(cmd.Args, cmd.Dir)
	}
	env := map[string]string{}
	for _, entry := range cmd.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		env[key] = value
	}
	if env["PYTHONHOME"] != "" || env["PYTHONPATH"] != "" {
		t.Fatal("inherited Python import override")
	}
	for key, value := range map[string]string{"GDL_BACKEND_PARENT_PIPE": "1", "LDOS_DESKTOP_DISTRIBUTION": "1", "LDOS_DESKTOP_ORIGIN": "http://localhost:1421", "PYTHON": python, "LDOS_DESKTOP_PYTHON": "", "LDOS_DESKTOP_RESOURCE_ROOT": "", "LDOS_DESKTOP_DATA_ROOT": ""} {
		if env[key] != value {
			t.Errorf("%s=%q", key, env[key])
		}
	}
	if _, err := developmentSpec(project, "mygo://localhost", noEnv); err == nil {
		t.Fatal("accepted missing default config")
	}
	fixtureFile(t, config, strings.Repeat(" ", maxConfigBytes+1), 0600)
	if _, err := developmentSpec(project, "mygo://localhost", mapEnv(map[string]string{"GDL_BACKEND_CONFIG": config})); err == nil {
		t.Fatal("accepted oversized config")
	}
}

func TestLinuxPathsAndPackagedConfigPreserveExistingData(t *testing.T) {
	root := t.TempDir()
	paths, err := linuxPaths(mapEnv(map[string]string{"XDG_CONFIG_HOME": filepath.Join(root, "config"), "XDG_DATA_HOME": filepath.Join(root, "data"), "XDG_CACHE_HOME": filepath.Join(root, "cache")}), root)
	if err != nil {
		t.Fatal(err)
	}
	if paths.config != filepath.Join(root, "config", appIdentifier) || paths.data != filepath.Join(root, "data", appIdentifier) {
		t.Fatal(paths)
	}
	fallback, _ := linuxPaths(mapEnv(map[string]string{"XDG_DATA_HOME": "relative-is-invalid"}), root)
	if fallback.data != filepath.Join(root, ".local/share", appIdentifier) {
		t.Fatal(fallback)
	}
	resourceDir := filepath.Join(root, "resources")
	backendRoot := filepath.Join(resourceDir, "backend")
	for _, rel := range []string{"runtime/python/bin/python3.13", "bin/ldos-backend", "app/executors/ldos_gallery/worker_entry.py", "app/gallery-dl-codeberg/gallery_dl/__init__.py", "app/dedup_review_worker.py", "app/dedup_core.py", "release-manifest.json"} {
		fixtureFile(t, filepath.Join(backendRoot, rel), "", 0700)
	}
	spec, err := packagedSpec(resourceDir, paths, "mygo://localhost", noEnv)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(paths.config, "backend.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	if config["database_path"] != filepath.Join(paths.data, "runtime/backend.sqlite3") {
		t.Fatal(config["database_path"])
	}
	if got := config["server"].(map[string]any)["cors_origins"]; !reflect.DeepEqual(got, []any{"mygo://localhost"}) {
		t.Fatal(got)
	}
	info, _ := os.Stat(configPath)
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
	for _, path := range []string{paths.config, paths.data} {
		info, _ := os.Stat(path)
		if info.Mode().Perm() != 0700 {
			t.Fatal(info.Mode())
		}
	}
	if spec.environment["LDOS_DESKTOP_DATA_ROOT"] != paths.data {
		t.Fatal(spec.environment)
	}
	original := `{"server":{"port":9999},"auth":{"token":"keep-existing"}}`
	fixtureFile(t, configPath, original, 0600)
	spec, err = packagedSpec(resourceDir, paths, "mygo://localhost", noEnv)
	if err != nil || spec.endpoint.port != 9999 {
		t.Fatal(spec, err)
	}
	data, _ = os.ReadFile(configPath)
	if string(data) != original {
		t.Fatal("rewrote existing user config")
	}
}

func TestNavigationUsesExactConfiguredOrigins(t *testing.T) {
	dev, err := originOf("http://localhost:1421/nested?x=1")
	if err != nil || dev != "http://localhost:1421" {
		t.Fatal(dev, err)
	}
	for _, raw := range []string{"mygo://localhost/", "mygo://localhost/assets/app.js", "http://localhost:1421/#/settings"} {
		if !allowedNavigation(raw, dev) {
			t.Error("rejected", raw)
		}
	}
	for _, raw := range []string{"mygo://evil.example/", "mygo://localhost:80/", "mygo://user@localhost/", "http://localhost:1420/", "http://localhost:1421.evil/", "http://127.0.0.1:8787/healthz", "file:///tmp/private", "javascript:alert(1)", "https://example.com/"} {
		if allowedNavigation(raw, dev) {
			t.Error("allowed", raw)
		}
	}
	if allowedNavigation("http://localhost:1421/", "") {
		t.Fatal("production allowed dev URL")
	}
	for _, raw := range []string{"file:///tmp/private", "javascript:alert(1)", "mailto:x@y.example", "https://user:secret@example.com/"} {
		if externalHTTP(raw) {
			t.Error("external opener allowed", raw)
		}
	}
}
