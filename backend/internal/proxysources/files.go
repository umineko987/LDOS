package proxysources

import (
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
	"ldos/backend/internal/proxyparse"
)

var errSymlink = errors.New("symlink")

// Every component is opened relative to its parent descriptor with O_NOFOLLOW.
// Checking a path and later opening it by name would allow an intermediate
// symlink replacement to redirect reads or writes outside the intended tree.
func openDirectory(path string, create bool) (*os.File, error) {
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
			if mkdirErr := unix.Mkdirat(fd, component, 0700); mkdirErr != nil && !errors.Is(mkdirErr, unix.EEXIST) {
				unix.Close(fd)
				return nil, mkdirErr
			}
			next, openErr = unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		}
		if openErr != nil {
			var stat unix.Stat_t
			if errors.Is(openErr, unix.ELOOP) || unix.Fstatat(fd, component, &stat, unix.AT_SYMLINK_NOFOLLOW) == nil && stat.Mode&unix.S_IFMT == unix.S_IFLNK {
				openErr = errSymlink
			}
		}
		unix.Close(fd)
		if openErr != nil {
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

func inside(path, root string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

// ReadNodeFile reads and validates a bounded, UTF-8 node file. A nil allowlist
// skips root restrictions (for existing config); an empty non-nil list denies
// all paths. Both forms reject symlinks in every path component.
func ReadNodeFile(path string, allowedRoots []string) (string, error) {
	candidate, err := filepath.Abs(path)
	if err != nil {
		return "", invalid("node_file", "unavailable", nil)
	}
	if allowedRoots != nil {
		allowed := false
		for _, root := range allowedRoots {
			absolute, err := filepath.Abs(root)
			if err == nil && inside(candidate, absolute) {
				allowed = true
				break
			}
		}
		if !allowed {
			return "", forbidden("outside_allowed_roots")
		}
	}
	dir, err := openDirectory(filepath.Dir(candidate), false)
	if err != nil {
		if errors.Is(err, errSymlink) {
			return "", forbidden("symlink")
		}
		return "", invalid("node_file", "unavailable", nil)
	}
	defer dir.Close()
	fd, err := unix.Openat(int(dir.Fd()), filepath.Base(candidate), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.ELOOP) {
			return "", forbidden("symlink")
		}
		return "", invalid("node_file", "unavailable", nil)
	}
	file := os.NewFile(uintptr(fd), candidate)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", invalid("node_file", "unavailable", nil)
	}
	if !info.Mode().IsRegular() {
		return "", invalid("node_file", "not_regular", nil)
	}
	if info.Size() > MaxNodeFileBytes {
		return "", invalid("node_file", "too_large", nil)
	}
	raw, err := io.ReadAll(io.LimitReader(file, MaxNodeFileBytes+1))
	if err != nil {
		return "", invalid("node_file", "unavailable", nil)
	}
	if len(raw) > MaxNodeFileBytes {
		return "", invalid("node_file", "too_large", nil)
	}
	if !utf8.Valid(raw) {
		return "", invalid("node_file", "invalid_encoding", nil)
	}
	text := strings.TrimPrefix(string(raw), "\ufeff")
	for _, node := range proxyparse.ParseSubscription(text) {
		if node.Usable || len(node.CoreConfig) != 0 {
			return text, nil
		}
	}
	return "", invalid("node_file", "empty_parse", nil)
}

const managedFilename = "managed-sources.json"

func readManaged(dir *os.File) ([]byte, bool, error) {
	fd, err := unix.Openat(int(dir.Fd()), managedFilename, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil, false, nil
	}
	if errors.Is(err, unix.ELOOP) {
		return nil, true, managedForbidden("managed_path_symlink")
	}
	if err != nil {
		return nil, true, corrupt("read_failed")
	}
	file := os.NewFile(uintptr(fd), managedFilename)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, true, corrupt("read_failed")
	}
	if !info.Mode().IsRegular() {
		return nil, true, corrupt("invalid_target")
	}
	if err := file.Chmod(0600); err != nil {
		return nil, true, corrupt("invalid_target")
	}
	if info.Size() > MaxManagedSourcesFileBytes {
		return nil, true, corrupt("too_large")
	}
	raw, err := io.ReadAll(io.LimitReader(file, MaxManagedSourcesFileBytes+1))
	if err != nil {
		return nil, true, corrupt("read_failed")
	}
	if len(raw) > MaxManagedSourcesFileBytes {
		return nil, true, corrupt("too_large")
	}
	return raw, true, nil
}

func checkManagedTarget(dir *os.File) error {
	var stat unix.Stat_t
	err := unix.Fstatat(int(dir.Fd()), managedFilename, &stat, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT == unix.S_IFLNK {
		return managedForbidden("managed_path_symlink")
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		return managedForbidden("managed_target_not_file")
	}
	return nil
}

func writeManaged(dir *os.File, data []byte, expectedToken string) error {
	if err := checkManagedTarget(dir); err != nil {
		return err
	}
	name := "." + managedFilename + "." + rand.Text() + ".tmp"
	fd, err := unix.Openat(int(dir.Fd()), name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return err
	}
	defer unix.Unlinkat(int(dir.Fd()), name, 0)
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	if err := file.Chmod(0600); err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	// The raw token detects edits even if the decoded values/revision are equal.
	raw, present, err := readManaged(dir)
	if err != nil || contentToken(raw, present) != expectedToken {
		return conflict()
	}
	return unix.Renameat(int(dir.Fd()), name, int(dir.Fd()), managedFilename)
}
