package gallerycatalog

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestTrashAfterDeviceRenumber(t *testing.T) {
	for _, scenario := range []string{"legacy purge", "restore", "changed content", "different filesystem", "not btrfs"} {
		t.Run(scenario, func(t *testing.T) {
			s := testService(t)
			ctx := context.Background()
			root := t.TempDir()
			var fs unix.Statfs_t
			must(t, unix.Statfs(root, &fs))
			if (fs.Type == unix.BTRFS_SUPER_MAGIC) == (scenario == "not btrfs") {
				t.Skip("run with TMPDIR on the corresponding filesystem")
			}
			picture(t, root, "one.png")
			put(t, root, "one.txt", []byte("kitten"))
			sid := importScan(t, s, root)
			aid := AssetID(sid, "one.png")
			_, e := s.HashImage(ctx, aid)
			must(t, e)
			op, e := s.Trash(ctx, Selection{AssetIDs: []string{aid}})
			must(t, e)
			_, items, e := s.operation(ctx, op.OperationID)
			must(t, e)
			it := items[0]
			for _, st := range []*fileIdentity{&it.Native.SourceRoot, &it.Native.TargetRoot, &it.Native.Image, &it.Native.Caption} {
				st.Device++ // simulate the persisted st_dev from before a remount
			}
			if scenario == "legacy purge" || scenario == "changed content" {
				it.Native.BtrfsFSID = nil // journal from before btrfs_fsid was recorded
			} else if scenario != "not btrfs" {
				if it.Native.BtrfsFSID == nil || *it.Native.BtrfsFSID != fs.Fsid.Val {
					t.Fatal("trash journal did not record the Btrfs filesystem ID")
				}
				if scenario == "different filesystem" {
					it.Native.BtrfsFSID[0]++
				}
			}
			must(t, s.updateItem(ctx, op.OperationID, it))
			if scenario == "changed content" {
				// Same inode, mode, size and mtime, but NOT the indexed caption.
				caption := filepath.Join(root, CaptionRelativePath(it.Target))
				st, err := os.Stat(caption)
				must(t, err)
				must(t, os.WriteFile(caption, []byte("rabbit"), 0600))
				must(t, os.Chtimes(caption, st.ModTime(), st.ModTime()))
			}
			if scenario == "restore" {
				_, e = s.Restore(ctx, op.OperationID)
				must(t, e)
				if !exists(t, root, "one.png") || !exists(t, root, "one.txt") {
					t.Fatal("restore did not move the pair")
				}
				return
			}
			result, e := s.PurgeAllTrash(ctx)
			if scenario == "legacy purge" {
				must(t, e)
				if num(result, "purged_items") != 1 || exists(t, root, it.Target) || exists(t, root, CaptionRelativePath(it.Target)) {
					t.Fatal("purge did not remove the pair", result)
				}
				return
			}
			code := "source_changed"
			if scenario == "changed content" {
				code = "target_path_changed"
			}
			wantError(t, e, code)
			if !exists(t, root, it.Target) || !exists(t, root, CaptionRelativePath(it.Target)) {
				t.Fatal("refusal removed a file")
			}
			row, e := s.db.QueryRow(ctx, "SELECT count(*) AS n FROM gallery_file_operations WHERE kind='purge'")
			must(t, e)
			if num(row, "n") != 0 {
				t.Fatal("refusal left a purge journal")
			}
		})
	}
}
