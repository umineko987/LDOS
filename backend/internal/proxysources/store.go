package proxysources

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

// Store serializes mutations and freezes its configuration baseline at New.
// A runtime override is always complete, including an explicitly empty one.
type Store struct {
	mu                             sync.Mutex
	baseline                       Snapshot
	path, projectDir, workspaceDir string
	allowedRoots                   []string
	lastFailure                    string
}

func New(settings Settings, runtimeDir, projectDir string) (*Store, error) {
	runtimeDir, err := filepath.Abs(runtimeDir)
	if err != nil {
		return nil, managedForbidden("managed_path_forbidden")
	}
	if projectDir == "" {
		projectDir = filepath.Dir(runtimeDir)
	}
	projectDir, err = filepath.Abs(projectDir)
	if err != nil {
		return nil, managedForbidden("managed_path_forbidden")
	}
	roots := make([]string, 0, len(settings.AllowedNodeRoots))
	for _, root := range settings.AllowedNodeRoots {
		absolute, err := filepath.Abs(root)
		if err != nil {
			return nil, forbidden("outside_allowed_roots")
		}
		roots = append(roots, absolute)
	}
	path := filepath.Join(runtimeDir, "proxy", managedFilename)
	dir, err := openDirectory(filepath.Dir(path), true)
	if err != nil {
		return nil, managedForbidden("managed_path_forbidden")
	}
	dir.Close()
	store := &Store{baseline: MakeSnapshot(settings), path: path, projectDir: projectDir, workspaceDir: filepath.Dir(projectDir), allowedRoots: roots}
	store.Snapshot()
	return store, nil
}

func (s *Store) Path() string { return s.path }

func (s *Store) fallback(present bool) Snapshot {
	b := s.baseline
	return snapshot(b.SubscriptionURLs, b.NodeFile, b.InlineNodes, b.Source, present, !present)
}

func contentToken(raw []byte, present bool) string {
	if !present {
		return "absent"
	}
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}

func (s *Store) readOverride() ([]byte, bool, error) {
	dir, err := openDirectory(filepath.Dir(s.path), false)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		if errors.Is(err, errSymlink) {
			return nil, true, managedForbidden("managed_path_symlink")
		}
		return nil, true, corrupt("invalid_target")
	}
	defer dir.Close()
	return readManaged(dir)
}

func stringList(raw json.RawMessage) ([]string, bool) {
	if len(raw) == 0 || raw[0] != '[' {
		return nil, false
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return nil, false
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		var value string
		if len(item) == 0 || item[0] != '"' || json.Unmarshal(item, &value) != nil {
			return nil, false
		}
		values = append(values, value)
	}
	return values, true
}

func decodeOverride(raw []byte) (Snapshot, error) {
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return Snapshot{}, corrupt("invalid_json")
	}
	var data map[string]json.RawMessage
	if json.Unmarshal(raw, &data) != nil || len(data) != 5 {
		return Snapshot{}, corrupt("invalid_structure")
	}
	for _, field := range []string{"version", "updated_at", "subscription_urls", "node_file", "inline_nodes"} {
		if _, ok := data[field]; !ok {
			return Snapshot{}, corrupt("invalid_structure")
		}
	}
	if string(data["version"]) != "1" {
		return Snapshot{}, corrupt("unsupported_version")
	}
	var updatedAt json.Number
	if json.Unmarshal(data["updated_at"], &updatedAt) != nil || len(data["updated_at"]) == 0 || data["updated_at"][0] == '"' {
		return Snapshot{}, corrupt("invalid_updated_at")
	}
	updated, err := updatedAt.Float64()
	if err != nil || math.IsNaN(updated) || math.IsInf(updated, 0) || updated < 0 {
		return Snapshot{}, corrupt("invalid_updated_at")
	}
	subscriptions, ok := stringList(data["subscription_urls"])
	if !ok {
		return Snapshot{}, corrupt("invalid_structure")
	}
	nodes, ok := stringList(data["inline_nodes"])
	if !ok {
		return Snapshot{}, corrupt("invalid_structure")
	}
	var nodeFile string
	if string(data["node_file"]) != "null" {
		if data["node_file"][0] != '"' || json.Unmarshal(data["node_file"], &nodeFile) != nil {
			return Snapshot{}, corrupt("invalid_structure")
		}
	}
	subscriptions, err = normalizeSubscriptions(subscriptions)
	if err != nil {
		return Snapshot{}, corrupt("invalid_source_value")
	}
	nodes, err = normalizeInlineNodes(nodes)
	if err != nil {
		return Snapshot{}, corrupt("invalid_source_value")
	}
	if nodeFile != "" {
		if utf8.RuneCountInString(nodeFile) > MaxSourcePathLength || !filepath.IsAbs(nodeFile) {
			return Snapshot{}, corrupt("invalid_node_file_value")
		}
		nodeFile = filepath.Clean(nodeFile)
	}
	// Decoding does not read a node file: an unavailable file is a later source
	// loading/validation error, not corruption of the override document itself.
	return snapshot(subscriptions, nodeFile, nodes, "runtime", true, true), nil
}

