package modelservice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"ldos/backend/internal/config"
	"ldos/backend/internal/downloads"
	"ldos/backend/internal/redaction"
)

type dedupEntry struct {
	key, title, selection, license, source string
	used                                   []string
}

var dedupEntries = []dedupEntry{
	{"sscd", "SSCD 拷贝检测", "dedup", "MIT", "https://github.com/facebookresearch/sscd-copy-detection", []string{"dedup"}},
	{"dino", "DINOv2 ViT-S/14", "dedup", "Apache-2.0", "https://github.com/facebookresearch/dinov2", []string{"dedup", "atlas"}},
	{"completeness", "画面完整度（anime_completeness）", "completeness", "", "https://huggingface.co/deepghs/anime_completeness", []string{"clean"}},
	{"ccip", "角色一致性（CCIP）", "ccip", "", "https://huggingface.co/deepghs/ccip_onnx", []string{"clean"}},
}

func (s *Service) modelProgress(key string) (int64, int64) {
	var done, total int64
	for _, f := range s.dedupFiles[key] {
		p := filepath.Join(s.deps.Settings.Dedup.ModelDir, f.Path)
		total += f.Size
		if safePath(p) == nil && safePath(p+".part") == nil {
			done += min(f.Size, max(fileSize(p), fileSize(p+".part")))
		}
	}
	return done, total
}
func (s *Service) setupProgress(selected []string) (int64, int64) {
	var done, total int64
	for _, entry := range dedupEntries {
		if contains(selected, entry.selection) {
			d, t := s.modelProgress(entry.key)
			done += d
			total += t
		}
	}
	return done, total
}
func (s *Service) basicInstalled(key string) bool {
	for _, f := range s.dedupFiles[key] {
		p := filepath.Join(s.deps.Settings.Dedup.ModelDir, f.Path)
		if safePath(p) != nil || fileSize(p) == 0 {
			return false
		}
	}
	if key == "dino" {
		p := filepath.Join(s.deps.Settings.Dedup.ModelDir, "torch", "hub", dinoRepository, "hubconf.py")
		return safePath(p) == nil && fileSize(p) > 0
	}
	return true
}
func (s *Service) filterScript() string {
	if s.deps.Options.FilterModelsScript != "" {
		return s.deps.Options.FilterModelsScript
	}
	return filepath.Join(filepath.Dir(s.deps.Settings.Dedup.CoreScript), "review_filter_models.py")
}
func (s *Service) CheckFilters(ctx context.Context, names []string) (map[string]Capability, error) {
	s.probeMu.Lock()
	defer s.probeMu.Unlock()
	out := map[string]Capability{}
	for _, name := range names {
		if name != "completeness" && name != "ccip" {
			return nil, fmt.Errorf("unknown filter model: %s", name)
		}
		signature := s.Settings().Dedup.PythonExecutable
		present := true
		for _, f := range s.dedupFiles[name] {
			p := filepath.Join(s.deps.Settings.Dedup.ModelDir, f.Path)
			st, e := os.Stat(p)
			if e != nil || safePath(p) != nil || !st.Mode().IsRegular() || st.Size() != f.Size {
				present = false
				break
			}
			signature += fmt.Sprintf("/%d/%d", st.Size(), st.ModTime().UnixNano())
		}
		if !present {
			out[name] = Capability{Reason: "缺少 " + name + " 模型，请先准备模型"}
			continue
		}
		if cached, ok := s.probes[name]; ok && cached.signature == signature {
			out[name] = cached.capability
			continue
		}
		checkCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		var result map[string]Capability
		_, e := RunCommand(checkCtx, Command{Executable: s.Settings().Dedup.PythonExecutable, Args: []string{s.filterScript(), "--model-dir", s.deps.Settings.Dedup.ModelDir, "--models", name}, Env: OfflineEnvironment(), Grace: grace(s.deps.Settings.Dedup.ShutdownGraceSeconds)}, func(line string) {
			var v map[string]Capability
			if json.Unmarshal([]byte(line), &v) == nil && v[name] != (Capability{}) {
				result = v
			}
		})
		cancel()
		cap, ok := result[name]
		if !ok || e != nil && cap.Available {
			cap = Capability{Reason: "过滤模型加载或 CPU 推理校验失败，请更新去重环境并重新准备模型"}
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		s.probes[name] = probeResult{signature, cap}
		out[name] = cap
	}
	return out, nil
}
func (s *Service) SetupStatus(ctx context.Context) (Record, error) {
	s.mu.Lock()
	phase, message, enabled, proxy := s.setupPhase, s.setupMessage, s.enabled, s.usingProxy
	selected := append([]string{}, s.selected...)
	s.mu.Unlock()
	caps, e := s.CheckFilters(ctx, []string{"completeness", "ccip"})
	if e != nil {
		return nil, e
	}
	sscd, dino := s.basicInstalled("sscd"), s.basicInstalled("dino")
	if phase == "idle" && sscd && dino && enabled {
		phase = "ready"
	}
	done, total := s.setupProgress(selected)
	models := Record{"sscd": Record{"installed": sscd}, "dino": Record{"installed": dino}}
	for _, key := range []string{"completeness", "ccip"} {
		d, t := s.modelProgress(key)
		models[key] = Record{"installed": caps[key].Available, "downloaded_bytes": d, "expected_bytes": t}
	}
	return Record{"phase": phase, "enabled": enabled, "installed": sscd && dino, "using_proxy": phase == "installing" && proxy, "downloaded_bytes": done, "expected_bytes": total, "message": message, "requested_models": selected, "review_filters": map[string]Capability{"filter_monochrome": caps["completeness"], "filter_sketch": caps["completeness"], "filter_character": caps["ccip"]}, "models": models}, nil
}
func (s *Service) ListModels(ctx context.Context) (Record, error) {
	status, e := s.SetupStatus(ctx)
	if e != nil {
		return nil, e
	}
	details := status["models"].(Record)
	selected := status["requested_models"].([]string)
	phase := status["phase"].(string)
	items := []Record{}
	for _, entry := range dedupEntries {
		detail := details[entry.key].(Record)
		ok := detail["installed"].(bool)
		state := "missing"
		involved := contains(selected, entry.selection)
		if phase == "installing" && involved {
			state = "installing"
		} else if ok {
			state = "installed"
		} else if phase == "failed" && involved {
			state = "failed"
		}
		_, size := s.modelProgress(entry.key)
		var progress, job, license any
		var installedBytes int64
		message := ""
		if ok {
			installedBytes = size
		}
		if entry.license != "" {
			license = entry.license
		}
		if state == "installing" {
			job = "models:dedup"
			progress = Record{"current": status["downloaded_bytes"], "total": status["expected_bytes"]}
			if entry.selection != "dedup" {
				progress = Record{"current": detail["downloaded_bytes"], "total": detail["expected_bytes"]}
			}
		}
		if state == "installing" || state == "failed" {
			message = redaction.Text(status["message"].(string), 300)
		}
		with := []string{}
		for _, other := range dedupEntries {
			if other.key != entry.key && other.selection == entry.selection {
				with = append(with, other.key)
			}
		}
		items = append(items, Record{"key": entry.key, "family": "dedup", "display_name": entry.title, "status": state, "size_bytes": size, "installed_bytes": installedBytes, "license": license, "gated": false, "source_url": entry.source, "used_by": entry.used, "installs_with": with, "message": message, "progress": progress, "job_id": job})
	}
	s.mu.Lock()
	state := s.state
	preparing := append([]string{}, s.prepareModels...)
	jobID := ""
	if s.tag != nil {
		jobID = s.tag.job
	}
	download := map[string]Record{}
	for k, v := range state.Download {
		download[k] = clone(v)
	}
	s.mu.Unlock()
	for _, spec := range s.specs {
		ok := installed(s.deps.Settings.Tagger.ModelDir, spec)
		v := "missing"
		if !s.deps.Settings.Tagger.Enabled {
			v = "disabled"
		} else if state.Phase == "preparing" && contains(preparing, spec.Key) {
			v = "installing"
		} else if ok {
			v = "installed"
		} else if state.Phase == "failed" && contains(preparing, spec.Key) {
			v = "failed"
		} else if spec.Gated {
			v = "needs_license"
		}
		var progress, job any
		message := ""
		if v == "installing" {
			if d := download[spec.Key]; d != nil {
				progress = Record{"current": d["done"], "total": d["total"]}
			}
			if jobID != "" {
				job = jobID
			}
		}
		if v == "failed" || v == "installing" {
			message = redaction.Text(state.Message, 300)
		}
		var size int64
		if ok {
			size = s.InstalledBytes(spec.Key)
		}
		items = append(items, Record{"key": spec.Key, "family": "tagger", "display_name": spec.DisplayName, "status": v, "size_bytes": nil, "installed_bytes": size, "license": spec.License, "gated": spec.Gated, "source_url": "https://huggingface.co/" + spec.Repo, "used_by": []string{"tag"}, "installs_with": []string{}, "message": message, "progress": progress, "job_id": job})
	}
	return Record{"items": items}, nil
}
func (s *Service) validateModels(models []string, accept, prepare bool) error {
	if len(models) == 0 {
		return failure(422, "invalid_model_selection", "请至少选择一个模型")
	}
	if !s.deps.Settings.Tagger.Enabled {
		return failure(409, "tagger_disabled", "打标功能未启用")
	}
	for _, key := range models {
		spec, ok := s.spec(key)
		if !ok {
			return failure(422, "unknown_model", "未登记的模型: "+key)
		}
		if prepare && spec.Gated && !accept {
			return failure(422, "model_license_required", "模型受自定义许可约束，需要先同意许可："+key)
		}
		if !prepare && !installed(s.deps.Settings.Tagger.ModelDir, spec) {
			return failure(409, "tagger_model_missing", "模型尚未准备: "+key)
		}
	}
	return nil
}
func (s *Service) resolve(ctx context.Context, kind string, overrides downloads.Overrides) (downloads.Environment, error) {
	env, e := s.deps.Downloads.Resolve(ctx, kind+":"+uuid.NewString(), overrides)
	if e != nil {
		return env, failure(409, "download_proxy_unavailable", "模型下载代理不可用")
	}
	return env, nil
}
func (s *Service) Install(ctx context.Context, keys []string, accept bool) (Record, error) {
	wanted := unique(keys)
	if len(wanted) == 0 {
		return nil, failure(422, "invalid_model_selection", "请至少选择一个模型")
	}
	tagger, selection, covered := []string{}, []string{}, []string{}
	for _, key := range wanted {
		found := false
		for _, entry := range dedupEntries {
			if entry.key == key {
				selection = append(selection, entry.selection)
				found = true
				break
			}
		}
		if !found {
			tagger = append(tagger, key)
		}
	}
	selection = unique(selection)
	for _, entry := range dedupEntries {
		if contains(selection, entry.selection) {
			covered = append(covered, entry.key)
		}
	}
	if len(tagger) > 0 {
		if e := s.validateModels(tagger, accept, true); e != nil {
			return nil, e
		}
	}
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return nil, failure(409, "service_stopping", "后端正在关闭")
	}
	if len(selection) > 0 && s.setup != nil {
		s.mu.Unlock()
		return nil, failure(409, "models_busy", "已有去重模型在安装")
	}
	if len(tagger) > 0 && s.tag != nil {
		s.mu.Unlock()
		return nil, failure(409, "tagger_busy", "已有打标任务在运行")
	}
	started := []Record{}
	if len(tagger) > 0 {
		env, e := s.resolve(ctx, "models:tagger", downloads.Overrides{})
		if e != nil {
			s.mu.Unlock()
			return nil, e
		}
		op := s.startPrepareLocked(tagger, accept, env)
		started = append(started, Record{"family": "tagger", "keys": tagger, "job_id": op.job, "proxy_source": env.ProxySource})
	}
	if len(selection) > 0 {
		env, e := s.resolve(ctx, "models:dedup", downloads.Overrides{})
		if e != nil {
			s.mu.Unlock()
			return nil, e
		}
		s.startSetupLocked(selection, env)
		started = append(started, Record{"family": "dedup", "keys": covered, "job_id": "models:dedup", "proxy_source": env.ProxySource})
	}
	s.mu.Unlock()
	listing, e := s.ListModels(ctx)
	if e != nil {
		return nil, e
	}
	listing["started"] = started
	return listing, nil
}

