package modelservice

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/config"
	"ldos/backend/internal/downloads"
)

func testService(t *testing.T) *Service {
	t.Helper()
	root := t.TempDir()
	settings := config.Settings{RuntimeDir: filepath.Join(root, "runtime"), Path: filepath.Join(root, "config.json"), Tagger: config.Tagger{Enabled: true, ModelDir: filepath.Join(root, "models"), CachePath: filepath.Join(root, "tags.sqlite3"), ShutdownGraceSeconds: .05}, Dedup: config.Dedup{ModelDir: filepath.Join(root, "dedup"), Device: "cpu", ShutdownGraceSeconds: .05}}
	must(t, os.WriteFile(settings.Path, []byte(`{"dedup":{"enabled":false},"browser":{"keep":true}}`), 0600))
	s, e := New(context.Background(), Dependencies{Settings: settings, Jobs: activity.NewRegistry(activity.NewBus(100))})
	must(t, e)
	t.Cleanup(func() { s.Stop() })
	return s
}
func must(t *testing.T, e error) {
	t.Helper()
	if e != nil {
		t.Fatal(e)
	}
}
func fixture(t *testing.T, s *Service, index int) Spec {
	t.Helper()
	spec := s.specs[index]
	dir := filepath.Join(s.deps.Settings.Tagger.ModelDir, spec.Key)
	for _, name := range spec.Files {
		must(t, privateDir(filepath.Dir(filepath.Join(dir, name))))
		must(t, os.WriteFile(filepath.Join(dir, name), []byte("fixture"), 0600))
	}
	if spec.Adapter == "wd_onnx" || spec.Adapter == "timm_canary" {
		must(t, os.WriteFile(filepath.Join(dir, "selected_tags.csv"), []byte("tag_id,name,category,count\n1,safe,9,1\n2,explicit,9,1\n3,blue_hair,0,1\n4,borderline,0,1\n5,A_(B),4,1\n"), 0600))
	}
	must(t, atomicJSON(filepath.Join(dir, "manifest.json"), Record{"key": spec.Key, "revision": spec.Revision, "license_accepted": true}))
	return spec
}
func scoreFixture(t *testing.T, s *Service, spec Spec, hash string, values []float32) {
	t.Helper()
	v, e := s.describe(spec)
	must(t, e)
	db, e := sql.Open("sqlite", s.deps.Settings.Tagger.CachePath)
	must(t, e)
	defer db.Close()
	_, e = db.Exec(`CREATE TABLE IF NOT EXISTS scores(model_fingerprint TEXT,file_hash TEXT,dimension INTEGER,vector BLOB,PRIMARY KEY(model_fingerprint,file_hash))`)
	must(t, e)
	raw := make([]byte, len(values)*4)
	for i, n := range values {
		binary.LittleEndian.PutUint32(raw[i*4:], math.Float32bits(n))
	}
	_, e = db.Exec("INSERT OR REPLACE INTO scores VALUES(?,?,?,?)", v.modelFingerprint, hash, len(values), raw)
	must(t, e)
}
func TestNativeQueryFloat32AndComposition(t *testing.T) {
	s := testService(t)
	spec := fixture(t, s, 0)
	hash := strings.Repeat("a", 64)
	scoreFixture(t, s, spec, hash, []float32{.1, .9, .7, .35, .95})
	lines := []string{hash + "\t/deleted/image.png", "/missing/image.png"}
	out, e := s.Query(context.Background(), "candidates", []string{spec.Key}, lines, []string{"--floor", "0.35"})
	must(t, e)
	rows := out[1]["models"].(Record)[spec.Key].([][]any)
	if len(rows) != 4 || rows[0][0] != "safe" || rows[1][0] != "explicit" || rows[2][0] != "blue_hair" {
		t.Fatalf("candidates: %#v", rows)
	}
	if out[2]["status"] != "unreadable" {
		t.Fatal(out)
	}
	v, e := s.describe(spec)
	must(t, e)
	h := sha256.Sum256([]byte("safe\x00rating\x00explicit\x00rating\x00blue_hair\x00general\x00borderline\x00general\x00A_(B)\x00character\x00"))
	if v.fingerprint != hex.EncodeToString(h[:]) {
		t.Fatal(v.fingerprint)
	}
	composed, e := s.Query(context.Background(), "compose", []string{spec.Key}, lines[:1], []string{"--escape-parens"})
	must(t, e)
	if composed[1]["caption"] != "explicit, blue hair, A_\\(B\\)" {
		t.Fatal(composed)
	}
	if fileSize(s.deps.Settings.Tagger.CachePath) == 0 {
		t.Fatal("cache vanished")
	}
	if _, e = s.Query(context.Background(), "compose", []string{spec.Key}, lines, []string{"--model-threshold", spec.Key, "general", "nan"}); e == nil {
		t.Fatal("accepted NaN")
	}
}
func TestVocabularyFamiliesAndMissingDimensions(t *testing.T) {
	s := testService(t)
	cl := fixture(t, s, 7)
	must(t, atomicJSON(filepath.Join(s.deps.Settings.Tagger.ModelDir, cl.Key, "v2_00/model_vocabulary.json"), Record{"num_tags": 2, "idx_to_tag": Record{"1": "girl", "0": "safe"}, "tag_to_category": Record{"safe": "Rating", "girl": "General"}}))
	v, e := s.describe(cl)
	must(t, e)
	if strings.Join(v.names, ",") != "safe,girl" || strings.Join(v.order, ",") != "rating,general" {
		t.Fatal(v)
	}
	pix := fixture(t, s, 6)
	must(t, atomicJSON(filepath.Join(s.deps.Settings.Tagger.ModelDir, pix.Key, "config.json"), Record{"tags": []string{"x", "safe"}, "tags_split": [][]any{{"style", 1}, {"rating", 1}}}))
	_, e = s.describe(pix)
	must(t, e)
	hash := strings.Repeat("b", 64)
	scoreFixture(t, s, cl, hash, []float32{1})
	out, e := s.Query(context.Background(), "candidates", []string{cl.Key}, []string{hash + "\t/gone"}, nil)
	must(t, e)
	if out[1]["status"] != "missing_scores" {
		t.Fatal(out)
	}
}

