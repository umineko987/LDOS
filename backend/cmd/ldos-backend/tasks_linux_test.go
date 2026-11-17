package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"ldos/backend/internal/config"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 2 && os.Args[1] == "-m" {
		if os.Args[2] != "ldos_gallery.worker_entry" {
			os.Exit(10)
		}
		for _, arg := range os.Args[3:] {
			if arg == "--resolve" {
				fmt.Print(`{"site":"fixture","subcategory":"","extractor":"","supported":false,"host":"127.0.0.1"}`)
				os.Exit(0)
			}
		}
		if err := validateFixtureProxy(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(13)
		}
		fmt.Fprintln(os.Stderr, "fixture worker ready")
		url := os.Args[len(os.Args)-1]
		if strings.HasSuffix(url, "/blocking") {
			for {
				time.Sleep(time.Second)
			}
		}
		for i, arg := range os.Args {
			if arg == "--destination" && i+1 < len(os.Args) {
				path := filepath.Join(os.Args[i+1], "fixture.jpg")
				if err := os.WriteFile(path, []byte("nonvisual fixture bytes"), 0600); err != nil {
					os.Exit(11)
				}
				fmt.Println(path)
				os.Exit(0)
			}
		}
		os.Exit(12)
	}
	os.Exit(m.Run())
}

func TestTaskExecutionRequiresExplicitConfiguration(t *testing.T) {
	settings := config.Settings{Proxy: config.Proxy{Enabled: true}}
	if err := validateTaskExecution(settings, false, ""); err != nil {
		t.Fatal(err)
	}
	for _, args := range []struct {
		enabled bool
		root    string
	}{{false, "executor"}, {true, ""}} {
		if err := validateTaskExecution(settings, args.enabled, args.root); err == nil {
			t.Fatal("incomplete dependency accepted", args)
		}
	}
	if err := validateTaskExecution(settings, true, "executor"); err != nil {
		t.Fatal(err)
	}
}

func TestNativeTaskProcessLifecycle(t *testing.T) {
	for _, mode := range []string{"direct", "proxy"} {
		t.Run(mode, func(t *testing.T) { testNativeTaskProcessLifecycle(t, mode == "proxy") })
	}
}

