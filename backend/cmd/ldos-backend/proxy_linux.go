package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"ldos/backend/internal/config"
	"ldos/backend/internal/proxyapi"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/proxysources"
	"ldos/backend/internal/scheduler"
	"ldos/backend/internal/tasks"
)

type proxyRuntime struct {
	pool    *proxypool.Pool
	handler http.Handler
	cancel  context.CancelFunc
	done    chan struct{}
}

func newProxyRuntime(settings config.Settings) (*proxyRuntime, error) {
	sources, err := proxysources.New(settings.Proxy.SourceSettings(), settings.RuntimeDir, settings.ProjectDir)
	if err != nil {
		return nil, err
	}
	pool := proxypool.New(settings.Proxy.RuntimeSettings(settings.RuntimeDir, settings.ProjectDir), sources)
	handler := proxyapi.New(pool, sources, func(ctx context.Context, target string) error {
		return tasks.ValidateTarget(ctx, target, settings.Server.AllowPrivateTargets, settings.Server.StrictTargetDNS, nil)
	}, func(context.Context, string) (string, error) {
		// The editable site policy has four fields, none of which overrides probe_url.
		// Its runtime default is nil, so the pool's configured probe target applies.
		return "", nil
	})
	return &proxyRuntime{pool: pool, handler: handler}, nil
}
func (r *proxyRuntime) start(ctx context.Context, settings config.Proxy) {
	if settings.Enabled && settings.AutoStart {
		if _, err := r.pool.Start(ctx, ""); err != nil {
			log.Printf("native proxy startup failed: %s; inspect /api/v1/proxy/status", r.pool.Status()["last_error"])
		}
	}
	healthCtx, cancel := context.WithCancel(ctx)
	r.cancel = cancel
	r.done = make(chan struct{})
	go func() { defer close(r.done); r.pool.RunHealth(healthCtx) }()
}
func (r *proxyRuntime) stop() error {
	if r.cancel != nil {
		r.cancel()
		<-r.done
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := r.pool.Stop(ctx, true)
	return err
}

type schedulerPool struct{ pool *proxypool.Pool }

func (p schedulerPool) Acquire(ctx context.Context, request scheduler.ProxyRequest) (*scheduler.Lease, error) {
	target := ""
	if request.ProbeURL != nil {
		target = *request.ProbeURL
	}
	lease, err := p.pool.Acquire(ctx, proxypool.Request{Owner: request.TaskID, NodeTags: request.NodeTags, ExcludeIDs: request.ExcludeIDs, AllowedIDs: request.AllowedIDs, ProbeBeforeUse: request.ProbeBeforeUse, ProbeURL: target})
	if errors.Is(err, proxypool.ErrUnavailable) {
		return nil, fmt.Errorf("%w: %v", scheduler.ErrPoolUnavailable, err)
	}
	if err != nil || lease == nil {
		return nil, err
	}
	return &scheduler.Lease{NodeID: lease.NodeID, Name: lease.Name, Protocol: lease.Protocol, Endpoint: lease.Endpoint}, nil
}
func (p schedulerPool) Release(ctx context.Context, owner string, fault bool, reason string) error {
	return p.pool.Release(ctx, owner, fault, reason)
}

type downloadPool struct{ pool *proxypool.Pool }

func (p downloadPool) Acquire(ctx context.Context, owner string) (string, error) {
	lease, err := p.pool.Acquire(ctx, proxypool.Request{Owner: owner})
	if err != nil || lease == nil {
		return "", err
	}
	return lease.Endpoint, nil
}
func (p downloadPool) Release(ctx context.Context, owner string, fault bool, reason string) error {
	return p.pool.Release(ctx, owner, fault, reason)
}
