package gallerycatalog

import (
	"context"
	"errors"
	"io"
	"os"
	"path"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

type copiedFile struct {
	Relative string       `json:"relative"`
	Identity fileIdentity `json:"identity"`
}
type copyInput struct {
	Relative string
	Output   string
	Identity fileIdentity
}

func discoverFiles(ctx context.Context, root *SafeRoot, relative string, allowlist bool) ([]copyInput, error) {
	files := []copyInput{}
	var walk func(string, string) error
	walk = func(rel, output string) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		entries, e := root.ReadDir(rel)
		if e != nil {
			return e
		}
		for _, entry := range entries {
			if reserved(entry.Name()) {
				continue
			}
			p := path.Join(rel, entry.Name())
			if ValidateRelativePath(p, false) != nil {
				return failure("unsafe_source_path", 409)
			}
			if entry.Type()&os.ModeSymlink != 0 {
				if allowlist {
					continue
				}
				return failure("unsafe_source_path", 409)
			}
			st, e := root.Stat(p)
			if e != nil {
				return e
			}
			dst := path.Join(output, entry.Name())
			if st.Mode&unix.S_IFMT == unix.S_IFDIR {
				if !allowlist {
					files = append(files, copyInput{p, dst, st})
				}
				if e = walk(p, dst); e != nil {
					return e
				}
			} else if st.Mode&unix.S_IFMT == unix.S_IFREG && (!allowlist || SupportedImage(entry.Name()) || strings.EqualFold(path.Ext(entry.Name()), ".txt")) {
				files = append(files, copyInput{p, dst, st})
			}
		}
		return nil
	}
	if e := walk(relative, ""); e != nil {
		return nil, e
	}
	return files, nil
}
func copyFile(ctx context.Context, source *SafeRoot, input copyInput, target *SafeRoot, output string, progress func(int64)) (fileIdentity, error) {
	if e := ctx.Err(); e != nil {
		return fileIdentity{}, e
	}
	if input.Identity.Mode&unix.S_IFMT == unix.S_IFDIR {
		current, err := source.Stat(input.Relative)
		if err != nil || !input.Identity.sameSnapshot(current) {
			return fileIdentity{}, failure("source_changed", 409)
		}
		if err := source.AssertCurrent(); err != nil {
			return fileIdentity{}, err
		}
		if err := target.MkdirAll(parentRelative(output)); err != nil {
			return fileIdentity{}, err
		}
		return target.Mkdir(output)
	}
	in, e := source.Open(input.Relative)
	if e != nil {
		return fileIdentity{}, wrapIO(e, "source_changed")
	}
	defer in.Close()
	before, e := fileStat(in)
	if e != nil {
		return fileIdentity{}, e
	}
	if !input.Identity.sameSnapshot(before) {
		return fileIdentity{}, failure("source_changed", 409)
	}
	if e = target.MkdirAll(parentRelative(output)); e != nil {
		return fileIdentity{}, e
	}
	out, e := target.create(output)
	if e != nil {
		return fileIdentity{}, e
	}
	owned, e := fileStat(out)
	if e != nil {
		out.Close()
		return fileIdentity{}, e
	}
	ok := false
	defer func() {
		out.Close()
		if !ok {
			_ = target.Remove(output, &owned)
		}
	}()
	buf := make([]byte, 128<<10)
	var count int64
	for {
		if e = ctx.Err(); e != nil {
			return fileIdentity{}, e
		}
		n, re := in.Read(buf)
		if n > 0 {
			written, we := out.Write(buf[:n])
			if we != nil {
				return fileIdentity{}, we
			}
			if written != n {
				return fileIdentity{}, io.ErrShortWrite
			}
			count += int64(n)
			if progress != nil {
				progress(int64(n))
			}
		}
		if re == io.EOF {
			break
		}
		if re != nil {
			return fileIdentity{}, re
		}
	}
	after, e := fileStat(in)
	if e != nil {
		return fileIdentity{}, e
	}
	current, e := source.Stat(input.Relative)
	if e != nil || !before.sameSnapshot(after) || !before.sameSnapshot(current) || count != before.Size {
		return fileIdentity{}, failure("source_changed", 409)
	}
	if e = source.AssertCurrent(); e != nil {
		return fileIdentity{}, e
	}
	if e = out.Sync(); e != nil {
		return fileIdentity{}, e
	}
	written, e := fileStat(out)
	if e != nil {
		return fileIdentity{}, e
	}
	current, e = target.Stat(output)
	if e != nil || !written.sameFile(current) {
		return fileIdentity{}, failure("target_path_changed", 409)
	}
	if e = target.AssertCurrent(); e != nil {
		return fileIdentity{}, e
	}
	ok = true
	return written, nil
}

