// Package modelservice owns model installation, availability and tagger orchestration.
package modelservice

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/config"
	"ldos/backend/internal/downloads"
	"ldos/backend/internal/store"
)

type Record = map[string]any
type Error struct {
	Status        int
	Code, Message string
}

func (e *Error) Error() string                        { return e.Message }
func failure(status int, code, message string) *Error { return &Error{status, code, message} }

type Capability struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
}
type Options struct {
	// FilterModelsScript defaults to review_filter_models.py beside dedup.core_script.
	FilterModelsScript string
	// Client constructs a dedicated HTTP client using the resolved download proxy.
	// nil uses the native transport; no ambient proxy settings are inherited.
	Client func(downloads.Environment) (*http.Client, error)
}
type Dependencies struct {
	Store     *store.Store
	Settings  config.Settings
	Jobs      *activity.Registry
	Downloads *downloads.Store
	Options   Options
	// Called after dedup enablement is durably saved. Main enables review/Atlas here.
	OnDedupEnabled func(context.Context) error
	// Optional integration hook; nil uses config.UpdateSection(Settings.Path).
	SaveDedup func(context.Context, map[string]any) error
}
type TagState struct {
	Phase      string            `json:"phase"`
	Stage      string            `json:"stage"`
	Done       int               `json:"done"`
	Total      int               `json:"total"`
	Message    string            `json:"message"`
	Download   map[string]Record `json:"download"`
	LastResult Record            `json:"last_result"`
}
type operation struct {
	cancel context.CancelFunc
	done   chan struct{}
	job    string
	models []string
}
type Service struct {
	deps                     Dependencies
	ctx                      context.Context
	cancel                   context.CancelFunc
	mu                       sync.Mutex
	stopping                 bool
	setupPhase, setupMessage string
	selected                 []string
	usingProxy, enabled      bool
	dedupPython              string
	setup, tag               *operation
	state                    TagState
	prepareModels            []string
	generation               atomic.Uint64
	wg                       sync.WaitGroup
	// Filter inference checks are cached by the actual file stat tuple.
	probeMu    sync.Mutex
	probes     map[string]probeResult
	dedupFiles map[string][]modelFile
	specs      []Spec
}
type probeResult struct {
	signature  string
	capability Capability
}

func New(ctx context.Context, deps Dependencies) (*Service, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithCancel(ctx)
	if deps.Downloads == nil {
		deps.Downloads = downloads.New(deps.Settings.RuntimeDir)
	}
	s := &Service{deps: deps, ctx: ctx, cancel: cancel, enabled: deps.Settings.Dedup.Enabled, setupPhase: "idle", selected: []string{"dedup"}, probes: map[string]probeResult{}, specs: Catalog(), dedupFiles: defaultModelFiles()}
	s.state = emptyState("idle")
	return s, nil
}
func emptyState(phase string) TagState {
	return TagState{Phase: phase, Download: map[string]Record{}, LastResult: Record{}}
}
func (s *Service) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping {
		return errors.New("modelservice is stopped")
	}
	return nil
}
func (s *Service) Stop() error {
	s.mu.Lock()
	s.stopping = true
	s.cancel()
	if s.setup != nil {
		s.setup.cancel()
	}
	if s.tag != nil {
		s.tag.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}
func (s *Service) CacheGeneration() uint64 { return s.generation.Load() }
func (s *Service) CurrentJobID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tag != nil {
		return s.tag.job
	}
	return ""
}

// Settings returns the runtime model configuration for diagnostics/integration.
func (s *Service) Settings() config.Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.deps.Settings
	v.Dedup.Enabled = s.enabled
	if s.dedupPython != "" {
		v.Dedup.PythonExecutable = s.dedupPython
	}
	return v
}
func (s *Service) Busy() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.tag != nil }
func (s *Service) State() TagState {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.state
	v.Download = map[string]Record{}
	for k, r := range s.state.Download {
		v.Download[k] = clone(r)
	}
	v.LastResult = clone(v.LastResult)
	return v
}
func clone(r Record) Record {
	v := Record{}
	for k, x := range r {
		v[k] = x
	}
	return v
}
func unique(values []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}
func contains(v []string, k string) bool {
	for _, x := range v {
		if x == k {
			return true
		}
	}
	return false
}
func (s *Service) startJob(kind, title, id string, total *int, ref map[string]string) string {
	if s.deps.Jobs == nil {
		return id
	}
	j, _ := s.deps.Jobs.Start(kind, title, activity.StartOptions{ID: id, Total: total, Ref: ref})
	return j.ID
}
func (s *Service) updateJob(id, message string, done, total int) {
	if s.deps.Jobs != nil && id != "" {
		var t *int
		if total > 0 {
			t = &total
		}
		_, _ = s.deps.Jobs.Update(id, activity.UpdateOptions{Current: &done, Total: t, Message: &message})
	}
}
func (s *Service) finishJob(id, status, message string) {
	if s.deps.Jobs != nil && id != "" {
		_, _ = s.deps.Jobs.Finish(id, activity.FinishOptions{Status: activity.JobStatus(status), Message: &message})
	}
}
func grace(seconds float64) time.Duration {
	if seconds <= 0 {
		return time.Second
	}
	return time.Duration(seconds * float64(time.Second))
}
