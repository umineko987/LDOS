package gallerycatalog

import (
	"context"
	"errors"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
)

func exists(t *testing.T, root, relative string) bool {
	t.Helper()
	_, e := os.Stat(filepath.Join(root, filepath.FromSlash(relative)))
	if e == nil {
		return true
	}
	if errors.Is(e, os.ErrNotExist) {
		return false
	}
	t.Fatal(e)
	return false
}
func TestRenameTrashRestorePurgeAndReviewSnapshot(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root := t.TempDir()
	picture(t, root, "one.png")
	put(t, root, "one.txt", []byte("kitten"))
	sid := importScan(t, s, root)
	aid := AssetID(sid, "one.png")
	result, e := s.Rename(ctx, aid, "renamed")
	must(t, e)
	if result.Kind != "rename" || result.ItemCount != 1 || result.HasTxtCount != 1 || exists(t, root, "one.png") || !exists(t, root, "renamed.txt") {
		t.Fatal(result)
	}
	_, e = s.Scan(ctx, sid)
	must(t, e)
	if str(imageAt(t, s, sid, "renamed.png"), "asset_id") != aid {
		t.Fatal("rename changed asset ID")
	}
	snapshot := Row{"asset_id": aid, "content_version": 1, "txt_version": 1, "relative_path": "renamed.png"}
	opID := id()
	result, e = s.TrashForReview(ctx, opID, Selection{AssetIDs: []string{aid}}, map[string]Row{aid: snapshot})
	must(t, e)
	if exists(t, root, "renamed.png") || !exists(t, root, path.Join(".ldos/trash", opID, "files/renamed.txt")) {
		t.Fatal("trash pair incomplete")
	}
	row, items, e := s.operation(ctx, opID)
	must(t, e)
	if str(row, "status") != "committed" || str(items[0].Snapshot, "asset_id") != aid || items[0].Native.Image.Inode == 0 {
		t.Fatal(row, items)
	}
	page, e := s.ListImages(ctx, ImageQuery{SourceID: sid, Query: "kitten"})
	must(t, e)
	if len(page.Assets) != 0 {
		t.Fatal("trash remained searchable")
	}
	trash, e := s.ListTrash(ctx, "", 1)
	must(t, e)
	if len(trash["operations"].([]Row)) != 1 || num(trash["operations"].([]Row)[0], "disk_usage_bytes") == 0 {
		t.Fatal(trash)
	}
	put(t, root, "renamed.png", []byte("foreign"))
	_, e = s.Restore(ctx, opID)
	wantError(t, e, "restore_target_conflict")
	must(t, os.Remove(filepath.Join(root, "renamed.png")))
	result, e = s.Restore(ctx, opID)
	must(t, e)
	if result.Status != "committed" || !exists(t, root, "renamed.txt") {
		t.Fatal(result)
	}
	page, e = s.ListImages(ctx, ImageQuery{SourceID: sid, Query: "kitten"})
	must(t, e)
	if len(page.Assets) != 1 {
		t.Fatal("restore did not restore FTS")
	}
	result, e = s.Trash(ctx, Selection{AssetIDs: []string{aid}})
	must(t, e)
	purged, e := s.Purge(ctx, result.OperationID)
	must(t, e)
	if purged.Kind != "purge" {
		t.Fatal(purged)
	}
	_, e = s.GetImage(ctx, aid)
	wantError(t, e, "asset_not_found")
	if exists(t, root, path.Join(".ldos/trash", result.OperationID, "files/renamed.png")) {
		t.Fatal("purge retained image")
	}
}

