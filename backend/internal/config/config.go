// Package config loads the existing JSON configuration without running Python.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const MaxBytes = 1024 * 1024

type Server struct {
	Host                string   `json:"host"`
	Port                int      `json:"port"`
	CORSOrigins         []string `json:"cors_origins"`
	AllowPrivateTargets bool     `json:"allow_private_targets"`
	StrictTargetDNS     bool     `json:"strict_target_dns"`
}

type Settings struct {
	Path               string         `json:"-"`
	ProjectDir         string         `json:"project_dir"`
	Gallery            Gallery        `json:"gallery"`
	Auth               Auth           `json:"auth"`
	Dedup              Dedup          `json:"dedup"`
	Tagger             Tagger         `json:"tagger"`
	WorkspaceDir       string         `json:"workspace_dir"`
	Scheduler          Scheduler      `json:"scheduler"`
	Proxy              Proxy          `json:"proxy"`
	EncryptedDNS       EncryptedDNS   `json:"encrypted_dns"`
	RuntimeDir         string         `json:"runtime_dir"`
	DatabasePath       string         `json:"database_path"`
	DefaultOutputRoot  string         `json:"default_output_root"`
	AllowedOutputRoots []string       `json:"allowed_output_roots"`
	AllowedConfigRoots []string       `json:"allowed_config_roots"`
	AllowedCookieRoots []string       `json:"allowed_cookie_roots"`
	Server             Server         `json:"server"`
	DefaultSitePolicy  map[string]any `json:"default_site_policy"`
}

// Load requires an explicit configuration file. It never rewrites configuration
// or silently starts against an unrelated empty database when a path is wrong.
func Load(path string, getenv func(string) string) (Settings, error) {
	var s Settings
	if path == "" {
		path = getenv("GDL_BACKEND_CONFIG")
	}
	if path == "" {
		return s, errors.New("--config or GDL_BACKEND_CONFIG is required")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return s, err
	}
	f, err := os.Open(abs)
	if err != nil {
		return s, fmt.Errorf("open configuration: %w", err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxBytes+1))
	if err != nil {
		return s, err
	}
	if len(data) > MaxBytes || !utf8.Valid(data) {
		return s, errors.New("configuration must be UTF-8 JSON up to 1 MiB")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil || object == nil {
		return s, errors.New("configuration must be a JSON object")
	}
	s.Server = Server{Host: "127.0.0.1", Port: 8787, StrictTargetDNS: true}
	s.DefaultSitePolicy = map[string]any{"max_concurrency": 20, "retry_limit": 2, "backoff_base_seconds": 2.0, "proxy_mode": "prefer"}
	s.executionDefaults()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&s); err != nil {
		return Settings{}, errors.New("invalid configuration field type")
	}
	if err := s.applyDesktopPaths(getenv); err != nil {
		return Settings{}, err
	}
	if err := validateEndpoint(s.Server); err != nil {
		return Settings{}, err
	}
	if host := getenv("GDL_BACKEND_HOST"); host != "" {
		s.Server.Host = host
	}
	if port := getenv("GDL_BACKEND_PORT"); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil {
			return Settings{}, errors.New("invalid GDL_BACKEND_PORT")
		}
		s.Server.Port = n
	}
	if err := validateEndpoint(s.Server); err != nil {
		return Settings{}, err
	}
	s.Server.Host = strings.ToLower(strings.TrimSpace(s.Server.Host))
	origins := append([]string(nil), s.Server.CORSOrigins...)
	if origin := getenv("LDOS_DESKTOP_ORIGIN"); origin != "" {
		origins = append(origins, origin)
	}
	s.Server.CORSOrigins = []string{}
	seen := map[string]bool{}
	for _, raw := range origins {
		origin, err := NormalizeOrigin(raw)
		if err != nil {
			return Settings{}, err
		}
		if !seen[origin] {
			seen[origin] = true
			s.Server.CORSOrigins = append(s.Server.CORSOrigins, origin)
		}
	}
	s.Path = abs
	base := filepath.Dir(abs)
	s.RuntimeDir = resolve(base, s.RuntimeDir, filepath.Join(base, "runtime"))
	s.DatabasePath = resolve(base, s.DatabasePath, filepath.Join(s.RuntimeDir, "backend.sqlite3"))
	s.DefaultOutputRoot = resolve(base, s.DefaultOutputRoot, filepath.Join(s.RuntimeDir, "downloads"))
	s.AllowedOutputRoots = resolveRoots(base, s.AllowedOutputRoots, s.DefaultOutputRoot)
	s.AllowedConfigRoots = resolveRoots(base, s.AllowedConfigRoots, filepath.Join(base, "credentials"))
	s.AllowedCookieRoots = resolveRoots(base, s.AllowedCookieRoots, filepath.Join(base, "credentials"))
	s.executionPaths(base, getenv)
	if err := s.normalizeExecution(); err != nil {
		return Settings{}, err
	}
	return s, nil
}

func validateEndpoint(s Server) error {
	host := strings.ToLower(strings.TrimSpace(s.Host))
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return errors.New("server.host must be a loopback address")
	}
	if s.Port < 1 || s.Port > 65535 {
		return errors.New("server.port must be between 1 and 65535")
	}
	return nil
}

func (s Server) Address() string { return net.JoinHostPort(s.Host, strconv.Itoa(s.Port)) }

var environmentVariable = regexp.MustCompile(`\$\w+|\$\{[^}]*\}`)

func expandPath(path string) string {
	path = environmentVariable.ReplaceAllStringFunc(path, func(token string) string {
		key := strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(token, "$"), "{"), "}")
		if value, ok := os.LookupEnv(key); ok {
			return value
		}
		return token
	})
	if path == "~" || strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			if path == "~" {
				return home
			}
			return filepath.Join(home, strings.TrimPrefix(path, "~/"))
		}
	}
	return path
}

func resolve(base, path, fallback string) string {
	if path == "" {
		return filepath.Clean(fallback)
	}
	path = expandPath(path)
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Join(base, path)
}

func resolveRoots(base string, paths []string, fallback string) []string {
	resolved := []string{}
	for _, path := range paths {
		if strings.TrimSpace(path) != "" {
			resolved = append(resolved, resolve(base, path, base))
		}
	}
	if len(resolved) == 0 {
		return []string{fallback}
	}
	return resolved
}

// NormalizeOrigin keeps existing desktop configuration readable while accepting
// no wildcard origins, credentials, paths, remote hosts, or opaque URLs.
func NormalizeOrigin(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	u, err := url.Parse(value)
	invalid := errors.New("server.cors_origins requires exact desktop or loopback development origins")
	if err != nil || value == "" || len(value) > 256 {
		return "", invalid
	}
	if u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(value, "#") || u.Opaque != "" {
		return "", invalid
	}
	scheme, host := strings.ToLower(u.Scheme), strings.ToLower(u.Hostname())
	port := u.Port()
	desktop := ((scheme == "mygo" || scheme == "tauri") && host == "localhost" && port == "") || (scheme == "http" && host == "mygo.localhost" && port == "") || ((scheme == "http" || scheme == "https") && host == "tauri.localhost" && port == "")
	development := scheme == "http" && (host == "127.0.0.1" || host == "localhost" || host == "::1") && port != ""
	if !desktop && !development {
		return "", invalid
	}
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", invalid
		}
		return scheme + "://" + net.JoinHostPort(host, strconv.Itoa(n)), nil
	}
	if strings.HasSuffix(u.Host, ":") {
		return "", invalid
	}
	return scheme + "://" + host, nil
}
