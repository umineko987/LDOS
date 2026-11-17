// Package diagnostics reports native service and executor readiness without
// exposing submitted credentials or executing the legacy Python business layer.
package diagnostics

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"ldos/backend/internal/config"
	"ldos/backend/internal/proxysources"
	"ldos/backend/internal/proxytransport"
)

type Component map[string]any
type Snapshot map[string]Component

func component(status, summary string, required bool) Component {
	return Component{"status": status, "summary": summary, "required": required}
}
func check(ok bool, summary string) Component {
	status := "error"
	if ok {
		status = "ok"
	}
	return component(status, summary, true)
}
func ready(items Snapshot) bool {
	for _, item := range items {
		if item["required"] != false && item["status"] != "ok" && item["status"] != "disabled" {
			return false
		}
	}
	return true
}
func now() float64             { return float64(time.Now().UnixMilli()) / 1000 }
func present(path string) bool { st, err := os.Stat(path); return err == nil && st.Mode().IsRegular() }
func nonempty(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular() && st.Size() > 0
}
func object(v any) map[string]any {
	result, _ := v.(map[string]any)
	if result == nil {
		return map[string]any{}
	}
	return result
}
func count(value any, max int64) int64 {
	var n float64
	switch v := value.(type) {
	case int:
		n = float64(v)
	case int64:
		n = float64(v)
	case float64:
		n = v
	case json.Number:
		n, _ = v.Float64()
	}
	if math.IsNaN(n) || n < 0 {
		return 0
	}
	if n > float64(max) {
		return max
	}
	return int64(n)
}
func timestamp(v any) any {
	var f float64
	switch n := v.(type) {
	case float64:
		f = n
	case int64:
		f = float64(n)
	default:
		return nil
	}
	if math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > 253402300799 {
		return nil
	}
	return f
}

func Loop(value map[string]any) map[string]any {
	state, _ := value["state"].(string)
	switch state {
	case "not_started", "running", "degraded", "stopping", "stopped", "unexpected_exit":
	default:
		state = "unknown"
	}
	var category any
	if raw, ok := value["last_error_category"].(string); ok && raw != "" {
		switch raw {
		case "database_error", "timeout_error", "connection_error", "permission_error", "io_error", "value_error", "runtime_error", "unexpected_error":
			category = raw
		default:
			category = "unexpected_error"
		}
	}
	return map[string]any{"state": state, "running": value["running"] == true && (state == "running" || state == "degraded"), "operational": value["operational"] == true && state != "unexpected_exit", "consecutive_failures": count(value["consecutive_failures"], 1000000), "last_error_category": category, "last_error_at": timestamp(value["last_error_at"]), "last_success_at": timestamp(value["last_success_at"]), "last_recovery_at": timestamp(value["last_recovery_at"])}
}

func ProjectProxy(settings config.Settings, live, health map[string]any) Component {
	p := settings.Proxy
	result := component("ok", "项目抓取代理池已配置", true)
	sources := 0
	if value, ok := live["source_count"]; ok {
		sources = int(count(value, 1000000))
	} else if p.Enabled {
		store, err := proxysources.New(p.SourceSettings(), settings.RuntimeDir, settings.ProjectDir)
		if err != nil {
			result["status"], result["summary"], result["source_count"] = "error", "项目抓取代理源不可用", 0
			return result
		}
		snapshot := store.Snapshot()
		sources = len(snapshot.SubscriptionURLs) + len(snapshot.InlineNodes)
		if snapshot.NodeFile != "" {
			sources++
		}
	}
	result["source_count"] = sources
	if health != nil {
		result["health_loop"] = Loop(health)
	}
	switch {
	case !p.Enabled:
		result["status"], result["summary"], result["required"], result["source_count"] = "disabled", "项目抓取代理池未启用", false, 0
	case sources == 0:
		result["status"], result["summary"] = "error", "项目抓取代理池已启用，但没有配置节点源"
	case health != nil && (Loop(health)["state"] == "unexpected_exit" || ((Loop(health)["state"] == "running" || Loop(health)["state"] == "degraded") && Loop(health)["operational"] != true)):
		result["status"], result["summary"] = "error", "代理健康监控循环意外结束"
	case live != nil && p.AutoStart && live["running"] != true:
		result["status"], result["summary"] = "error", "项目抓取代理池自动启动后未运行"
	default:
		result["running"], result["healthy"] = live["running"] == true, count(live["healthy"], 1000000000)
	}
	return result
}

func Core(settings config.Settings) Component {
	required := settings.Proxy.Enabled && settings.Proxy.TransportCoreEnabled
	_, err := proxytransport.ResolveCoreBinary(proxytransport.CoreSettings{BinaryPath: settings.Proxy.TransportCoreBinary, ExpectedSHA256: settings.Proxy.TransportCoreSHA256, ProjectBinDir: filepath.Join(settings.ProjectDir, "bin")})
	if err != nil {
		status := "optional_missing"
		if required {
			status = "error"
		}
		return component(status, "Mihomo 不可用", required)
	}
	result := component("ok", "Mihomo 可执行文件可用", required)
	result["version"] = nil
	return result
}

