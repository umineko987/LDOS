package proxysources

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"golang.org/x/sys/unix"
)

const (
	testSubscription  = "https://fixture.invalid/private/subscription?ticket=fixture-value"
	testSubscription2 = "https://second.fixture.invalid/another/private/path"
	testDirectNode    = "http://fixture-user:fixture-pass@127.0.0.1:18080#LOCAL"
	testDirectNode2   = "socks5://127.0.0.1:18081#SECOND"
	testUUID          = "11111111-1111-1111-1111-111111111111"
	testTunnelNode    = "vless://" + testUUID + "@proxy.fixture.invalid:443?security=tls&type=ws&path=%2Fprivate#JP-01"
)

func newTestStore(t *testing.T, settings Settings) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	allowed := filepath.Join(root, "subscriptions")
	if err := os.Mkdir(allowed, 0700); err != nil {
		t.Fatal(err)
	}
	if settings.AllowedNodeRoots == nil {
		settings.AllowedNodeRoots = []string{allowed}
	}
	store, err := New(settings, filepath.Join(root, "runtime"), root)
	if err != nil {
		t.Fatal(err)
	}
	return store, root
}

func putFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func fileBytes(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func requireError(t *testing.T, err error, category, reason string) *Error {
	t.Helper()
	var typed *Error
	if !errors.As(err, &typed) {
		t.Fatalf("expected structured %s/%s, got %T", category, reason, err)
	}
	if typed.Category != category || typed.Reason != reason {
		t.Fatalf("error category/reason = %s/%s, want %s/%s", typed.Category, typed.Reason, category, reason)
	}
	return typed
}

func requireSafe(t *testing.T, value any, root string) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"/private/subscription", "ticket=fixture-value", "/another/private/path", "fixture-user", "fixture-pass", testUUID, testTunnelNode, root} {
		if forbidden != "" && bytes.Contains(data, []byte(forbidden)) {
			t.Fatal("public value contains a private fixture")
		}
	}
}

func TestBaselineCompleteOverrideRestartReset(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "nodes.txt")
	putFile(t, path, testDirectNode)
	settings := Settings{SubscriptionURLs: []string{testSubscription}, NodeFile: path, InlineNodes: []string{testDirectNode}}
	store, err := New(settings, filepath.Join(root, "runtime"), root)
	if err != nil {
		t.Fatal(err)
	}
	initial := store.Snapshot()
	if initial.Source != "config" || initial.HasRuntimeOverride || !initial.RuntimeOverrideValid {
		t.Fatal(initial)
	}
	settings.SubscriptionURLs[0], settings.InlineNodes[0] = testSubscription2, testDirectNode2
	initial.SubscriptionURLs[0], initial.InlineNodes[0] = testSubscription2, testDirectNode2
	changed, err := store.AddSubscription("  " + testSubscription2 + "  ")
	if err != nil {
		t.Fatal(err)
	}
	if changed.Source != "runtime" || !changed.HasRuntimeOverride || !changed.RuntimeOverrideValid {
		t.Fatal(changed)
	}
	if !reflect.DeepEqual(changed.SubscriptionURLs, []string{testSubscription, testSubscription2}) || !reflect.DeepEqual(changed.InlineNodes, []string{testDirectNode}) || changed.NodeFile != path {
		t.Fatal("first mutation did not preserve the frozen complete baseline")
	}
	var document map[string]any
	if err := json.Unmarshal(fileBytes(t, store.Path()), &document); err != nil {
		t.Fatal(err)
	}
	if document["version"] != float64(1) || len(document) != 5 || document["node_file"] != path {
		t.Fatal("invalid v1 document")
	}
	restarted, err := New(Settings{}, filepath.Join(root, "runtime"), root)
	if err != nil {
		t.Fatal(err)
	}
	if restarted.Snapshot().ConfiguredRevision != changed.ConfiguredRevision {
		t.Fatal("restart changed revision")
	}
	changed.SubscriptionURLs[0] = "mutated"
	if store.Snapshot().SubscriptionURLs[0] != testSubscription {
		t.Fatal("returned snapshot aliases persisted state")
	}
	restored, err := store.ResetOverride()
	if err != nil {
		t.Fatal(err)
	}
	if restored.Source != "config" || restored.HasRuntimeOverride || restored.InlineNodes[0] != testDirectNode || restored.SubscriptionURLs[0] != testSubscription {
		t.Fatal("reset changed frozen baseline")
	}
	if _, err := os.Lstat(store.Path()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("override was not removed")
	}
}