func testNativeTaskProcessLifecycle(t *testing.T, useProxy bool) {
	root := t.TempDir()
	executors := filepath.Join(root, "executors")
	repo := filepath.Join(root, "gallery")
	for _, path := range []string{filepath.Join(executors, "ldos_gallery", "worker_entry.py"), filepath.Join(repo, "gallery_dl", "__init__.py")} {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	settings := map[string]any{
		"runtime_dir":         filepath.Join(root, "runtime"),
		"server":              map[string]any{"port": port, "allow_private_targets": true, "cors_origins": []string{"mygo://localhost"}},
		"proxy":               map[string]any{"enabled": false},
		"gallery":             map[string]any{"repo_path": repo, "cache_file": filepath.Join(root, "credentials/cache.sqlite3"), "python_executable": self, "terminate_grace_seconds": .2, "migrate_default_auth": false},
		"scheduler":           map[string]any{"poll_interval_seconds": .1, "shutdown_grace_seconds": 3},
		"default_site_policy": map[string]any{"proxy_mode": "direct"},
	}
	var proxyEnvironment []string
	proxyHits := func() int32 { return 0 }
	if useProxy {
		configuration, environment, hits := nativeProxyFixture(t, root)
		settings["proxy"] = configuration
		settings["default_site_policy"] = map[string]any{"proxy_mode": "required"}
		proxyEnvironment, proxyHits = environment, hits.Load
	}
	data, err := json.Marshal(settings)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, "config.json")
	if err := os.WriteFile(configPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(self, "-test.run=^TestBackendProcessHelper$", "--", "--allow-incomplete", "--enable-tasks", "--executors-dir", executors, "--config", configPath)
	cmd.Env = []string{"PATH=" + filepath.Join(root, "empty-path"), "LDOS_GO_TEST_HELPER=1", "GDL_BACKEND_PARENT_PIPE=1", "GORACE=atexit_sleep_ms=0"}
	cmd.Env = append(cmd.Env, proxyEnvironment...)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
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
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	defer client.CloseIdleConnections()
	deadline := time.Now().Add(10 * time.Second)
	for {
		resp, err := client.Get(base + "/healthz")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
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
			t.Fatal("native task backend not healthy")
		}
		time.Sleep(10 * time.Millisecond)
	}
	request := func(method, path, body string, expected int) map[string]any {
		t.Helper()
		req, err := http.NewRequest(method, base+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", "mygo://localhost")
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var row map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&row); err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != expected {
			t.Fatalf("%s %s: HTTP %d %#v", method, path, resp.StatusCode, row)
		}
		return row
	}
	catalog := request("GET", "/api/v1/search/sites", "", 200)
	if len(catalog["items"].([]any)) != 5 {
		t.Fatal(catalog)
	}
	request("POST", "/api/v1/search?view=desktop", `{"keyword":""}`, 422)
	request("GET", "/api/v1/auth/twitter?view=vault", "", 200)
	if useProxy {
		status := request("GET", "/api/v1/proxy/status", "", 200)
		if status["running"] != true || status["healthy"] != float64(1) || status["reload_required"] != false {
			t.Fatal(status)
		}
		if text, _ := json.Marshal(status); strings.Contains(string(text), "private-proxy-password") {
			t.Fatal("proxy status leaked upstream credentials")
		}
	}
	create := func(url string) string {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"url": url})
		return request("POST", "/api/v1/tasks", string(body), 202)["id"].(string)
	}
	wait := func(id, status string) map[string]any {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for {
			row := request("GET", "/api/v1/tasks/"+id, "", 200)
			if row["status"] == status && (status != "running" || row["pid"] != nil) {
				if status != "running" {
					return row
				}
				logs, _ := json.Marshal(request("GET", "/api/v1/tasks/"+id+"/logs", "", 200))
				if strings.Contains(string(logs), "fixture worker ready") {
					return row
				}
			}
			if time.Now().After(deadline) {
				t.Fatalf("wanted %s, got %#v", status, row)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	id := create("https://127.0.0.1/fixture")
	row := wait(id, "succeeded")
	if row["attempt_count"] != float64(1) {
		t.Fatal(row)
	}
	files := request("GET", "/api/v1/tasks/"+id+"/files", "", 200)["items"].([]any)
	if len(files) != 1 || files[0].(map[string]any)["path"] != "fixture.jpg" {
		t.Fatal(files)
	}
	request("POST", "/api/v1/tasks/"+id+"/retry", `{}`, 202)
	row = wait(id, "succeeded")
	if row["attempt_count"] != float64(2) {
		t.Fatal(row)
	}
	blocking := create("https://127.0.0.1/blocking")
	row = wait(blocking, "running")
	pid := int(row["pid"].(float64))
	if useProxy {
		status := request("GET", "/api/v1/proxy/status", "", 200)
		if status["leases"] != float64(1) {
			t.Fatal(status)
		}
		request("POST", "/api/v1/proxy/stop", `{}`, 409)
	}
	request("POST", "/api/v1/tasks/"+blocking+"/cancel", "", 200)
	wait(blocking, "cancelled")
	if err := syscall.Kill(pid, 0); err != syscall.ESRCH {
		t.Fatalf("cancel did not reap worker %d: %v", pid, err)
	}
	shutdownTask := create("https://127.0.0.1/blocking")
	row = wait(shutdownTask, "running")
	pid = int(row["pid"].(float64))
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		exited = true
		if err != nil {
			t.Fatal(err, output.String())
		}
	case <-time.After(15 * time.Second):
		t.Fatal("parent shutdown did not drain task workers")
	}
	if err := syscall.Kill(pid, 0); err != syscall.ESRCH {
		t.Fatalf("parent shutdown left worker %d: %v", pid, err)
	}
	if useProxy && proxyHits() < 8 {
		t.Fatalf("probes and workers did not traverse the authenticated proxy: %d CONNECT requests", proxyHits())
	}
}
