//go:build linux

package authbrowser

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// openDirectory walks every component with O_NOFOLLOW. Existing ancestors are
// never chmodded; only directories we create receive private permissions.
func openDirectory(path string, create bool) (*os.File, error) {
	if !filepath.IsAbs(path) {
		return nil, ErrProfile
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, ErrProfile
	}
	for _, component := range strings.Split(strings.TrimPrefix(filepath.Clean(path), "/"), "/") {
		if component == "" {
			continue
		}
		next, e := unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if errors.Is(e, unix.ENOENT) && create {
			e = unix.Mkdirat(fd, component, 0700)
			if e == nil || errors.Is(e, unix.EEXIST) {
				next, e = unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			}
		}
		unix.Close(fd)
		if errors.Is(e, unix.ENOENT) {
			return nil, os.ErrNotExist
		}
		if e != nil {
			return nil, ErrProfile
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), path), nil
}

func prepareProfile(path string) error {
	if path == "" || path == "/" {
		return ErrProfile
	}
	dir, err := openDirectory(path, true)
	if err != nil {
		return ErrProfile
	}
	defer dir.Close()
	if err := dir.Chmod(0700); err != nil {
		return ErrProfile
	}
	// Unlink the directory entry itself; a symlink here is never followed.
	if err := unix.Unlinkat(int(dir.Fd()), "DevToolsActivePort", 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return ErrProfile
	}
	return nil
}

func (b *Browser) ProfilePresent() bool {
	if b.profileDir == "" {
		return false
	}
	dir, err := openDirectory(b.profileDir, false)
	if err != nil {
		return false
	}
	dir.Close()
	return true
}

// ResetProfile stops the host and removes only the configured directory. The
// parent is pinned by a no-symlink descriptor; Root.RemoveAll never follows links.
func (b *Browser) ResetProfile() error {
	b.cancelHost()
	if err := b.acquire(nil); err != nil {
		return err
	}
	defer b.release()
	if err := b.stopLocked(); err != nil {
		return err
	}
	if b.profileDir == "" || b.profileDir == "/" {
		return ErrProfile
	}
	parentPath := filepath.Dir(b.profileDir)
	parent, err := openDirectory(parentPath, false)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return ErrProfile
	}
	defer parent.Close()
	name := filepath.Base(b.profileDir)
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return ErrProfile
	}
	unix.Close(fd)
	root, err := os.OpenRoot(fmt.Sprintf("/proc/self/fd/%d", parent.Fd()))
	if err != nil {
		return ErrProfile
	}
	defer root.Close()
	if err := root.RemoveAll(name); err != nil {
		return ErrProfile
	}
	return nil
}
