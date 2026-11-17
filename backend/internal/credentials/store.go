// Package credentials owns private managed cookie exports and authorization metadata.
package credentials

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var (
	// Errors deliberately contain neither paths nor credential/worker contents.
	ErrUnsafePath      = errors.New("credentials: unsafe managed path")
	ErrStorage         = errors.New("credentials: private storage unavailable")
	ErrInvalidMetadata = errors.New("credentials: invalid metadata")
)

const metadataName = "auth-metadata.json"

// Store owns only managedDir, its two cookie exports, and auth-metadata.json.
// Operations are safe for concurrent callers and cooperating Store instances.
// No persistent file descriptors are retained; no Close is needed.
type Store struct {
	managedDir string
}

// New takes the managed directory itself (allowed_cookie_roots[0]/managed),
// not the cookie root. It creates missing directories privately and tightens
// existing managed directory/files to 0700/0600 without following symlinks.
func New(managedDir string) (*Store, error) {
	if managedDir == "" {
		return nil, ErrUnsafePath
	}
	dir, err := filepath.Abs(managedDir)
	if err != nil || dir == string(filepath.Separator) {
		return nil, ErrUnsafePath
	}
	if _, followedLink, err := resolveSupplied(managedDir); err != nil || followedLink {
		return nil, ErrUnsafePath
	}
	root, err := openManagedDir(dir, true)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	for _, name := range []string{metadataName, cookieName("twitter"), cookieName("exhentai")} {
		f, err := openPrivateFile(root, name)
		if err != nil {
			return nil, err
		}
		if f != nil {
			f.Close()
		}
	}
	return &Store{managedDir: dir}, nil
}

// CookiesFor returns an absolute path only for a valid, non-invalidated
// Twitter/EH cookie export. Missing or malformed cookies and unsupported sites
// return an empty path. Storage/security failures and corrupt metadata error.
func (s *Store) CookiesFor(ctx context.Context, site string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	site = normalizeSite(site)
	if !managedSite(site) {
		return "", nil
	}
	root, err := s.open(ctx)
	if err != nil {
		return "", err
	}
	defer root.Close()
	valid, err := cookiesValid(ctx, root, site)
	if err != nil || !valid {
		return "", err
	}
	metadata, err := readMetadata(ctx, root)
	if err != nil {
		return "", err
	}
	if invalidated(metadata[site]) {
		return "", nil
	}
	return filepath.Join(s.managedDir, cookieName(site)), nil
}

// Available gates only a supplied cookie path owned by this store and site.
// Empty paths, unsupported sites and external files pass through untouched;
// this is not a general validator of caller-supplied credentials.
func (s *Store) Available(ctx context.Context, site, cookiesFile string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	site = normalizeSite(site)
	managed, err := s.matches(site, cookiesFile)
	if err != nil {
		return false, err
	}
	if !managed {
		return true, nil
	}
	path, err := s.CookiesFor(ctx, site)
	return path != "", err
}

// Invalidate records only the fact of a managed credential failure. The caller
// classifies authentication failures; unrelated failures must not be sent here.
// Known access/content restrictions are explicitly excluded. Raw messages are
// never persisted or included in errors. Other metadata fields are preserved.
func (s *Store) Invalidate(ctx context.Context, site, cookiesFile, message string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	site = normalizeSite(site)
	managed, err := s.matches(site, cookiesFile)
	if err != nil || !managed {
		return false, err
	}
	lower := strings.ToLower(message)
	for _, marker := range []string{
		"tweets are protected",
		"has blocked your account",
		"blocked your account",
		"insufficient privileges to access this endpoint",
		"temporarily banned",
		"gallery not available",
	} {
		if strings.Contains(lower, marker) {
			return false, nil
		}
	}
	root, err := s.open(ctx)
	if err != nil {
		return false, err
	}
	defer root.Close()
	// Even an absent/invalid cookie can be invalidated, but a managed symlink
	// must never be accepted just because this operation only writes metadata.
	f, err := openPrivateFile(root, cookieName(site))
	if err != nil {
		return false, err
	}
	if f != nil {
		f.Close()
	}
	metadata, err := readMetadata(ctx, root)
	if err != nil {
		return false, err
	}
	fields := siteFields(metadata[site])
	fields["method"] = json.RawMessage(`"managed_browser"`)
	fields["browser"] = json.RawMessage(`"project_chrome"`)
	fields["invalidated_at"], _ = json.Marshal(float64(time.Now().UnixNano()) / 1e9)
	fields["invalid_reason"] = json.RawMessage(`"登录凭证失效"`)
	metadata[site], err = json.Marshal(fields)
	if err != nil {
		return false, ErrInvalidMetadata
	}
	if err := writeMetadata(ctx, root, metadata); err != nil {
		return false, err
	}
	return true, nil
}

