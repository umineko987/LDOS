//go:build linux

package gallerycatalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/sys/unix"
	"golang.org/x/text/cases"
)

var MissingDiskVersion = digest([]byte("ldos:missing:v1"))

func digest(b []byte) string { d := sha256.Sum256(b); return hex.EncodeToString(d[:]) }
func SupportedImage(name string) bool {
	ext := strings.ToLower(path.Ext(name))
	return len(name) > len(ext) && (ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".webp")
}
func CaptionRelativePath(image string) string {
	return strings.TrimSuffix(image, path.Ext(image)) + ".txt"
}
func parentRelative(p string) string {
	d := path.Dir(p)
	if d == "." {
		return ""
	}
	return d
}
func reserved(p string) bool {
	for _, v := range strings.Split(p, "/") {
		if v == ".ldos" || strings.HasPrefix(v, ".ldos-copy-") {
			return true
		}
	}
	return false
}
func ValidateRelativePath(p string, allowRoot bool) error {
	if p == "" && allowRoot {
		return nil
	}
	if p == "" || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00") || strings.Contains(p, ":") {
		return failure("unsafe_source_path", 409)
	}
	for _, v := range strings.Split(p, "/") {
		if v == "" || v == "." || v == ".." || strings.HasSuffix(v, " ") || strings.HasSuffix(v, ".") {
			return failure("unsafe_source_path", 409)
		}
		for _, r := range v {
			if r < 32 || r == 127 {
				return failure("unsafe_source_path", 409)
			}
		}
	}
	return nil
}
func NaturalSortKey(name string) string {
	chars := []rune(cases.Fold().String(name))
	var b strings.Builder
	for i := 0; i < len(chars); {
		j := i
		if unicode.IsDigit(chars[i]) {
			for j < len(chars) && unicode.IsDigit(chars[j]) {
				j++
			}
			n := j - i
			if n > 99 {
				n = 99
			}
			fmt.Fprintf(&b, "%02d", n)
		} else {
			for j < len(chars) && !unicode.IsDigit(chars[j]) {
				j++
			}
		}
		b.WriteString(string(chars[i:j]))
		i = j
	}
	return b.String()
}
func rootRelation(left, right string) string {
	if left == right {
		return "same"
	}
	if strings.HasPrefix(left, strings.TrimSuffix(right, "/")+"/") {
		return "descendant"
	}
	if strings.HasPrefix(right, strings.TrimSuffix(left, "/")+"/") {
		return "ancestor"
	}
	return "disjoint"
}

type fileIdentity struct {
	Device   uint64 `json:"device"`
	Inode    uint64 `json:"inode"`
	Mode     uint32 `json:"mode"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified_ns"`
}

func identity(st *unix.Stat_t) fileIdentity {
	return fileIdentity{uint64(st.Dev), st.Ino, st.Mode, st.Size, st.Mtim.Sec*1e9 + st.Mtim.Nsec}
}
func (a fileIdentity) sameFile(b fileIdentity) bool {
	return a.Device == b.Device && a.Inode == b.Inode && a.Mode == b.Mode
}
func (a fileIdentity) sameSnapshot(b fileIdentity) bool {
	return a.sameFile(b) && a.Size == b.Size && a.Modified == b.Modified
}
func fileStat(f *os.File) (fileIdentity, error) {
	var st unix.Stat_t
	e := unix.Fstat(int(f.Fd()), &st)
	return identity(&st), e
}

// SafeRoot holds a no-follow descriptor for each operation. Every parent is
// opened relative to the held root; root/parent replacement is checked again at
// publication. Returned files remain safe even when a path is concurrently moved.
type SafeRoot struct {
	path     string
	fd       int
	identity fileIdentity
}

