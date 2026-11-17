package datasets

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"ldos/backend/internal/store"
)

var galleryNamespace = uuid.NewSHA1(uuid.NameSpaceURL, []byte("ldos:gallery"))

func DirectoryID(sourceID, relative string) string {
	return uuid.NewSHA1(galleryNamespace, []byte("directory:"+sourceID+":"+relative)).String()
}
func safeRelative(p string) bool {
	if p == "" || strings.ContainsAny(p, "\\\x00") || strings.HasPrefix(p, "/") {
		return false
	}
	for _, v := range strings.Split(p, "/") {
		if v == "" || v == "." || v == ".." {
			return false
		}
	}
	return true
}
func excludedPath(p string) bool {
	for _, v := range strings.Split(strings.ToLower(p), "/") {
		switch v {
		case ".ldos", "duplicates", "keep", "trashed", "trash":
			return true
		}
		if strings.HasPrefix(v, ".ldos-") {
			return true
		}
	}
	return false
}

const rootSelect = `SELECT r.id AS root_id,r.dataset_id,r.source_id,r.directory_id,r.relative_path,r.origin,r.created_at,s.display_name AS source_display_name,s.availability AS source_availability,s.kind AS source_kind,d.name AS directory_name,d.recursive_asset_count,a.name AS asset_name FROM dataset_roots r JOIN gallery_sources s ON s.id=r.source_id LEFT JOIN gallery_directories d ON d.id=r.directory_id AND d.lifecycle_state='active' LEFT JOIN gallery_assets a ON a.source_id=r.source_id AND a.relative_path=r.relative_path AND a.lifecycle_state='active' AND a.dedup_visibility!='excluded'`

