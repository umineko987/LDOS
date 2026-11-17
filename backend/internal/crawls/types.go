// Package crawls owns ordered crawl planning and persistence on the shared v18 store.
package crawls

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"ldos/backend/internal/activity"
	"ldos/backend/internal/config"
	"ldos/backend/internal/discovery"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/scheduler"
	"ldos/backend/internal/store"
	"ldos/backend/internal/tasks"
)

// CredentialsRequest preserves explicit source overrides, including explicit nulls
// (already resolved against the batch options before this callback is invoked).
type CredentialsRequest struct{ Reference, CookiesFile, ConfigFile *string }
type Credentials = tasks.Credentials

type Dependencies struct {
	Store        *store.Store
	Settings     config.Settings
	Jobs         *activity.Registry
	Discovery    *discovery.Service
	Tasks        *tasks.Service
	PolicyFor    func(context.Context, string) (scheduler.Policy, error)
	Credentials  func(context.Context, string, CredentialsRequest) (Credentials, error)
	ValidateArgs func([]string) ([]string, error)
	// ValidateTarget uses the execution mode's DNS path, including validated
	// proxy-cache answers. It must never admit an unvalidated private target.
	ValidateTarget func(context.Context, string, string, scheduler.Policy) error
	Resolve        func(context.Context, string) (tasks.SiteInfo, error)
	ProbeForTarget func(context.Context, string) (proxypool.ProbeResult, error)
	NotifyTasks    func()
	// BatchComplete must be idempotent. It is called again after process recovery
	// for terminal batches and retried after errors; it never runs inside a DB transaction.
	BatchComplete func(context.Context, map[string]any) error
	// ReviewEnabled controls the legacy synthetic terminal review status only.
	ReviewEnabled bool
	// HTTPClient is optional and used for native EH index fetching. The default
	// constructs a proxy-aware client for each lease; tests may supply local transports.
	HTTPClient   func(context.Context, string, time.Duration) (*http.Client, func(), error)
	PollInterval time.Duration
}

type Error struct {
	Status        int
	Code, Message string
	Details       any
}

func (e *Error) Error() string { return e.Message }
func invalid(message string) error {
	return &Error{Status: 422, Code: "invalid_crawl", Message: message}
}
func missing() error {
	return &Error{Status: 404, Code: "crawl_not_found", Message: "爬取批次不存在"}
}

type Service struct {
	deps      Dependencies
	parent    context.Context
	life      sync.Mutex
	mu        sync.Mutex
	cancel    context.CancelFunc
	done      chan struct{}
	wake      chan struct{}
	batches   map[string]chan struct{}
	siteLocks map[string]chan struct{}
	notified  map[string]float64
	lastError string
}

func New(ctx context.Context, deps Dependencies) (*Service, error) {
	if ctx == nil || deps.Store == nil || deps.Discovery == nil || deps.Tasks == nil || deps.PolicyFor == nil || deps.Credentials == nil || deps.ValidateArgs == nil || deps.ValidateTarget == nil || deps.Resolve == nil || deps.ProbeForTarget == nil || deps.NotifyTasks == nil {
		return nil, errors.New("crawls requires shared store, discovery, tasks, policy, credentials, validation, resolver, proxy probe and scheduler notification")
	}
	if deps.Discovery.Transport == nil || deps.Settings.RuntimeDir == "" || deps.Settings.DefaultOutputRoot == "" || len(deps.Settings.AllowedOutputRoots) == 0 {
		return nil, errors.New("crawl transport or output configuration is incomplete")
	}
	if deps.PollInterval <= 0 {
		deps.PollInterval = 250 * time.Millisecond
	}
	if deps.Settings.Scheduler.MaxConcurrentBatches <= 0 {
		deps.Settings.Scheduler.MaxConcurrentBatches = 4
	}
	if deps.Settings.Scheduler.MaxConcurrentTasks <= 0 {
		deps.Settings.Scheduler.MaxConcurrentTasks = 20
	}
	return &Service{deps: deps, parent: ctx, wake: make(chan struct{}, 1), batches: map[string]chan struct{}{}, siteLocks: map[string]chan struct{}{}, notified: map[string]float64{}}, nil
}

func terminal(status string) bool {
	return status == "succeeded" || status == "completed_with_errors" || status == "cancelled"
}
func taskTerminal(status string) bool {
	return status == "succeeded" || status == "failed" || status == "cancelled"
}
func now() float64      { return float64(time.Now().UnixNano()) / 1e9 }
func ptr[T any](v T) *T { return &v }