func TestDirectoryTrashKeepsUnindexedFilesAndScanDoesNotResurrect(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root := t.TempDir()
	picture(t, root, "dir/sub/a.png")
	put(t, root, "dir/unindexed.bin", []byte("retain me"))
	put(t, root, "dir/.hidden", []byte("hidden"))
	must(t, os.MkdirAll(filepath.Join(root, "dir/empty"), 0755))
	sid := importScan(t, s, root)
	did := DirectoryID(sid, "dir")
	_, e := s.Trash(ctx, Selection{DirectoryIDs: []string{did, DirectoryID(sid, "dir/sub")}})
	wantError(t, e, "directory_selection_overlap")
	_, e = s.Trash(ctx, Selection{DirectoryIDs: []string{DirectoryID(sid, "")}})
	wantError(t, e, "directory_root_not_deletable")
	result, e := s.Trash(ctx, Selection{DirectoryIDs: []string{did}, AssetIDs: []string{AssetID(sid, "dir/sub/a.png")}})
	must(t, e)
	if result.ItemCount != 1 {
		t.Fatal("nested asset not collapsed")
	}
	_, e = s.Scan(ctx, sid)
	must(t, e)
	if len(allImages(t, s, sid)) != 0 {
		t.Fatal("scan resurrected trash")
	}
	_, e = s.Restore(ctx, result.OperationID)
	must(t, e)
	for _, rel := range []string{"dir/unindexed.bin", "dir/.hidden", "dir/empty", "dir/sub/a.png"} {
		if !exists(t, root, rel) {
			t.Fatal("restore lost", rel)
		}
	}
	result, e = s.Trash(ctx, Selection{DirectoryIDs: []string{did}})
	must(t, e)
	_, e = s.Purge(ctx, result.OperationID)
	must(t, e)
	if exists(t, root, path.Join(".ldos/trash", result.OperationID, "files/dir")) {
		t.Fatal("directory not purged")
	}
}

func TestTransferCopyAndMoveWithinSource(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root, other := t.TempDir(), t.TempDir()
	picture(t, root, "dir/sub/a.png")
	put(t, root, "dir/sub/a.txt", []byte("lion"))
	put(t, root, "dir/data.bin", []byte("unindexed"))
	must(t, os.MkdirAll(filepath.Join(root, "dir/empty"), 0700))
	picture(t, root, "target/keep.png")
	sid := importScan(t, s, root)
	otherID := importScan(t, s, other)
	selection := Selection{DirectoryIDs: []string{DirectoryID(sid, "dir")}}
	_, e := s.Transfer(ctx, selection, DirectoryID(otherID, ""), "copy")
	wantError(t, e, "source_mismatch")
	copied, e := s.Transfer(ctx, selection, DirectoryID(sid, "target"), "copy")
	must(t, e)
	if copied.Kind != "copy" || !exists(t, root, "target/dir/data.bin") || !exists(t, root, "target/dir/empty") || !exists(t, root, "dir/sub/a.png") {
		t.Fatal(copied)
	}
	if len(allImages(t, s, sid)) != 3 {
		t.Fatal("copy did not index target")
	}
	_, e = s.Transfer(ctx, selection, DirectoryID(sid, "target"), "copy")
	wantError(t, e, "transfer_target_conflict")
	picture(t, root, "move.png")
	put(t, root, "move.txt", []byte("moving"))
	_, e = s.Scan(ctx, sid)
	must(t, e)
	moved, e := s.Transfer(ctx, Selection{AssetIDs: []string{AssetID(sid, "move.png")}}, DirectoryID(sid, "target"), "move")
	must(t, e)
	if moved.Kind != "move" || exists(t, root, "move.png") || !exists(t, root, "target/move.txt") {
		t.Fatal(moved)
	}
	if len(allImages(t, s, sid)) != 4 {
		t.Fatal("move index stale")
	}
}