func TestEmptyOverrideAndCRUD(t *testing.T) {
	store, _ := newTestStore(t, Settings{})
	if store.Snapshot().Source != "none" {
		t.Fatal("empty config source")
	}
	current, err := store.ClearNodeFile()
	if err != nil || current.Source != "runtime" || !current.HasRuntimeOverride {
		t.Fatal("empty override lost runtime source", err)
	}
	if _, err := store.AddSubscription(testSubscription); err != nil {
		t.Fatal(err)
	}
	current, err = store.AddSubscription(" " + testSubscription + " ")
	if err != nil || len(current.SubscriptionURLs) != 1 {
		t.Fatal("duplicate subscription", err)
	}
	current, err = store.ReplaceSubscription(sourceID("sub", testSubscription), testSubscription2)
	if err != nil || len(current.SubscriptionURLs) != 1 || current.SubscriptionURLs[0] != testSubscription2 {
		t.Fatal("replace subscription", err)
	}
	current, err = store.DeleteSubscription(sourceID("sub", testSubscription2))
	if err != nil || len(current.SubscriptionURLs) != 0 {
		t.Fatal("delete subscription", err)
	}
	current, err = store.AddInlineNodes([]string{testDirectNode, " " + testDirectNode + " ", testTunnelNode})
	if err != nil || len(current.InlineNodes) != 2 {
		t.Fatal("add inline nodes", err)
	}
	current, err = store.ReplaceInlineNode(sourceID("node", testDirectNode), testDirectNode2)
	if err != nil || current.InlineNodes[0] != testDirectNode2 {
		t.Fatal("replace inline node", err)
	}
	current, err = store.DeleteInlineNode(sourceID("node", testDirectNode2))
	if err != nil || !reflect.DeepEqual(current.InlineNodes, []string{testTunnelNode}) {
		t.Fatal("delete inline node", err)
	}
}

func TestRevisionAndSourceIDsMatchPython(t *testing.T) {
	// Golden values were computed with Python hashlib/json and the original
	// versioned prefixes. Include characters encoding/json normally escapes.
	cases := []struct {
		settings Settings
		revision string
	}{
		{Settings{}, "8a4428d6468413269f13bb2a7bc13be330fae3793ff0847f18a332740a010e75"},
		{Settings{SubscriptionURLs: []string{testSubscription}, InlineNodes: []string{testDirectNode}}, "c76077288d84fa2bb78b96d72ef40f3e92564734132f1fd50cbdf6ddce23b00f"},
		{Settings{SubscriptionURLs: []string{"https://example.invalid/中文?<>&\u2028#\u2029"}, NodeFile: "/tmp/节点文件", InlineNodes: []string{"http://127.0.0.1:80#节点\t\"\\"}}, "f156da2f3a40995b7427bfc866d4e24ab1a5147f77cfb94e99f6f8ee96bd052c"},
	}
	for i, tc := range cases {
		if got := configuredRevision(tc.settings.SubscriptionURLs, tc.settings.NodeFile, tc.settings.InlineNodes); got != tc.revision {
			t.Fatalf("revision fixture %d differs", i)
		}
	}
	if got := sourceID("sub", testSubscription); got != "sub_59eb48efb7fb2f086cf0dd5aaa13c3c4f417c0559f5f5073c06d4b531ce7c183" {
		t.Fatal("subscription ID differs from Python")
	}
	if got := sourceID("node", testDirectNode); got != "node_2a05c18d160cb5a77b210af00bae7bec38718d1344be0f23af6b07875cb9f42e" {
		t.Fatal("inline node ID differs from Python")
	}
}