type testPool struct {
	mu                 sync.Mutex
	acquired, released int
	endpoint           string
}

func (p *testPool) Acquire(context.Context, string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.acquired++
	return p.endpoint, nil
}
func (p *testPool) Release(context.Context, string, bool, string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.released++
	return nil
}
func waitTag(t *testing.T, s *Service) {
	t.Helper()
	s.mu.Lock()
	op := s.tag
	s.mu.Unlock()
	if op != nil {
		select {
		case <-op.done:
		case <-time.After(5 * time.Second):
			t.Fatal("tagger did not finish")
		}
	}
}
func TestNativeInstallMirrorTokenLeaseAndGated(t *testing.T) {
	s := testService(t)
	secret := "hf_test_secret"
	var requests int
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+secret {
			t.Errorf("missing token")
		}
		if !strings.Contains(r.URL.Path, "/resolve/") {
			t.Errorf("unpinned URL %s", r.URL.Path)
		}
		mu.Lock()
		requests++
		mu.Unlock()
		_, _ = io.WriteString(w, "fixture")
	}))
	defer server.Close()
	pool := &testPool{endpoint: "http://127.0.0.1:1"}
	s.deps.Downloads = downloads.NewWithPool(s.deps.Settings.RuntimeDir, pool)
	_, e := s.deps.Downloads.Update(downloads.Update{HFMirror: downloads.String(server.URL), HFToken: downloads.String(secret), ProxyMode: downloads.String("pool")})
	must(t, e)
	s.deps.Options.Client = func(env downloads.Environment) (*http.Client, error) {
		if env.ProxySource != "pool" {
			t.Errorf("lease missing")
		}
		return server.Client(), nil
	}
	if _, e = s.Install(context.Background(), []string{"cl-tagger-v2"}, false); e == nil {
		t.Fatal("license not enforced")
	}
	result, e := s.Install(context.Background(), []string{"wd-vit-v3"}, false)
	must(t, e)
	if len(result["started"].([]Record)) != 1 {
		t.Fatal(result)
	}
	waitTag(t, s)
	if !installed(s.deps.Settings.Tagger.ModelDir, s.specs[0]) {
		t.Fatal(s.State())
	}
	pool.mu.Lock()
	a, r := pool.acquired, pool.released
	pool.mu.Unlock()
	mu.Lock()
	n := requests
	mu.Unlock()
	if a != 1 || r != 1 || n != 2 {
		t.Fatalf("requests/leases: %d %d %d", n, a, r)
	}
	data, _ := json.Marshal(s.State())
	if strings.Contains(string(data), secret) {
		t.Fatal("token leaked")
	}
}
func TestDownloadCancellationAndAtomicPublish(t *testing.T) {
	s := testService(t)
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100000")
		_, _ = w.Write([]byte("partial"))
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	_, e := s.Prepare(context.Background(), []string{"wd-vit-v3"}, false, downloads.Overrides{HFMirror: downloads.String(server.URL)})
	must(t, e)
	<-started
	_, e = s.Cancel(context.Background())
	must(t, e)
	if s.State().Message != "已取消" || installed(s.deps.Settings.Tagger.ModelDir, s.specs[0]) {
		t.Fatal(s.State())
	}
	entries, e := os.ReadDir(s.deps.Settings.Tagger.ModelDir)
	must(t, e)
	if len(entries) != 0 {
		t.Fatal(entries)
	}
}
func helperExecutable(t *testing.T, s *Service, mode string) {
	t.Helper()
	self, e := os.Executable()
	must(t, e)
	wrapper := filepath.Join(t.TempDir(), "fake-python")
	must(t, os.WriteFile(wrapper, []byte("#!/bin/sh\nexec '"+strings.ReplaceAll(self, "'", "'\\''")+"' -test.run=TestInferenceHelper -- \"$@\"\n"), 0700))
	s.deps.Settings.Tagger.PythonExecutable = wrapper
	s.deps.Settings.Tagger.CLIScript = filepath.Join(t.TempDir(), "cli.py")
	must(t, os.WriteFile(s.deps.Settings.Tagger.CLIScript, []byte("fixture"), 0600))
	t.Setenv("LDOS_MODEL_HELPER", mode)
}
func TestInferenceHelper(t *testing.T) {
	mode := os.Getenv("LDOS_MODEL_HELPER")
	if mode == "" {
		return
	}
	input, _ := io.ReadAll(os.Stdin)
	if !strings.Contains(strings.Join(os.Args, " "), "--no-captions") || len(input) == 0 {
		os.Exit(4)
	}
	fmt.Println(`{"type":"progress","stage":"inferring","done":1,"total":2}`)
	if mode == "wait" {
		time.Sleep(30 * time.Second)
	}
	if mode == "fail" {
		fmt.Fprintln(os.Stderr, "proxy https://secret:pass@example.com token=abc")
		os.Exit(4)
	}
	fmt.Println(`{"type":"done","command":"tag","total":2,"per_model":{},"decode_errors":[]}`)
	os.Exit(0)
}
func TestTagLifecycleAndCancellation(t *testing.T) {
	for _, mode := range []string{"success", "fail", "wait"} {
		t.Run(mode, func(t *testing.T) {
			s := testService(t)
			spec := fixture(t, s, 0)
			helperExecutable(t, s, mode)
			finished := make(chan Record, 1)
			result, e := s.Tag(context.Background(), TagRequest{Models: []string{spec.Key}, Inputs: []string{"/fixture/one.png", "/fixture/two.png"}, OnFinished: func(_ context.Context, r Record) error { finished <- r; return nil }})
			must(t, e)
			if mode == "wait" {
				_, e = s.Cancel(context.Background())
				must(t, e)
			}
			select {
			case summary := <-finished:
				want := map[string]string{"success": "succeeded", "fail": "failed", "wait": "cancelled"}[mode]
				if summary["status"] != want {
					t.Fatal(summary)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("no completion")
			}
			if s.CacheGeneration() != 1 || s.Busy() {
				t.Fatal("cache generation or lifecycle")
			}
			job := s.deps.Jobs.Get(text(result["job_id"]))
			if !job.Status.Terminal() {
				t.Fatal(job)
			}
			if strings.Contains(s.State().Message, "secret:pass") {
				t.Fatal("credential leak")
			}
		})
	}
}
func TestModelHTTPValidationAndStatus(t *testing.T) {
	s := testService(t)
	mux := http.NewServeMux()
	s.Register(mux)
	for _, tc := range []struct {
		method, path, body string
		code               int
	}{{"GET", "/api/v1/models", "", 200}, {"GET", "/api/v1/setup/models", "", 200}, {"GET", "/api/v1/tagger/models", "", 200}, {"POST", "/api/v1/models/install", `{"keys":[]}`, 422}, {"POST", "/api/v1/models/install", `{"keys":["unknown"]}`, 422}, {"POST", "/api/v1/models/install", `{"keys":["wd-vit-v3"],"extra":true}`, 422}, {"POST", "/api/v1/setup/models/install", `{"proxy_url":"http://secret:pass@localhost"}`, 422}} {
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != tc.code {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "secret:pass") {
			t.Fatal("proxy leak")
		}
	}
}

func TestSetupHelper(t *testing.T) {
	mode := os.Getenv("LDOS_SETUP_HELPER")
	if mode == "" {
		return
	}
	if strings.Contains(strings.Join(os.Args, " "), "--prepare-models") {
		os.Exit(0)
	}
	if mode == "fail" {
		fmt.Println(`{"completeness":{"available":false,"reason":"fixture inference failure"},"ccip":{"available":false,"reason":"fixture inference failure"}}`)
		os.Exit(1)
	}
	fmt.Println(`{"completeness":{"available":true,"reason":""},"ccip":{"available":true,"reason":""}}`)
	os.Exit(0)
}
func TestNativeDedupSetupAndSettings(t *testing.T) {
	for _, mode := range []string{"success", "fail"} {
		t.Run(mode, func(t *testing.T) {
			s := testService(t)
			self, e := os.Executable()
			must(t, e)
			wrapper := filepath.Join(t.TempDir(), "fake-python")
			must(t, os.WriteFile(wrapper, []byte("#!/bin/sh\nexec '"+strings.ReplaceAll(self, "'", "'\\''")+"' -test.run=TestSetupHelper -- \"$@\"\n"), 0700))
			s.deps.Settings.Dedup.PythonExecutable = wrapper
			s.deps.Settings.Dedup.CoreScript = filepath.Join(t.TempDir(), "core.py")
			must(t, os.WriteFile(s.deps.Settings.Dedup.CoreScript, []byte("fixture"), 0600))
			t.Setenv("LDOS_SETUP_HELPER", mode)
			payload := []byte("weight fixture")
			sum := sha256.Sum256(payload)
			hash := hex.EncodeToString(sum[:])
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
			defer server.Close()
			for name, files := range s.dedupFiles {
				for i, f := range files {
					f.Size = int64(len(payload))
					f.Hash = hash
					f.URL = server.URL + "/" + name
					files[i] = f
				}
				s.dedupFiles[name] = files
			}
			repository := filepath.Join(s.deps.Settings.Dedup.ModelDir, "torch", "hub", dinoRepository)
			must(t, privateDir(repository))
			must(t, os.WriteFile(filepath.Join(repository, "hubconf.py"), []byte("fixture"), 0600))
			enabled := false
			s.deps.OnDedupEnabled = func(context.Context) error { enabled = true; return nil }
			_, e = s.InstallSetup(context.Background(), "", []string{"dedup", "completeness"})
			must(t, e)
			s.mu.Lock()
			op := s.setup
			s.mu.Unlock()
			if op != nil {
				select {
				case <-op.done:
				case <-time.After(8 * time.Second):
					t.Fatal("setup did not finish")
				}
			}
			status, e := s.SetupStatus(context.Background())
			must(t, e)
			var saved Record
			must(t, readJSON(s.deps.Settings.Path, &saved))
			if saved["browser"].(map[string]any)["keep"] != true {
				t.Fatal("lost unrelated settings")
			}
			if mode == "success" {
				if status["phase"] != "ready" || !enabled || !s.Settings().Dedup.Enabled || saved["dedup"].(map[string]any)["enabled"] != true {
					t.Fatal(status, saved)
				}
			} else {
				if status["phase"] != "failed" || enabled || s.Settings().Dedup.Enabled || saved["dedup"].(map[string]any)["enabled"] != false {
					t.Fatal("enabled before all inference checks succeeded", status, saved)
				}
			}
		})
	}
}
func TestDownloadIntegrityAndProxyValidation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "corrupt") }))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "model")
	e := fetch(context.Background(), server.Client(), server.URL, path, "", modelFile{Hash: strings.Repeat("0", 64)}, nil)
	if e == nil {
		t.Fatal("corruption accepted")
	}
	if _, e = os.Stat(path); !os.IsNotExist(e) {
		t.Fatal("published invalid download")
	}
	if _, e = os.Stat(path + ".part"); !os.IsNotExist(e) {
		t.Fatal("partial download leaked")
	}
	for _, value := range []string{"http://localhost:99999", "http://localhost:0", "ftp://localhost:80", "http://localhost:80/path", "http://localhost:80?token=secret"} {
		if _, e = normalizeProxy(value); e == nil {
			t.Fatalf("accepted %q", value)
		}
	}
}