func plannedTrash(t *testing.T, s *Service, sid, aid string) (string, []operationItem, map[string]*SafeRoot, func()) {
	t.Helper()
	ctx := context.Background()
	items, sources, e := s.selection(ctx, Selection{AssetIDs: []string{aid}})
	must(t, e)
	op := id()
	for i := range items {
		items[i].Target = path.Join(".ldos/trash", op, "files", items[i].Origin)
	}
	roots, close, e := s.openRoots(ctx, sources)
	must(t, e)
	must(t, s.prepareItems(ctx, items, roots, "trash"))
	must(t, s.persistOperation(ctx, op, "trash", sources, items))
	return op, items, roots, close
}
func TestRecoverImageMovedBeforeCaptionAndJournalUpdate(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root := t.TempDir()
	picture(t, root, "a.png")
	put(t, root, "a.txt", []byte("fox"))
	sid := importScan(t, s, root)
	aid := AssetID(sid, "a.png")
	op, items, roots, close := plannedTrash(t, s, sid, aid)
	it := items[0]
	must(t, s.exec(ctx, "UPDATE gallery_file_operations SET status='applying' WHERE id=?", op))
	must(t, roots[sid].RenameTo(it.Origin, roots[sid], it.Target, &it.Native.Image))
	close()
	recovered, e := s.Recover(ctx)
	must(t, e)
	if len(recovered) != 1 || str(recovered[0], "outcome") != "committed" {
		t.Fatal(recovered)
	}
	if exists(t, root, "a.txt") || !exists(t, root, CaptionRelativePath(it.Target)) {
		t.Fatal("pair gap not completed")
	}
	if str(imageAt(t, s, sid, "a.png"), "lifecycle_state") != "trashed" {
		t.Fatal("journal committed without index")
	}
	again, e := s.Recover(ctx)
	must(t, e)
	if len(again) != 0 {
		t.Fatal("replayed committed operation")
	}
	_, e = s.Restore(ctx, op)
	must(t, e)
}
func TestRecoveryNeverClaimsForeignReplacement(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root := t.TempDir()
	picture(t, root, "a.png")
	sid := importScan(t, s, root)
	aid := AssetID(sid, "a.png")
	op, items, roots, close := plannedTrash(t, s, sid, aid)
	it := items[0]
	must(t, roots[sid].RenameTo(it.Origin, roots[sid], it.Target, &it.Native.Image))
	close()
	must(t, os.Rename(filepath.Join(root, it.Target), filepath.Join(root, it.Target)+".held"))
	put(t, root, it.Target, []byte("foreign"))
	result, e := s.Recover(ctx)
	must(t, e)
	if str(result[0], "outcome") != "failed" {
		t.Fatal(result)
	}
	raw, e := os.ReadFile(filepath.Join(root, it.Target))
	must(t, e)
	if string(raw) != "foreign" {
		t.Fatal("recovery overwrote foreign data")
	}
	operation, e := s.GetOperation(ctx, op)
	must(t, e)
	if str(operation, "status") == "committed" {
		t.Fatal(operation)
	}
}

func TestTrashRollbackOnDatabaseCommitFailure(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root := t.TempDir()
	picture(t, root, "a.png")
	put(t, root, "a.txt", []byte("caption"))
	sid := importScan(t, s, root)
	must(t, s.exec(ctx, `CREATE TRIGGER fail_trash BEFORE UPDATE OF lifecycle_state ON gallery_assets WHEN NEW.lifecycle_state='trashed' BEGIN SELECT RAISE(ABORT,'test failure'); END`))
	_, e := s.Trash(ctx, Selection{AssetIDs: []string{AssetID(sid, "a.png")}})
	if e == nil {
		t.Fatal("trash reported success on failed transaction")
	}
	if !exists(t, root, "a.png") || !exists(t, root, "a.txt") {
		t.Fatal("rollback lost pair")
	}
	rows, e := s.db.QueryRows(ctx, "SELECT status FROM gallery_file_operations")
	must(t, e)
	if len(rows) != 1 || str(rows[0], "status") != "rolled_back" {
		t.Fatal(rows)
	}
	must(t, s.exec(ctx, "DROP TRIGGER fail_trash"))
}

func TestRecoverPurgeAfterOneFileDeleted(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root := t.TempDir()
	picture(t, root, "a.png")
	put(t, root, "a.txt", []byte("caption"))
	sid := importScan(t, s, root)
	trash, e := s.Trash(ctx, Selection{AssetIDs: []string{AssetID(sid, "a.png")}})
	must(t, e)
	_, items, e := s.operation(ctx, trash.OperationID)
	must(t, e)
	for i := range items {
		items[i].Origin, items[i].Target = items[i].Target, items[i].Origin
		items[i].Native.TrashOperation = trash.OperationID
	}
	op := id()
	must(t, s.persistOperation(ctx, op, "purge", []string{sid}, items))
	must(t, os.Remove(filepath.Join(root, items[0].Origin)))
	result, e := s.Recover(ctx)
	must(t, e)
	if str(result[0], "outcome") != "committed" {
		t.Fatal(result)
	}
	_, e = s.GetImage(ctx, AssetID(sid, "a.png"))
	wantError(t, e, "asset_not_found")
	if exists(t, root, CaptionRelativePath(items[0].Origin)) {
		t.Fatal("purge caption gap remains")
	}
}