func TestCorruptOverrideFallbackMutationRejectionAndReset(t *testing.T) {
	store, root := newTestStore(t, Settings{SubscriptionURLs: []string{testSubscription}})
	baseline := store.Snapshot()
	for _, content := range []string{"{broken", `{"version":999,"updated_at":0,"subscription_urls":[],"node_file":null,"inline_nodes":[]}`} {
		putFile(t, store.Path(), content)
		current := store.Snapshot()
		if current.Source != "config" || !current.HasRuntimeOverride || current.RuntimeOverrideValid || current.ConfiguredRevision != baseline.ConfiguredRevision {
			t.Fatal("corrupt override did not fall back")
		}
		_, err := store.AddSubscription(testSubscription2)
		var typed *Error
		if !errors.As(err, &typed) || typed.Category != "corrupt" || typed.Code != "proxy_sources_store_error" {
			t.Fatal("mutation did not reject corrupt override")
		}
		requireSafe(t, typed, root)
		if string(fileBytes(t, store.Path())) != content {
			t.Fatal("mutation replaced corrupt data")
		}
		reset, err := store.ResetOverride()
		if err != nil || reset.HasRuntimeOverride || !reset.RuntimeOverrideValid {
			t.Fatal("reset failed", err)
		}
	}
}

func TestStrictOverrideSchema(t *testing.T) {
	base := `{"version":1,"updated_at":0,"subscription_urls":[],"node_file":null,"inline_nodes":[]}`
	cases := []struct{ raw, reason string }{
		{"[]", "invalid_structure"}, {"null", "invalid_structure"},
		{strings.Replace(base, `"version":1`, `"version":true`, 1), "unsupported_version"},
		{strings.Replace(base, `"version":1`, `"version":1.0`, 1), "unsupported_version"},
		{strings.Replace(base, `"version":1`, `"extra":1`, 1), "invalid_structure"},
		{strings.Replace(base, `"updated_at":0`, `"updated_at":-1`, 1), "invalid_updated_at"},
		{strings.Replace(base, `"updated_at":0`, `"updated_at":true`, 1), "invalid_updated_at"},
		{strings.Replace(base, `"updated_at":0`, `"updated_at":null`, 1), "invalid_updated_at"},
		{strings.Replace(base, `"updated_at":0`, `"updated_at":"0"`, 1), "invalid_updated_at"},
		{strings.Replace(base, `"updated_at":0`, `"updated_at":1e999`, 1), "invalid_updated_at"},
		{strings.Replace(base, `"subscription_urls":[]`, `"subscription_urls":null`, 1), "invalid_structure"},
		{strings.Replace(base, `"subscription_urls":[]`, `"subscription_urls":[null]`, 1), "invalid_structure"},
		{strings.Replace(base, `"subscription_urls":[]`, `"subscription_urls":["invalid"]`, 1), "invalid_source_value"},
		{strings.Replace(base, `"inline_nodes":[]`, `"inline_nodes":[true]`, 1), "invalid_structure"},
		{strings.Replace(base, `"inline_nodes":[]`, `"inline_nodes":["unsupported://fixture"]`, 1), "invalid_source_value"},
		{strings.Replace(base, `"node_file":null`, `"node_file":true`, 1), "invalid_structure"},
		{strings.Replace(base, `"node_file":null`, `"node_file":"relative/path"`, 1), "invalid_node_file_value"},
		{strings.Replace(base, `"node_file":null`, `"node_file":"/`+strings.Repeat("p", MaxSourcePathLength)+`"`, 1), "invalid_node_file_value"},
		{"\xff", "invalid_json"}, {"\ufeff" + base, "invalid_json"},
	}
	for i, tc := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			_, err := decodeOverride([]byte(tc.raw))
			requireError(t, err, "corrupt", tc.reason)
		})
	}
	for _, path := range []string{`null`, `""`, `"/missing/allowed-node-file"`} {
		current, err := decodeOverride([]byte(strings.Replace(base, `"node_file":null`, `"node_file":`+path, 1)))
		if err != nil || current.Source != "runtime" {
			t.Fatal("decode unexpectedly opened node file", err)
		}
	}
}