func normalizeSite(site string) string {
	switch site = strings.ToLower(strings.TrimFunc(site, pythonSpace)); site {
	case "x":
		return "twitter"
	case "eh", "e-hentai":
		return "exhentai"
	default:
		return site
	}
}

func managedSite(site string) bool  { return site == "twitter" || site == "exhentai" }
func cookieName(site string) string { return site + ".cookies.txt" }

func (s *Store) matches(site, supplied string) (bool, error) {
	if !managedSite(site) || supplied == "" {
		return false, nil
	}
	expected := filepath.Join(s.managedDir, cookieName(site))
	abs, err := filepath.Abs(supplied)
	if err != nil {
		return false, nil
	}
	resolved, followedLink, err := resolveSupplied(supplied)
	if abs == expected && (err != nil || resolved != expected || followedLink) {
		return false, ErrUnsafePath
	}
	if err != nil || resolved != expected {
		return false, nil // External paths are not this store's responsibility.
	}
	if followedLink {
		return false, ErrUnsafePath // An alias must not bypass managed validation.
	}
	return true, nil
}

// Path.resolve(strict=False) follows symlinks even when the final target does
// not exist and handles '..' after (not before) links. Only path metadata is
// inspected; no external cookie contents or permissions are touched.
func resolveSupplied(path string) (string, bool, error) {
	if !filepath.IsAbs(path) {
		wd, err := os.Getwd()
		if err != nil {
			return "", false, err
		}
		path = wd + string(filepath.Separator) + path
	}
	pending := strings.Split(path, string(filepath.Separator))
	current := string(filepath.Separator)
	links := 0
	for len(pending) != 0 {
		part := pending[0]
		pending = pending[1:]
		switch part {
		case "", ".":
			continue
		case "..":
			current = filepath.Dir(current)
			continue
		}
		candidate := filepath.Join(current, part)
		info, err := os.Lstat(candidate)
		if errors.Is(err, os.ErrNotExist) {
			current = candidate
			continue
		}
		if err != nil {
			return "", links != 0, err
		}
		if info.Mode()&os.ModeSymlink == 0 {
			current = candidate
			continue
		}
		links++
		if links > 40 {
			return "", true, ErrUnsafePath
		}
		target, err := os.Readlink(candidate)
		if err != nil {
			return "", true, err
		}
		if filepath.IsAbs(target) {
			current = string(filepath.Separator)
		}
		pending = append(strings.Split(target, string(filepath.Separator)), pending...)
	}
	return current, links != 0, nil
}

func siteFields(raw json.RawMessage) map[string]json.RawMessage {
	var fields map[string]json.RawMessage
	// Python treats a non-object per-site value as an empty metadata object.
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return make(map[string]json.RawMessage)
	}
	return fields
}

func invalidated(raw json.RawMessage) bool {
	value := siteFields(raw)["invalidated_at"]
	if len(value) == 0 {
		return false
	}
	decoder := json.NewDecoder(strings.NewReader(string(value)))
	decoder.UseNumber()
	var decoded any
	if decoder.Decode(&decoded) != nil {
		return false // Only previously validated JSON reaches this helper.
	}
	switch v := decoded.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case []any:
		return len(v) != 0
	case map[string]any:
		return len(v) != 0
	case json.Number:
		if strings.ContainsAny(string(v), ".eE") {
			f, _ := v.Float64()
			return f != 0
		}
		return strings.TrimLeft(string(v), "-0") != ""
	}
	return false
}
