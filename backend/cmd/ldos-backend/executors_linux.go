package main

import (
	"errors"
	"os"
	"path/filepath"

	"ldos/backend/internal/config"
)

// Resolve the isolated executor alongside installed resources or the checked-out
// Go backend. No candidate is the retired gdl_backend business package.
func resolveExecutors(settings config.Settings, explicit string) (string, error) {
	return findExecutors(settings, explicit, os.Getenv("LDOS_DESKTOP_RESOURCE_ROOT"), os.Executable)
}
func findExecutors(settings config.Settings, explicit, resourceRoot string, executable func() (string, error)) (string, error) {
	candidates := []string{}
	if explicit != "" {
		candidates = append(candidates, explicit)
	} else {
		if resourceRoot != "" {
			candidates = append(candidates, filepath.Join(resourceRoot, "app", "executors"))
		}
		if path, err := executable(); err == nil {
			base := filepath.Dir(path)
			candidates = append(candidates, filepath.Join(base, "..", "app", "executors"), filepath.Join(base, "..", "executors"), filepath.Join(base, "executors"))
		}
		candidates = append(candidates, filepath.Join(settings.ProjectDir, "executors"), filepath.Join(settings.WorkspaceDir, "backend", "executors"), filepath.Join(settings.ProjectDir, "..", "backend", "executors"))
	}
	for _, candidate := range candidates {
		path, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		st, err := os.Stat(filepath.Join(path, "ldos_gallery", "worker_entry.py"))
		if err == nil && st.Mode().IsRegular() {
			return filepath.Clean(path), nil
		}
	}
	return "", errors.New("isolated gallery-dl executor not found; install app/executors or pass --executors-dir pointing to backend/executors")
}
