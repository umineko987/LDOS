package downloads

import (
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

var errUnsafePath = errors.New("下载设置路径不能包含符号链接或非普通文件")

// Open each component relative to its parent descriptor. O_NOFOLLOW applies to
// every component, including the runtime directory, so no symlink can redirect IO.
func openPrivateDirectory(path string, create bool) (*os.File, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, component := range strings.Split(strings.TrimPrefix(absolute, "/"), "/") {
		if component == "" {
			continue
		}
		next, openErr := unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if errors.Is(openErr, unix.ENOENT) && create {
			if err := unix.Mkdirat(fd, component, 0700); err != nil && !errors.Is(err, unix.EEXIST) {
				unix.Close(fd)
				return nil, err
			}
			next, openErr = unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		}
		unix.Close(fd)
		if openErr != nil {
			if errors.Is(openErr, unix.ELOOP) || errors.Is(openErr, unix.ENOTDIR) {
				return nil, errUnsafePath
			}
			return nil, openErr
		}
		fd = next
	}
	dir := os.NewFile(uintptr(fd), absolute)
	if create {
		if err := dir.Chmod(0700); err != nil {
			dir.Close()
			return nil, err
		}
	}
	return dir, nil
}

func checkPrivateFile(dir *os.File, name string) error {
	var stat unix.Stat_t
	err := unix.Fstatat(int(dir.Fd()), name, &stat, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		return errUnsafePath
	}
	return nil
}

func readPrivate(runtimeDir, name string) ([]byte, error) {
	dir, err := openPrivateDirectory(runtimeDir, false)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	if err := checkPrivateFile(dir, name); err != nil {
		return nil, err
	}
	fd, err := unix.Openat(int(dir.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ELOOP) {
		return nil, errUnsafePath
	}
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() {
		return nil, errUnsafePath
	}
	return io.ReadAll(file)
}

// A same-directory temporary file and rename keep each write atomic. Settings
// and token are separate files, as in Python; they are not a two-file transaction.
func writePrivate(dir *os.File, name string, data []byte) error {
	if err := checkPrivateFile(dir, name); err != nil {
		return err
	}
	temporary := "." + name + "." + rand.Text() + ".tmp"
	fd, err := unix.Openat(int(dir.Fd()), temporary, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return err
	}
	defer unix.Unlinkat(int(dir.Fd()), temporary, 0)
	file := os.NewFile(uintptr(fd), temporary)
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := checkPrivateFile(dir, name); err != nil {
		return err
	}
	return unix.Renameat(int(dir.Fd()), temporary, int(dir.Fd()), name)
}

func removePrivate(dir *os.File, name string) error {
	if err := checkPrivateFile(dir, name); err != nil {
		return err
	}
	err := unix.Unlinkat(int(dir.Fd()), name, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	return err
}