func TestInvalidMutationIsAtomicAndSafe(t *testing.T) {
	store, root := newTestStore(t, Settings{})
	before, err := store.AddInlineNodes([]string{testDirectNode})
	if err != nil {
		t.Fatal(err)
	}
	raw := fileBytes(t, store.Path())
	_, err = store.AddInlineNodes([]string{testDirectNode2, "unsupported://do-not-echo.invalid/private"})
	typed := requireError(t, err, "validation", "unsupported_or_empty")
	if typed.Code != "invalid_proxy_inline_node" || typed.Index == nil || *typed.Index != 1 || typed.Details["index"] != 1 {
		t.Fatal("missing failing node index")
	}
	requireSafe(t, typed, root)
	if !bytes.Equal(raw, fileBytes(t, store.Path())) || before.ConfiguredRevision != store.Snapshot().ConfiguredRevision {
		t.Fatal("invalid batch changed override")
	}
	for _, id := range []string{"bad", "sub_" + strings.Repeat("A", 64), sourceID("node", testDirectNode)} {
		_, err := store.DeleteSubscription(id)
		if requireError(t, err, "validation", "invalid_source_id").Code != "invalid_proxy_source_id" {
			t.Fatal("incorrect source ID code")
		}
	}
	_, err = store.DeleteSubscription("sub_" + strings.Repeat("0", 64))
	if requireError(t, err, "not_found", "not_found").Code != "proxy_source_not_found" {
		t.Fatal("incorrect missing source code")
	}
}

func TestValidationLimitsAndNormalization(t *testing.T) {
	for _, tc := range []struct{ input, expected string }{
		{" HTTPS://User:Pass@EXAMPLE.COM.:00443/raw%broken?x=%#fragment ", "https://User:Pass@example.com:443/raw%broken?x=%#fragment"},
		{"http://[2001:DB8::1]:8080/", "http://[2001:db8::1]:8080/"},
		{"http://example.invalid:?#", "http://example.invalid"},
	} {
		value, err := normalizeSubscription(tc.input)
		if err != nil || value != tc.expected {
			t.Fatal("subscription normalization differs", err)
		}
	}
	for _, tc := range []struct{ input, reason string }{
		{"", "empty"}, {"https://example.invalid/" + strings.Repeat("x", MaxSubscriptionURLLength), "too_long"},
		{"https://example.invalid/\nprivate", "control_character"}, {"ftp://example.invalid/", "unsupported_scheme"},
		{"https://example.invalid:0", "malformed"}, {"https://example.invalid:65536", "malformed"}, {"https://[broken]/", "malformed"},
	} {
		_, err := normalizeSubscription(tc.input)
		if requireError(t, err, "validation", tc.reason).Code != "invalid_proxy_subscription" {
			t.Fatal("incorrect subscription code")
		}
	}
	_, err := normalizeSubscriptions(make([]string, MaxSubscriptions+1))
	requireError(t, err, "validation", "too_many")
	_, err = normalizeInlineNodes(make([]string, MaxInlineNodes+1))
	requireError(t, err, "validation", "too_many")
	_, _, err = parseOneInlineNode(testDirectNode+strings.Repeat("n", MaxInlineNodeLength), nil)
	requireError(t, err, "validation", "too_long")
	_, err = normalizeInlineNodes([]string{strings.Repeat("x", MaxInlineNodeTotalChars+1)})
	requireError(t, err, "validation", "total_too_large")
	_, _, err = parseOneInlineNode("http://127.0.0.1:80\nhttp://127.0.0.1:81", nil)
	requireError(t, err, "validation", "control_character")
}

