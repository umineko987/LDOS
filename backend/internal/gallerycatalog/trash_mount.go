package gallerycatalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"

	"golang.org/x/sys/unix"
)

// Btrfs can allocate a different anonymous st_dev to the same subvolume on
// the next mount. Its statfs fsid incorporates the filesystem and subvolume.
func (r *SafeRoot) btrfsFSID() (*[2]int32, error) {
	var fs unix.Statfs_t
	if err := unix.Fstatfs(r.fd, &fs); err != nil {
		return nil, err
	}
	if fs.Type != unix.BTRFS_SUPER_MAGIC {
		return nil, nil
	}
	return &fs.Fsid.Val, nil
}

// Only rebind committed trash entries, before planning a restore or purge.
// Live file operations still compare the full device/inode identities.
func (s *Service) rebindTrashMount(ctx context.Context, root *SafeRoot, it *operationItem) error {
	n := &it.Native
	old := n.SourceRoot
	if old.Inode == 0 { // pre-native journal, no recorded root
		return nil
	}
	current := root.identity
	if old.Inode != current.Inode || old.Mode != current.Mode || !old.sameFile(n.TargetRoot) {
		return failure("source_changed", 409)
	}
	if old.Device == current.Device && n.BtrfsFSID == nil {
		return nil
	}
	fsid, err := root.btrfsFSID()
	if err != nil {
		return err
	}
	if fsid == nil || n.BtrfsFSID != nil && *n.BtrfsFSID != *fsid {
		return failure("source_changed", 409)
	}
	if old.Device == current.Device {
		return nil
	}
	var asset Row
	if n.BtrfsFSID == nil {
		// Old journals have no stable mount ID. Only accept catalogued regular
		// files whose contents still match; never infer ownership of a tree.
		if it.ItemType != "asset" {
			return failure("source_changed", 409)
		}
		asset, err = s.db.QueryRow(ctx, `SELECT content_sha256,txt_sha256 FROM gallery_assets WHERE id=? AND source_id=? AND relative_path=? AND lifecycle_state='trashed' AND content_version=? AND txt_version=?`, it.AssetID, it.SourceID, it.Origin, it.ExpectedAssetVersion, it.ExpectedTxtVersion)
		if err != nil {
			return err
		}
		if asset == nil {
			return failure("target_path_changed", 409)
		}
	}
	for i, rel := range itemPaths(*it, false) {
		st, key := &n.Image, "content_sha256"
		if i != 0 {
			st, key = &n.Caption, "txt_sha256"
		}
		if st.Device != old.Device || st.Inode == 0 {
			return failure("target_path_changed", 409)
		}
		st.Device = current.Device
		if asset != nil {
			if err := verifyLegacyTrashFile(root, rel, *st, str(asset, key)); err != nil {
				return err
			}
		}
	}
	n.SourceRoot, n.TargetRoot = current, current
	return nil
}

func verifyLegacyTrashFile(root *SafeRoot, rel string, expected fileIdentity, contentHash string) error {
	if contentHash == "" {
		return failure("target_path_changed", 409)
	}
	f, err := root.Open(rel)
	if err != nil {
		return wrapIO(err, "trash_file_missing")
	}
	defer f.Close()
	before, err := fileStat(f)
	if err != nil || !expected.sameSnapshot(before) {
		return failure("target_path_changed", 409)
	}
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return err
	}
	after, err := fileStat(f)
	if err != nil || !before.sameSnapshot(after) || hex.EncodeToString(h.Sum(nil)) != contentHash {
		return failure("target_path_changed", 409)
	}
	return nil
}
