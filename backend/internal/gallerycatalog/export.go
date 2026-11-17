package gallerycatalog

import (
	"context"
	"errors"
	"path"
	"path/filepath"
	"strings"
	"time"

	"ldos/backend/internal/activity"
)

type exportSelection struct {
	SourceID, Relative, Name string
	Root                     fileIdentity
}
type exportOperation struct {
	id, target string
	identity   fileIdentity
	selections []exportSelection
	sourceIDs  []string
	projection Row
	ctx        context.Context
	cancel     context.CancelFunc
	finished   float64
}
type idempotentExport struct {
	Request     string
	OperationID string
}

func (s *Service) StartDirectoryExport(ctx context.Context, directoryIDs []string, targetPath, idempotencyKey string) (Row, error) {
	if len(directoryIDs) < 1 || len(directoryIDs) > 500 {
		return nil, failure("invalid_directory_ids", 422)
	}
	for _, did := range directoryIDs {
		if did == "" || len(did) > 128 {
			return nil, failure("invalid_directory_ids", 422)
		}
	}
	if !filepath.IsAbs(targetPath) {
		return nil, failure("target_path_not_absolute", 422)
	}
	if len(targetPath) > 4096 || strings.ContainsAny(targetPath, "\x00\n\r") {
		return nil, failure("target_path_invalid", 422)
	}
	request := jsonText(Row{"directory_ids": directoryIDs, "target_path": targetPath})
	s.mu.Lock()
	if previous, ok := s.idempotency[idempotencyKey]; idempotencyKey != "" && ok {
		if previous.Request != request {
			s.mu.Unlock()
			return nil, failure("idempotency_conflict", 409)
		}
		op := s.exports[previous.OperationID]
		if op != nil {
			result := exportProjection(op)
			s.mu.Unlock()
			return result, nil
		}
	}
	s.mu.Unlock()
	target, e := OpenSafeRoot(targetPath)
	if e != nil {
		code := "target_unavailable"
		if errorCode(e) == "unsafe_source_path" {
			code = "target_path_unsafe"
		}
		return nil, &Error{Code: code, Status: 409, Cause: e}
	}
	defer target.Close()
	selections := []exportSelection{}
	sourceIDs := []string{}
	names := map[string]bool{}
	for _, did := range unique(directoryIDs) {
		d, e := s.GetDirectory(ctx, did)
		if e != nil {
			return nil, e
		}
		sid := str(d, "source_id")
		source, e := s.Source(ctx, sid)
		if e != nil {
			return nil, e
		}
		root, e := s.OpenSource(ctx, sid)
		if e != nil {
			return nil, e
		}
		name := str(d, "name")
		if str(d, "relative_path") == "" {
			name = filepath.Base(str(source, "root_path"))
		}
		if ValidateRelativePath(name, false) != nil || strings.Contains(name, "/") || reserved(name) {
			root.Close()
			return nil, failure("directory_name_invalid", 422)
		}
		if names[name] {
			root.Close()
			return nil, failure("selected_name_conflict", 409)
		}
		names[name] = true
		selectedPath := filepath.Join(root.path, filepath.FromSlash(str(d, "relative_path")))
		relation := rootRelation(target.path, selectedPath)
		if relation == "same" || relation == "descendant" {
			root.Close()
			return nil, failure("target_inside_source", 409)
		}
		exists, e := target.Exists(name)
		if e != nil {
			root.Close()
			return nil, e
		}
		if exists {
			root.Close()
			return nil, &Error{Code: "target_name_conflict", Status: 409, Details: Row{"directory_name": name}}
		}
		if _, e = root.Stat(str(d, "relative_path")); e != nil {
			root.Close()
			return nil, wrapIO(e, "source_changed")
		}
		selections = append(selections, exportSelection{sid, str(d, "relative_path"), name, root.identity})
		root.Close()
		sourceIDs = append(sourceIDs, sid)
	}
	// A target inside another registered source participates in that source's lock.
	all, e := s.db.QueryRows(ctx, "SELECT id,root_path FROM gallery_sources")
	if e != nil {
		return nil, e
	}
	for _, source := range all {
		relation := rootRelation(target.path, str(source, "root_path"))
		if relation == "same" || relation == "descendant" {
			sourceIDs = append(sourceIDs, str(source, "id"))
		}
	}
	probe := ".ldos-copy-probe-" + id()
	probeStat, e := target.Mkdir(probe)
	if e != nil {
		return nil, wrapIO(e, "target_not_writable")
	}
	if e = target.Remove(probe, &probeStat); e != nil {
		return nil, wrapIO(e, "target_not_writable")
	}
	opctx, cancel := context.WithCancel(s.ctx)
	operationID := id()
	op := &exportOperation{id: operationID, target: target.path, identity: target.identity, selections: selections, sourceIDs: unique(sourceIDs), ctx: opctx, cancel: cancel, projection: Row{"operation_id": operationID, "state": "copying", "current_directory_name": nil, "directory_count": len(selections), "completed_directory_count": 0, "failed_directory_count": 0, "discovered_file_count": 0, "copied_file_count": 0, "discovered_byte_count": int64(0), "copied_byte_count": int64(0), "error_code": nil, "successful_directory_names": []string{}, "results": []Row{}}}
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		cancel()
		return nil, failure("service_stopping", 503)
	}
	if _, busy := s.targets[target.path]; busy {
		s.mu.Unlock()
		cancel()
		return nil, failure("target_busy", 409)
	}
	active := 0
	for key, old := range s.exports {
		if old.finished != 0 && now()-old.finished > 3600 {
			delete(s.exports, key)
		} else if str(old.projection, "state") == "copying" {
			active++
		}
	}
	if active >= 4 {
		s.mu.Unlock()
		cancel()
		return nil, failure("operation_capacity_reached", 429)
	}
	if len(s.exports) >= 128 {
		var oldest *exportOperation
		for _, old := range s.exports {
			if old.finished != 0 && (oldest == nil || old.finished < oldest.finished) {
				oldest = old
			}
		}
		if oldest == nil {
			s.mu.Unlock()
			cancel()
			return nil, failure("operation_capacity_reached", 429)
		}
		delete(s.exports, oldest.id)
	}
	if previous, ok := s.idempotency[idempotencyKey]; idempotencyKey != "" && ok {
		if previous.Request != request {
			s.mu.Unlock()
			cancel()
			return nil, failure("idempotency_conflict", 409)
		}
		if existing := s.exports[previous.OperationID]; existing != nil {
			result := exportProjection(existing)
			s.mu.Unlock()
			cancel()
			return result, nil
		}
	}
	s.exports[operationID] = op
	s.targets[target.path] = operationID
	if idempotencyKey != "" {
		s.idempotency[idempotencyKey] = idempotentExport{request, operationID}
	}
	result := exportProjection(op)
	s.wg.Add(1)
	s.mu.Unlock()
	if s.jobs != nil {
		_, _ = s.jobs.Start("gallery.export", "导出图库目录", activity.StartOptions{ID: "export:" + operationID, Ref: map[string]string{"operation_id": operationID}})
	}
	go func() { defer s.wg.Done(); s.runDirectoryExport(op) }()
	return result, nil
}
func exportProjection(op *exportOperation) Row {
	r := clone(op.projection)
	r["successful_directory_names"] = append([]string{}, op.projection["successful_directory_names"].([]string)...)
	results := []Row{}
	for _, item := range op.projection["results"].([]Row) {
		results = append(results, clone(item))
	}
	r["results"] = results
	return r
}
func (s *Service) exportChange(op *exportOperation, fn func(Row)) {
	s.mu.Lock()
	fn(op.projection)
	s.mu.Unlock()
}
func (s *Service) runDirectoryExport(op *exportOperation) {
	var resultErr error
	copiedTotal := 0
	defer func() {
		s.mu.Lock()
		if str(op.projection, "state") == "copying" {
			op.projection["state"] = "completed"
		}
		op.projection["current_directory_name"] = nil
		op.finished = now()
		delete(s.targets, op.target)
		s.mu.Unlock()
		op.cancel()
		s.finishJob("export:"+op.id, resultErr, copiedTotal)
	}()
	keys := []string{"target:" + op.target}
	for _, sid := range op.sourceIDs {
		keys = append(keys, "source:"+sid)
	}
	release, e := s.locks.Hold(op.ctx, keys...)
	if e != nil {
		resultErr = e
		s.exportFail(op, e)
		return
	}
	defer release()
	target, e := OpenSafeRoot(op.target)
	if e != nil {
		resultErr = e
		s.exportFail(op, failure("target_path_unsafe", 409))
		return
	}
	defer target.Close()
	if !op.identity.sameFile(target.identity) {
		resultErr = failure("target_root_changed", 409)
		s.exportFail(op, resultErr)
		return
	}
	for _, selected := range op.selections {
		if e = op.ctx.Err(); e != nil {
			resultErr = e
			s.exportFail(op, e)
			return
		}
		s.exportChange(op, func(r Row) { r["current_directory_name"] = selected.Name })
		root, e := s.OpenSource(op.ctx, selected.SourceID)
		if e != nil {
			resultErr = e
			s.exportFail(op, e)
			return
		}
		if !selected.Root.sameFile(root.identity) {
			root.Close()
			resultErr = failure("source_changed", 409)
			s.exportFail(op, resultErr)
			return
		}
		stage := ".ldos-copy-" + op.id + "-" + id()
		owned := fileIdentity{}
		copied := []copiedFile{}
		var bytes int64
		inputs, copyErr := discoverFiles(op.ctx, root, selected.Relative, true)
		if copyErr == nil {
			s.exportChange(op, func(r Row) {
				r["discovered_file_count"] = num(r, "discovered_file_count") + int64(len(inputs))
				for _, input := range inputs {
					r["discovered_byte_count"] = num(r, "discovered_byte_count") + input.Identity.Size
				}
			})
			owned, copyErr = target.Mkdir(stage)
		}
		if copyErr == nil {
			for _, input := range inputs {
				destination := path.Join(stage, input.Output)
				file, e := copyFile(op.ctx, root, input, target, destination, func(count int64) {
					s.exportChange(op, func(r Row) { r["copied_byte_count"] = num(r, "copied_byte_count") + count })
				})
				if e != nil {
					copyErr = e
					break
				}
				copied = append(copied, copiedFile{destination, file})
				bytes += file.Size
				copiedTotal++
				s.exportChange(op, func(r Row) { r["copied_file_count"] = num(r, "copied_file_count") + 1 })
				s.progressJob("export:"+op.id, copiedTotal, nil)
			}
		}
		root.Close()
		if copyErr == nil {
			copyErr = verifyCopied(target, stage, owned, copied)
		}
		if copyErr == nil {
			copyErr = op.ctx.Err()
		}
		if copyErr == nil {
			copyErr = target.RenameTo(stage, target, selected.Name, &owned)
		}
		if copyErr != nil {
			// Never remove an unowned preexisting generated name.
			if owned.Inode != 0 {
				if cleanupErr := cleanupCopied(target, stage, owned, copied); cleanupErr != nil {
					copyErr = cleanupErr
				}
			}
			resultErr = copyErr
			state := "failed"
			if errors.Is(copyErr, context.Canceled) {
				state = "cancelled"
			}
			s.exportChange(op, func(r Row) {
				r["results"] = append(r["results"].([]Row), Row{"directory_name": selected.Name, "status": state, "copied_file_count": len(copied), "copied_byte_count": bytes, "error_code": errorCode(copyErr)})
				if state == "failed" {
					r["failed_directory_count"] = num(r, "failed_directory_count") + 1
				}
			})
			s.exportFail(op, copyErr)
			return
		}
		s.exportChange(op, func(r Row) {
			r["completed_directory_count"] = num(r, "completed_directory_count") + 1
			r["successful_directory_names"] = append(r["successful_directory_names"].([]string), selected.Name)
			r["results"] = append(r["results"].([]Row), Row{"directory_name": selected.Name, "status": "completed", "copied_file_count": len(copied), "copied_byte_count": bytes, "error_code": nil})
		})
	}
}
func (s *Service) exportFail(op *exportOperation, err error) {
	s.exportChange(op, func(r Row) {
		state := "failed"
		code := errorCode(err)
		if errors.Is(err, context.Canceled) {
			state = "cancelled"
			code = ""
		}
		if code == "io_error" {
			code = "copy_failed"
		}
		r["state"] = state
		if code == "" {
			r["error_code"] = nil
		} else {
			r["error_code"] = code
		}
	})
}
func (s *Service) GetDirectoryExport(operationID string) (Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	op := s.exports[operationID]
	if op == nil {
		return nil, failure("operation_not_found", 404)
	}
	return exportProjection(op), nil
}
func (s *Service) CancelDirectoryExport(operationID string) (Row, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	op := s.exports[operationID]
	if op == nil {
		return nil, failure("operation_not_found", 404)
	}
	op.cancel()
	return exportProjection(op), nil
}

// WaitDirectoryExport is useful to local integrations and tests, without polling
// the HTTP API. It never causes a second export or extends operation retention.
func (s *Service) WaitDirectoryExport(ctx context.Context, operationID string) (Row, error) {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		r, e := s.GetDirectoryExport(operationID)
		if e != nil || str(r, "state") != "copying" {
			return r, e
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}