func projectRoot(r Record) Record {
	if r == nil {
		return nil
	}
	name := str(r["directory_name"])
	if name == "" {
		name = str(r["asset_name"])
	}
	if name == "" {
		name = path.Base(str(r["relative_path"]))
		if name == "." || name == "" {
			name = str(r["source_display_name"])
		}
	}
	r["name"] = name
	r["available"] = str(r["source_availability"]) == "available" && (r["directory_name"] != nil || r["asset_name"] != nil)
	r["recursive_asset_count"] = num(r["recursive_asset_count"])
	if r["asset_name"] != nil {
		r["recursive_asset_count"] = int64(1)
	}
	delete(r, "source_availability")
	delete(r, "directory_name")
	delete(r, "asset_name")
	return r
}
func (s *Service) ListRoots(ctx context.Context, id string) ([]Record, error) {
	if e := s.Require(ctx, id); e != nil {
		return nil, e
	}
	rows, e := s.deps.Store.QueryRows(ctx, rootSelect+" WHERE r.dataset_id=? ORDER BY r.created_at,r.id", id)
	for _, r := range rows {
		projectRoot(r)
	}
	return rows, e
}
func (s *Service) AttachDirectory(ctx context.Context, id, directory string, origins ...string) (Record, bool, error) {
	if e := s.Require(ctx, id); e != nil {
		return nil, false, e
	}
	r, e := s.deps.Store.QueryRow(ctx, "SELECT source_id,relative_path FROM gallery_directories WHERE id=?", directory)
	if e != nil {
		return nil, false, e
	}
	if r == nil {
		return nil, false, failure(404, "gallery_directory_not_found", "图库目录不存在")
	}
	origin := "library"
	if len(origins) > 0 {
		origin = origins[0]
	}
	return s.AttachRoot(ctx, id, str(r["source_id"]), str(r["relative_path"]), origin)
}
func (s *Service) AttachSource(ctx context.Context, id, source string, origins ...string) (Record, bool, error) {
	if e := s.Require(ctx, id); e != nil {
		return nil, false, e
	}
	r, e := s.deps.Store.QueryRow(ctx, "SELECT id FROM gallery_sources WHERE id=?", source)
	if e != nil {
		return nil, false, e
	}
	if r == nil {
		return nil, false, failure(404, "gallery_source_not_found", "图库来源不存在")
	}
	origin := "library"
	if len(origins) > 0 {
		origin = origins[0]
	}
	return s.AttachRoot(ctx, id, source, "", origin)
}
func (s *Service) AttachRoot(ctx context.Context, id, source, relative, origin string) (Record, bool, error) {
	if relative != "" && !safeRelative(relative) {
		return nil, false, failure(422, "dataset_root_path_invalid", "根目录路径不安全")
	}
	if excludedPath(relative) {
		return nil, false, failure(422, "dataset_root_path_excluded", "回收区、keep、duplicates 等目录不能作为数据集根目录")
	}
	if origin != "library" && origin != "import" && origin != "crawl" {
		return nil, false, validation()
	}
	rootID := uuid.NewString()
	created := false
	e := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if e := requireTx(ctx, tx, id); e != nil {
			return e
		}
		r, e := store.QueryRowTx(ctx, tx, "SELECT id FROM dataset_roots WHERE dataset_id=? AND source_id=? AND relative_path=?", id, source, relative)
		if e != nil {
			return e
		}
		if r != nil {
			rootID = str(r["id"])
			return nil
		}
		src, e := store.QueryRowTx(ctx, tx, "SELECT id FROM gallery_sources WHERE id=?", source)
		if e != nil {
			return e
		}
		if src == nil {
			return failure(404, "gallery_source_not_found", "图库来源不存在")
		}
		_, e = tx.ExecContext(ctx, "INSERT INTO dataset_roots(id,dataset_id,source_id,directory_id,relative_path,origin,created_at) VALUES(?,?,?,?,?,?,?)", rootID, id, source, DirectoryID(source, relative), relative, origin, now())
		if e != nil {
			return e
		}
		created = true
		return touch(ctx, tx, id)
	})
	if e != nil {
		return nil, false, e
	}
	r, e := s.deps.Store.QueryRow(ctx, rootSelect+" WHERE r.dataset_id=? AND r.id=?", id, rootID)
	if e != nil {
		return nil, false, e
	}
	_, e = s.EnqueueHashing(ctx, id)
	if e != nil {
		return nil, false, e
	}
	if created {
		s.PublishUpdated(id, "roots")
	}
	return projectRoot(r), created, nil
}
func (s *Service) DetachRoot(ctx context.Context, id, rootID string) error {
	e := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if e := requireTx(ctx, tx, id); e != nil {
			return e
		}
		r, e := tx.ExecContext(ctx, "DELETE FROM dataset_roots WHERE dataset_id=? AND id=?", id, rootID)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return failure(404, "dataset_root_not_found", "数据集根目录不存在")
		}
		return touch(ctx, tx, id)
	})
	if e == nil {
		s.PublishUpdated(id, "roots")
	}
	return e
}
func within(child, parent string) (string, bool) {
	r, e := filepath.Rel(parent, child)
	return filepath.ToSlash(r), e == nil && r != ".." && !strings.HasPrefix(r, ".."+string(os.PathSeparator))
}
func (s *Service) AttachPath(ctx context.Context, id, p, displayName string) (Record, bool, error) {
	if e := s.Require(ctx, id); e != nil {
		return nil, false, e
	}
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, e := os.UserHomeDir()
		if e != nil {
			return nil, false, e
		}
		p = filepath.Join(home, strings.TrimPrefix(p, "~/"))
	}
	if !filepath.IsAbs(p) {
		return nil, false, failure(422, "dataset_root_path_invalid", "导入目录必须是绝对路径")
	}
	real, e := filepath.EvalSymlinks(p)
	if e != nil {
		return nil, false, failure(404, "source_path_not_found", "导入目录不存在或不是普通目录")
	}
	st, e := os.Stat(real)
	if e != nil || !st.IsDir() {
		return nil, false, failure(404, "source_path_not_found", "导入目录不存在或不是普通目录")
	}
	sources, e := s.deps.Store.QueryRows(ctx, "SELECT id,root_path FROM gallery_sources ORDER BY created_at,id")
	if e != nil {
		return nil, false, e
	}
	for _, src := range sources {
		base, err := filepath.EvalSymlinks(str(src["root_path"]))
		if err != nil {
			base = filepath.Clean(str(src["root_path"]))
		}
		if rel, ok := within(real, base); ok {
			if rel == "." {
				rel = ""
			}
			if s.deps.Catalog != nil {
				if e := s.deps.Catalog.StartScan(ctx, str(src["id"])); e != nil {
					return nil, false, e
				}
			}
			return s.AttachRoot(ctx, id, str(src["id"]), rel, "import")
		}
		if _, ok := within(base, real); ok {
			return nil, false, failure(409, "source_path_conflict", "该目录包含已有的图库来源，请改为分别添加这些来源", Record{"relation": "ancestor"})
		}
	}
	if s.deps.Catalog == nil {
		return nil, false, failure(503, "catalog_unavailable", "图库服务尚未连接")
	}
	source, e := s.deps.Catalog.ImportSource(ctx, p, displayName)
	if e != nil {
		return nil, false, e
	}
	if e = s.deps.Catalog.StartScan(ctx, source); e != nil {
		return nil, false, e
	}
	return s.AttachRoot(ctx, id, source, "", "import")
}

