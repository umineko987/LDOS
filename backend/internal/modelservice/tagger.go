package modelservice

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"ldos/backend/internal/downloads"
	"ldos/backend/internal/redaction"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

type TagRequest struct {
	Models, Inputs, Categories []string
	Thresholds                 map[string]map[string]float64
	BatchSize                  int
	JobRef                     map[string]string
	OnFinished                 func(context.Context, Record) error
}

// Prepare installs native bundles with explicitly supplied overrides. Unset
// overrides inherit the shared download settings, including the proxy lease.
func (s *Service) Prepare(ctx context.Context, models []string, accept bool, overrides downloads.Overrides) (Record, error) {
	models = unique(models)
	if e := s.validateModels(models, accept, true); e != nil {
		return nil, e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping {
		return nil, failure(409, "service_stopping", "后端正在关闭")
	}
	if s.tag != nil {
		return nil, failure(409, "tagger_busy", "已有打标任务在运行")
	}
	env, e := s.resolve(ctx, "models:tagger", overrides)
	if e != nil {
		return nil, e
	}
	s.startPrepareLocked(models, accept, env)
	return Record{"phase": "preparing", "models": models}, nil
}
func (s *Service) Tag(ctx context.Context, request TagRequest) (Record, error) {
	models := unique(request.Models)
	if e := s.validateModels(models, false, false); e != nil {
		return nil, e
	}
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	for _, p := range request.Inputs {
		if strings.ContainsAny(p, "\x00\r\n") || p == "" {
			return nil, failure(422, "invalid_tagger_input", "图片路径不能包含换行或空字符")
		}
	}
	batch := request.BatchSize
	if batch == 0 {
		batch = 8
	}
	if batch < 1 {
		return nil, failure(422, "invalid_tagger_batch_size", "批大小必须为正数")
	}
	args := []string{s.deps.Settings.Tagger.CLIScript, "--model-dir", s.deps.Settings.Tagger.ModelDir, "tag", "--progress-json", "--models", strings.Join(models, ","), "--cache", s.deps.Settings.Tagger.CachePath, "--batch-size", strconv.Itoa(batch), "--inputs-file", "-", "--no-captions"}
	for model, thresholds := range request.Thresholds {
		for category, v := range thresholds {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return nil, failure(422, "invalid_tagger_threshold", "阈值必须为有限数值")
			}
			args = append(args, "--model-threshold", model, category, strconv.FormatFloat(v, 'g', -1, 64))
		}
	}
	if len(request.Categories) > 0 {
		args = append(args, "--categories", strings.Join(request.Categories, ","))
	}
	if st, e := os.Stat(s.deps.Settings.Tagger.CLIScript); e != nil || !st.Mode().IsRegular() {
		return nil, failure(503, "tagger_start_failed", "tagger CLI 不存在")
	}
	if _, e := exec.LookPath(s.deps.Settings.Tagger.PythonExecutable); e != nil {
		return nil, failure(503, "tagger_start_failed", "打标 Python 不存在")
	}
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return nil, failure(409, "service_stopping", "后端正在关闭")
	}
	if s.tag != nil {
		s.mu.Unlock()
		return nil, failure(409, "tagger_busy", "已有打标任务在运行")
	}
	runCtx, cancel := context.WithCancel(s.ctx)
	op := &operation{cancel: cancel, done: make(chan struct{}), models: models}
	total := len(request.Inputs)
	ref := map[string]string{"models": strings.Join(models, ",")}
	for k, v := range request.JobRef {
		ref[k] = v
	}
	op.job = s.startJob("tagger.tag", fmt.Sprintf("打标 %d 张", total), "tagger:"+uuid.NewString(), &total, ref)
	s.tag = op
	s.prepareModels = nil
	s.state = emptyState("tagging")
	s.wg.Add(1)
	s.mu.Unlock()
	input := strings.Join(request.Inputs, "\n")
	if len(request.Inputs) > 0 {
		input += "\n"
	}
	go func() {
		defer s.wg.Done()
		defer close(op.done)
		defer cancel()
		tail, e := RunCommand(runCtx, Command{Executable: s.deps.Settings.Tagger.PythonExecutable, Args: args, Input: strings.NewReader(input), Env: OfflineEnvironment(), Grace: grace(s.deps.Settings.Tagger.ShutdownGraceSeconds)}, func(line string) {
			var event Record
			if json.Unmarshal([]byte(line), &event) == nil {
				s.applyEvent(op, event)
			}
		})
		s.finishTag(runCtx, op, e, tail, "", request.OnFinished, true)
	}()
	return Record{"phase": "tagging", "models": models, "inputs": append([]string{}, request.Inputs...), "job_id": op.job}, nil
}
func (s *Service) applyEvent(op *operation, event Record) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tag != op {
		return
	}
	switch text(event["type"]) {
	case "progress":
		s.state.Stage = text(event["stage"])
		s.state.Done = int(number(event["done"]))
		s.state.Total = int(number(event["total"]))
		s.updateJob(op.job, s.state.Stage, s.state.Done, s.state.Total)
	case "done":
		s.state.LastResult = event
		s.state.Stage = ""
		s.state.Download = map[string]Record{}
	}
}
func (s *Service) finishTag(ctx context.Context, op *operation, e error, tail, secret string, finished func(context.Context, Record) error, inference bool) {
	phase, status, message := "idle", "succeeded", ""
	if e != nil {
		phase, status = "failed", "failed"
		message = tail
		if message == "" {
			message = e.Error()
		}
		message = redaction.Text(message, 500, secret)
	}
	if ctx.Err() != nil {
		phase, status, message = "failed", "cancelled", "已取消"
	}
	if inference {
		s.generation.Add(1)
	}
	s.mu.Lock()
	s.state.Phase, s.state.Message = phase, message
	s.tag = nil
	result := clone(s.state.LastResult)
	s.mu.Unlock()
	s.finishJob(op.job, status, message)
	if finished != nil {
		_ = finished(context.WithoutCancel(ctx), Record{"status": status, "message": message, "last_result": result})
	}
}
func (s *Service) Cancel(ctx context.Context) (Record, error) {
	s.mu.Lock()
	op := s.tag
	if op == nil {
		phase := s.state.Phase
		s.mu.Unlock()
		return Record{"phase": phase, "message": "没有运行中的任务"}, nil
	}
	op.cancel()
	s.mu.Unlock()
	select {
	case <-op.done:
		return Record{"phase": "failed"}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func text(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	}
	return ""
}
func number(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case json.Number:
		n, _ := x.Float64()
		return n
	}
	return 0
}