func OpenSafeRoot(root string) (*SafeRoot, error) {
	if !filepath.IsAbs(root) {
		return nil, failure("unsafe_source_path", 409)
	}
	root = filepath.Clean(root)
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, component := range strings.Split(strings.TrimPrefix(root, "/"), "/") {
		if component == "" {
			continue
		}
		next, e := unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if e != nil {
			return nil, pathError(e)
		}
		fd = next
	}
	var st unix.Stat_t
	if err = unix.Fstat(fd, &st); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return &SafeRoot{path: root, fd: fd, identity: identity(&st)}, nil
}
func pathError(err error) error {
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		return &Error{Code: "unsafe_source_path", Status: 409, Cause: err}
	}
	return err
}
func (r *SafeRoot) Close() error { return unix.Close(r.fd) }
func (r *SafeRoot) AssertCurrent() error {
	current, e := OpenSafeRoot(r.path)
	if e != nil {
		return wrapIO(e, "unsafe_source_path")
	}
	defer current.Close()
	if !r.identity.sameFile(current.identity) {
		return failure("source_changed", 409)
	}
	return nil
}
func (r *SafeRoot) directory(relative string, create bool) (int, error) {
	if e := ValidateRelativePath(relative, true); e != nil {
		return -1, e
	}
	fd, e := unix.Dup(r.fd)
	if e != nil {
		return -1, e
	}
	unix.CloseOnExec(fd)
	for _, part := range strings.Split(relative, "/") {
		if part == "" {
			continue
		}
		if create {
			e = unix.Mkdirat(fd, part, 0755)
			if e != nil && !errors.Is(e, unix.EEXIST) {
				unix.Close(fd)
				return -1, e
			}
		}
		next, e := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if e != nil {
			return -1, pathError(e)
		}
		fd = next
	}
	return fd, nil
}
func (r *SafeRoot) parent(relative string, create bool) (int, string, error) {
	if e := ValidateRelativePath(relative, false); e != nil {
		return -1, "", e
	}
	fd, e := r.directory(parentRelative(relative), create)
	return fd, path.Base(relative), e
}
func (r *SafeRoot) sameParent(relative string, fd int) error {
	if e := r.AssertCurrent(); e != nil {
		return e
	}
	current, e := r.directory(parentRelative(relative), false)
	if e != nil {
		return pathError(e)
	}
	defer unix.Close(current)
	var a, b unix.Stat_t
	if e = unix.Fstat(fd, &a); e != nil {
		return e
	}
	if e = unix.Fstat(current, &b); e != nil {
		return e
	}
	if !identity(&a).sameFile(identity(&b)) {
		return failure("unsafe_source_path", 409)
	}
	return nil
}
func (r *SafeRoot) Open(relative string) (*os.File, error) {
	fd, name, e := r.parent(relative, false)
	if e != nil {
		return nil, e
	}
	defer unix.Close(fd)
	out, e := unix.Openat(fd, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if e != nil {
		return nil, pathError(e)
	}
	f := os.NewFile(uintptr(out), name)
	st, e := fileStat(f)
	if e != nil || st.Mode&unix.S_IFMT != unix.S_IFREG {
		f.Close()
		return nil, failure("unsafe_source_path", 409)
	}
	return f, nil
}
func (r *SafeRoot) Stat(relative string) (fileIdentity, error) {
	if relative == "" {
		return r.identity, nil
	}
	fd, name, e := r.parent(relative, false)
	if e != nil {
		return fileIdentity{}, e
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	e = unix.Fstatat(fd, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	if e != nil {
		return fileIdentity{}, pathError(e)
	}
	if st.Mode&unix.S_IFMT == unix.S_IFLNK {
		return fileIdentity{}, failure("unsafe_source_path", 409)
	}
	return identity(&st), nil
}
func (r *SafeRoot) Exists(relative string) (bool, error) {
	_, e := r.Stat(relative)
	if errors.Is(e, os.ErrNotExist) {
		return false, nil
	}
	return e == nil, e
}
func (r *SafeRoot) Mkdir(relative string) (fileIdentity, error) {
	fd, name, e := r.parent(relative, false)
	if e != nil {
		return fileIdentity{}, e
	}
	defer unix.Close(fd)
	if e = r.sameParent(relative, fd); e != nil {
		return fileIdentity{}, e
	}
	if e = unix.Mkdirat(fd, name, 0755); e != nil {
		return fileIdentity{}, e
	}
	if e = unix.Fsync(fd); e != nil {
		return fileIdentity{}, e
	}
	return r.Stat(relative)
}
func (r *SafeRoot) MkdirAll(relative string) error {
	if e := r.AssertCurrent(); e != nil {
		return e
	}
	fd, e := r.directory(relative, true)
	if e != nil {
		return e
	}
	defer unix.Close(fd)
	return unix.Fsync(fd)
}
func (r *SafeRoot) create(relative string) (*os.File, error) {
	fd, name, e := r.parent(relative, false)
	if e != nil {
		return nil, e
	}
	defer unix.Close(fd)
	if e = r.sameParent(relative, fd); e != nil {
		return nil, e
	}
	out, e := unix.Openat(fd, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0644)
	if e != nil {
		return nil, pathError(e)
	}
	return os.NewFile(uintptr(out), name), nil
}
func (r *SafeRoot) Remove(relative string, expected *fileIdentity) error {
	fd, name, e := r.parent(relative, false)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	if e != nil {
		return e
	}
	defer unix.Close(fd)
	if e = r.sameParent(relative, fd); e != nil {
		return e
	}
	var st unix.Stat_t
	e = unix.Fstatat(fd, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	if e != nil {
		return e
	}
	found := identity(&st)
	if expected != nil && !expected.sameFile(found) {
		return failure("target_path_changed", 409)
	}
	if st.Mode&unix.S_IFMT == unix.S_IFLNK {
		return failure("unsafe_source_path", 409)
	}
	flags := 0
	if st.Mode&unix.S_IFMT == unix.S_IFDIR {
		flags = unix.AT_REMOVEDIR
	}
	if e = unix.Unlinkat(fd, name, flags); e != nil {
		return e
	}
	return unix.Fsync(fd)
}
func (r *SafeRoot) RenameTo(relative string, target *SafeRoot, destination string, expected *fileIdentity) error {
	a, an, e := r.parent(relative, false)
	if e != nil {
		return e
	}
	defer unix.Close(a)
	b, bn, e := target.parent(destination, true)
	if e != nil {
		return e
	}
	defer unix.Close(b)
	if e = r.sameParent(relative, a); e != nil {
		return e
	}
	if e = target.sameParent(destination, b); e != nil {
		return e
	}
	var st unix.Stat_t
	if e = unix.Fstatat(a, an, &st, unix.AT_SYMLINK_NOFOLLOW); e != nil {
		return e
	}
	if st.Mode&unix.S_IFMT == unix.S_IFLNK {
		return failure("unsafe_source_path", 409)
	}
	if expected != nil && !expected.sameFile(identity(&st)) {
		return failure("source_changed", 409)
	}
	if e = unix.Renameat2(a, an, b, bn, unix.RENAME_NOREPLACE); e != nil {
		if errors.Is(e, unix.EEXIST) {
			return failure("target_name_conflict", 409)
		}
		return pathError(e)
	}
	if e = unix.Fsync(a); e != nil {
		return e
	}
	return unix.Fsync(b)
}
func opaqueDiskVersion(st fileIdentity, hash []byte) string {
	h := sha256.New()
	h.Write([]byte("ldos:disk-version:v1\x00"))
	for _, v := range []string{strconv.FormatUint(st.Device, 10), strconv.FormatUint(st.Inode, 10), strconv.FormatUint(uint64(st.Mode), 10), strconv.FormatInt(st.Size, 10), strconv.FormatInt(st.Modified, 10)} {
		h.Write([]byte(v))
		h.Write([]byte{0})
	}
	h.Write(hash)
	return hex.EncodeToString(h.Sum(nil))
}
func (r *SafeRoot) ReadVersion(relative string, maxBytes int64) ([]byte, string, fileIdentity, error) {
	f, e := r.Open(relative)
	if errors.Is(e, os.ErrNotExist) {
		return nil, MissingDiskVersion, fileIdentity{}, nil
	}
	if e != nil {
		return nil, "", fileIdentity{}, e
	}
	defer f.Close()
	st, e := fileStat(f)
	if e != nil {
		return nil, "", st, e
	}
	b, e := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if e != nil {
		return nil, "", st, e
	}
	if int64(len(b)) > maxBytes {
		return nil, "", st, failure("txt_file_too_large", 409)
	}
	after, e := fileStat(f)
	if e != nil || !st.sameSnapshot(after) {
		return nil, "", st, failure("source_changed", 409)
	}
	hash := sha256.Sum256(b)
	return b, opaqueDiskVersion(st, hash[:]), st, nil
}
func (r *SafeRoot) AtomicWrite(relative string, payload []byte, expected string) (string, fileIdentity, error) {
	_, version, _, e := r.ReadVersion(relative, 8<<20)
	if e != nil {
		return "", fileIdentity{}, e
	}
	if version != expected {
		return "", fileIdentity{}, failure("txt_disk_conflict", 409)
	}
	temp := path.Join(parentRelative(relative), ".ldos-txt-"+id())
	f, e := r.create(temp)
	if e != nil {
		return "", fileIdentity{}, e
	}
	owned, e := fileStat(f)
	if e != nil {
		f.Close()
		return "", fileIdentity{}, e
	}
	defer r.Remove(temp, &owned)
	if _, e = f.Write(payload); e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return "", fileIdentity{}, e
	}
	fd, name, e := r.parent(relative, false)
	if e != nil {
		return "", fileIdentity{}, e
	}
	defer unix.Close(fd)
	_, version, _, e = r.ReadVersion(relative, 8<<20)
	if e != nil {
		return "", fileIdentity{}, e
	}
	if version != expected {
		return "", fileIdentity{}, failure("txt_disk_conflict", 409)
	}
	if e = r.sameParent(relative, fd); e != nil {
		return "", fileIdentity{}, e
	}
	if expected == MissingDiskVersion {
		e = unix.Renameat2(fd, path.Base(temp), fd, name, unix.RENAME_NOREPLACE)
	} else {
		e = unix.Renameat(fd, path.Base(temp), fd, name)
	}
	if e != nil {
		return "", fileIdentity{}, pathError(e)
	}
	if e = unix.Fsync(fd); e != nil {
		return "", fileIdentity{}, e
	}
	_, version, st, e := r.ReadVersion(relative, 8<<20)
	return version, st, e
}
func (r *SafeRoot) ReadDir(relative string) ([]os.DirEntry, error) {
	fd, e := r.directory(relative, false)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), relative)
	defer f.Close()
	entries, e := f.ReadDir(-1)
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, e
}
func (r *SafeRoot) removeTree(relative string, owned fileIdentity) error {
	st, e := r.Stat(relative)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	if e != nil {
		return e
	}
	if !st.sameFile(owned) {
		return failure("target_path_changed", 409)
	}
	if st.Mode&unix.S_IFMT == unix.S_IFDIR {
		entries, e := r.ReadDir(relative)
		if e != nil {
			return e
		}
		for _, entry := range entries {
			child := path.Join(relative, entry.Name())
			st, e := r.Stat(child)
			if e != nil {
				return e
			}
			if e = r.removeTree(child, st); e != nil {
				return e
			}
		}
	}
	return r.Remove(relative, &owned)
}
func (s *Service) OpenSource(ctx context.Context, sourceID string) (*SafeRoot, error) {
	row, e := s.Source(ctx, sourceID)
	if e != nil {
		return nil, e
	}
	if str(row, "availability") == "offline" {
		return nil, failure("source_offline", 409)
	}
	if str(row, "availability") == "conflict" {
		return nil, failure("source_conflict", 409)
	}
	r, e := OpenSafeRoot(str(row, "root_path"))
	if errors.Is(e, os.ErrNotExist) {
		return nil, failure("source_offline", 409)
	}
	return r, wrapIO(e, "unsafe_source_path")
}
func (s *Service) SafeImagePath(ctx context.Context, assetID string) (string, error) {
	return s.safeAssetPath(ctx, assetID, false)
}
func (s *Service) SafeCaptionPath(ctx context.Context, assetID string) (string, error) {
	return s.safeAssetPath(ctx, assetID, true)
}
func (s *Service) safeAssetPath(ctx context.Context, assetID string, caption bool) (string, error) {
	a, e := s.GetImage(ctx, assetID)
	if e != nil {
		return "", e
	}
	if str(a, "lifecycle_state") != "active" {
		return "", failure("asset_not_active", 409)
	}
	r, e := s.OpenSource(ctx, str(a, "source_id"))
	if e != nil {
		return "", e
	}
	defer r.Close()
	rel := str(a, "relative_path")
	if caption {
		rel = CaptionRelativePath(rel)
	}
	_, e = r.Stat(rel)
	if e != nil && !(caption && errors.Is(e, os.ErrNotExist)) {
		return "", wrapIO(e, "asset_file_missing")
	}
	return filepath.Join(r.path, filepath.FromSlash(rel)), nil
}
func (s *Service) OpenImage(ctx context.Context, assetID string) (*os.File, Row, error) {
	a, e := s.GetImage(ctx, assetID)
	if e != nil {
		return nil, nil, e
	}
	if str(a, "lifecycle_state") != "active" {
		return nil, nil, failure("asset_not_active", 409)
	}
	r, e := s.OpenSource(ctx, str(a, "source_id"))
	if e != nil {
		return nil, nil, e
	}
	defer r.Close()
	f, e := r.Open(str(a, "relative_path"))
	return f, a, wrapIO(e, "asset_file_missing")
}