func (s *Store) loadLocked(mutation bool) (Snapshot, string, error) {
	raw, present, err := s.readOverride()
	var current Snapshot
	if err == nil && present {
		current, err = decodeOverride(raw)
	}
	if err != nil {
		var sourceError *Error
		errors.As(err, &sourceError)
		if s.lastFailure != sourceError.Reason {
			s.lastFailure = sourceError.Reason
			slog.Warn("托管代理源覆盖无效，已安全回退配置基线", "reason", sourceError.Reason)
		}
		if mutation {
			return Snapshot{}, "invalid", err
		}
		return s.fallback(true), "invalid", nil
	}
	s.lastFailure = ""
	if !present {
		return s.fallback(false), "absent", nil
	}
	return current, contentToken(raw, true), nil
}

func (s *Store) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, _, _ := s.loadLocked(false)
	return current
}

func (s *Store) writeLocked(expectedToken string, current Snapshot) (Snapshot, error) {
	subscriptions, err := normalizeSubscriptions(current.SubscriptionURLs)
	if err != nil {
		return Snapshot{}, err
	}
	nodes, err := normalizeInlineNodes(current.InlineNodes)
	if err != nil {
		return Snapshot{}, err
	}
	if current.NodeFile != "" {
		if _, err := ReadNodeFile(current.NodeFile, nil); err != nil {
			return Snapshot{}, err
		}
	}
	dir, err := openDirectory(filepath.Dir(s.path), true)
	if err != nil {
		return Snapshot{}, conflict()
	}
	defer dir.Close()
	raw, present, err := readManaged(dir)
	if err != nil || contentToken(raw, present) != expectedToken {
		return Snapshot{}, conflict()
	}
	// Keep ensure_ascii=False semantics on disk too: HTML/U+2028 escapes can
	// otherwise expand a valid source set beyond the v1 managed-file byte limit.
	data := []byte(`{"version":1,"updated_at":`)
	data = strconv.AppendInt(data, time.Now().Unix(), 10)
	data = append(data, `,"subscription_urls":`...)
	data = appendStringList(data, subscriptions)
	data = append(data, `,"node_file":`...)
	if current.NodeFile == "" {
		data = append(data, "null"...)
	} else {
		data = appendJSONString(data, current.NodeFile)
	}
	data = append(data, `,"inline_nodes":`...)
	data = appendStringList(data, nodes)
	data = append(data, '}')
	var formatted bytes.Buffer
	// The fixed document contains only JSON strings, integer fields and lists.
	_ = json.Indent(&formatted, data, "", "  ")
	data = append(formatted.Bytes(), '\n')
	if err := writeManaged(dir, data, expectedToken); err != nil {
		var typed *Error
		if errors.As(err, &typed) {
			return Snapshot{}, typed
		}
		return Snapshot{}, storeError("store_error", "write_failed", "无法保存运行时代理源覆盖")
	}
	return snapshot(subscriptions, current.NodeFile, nodes, "runtime", true, true), nil
}

func (s *Store) mutate(change func(*Snapshot) error) (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, token, err := s.loadLocked(true)
	if err != nil {
		return Snapshot{}, err
	}
	if err := change(&current); err != nil {
		return Snapshot{}, err
	}
	return s.writeLocked(token, current)
}

func (s *Store) AddSubscription(value string) (Snapshot, error) {
	return s.mutate(func(current *Snapshot) error {
		normalized, err := normalizeSubscription(value)
		if err == nil {
			current.SubscriptionURLs = append(current.SubscriptionURLs, normalized)
		}
		return err
	})
}

