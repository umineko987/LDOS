package atlas

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func safePath(path string) error {
	absolute, e := filepath.Abs(path)
	if e != nil {
		return e
	}
	for p := absolute; ; p = filepath.Dir(p) {
		st, e := os.Lstat(p)
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			return e
		}
		if e == nil && st.Mode()&os.ModeSymlink != 0 {
			return errors.New("path contains symbolic link")
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	return nil
}
func privateDir(path string) error {
	if e := safePath(path); e != nil {
		return e
	}
	return os.MkdirAll(path, 0700)
}
func writeJSON(path string, v any) error {
	data, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return writeBytes(path, data)
}
func writeBytes(path string, data []byte) error {
	if e := safePath(path); e != nil {
		return e
	}
	if e := privateDir(filepath.Dir(path)); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".write-*")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, e = f.Write(data); e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	return os.Rename(tmp, path)
}
func readRecord(path string) (Record, error) {
	if e := safePath(path); e != nil {
		return nil, e
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	var v Record
	d := json.NewDecoder(f)
	d.UseNumber()
	if e = d.Decode(&v); e != nil {
		return nil, e
	}
	if v == nil {
		return nil, errors.New("JSON object required")
	}
	if d.Decode(new(any)) != io.EOF {
		return nil, errors.New("trailing JSON")
	}
	return v, nil
}
func (s *Service) current(id string) string {
	v, e := readRecord(filepath.Join(s.root, id, "current.json"))
	if e != nil {
		return ""
	}
	run := text(v["run_id"])
	if !runID.MatchString(run) {
		return ""
	}
	return run
}
func (s *Service) loadRun(id, run string) (loadedRun, bool) {
	if !runID.MatchString(run) {
		return loadedRun{}, false
	}
	key := id + "/" + run
	s.cacheMu.Lock()
	if v, ok := s.cache[key]; ok {
		s.cacheMu.Unlock()
		return v, true
	}
	s.cacheMu.Unlock()
	meta, e := readRecord(filepath.Join(s.runDir(id, run), "run.json"))
	if e != nil {
		return loadedRun{}, false
	}
	payload, e := readRecord(filepath.Join(s.runDir(id, run), "atlas.json"))
	if e != nil {
		return loadedRun{}, false
	}
	loaded := loadedRun{meta, payload}
	s.cacheMu.Lock()
	if _, ok := s.cache[key]; !ok {
		s.cacheOrder = append(s.cacheOrder, key)
	}
	s.cache[key] = loaded
	for len(s.cacheOrder) > 4 {
		delete(s.cache, s.cacheOrder[0])
		s.cacheOrder = s.cacheOrder[1:]
	}
	s.cacheMu.Unlock()
	return loaded, true
}
func (s *Service) discard(id, run string) {
	if !runID.MatchString(run) || run == s.current(id) {
		return
	}
	path := s.runDir(id, run)
	if safePath(filepath.Dir(path)) == nil {
		_ = os.RemoveAll(path)
	}
}
func (s *Service) prune(id string, keep map[string]bool) {
	dir := filepath.Join(s.root, id, "runs")
	if safePath(dir) != nil {
		return
	}
	entries, e := os.ReadDir(dir)
	if e != nil {
		return
	}
	for _, v := range entries {
		if !keep[v.Name()] {
			_ = os.RemoveAll(filepath.Join(dir, v.Name()))
		}
	}
	s.cacheMu.Lock()
	order := []string{}
	for _, key := range s.cacheOrder {
		parts := strings.SplitN(key, "/", 2)
		if parts[0] == id && !keep[parts[1]] {
			delete(s.cache, key)
		} else {
			order = append(order, key)
		}
	}
	s.cacheOrder = order
	s.cacheMu.Unlock()
}

// Called before workers start, so no in-progress directories are pruned.
func (s *Service) cleanupOrphans(ctx context.Context) error {
	if e := safePath(s.root); e != nil {
		return e
	}
	entries, e := os.ReadDir(s.root)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	if e != nil {
		return e
	}
	for _, entry := range entries {
		if e = ctx.Err(); e != nil {
			return e
		}
		id := entry.Name()
		path := filepath.Join(s.root, id)
		if !datasetID.MatchString(id) || !entry.IsDir() {
			_ = os.RemoveAll(path)
			continue
		}
		exists, e := s.deps.Store.QueryRow(ctx, "SELECT id FROM datasets WHERE id=?", id)
		if e != nil {
			return e
		}
		if exists == nil {
			_ = os.RemoveAll(path)
			continue
		}
		current := s.current(id)
		runs, e := os.ReadDir(filepath.Join(path, "runs"))
		if e != nil {
			continue
		}
		completed := []string{}
		for _, r := range runs {
			if r.Name() != current && runID.MatchString(r.Name()) {
				dir := s.runDir(id, r.Name())
				if safePath(dir) == nil && regularFile(filepath.Join(dir, "atlas.json")) && regularFile(filepath.Join(dir, "run.json")) {
					completed = append(completed, r.Name())
				}
			}
		}
		sort.Strings(completed)
		keep := map[string]bool{current: true}
		if len(completed) > 0 {
			keep[completed[len(completed)-1]] = true
		}
		s.prune(id, keep)
	}
	return nil
}
func (s *Service) openSource(ctx context.Context, sourceID, relative string) (*os.File, error) {
	if !filepath.IsLocal(relative) || strings.Contains(relative, "\\") {
		return nil, errors.New("unsafe relative image path")
	}
	if s.deps.Gallery.OpenImage != nil {
		return s.deps.Gallery.OpenImage(ctx, sourceID, relative)
	}
	source, e := s.deps.Store.QueryRow(ctx, "SELECT root_path,availability FROM gallery_sources WHERE id=?", sourceID)
	if e != nil {
		return nil, e
	}
	if source == nil || text(source["availability"]) != "available" {
		return nil, os.ErrNotExist
	}
	rootPath := text(source["root_path"])
	if e = safePath(rootPath); e != nil {
		return nil, e
	}
	root, e := os.OpenRoot(rootPath)
	if e != nil {
		return nil, e
	}
	defer root.Close()
	parts := strings.Split(filepath.ToSlash(relative), "/")
	p := ""
	for _, part := range parts {
		p = filepath.Join(p, part)
		st, e := root.Lstat(p)
		if e != nil {
			return nil, e
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("image path contains symbolic link")
		}
	}
	f, e := root.Open(relative)
	if e != nil {
		return nil, e
	}
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() {
		f.Close()
		return nil, errors.New("image is not a regular file")
	}
	return f, nil
}

type Sprite struct {
	File            *os.File
	MediaType, ETag string
	Immutable       bool
}

func (s *Service) Sprite(ctx context.Context, id string, index int, run string) (Sprite, error) {
	if _, e := s.require(ctx, id); e != nil {
		return Sprite{}, e
	}
	pinned := run != ""
	if run == "" {
		run = s.current(id)
	}
	missing := failure(404, "atlas_sprite_not_found", "雪碧图不存在")
	if run == "" {
		return Sprite{}, missing
	}
	if !runID.MatchString(run) {
		return Sprite{}, failure(422, "invalid_atlas_run", "地图运行编号无效")
	}
	loaded, ok := s.loadRun(id, run)
	sheets := array(object(loaded.payload["sprites"])["sheets"])
	if !ok || index < 0 || index >= len(sheets) {
		return Sprite{}, missing
	}
	relative := text(sheets[index])
	if !sheetName.MatchString(relative) {
		return Sprite{}, missing
	}
	path := filepath.Join(s.runDir(id, run), relative)
	if safePath(path) != nil {
		return Sprite{}, missing
	}
	root, e := os.OpenRoot(s.runDir(id, run))
	if e != nil {
		return Sprite{}, missing
	}
	defer root.Close()
	f, e := root.Open(relative)
	if e != nil {
		return Sprite{}, missing
	}
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() {
		f.Close()
		return Sprite{}, missing
	}
	media := "image/webp"
	if strings.HasSuffix(relative, ".png") {
		media = "image/png"
	}
	return Sprite{f, media, fmt.Sprintf("\"%s-%d\"", run, index), pinned}, nil
}
