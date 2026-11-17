package datasetstages

import (
	"fmt"
	"os"
	"syscall"
)

type candidateCache struct {
	key, etag string
	body      []byte
}

// The inference generation and SQLite/WAL stat tuples invalidate read-only score
// queries. This is the same cache boundary as Python; no model state is invented.
func (s *Service) candidateKey(id string, entries []Row, inputs []TagInput, floor float64) string {
	if s.deps.Tagger.CacheGeneration == nil {
		return ""
	}
	models := []any{}
	for _, e := range entries {
		models = append(models, []any{e["key"], e["revision"], e["adapter"], e["installed"]})
	}
	signatures := []string{}
	for _, suffix := range []string{"", "-wal"} {
		signature := "missing"
		if path := s.deps.Settings.Tagger.CachePath; path != "" {
			if info, e := os.Stat(path + suffix); e == nil {
				signature = fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
				if st, ok := info.Sys().(*syscall.Stat_t); ok {
					signature = fmt.Sprintf("%d:%d:", st.Dev, st.Ino) + signature
				}
			}
		}
		signatures = append(signatures, signature)
	}
	return encode([]any{id, models, inputs, floor, s.deps.Tagger.CacheGeneration(), signatures})
}
func (s *Service) cachedCandidate(key string) (string, []byte, bool) {
	if key == "" {
		return "", nil, false
	}
	for i, c := range s.candidates {
		if c.key == key {
			s.candidates = append(append(s.candidates[:i], s.candidates[i+1:]...), c)
			return c.etag, append([]byte(nil), c.body...), true
		}
	}
	return "", nil, false
}
func (s *Service) cacheCandidate(key, etag string, body []byte) {
	if key == "" {
		return
	}
	s.candidates = append(s.candidates, candidateCache{key, etag, append([]byte(nil), body...)})
	if len(s.candidates) > 4 {
		s.candidates = s.candidates[len(s.candidates)-4:]
	}
}
