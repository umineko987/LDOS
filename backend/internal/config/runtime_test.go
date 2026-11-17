package config

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestRuntimeUpdatesPreserveConcurrentSections(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"auth":{"unknown":true},"dedup":{"device":"cpu"},"unrelated":{"preserve":42}}`), 0600); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if err := SaveBrowserExecutable(context.Background(), path, "/usr/bin/chromium"); err != nil {
				t.Error(err)
			}
		}()
		go func() {
			defer wg.Done()
			if err := UpdateSection(context.Background(), path, "dedup", map[string]any{"enabled": true}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]map[string]any
	if err = json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	if v["auth"]["unknown"] != true || v["auth"]["chrome_executable"] != "/usr/bin/chromium" || v["dedup"]["enabled"] != true || v["dedup"]["device"] != "cpu" || v["unrelated"]["preserve"] != float64(42) {
		t.Fatal(string(data))
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0600 {
		t.Fatal("config lost private mode", err)
	}
	files, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(files) != 1 {
		t.Fatal("temporary config files leaked", files, err)
	}
}
