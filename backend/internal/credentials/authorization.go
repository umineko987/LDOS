package credentials

import (
	"context"
	"encoding/json"
	"errors"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

// Snapshot reads status and metadata under the same directory lock used by
// scheduler invalidation and login persistence.
func (s *Store) Snapshot(ctx context.Context, site string) (CookieStatus, map[string]any, error) {
	root, err := s.open(ctx)
	if err != nil {
		return CookieStatus{}, nil, err
	}
	defer root.Close()
	metadata, err := readMetadata(ctx, root)
	if err != nil {
		return CookieStatus{}, nil, err
	}
	fields := map[string]any{}
	_ = json.Unmarshal(metadata[site], &fields)
	if fields == nil {
		fields = map[string]any{}
	}
	var status CookieStatus
	if managedSite(site) {
		status, err = inspectCookies(ctx, root, site)
	}
	return status, fields, err
}

func (s *Store) SetMetadata(ctx context.Context, key string, fields map[string]any) error {
	root, err := s.open(ctx)
	if err != nil {
		return err
	}
	defer root.Close()
	metadata, err := readMetadata(ctx, root)
	if err != nil {
		return err
	}
	if fields == nil {
		delete(metadata, key)
	} else {
		metadata[key], err = json.Marshal(fields)
		if err != nil {
			return ErrInvalidMetadata
		}
	}
	return writeMetadata(ctx, root, metadata)
}

// SaveCookies replaces the export first and clears old invalidation metadata
// only after the private write succeeds. Readers cannot observe the intermediate
// state; a failed metadata write leaves any old invalidation in force.
func (s *Store) SaveCookies(ctx context.Context, site string, data []byte, fields map[string]any) error {
	if !managedSite(site) || len(data) > maxCookieBytes || !utf8.Valid(data) {
		return ErrInvalidMetadata
	}
	root, err := s.open(ctx)
	if err != nil {
		return err
	}
	defer root.Close()
	metadata, err := readMetadata(ctx, root)
	if err != nil {
		return err
	}
	metadata[site], err = json.Marshal(fields)
	if err != nil {
		return ErrInvalidMetadata
	}
	if err = writePrivateBytes(ctx, root, cookieName(site), data); err != nil {
		return err
	}
	return writeMetadata(ctx, root, metadata)
}

func (s *Store) Clear(ctx context.Context, site string) error {
	root, err := s.open(ctx)
	if err != nil {
		return err
	}
	defer root.Close()
	metadata, err := readMetadata(ctx, root)
	if err != nil {
		return err
	}
	if managedSite(site) {
		f, err := openPrivateFile(root, cookieName(site))
		if err != nil {
			return err
		}
		if f != nil {
			f.Close()
			if err := unix.Unlinkat(int(root.Fd()), cookieName(site), 0); err != nil && !errors.Is(err, unix.ENOENT) {
				return ErrStorage
			}
		}
	}
	delete(metadata, site)
	return writeMetadata(ctx, root, metadata)
}
