package gallerycatalog

import (
	"context"
	"math"
	"path"

	"golang.org/x/sys/unix"
)

func diskUsage(root *SafeRoot, relative string) (int64, error) {
	st, e := root.Stat(relative)
	if e != nil {
		return 0, e
	}
	if st.Mode&unix.S_IFMT == unix.S_IFREG {
		return st.Size, nil
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return 0, failure("unsafe_source_path", 409)
	}
	entries, e := root.ReadDir(relative)
	if e != nil {
		return 0, e
	}
	var total int64
	for _, entry := range entries {
		n, e := diskUsage(root, path.Join(relative, entry.Name()))
		if e != nil {
			return 0, e
		}
		total += n
	}
	return total, nil
}
func (s *Service) ListTrash(ctx context.Context, cursor string, limit int) (Row, error) {
	limit, e := pageLimit(limit)
	if e != nil {
		return nil, e
	}
	where := "kind='trash' AND status='committed'"
	args := []any{}
	if cursor != "" {
		row, e := s.db.QueryRow(ctx, "SELECT id,created_at FROM gallery_file_operations WHERE id=?", cursor)
		if e != nil {
			return nil, e
		}
		if row == nil {
			return nil, failure("invalid_cursor", 422)
		}
		where += " AND (created_at,id)<(?,?)"
		args = append(args, row["created_at"], row["id"])
	}
	args = append(args, limit+1)
	rows, e := s.db.QueryRows(ctx, "SELECT * FROM gallery_file_operations WHERE "+where+" ORDER BY created_at DESC,id DESC LIMIT ?", args...)
	if e != nil {
		return nil, e
	}
	var next any
	if len(rows) > limit {
		next = rows[limit-1]["id"]
		rows = rows[:limit]
	}
	out := []Row{}
	for _, op := range rows {
		_, items, e := s.operation(ctx, str(op, "id"))
		if e != nil {
			return nil, e
		}
		var bytes int64
		errors, txt := 0, 0
		for _, it := range items {
			if it.HasTxt {
				txt++
			}
			root, e := s.OpenSource(ctx, it.SourceID)
			if e != nil {
				errors++
				continue
			}
			itemError := false
			for _, rel := range itemPaths(it, false) {
				n, e := diskUsage(root, rel)
				if e != nil {
					itemError = true
				} else {
					bytes += n
				}
			}
			root.Close()
			if itemError {
				errors++
			}
		}
		at, _ := op["created_at"].(float64)
		if at == 0 {
			at = float64(num(op, "created_at"))
		}
		out = append(out, Row{"operation_id": op["id"], "created_at": int64(math.Round(at * 1000)), "item_count": len(items), "has_txt_count": txt, "item_error_count": errors, "disk_usage_bytes": bytes})
	}
	return Row{"operations": out, "next_cursor": next}, nil
}
func (s *Service) PurgeAllTrash(ctx context.Context) (Row, error) {
	rows, e := s.db.QueryRows(ctx, "SELECT id FROM gallery_file_operations WHERE kind='trash' AND status='committed' ORDER BY created_at,id")
	if e != nil {
		return nil, e
	}
	operations, count := 0, 0
	for _, row := range rows {
		result, e := s.Purge(ctx, str(row, "id"))
		if e != nil {
			return nil, e
		}
		operations++
		count += result.ItemCount
	}
	return Row{"purged_operations": operations, "purged_items": count}, nil
}
