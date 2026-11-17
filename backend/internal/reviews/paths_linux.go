package reviews

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// Root-relative descriptor traversal rejects links at every component, including
// ancestors of the registered root. Hashes implement the worker's disk-version
// wire contract and are used to reject changed content before physical mutation.
type safeRoot struct {
	file *os.File
	path string
}

func relativeParts(p string) ([]string, error) {
	if p == "" || filepath.IsAbs(p) || strings.ContainsRune(p, 0) || strings.Contains(p, "\\") {
		return nil, conflict("审核图片路径无效")
	}
	parts := strings.Split(p, "/")
	for _, v := range parts {
		if v == "" || v == "." || v == ".." {
			return nil, conflict("审核图片路径无效")
		}
	}
	return parts, nil
}
func openRoot(path string) (*safeRoot, error) {
	abs, e := filepath.Abs(path)
	if e != nil {
		return nil, e
	}
	fd, e := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if e != nil {
		return nil, e
	}
	for _, part := range strings.Split(strings.TrimPrefix(abs, "/"), "/") {
		if part == "" {
			continue
		}
		next, err := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			return nil, err
		}
		fd = next
	}
	return &safeRoot{file: os.NewFile(uintptr(fd), abs), path: abs}, nil
}
func (r *safeRoot) close() { _ = r.file.Close() }
func (r *safeRoot) identity() ([]uint64, error) {
	var st unix.Stat_t
	if e := unix.Fstat(int(r.file.Fd()), &st); e != nil {
		return nil, e
	}
	return []uint64{st.Dev, st.Ino}, nil
}
func (r *safeRoot) parent(relative string, create bool) (*os.File, string, error) {
	parts, e := relativeParts(relative)
	if e != nil {
		return nil, "", e
	}
	fd, e := unix.Dup(int(r.file.Fd()))
	if e != nil {
		return nil, "", e
	}
	unix.CloseOnExec(fd)
	for _, part := range parts[:len(parts)-1] {
		next, err := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if errors.Is(err, unix.ENOENT) && create {
			if err = unix.Mkdirat(fd, part, 0700); err == nil || errors.Is(err, unix.EEXIST) {
				next, err = unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			}
		}
		unix.Close(fd)
		if err != nil {
			return nil, "", err
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), relative), parts[len(parts)-1], nil
}
func (r *safeRoot) open(relative string) (*os.File, error) {
	parent, name, e := r.parent(relative, false)
	if e != nil {
		return nil, e
	}
	defer parent.Close()
	fd, e := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), name)
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() {
		f.Close()
		if e != nil {
			return nil, e
		}
		return nil, conflict("审核图片不是普通文件")
	}
	return f, nil
}
func (r *safeRoot) exists(relative string) (bool, error) {
	p, n, e := r.parent(relative, false)
	if errors.Is(e, unix.ENOENT) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	defer p.Close()
	var st unix.Stat_t
	e = unix.Fstatat(int(p.Fd()), n, &st, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(e, unix.ENOENT) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if st.Mode&unix.S_IFMT == unix.S_IFLNK {
		return false, conflict("审核文件路径包含链接")
	}
	return true, nil
}
func (r *safeRoot) diskVersion(ctx context.Context, path string, missing bool) (string, error) {
	f, e := r.open(path)
	if errors.Is(e, unix.ENOENT) && missing {
		v := sha256.Sum256([]byte("ldos:missing:v1"))
		return hex.EncodeToString(v[:]), nil
	}
	if e != nil {
		return "", e
	}
	defer f.Close()
	return heldDiskVersion(ctx, f)
}
func heldDiskVersion(ctx context.Context, f *os.File) (string, error) {
	pos, e := f.Seek(0, io.SeekCurrent)
	if e != nil {
		return "", e
	}
	defer f.Seek(pos, io.SeekStart)
	if _, e = f.Seek(0, io.SeekStart); e != nil {
		return "", e
	}
	var st unix.Stat_t
	if e = unix.Fstat(int(f.Fd()), &st); e != nil {
		return "", e
	}
	payload := sha256.New()
	buf := make([]byte, 128*1024)
	for {
		if e = ctx.Err(); e != nil {
			return "", e
		}
		n, err := f.Read(buf)
		if n > 0 {
			payload.Write(buf[:n])
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", err
		}
	}
	digest := sha256.New()
	digest.Write([]byte("ldos:disk-version:v1\x00"))
	for _, v := range []string{fmt.Sprint(st.Dev), fmt.Sprint(st.Ino), fmt.Sprint(st.Mode), fmt.Sprint(st.Size), fmt.Sprint(st.Mtim.Sec*1e9 + st.Mtim.Nsec)} {
		digest.Write([]byte(v))
		digest.Write([]byte{0})
	}
	digest.Write(payload.Sum(nil))
	return hex.EncodeToString(digest.Sum(nil)), nil
}
func checkPath(root, relative string) error {
	parts, e := relativeParts(relative)
	if e != nil {
		return e
	}
	r, e := openRoot(root)
	if e != nil {
		return e
	}
	defer r.close()
	current := ""
	for _, v := range parts {
		if current != "" {
			current += "/"
		}
		current += v
		exists, e := r.exists(current)
		if e != nil {
			return e
		}
		if !exists {
			return nil
		}
	}
	return nil
}
func privateDirectory(path string) error {
	abs, e := filepath.Abs(path)
	if e != nil {
		return e
	}
	parent, e := openRoot("/")
	if e != nil {
		return e
	}
	defer parent.close()
	p, _, e := parent.parent(strings.TrimPrefix(abs, "/")+"/file", true)
	if e != nil {
		return e
	}
	defer p.Close()
	return p.Chmod(0700)
}
func privateFile(path string) (*os.File, error) {
	r, e := openRoot(filepath.Dir(path))
	if e != nil {
		return nil, e
	}
	defer r.close()
	fd, e := unix.Openat(int(r.file.Fd()), filepath.Base(path), unix.O_WRONLY|unix.O_CREAT|unix.O_TRUNC|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), path)
	if e = f.Chmod(0600); e != nil {
		f.Close()
		return nil, e
	}
	return f, nil
}
func (r *safeRoot) move(source, target string) error {
	from, name, e := r.parent(source, false)
	if e != nil {
		return e
	}
	defer from.Close()
	to, dest, e := r.parent(target, true)
	if e != nil {
		return e
	}
	defer to.Close()
	var st unix.Stat_t
	if e = unix.Fstatat(int(from.Fd()), name, &st, unix.AT_SYMLINK_NOFOLLOW); e != nil {
		return e
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return conflict("审核文件不是普通文件")
	}
	return unix.Renameat2(int(from.Fd()), name, int(to.Fd()), dest, unix.RENAME_NOREPLACE)
}
