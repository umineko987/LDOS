//go:build linux

package authbrowser

import (
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

func BrowserName(path string) string {
	normalized := strings.ToLower(strings.ReplaceAll(path, "\\", "/"))
	name := filepath.Base(normalized)
	switch name {
	case "firefox", "firefox-esr", "firefox-bin":
		return "Firefox"
	case "msedge", "microsoft-edge", "microsoft-edge-stable", "microsoft edge":
		return "Microsoft Edge"
	case "chromium", "chromium-browser":
		return "Chromium"
	case "chrome", "google-chrome", "google-chrome-stable", "google chrome":
		return "Google Chrome"
	}
	switch {
	case strings.Contains(normalized, "/microsoft/edge/"):
		return "Microsoft Edge"
	case strings.Contains(normalized, "/chromium/"):
		return "Chromium"
	case strings.Contains(normalized, "/google/chrome/"):
		return "Google Chrome"
	}
	return ""
}

// Discover honors an explicit/configured executable without falling back to another browser.
func Discover(explicit string) (path, name string, err error) {
	configured := strings.TrimSpace(explicit)
	if configured == "" {
		configured = strings.TrimSpace(os.Getenv("GDL_BACKEND_CHROME"))
	}
	var candidates []string
	if configured != "" {
		configured = os.ExpandEnv(configured)
		if configured == "~" || strings.HasPrefix(configured, "~/") {
			home, e := os.UserHomeDir()
			if e != nil {
				return "", "", ErrNotFound
			}
			if configured == "~" {
				configured = home
			} else {
				configured = filepath.Join(home, strings.TrimPrefix(configured, "~/"))
			}
		}
		candidates = []string{configured}
	} else {
		for _, candidate := range []string{"chrome", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"} {
			if found, e := exec.LookPath(candidate); e == nil {
				candidates = append(candidates, found)
			}
		}
		for _, candidate := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"} {
			candidates = append(candidates, filepath.Join("/usr/bin", candidate))
		}
		// Keep the existing Chromium-family candidates ahead of Firefox.
		for _, name := range []string{"firefox", "firefox-esr"} {
			if path, err := exec.LookPath(name); err == nil {
				candidates = append(candidates, path)
			}
			candidates = append(candidates, filepath.Join("/usr/bin", name))
		}
	}
	for _, candidate := range candidates {
		resolved, e := filepath.EvalSymlinks(candidate)
		if e != nil {
			continue
		}
		resolved, e = filepath.Abs(resolved)
		if e != nil {
			continue
		}
		info, e := os.Stat(resolved)
		if e == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
			// A distribution launcher may dispatch on argv[0] (e.g. a snap symlink).
			if BrowserName(candidate) == "Firefox" && BrowserName(resolved) != "Firefox" {
				path, e := filepath.Abs(candidate)
				return path, "Firefox", e
			}
			return resolved, BrowserName(resolved), nil
		}
	}
	return "", "", ErrNotFound
}

func chromeProxy(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || u.Opaque != "" {
		return "", ErrProxy
	}
	scheme := strings.ToLower(u.Scheme)
	switch scheme {
	case "socks5h":
		scheme = "socks5"
	case "socks4a":
		scheme = "socks4"
	case "http", "https", "socks4", "socks5":
	default:
		return "", ErrProxy
	}
	host := u.Hostname()
	if strings.ContainsAny(host, "\t\r\n ;,/") {
		return "", ErrProxy
	}
	if port := u.Port(); port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 {
			return "", ErrProxy
		}
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return scheme + "://" + host, nil
}