// verifyCopied rejects added files, replaced files, links and added empty
// directories in the owned staging tree before its no-clobber publication.
func verifyCopied(root *SafeRoot, stage string, owned fileIdentity, files []copiedFile) error {
	st, e := root.Stat(stage)
	if e != nil {
		return e
	}
	if !owned.sameFile(st) {
		return failure("target_path_changed", 409)
	}
	expected := map[string]fileIdentity{}
	dirs := map[string]bool{stage: true}
	for _, f := range files {
		expected[f.Relative] = f.Identity
		if f.Identity.Mode&unix.S_IFMT == unix.S_IFDIR {
			dirs[f.Relative] = true
		}
		for p := parentRelative(f.Relative); p != "" && p != stage; p = parentRelative(p) {
			dirs[p] = true
		}
	}
	var walk func(string) error
	seen := 0
	walk = func(rel string) error {
		entries, e := root.ReadDir(rel)
		if e != nil {
			return e
		}
		for _, entry := range entries {
			p := path.Join(rel, entry.Name())
			st, e := root.Stat(p)
			if e != nil {
				return e
			}
			if st.Mode&unix.S_IFMT == unix.S_IFDIR {
				if !dirs[p] {
					return failure("target_path_changed", 409)
				}
				if want, recorded := expected[p]; recorded {
					if !want.sameFile(st) {
						return failure("target_path_changed", 409)
					}
					seen++
				}
				if e = walk(p); e != nil {
					return e
				}
			} else {
				want, ok := expected[p]
				if !ok || !want.sameSnapshot(st) {
					return failure("target_path_changed", 409)
				}
				seen++
			}
		}
		return nil
	}
	if e = walk(stage); e != nil {
		return e
	}
	if seen != len(files) {
		return failure("target_path_changed", 409)
	}
	return root.AssertCurrent()
}
func cleanupCopied(root *SafeRoot, stage string, owned fileIdentity, files []copiedFile) error {
	if owned.Inode == 0 {
		exists, e := root.Exists(stage)
		if e != nil {
			return e
		}
		if exists {
			return failure("temporary_cleanup_failed", 409)
		}
		return nil
	}
	if e := verifyCopied(root, stage, owned, files); e != nil {
		if errors.Is(e, os.ErrNotExist) {
			return nil
		}
		return &Error{Code: "temporary_cleanup_failed", Status: 409, Cause: e}
	}
	if e := root.removeTree(stage, owned); e != nil {
		return &Error{Code: "temporary_cleanup_failed", Status: 409, Cause: e}
	}
	return nil
}
func (s *Service) copyOperationItem(ctx context.Context, operationID string, it *operationItem, source, target *SafeRoot) error {
	if it.Native.Stage == "" {
		it.Native.Stage = path.Join(parentRelative(it.Target), ".ldos-copy-"+operationID+"-"+strconv.Itoa(it.Ordinal))
		if e := s.updateItem(ctx, operationID, *it); e != nil {
			return e
		}
	}
	stage := it.Native.Stage
	// Publication may have completed just before the journal update.
	if it.ItemType == "directory" {
		found, e := target.Stat(it.Target)
		if e == nil {
			if it.Native.StageIdentity.Inode != 0 && it.Native.StageIdentity.sameFile(found) {
				return nil
			}
			return failure("transfer_target_conflict", 409)
		}
		if !errors.Is(e, os.ErrNotExist) {
			return e
		}
	}
	if it.Native.StageIdentity.Inode == 0 {
		owned, e := target.Mkdir(stage)
		if e != nil {
			return e
		}
		it.Native.StageIdentity = owned
		if e = s.updateItem(ctx, operationID, *it); e != nil {
			return e
		}
	}
	if it.Status == "copy_ready" || it.Status == "done" {
		return s.publishCopy(ctx, operationID, it, target)
	}
	// A recorded partial copy is restarted only if its complete ownership manifest
	// matches. Unjournaled crash-gap outputs are retained and require recovery.
	if len(it.Native.Copied) > 0 {
		if e := cleanupCopied(target, stage, it.Native.StageIdentity, it.Native.Copied); e != nil {
			return e
		}
		owned, e := target.Mkdir(stage)
		if e != nil {
			return e
		}
		it.Native.StageIdentity = owned
		it.Native.Copied = nil
		if e = s.updateItem(ctx, operationID, *it); e != nil {
			return e
		}
	}
	inputs := []copyInput{}
	if it.ItemType == "directory" {
		var e error
		inputs, e = discoverFiles(ctx, source, it.Origin, false)
		if e != nil {
			return e
		}
	} else {
		for j, rel := range itemPaths(*it, true) {
			inputs = append(inputs, copyInput{rel, path.Base(rel), itemIdentities(*it)[j]})
		}
	}
	for _, input := range inputs {
		dest := path.Join(stage, input.Output)
		owned, e := copyFile(ctx, source, input, target, dest, nil)
		if e != nil {
			return e
		}
		it.Native.Copied = append(it.Native.Copied, copiedFile{dest, owned})
		if e = s.updateItem(ctx, operationID, *it); e != nil {
			return e
		}
	}
	if e := verifyCopied(target, stage, it.Native.StageIdentity, it.Native.Copied); e != nil {
		return e
	}
	it.Status = "copy_ready"
	if e := s.updateItem(ctx, operationID, *it); e != nil {
		return e
	}
	return s.publishCopy(ctx, operationID, it, target)
}
func (s *Service) publishCopy(ctx context.Context, operationID string, it *operationItem, target *SafeRoot) error {
	if it.ItemType == "directory" {
		return moveStep(target, it.Native.Stage, target, it.Target, it.Native.StageIdentity)
	}
	for i, f := range it.Native.Copied {
		dest := it.Target
		if i == 1 {
			dest = CaptionRelativePath(it.Target)
		}
		if e := moveStep(target, f.Relative, target, dest, f.Identity); e != nil {
			return e
		}
	}
	return target.Remove(it.Native.Stage, &it.Native.StageIdentity)
}
func (s *Service) rollbackCopy(target *SafeRoot, it operationItem) error {
	if it.Native.Stage == "" {
		return nil
	}
	if it.ItemType == "directory" {
		st, e := target.Stat(it.Target)
		if e == nil {
			if it.Native.StageIdentity.Inode == 0 || !it.Native.StageIdentity.sameFile(st) {
				return failure("target_path_changed", 409)
			}
			files := []copiedFile{}
			for _, f := range it.Native.Copied {
				files = append(files, copiedFile{it.Target + strings.TrimPrefix(f.Relative, it.Native.Stage), f.Identity})
			}
			return cleanupCopied(target, it.Target, st, files)
		}
		if !errors.Is(e, os.ErrNotExist) {
			return e
		}
	}
	remaining := []copiedFile{}
	for i, f := range it.Native.Copied {
		st, e := target.Stat(f.Relative)
		if e == nil {
			if !f.Identity.sameFile(st) {
				return failure("target_path_changed", 409)
			}
			remaining = append(remaining, f)
			continue
		}
		if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		if it.ItemType != "directory" {
			dest := it.Target
			if i == 1 {
				dest = CaptionRelativePath(dest)
			}
			if e = target.Remove(dest, &f.Identity); e != nil {
				return e
			}
		}
	}
	return cleanupCopied(target, it.Native.Stage, it.Native.StageIdentity, remaining)
}
