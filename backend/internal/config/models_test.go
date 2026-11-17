package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestModelSettingsAndDesktopRelocation(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "config.json")
	content := `{"runtime_dir":"/obsolete/runtime","database_path":"/obsolete/db","gallery":{"python_executable":"/obsolete/python"},"dedup":{"device":"cpu","workers":2,"model_dir":"/obsolete/models"},"tagger":{"cache_path":"/obsolete/tags.sqlite3"}}`
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	plain, err := Load(path, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if plain.Dedup.Device != "cpu" || plain.Dedup.Workers != 2 || !plain.Dedup.Enabled || !plain.Tagger.Enabled || plain.Scheduler.MaxConcurrentBatches != 4 {
		t.Fatal(plain.Dedup, plain.Tagger, plain.Scheduler)
	}
	resource, data := filepath.Join(root, "resources"), filepath.Join(root, "data")
	python := filepath.Join(resource, "runtime/python/bin/python3.13")
	env := map[string]string{"LDOS_DESKTOP_RESOURCE_ROOT": resource, "LDOS_DESKTOP_DATA_ROOT": data, "LDOS_DESKTOP_PYTHON": python}
	loaded, err := Load(path, func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if loaded.DatabasePath != filepath.Join(data, "runtime/backend.sqlite3") || loaded.Gallery.PythonExecutable != python || loaded.Gallery.MigrateDefaultAuth || loaded.Tagger.CachePath != filepath.Join(data, "tagger/tags.sqlite3") || loaded.Dedup.ModelDir != filepath.Join(data, "models") || loaded.Dedup.WorkerScript != filepath.Join(resource, "app/dedup_review_worker.py") {
		t.Fatal("packaged paths were not relocated")
	}
	if loaded.Dedup.Device != "cpu" || loaded.Dedup.Workers != 2 {
		t.Fatal("relocation lost user model choices")
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != content {
		t.Fatal("relocation rewrote user configuration", err)
	}
	delete(env, "LDOS_DESKTOP_PYTHON")
	if _, err := Load(path, func(k string) string { return env[k] }); err == nil {
		t.Fatal("incomplete distribution accepted")
	}
	env["LDOS_DESKTOP_PYTHON"] = "/usr/bin/python3"
	if _, err := Load(path, func(k string) string { return env[k] }); err == nil {
		t.Fatal("uncontrolled executor accepted")
	}
}

func TestModelResourceBoundaries(t *testing.T) {
	for _, content := range []string{`{"dedup":{"device":"invalid"}}`, `{"dedup":{"workers":65}}`, `{"dedup":{"torch_threads":129}}`, `{"dedup":{"torch_interop_threads":17}}`, `{"dedup":{"deep_batch_size":129}}`, `{"dedup":{"neighbor_block_size":8193}}`, `{"scheduler":{"max_concurrent_batches":0}}`} {
		path := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path, func(string) string { return "" }); err == nil {
			t.Fatalf("accepted %s", content)
		}
	}
}
