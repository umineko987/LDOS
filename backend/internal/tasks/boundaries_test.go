package tasks

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestOutputDirRejectsEscapes(t *testing.T) {
	root := t.TempDir()
	runtime := filepath.Join(root, "runtime")
	output := filepath.Join(runtime, "downloads")
	outside := filepath.Join(root, "outside")
	for _, dir := range []string{output, outside} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(output, "escape")); err != nil {
		t.Fatal(err)
	}
	config := Config{RuntimeDir: runtime, OutputRoot: output, AllowedOutputRoots: []string{output}}
	for _, tc := range []struct {
		name    string
		input   string
		escaped string
	}{
		{"traversal", "../traversal", filepath.Join(runtime, "traversal")},
		{"absolute sibling prefix", output + "-sibling/task", output + "-sibling/task"},
		{"symlink ancestor", filepath.Join("escape", "new", "task"), filepath.Join(outside, "new")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if path, err := config.outputDir(tc.input, "task-id"); err == nil || path != "" {
				t.Fatalf("outputDir(%q) escaped: path=%q err=%v", tc.input, path, err)
			}
			if _, err := os.Stat(tc.escaped); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("rejected path created %q: %v", tc.escaped, err)
			}
		})
	}
}

func TestOutputDirPermissions(t *testing.T) {
	root := t.TempDir()
	runtime := filepath.Join(root, "runtime")
	output := filepath.Join(runtime, "downloads")
	external := filepath.Join(root, "external")
	for _, dir := range []string{output, external} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	existingRuntime := filepath.Join(output, "existing")
	existingExternal := filepath.Join(external, "existing")
	for _, dir := range []string{existingRuntime, existingExternal, external} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		// Set explicitly so the test never depends on or changes process umask.
		if err := os.Chmod(dir, 0751); err != nil {
			t.Fatal(err)
		}
	}
	config := Config{RuntimeDir: runtime, OutputRoot: output, AllowedOutputRoots: []string{output, external}}
	for _, tc := range []struct {
		name     string
		input    string
		wantPath string
		wantMode os.FileMode
	}{
		{"new runtime directory", "", filepath.Join(output, "task-id"), 0700},
		{"existing runtime becomes private", existingRuntime, existingRuntime, 0700},
		{"existing external remains unchanged", existingExternal, existingExternal, 0751},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path, err := config.outputDir(tc.input, "task-id")
			if err != nil || path != tc.wantPath {
				t.Fatalf("outputDir(%q) = %q, %v; want %q", tc.input, path, err, tc.wantPath)
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if !info.IsDir() || info.Mode().Perm() != tc.wantMode {
				t.Fatalf("directory mode = %v, want %04o", info.Mode(), tc.wantMode)
			}
		})
	}
	info, err := os.Stat(external)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0751 {
		t.Fatalf("external parent mode changed to %04o", info.Mode().Perm())
	}
}

func TestAllowedFileResolvesProjectRelativeAndRejectsSymlinkEscape(t *testing.T) {
	project := t.TempDir()
	allowed := filepath.Join(project, "credentials")
	cookies := writeTaskTestFile(t, filepath.Join(allowed, "cookies.txt"))
	outside := writeTaskTestFile(t, filepath.Join(project, "outside.txt"))
	link := filepath.Join(allowed, "escape.txt")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	resolved, err := allowedFile(filepath.Join("credentials", "cookies.txt"), project, []string{allowed}, "cookies_file")
	if err != nil || resolved != cookies {
		t.Fatalf("project relative credential = %q, %v; want %q", resolved, err, cookies)
	}
	if resolved, err := allowedFile(link, project, []string{allowed}, "cookies_file"); err == nil || resolved != "" {
		t.Fatalf("credential symlink escaped: %q, %v", resolved, err)
	}
}

func TestValidateTargetDoesNotResolveDNS(t *testing.T) {
	for _, strict := range []bool{true, false} {
		lookup := func(context.Context, string) ([]string, error) {
			t.Fatal("admission must not resolve or inspect DNS answers")
			return []string{"127.0.0.1"}, errors.New("DNS unavailable")
		}
		if err := ValidateTarget(context.Background(), "twitter:r:https://unresolvable.example.invalid/item", false, strict, lookup); err != nil {
			t.Fatal("legacy strict setting restored DNS checks", strict, err)
		}
		for _, target := range []string{"https://", "ftp://example.test/image", "https://example.test:99999/"} {
			if err := ValidateTarget(context.Background(), target, false, strict, lookup); err == nil {
				t.Fatal("invalid URL admitted", target)
			}
		}
	}
}

func TestValidateTargetAllowPrivateBypassesDNS(t *testing.T) {
	lookup := func(context.Context, string) ([]string, error) {
		t.Fatal("allowPrivate must bypass DNS")
		return nil, errors.New("unexpected DNS")
	}
	if err := ValidateTarget(context.Background(), "http://localhost/private", true, true, lookup); err != nil {
		t.Fatalf("allowPrivate rejected localhost: %v", err)
	}
}
