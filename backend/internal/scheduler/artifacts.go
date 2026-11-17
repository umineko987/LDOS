package scheduler

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// artifactTracker accepts gallery-dl stdout paths, not every preexisting file.
type artifactTracker struct {
	root         string
	mu           sync.Mutex
	paths        map[string]struct{}
	count, bytes int64
	lastWrite    time.Time
}

func newArtifacts(root string) *artifactTracker {
	return &artifactTracker{root: root, paths: map[string]struct{}{}}
}

func artifactPath(line, root string) (string, int64, bool) {
	path := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "# "))
	if !filepath.IsAbs(path) {
		return "", 0, false
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", 0, false
	}
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", 0, false
	}
	base, err = filepath.Abs(base)
	if err != nil {
		return "", 0, false
	}
	rel, err := filepath.Rel(base, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", 0, false
	}
	name := filepath.Base(resolved)
	if strings.HasSuffix(strings.ToLower(name), ".part") || strings.HasPrefix(name, ".gdl-activity-") {
		return "", 0, false
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", 0, false
	}
	return resolved, info.Size(), true
}

func (a *artifactTracker) observe(line string) (count, total int64, write bool) {
	path, size, ok := artifactPath(line, a.root)
	if !ok {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, exists := a.paths[path]; exists {
		return
	}
	a.paths[path] = struct{}{}
	a.count++
	a.bytes += size
	if time.Since(a.lastWrite) >= time.Second {
		a.lastWrite = time.Now()
		return a.count, a.bytes, true
	}
	return
}
func (a *artifactTracker) totals() (count, total int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for path := range a.paths {
		if _, size, ok := artifactPath(path, a.root); ok {
			count++
			total += size
		}
	}
	return
}
func (a *artifactTracker) seen() int { a.mu.Lock(); defer a.mu.Unlock(); return len(a.paths) }
