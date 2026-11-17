package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type applicationPaths struct{ config, data, cache string }

// Tauri used the identifier, not the product name, for these Linux paths.
// Do not adopt mygo's ~/.config/LDOS default and silently open an empty library.
func linuxPaths(getenv func(string) string, home string) (applicationPaths, error) {
	if home == "" {
		return applicationPaths{}, errors.New("home directory unavailable")
	}
	root := func(key, fallback string) string {
		if path := getenv(key); filepath.IsAbs(path) {
			return path
		}
		return filepath.Join(home, fallback)
	}
	return applicationPaths{
		filepath.Join(root("XDG_CONFIG_HOME", ".config"), appIdentifier),
		filepath.Join(root("XDG_DATA_HOME", ".local/share"), appIdentifier),
		filepath.Join(root("XDG_CACHE_HOME", ".cache"), appIdentifier),
	}, nil
}

func packagedBackendRoot(resourceDir string) string {
	standard := filepath.Join(resourceDir, "backend")
	if isFile(filepath.Join(standard, "release-manifest.json")) {
		return standard
	}
	// Preserve the former AppImage resource layout as well.
	appimage := filepath.Join(filepath.Dir(filepath.Dir(resourceDir)), "share", "LDOS", "backend")
	if isFile(filepath.Join(appimage, "release-manifest.json")) {
		return appimage
	}
	return standard
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func packagedSpec(resourceDir string, paths applicationPaths, origin string, getenv func(string) string) (launchSpec, error) {
	backendRoot := packagedBackendRoot(resourceDir)
	appRoot := filepath.Join(backendRoot, "app")
	python := filepath.Join(backendRoot, "runtime", "python", "bin", "python3.13")
	for _, path := range []string{
		python, filepath.Join(backendRoot, "bin", "ldos-backend"), filepath.Join(appRoot, "executors", "ldos_gallery", "worker_entry.py"),
		filepath.Join(appRoot, "gallery-dl-codeberg", "gallery_dl", "__init__.py"),
		filepath.Join(appRoot, "dedup_review_worker.py"), filepath.Join(appRoot, "dedup_core.py"),
		filepath.Join(backendRoot, "release-manifest.json"),
	} {
		if !isFile(path) {
			return launchSpec{}, errors.New("packaged backend resource unavailable")
		}
	}
	for _, path := range []string{paths.config, paths.data} {
		if err := os.MkdirAll(path, 0700); err != nil {
			return launchSpec{}, err
		}
		if err := os.Chmod(path, 0700); err != nil {
			return launchSpec{}, err
		}
	}
	configPath := filepath.Join(paths.config, "backend.json")
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		if err := writeInitialConfig(configPath, appRoot, paths.data, python); err != nil {
			return launchSpec{}, err
		}
	} else if err != nil {
		return launchSpec{}, err
	}
	return specFromPaths(filepath.Join(backendRoot, "bin", "ldos-backend"), appRoot, filepath.Join(appRoot, "executors"), configPath, origin, map[string]string{
		"LDOS_DESKTOP_RESOURCE_ROOT": backendRoot,
		"LDOS_DESKTOP_DATA_ROOT":     paths.data,
		"LDOS_DESKTOP_PYTHON":        python,
		"PYTHON":                     python,
	}, getenv)
}

func writeInitialConfig(configPath, appRoot, dataRoot, python string) error {
	runtimeDir := filepath.Join(dataRoot, "runtime")
	outputDir := filepath.Join(dataRoot, "downloads")
	credentialsDir := filepath.Join(dataRoot, "credentials")
	config := map[string]any{
		"runtime_dir":          runtimeDir,
		"database_path":        filepath.Join(runtimeDir, "backend.sqlite3"),
		"default_output_root":  outputDir,
		"allowed_output_roots": []string{outputDir},
		"allowed_config_roots": []string{credentialsDir},
		"allowed_cookie_roots": []string{credentialsDir},
		"server":               map[string]any{"host": "127.0.0.1", "port": 8787, "cors_origins": []string{"mygo://localhost"}, "allow_private_targets": false, "strict_target_dns": true},
		"gallery":              map[string]any{"repo_path": filepath.Join(appRoot, "gallery-dl-codeberg"), "cache_file": filepath.Join(credentialsDir, "managed", "gallery-dl-cache.sqlite3"), "python_executable": python, "migrate_default_auth": false},
		"auth":                 map[string]any{"chrome_executable": "", "authorization_proxy": ""},
		"proxy":                map[string]any{"enabled": false, "auto_start": false, "engine": "native", "subscription_urls": []string{}, "inline_nodes": []string{}, "allowed_node_roots": []string{filepath.Join(dataRoot, "subscriptions")}, "transport_core_enabled": false},
		"dedup":                map[string]any{"enabled": false, "python_executable": python, "worker_script": filepath.Join(appRoot, "dedup_review_worker.py"), "core_script": filepath.Join(appRoot, "dedup_core.py"), "atlas_script": filepath.Join(appRoot, "atlas_worker.py"), "model_dir": filepath.Join(dataRoot, "models"), "device": "auto"},
		"tagger":               map[string]any{"enabled": true, "python_executable": python, "cli_script": filepath.Join(appRoot, "tagger", "cli.py"), "model_dir": filepath.Join(dataRoot, "tagger", "models"), "cache_path": filepath.Join(dataRoot, "tagger", "tags.sqlite3")},
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(configPath), ".backend-config-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(append(data, '\n')); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), configPath)
}