func TestNodeFileAllowlistBoundaryAndRestart(t *testing.T) {
	store, root := newTestStore(t, Settings{})
	path := filepath.Join(root, "subscriptions", "nodes.txt")
	putFile(t, path, "\ufeff"+testDirectNode+"\n")
	current, err := store.SetNodeFile("subscriptions/nodes.txt")
	if err != nil || current.NodeFile != path {
		t.Fatal("set relative node file", err)
	}
	public, err := store.PublicSnapshot(&current, nil)
	if err != nil || public["node_file"].(map[string]any)["display_path"] != "subscriptions/nodes.txt" {
		t.Fatal("node file display path", err)
	}
	text, err := ReadNodeFile(path, nil)
	if err != nil || text != testDirectNode+"\n" {
		t.Fatal("BOM read", err)
	}
	_, err = ReadNodeFile(path, []string{})
	requireError(t, err, "path_forbidden", "outside_allowed_roots")
	outside := filepath.Join(root, "subscriptions-sibling.txt")
	putFile(t, outside, testDirectNode)
	_, err = store.SetNodeFile(outside)
	requireError(t, err, "path_forbidden", "outside_allowed_roots")
	for _, tc := range []struct{ name, content, reason string }{
		{"invalid.txt", "\xff\xfe\xff", "invalid_encoding"}, {"empty.txt", "unsupported://fixture\n", "empty_parse"},
	} {
		path := filepath.Join(root, "subscriptions", tc.name)
		putFile(t, path, tc.content)
		_, err := store.SetNodeFile(path)
		requireError(t, err, "validation", tc.reason)
	}
	_, err = store.SetNodeFile(filepath.Join(root, "subscriptions"))
	requireError(t, err, "validation", "not_regular")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if !store.Snapshot().RuntimeOverrideValid {
		t.Fatal("missing node file corrupted valid override document")
	}
	_, err = store.AddSubscription(testSubscription)
	requireError(t, err, "validation", "unavailable")
	current, err = store.ClearNodeFile()
	if err != nil || current.NodeFile != "" {
		t.Fatal("could not clear unavailable node file", err)
	}
}

func TestNodeFileNonRegularAndSize(t *testing.T) {
	store, root := newTestStore(t, Settings{})
	fifo := filepath.Join(root, "subscriptions", "fifo")
	if err := unix.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	_, err := store.SetNodeFile(fifo)
	requireError(t, err, "validation", "not_regular")
	large := filepath.Join(root, "subscriptions", "large")
	putFile(t, large, "")
	if err := os.Truncate(large, MaxNodeFileBytes+1); err != nil {
		t.Fatal(err)
	}
	_, err = store.SetNodeFile(large)
	requireError(t, err, "validation", "too_large")
}

func TestSymlinksNeverFollowed(t *testing.T) {
	store, root := newTestStore(t, Settings{})
	outside := filepath.Join(root, "outside.json")
	putFile(t, outside, "do-not-touch")
	if err := os.Symlink(outside, store.Path()); err != nil {
		t.Fatal(err)
	}
	if store.Snapshot().RuntimeOverrideValid {
		t.Fatal("symlink did not invalidate override")
	}
	_, err := store.AddSubscription(testSubscription)
	requireError(t, err, "path_forbidden", "managed_path_symlink")
	_, err = store.ResetOverride()
	requireError(t, err, "path_forbidden", "managed_path_symlink")
	if string(fileBytes(t, outside)) != "do-not-touch" {
		t.Fatal("symlink target changed")
	}
	if err := os.Remove(store.Path()); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "missing"), store.Path()); err != nil {
		t.Fatal(err)
	}
	_, err = store.ClearNodeFile()
	requireError(t, err, "path_forbidden", "managed_path_symlink")

	realNodes := filepath.Join(root, "real-nodes")
	if err := os.Mkdir(realNodes, 0700); err != nil {
		t.Fatal(err)
	}
	putFile(t, filepath.Join(realNodes, "nodes.txt"), testDirectNode)
	linkedRoot := filepath.Join(root, "subscriptions", "linked")
	if err := os.Symlink(realNodes, linkedRoot); err != nil {
		t.Fatal(err)
	}
	_, err = ReadNodeFile(filepath.Join(linkedRoot, "nodes.txt"), []string{linkedRoot})
	requireError(t, err, "path_forbidden", "symlink")
	_, err = ReadNodeFile(filepath.Join(linkedRoot, "nodes.txt"), nil)
	requireError(t, err, "path_forbidden", "symlink")
	leaf := filepath.Join(root, "subscriptions", "leaf")
	if err := os.Symlink(filepath.Join(realNodes, "nodes.txt"), leaf); err != nil {
		t.Fatal(err)
	}
	_, err = ReadNodeFile(leaf, nil)
	requireError(t, err, "path_forbidden", "symlink")

	linkedRuntime := filepath.Join(root, "linked-runtime")
	if err := os.Symlink(realNodes, linkedRuntime); err != nil {
		t.Fatal(err)
	}
	_, err = New(Settings{}, linkedRuntime, root)
	requireError(t, err, "path_forbidden", "managed_path_forbidden")
	// Replace an already-opened store's parent with a symlink after startup.
	if err := os.Remove(store.Path()); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Dir(store.Path())); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realNodes, filepath.Dir(store.Path())); err != nil {
		t.Fatal(err)
	}
	_, err = store.AddInlineNodes([]string{testDirectNode})
	requireError(t, err, "path_forbidden", "managed_path_symlink")
	_, err = store.ResetOverride()
	requireError(t, err, "path_forbidden", "managed_path_symlink")
	if _, err := os.Lstat(filepath.Join(realNodes, managedFilename)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("managed write escaped through parent symlink")
	}
}

