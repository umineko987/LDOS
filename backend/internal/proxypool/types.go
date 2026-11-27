// Package proxypool owns native proxy selection, health and lifecycle coordination.
package proxypool

import (
	"context"
	"errors"
	"sync"
	"time"

	"ldos/backend/internal/proxyparse"
	"ldos/backend/internal/proxysources"
	"ldos/backend/internal/proxytransport"
)

var (
	ErrConflict    = errors.New("仍有任务正在申请或持有代理租约")
	ErrUnavailable = errors.New("代理传输核心不可用")
)

type Settings struct {
	Enabled, AutoStart, AllowSocks, TransportCoreEnabled                                             bool
	Engine, ProbeURL, RuntimeDir, ProjectBinDir, CoreBinary, CoreSHA256                              string
	ProbeTimeout, ProbeCacheTTL, HealthInterval, FailCooldown, SubscriptionTimeout, CoreStartTimeout time.Duration
	ProbeWorkers, CoreBasePort                                                                       int
}

type SourceProvider interface{ Snapshot() proxysources.Snapshot }
type Core interface {
	Start(context.Context, []proxyparse.Node) ([]proxytransport.Endpoint, error)
	Stop() error
	Status() map[string]any
}
type Forwarder interface {
	Start() (string, error)
	Stop() error
}

type Request struct {
	Owner                            string
	NodeTags, ExcludeIDs, AllowedIDs []string // nil AllowedIDs means unrestricted; empty means no nodes.
	ProbeBeforeUse                   bool
	ProbeURL                         string
	WaitIfBusy                       bool
}
type Lease struct {
	Owner, NodeID, Name, Protocol, Endpoint string
	Tags                                    []string
	AcquiredAt                              float64
}

func (l Lease) String() string   { return "ProxyLease(" + l.Owner + ", " + l.NodeID + ")" }
func (l Lease) GoString() string { return l.String() }

type record struct {
	id, name, protocol, endpoint string
	tags                         []string
	healthy                      bool
	successes, failures          int
	latency                      *float64
	cooldown                     time.Time
	lastError                    string
	owner                        string
}
type heldLease struct {
	lease     Lease
	node      *record
	forwarder Forwarder
}
type pendingAcquire struct {
	done   chan struct{}
	cancel context.CancelFunc
}
type cachedProbe struct {
	at     time.Time
	result ProbeResult
}

type ProbeNode struct {
	ID       string   `json:"id"`
	Healthy  bool     `json:"healthy"`
	Latency  *float64 `json:"latency_ms"`
	Error    string   `json:"error"`
	Endpoint string   `json:"endpoint"`
	Target   string   `json:"target"`
}
type ProbeResult struct {
	Total   int         `json:"total"`
	Healthy int         `json:"healthy"`
	Results []ProbeNode `json:"results"`
	Target  string      `json:"target"`
	Cached  bool        `json:"cached"`
	Age     *float64    `json:"age_seconds,omitempty"`
}

type dependencies struct {
	load      func(context.Context, proxysources.Snapshot, time.Duration) ([]proxyparse.Node, []string, error)
	probe     func(context.Context, string, string, time.Duration) (int, error)
	core      func() Core
	forwarder func(string) (Forwarder, error)
	now       func() time.Time
}
type Pool struct {
	settings             Settings
	sources              SourceProvider
	deps                 dependencies
	lifecycle            chan struct{}
	mu                   sync.Mutex
	slotReleased         chan struct{}
	records              []*record
	leases               map[string]heldLease
	pending              map[string]*pendingAcquire
	cache                map[string]cachedProbe
	core                 Core
	generation           uint64
	cursor               int
	running              bool
	activeRevision       *string
	lastError, coreError string
	summary              map[string]any
	health               healthState
}

func New(settings Settings, sources SourceProvider) *Pool {
	return newPool(settings, sources, dependencies{
		load: loadSources, probe: proxytransport.ProbeHTTPStatus,
		core: func() Core {
			return proxytransport.NewCore(proxytransport.CoreSettings{
				BinaryPath: settings.CoreBinary, ExpectedSHA256: settings.CoreSHA256,
				RuntimeDir: settings.RuntimeDir, ProjectBinDir: settings.ProjectBinDir,
				BasePort: settings.CoreBasePort, StartTimeout: settings.CoreStartTimeout,
			})
		},
		forwarder: func(endpoint string) (Forwarder, error) { return proxytransport.NewForwarder(endpoint) },
		now:       time.Now,
	})
}
func newPool(settings Settings, sources SourceProvider, deps dependencies) *Pool {
	return &Pool{settings: settings, sources: sources, deps: deps, lifecycle: make(chan struct{}, 1),
		leases: map[string]heldLease{}, pending: map[string]*pendingAcquire{}, cache: map[string]cachedProbe{},
		summary: map[string]any{"subscriptions": 0, "source_nodes": 0, "pool_nodes": 0, "skipped_nodes": 0, "scheme_counts": map[string]int{}, "warnings": []string{}}}
}
func (p *Pool) enter(ctx context.Context) error {
	select {
	case p.lifecycle <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (p *Pool) leave()         { <-p.lifecycle }
func copyLease(l Lease) *Lease { l.Tags = append([]string{}, l.Tags...); return &l }
func copyProbe(r ProbeResult) ProbeResult {
	r.Results = append([]ProbeNode{}, r.Results...)
	for i := range r.Results {
		if r.Results[i].Latency != nil {
			n := *r.Results[i].Latency
			r.Results[i].Latency = &n
		}
	}
	if r.Age != nil {
		n := *r.Age
		r.Age = &n
	}
	return r
}
