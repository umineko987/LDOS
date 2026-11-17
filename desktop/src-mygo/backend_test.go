package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func testTiming() supervisorTiming {
	return supervisorTiming{startup: 300 * time.Millisecond, probe: 10 * time.Millisecond, io: 50 * time.Millisecond, shutdown: 100 * time.Millisecond, terminate: 100 * time.Millisecond}
}

func TestHealthGateAndVersionMetadata(t *testing.T) {
	for _, test := range []struct {
		name, health, version string
		status                int
		ready                 bool
		requests              []string
	}{
		{"healthy", `{"ok":true}`, `{"service":"gallery-dl-backend","version":"0.5.2"}`, 200, true, []string{"/healthz", "/"}},
		{"unhealthy", `{"ok":false}`, `{"version":"0.5.2"}`, 200, false, []string{"/healthz"}},
		{"wrong-health-type", `{"ok":"true"}`, `{}`, 200, false, []string{"/healthz"}},
		{"failed-status", `{"ok":true}`, `{}`, 503, false, []string{"/healthz"}},
		{"invalid-version", `{"ok":true}`, `{"version":"secret/path"}`, 200, false, []string{"/healthz", "/"}},
		{"missing-version", `{"ok":true}`, `{}`, 200, false, []string{"/healthz", "/"}},
		{"oversized", strings.Repeat(" ", 64*1024) + `{"ok":true}`, `{}`, 200, false, []string{"/healthz"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var mu sync.Mutex
			var requests []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				requests = append(requests, r.URL.Path)
				mu.Unlock()
				w.WriteHeader(test.status)
				if r.URL.Path == "/healthz" {
					w.Write([]byte(test.health))
				} else {
					w.Write([]byte(test.version))
				}
			}))
			defer server.Close()
			u, _ := url.Parse(server.URL)
			ep, err := endpointForAddress(u.Host)
			if err != nil {
				t.Fatal(err)
			}
			client := probeClient(time.Second)
			defer client.CloseIdleConnections()
			metadata, err := probeBackend(context.Background(), client, ep)
			if (err == nil) != test.ready {
				t.Fatalf("metadata=%+v err=%v", metadata, err)
			}
			if test.ready && (metadata.APIOrigin != server.URL || *metadata.BackendVersion != "0.5.2") {
				t.Fatal(metadata)
			}
			mu.Lock()
			defer mu.Unlock()
			if !reflect.DeepEqual(requests, test.requests) {
				t.Fatal(requests)
			}
		})
	}
}

func TestProbeDoesNotRedirectOrUseProxy(t *testing.T) {
	redirectTarget := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("followed redirect/proxy") }))
	defer redirectTarget.Close()
	t.Setenv("HTTP_PROXY", redirectTarget.URL)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, redirectTarget.URL, http.StatusFound)
	}))
	defer server.Close()
	u, _ := url.Parse(server.URL)
	ep, _ := endpointForAddress(u.Host)
	client := probeClient(time.Second)
	defer client.CloseIdleConnections()
	if _, err := probeBackend(context.Background(), client, ep); err == nil {
		t.Fatal("accepted redirect")
	}
}

func waitStatus(t *testing.T, m *backendManager, state BackendState, code string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		status := m.currentStatus()
		actualCode := ""
		if status.Code != nil {
			actualCode = *status.Code
		}
		if status.State == state && actualCode == code {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("wanted %s/%s, got %+v", state, code, m.currentStatus())
}

func fakeLaunchSpec(t *testing.T, script string, ep endpoint) launchSpec {
	t.Helper()
	root := t.TempDir()
	executable := filepath.Join(root, "fake-executable")
	fixtureFile(t, executable, "#!/bin/sh\n"+script+"\n", 0700)
	return launchSpec{executable: executable, backendDir: root, configPath: filepath.Join(root, "config.json"), desktopOrigin: "mygo://localhost", endpoint: ep}
}

func TestSupervisorFailureCodesAndShutdown(t *testing.T) {
	for _, test := range []struct {
		name, script, code      string
		configError, startError bool
	}{
		{name: "invalid-config", code: "backend_config_invalid", configError: true},
		{name: "spawn-failure", code: "backend_start_failed", startError: true},
		{name: "early-exit", script: "exit 7", code: "backend_exited"},
		{name: "unhealthy-timeout", script: "exec cat >/dev/null", code: "backend_start_timeout"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`{"ok":false}`)) }))
			defer server.Close()
			u, _ := url.Parse(server.URL)
			ep, _ := endpointForAddress(u.Host)
			spec := fakeLaunchSpec(t, test.script, ep)
			if test.startError {
				spec.executable = filepath.Join(t.TempDir(), "missing-executable")
			}
			m := newBackendManager(testTiming())
			defer m.shutdown()
			m.start(func() (launchSpec, error) {
				if test.configError {
					return launchSpec{}, errors.New("private-config-path")
				}
				return spec, nil
			})
			waitStatus(t, m, BackendFailed, test.code)
			if _, err := m.runtimeMetadata(); err == nil || err.Error() != "backend_not_ready" {
				t.Fatal(err)
			}
			m.shutdown()
			m.shutdown()
			waitStatus(t, m, BackendStopped, "")
		})
	}
}

func TestSupervisorReadyThenExitClearsMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.Write([]byte(`{"ok":true}`))
		} else {
			w.Write([]byte(`{"version":"0.5.2"}`))
		}
	}))
	defer server.Close()
	u, _ := url.Parse(server.URL)
	ep, _ := endpointForAddress(u.Host)
	// The marker gives this test explicit control of the fake process's exit.
	marker := filepath.Join(t.TempDir(), "exit")
	spec := fakeLaunchSpec(t, `while [ ! -f "$LDOS_TEST_EXIT" ]; do sleep 0.02; done`, ep)
	spec.environment = map[string]string{"LDOS_TEST_EXIT": marker}
	m := newBackendManager(testTiming())
	defer m.shutdown()
	m.start(func() (launchSpec, error) { return spec, nil })
	waitStatus(t, m, BackendReady, "")
	metadata, err := m.runtimeMetadata()
	if err != nil || metadata.APIOrigin != server.URL {
		t.Fatal(metadata, err)
	}
	fixtureFile(t, marker, "", 0600)
	waitStatus(t, m, BackendFailed, "backend_exited")
	if _, err := m.runtimeMetadata(); err == nil {
		t.Fatal("exposed stale metadata")
	}
}

func TestShutdownDuringStartupAndBeforeStart(t *testing.T) {
	m := newBackendManager(testTiming())
	m.shutdown()
	m.start(func() (launchSpec, error) { t.Error("started after shutdown"); return launchSpec{}, nil })
	waitStatus(t, m, BackendStopped, "")
	m = newBackendManager(testTiming())
	entered, release := make(chan struct{}), make(chan struct{})
	m.start(func() (launchSpec, error) { close(entered); <-release; return launchSpec{}, errors.New("cancelled") })
	<-entered
	done := make(chan struct{})
	go func() { m.shutdown(); close(done) }()
	close(release)
	if !waitDone(done, time.Second) {
		t.Fatal("shutdown stuck")
	}
	waitStatus(t, m, BackendStopped, "")
}

func TestPublicProtocolAndBoundMethodSurface(t *testing.T) {
	version := "0.5.2"
	code := "backend_exited"
	for _, test := range []struct {
		value any
		want  string
	}{
		{RuntimeMetadata{"http://127.0.0.1:8787", &version}, `{"apiOrigin":"http://127.0.0.1:8787","backendVersion":"0.5.2"}`},
		{RuntimeMetadata{"http://127.0.0.1:8787", nil}, `{"apiOrigin":"http://127.0.0.1:8787","backendVersion":null}`},
		{BackendStatus{State: BackendStarting}, `{"state":"starting","code":null}`},
		{BackendStatus{State: BackendFailed, Code: &code}, `{"state":"failed","code":"backend_exited"}`},
	} {
		data, err := json.Marshal(test.value)
		if err != nil || string(data) != test.want {
			t.Fatal(string(data), err)
		}
	}
	typeOf := reflect.TypeOf(&Host{})
	var methods []string
	for i := 0; i < typeOf.NumMethod(); i++ {
		methods = append(methods, typeOf.Method(i).Name)
	}
	if !reflect.DeepEqual(methods, []string{"BackendStatus", "RevealInFileManager", "RuntimeMetadata", "SelectBrowserExecutable", "SelectDirectory"}) {
		t.Fatal(methods)
	}
	for _, path := range []string{"", "a\x00b", string([]byte{0xff})} {
		if err := (&Host{}).RevealInFileManager(path); err == nil || err.Error() != "invalid_reveal_path" {
			t.Fatal(err)
		}
	}
}
