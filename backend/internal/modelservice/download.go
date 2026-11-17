package modelservice

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"ldos/backend/internal/downloads"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
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
			return errors.New("managed path contains symbolic link")
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
func fileSize(path string) int64 {
	st, e := os.Stat(path)
	if e != nil || !st.Mode().IsRegular() {
		return 0
	}
	return st.Size()
}
func atomicJSON(path string, value any) error {
	if e := privateDir(filepath.Dir(path)); e != nil {
		return e
	}
	if e := safePath(path); e != nil {
		return e
	}
	data, e := json.Marshal(value)
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".json-*")
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
func verifyFile(path string, spec modelFile) error {
	if e := safePath(path); e != nil {
		return e
	}
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return e
	}
	if !st.Mode().IsRegular() || st.Size() == 0 || spec.Size > 0 && st.Size() != spec.Size {
		return errors.New("model size mismatch")
	}
	if spec.Hash != "" {
		h := sha256.New()
		if _, e = io.Copy(h, f); e != nil {
			return e
		}
		if hex.EncodeToString(h.Sum(nil)) != spec.Hash {
			return errors.New("model SHA-256 mismatch")
		}
	}
	return nil
}
func (s *Service) client(env downloads.Environment) (*http.Client, error) {
	if s.deps.Options.Client != nil {
		return s.deps.Options.Client(env)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.ResponseHeaderTimeout = 120 * time.Second
	if env.Proxy != nil && *env.Proxy != "" {
		p, e := normalizeProxy(*env.Proxy)
		if e != nil {
			return nil, e
		}
		u, _ := url.Parse(p)
		transport.Proxy = http.ProxyURL(u)
	}
	return &http.Client{Transport: transport, Timeout: 30 * time.Minute}, nil
}
func normalizeProxy(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	bad := func() (string, error) {
		return "", failure(422, "invalid_model_proxy", "代理地址需为带端口的 HTTP 或 HTTPS 地址")
	}
	if len([]rune(value)) > 300 {
		return bad()
	}
	for _, r := range value {
		if r <= 32 || r == 127 {
			return bad()
		}
	}
	u, e := url.Parse(value)
	if e != nil || u.Hostname() == "" || u.Port() == "" || (u.Scheme != "http" && u.Scheme != "https") || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return bad()
	}
	port, e := strconv.Atoi(u.Port())
	if e != nil || port < 1 || port > 65535 {
		return bad()
	}
	u.Path = ""
	return u.String(), nil
}
func mirrorURL(value string, env downloads.Environment) string {
	if env.HFEndpoint != nil && strings.HasPrefix(value, "https://huggingface.co/") {
		return strings.TrimRight(*env.HFEndpoint, "/") + strings.TrimPrefix(value, "https://huggingface.co")
	}
	return value
}
func fetch(ctx context.Context, client *http.Client, url, path, token string, spec modelFile, progress func(int64, int64)) error {
	if e := privateDir(filepath.Dir(path)); e != nil {
		return e
	}
	if e := safePath(path); e != nil {
		return e
	}
	part := path + ".part"
	if e := safePath(part); e != nil {
		return e
	}
	if e := os.Remove(part); e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	req, e := http.NewRequestWithContext(ctx, "GET", url, nil)
	if e != nil {
		return e
	}
	req.Header.Set("User-Agent", "ldos-models/1.0")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, e := client.Do(req)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("model download HTTP %d", resp.StatusCode)
	}
	f, e := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	defer os.Remove(part)
	done, total := int64(0), max(0, resp.ContentLength)
	if progress != nil {
		progress(done, total)
	}
	buf := make([]byte, 1<<20)
	for {
		if e = ctx.Err(); e != nil {
			break
		}
		var n int
		n, e = resp.Body.Read(buf)
		if n > 0 {
			_, we := f.Write(buf[:n])
			done += int64(n)
			if we != nil {
				e = we
				break
			}
			if progress != nil {
				progress(done, total)
			}
		}
		if e != nil {
			if e == io.EOF {
				e = nil
			}
			break
		}
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if resp.ContentLength >= 0 && done != resp.ContentLength {
		return io.ErrUnexpectedEOF
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	if spec.Hash != "" || spec.Size > 0 {
		if e = verifyFile(part, spec); e != nil {
			return e
		}
	}
	return os.Rename(part, path)
}
func token(env downloads.Environment) string {
	if env.Token != nil {
		return *env.Token
	}
	return ""
}
func (s *Service) installBundle(ctx context.Context, client *http.Client, env downloads.Environment, spec Spec, accept bool, op *operation) error {
	root := s.deps.Settings.Tagger.ModelDir
	if installed(root, spec) {
		return nil
	}
	if e := privateDir(root); e != nil {
		return e
	}
	staging, e := os.MkdirTemp(root, ".staging-"+spec.Key+"-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(staging)
	endpoint := "https://huggingface.co"
	if env.HFEndpoint != nil {
		endpoint = strings.TrimRight(*env.HFEndpoint, "/")
	}
	for _, name := range spec.Files {
		e = fetch(ctx, client, endpoint+"/"+spec.Repo+"/resolve/"+spec.Revision+"/"+name, filepath.Join(staging, name), token(env), modelFile{}, func(done, total int64) {
			s.mu.Lock()
			s.state.Download[spec.Key] = Record{"file": filepath.Base(name), "done": done, "total": total}
			s.state.Message = spec.Key + " · " + name
			s.mu.Unlock()
			s.updateJob(op.job, spec.Key+" · "+name, int(done), int(total))
		})
		if e != nil {
			return e
		}
	}
	manifest := Record{"key": spec.Key, "repo": spec.Repo, "revision": spec.Revision, "adapter": spec.Adapter, "files": spec.Files, "license_accepted": spec.Gated && accept}
	if e = atomicJSON(filepath.Join(staging, "manifest.json"), manifest); e != nil {
		return e
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	if e = publishDirectory(staging, filepath.Join(root, spec.Key)); e != nil {
		return e
	}
	s.mu.Lock()
	delete(s.state.Download, spec.Key)
	s.mu.Unlock()
	return nil
}
func publishDirectory(staging, target string) error {
	if e := safePath(target); e != nil {
		return e
	}
	trash := ""
	if _, e := os.Stat(target); e == nil {
		t, e := os.MkdirTemp(filepath.Dir(target), ".trash-")
		if e != nil {
			return e
		}
		if e = os.Remove(t); e != nil {
			return e
		}
		trash = t
		if e = os.Rename(target, trash); e != nil {
			return e
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	if e := os.Rename(staging, target); e != nil {
		if trash != "" {
			_ = os.Rename(trash, target)
		}
		return e
	}
	if trash != "" {
		_ = os.RemoveAll(trash)
	}
	return nil
}
func (s *Service) installDINORepository(ctx context.Context, client *http.Client) error {
	root := filepath.Join(s.deps.Settings.Dedup.ModelDir, "torch", "hub")
	target := filepath.Join(root, dinoRepository)
	if safePath(target) != nil {
		return errors.New("unsafe DINO repository")
	}
	if fileSize(filepath.Join(target, "hubconf.py")) > 0 {
		return nil
	}
	if e := privateDir(root); e != nil {
		return e
	}
	stage, e := os.MkdirTemp(root, ".dino-*")
	if e != nil {
		return e
	}
	defer os.RemoveAll(stage)
	archive := filepath.Join(stage, "repo.zip")
	if e = fetch(ctx, client, "https://github.com/facebookresearch/dinov2/zipball/7764ea0f912e53c92e82eb78a2a1631e92725fc8", archive, "", modelFile{}, nil); e != nil {
		return e
	}
	z, e := zip.OpenReader(archive)
	if e != nil {
		return e
	}
	defer z.Close()
	unpacked := filepath.Join(stage, "repository")
	if e = privateDir(unpacked); e != nil {
		return e
	}
	for _, entry := range z.File {
		if e = ctx.Err(); e != nil {
			return e
		}
		parts := strings.SplitN(entry.Name, "/", 2)
		if len(parts) != 2 || parts[1] == "" {
			continue
		}
		rel := parts[1]
		if !filepath.IsLocal(rel) || strings.Contains(rel, "\\") || entry.Mode()&os.ModeSymlink != 0 {
			return errors.New("unsafe model repository archive")
		}
		p := filepath.Join(unpacked, rel)
		if entry.FileInfo().IsDir() {
			if e = privateDir(p); e != nil {
				return e
			}
			continue
		}
		if !entry.Mode().IsRegular() {
			return errors.New("invalid repository member")
		}
		if e = privateDir(filepath.Dir(p)); e != nil {
			return e
		}
		r, e := entry.Open()
		if e != nil {
			return e
		}
		f, e := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e == nil {
			_, e = io.Copy(f, r)
			ce := f.Close()
			if e == nil {
				e = ce
			}
		}
		r.Close()
		if e != nil {
			return e
		}
	}
	if fileSize(filepath.Join(unpacked, "hubconf.py")) == 0 {
		return errors.New("DINO repository missing hubconf.py")
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	return publishDirectory(unpacked, target)
}
