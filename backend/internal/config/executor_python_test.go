package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGalleryExecutorPythonSelection(t *testing.T) {
	for _, tc := range []struct {
		name, configured, environment, expected string
		venv                                    bool
	}{
		{"system fallback", "", "", "python3", false},
		{"existing source venv", "", "", ".venv/bin/python", true},
		{"environment overrides default", "", "custom/bin/python", "custom/bin/python", true},
		{"explicit config wins", "chosen/bin/python", "custom/bin/python", "chosen/bin/python", true},
		{"command name stays portable", "python-special", "", "python-special", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			if tc.venv {
				path := filepath.Join(root, ".venv", "bin", "python")
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			path := filepath.Join(root, "config.json")
			if err := os.WriteFile(path, []byte(`{"gallery":{"python_executable":"`+tc.configured+`"}}`), 0600); err != nil {
				t.Fatal(err)
			}
			s, err := Load(path, func(key string) string {
				if key == "PYTHON" {
					return tc.environment
				}
				return ""
			})
			if err != nil {
				t.Fatal(err)
			}
			want := tc.expected
			if filepath.Base(want) != want {
				want = filepath.Join(root, want)
			}
			if s.Gallery.PythonExecutable != want {
				t.Fatalf("got %q, want %q", s.Gallery.PythonExecutable, want)
			}
		})
	}
}
