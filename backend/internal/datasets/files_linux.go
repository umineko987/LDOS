package datasets

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

type fileIdentity [2]uint64

func identity(f *os.File) (fileIdentity, error) {
	var st unix.Stat_t
	e := unix.Fstat(int(f.Fd()), &st)
	return fileIdentity{uint64(st.Dev), st.Ino}, e
}
func identityAt(parent *os.File, name string) (fileIdentity, error) {
	if !safeLeaf(name) {
		return fileIdentity{}, failure(409, "target_path_unsafe", "目标路径不安全")
	}
	var st unix.Stat_t
	e := unix.Fstatat(int(parent.Fd()), name, &st, unix.AT_SYMLINK_NOFOLLOW)
	if e != nil {
		return fileIdentity{}, e
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return fileIdentity{}, failure(409, "target_path_changed", "目标名字已被占用")
	}
	return fileIdentity{uint64(st.Dev), st.Ino}, nil
}
func safeLeaf(p string) bool { return safeRelative(p) && !strings.Contains(p, "/") }
func openDirectory(p string) (*os.File, error) {
	if !filepath.IsAbs(p) || strings.ContainsRune(p, 0) {
		return nil, failure(409, "target_path_unsafe", "路径必须是绝对路径")
	}
	fd, e := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if e != nil {
		return nil, e
	}
	for _, part := range strings.Split(p, "/") {
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
	return os.NewFile(uintptr(fd), p), nil
}
func openChildDirectory(parent *os.File, name string) (*os.File, error) {
	if !safeLeaf(name) {
		return nil, failure(409, "target_path_unsafe", "路径不安全")
	}
	fd, e := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if e != nil {
		return nil, e
	}
	return os.NewFile(uintptr(fd), name), nil
}
func openRelative(root *os.File, relative string) (*os.File, error) {
	if !safeRelative(relative) {
		return nil, failure(409, "source_changed", "来源路径不安全")
	}
	parts := strings.Split(relative, "/")
	fd, e := unix.Dup(int(root.Fd()))
	if e != nil {
		return nil, e
	}
	unix.CloseOnExec(fd)
	for i, part := range parts {
		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC
		if i < len(parts)-1 {
			flags |= unix.O_DIRECTORY
		} else {
			flags |= unix.O_NONBLOCK
		}
		next, err := unix.Openat(fd, part, flags, 0)
		unix.Close(fd)
		if err != nil {
			return nil, err
		}
		fd = next
	}
	f := os.NewFile(uintptr(fd), relative)
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() {
		f.Close()
		if e != nil {
			return nil, e
		}
		return nil, failure(409, "source_changed", "来源不是普通文件")
	}
	return f, nil
}
func createOutput(dir *os.File, name string) (*os.File, error) {
	if !safeLeaf(name) {
		return nil, failure(409, "target_path_unsafe", "目标文件名不安全")
	}
	fd, e := unix.Openat(int(dir.Fd()), name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if e != nil {
		if errors.Is(e, unix.EEXIST) || errors.Is(e, unix.ELOOP) {
			return nil, failure(409, "target_path_unsafe", "目标文件名已被占用")
		}
		return nil, e
	}
	return os.NewFile(uintptr(fd), name), nil
}
func verifyOutput(dir *os.File, name string, file *os.File) error {
	expected, err := identity(file)
	if err != nil {
		return err
	}
	var st unix.Stat_t
	if err = unix.Fstatat(int(dir.Fd()), name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil || st.Mode&unix.S_IFMT != unix.S_IFREG || (fileIdentity{uint64(st.Dev), st.Ino}) != expected || st.Nlink != 1 {
		return failure(409, "target_path_changed", "输出文件已变化")
	}
	return nil
}
func removeOutput(dir *os.File, name string) error {
	if !safeLeaf(name) {
		return failure(409, "target_path_unsafe", "目标文件名不安全")
	}
	e := unix.Unlinkat(int(dir.Fd()), name, 0)
	if errors.Is(e, unix.ENOENT) {
		return nil
	}
	return e
}
func verifyDirectory(p string, expected fileIdentity) error {
	f, e := openDirectory(p)
	if e != nil {
		return failure(409, "target_root_changed", "导出目录已变化")
	}
	defer f.Close()
	actual, e := identity(f)
	if e != nil {
		return e
	}
	if actual != expected {
		return failure(409, "target_root_changed", "导出目录已变化")
	}
	return nil
}
func verifyOwned(parent *os.File, name string, expected fileIdentity) error {
	actual, e := identityAt(parent, name)
	if e != nil || actual != expected {
		return failure(409, "target_path_changed", "临时目录已变化")
	}
	return nil
}

// removeOwned never follows links and never removes a directory unless its
// descriptor identity matches the durable staging_created event.
func removeOwned(parent *os.File, name string, expected fileIdentity) error {
	if e := verifyOwned(parent, name, expected); e != nil {
		return e
	}
	dir, e := openChildDirectory(parent, name)
	if e != nil {
		return e
	}
	defer dir.Close()
	actual, e := identity(dir)
	if e != nil || actual != expected {
		return failure(409, "target_path_changed", "临时目录已变化")
	}
	if e = removeContents(dir); e != nil {
		return e
	}
	if e = verifyOwned(parent, name, expected); e != nil {
		return e
	}
	if e = unix.Unlinkat(int(parent.Fd()), name, unix.AT_REMOVEDIR); e != nil {
		return e
	}
	return parent.Sync()
}
func removeContents(dir *os.File) error {
	entries, e := dir.ReadDir(-1)
	if e != nil {
		return e
	}
	for _, entry := range entries {
		if entry.IsDir() {
			child, e := openChildDirectory(dir, entry.Name())
			if e != nil {
				return e
			}
			id, e := identity(child)
			child.Close()
			if e != nil {
				return e
			}
			if e = removeOwned(dir, entry.Name(), id); e != nil {
				return e
			}
		} else {
			if e = removeOutput(dir, entry.Name()); e != nil {
				return e
			}
		}
	}
	return nil
}
func validateTree(ctx context.Context, dir *os.File, expected map[string]int64) error {
	entries, e := dir.ReadDir(-1)
	if e != nil {
		return e
	}
	if len(entries) != len(expected) {
		return failure(409, "target_path_changed", "临时目录内容已变化")
	}
	for _, entry := range entries {
		if e := ctx.Err(); e != nil {
			return e
		}
		size, ok := expected[entry.Name()]
		if !ok {
			return failure(409, "target_path_changed", "临时目录内容已变化")
		}
		f, e := openRelative(dir, entry.Name())
		if e != nil {
			return failure(409, "target_path_changed", "临时文件不安全")
		}
		var st unix.Stat_t
		e = unix.Fstat(int(f.Fd()), &st)
		f.Close()
		if e != nil {
			return e
		}
		if st.Size != size || st.Nlink != 1 {
			return failure(409, "target_path_changed", "临时文件已变化")
		}
	}
	return nil
}
func commitDirectory(target *os.File, staging, folder string, id fileIdentity) error {
	if !safeLeaf(folder) {
		return failure(409, "target_path_unsafe", "目标名字不安全")
	}
	if e := verifyOwned(target, staging, id); e != nil {
		return e
	}
	e := unix.Renameat2(int(target.Fd()), staging, int(target.Fd()), folder, unix.RENAME_NOREPLACE)
	if errors.Is(e, unix.EEXIST) || errors.Is(e, unix.ENOTEMPTY) {
		return failure(409, "export_target_exists", "导出目录里已经有同名文件夹")
	}
	if e != nil {
		return e
	}
	return target.Sync()
}
