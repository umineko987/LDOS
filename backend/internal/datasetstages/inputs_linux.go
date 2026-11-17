package datasetstages

import (
	"context"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
	"ldos/backend/internal/captions"
)

type TagInput struct {
	AssetID, Path, SHA256, Unavailable string
	Size, ModifiedNS                   int64
}

func (i TagInput) Line() string {
	if i.SHA256 != "" {
		return i.SHA256 + "\t" + i.Path
	}
	return i.Path
}

// statInput walks every path component without following symlinks. Opening with
// NONBLOCK prevents named pipes/devices from hanging the request before fstat.
func statInput(root, relative string) (unix.Stat_t, error) {
	var stat unix.Stat_t
	if !filepath.IsAbs(root) || relative == "" || filepath.IsAbs(relative) || strings.ContainsAny(relative, "\x00\t\r\n") || strings.ContainsAny(root, "\x00\t\r\n") {
		return stat, unix.EINVAL
	}
	parts := append(strings.Split(strings.TrimPrefix(filepath.Clean(root), "/"), "/"), strings.Split(relative, "/")...)
	fd, e := unix.Open("/", unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_RDONLY, 0)
	if e != nil {
		return stat, e
	}
	defer func() { unix.Close(fd) }()
	for i, p := range parts {
		if p == "" || p == "." || p == ".." {
			return stat, unix.EINVAL
		}
		flags := unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_RDONLY | unix.O_NONBLOCK
		if i < len(parts)-1 {
			flags |= unix.O_DIRECTORY
		}
		next, e := unix.Openat(fd, p, flags, 0)
		if e != nil {
			return stat, e
		}
		unix.Close(fd)
		fd = next
	}
	if e = unix.Fstat(fd, &stat); e != nil {
		return stat, e
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		return stat, unix.EINVAL
	}
	return stat, nil
}
func (s *Service) Inputs(ctx context.Context, id, stage string, ids []string) ([]TagInput, error) {
	if e := s.require(ctx, id); e != nil {
		return nil, e
	}
	members, e := s.deps.StageInput(ctx, id, stage)
	if e != nil {
		return nil, e
	}
	if ids != nil {
		if e = captions.ValidateIDs(ids, 1, 50000); e != nil {
			return nil, e
		}
		byID := map[string]Row{}
		for _, r := range members {
			byID[text(r["asset_id"])] = r
		}
		selected := []Row{}
		unknown := []string{}
		for _, aid := range captions.Dedupe(ids) {
			if r := byID[aid]; r != nil {
				selected = append(selected, r)
			} else {
				unknown = append(unknown, aid)
			}
		}
		if len(unknown) > 0 {
			return nil, &Error{Status: 422, Code: "caption_asset_not_in_stage", Message: "有图片不在这一阶段的输入里", Details: Row{"stage": stage, "asset_ids": unknown[:min(20, len(unknown))]}}
		}
		members = selected
	}
	sources := map[string]Row{}
	out := []TagInput{}
	for _, r := range members {
		if e = ctx.Err(); e != nil {
			return nil, e
		}
		sid := text(r["source_id"])
		source, ok := sources[sid]
		if !ok {
			source, e = s.deps.Store.QueryRow(ctx, "SELECT * FROM gallery_sources WHERE id=?", sid)
			if e != nil {
				return nil, e
			}
			sources[sid] = source
		}
		v := TagInput{AssetID: text(r["asset_id"])}
		if source == nil || text(source["availability"]) != "available" {
			v.Unavailable = "source_offline"
			out = append(out, v)
			continue
		}
		root, relative := text(source["root_path"]), text(r["relative_path"])
		st, err := statInput(root, relative)
		if err != nil {
			v.Unavailable = "unsafe_source_path"
			if errors.Is(err, unix.ENOENT) {
				v.Unavailable = "file_missing"
			}
			out = append(out, v)
			continue
		}
		v.Path = filepath.Join(root, relative)
		v.Size = st.Size
		v.ModifiedNS = st.Mtim.Sec*1e9 + st.Mtim.Nsec
		sha := text(r["content_sha256"])
		_, hexerr := hex.DecodeString(sha)
		if len(sha) == 64 && sha == strings.ToLower(sha) && hexerr == nil && v.Size == number(r["size_bytes"]) && v.ModifiedNS == number(r["modified_ns"]) {
			v.SHA256 = sha
		}
		out = append(out, v)
	}
	return out, nil
}
