package pixivauth

import (
	"errors"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

func openCacheDirectory(path string, create bool) (*os.File, error) {
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if part == "" {
			continue
		}
		next, err := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if errors.Is(err, unix.ENOENT) && create {
			if err = unix.Mkdirat(fd, part, 0700); err == nil || errors.Is(err, unix.EEXIST) {
				next, err = unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			}
		}
		unix.Close(fd)
		if err != nil {
			if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
				return nil, ErrUnsafePath
			}
			return nil, err
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), path), nil
}

// Inspect files through directory descriptors; chmod never follows a link.
// SQLite creates journal/WAL files with the database's already-private mode.
func secureCacheFiles(dir *os.File, name string, writable bool) error {
	for _, suffix := range []string{"", "-journal", "-wal", "-shm"} {
		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
		if writable && suffix == "" {
			flags |= unix.O_CREAT
		}
		fd, err := unix.Openat(int(dir.Fd()), name+suffix, flags, 0600)
		if errors.Is(err, unix.ENOENT) && suffix != "" {
			continue
		}
		if err != nil {
			if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.EISDIR) {
				return ErrUnsafePath
			}
			return err
		}
		var stat unix.Stat_t
		err = unix.Fstat(fd, &stat)
		if err == nil && (stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Nlink != 1) {
			err = ErrUnsafePath
		}
		if err == nil && writable {
			err = unix.Fchmod(fd, 0600)
		}
		unix.Close(fd)
		if err != nil {
			return err
		}
	}
	return nil
}