type fileState struct {
	Modified int64
	Size     int64
	Mode     os.FileMode
}
type cacheKey struct {
	Settings config.Dedup
	Files    [6]fileState
}

func key(settings config.Dedup) cacheKey {
	k := cacheKey{Settings: settings}
	for i, p := range []string{settings.PythonExecutable, settings.WorkerScript, settings.CoreScript, filepath.Join(settings.ModelDir, sscdFile), filepath.Join(settings.ModelDir, dinoCheckpoint), filepath.Join(settings.ModelDir, dinoRepository, "hubconf.py")} {
		if st, err := os.Stat(p); err == nil {
			k.Files[i] = fileState{st.ModTime().UnixNano(), st.Size(), st.Mode()}
		}
	}
	return k
}

type Service struct {
	settings  func() config.Settings
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.Mutex
	cached    Snapshot
	cachedKey cacheKey
	at        time.Time
	flight    chan struct{}
	probe     func(context.Context, config.Settings) Snapshot
}

func New(ctx context.Context, settings func() config.Settings) *Service {
	ctx, cancel := context.WithCancel(ctx)
	return &Service{settings: settings, ctx: ctx, cancel: cancel, probe: probeModels}
}
func (s *Service) Stop() {
	s.cancel()
	s.mu.Lock()
	done := s.flight
	s.mu.Unlock()
	if done != nil {
		<-done
	}
}
func clone(snapshot Snapshot) Snapshot {
	out := Snapshot{}
	for name, item := range snapshot {
		copy := Component{}
		for k, v := range item {
			copy[k] = v
		}
		out[name] = copy
	}
	return out
}
func disabledModels() Snapshot {
	result := Snapshot{}
	for _, name := range []string{"dedup", "dedup_python", "torch", "sscd_model", "dino_model"} {
		result[name] = component("disabled", "去重功能未启用", false)
	}
	return result
}
func (s *Service) Models(ctx context.Context, fresh bool) Snapshot {
	settings := s.settings()
	if !settings.Dedup.Enabled {
		return disabledModels()
	}
	for {
		k := key(settings.Dedup)
		s.mu.Lock()
		cached := s.cached != nil && s.cachedKey == k
		age := time.Since(s.at)
		if !fresh && cached && age < 120*time.Second {
			out := clone(s.cached)
			s.mu.Unlock()
			return out
		}
		if !fresh && cached {
			out := clone(s.cached)
			for _, item := range out {
				item["stale"] = true
				item["age_seconds"] = math.Round(age.Seconds()*10) / 10
			}
			if s.flight == nil {
				s.flight = make(chan struct{})
				go s.refresh(settings, k)
			}
			s.mu.Unlock()
			return out
		}
		if s.flight != nil {
			done := s.flight
			s.mu.Unlock()
			select {
			case <-done:
				continue
			case <-ctx.Done():
				return Snapshot{"dedup": component("error", "模型诊断已取消", true)}
			}
		}
		s.flight = make(chan struct{})
		s.mu.Unlock()
		s.refresh(settings, k)
		s.mu.Lock()
		out := clone(s.cached)
		s.mu.Unlock()
		return out
	}
}
func (s *Service) refresh(settings config.Settings, k cacheKey) {
	result := s.probe(s.ctx, settings)
	s.mu.Lock()
	s.cached, s.cachedKey, s.at = result, k, time.Now()
	close(s.flight)
	s.flight = nil
	s.mu.Unlock()
}
func (s *Service) Readiness(ctx context.Context, databaseOK bool, proxy, health, scheduler, crawls map[string]any) map[string]any {
	settings := s.settings()
	loop := Loop(object(scheduler["dispatch_loop"]))
	operational := loop["state"] != "unexpected_exit" && !((loop["state"] == "running" || loop["state"] == "degraded") && loop["operational"] != true)
	items := Snapshot{"process": component("ok", "Go 后端进程正在响应", true), "database": check(databaseOK, "SQLite 可访问"), "gallery_source": check(present(filepath.Join(settings.Gallery.RepoPath, "gallery_dl", "__init__.py")), "gallery-dl 执行器源码"), "project_proxy": ProjectProxy(settings, proxy, health), "mihomo": Core(settings), "scheduler": check(operational && scheduler != nil, "任务调度器"), "ordered_crawls": check(crawls != nil && crawls["running"] == true, "顺序批次管理器")}
	items["gallery_python"] = check(executable(settings.Gallery.PythonExecutable), "gallery-dl Python 执行器")
	items["scheduler"]["details"] = scheduler
	items["ordered_crawls"]["details"] = crawls
	for k, v := range s.Models(ctx, false) {
		items[k] = v
	}
	return map[string]any{"ready": ready(items), "components": items, "time": now()}
}
