package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The test executable stands in for ldos-backend; no window, Python, or model is started.
func TestNativeBackendHelper(t *testing.T) {
	if os.Getenv("LDOS_NATIVE_HELPER") != "1" {
		return
	}
	args := os.Args
	for len(args) > 0 && args[0] != "--" {
		args = args[1:]
	}
	if len(args) != 5 || args[1] != "--config" || args[3] != "--executors-dir" {
		os.Exit(2)
	}
	data, err := os.ReadFile(args[2])
	if err != nil {
		os.Exit(3)
	}
	ep, err := endpointFromConfig(data, os.Getenv)
	if err != nil {
		os.Exit(4)
	}
	listener, err := net.Listen("tcp", ep.authority())
	if err != nil {
		os.Exit(5)
	}
	snapshot := map[string]any{"args": args[1:], "parent": os.Getenv("GDL_BACKEND_PARENT_PIPE"), "origin": os.Getenv("LDOS_DESKTOP_ORIGIN"), "python": os.Getenv("PYTHON"), "resource": os.Getenv("LDOS_DESKTOP_RESOURCE_ROOT"), "data": os.Getenv("LDOS_DESKTOP_DATA_ROOT")}
	payload, _ := json.Marshal(snapshot)
	if err := os.WriteFile(os.Getenv("LDOS_NATIVE_SNAPSHOT"), payload, 0600); err != nil {
		os.Exit(6)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			fmt.Fprint(w, `{"ok":true}`)
		} else {
			fmt.Fprint(w, `{"version":"native-fixture"}`)
		}
	})}
	go server.Serve(listener)
	_, _ = io.Copy(io.Discard, os.Stdin)
	server.Close()
	os.Exit(0)
}

func TestPackagedNativeProcessContract(t *testing.T) {
	root := t.TempDir()
	resource := filepath.Join(root, "resources")
	backend := filepath.Join(resource, "backend")
	paths := applicationPaths{config: filepath.Join(root, "config"), data: filepath.Join(root, "data"), cache: filepath.Join(root, "cache")}
	for _, relative := range []string{"runtime/python/bin/python3.13", "app/executors/ldos_gallery/worker_entry.py", "app/gallery-dl-codeberg/gallery_dl/__init__.py", "app/dedup_review_worker.py", "app/dedup_core.py", "release-manifest.json"} {
		fixtureFile(t, filepath.Join(backend, relative), "", 0700)
	}
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
	executable := filepath.Join(backend, "bin/ldos-backend")
	fixtureFile(t, executable, "#!/bin/sh\nexec "+quote(os.Args[0])+" -test.run=^TestNativeBackendHelper$ -- \"$@\"\n", 0700)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	config := filepath.Join(paths.config, "backend.json")
	original := fmt.Sprintf(`{"server":{"port":%d},"runtime_dir":"/stale/runtime","database_path":"/stale/database","gallery":{"python_executable":"/stale/python"}}`, port)
	fixtureFile(t, config, original, 0600)
	snapshotPath := filepath.Join(root, "snapshot.json")
	t.Setenv("LDOS_NATIVE_HELPER", "1")
	t.Setenv("LDOS_NATIVE_SNAPSHOT", snapshotPath)
	t.Setenv("GORACE", os.Getenv("GORACE")+" atexit_sleep_ms=0")
	t.Setenv("PYTHON", "/forbidden/python")
	t.Setenv("PYTHONPATH", "/forbidden/business")
	t.Setenv("PYTHONHOME", "/forbidden/home")
	t.Setenv("LDOS_DESKTOP_ORIGIN", "https://untrusted.example")
	manager := newBackendManager(supervisorTiming{startup: 3 * time.Second, probe: 10 * time.Millisecond, io: time.Second, shutdown: time.Second, terminate: 100 * time.Millisecond})
	defer manager.shutdown()
	manager.start(func() (launchSpec, error) { return packagedSpec(resource, paths, "mygo://localhost", os.Getenv) })
	waitStatus(t, manager, BackendReady, "")
	payload, err := os.ReadFile(snapshotPath)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot map[string]any
	if err := json.Unmarshal(payload, &snapshot); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"args": []any{"--config", config, "--executors-dir", filepath.Join(backend, "app/executors")}, "parent": "1", "origin": "mygo://localhost", "python": filepath.Join(backend, "runtime/python/bin/python3.13"), "resource": backend, "data": paths.data}
	if !reflect.DeepEqual(snapshot, want) {
		t.Fatalf("launch contract: got %#v, want %#v", snapshot, want)
	}
	manager.shutdown()
	waitStatus(t, manager, BackendStopped, "")
	data, _ := os.ReadFile(config)
	if string(data) != original {
		t.Fatal("packaged launch rewrote existing configuration")
	}
}