func TestCopyPublishCrashGapRecovery(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	from, to := t.TempDir(), t.TempDir()
	picture(t, from, "a.png")
	put(t, from, "a.txt", []byte("caption"))
	sid := importScan(t, s, from)
	tid := importScan(t, s, to)
	items, _, e := s.selection(ctx, Selection{AssetIDs: []string{AssetID(sid, "a.png")}})
	must(t, e)
	items[0].Target = "a.png"
	items[0].TargetSourceID = tid
	roots, close, e := s.openRoots(ctx, []string{sid, tid})
	must(t, e)
	defer close()
	must(t, s.prepareItems(ctx, items, roots, "copy"))
	op := id()
	must(t, s.persistOperation(ctx, op, "copy", []string{sid, tid}, items))
	it := &items[0]
	it.Native.Stage = ".ldos-copy-" + op
	it.Native.StageIdentity, e = roots[tid].Mkdir(it.Native.Stage)
	must(t, e)
	for i, rel := range itemPaths(*it, true) {
		input := copyInput{Relative: rel, Output: path.Base(rel), Identity: itemIdentities(*it)[i]}
		dest := path.Join(it.Native.Stage, input.Output)
		st, e := copyFile(ctx, roots[sid], input, roots[tid], dest, nil)
		must(t, e)
		it.Native.Copied = append(it.Native.Copied, copiedFile{dest, st})
	}
	it.Status = "copy_ready"
	must(t, s.updateItem(ctx, op, *it))
	must(t, roots[tid].RenameTo(it.Native.Copied[0].Relative, roots[tid], it.Target, &it.Native.Copied[0].Identity))
	result, e := s.Recover(ctx)
	must(t, e)
	if str(result[0], "outcome") != "committed" {
		t.Fatal(result)
	}
	if !exists(t, to, "a.txt") || exists(t, to, it.Native.Stage) {
		t.Fatal("copy pair publication gap")
	}
	if len(allImages(t, s, tid)) != 1 {
		t.Fatal("copy recovery index stale")
	}
}

func TestSafePathsSymlinksRootReplacementAndTraversal(t *testing.T) {
	s := testService(t)
	ctx := context.Background()
	root, outside := t.TempDir(), t.TempDir()
	picture(t, root, "folder/a.png")
	put(t, outside, "secret.txt", []byte("secret"))
	sid := importScan(t, s, root)
	safe, e := s.OpenSource(ctx, sid)
	must(t, e)
	defer safe.Close()
	for _, bad := range []string{"../secret.txt", "/etc/passwd", "folder/../a.png", "a\\b", "a\x00b", "a/", "a/."} {
		_, e = safe.Open(bad)
		if e == nil {
			t.Fatal("unsafe path accepted", bad)
		}
	}
	must(t, os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "folder/a.txt")))
	_, e = s.GetAnnotation(ctx, AssetID(sid, "folder/a.png"))
	if e == nil {
		t.Fatal("caption symlink read")
	}
	_, _, e = safe.AtomicWrite("folder/a.txt", []byte("replace"), MissingDiskVersion)
	if e == nil {
		t.Fatal("caption symlink overwritten")
	}
	must(t, os.Remove(filepath.Join(root, "folder/a.txt")))
	must(t, os.Rename(filepath.Join(root, "folder"), filepath.Join(root, "held")))
	must(t, os.Symlink(outside, filepath.Join(root, "folder")))
	_, _, e = s.OpenImage(ctx, AssetID(sid, "folder/a.png"))
	if e == nil {
		t.Fatal("directory symlink followed")
	}
	must(t, os.Remove(filepath.Join(root, "folder")))
	must(t, os.Rename(filepath.Join(root, "held"), filepath.Join(root, "folder")))
	moved := root + "-held"
	must(t, os.Rename(root, moved))
	t.Cleanup(func() { _ = os.RemoveAll(moved) })
	must(t, os.Mkdir(root, 0755))
	e = safe.MkdirAll("must-not-write")
	wantError(t, e, "source_changed")
	if exists(t, root, "must-not-write") || exists(t, moved, "must-not-write") {
		t.Fatal("root replacement mutated files")
	}
	raw, e := os.ReadFile(filepath.Join(outside, "secret.txt"))
	must(t, e)
	if strings.TrimSpace(string(raw)) != "secret" {
		t.Fatal("outside modified")
	}
}
