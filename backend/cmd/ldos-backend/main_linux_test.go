package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestConfigurationRequired(t *testing.T) {
	if err := run(nil); err == nil || !strings.Contains(err.Error(), "--config") {
		t.Fatal(err)
	}
}

func TestBackendProcessHelper(t *testing.T) {
	if os.Getenv("LDOS_GO_TEST_HELPER") != "1" {
		return
	}
	args := os.Args
	for i, arg := range args {
		if arg == "--" {
			if err := run(args[i+1:]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(2)
			}
			os.Exit(0)
		}
	}
	os.Exit(2)
}

func TestNativeServerWithoutPythonAndParentShutdown(t *testing.T) {
	dir := t.TempDir()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	configuration := map[string]any{"runtime_dir": filepath.Join(dir, "runtime"), "database_path": filepath.Join(dir, "runtime", "backend.sqlite3"), "server": map[string]any{"host": "127.0.0.1", "port": port, "cors_origins": []string{"mygo://localhost"}}}
	configuration["gallery"] = map[string]any{"migrate_default_auth": false}
	data, _ := json.Marshal(configuration)
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executors, err := filepath.Abs("../../executors")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestBackendProcessHelper$", "--", "--config", path, "--executors-dir", executors)
	// No Python or other external executables are available to this child.
	cmd.Env = []string{"PATH=" + filepath.Join(dir, "empty-path"), "LDOS_GO_TEST_HELPER=1", "GDL_BACKEND_PARENT_PIPE=1"}
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	exited := false
	t.Cleanup(func() {
		input.Close()
		if !exited {
			cmd.Process.Kill()
			<-done
		}
	})
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	deadline := time.Now().Add(10 * time.Second)
	for {
		response, err := client.Get(base + "/healthz")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == 200 {
				break
			}
		}
		select {
		case err := <-done:
			exited = true
			t.Fatalf("backend exited: %v %s", err, output.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("native backend did not become healthy")
		}
		time.Sleep(20 * time.Millisecond)
	}
	request := func(method, route, body string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(method, base+route, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "mygo://localhost")
		req.Header.Set("X-Request-ID", "integration-request")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var value map[string]any
		if err = json.NewDecoder(resp.Body).Decode(&value); err != nil {
			t.Fatal(err)
		}
		if resp.Header.Get("Access-Control-Allow-Origin") != "mygo://localhost" || resp.Header.Get("X-Request-ID") != "integration-request" {
			t.Fatal(resp.Header)
		}
		return resp.StatusCode, value
	}
	if status, body := request("GET", "/api/v1/auth?view=vault", ""); status != 200 || body["response_profile"] != "vault" || len(body["items"].([]any)) != 5 {
		t.Fatal(status, body)
	}
	if status, body := request("GET", "/api/v1/auth/pixiv?view=vault", ""); status != 200 || body["authorized"] != false || body["state"] != "required" {
		t.Fatal(status, body)
	}
	if status, body := request("PUT", "/api/v1/auth/proxy?view=vault", `{"proxy_url":"http://user:private-auth-password@127.0.0.1:7890"}`); status != 200 || body["proxy_url"] != "http://***@127.0.0.1:7890" {
		t.Fatal(status, body)
	}
	if status, body := request("DELETE", "/api/v1/auth/proxy?view=vault", ""); status != 200 || body["source"] != "none" {
		t.Fatal(status, body)
	}
	if status, body := request("PUT", "/api/v1/sites/policies/danbooru?view=policy", `{"max_concurrency":3,"retry_limit":1,"backoff_base_seconds":2,"proxy_mode":"direct"}`); status != 200 || body["has_override"] != true {
		t.Fatal(status, body)
	}
	if status, body := request("GET", "/api/v1/sites/policies/danbooru", ""); status != 200 || body["policy"].(map[string]any)["max_concurrency"] != float64(3) {
		t.Fatal(status, body)
	}
	if status, body := request("PUT", "/api/v1/settings/downloads", `{"hf_token":"test-token","hf_mirror":"https://mirror.example"}`); status != 200 || body["token_set"] != true {
		t.Fatal(status, body)
	}
	if status, body := request("GET", "/api/v1/settings/downloads", ""); status != 200 || body["token_set"] != true || body["hf_token"] != nil {
		t.Fatal(status, body)
	}
	if status, body := request("GET", "/api/v1/tasks", ""); status != 200 || len(body["items"].([]any)) != 0 {
		t.Fatal(status, body)
	}
	if status, body := request("GET", "/api/v1/jobs", ""); status != 200 || body["last_event_id"] == "" {
		t.Fatal(status, body)
	}
	// The native process is healthy without Python; missing required executors and
	// models are reported by live diagnostics, not a migration gate.
	if status, body := request("GET", "/readyz", ""); status != 503 || body["ready"] != false || body["reason"] != nil {
		t.Fatal(status, body)
	} else {
		components := body["components"].(map[string]any)
		for _, name := range []string{"process", "database", "scheduler", "ordered_crawls"} {
			if components[name].(map[string]any)["status"] != "ok" {
				t.Fatal(name, components[name])
			}
		}
	}
	client.Timeout = 15 * time.Second // SSE stays open across the 10s server shutdown budget.
	stream, err := client.Get(base + "/api/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	reader := bufio.NewReader(stream.Body)
	line, err := reader.ReadString('\n')
	if err != nil || line != "event: hello\n" {
		t.Fatal(line, err)
	}
	// net/http allows accepted connections with no request headers up to the
	// configured ReadHeaderTimeout; the test must honor the shutdown budget.
	idle, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer idle.Close()
	if err = input.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		exited = true
		if err != nil {
			t.Fatal(err, output.String())
		}
	case <-time.After(13 * time.Second): // 10s HTTP shutdown budget plus race-runtime exit overhead.
		t.Fatal("parent pipe close did not stop Go backend")
	}
	_, err = io.ReadAll(reader)
	if err != nil {
		t.Fatal("SSE did not close cleanly:", err)
	}
}