func (s *Service) HashingStatus(ctx context.Context, id string) (Record, error) {
	members, e := s.MemberRows(ctx, id)
	if e != nil {
		return nil, e
	}
	return s.hashingStatus(members), nil
}
func (s *Service) hashingStatus(members []Record) Record {
	count, hashed := 0, 0
	for _, m := range members {
		if live(m) {
			count++
			if str(m["content_sha256"]) != "" {
				hashed++
			}
		}
	}
	s.mu.Lock()
	pending := len(s.hashes)
	s.mu.Unlock()
	return Record{"member_count": count, "hashed_count": hashed, "pending": pending}
}
func (s *Service) EnqueueHashing(ctx context.Context, id string, sourceIDs ...string) (Record, error) {
	members, e := s.MemberRows(ctx, id)
	if e != nil {
		return nil, e
	}
	s.mu.Lock()
	if !s.stopping {
		pass := s.hashPasses[id]
		for _, m := range members {
			if !live(m) || str(m["content_sha256"]) != "" || (len(sourceIDs) > 0 && str(m["source_id"]) != sourceIDs[0]) {
				continue
			}
			a := str(m["asset_id"])
			if pass == nil {
				pass = &hashPass{pending: map[string]bool{}}
				s.hashPasses[id] = pass
			}
			if !pass.pending[a] {
				pass.pending[a] = true
				pass.total++
			}
			if !s.hashes[a] {
				s.hashes[a] = true
				s.hashQueue = append(s.hashQueue, a)
			}
		}
		if len(s.hashQueue) > 0 && !s.hashRunning {
			s.hashRunning = true
			s.wg.Add(1)
			go s.hashLoop()
		}
	}
	s.mu.Unlock()
	return s.hashingStatus(members), nil
}
func (s *Service) hashLoop() {
	defer s.wg.Done()
	for {
		s.mu.Lock()
		if s.stopping || s.ctx.Err() != nil || len(s.hashQueue) == 0 {
			s.hashRunning = false
			s.hashes = map[string]bool{}
			s.hashQueue = nil
			s.mu.Unlock()
			return
		}
		id := s.hashQueue[0]
		s.hashQueue = s.hashQueue[1:]
		s.mu.Unlock()
		_, _ = s.HashAsset(s.ctx, id)
		s.mu.Lock()
		updated := []string{}
		for dataset, p := range s.hashPasses {
			if !p.pending[id] {
				continue
			}
			delete(p.pending, id)
			step := (p.total - len(p.pending)) * 4 / p.total
			if len(p.pending) == 0 || step > p.step {
				updated = append(updated, dataset)
				p.step = step
			}
			if len(p.pending) == 0 {
				delete(s.hashPasses, dataset)
			}
		}
		s.mu.Unlock()
		for _, d := range updated {
			s.PublishUpdated(d, "hashing")
		}
		s.mu.Lock()
		delete(s.hashes, id)
		s.mu.Unlock()
	}
}
func (s *Service) HashAsset(ctx context.Context, id string) (string, error) {
	a, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_assets WHERE id=?", id)
	if e != nil {
		return "unavailable", e
	}
	if a == nil || str(a["lifecycle_state"]) != "active" || str(a["content_sha256"]) != "" {
		return "skipped", nil
	}
	f, e := s.openSource(ctx, str(a["source_id"]), str(a["relative_path"]))
	if e != nil {
		return "unavailable", nil
	}
	defer f.Close()
	before, e := f.Stat()
	if e != nil {
		return "unavailable", e
	}
	if before.Size() != num(a["size_bytes"]) || before.ModTime().UnixNano() != num(a["modified_ns"]) {
		return "changed", nil
	}
	h := sha256.New()
	if _, e = copyContext(ctx, h, f); e != nil {
		return "unavailable", e
	}
	after, e := f.Stat()
	if e != nil {
		return "unavailable", e
	}
	if after.Size() != before.Size() || after.ModTime() != before.ModTime() {
		return "changed", nil
	}
	written := int64(0)
	e = s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		r, e := tx.ExecContext(ctx, "UPDATE gallery_assets SET content_sha256=? WHERE id=? AND lifecycle_state='active' AND content_sha256='' AND size_bytes=? AND modified_ns=?", hex.EncodeToString(h.Sum(nil)), id, before.Size(), before.ModTime().UnixNano())
		if e == nil {
			written, _ = r.RowsAffected()
		}
		return e
	})
	if e != nil {
		return "unavailable", e
	}
	if written == 0 {
		return "changed", nil
	}
	return "hashed", nil
}
func (s *Service) WaitHashing(ctx context.Context) error {
	t := time.NewTicker(time.Millisecond)
	defer t.Stop()
	for {
		s.mu.Lock()
		done := !s.hashRunning
		s.mu.Unlock()
		if done {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}
func copyContext(ctx context.Context, w io.Writer, r io.Reader) (int64, error) {
	buf := make([]byte, 1024*1024)
	var total int64
	for {
		if e := ctx.Err(); e != nil {
			return total, e
		}
		n, e := r.Read(buf)
		if n > 0 {
			written, err := w.Write(buf[:n])
			total += int64(written)
			if err != nil {
				return total, err
			}
			if written != n {
				return total, io.ErrShortWrite
			}
		}
		if errors.Is(e, io.EOF) {
			return total, nil
		}
		if e != nil {
			return total, e
		}
	}
}
func (s *Service) OnScanCommitted(ctx context.Context, source string) error {
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT DISTINCT dataset_id FROM dataset_roots WHERE source_id=?", source)
	if e != nil {
		return e
	}
	for _, r := range rows {
		id := str(r["dataset_id"])
		if _, e := s.EnqueueHashing(ctx, id, source); e != nil {
			return e
		}
		s.PublishUpdated(id, "members")
	}
	return nil
}

const crawlSelect = `SELECT c.dataset_id,c.batch_id,c.state,c.root_id,c.error_code,c.created_at,c.updated_at,b.status AS batch_status FROM dataset_crawls c LEFT JOIN crawl_batches b ON b.id=c.batch_id`

func (s *Service) ListCrawls(ctx context.Context, id string) ([]Record, error) {
	if e := s.Require(ctx, id); e != nil {
		return nil, e
	}
	return s.deps.Store.QueryRows(ctx, crawlSelect+" WHERE c.dataset_id=? ORDER BY c.created_at DESC,c.batch_id", id)
}
func (s *Service) StartCrawl(ctx context.Context, id string, request json.RawMessage, key string) (Record, error) {
	if e := s.Require(ctx, id); e != nil {
		return nil, e
	}
	if s.deps.Crawls == nil {
		return nil, failure(503, "crawl_service_unavailable", "采集服务尚未连接")
	}
	batch, e := s.deps.Crawls.StartCrawl(ctx, request, key)
	if e != nil {
		return nil, e
	}
	return s.RegisterCrawl(ctx, id, batch)
}
func (s *Service) RegisterCrawl(ctx context.Context, id, batch string) (Record, error) {
	if e := s.Require(ctx, id); e != nil {
		return nil, e
	}
	t := now()
	if e := s.exec(ctx, "INSERT INTO dataset_crawls(dataset_id,batch_id,state,created_at,updated_at) VALUES(?,?,'pending',?,?) ON CONFLICT(dataset_id,batch_id) DO NOTHING", id, batch, t, t); e != nil {
		return nil, e
	}
	s.PublishUpdated(id, "crawls")
	if e := s.OnBatchFinished(ctx, batch); e != nil {
		return nil, e
	}
	return s.deps.Store.QueryRow(ctx, crawlSelect+" WHERE c.dataset_id=? AND c.batch_id=?", id, batch)
}
func (s *Service) OnBatchFinished(ctx context.Context, batch string) error {
	rows, e := s.deps.Store.QueryRows(ctx, crawlSelect+" WHERE c.state='pending' AND c.batch_id=? ORDER BY c.created_at", batch)
	if e != nil {
		return e
	}
	for _, r := range rows {
		if _, err := s.attachCrawl(ctx, r); err != nil {
			slog.WarnContext(ctx, "dataset crawl attachment deferred", "dataset_id", r["dataset_id"], "batch_id", batch, "error", err)
		}
	}
	return nil
}
func (s *Service) attachCrawl(ctx context.Context, c Record) (bool, error) {
	id, batch := str(c["dataset_id"]), str(c["batch_id"])
	mark := func(state, root, code string) error {
		var r any
		if root != "" {
			r = root
		}
		return s.exec(ctx, "UPDATE dataset_crawls SET state=?,root_id=?,error_code=?,updated_at=? WHERE dataset_id=? AND batch_id=?", state, r, code, now(), id, batch)
	}
	b, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM crawl_batches WHERE id=?", batch)
	if e != nil {
		return false, e
	}
	if b == nil {
		return false, mark("failed", "", "crawl_not_found")
	}
	switch str(b["status"]) {
	case "succeeded", "completed_with_errors", "cancelled":
	default:
		return false, nil
	}
	src, e := s.deps.Store.QueryRow(ctx, "SELECT id FROM gallery_sources WHERE batch_id=?", batch)
	if e != nil {
		return false, e
	}
	source, relative := "", ""
	if src != nil {
		source = str(src["id"])
	} else {
		output := str(b["output_dir"])
		st, e := os.Stat(output)
		if e != nil || !st.IsDir() {
			return false, mark("failed", "", "crawl_output_missing")
		}
		output, e = filepath.EvalSymlinks(output)
		if e != nil {
			return false, e
		}
		sources, e := s.deps.Store.QueryRows(ctx, "SELECT id,root_path FROM gallery_sources ORDER BY created_at,id")
		if e != nil {
			return false, e
		}
		for _, candidate := range sources {
			base, e := filepath.EvalSymlinks(str(candidate["root_path"]))
			if e != nil {
				continue
			}
			if rel, ok := within(output, base); ok {
				source, relative = str(candidate["id"]), rel
				if rel == "." {
					relative = ""
				}
				if s.deps.Catalog != nil {
					if e := s.deps.Catalog.StartScan(ctx, source); e != nil {
						return false, e
					}
				}
				break
			}
		}
	}
	if source == "" {
		return false, mark("failed", "", "crawl_source_conflict")
	}
	r, _, e := s.AttachRoot(ctx, id, source, relative, "crawl")
	if e != nil {
		return false, e
	}
	return true, mark("attached", str(r["root_id"]), "")
}
func (s *Service) Reconcile(ctx context.Context) (Record, error) {
	rows, e := s.deps.Store.QueryRows(ctx, crawlSelect+" WHERE c.state='pending' ORDER BY c.created_at")
	if e != nil {
		return nil, e
	}
	attached, queued := 0, 0
	for _, r := range rows {
		ok, e := s.attachCrawl(ctx, r)
		if e != nil {
			slog.WarnContext(ctx, "dataset crawl reconciliation deferred", "dataset_id", r["dataset_id"], "batch_id", r["batch_id"], "error", e)
		}
		if ok {
			attached++
		}
	}
	datasets, e := s.deps.Store.QueryRows(ctx, "SELECT id FROM datasets")
	if e != nil {
		return nil, e
	}
	for _, d := range datasets {
		s.mu.Lock()
		before := len(s.hashes)
		s.mu.Unlock()
		_, e := s.EnqueueHashing(ctx, str(d["id"]))
		if e != nil {
			slog.WarnContext(ctx, "dataset hashing reconciliation deferred", "dataset_id", d["id"], "error", e)
			continue
		}
		s.mu.Lock()
		queued += max(0, len(s.hashes)-before)
		s.mu.Unlock()
	}
	return Record{"attached_crawls": attached, "queued_hashes": queued}, nil
}
