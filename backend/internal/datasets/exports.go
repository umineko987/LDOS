package datasets

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"ldos/backend/internal/activity"
	"ldos/backend/internal/store"
)

func resumable(r Record) bool {
	return str(r["status"]) == "interrupted" || str(r["status"]) == "failed" && (str(r["error_class"]) == "export_target_exists" || str(r["error_class"]) == "copy_io_error")
}
func (s *Service) exportRow(ctx context.Context, id string) (Record, error) {
	r, e := s.deps.Store.QueryRow(ctx, "SELECT * FROM dataset_export_jobs WHERE id=? AND dataset_id!=''", id)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, failure(404, "export_not_found", "导出任务不存在")
	}
	return r, nil
}
func (s *Service) GetExport(ctx context.Context, id string) (Record, error) {
	r, e := s.exportRow(ctx, id)
	if e != nil {
		return nil, e
	}
	return s.projectExport(ctx, r)
}
func (s *Service) ListExports(ctx context.Context, id string, limit int) ([]Record, error) {
	if e := s.Require(ctx, id); e != nil {
		return nil, e
	}
	if limit == 0 {
		limit = 50
	}
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT * FROM dataset_export_jobs WHERE dataset_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?", id, max(1, min(limit, 200)))
	if e != nil {
		return nil, e
	}
	out := []Record{}
	for _, r := range rows {
		p, e := s.projectExport(ctx, r)
		if e != nil {
			return nil, e
		}
		out = append(out, p)
	}
	return out, nil
}
func (s *Service) projectExport(ctx context.Context, r Record) (Record, error) {
	o := object(r["options_json"])
	delete(o, "target_identity")
	id := str(r["id"])
	progress, e := s.deps.Store.QueryRow(ctx, "SELECT COUNT(*) AS staged,COALESCE(SUM(image_size_bytes+txt_size_bytes),0) AS bytes FROM dataset_export_items WHERE job_id=? AND copy_state='staged'", id)
	if e != nil {
		return nil, e
	}
	event, e := s.deps.Store.QueryRow(ctx, "SELECT detail_json FROM dataset_export_events WHERE job_id=? AND event_type='finished' ORDER BY id DESC LIMIT 1", id)
	if e != nil {
		return nil, e
	}
	var details, code, galleryWarning any
	if event != nil {
		result := object(event["detail_json"])["details"]
		switch str(r["status"]) {
		case "failed":
			details = result
		case "succeeded":
			galleryWarning = object(result)["gallery_warning"]
		}
	}
	if str(r["error_class"]) != "" {
		code = r["error_class"]
	}
	folder := str(o["folder_name"])
	return Record{"export_id": id, "dataset_id": r["dataset_id"], "status": r["status"], "target_path": r["target_path"], "folder_name": folder, "output_path": filepath.Join(str(r["target_path"]), folder), "options": o, "total_items": r["sample_count"], "staged_items": progress["staged"], "image_bytes": r["image_bytes"], "txt_bytes": r["txt_bytes"], "total_bytes": num(r["image_bytes"]) + num(r["txt_bytes"]), "copied_bytes": progress["bytes"], "error_code": code, "error_details": details, "gallery_warning": galleryWarning, "resumable": resumable(r), "job_id": "dataset-export:" + id, "created_at": r["created_at"], "updated_at": r["updated_at"], "started_at": r["started_at"], "finished_at": r["finished_at"]}, nil
}
func (s *Service) reserveLocked(id, key string) (context.Context, error) {
	if s.stopping || s.ctx.Err() != nil {
		return nil, failure(409, "service_stopping", "后端正在关闭")
	}
	for existing, w := range s.workers {
		if existing == id || w.reservation == key {
			return nil, failure(409, "export_target_busy", "同一个目标文件夹正在导出")
		}
	}
	if len(s.workers) >= 2 {
		return nil, failure(409, "export_capacity_reached", "同时进行的导出太多了，请稍后再试")
	}
	ctx, cancel := context.WithCancel(s.ctx)
	s.workers[id] = &exportWorker{cancel: cancel, reservation: key}
	s.wg.Add(1)
	return ctx, nil
}
func (s *Service) release(id string) {
	s.mu.Lock()
	if w := s.workers[id]; w != nil {
		w.cancel()
		delete(s.workers, id)
		s.wg.Done()
	}
	s.mu.Unlock()
}
func checkExportInput(ctx context.Context, query func(context.Context, string, ...any) (Record, error), id string) error {
	// Clean and dedup can apply automatic exclusions before they finish. Tag
	// generation only fills the cache; caption writes use the source locks.
	r, e := query(ctx, `SELECT stage FROM dataset_stage_runs WHERE dataset_id=? AND status='running' AND stage IN ('clean','dedup')
		UNION ALL SELECT 'collect' FROM dataset_crawls c JOIN crawl_batches b ON b.id=c.batch_id
		WHERE c.dataset_id=? AND c.state='pending' AND b.status IN ('queued','running','cancelling') LIMIT 1`, id, id)
	if e != nil {
		return e
	}
	if r != nil {
		return failure(409, "export_input_busy", "采集或整理任务正在改动数据集，请等待任务结束后再导出", Record{"stage": r["stage"]})
	}
	return nil
}

