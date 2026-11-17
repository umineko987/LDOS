package atlas

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/modelservice"
	"ldos/backend/internal/redaction"
)

type RunRequest struct {
	Force      bool     `json:"force"`
	Clusters   *int     `json:"clusters"`
	Perplexity *float64 `json:"perplexity"`
}

func normalize(request RunRequest) (Record, error) {
	opts := Record{}
	if request.Clusters != nil {
		if *request.Clusters < 1 || *request.Clusters > 256 {
			return nil, failure(422, "validation_error", "聚类数量必须为 1..256")
		}
		opts["clusters"] = *request.Clusters
	}
	if request.Perplexity != nil {
		v := *request.Perplexity
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 2 || v > 100 {
			return nil, failure(422, "validation_error", "perplexity 必须为 2..100")
		}
		opts["perplexity"] = v
	}
	return opts, nil
}
func (s *Service) Run(ctx context.Context, id string, request RunRequest) (Record, error) {
	dataset, e := s.require(ctx, id)
	if e != nil {
		return nil, e
	}
	opts, e := normalize(request)
	if e != nil {
		return nil, e
	}
	if e = s.Start(); e != nil {
		return nil, e
	}
	availability := s.Availability()
	if availability["available"] != true {
		return nil, failure(409, "atlas_unavailable", map[string]string{"dedup_disabled": "语义地图依赖去重环境，去重功能当前已关闭", "python_missing": "去重 Python 环境不存在", "worker_missing": "语义地图 worker 不存在"}[text(availability["reason"])])
	}
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return nil, failure(503, "atlas_unavailable", "后端正在关闭")
	}
	if s.active[id] != nil {
		s.mu.Unlock()
		return s.Status(ctx, id)
	}
	s.mu.Unlock()
	members, e := s.members(ctx, id)
	if e != nil {
		return nil, e
	}
	if len(members) == 0 {
		return nil, failure(422, "atlas_empty", "打标阶段没有可用图片，无法生成语义地图")
	}
	complete := true
	for _, m := range members {
		if text(m["content_sha256"]) == "" {
			complete = false
		}
	}
	if !request.Force && complete {
		if cached, ok := s.loadRun(id, s.current(id)); ok && text(cached.meta["input_digest"]) == Digest(inputs(members), opts) {
			s.mu.Lock()
			delete(s.failures, id)
			s.mu.Unlock()
			v, e := s.Status(ctx, id)
			if e == nil {
				v["cached"] = true
			}
			return v, e
		}
	}
	random := make([]byte, 4)
	if _, e = rand.Read(random); e != nil {
		return nil, e
	}
	run := fmt.Sprintf("%013d-%s", time.Now().UnixMilli(), hex.EncodeToString(random))
	runCtx, cancel := context.WithCancel(s.ctx)
	active := &activeRun{dataset: id, id: run, job: "atlas:" + id, phase: "queued", options: opts, force: request.Force, started: now(), cancel: cancel, finished: make(chan struct{})}
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		cancel()
		return nil, failure(503, "atlas_unavailable", "后端正在关闭")
	}
	if s.active[id] != nil {
		s.mu.Unlock()
		cancel()
		return s.Status(ctx, id)
	}
	s.active[id] = active
	delete(s.failures, id)
	if s.deps.Jobs != nil {
		_, _ = s.deps.Jobs.Start("atlas.run", "语义地图 · "+text(dataset["name"]), activity.StartOptions{ID: active.job, Status: activity.StatusQueued, Message: label("queued"), Ref: map[string]string{"dataset_id": id, "run_id": run}})
	}
	s.wg.Add(1)
	s.mu.Unlock()
	s.publish(id, "running", run)
	go s.execute(runCtx, active)
	return s.Status(ctx, id)
}
func (s *Service) Cancel(ctx context.Context, id string) (Record, error) {
	if _, e := s.require(ctx, id); e != nil {
		return nil, e
	}
	s.mu.Lock()
	active := s.active[id]
	if active != nil {
		active.cancel()
	}
	s.mu.Unlock()
	if active != nil {
		select {
		case <-active.finished:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return s.Status(ctx, id)
}
func (s *Service) execute(ctx context.Context, active *activeRun) {
	defer s.wg.Done()
	defer close(active.finished)
	defer active.cancel()
	var e error
	select {
	case s.gate <- struct{}{}:
		e = s.executeHeld(ctx, active)
		<-s.gate
	case <-ctx.Done():
		e = ctx.Err()
	}
	status, message := "succeeded", ""
	if e != nil {
		status = "failed"
		message = redaction.Text(e.Error(), 500)
		code := "atlas_internal"
		var api *Error
		if errors.As(e, &api) {
			code, message = api.Code, api.Message
		}
		if ctx.Err() != nil {
			status, message = "cancelled", "已取消"
		} else {
			s.mu.Lock()
			s.failures[active.dataset] = Record{"code": code, "message": message, "at": now()}
			s.mu.Unlock()
		}
		s.discard(active.dataset, active.id)
	}
	s.mu.Lock()
	if s.deps.Jobs != nil {
		_, _ = s.deps.Jobs.Finish(active.job, activity.FinishOptions{Status: activity.JobStatus(status), Message: &message})
	}
	if s.active[active.dataset] == active {
		delete(s.active, active.dataset)
	}
	s.publish(active.dataset, status, active.id)
	s.mu.Unlock()
}

type prepared struct {
	dir, job, digest string
	inputs           map[string]string
	skipped          []Record
	count            int
}

func (s *Service) prepare(ctx context.Context, active *activeRun) (*prepared, error) {
	members, e := s.members(ctx, active.dataset)
	if e != nil {
		return nil, e
	}
	missing := []Record{}
	for _, m := range members {
		if text(m["content_sha256"]) == "" {
			missing = append(missing, m)
		}
	}
	if len(missing) > 0 && s.deps.Datasets.HashAsset != nil {
		for i, m := range missing {
			if e = ctx.Err(); e != nil {
				return nil, e
			}
			total := len(missing)
			s.setPhase(active, "hashing", &i, &total)
			_, _ = s.deps.Datasets.HashAsset(ctx, text(m["asset_id"]))
		}
		members, e = s.members(ctx, active.dataset)
		if e != nil {
			return nil, e
		}
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	in := inputs(members)
	digest := Digest(in, active.options)
	if !active.force {
		if old, ok := s.loadRun(active.dataset, s.current(active.dataset)); ok && text(old.meta["input_digest"]) == digest {
			return nil, nil
		}
	}
	p := &prepared{dir: s.runDir(active.dataset, active.id), digest: digest, inputs: in, skipped: []Record{}}
	p.job = filepath.Join(p.dir, "job.json")
	items := []Record{}
	for _, m := range members {
		if e = ctx.Err(); e != nil {
			return nil, e
		}
		id := text(m["asset_id"])
		sourceID, relative := text(m["source_id"]), text(m["relative_path"])
		source, e := s.deps.Store.QueryRow(ctx, "SELECT root_path,availability FROM gallery_sources WHERE id=?", sourceID)
		if e != nil {
			return nil, e
		}
		if source == nil || text(source["availability"]) != "available" {
			p.skipped = append(p.skipped, Record{"asset_id": id, "reason": "missing"})
			continue
		}
		f, e := s.openSource(ctx, sourceID, relative)
		if e != nil {
			reason := "unreadable"
			if errors.Is(e, os.ErrNotExist) {
				reason = "missing"
			}
			p.skipped = append(p.skipped, Record{"asset_id": id, "reason": reason})
			continue
		}
		f.Close()
		var hash any
		if h := text(m["content_sha256"]); h != "" {
			hash = h
		}
		path := filepath.Join(text(source["root_path"]), relative)
		path, e = filepath.Abs(path)
		if e != nil {
			return nil, e
		}
		item := Record{"asset_id": id, "path": path, "sha256": hash}
		if s.deps.Gallery.Thumbnail != nil {
			thumb, e := s.deps.Gallery.Thumbnail(id, int64(number(m["modified_ns"])), 256)
			if e == nil && thumb != "" && safePath(thumb) == nil && regularFile(thumb) {
				item["thumbnail_path"] = thumb
			}
		}
		items = append(items, item)
	}
	if len(items) == 0 {
		return nil, failure(422, "atlas_empty", "打标阶段的图片都无法读取，无法生成语义地图")
	}
	p.count = len(items)
	if e = writeJSON(p.job, Record{"schema_version": 1, "output_dir": p.dir, "items": items, "options": active.options}); e != nil {
		return nil, e
	}
	return p, nil
}
func (s *Service) executeHeld(ctx context.Context, active *activeRun) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	s.setPhase(active, "preparing", nil, nil)
	p, e := s.prepare(ctx, active)
	if e != nil || p == nil {
		return e
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	d := s.deps.Settings.Dedup
	args := []string{d.AtlasScript, "--job", p.job, "--output-dir", p.dir, "--model-dir", d.ModelDir, "--device", d.Device, "--workers", strconv.Itoa(max(0, min(d.Workers, 64))), "--torch-threads", strconv.Itoa(max(0, min(d.TorchThreads, 128))), "--deep-batch-size", strconv.Itoa(max(0, min(d.DeepBatchSize, 128)))}
	env := append(modelservice.OfflineEnvironment(), "PYTHONUTF8=1", "PYTHONUNBUFFERED=1")
	zero := 0
	s.setPhase(active, "read", &zero, &p.count)
	var workerError Record
	tail, e := modelservice.RunCommand(ctx, modelservice.Command{Executable: s.pythonExecutable(), Args: args, Dir: filepath.Dir(d.AtlasScript), Env: env, Grace: time.Duration(d.ShutdownGraceSeconds * float64(time.Second))}, func(line string) {
		var event Record
		if json.Unmarshal([]byte(line), &event) != nil {
			return
		}
		switch text(event["type"]) {
		case "stage":
			s.setPhase(active, text(event["stage"]), nil, nil)
		case "progress":
			var done, total *int
			if v, ok := event["done"]; ok && v != nil {
				n := int(number(v))
				done = &n
			}
			if v, ok := event["total"]; ok && v != nil {
				n := int(number(v))
				total = &n
			}
			s.setPhase(active, text(event["stage"]), done, total)
		case "error":
			workerError = event
		}
	})
	_ = writeBytes(filepath.Join(p.dir, "worker.log"), []byte(redaction.Text(tail, 4000)))
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if e != nil || !regularFile(filepath.Join(p.dir, "atlas.json")) {
		if workerError != nil {
			code := text(workerError["code"])
			if code == "" {
				code = "internal"
			}
			message := redaction.Text(text(workerError["message"]), 500)
			if message == "" {
				message = "语义地图 worker 失败（" + code + "）"
			}
			return failure(500, "atlas_"+code, message)
		}
		message := redaction.Text(tail, 500)
		if message == "" {
			message = "语义地图 worker 失败"
		}
		return failure(500, "atlas_worker_failed", message)
	}
	return s.commit(ctx, active, p)
}
func (s *Service) commit(ctx context.Context, active *activeRun, p *prepared) error {
	payload, e := readRecord(filepath.Join(p.dir, "atlas.json"))
	if e != nil || number(payload["schema_version"]) != 1 {
		return failure(500, "atlas_output_invalid", "atlas.json 格式无效")
	}
	if _, ok := payload["items"].([]any); !ok {
		return failure(500, "atlas_output_invalid", "atlas.json 点位无效")
	}
	if v := payload["sprites"]; v != nil {
		sprites, ok := v.(map[string]any)
		if !ok {
			return failure(500, "atlas_output_invalid", "atlas.json 的雪碧图列表无效")
		}
		sheets, ok := sprites["sheets"].([]any)
		if !ok {
			return failure(500, "atlas_output_invalid", "atlas.json 的雪碧图列表无效")
		}
		for _, sheet := range sheets {
			if !sheetName.MatchString(text(sheet)) {
				return failure(500, "atlas_output_invalid", "atlas.json 的雪碧图列表无效")
			}
		}
	}
	previous := s.current(active.dataset)
	meta := Record{"schema_version": 1, "run_id": active.id, "dataset_id": active.dataset, "started_at": active.started, "finished_at": now(), "input_digest": p.digest, "options": active.options, "inputs": p.inputs, "skipped": p.skipped}
	if e = writeJSON(filepath.Join(p.dir, "run.json"), meta); e != nil {
		return e
	}
	if e = os.Remove(p.job); e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	if e = writeJSON(filepath.Join(s.root, active.dataset, "current.json"), Record{"run_id": active.id}); e != nil {
		return e
	}
	s.prune(active.dataset, map[string]bool{previous: true, active.id: true})
	return nil
}