func TestManagedNonRegularAndSize(t *testing.T) {
	store, _ := newTestStore(t, Settings{})
	if err := os.Mkdir(store.Path(), 0700); err != nil {
		t.Fatal(err)
	}
	if store.Snapshot().RuntimeOverrideValid {
		t.Fatal("managed directory treated as valid")
	}
	_, err := store.ClearNodeFile()
	requireError(t, err, "corrupt", "invalid_target")
	_, err = store.ResetOverride()
	requireError(t, err, "path_forbidden", "managed_target_not_file")
	if err := os.Remove(store.Path()); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(store.Path(), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = store.ClearNodeFile()
	requireError(t, err, "corrupt", "invalid_target")
	if err := os.Remove(store.Path()); err != nil {
		t.Fatal(err)
	}
	putFile(t, store.Path(), "")
	if err := os.Truncate(store.Path(), MaxManagedSourcesFileBytes+1); err != nil {
		t.Fatal(err)
	}
	_, err = store.ClearNodeFile()
	requireError(t, err, "corrupt", "too_large")
	if _, err := store.ResetOverride(); err != nil {
		t.Fatal(err)
	}
}

func TestPrivateModesAndAtomicReplacement(t *testing.T) {
	store, _ := newTestStore(t, Settings{})
	if _, err := store.AddSubscription(testSubscription); err != nil {
		t.Fatal(err)
	}
	old, err := os.Open(store.Path())
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	previous := fileBytes(t, store.Path())
	if err := os.Chmod(store.Path(), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddSubscription(testSubscription2); err != nil {
		t.Fatal(err)
	}
	stillOld, err := io.ReadAll(old)
	if err != nil || !bytes.Equal(stillOld, previous) {
		t.Fatal("write modified old inode rather than replacing atomically", err)
	}
	for path, mode := range map[string]os.FileMode{store.Path(): 0600, filepath.Dir(store.Path()): 0700} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != mode {
			t.Fatal("private mode mismatch", err)
		}
	}
	entries, err := os.ReadDir(filepath.Dir(store.Path()))
	if err != nil || len(entries) != 1 || entries[0].Name() != managedFilename {
		t.Fatal("temporary file leaked", err)
	}
}

func TestExternalChangesConflictIncludingWhitespace(t *testing.T) {
	for _, mode := range []string{"created", "changed", "whitespace", "removed", "corrupt", "symlink"} {
		t.Run(mode, func(t *testing.T) {
			store, root := newTestStore(t, Settings{})
			if mode != "created" {
				if _, err := store.AddSubscription(testSubscription); err != nil {
					t.Fatal(err)
				}
			}
			store.mu.Lock()
			defer store.mu.Unlock()
			current, token, err := store.loadLocked(true)
			if err != nil {
				t.Fatal(err)
			}
			var external []byte
			switch mode {
			case "created", "changed":
				external = []byte(`{"version":1,"updated_at":123,"subscription_urls":[],"node_file":null,"inline_nodes":[]}`)
				putFile(t, store.Path(), string(external))
			case "whitespace":
				external = append(fileBytes(t, store.Path()), '\n')
				putFile(t, store.Path(), string(external))
			case "corrupt":
				external = []byte("broken")
				putFile(t, store.Path(), string(external))
			case "removed":
				if err := os.Remove(store.Path()); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Remove(store.Path()); err != nil {
					t.Fatal(err)
				}
				external = []byte("do-not-touch")
				target := filepath.Join(root, "external")
				putFile(t, target, string(external))
				if err := os.Symlink(target, store.Path()); err != nil {
					t.Fatal(err)
				}
			}
			current.InlineNodes = []string{testDirectNode}
			_, err = store.writeLocked(token, current)
			if requireError(t, err, "conflict", "external_change").Code != "proxy_sources_store_error" {
				t.Fatal("incorrect conflict code")
			}
			if mode == "removed" {
				if _, err := os.Lstat(store.Path()); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("external deletion overwritten")
				}
			} else if !bytes.Equal(fileBytes(t, store.Path()), external) {
				t.Fatal("external update overwritten")
			}
		})
	}
}

