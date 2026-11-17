package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

const appIdentifier = "dev.ldos.desktop"
const maxConfigBytes = 1024 * 1024

type endpoint struct {
	host string
	port uint16
}

func newEndpoint(host string, port uint64) (endpoint, error) {
	host = strings.ToLower(strings.TrimSpace(host))
	if (host != "127.0.0.1" && host != "localhost" && host != "::1") || port == 0 || port > 65535 {
		return endpoint{}, errors.New("invalid backend endpoint")
	}
	return endpoint{host, uint16(port)}, nil
}

func endpointFromConfig(data []byte, getenv func(string) string) (endpoint, error) {
	if !utf8.Valid(data) {
		return endpoint{}, errors.New("invalid configuration encoding")
	}
	var config map[string]json.RawMessage
	if err := json.Unmarshal(data, &config); err != nil || config == nil {
		return endpoint{}, errors.New("invalid backend configuration")
	}
	var server map[string]json.RawMessage
	if raw, ok := config["server"]; ok {
		if err := json.Unmarshal(raw, &server); err != nil {
			return endpoint{}, err
		}
	}
	host, port := "127.0.0.1", uint64(8787)
	if raw, ok := server["host"]; ok {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return endpoint{}, errors.New("invalid host")
		}
		if err := json.Unmarshal(raw, &host); err != nil {
			return endpoint{}, err
		}
	}
	if raw, ok := server["port"]; ok {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return endpoint{}, errors.New("invalid port")
		}
		if err := json.Unmarshal(raw, &port); err != nil {
			return endpoint{}, err
		}
	}
	// Match the existing host: reject an invalid file before applying overrides.
	if _, err := newEndpoint(host, port); err != nil {
		return endpoint{}, err
	}
	if value := getenv("GDL_BACKEND_HOST"); value != "" {
		host = value
	}
	if value := getenv("GDL_BACKEND_PORT"); value != "" {
		parsed, err := strconv.ParseUint(value, 10, 16)
		if err != nil {
			return endpoint{}, err
		}
		port = parsed
	}
	return newEndpoint(host, port)
}

func (e endpoint) authority() string { return net.JoinHostPort(e.host, strconv.Itoa(int(e.port))) }
func (e endpoint) apiOrigin() string {
	if e.host == "::1" {
		return "http://localhost:" + strconv.Itoa(int(e.port))
	}
	return "http://" + e.authority()
}

func originOf(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Opaque != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("invalid development URL")
	}
	// MYGO_DEV_URL is supplied by mygo from devUrl, so use its real origin.
	return strings.ToLower(u.Scheme + "://" + u.Host), nil
}

func frontendOrigins(development bool, devURL string) (devOrigin, desktopOrigin string, err error) {
	if !development || devURL == "" {
		return "", "mygo://localhost", nil
	}
	origin, err := originOf(devURL)
	return origin, origin, err
}

// Source mode is explicit for production builds; it changes the backend
// location only, never the origin of the embedded frontend.
func usesSourceBackend(development bool, getenv func(string) string) bool {
	return development || getenv("LDOS_DESKTOP_SOURCE") == "1"
}

type launchSpec struct {
	executable, backendDir, executorsDir, configPath, desktopOrigin string
	endpoint                                                        endpoint
	environment                                                     map[string]string
}

func specFromPaths(executable, backendDir, executorsDir, configPath, origin string, environment map[string]string, getenv func(string) string) (launchSpec, error) {
	for _, path := range []string{executable, filepath.Join(executorsDir, "ldos_gallery", "worker_entry.py"), configPath} {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || (path == executable && info.Mode().Perm()&0111 == 0) {
			return launchSpec{}, errors.New("missing backend resource")
		}
	}
	file, err := os.Open(configPath)
	if err != nil {
		return launchSpec{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxConfigBytes+1))
	if err != nil || len(data) > maxConfigBytes {
		return launchSpec{}, errors.New("invalid configuration size")
	}
	ep, err := endpointFromConfig(data, getenv)
	if err != nil {
		return launchSpec{}, err
	}
	return launchSpec{executable, backendDir, executorsDir, configPath, origin, ep, environment}, nil
}

func developmentSpec(projectDir, origin string, getenv func(string) string) (launchSpec, error) {
	backendDir, err := filepath.EvalSymlinks(filepath.Join(projectDir, "..", "gallery-dl-backend"))
	if err != nil {
		return launchSpec{}, err
	}
	configPath := getenv("GDL_BACKEND_CONFIG")
	if configPath == "" {
		configPath = "config.json"
	}
	if !filepath.IsAbs(configPath) {
		configPath = filepath.Join(backendDir, configPath)
	}
	configPath, err = filepath.EvalSymlinks(configPath)
	if err != nil {
		return launchSpec{}, err
	}
	nativeRoot := filepath.Join(projectDir, "..", "backend")
	executable, err := filepath.Abs(filepath.Join(nativeRoot, "build", "ldos-backend"))
	if err != nil {
		return launchSpec{}, err
	}
	executorsDir, err := filepath.Abs(filepath.Join(nativeRoot, "executors"))
	if err != nil {
		return launchSpec{}, err
	}
	environment := map[string]string{}
	if python := getenv("PYTHON"); python != "" {
		// This selects the isolated executors' runtime, never the business server.
		if strings.ContainsRune(python, filepath.Separator) {
			python, err = filepath.Abs(python)
			if err != nil {
				return launchSpec{}, err
			}
		}
		environment["PYTHON"] = python
	}
	return specFromPaths(executable, backendDir, executorsDir, configPath, origin, environment, getenv)
}

func (s launchSpec) command() *exec.Cmd {
	cmd := exec.Command(s.executable, "--config", s.configPath, "--executors-dir", s.executorsDir)
	cmd.Dir = s.backendDir
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	// AppImage Python variables must not override the controlled runtime.
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if key != "PYTHONHOME" && key != "PYTHONPATH" && key != "LDOS_DESKTOP_RESOURCE_ROOT" && key != "LDOS_DESKTOP_DATA_ROOT" && key != "LDOS_DESKTOP_PYTHON" {
			cmd.Env = append(cmd.Env, value)
		}
	}
	env := map[string]string{"GDL_BACKEND_PARENT_PIPE": "1", "LDOS_DESKTOP_DISTRIBUTION": "1", "LDOS_DESKTOP_ORIGIN": s.desktopOrigin}
	for key, value := range s.environment {
		env[key] = value
	}
	for key, value := range env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd
}

// Locate the source checkout from the CLI's working directory or .mygo binary.
func sourceProjectDir() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	exe, _ := os.Executable()
	for _, start := range []string{wd, filepath.Dir(exe)} {
		for dir := start; ; dir = filepath.Dir(dir) {
			if info, err := os.Stat(filepath.Join(dir, "src-mygo")); err == nil && info.IsDir() {
				if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
					return dir, nil
				}
			}
			if next := filepath.Dir(dir); next == dir {
				break
			}
		}
	}
	return "", fmt.Errorf("desktop source directory unavailable")
}

func validEnvironment() error {
	for _, key := range []string{"PYTHON", "GDL_BACKEND_CONFIG", "GDL_BACKEND_HOST", "GDL_BACKEND_PORT", "MYGO_DEV_URL"} {
		if !utf8.ValidString(os.Getenv(key)) {
			return errors.New("invalid environment encoding")
		}
	}
	return nil
}