// InstallSetup preserves the legacy endpoint: blank proxy is direct, independent
// of the stored proxy mode; only the stored HF mirror is inherited.
func (s *Service) InstallSetup(ctx context.Context, proxy string, models []string) (Record, error) {
	normalized, e := normalizeProxy(proxy)
	if e != nil {
		return nil, e
	}
	if models == nil {
		models = []string{"dedup"}
	}
	models = unique(models)
	if len(models) == 0 {
		return nil, failure(422, "invalid_model_proxy", "模型选择无效")
	}
	for _, v := range models {
		if v != "dedup" && v != "completeness" && v != "ccip" {
			return nil, failure(422, "invalid_model_proxy", "模型选择无效")
		}
	}
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return nil, failure(409, "service_stopping", "后端正在关闭")
	}
	if s.setup != nil {
		s.mu.Unlock()
		return s.SetupStatus(ctx)
	}
	var p *string
	if normalized != "" {
		p = &normalized
	}
	env, e := s.resolve(ctx, "models:dedup", downloads.Overrides{Proxy: downloads.OptionalString{Set: true, Value: p}, Token: downloads.OptionalString{Set: true}})
	if e != nil {
		s.mu.Unlock()
		return nil, e
	}
	s.startSetupLocked(models, env)
	s.mu.Unlock()
	return s.SetupStatus(ctx)
}
func (s *Service) startPrepareLocked(models []string, accept bool, env downloads.Environment) *operation {
	ctx, cancel := context.WithCancel(s.ctx)
	op := &operation{cancel: cancel, done: make(chan struct{}), models: append([]string{}, models...)}
	op.job = s.startJob("tagger.prepare", "下载打标模型", "tagger:"+uuid.NewString(), nil, map[string]string{"models": strings.Join(models, ",")})
	s.tag = op
	s.prepareModels = op.models
	s.state = emptyState("preparing")
	s.state.Message = "准备下载"
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer close(op.done)
		defer cancel()
		defer s.deps.Downloads.Release(context.WithoutCancel(ctx), env)
		client, e := s.client(env)
		if e == nil {
			defer client.CloseIdleConnections()
			for _, key := range op.models {
				spec, _ := s.spec(key)
				if e = s.installBundle(ctx, client, env, spec, accept, op); e != nil {
					break
				}
			}
		}
		s.finishTag(ctx, op, e, "", token(env), nil, false)
	}()
	return op
}
func (s *Service) startSetupLocked(models []string, env downloads.Environment) {
	ctx, cancel := context.WithCancel(s.ctx)
	op := &operation{cancel: cancel, done: make(chan struct{}), job: "models:dedup", models: append([]string{}, models...)}
	s.setup = op
	s.selected = op.models
	s.setupPhase = "installing"
	s.setupMessage = "正在准备模型"
	s.usingProxy = env.Proxy != nil
	s.startJob("models.install", "准备去重模型", op.job, nil, nil)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer close(op.done)
		defer cancel()
		defer s.deps.Downloads.Release(context.WithoutCancel(ctx), env)
		e := s.runSetup(ctx, op, env)
		status, message, phase := "succeeded", "模型已安装并启用", "ready"
		if !contains(models, "dedup") {
			message = "过滤模型已准备并通过 CPU 推理校验"
		}
		if e != nil {
			status, phase, message = "failed", "failed", "模型下载或校验失败，请检查去重 ONNX 依赖、网络或本次代理后重试"
			if ctx.Err() != nil {
				status, message = "cancelled", "已取消"
			}
			var api *Error
			if errors.As(e, &api) {
				message = api.Message
			}
		}
		s.mu.Lock()
		s.setupPhase, s.setupMessage, s.usingProxy = phase, message, false
		s.finishJob(op.job, status, message)
		s.setup = nil
		s.mu.Unlock()
	}()
}
func (s *Service) runSetup(ctx context.Context, op *operation, env downloads.Environment) error {
	client, e := s.client(env)
	if e != nil {
		return e
	}
	defer client.CloseIdleConnections()
	for _, entry := range dedupEntries {
		if !contains(op.models, entry.selection) {
			continue
		}
		for _, f := range s.dedupFiles[entry.key] {
			p := filepath.Join(s.deps.Settings.Dedup.ModelDir, f.Path)
			if verifyFile(p, f) == nil {
				continue
			}
			auth := ""
			if strings.HasPrefix(f.URL, "https://huggingface.co/") {
				auth = token(env)
			}
			e = fetch(ctx, client, mirrorURL(f.URL, env), p, auth, f, func(_, _ int64) {
				d, t := s.setupProgress(op.models)
				s.mu.Lock()
				s.setupMessage = "正在下载并检查模型"
				s.mu.Unlock()
				s.updateJob(op.job, "正在下载并检查模型", int(d), int(t))
			})
			if e != nil {
				return e
			}
		}
	}
	updates := map[string]any{}
	python := s.Settings().Dedup.PythonExecutable
	if _, e = exec.LookPath(python); e != nil {
		fallback := filepath.Join(filepath.Dir(s.deps.Settings.Dedup.CoreScript), ".venv", "bin", "python")
		if _, e = exec.LookPath(fallback); e != nil {
			return e
		}
		python = fallback
		s.mu.Lock()
		s.dedupPython = fallback
		s.mu.Unlock()
	}
	if python != s.deps.Settings.Dedup.PythonExecutable {
		updates["python_executable"] = python
	}
	if contains(op.models, "dedup") {
		if e = s.installDINORepository(ctx, client); e != nil {
			return e
		}
		args := []string{s.deps.Settings.Dedup.CoreScript, "--prepare-models", "--model-dir", s.deps.Settings.Dedup.ModelDir, "--device", s.deps.Settings.Dedup.Device}
		s.mu.Lock()
		s.setupMessage = "正在加载模型"
		s.mu.Unlock()
		_, e = RunCommand(ctx, Command{Executable: python, Args: args, Env: OfflineEnvironment(), Grace: grace(s.deps.Settings.Dedup.ShutdownGraceSeconds)}, nil)
		if e != nil {
			return e
		}
		updates["enabled"] = true
	}
	filters := []string{}
	for _, v := range op.models {
		if v != "dedup" {
			filters = append(filters, v)
		}
	}
	if len(filters) > 0 {
		s.probeMu.Lock()
		for _, v := range filters {
			delete(s.probes, v)
		}
		s.probeMu.Unlock()
		caps, e := s.CheckFilters(ctx, filters)
		if e != nil {
			return e
		}
		for _, v := range filters {
			if !caps[v].Available {
				return errors.New(caps[v].Reason)
			}
		}
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	if len(updates) > 0 {
		if s.deps.SaveDedup != nil {
			e = s.deps.SaveDedup(ctx, updates)
		} else {
			e = config.UpdateSection(ctx, s.deps.Settings.Path, "dedup", updates)
		}
		if e != nil {
			return failure(500, "model_settings_save_failed", "模型已下载，但启用设置保存失败，请重试")
		}
	}
	if contains(op.models, "dedup") {
		s.mu.Lock()
		s.enabled = true
		s.mu.Unlock()
		if s.deps.OnDedupEnabled != nil {
			if e = s.deps.OnDedupEnabled(ctx); e != nil {
				return e
			}
		}
	}
	return nil
}
