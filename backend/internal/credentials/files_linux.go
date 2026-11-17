//go:build linux

package credentials

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

const (
	maxMetadataBytes = 1 << 20
	maxCookieBytes   = 8 << 20
	maxCookieLine    = 64 << 10
)

// Walk each component from an opened filesystem root. All subsequent I/O is
// relative to this directory descriptor, so replacing a parent with a symlink
// cannot redirect a chmod, read, temporary-file write or rename.
func openManagedDir(path string, create bool) (*os.File, error) {
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, ErrStorage
	}
	for _, component := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		next, err := unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if errors.Is(err, unix.ENOENT) && create {
			if err = unix.Mkdirat(fd, component, 0700); err == nil || errors.Is(err, unix.EEXIST) {
				next, err = unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			}
		}
		unix.Close(fd)
		if err != nil {
			return nil, pathError(err)
		}
		fd = next
	}
	if err := unix.Fchmod(fd, 0700); err != nil {
		unix.Close(fd)
		return nil, ErrStorage
	}
	return os.NewFile(uintptr(fd), "managed credentials"), nil
}

func pathError(err error) error {
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		return ErrUnsafePath
	}
	return ErrStorage
}

func (s *Store) open(ctx context.Context) (*os.File, error) {
	root, err := openManagedDir(s.managedDir, false)
	if err != nil {
		return nil, err
	}
	// Lock the directory inode, not the replaceable JSON inode. Closing root
	// releases the lock. Separate Store instances/processes cooperate too.
	for {
		if err := ctx.Err(); err != nil {
			root.Close()
			return nil, err
		}
		err := unix.Flock(int(root.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return root, nil
		}
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if !errors.Is(err, unix.EWOULDBLOCK) {
			root.Close()
			return nil, ErrStorage
		}
		timer := time.NewTimer(5 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			root.Close()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func regularPrivateFile(stat *unix.Stat_t) bool {
	// Hard links could otherwise cause permission changes to an external file.
	return stat.Mode&unix.S_IFMT == unix.S_IFREG && stat.Nlink == 1
}

func openPrivateFile(root *os.File, name string) (*os.File, error) {
	var stat unix.Stat_t
	err := unix.Fstatat(int(root.Fd()), name, &stat, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, unix.ENOENT) {
		return nil, nil
	}
	if err != nil {
		return nil, pathError(err)
	}
	if !regularPrivateFile(&stat) {
		return nil, ErrUnsafePath
	}
	fd, err := unix.Openat(int(root.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, pathError(err)
	}
	if err := unix.Fstat(fd, &stat); err != nil {
		unix.Close(fd)
		return nil, ErrStorage
	}
	if !regularPrivateFile(&stat) {
		unix.Close(fd)
		return nil, ErrUnsafePath
	}
	if err := unix.Fchmod(fd, 0600); err != nil {
		unix.Close(fd)
		return nil, ErrStorage
	}
	return os.NewFile(uintptr(fd), "managed credential file"), nil
}

func readMetadata(ctx context.Context, root *os.File) (map[string]json.RawMessage, error) {
	f, err := openPrivateFile(root, metadataName)
	if err != nil {
		return nil, err
	}
	if f == nil {
		return make(map[string]json.RawMessage), nil
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxMetadataBytes+1))
	if err != nil {
		return nil, ErrStorage
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(data) > maxMetadataBytes || !utf8.Valid(data) {
		return nil, ErrInvalidMetadata
	}
	var metadata map[string]json.RawMessage
	if json.Unmarshal(data, &metadata) != nil || metadata == nil {
		return nil, ErrInvalidMetadata
	}
	return metadata, nil
}

func writeMetadata(ctx context.Context, root *os.File, metadata map[string]json.RawMessage) error {
	data, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil || len(data)+1 > maxMetadataBytes {
		return ErrInvalidMetadata
	}
	return writePrivateBytes(ctx, root, metadataName, append(data, '\n'))
}

func writePrivateBytes(ctx context.Context, root *os.File, target string, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	name := "." + target + "." + rand.Text() + ".tmp"
	fd, err := unix.Openat(int(root.Fd()), name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return ErrStorage
	}
	defer unix.Unlinkat(int(root.Fd()), name, 0)
	f := os.NewFile(uintptr(fd), "temporary credential metadata")
	defer f.Close()
	if err := f.Chmod(0600); err != nil {
		return ErrStorage
	}
	if _, err := f.Write(data); err != nil {
		return ErrStorage
	}
	if err := f.Sync(); err != nil {
		return ErrStorage
	}
	if err := f.Close(); err != nil {
		return ErrStorage
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Recheck the replacement target without ever following a link.
	existing, err := openPrivateFile(root, target)
	if err != nil {
		return err
	}
	if existing != nil {
		existing.Close()
	}
	if err := unix.Renameat(int(root.Fd()), name, int(root.Fd()), target); err != nil {
		return ErrStorage
	}
	if err := root.Sync(); err != nil {
		return ErrStorage
	}
	return nil
}