func (s *Service) CreateExport(ctx context.Context, id string, options Record) (Record, error) {
	p, e := s.planExport(ctx, id, options)
	if e != nil {
		return nil, e
	}
	if len(p.blockers) > 0 {
		return nil, failure(409, "export_"+str(p.blockers[0]["code"]), "有图片暂时不能导出", Record{"blockers": p.blockers})
	}
	if p.targetExists {
		return nil, failure(409, "export_target_exists", "导出目录里已经有同名文件夹", Record{"output_path": filepath.Join(p.target, str(p.options["folder_name"]))})
	}
	exportID := uuid.NewString()
	s.mu.Lock()
	workerCtx, e := s.reserveLocked(exportID, p.key+"\x00"+portableName(str(p.options["folder_name"])))
	s.mu.Unlock()
	if e != nil {
		return nil, e
	}
	if e = s.insertExport(ctx, exportID, p); e != nil {
		s.release(exportID)
		return nil, e
	}
	s.PublishUpdated(id, "stage_run")
	s.publishExport(ctx, exportID)
	result, e := s.GetExport(ctx, exportID)
	go s.runExport(workerCtx, exportID)
	return result, e
}
func (s *Service) insertExport(ctx context.Context, id string, p *exportPlan) error {
	o := Record{}
	for k, v := range p.options {
		o[k] = v
	}
	o["target_identity"] = p.identity
	jsonOptions, e := jsonText(o)
	if e != nil {
		return e
	}
	digest, e := s.StageInputDigest(ctx, p.datasetID, "export")
	if e != nil {
		return e
	}
	t := now()
	return s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		if e := requireTx(ctx, tx, p.datasetID); e != nil {
			return e
		}
		if e := checkExportInput(ctx, func(ctx context.Context, q string, args ...any) (Record, error) {
			return store.QueryRowTx(ctx, tx, q, args...)
		}, p.datasetID); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, `INSERT INTO dataset_export_jobs(id,dataset_id,options_json,status,target_path,sample_count,image_bytes,txt_bytes,snapshot_digest,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,?,?,?,?)`, id, p.datasetID, jsonOptions, p.target, len(p.items), p.imageBytes, p.txtBytes, digest, t, t)
		if e != nil {
			return e
		}
		for _, m := range p.items {
			has := 0
			if str(m["txt_output_relative_path"]) != "" {
				has = 1
			}
			_, e = tx.ExecContext(ctx, `INSERT INTO dataset_export_items(job_id,asset_id,source_id,output_relative_path,source_relative_path,txt_output_relative_path,txt_source_relative_path,has_txt,expected_content_version,expected_txt_version,image_size_bytes,txt_size_bytes,image_sha256,txt_sha256,copy_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`, id, m["asset_id"], m["source_id"], m["output_relative_path"], m["source_relative_path"], m["txt_output_relative_path"], m["txt_source_relative_path"], has, m["expected_content_version"], m["expected_txt_version"], m["image_size_bytes"], m["txt_size_bytes"], m["image_sha256"], m["txt_sha256"])
			if e != nil {
				return e
			}
		}
		detail, _ := jsonText(Record{"items": len(p.items), "collisions": len(p.collisions)})
		if _, e = tx.ExecContext(ctx, "INSERT INTO dataset_export_events(job_id,ts,event_type,detail_json) VALUES(?,?,'planned',?)", id, t, detail); e != nil {
			return e
		}
		stats, _ := jsonText(Record{"export_id": id})
		_, e = tx.ExecContext(ctx, `INSERT INTO dataset_stage_runs(id,dataset_id,stage,status,ref_id,input_digest,stats_json,error_code,created_at,updated_at) VALUES(?,?,'export','running',?,?,?,'',?,?)`, uuid.NewString(), p.datasetID, id, digest, stats, t, t)
		if e != nil {
			return e
		}
		return touch(ctx, tx, p.datasetID)
	})
}
func (s *Service) ResumeExport(ctx context.Context, id string) (Record, error) {
	s.mu.Lock()
	r, e := s.exportRow(ctx, id)
	if e != nil {
		s.mu.Unlock()
		return nil, e
	}
	if !resumable(r) {
		s.mu.Unlock()
		return nil, failure(409, "export_not_resumable", "这次导出不能续传", Record{"status": r["status"], "error_code": r["error_class"]})
	}
	o := object(r["options_json"])
	key, e := filepath.EvalSymlinks(str(r["target_path"]))
	if e != nil {
		s.mu.Unlock()
		return nil, failure(409, "target_unavailable", "导出目录不可用")
	}
	wctx, e := s.reserveLocked(id, key+"\x00"+portableName(str(o["folder_name"])))
	if e != nil {
		s.mu.Unlock()
		return nil, e
	}
	e = s.exec(ctx, "UPDATE dataset_export_jobs SET status='queued',error_class='',finished_at=NULL,updated_at=? WHERE id=?", now(), id)
	if e == nil {
		e = s.exportEvent(ctx, id, "resumed", Record{})
	}
	if e == nil {
		_, e = s.StartStageRun(ctx, str(r["dataset_id"]), "export", StageRunOptions{RefID: id, Stats: Record{"export_id": id}})
	}
	s.mu.Unlock()
	if e != nil {
		s.release(id)
		_ = s.finishExport(context.Background(), id, "interrupted", "export_interrupted", nil, nil)
		return nil, e
	}
	s.publishExport(ctx, id)
	result, e := s.GetExport(ctx, id)
	go s.runExport(wctx, id)
	return result, e
}
func (s *Service) CancelExport(ctx context.Context, id string) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, e := s.exportRow(ctx, id)
	if e != nil {
		return nil, e
	}
	if w := s.workers[id]; w != nil {
		w.cancel()
		return s.projectExport(ctx, r)
	}
	status := str(r["status"])
	if status != "queued" && status != "running" && !resumable(r) {
		return nil, failure(409, "export_not_cancellable", "这次导出已经结束", Record{"status": status})
	}
	if e = s.removeStaging(ctx, id); e != nil {
		return nil, e
	}
	if e = s.finishExport(ctx, id, "cancelled", "", nil, nil); e != nil {
		return nil, e
	}
	return s.GetExport(ctx, id)
}
func (s *Service) RecoverExports(ctx context.Context) (int, error) {
	rows, e := s.deps.Store.QueryRows(ctx, "SELECT * FROM dataset_export_jobs WHERE dataset_id!='' AND status IN ('queued','running')")
	if e != nil {
		return 0, e
	}
	count := 0
	for _, r := range rows {
		id := str(r["id"])
		s.mu.Lock()
		if s.workers[id] != nil {
			s.mu.Unlock()
			continue
		}
		output, err := s.recoverCommittedExport(ctx, r)
		if err == nil && output == nil {
			err = s.finishExport(ctx, id, "interrupted", "export_interrupted", nil, nil)
		}
		if err == nil && output != nil {
			err = s.resumeCommittedExportLocked(id, r, output)
		}
		s.mu.Unlock()
		if err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}
func (s *Service) resumeCommittedExportLocked(id string, row Record, output *committedExport) error {
	key := str(row["target_path"]) + "\x00" + portableName(str(output.stats["folder_name"]))
	if _, err := s.reserveLocked(id, key); err != nil {
		output.dir.Close()
		return err
	}
	go func() {
		defer s.release(id)
		_ = s.finishCommittedExport(id, output)
	}()
	return nil
}
func (s *Service) exportEvent(ctx context.Context, id, kind string, detail Record) error {
	j, e := jsonText(detail)
	if e != nil {
		return e
	}
	return s.exec(ctx, "INSERT INTO dataset_export_events(job_id,ts,event_type,detail_json) VALUES(?,?,?,?)", id, now(), kind, j)
}
func (s *Service) stagingIdentity(ctx context.Context, id string) (fileIdentity, bool, error) {
	r, e := s.deps.Store.QueryRow(ctx, "SELECT detail_json FROM dataset_export_events WHERE job_id=? AND event_type='staging_created' ORDER BY id DESC LIMIT 1", id)
	if e != nil || r == nil {
		return fileIdentity{}, false, e
	}
	ident, e := readIdentity(object(r["detail_json"])["identity"])
	return ident, true, e
}
func (s *Service) exportItems(ctx context.Context, id string) ([]Record, error) {
	return s.deps.Store.QueryRows(ctx, "SELECT * FROM dataset_export_items WHERE job_id=? ORDER BY rowid", id)
}
func (s *Service) publishExport(ctx context.Context, id string) {
	r, e := s.exportRow(ctx, id)
	if e == nil {
		s.publish("dataset.export.updated", Record{"dataset_id": r["dataset_id"], "export_id": id, "status": r["status"]})
	}
}
func (s *Service) exportProgress(ctx context.Context, id string, current, total int) {
	if s.deps.Jobs == nil {
		return
	}
	jobID := "dataset-export:" + id
	j := s.deps.Jobs.Get(jobID)
	if j == nil || j.Status.Terminal() {
		r, e := s.exportRow(ctx, id)
		if e != nil {
			return
		}
		_, _ = s.deps.Jobs.Start("dataset.export", "导出数据集", activity.StartOptions{ID: jobID, Current: &current, Total: &total, Ref: map[string]string{"dataset_id": str(r["dataset_id"]), "export_id": id}})
	} else {
		message := fmt.Sprintf("%d/%d", current, total)
		_, _ = s.deps.Jobs.Update(jobID, activity.UpdateOptions{Current: &current, Total: &total, Message: &message})
	}
}
func (s *Service) finishExport(ctx context.Context, id, status, code string, stats, details Record) error {
	t := now()
	var dataset string
	var runUpdated bool
	e := s.deps.Store.WriteTransaction(ctx, func(tx *sql.Tx) error {
		r, e := store.QueryRowTx(ctx, tx, "SELECT dataset_id FROM dataset_export_jobs WHERE id=?", id)
		if e != nil {
			return e
		}
		if r == nil {
			return failure(404, "export_not_found", "导出任务不存在")
		}
		dataset = str(r["dataset_id"])
		if _, e = tx.ExecContext(ctx, "UPDATE dataset_export_jobs SET status=?,error_class=?,updated_at=?,finished_at=? WHERE id=?", status, code, t, t, id); e != nil {
			return e
		}
		if status == "succeeded" {
			// Persist the commit journal with the terminal result. A DB failure
			// after the rename leaves the job recoverable, not a copy failure.
			if _, e = tx.ExecContext(ctx, `INSERT INTO dataset_export_events(job_id,ts,event_type,detail_json)
				SELECT ?,?,'committed','{}' WHERE NOT EXISTS (SELECT 1 FROM dataset_export_events WHERE job_id=? AND event_type='committed')`, id, t, id); e != nil {
				return e
			}
		}
		detail := Record{"status": status, "error_code": code}
		if len(details) > 0 {
			detail["details"] = details
		}
		j, e := jsonText(detail)
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, "INSERT INTO dataset_export_events(job_id,ts,event_type,detail_json) VALUES(?,?,'finished',?)", id, t, j); e != nil {
			return e
		}
		run, e := store.QueryRowTx(ctx, tx, "SELECT id,stats_json FROM dataset_stage_runs WHERE ref_id=? AND stage='export' AND status='running' ORDER BY created_at DESC,rowid DESC LIMIT 1", id)
		if e != nil {
			return e
		}
		if run != nil {
			st := object(run["stats_json"])
			for k, v := range stats {
				st[k] = v
			}
			j, e := jsonText(st)
			if e != nil {
				return e
			}
			runStatus := status
			if status == "interrupted" {
				runStatus = "failed"
			}
			_, e = tx.ExecContext(ctx, "UPDATE dataset_stage_runs SET status=?,stats_json=?,error_code=?,updated_at=?,finished_at=? WHERE id=?", runStatus, j, code, t, t, run["id"])
			runUpdated = true
			return e
		}
		return nil
	})
	if e != nil {
		return e
	}
	if runUpdated {
		s.PublishUpdated(dataset, "stage_run")
	}
	if s.deps.Jobs != nil {
		jobID := "dataset-export:" + id
		jobStatus := activity.JobStatus(status)
		message := code
		if status == "interrupted" {
			jobStatus = activity.StatusFailed
			message = "已中断，可以续传"
		}
		if s.deps.Jobs.Get(jobID) == nil {
			_, _ = s.deps.Jobs.Start("dataset.export", "导出数据集", activity.StartOptions{ID: jobID, Ref: map[string]string{"dataset_id": dataset, "export_id": id}})
		}
		_, _ = s.deps.Jobs.Finish(jobID, activity.FinishOptions{Status: jobStatus, Message: &message})
	}
	s.publishExport(ctx, id)
	s.publish("dataset.stage.updated", Record{"dataset_id": dataset, "stage": "export", "export_id": id, "status": status})
	return nil
}
func (s *Service) WaitExport(ctx context.Context, id string) (Record, error) {
	for {
		r, e := s.GetExport(ctx, id)
		if e != nil {
			return nil, e
		}
		s.mu.Lock()
		active := s.workers[id] != nil
		s.mu.Unlock()
		if !active && !strings.Contains("queued running", str(r["status"])) {
			return r, nil
		}
		if e = waitTick(ctx); e != nil {
			return nil, e
		}
	}
}