func TestConcurrentMutationsDoNotLoseUpdates(t *testing.T) {
	store, _ := newTestStore(t, Settings{InlineNodes: []string{testDirectNode}})
	const count = 12
	var group sync.WaitGroup
	errors := make(chan error, count)
	start := make(chan struct{})
	for i := range count {
		group.Go(func() {
			<-start
			_, err := store.AddSubscription(fmt.Sprintf("https://provider-%d.fixture.invalid/subscription/%d", i, i))
			errors <- err
			store.Snapshot()
		})
	}
	close(start)
	group.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	current := store.Snapshot()
	if len(current.SubscriptionURLs) != count || !reflect.DeepEqual(current.InlineNodes, []string{testDirectNode}) {
		t.Fatal("concurrent mutations lost sources")
	}
}

func TestPublicSnapshotRedactionAndReload(t *testing.T) {
	store, root := newTestStore(t, Settings{
		SubscriptionURLs: []string{"https://user:password@[2001:db8::1]:8443/private?q=fixture#fragment"},
		InlineNodes:      []string{testDirectNode, "vless://" + testUUID + "@proxy.fixture.invalid:443?security=tls#" + testUUID + "%0Acontrol"},
	})
	current := store.Snapshot()
	current.NodeFile = filepath.Join(filepath.Dir(root), "external-nodes.txt")
	public, err := store.PublicSnapshot(&current, nil)
	if err != nil {
		t.Fatal(err)
	}
	requireSafe(t, public, root)
	data, _ := json.Marshal(public)
	if bytes.Contains(data, []byte("password")) || bytes.Contains(data, []byte("?q=")) || bytes.Contains(data, []byte("security=tls")) {
		t.Fatal("public projection leaked credentials or protocol secrets")
	}
	subscription := public["subscriptions"].([]map[string]any)[0]
	if subscription["display_url"] != "https://[2001:db8::1]:8443/…" || subscription["credentials_redacted"] != true || subscription["sensitive_parts_redacted"] != true {
		t.Fatal("incorrect subscription projection")
	}
	nodes := public["inline_nodes"].([]map[string]any)
	if nodes[0]["requires_transport_core"] != false || nodes[1]["requires_transport_core"] != true || strings.Contains(nodes[1]["name"].(string), "\n") {
		t.Fatal("incorrect inline projection")
	}
	if public["node_file"].(map[string]any)["display_path"] != "external-nodes.txt" {
		t.Fatal("external path leaked")
	}
	if public["active_revision"] != nil || public["reload_required"] != true || public["counts"].(map[string]any)["total"] != 4 {
		t.Fatal("incorrect revision/counts projection")
	}
	public, err = store.PublicSnapshot(&current, &current.ConfiguredRevision)
	if err != nil || public["reload_required"] != false {
		t.Fatal("active revision comparison", err)
	}
	for _, formatted := range []string{fmt.Sprint(current), fmt.Sprintf("%+v", current), fmt.Sprintf("%#v", current)} {
		requireSafe(t, formatted, root)
	}
	for value, expected := range map[string]string{
		"http://user:password@example.invalid/private": "已命名节点",
		"secret=fixture-value":                         "已命名节点", strings.Repeat("a", 32): "***", testUUID + "\ncontrol": "*** control",
		"  node\tname  ": "node name", strings.Repeat("n ", 100): strings.TrimSpace(strings.Repeat("n ", 40)) + " ",
	} {
		if got := SafeNodeName(value); got != expected {
			t.Fatal("unsafe or inconsistent node label")
		}
	}
}