func (s *Store) ReplaceSubscription(id, value string) (Snapshot, error) {
	if err := validateSourceID(id, "sub"); err != nil {
		return Snapshot{}, err
	}
	return s.mutate(func(current *Snapshot) error {
		i, err := findID("sub", id, current.SubscriptionURLs)
		if err != nil {
			return err
		}
		normalized, err := normalizeSubscription(value)
		if err == nil {
			current.SubscriptionURLs[i] = normalized
		}
		return err
	})
}

func (s *Store) DeleteSubscription(id string) (Snapshot, error) {
	if err := validateSourceID(id, "sub"); err != nil {
		return Snapshot{}, err
	}
	return s.mutate(func(current *Snapshot) error {
		i, err := findID("sub", id, current.SubscriptionURLs)
		if err != nil {
			return err
		}
		current.SubscriptionURLs = append(current.SubscriptionURLs[:i], current.SubscriptionURLs[i+1:]...)
		return nil
	})
}

func expandUser(path string) (string, error) {
	if !strings.HasPrefix(path, "~") {
		return path, nil
	}
	name, rest, _ := strings.Cut(path, "/")
	var home string
	if name == "~" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return "", invalid("node_file", "invalid_path", nil)
		}
	} else {
		account, err := user.Lookup(name[1:])
		if err != nil {
			return "", invalid("node_file", "invalid_path", nil)
		}
		home = account.HomeDir
	}
	return filepath.Join(home, rest), nil
}

func (s *Store) SetNodeFile(value string) (Snapshot, error) {
	return s.mutate(func(current *Snapshot) error {
		text := trim(value)
		if text == "" || utf8.RuneCountInString(text) > MaxSourcePathLength || hasControl(text) {
			return invalid("node_file", "invalid_path", nil)
		}
		candidate, err := expandUser(text)
		if err != nil {
			return err
		}
		if !filepath.IsAbs(candidate) {
			candidate = filepath.Join(s.projectDir, candidate)
		}
		candidate = filepath.Clean(candidate)
		if _, err := ReadNodeFile(candidate, s.allowedRoots); err != nil {
			return err
		}
		current.NodeFile = candidate
		return nil
	})
}

func (s *Store) ClearNodeFile() (Snapshot, error) {
	return s.mutate(func(current *Snapshot) error { current.NodeFile = ""; return nil })
}

func (s *Store) AddInlineNodes(values []string) (Snapshot, error) {
	return s.mutate(func(current *Snapshot) error {
		normalized, err := normalizeInlineNodes(values)
		if err == nil {
			current.InlineNodes = append(current.InlineNodes, normalized...)
		}
		return err
	})
}

func (s *Store) ReplaceInlineNode(id, value string) (Snapshot, error) {
	if err := validateSourceID(id, "node"); err != nil {
		return Snapshot{}, err
	}
	return s.mutate(func(current *Snapshot) error {
		i, err := findID("node", id, current.InlineNodes)
		if err != nil {
			return err
		}
		normalized, _, err := parseOneInlineNode(value, nil)
		if err == nil {
			current.InlineNodes[i] = normalized
		}
		return err
	})
}

func (s *Store) DeleteInlineNode(id string) (Snapshot, error) {
	if err := validateSourceID(id, "node"); err != nil {
		return Snapshot{}, err
	}
	return s.mutate(func(current *Snapshot) error {
		i, err := findID("node", id, current.InlineNodes)
		if err != nil {
			return err
		}
		current.InlineNodes = append(current.InlineNodes[:i], current.InlineNodes[i+1:]...)
		return nil
	})
}

// ResetOverride can remove a corrupt regular file. It must not follow or remove
// a symlink or non-regular managed target.
func (s *Store) ResetOverride() (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := openDirectory(filepath.Dir(s.path), true)
	if err != nil {
		return Snapshot{}, managedForbidden("managed_path_symlink")
	}
	defer dir.Close()
	if err := checkManagedTarget(dir); err != nil {
		var typed *Error
		if errors.As(err, &typed) {
			return Snapshot{}, typed
		}
		return Snapshot{}, storeError("store_error", "delete_failed", "无法恢复配置文件默认代理源")
	}
	if err := unix.Unlinkat(int(dir.Fd()), managedFilename, 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return Snapshot{}, storeError("store_error", "delete_failed", "无法恢复配置文件默认代理源")
	}
	s.lastFailure = ""
	return s.fallback(false), nil
}