func TestUnicodeNormalizationMatchesPython(t *testing.T) {
	for host, expected := range map[string]string{
		"bücher.example": "xn--bcher-kva.example", "faß.example": "fass.example",
		"ＢÜＣＨＥＲ.example": "xn--bcher-kva.example", "bu\u0308cher.example": "xn--bcher-kva.example",
		"例子。测试": "xn--fsqu00a.xn--0zwm56d", "fa\u200dß.example": "fass.example",
	} {
		value, err := normalizeSubscription("https://" + host + "/订阅")
		if err != nil || value != "https://"+expected+"/订阅" {
			t.Fatal("IDNA normalization differs from Python", err)
		}
	}
	current := MakeSnapshot(Settings{SubscriptionURLs: []string{"https://bücher.example/订阅"}})
	if current.ConfiguredRevision != "c249b1cdff9c5cd35b7f3ac88512a2d1ab28cc984b576348685bb33730fdba07" {
		t.Fatal("IDNA revision differs from Python")
	}
	for _, value := range []string{"https://example.invalid／private", "https://user＠example.invalid/", "https://example.invalid：80/"} {
		_, err := normalizeSubscription(value)
		requireError(t, err, "validation", "malformed")
	}
	for value, expected := range map[string]string{
		"节点①": "节点1", "ｅ\u0301": "é", "ＡＢＣ\u202e节点": "ABC 节点",
		"ｐａｓｓｗｏｒｄ＝fixture": "已命名节点", "ｈｔｔｐ：／／private": "已命名节点",
		"节点\u0378name": "节点 name", "ｔｏｋｅｎ＝value": "已命名节点",
	} {
		if got := SafeNodeName(value); got != expected {
			t.Fatal("NFKC display normalization differs from Python")
		}
	}
}

func TestValidSourceSetFitsManagedFileLimit(t *testing.T) {
	store, _ := newTestStore(t, Settings{})
	// 129 distinct nodes fit the 2 Mi-character budget, but Go's default HTML
	// escaping would expand their names beyond the v1 managed-file byte limit.
	nodes := make([]string, 129)
	for i := range nodes {
		nodes[i] = fmt.Sprintf("http://127.0.0.1:80#%d-", i) + strings.Repeat("<", 16000)
	}
	saved, err := store.AddInlineNodes(nodes)
	if err != nil {
		t.Fatal(err)
	}
	loaded := store.Snapshot()
	if !loaded.RuntimeOverrideValid || loaded.ConfiguredRevision != saved.ConfiguredRevision || len(loaded.InlineNodes) != len(nodes) {
		t.Fatal("valid source set exceeded managed-file read budget")
	}
	unicodeNode := "http://127.0.0.1:80#before\u2028middle\u2029after"
	saved, err = store.AddInlineNodes([]string{unicodeNode})
	if err != nil {
		t.Fatal(err)
	}
	raw := fileBytes(t, store.Path())
	if bytes.Contains(raw, []byte(`\u2028`)) || bytes.Contains(raw, []byte(`\u2029`)) {
		t.Fatal("Unicode source text was expanded on disk")
	}
	if store.Snapshot().ConfiguredRevision != saved.ConfiguredRevision {
		t.Fatal("Unicode source roundtrip changed revision")
	}
}
