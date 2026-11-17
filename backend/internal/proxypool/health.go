package proxypool

import (
	"context"
	"errors"
	"time"
)

type healthState struct {
	started, running                     bool
	failures                             int
	category                             string
	lastError, lastSuccess, lastRecovery *float64
}

// RunHealth is the service-owned monitor. The caller cancels ctx and waits for
// this function before stopping the pool; the monitor never restarts a stopped pool.
func (p *Pool) RunHealth(ctx context.Context) {
	p.mu.Lock()
	p.health.started = true
	p.health.running = true
	p.mu.Unlock()
	defer func() { p.mu.Lock(); p.health.running = false; p.mu.Unlock() }()
	ticker := time.NewTicker(max(5*time.Second, p.settings.HealthInterval))
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.healthTick(ctx)
		}
	}
}
func (p *Pool) healthTick(ctx context.Context) {
	if err := p.enter(ctx); err != nil {
		return
	}
	defer p.leave()
	p.mu.Lock()
	running := p.running
	p.mu.Unlock()
	var err error
	if running {
		_, err = p.probe(ctx, p.settings.ProbeURL, "")
	}
	if ctx.Err() != nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := unixSeconds(p.deps.now())
	if err != nil {
		p.health.failures++
		p.health.lastError = &now
		p.health.category = "unexpected_error"
		if errors.Is(err, context.DeadlineExceeded) {
			p.health.category = "timeout"
		}
	} else {
		p.health.lastSuccess = &now
		if p.health.failures > 0 {
			p.health.failures = 0
			p.health.lastRecovery = &now
		}
	}
}
func (p *Pool) HealthSummary() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	h := p.health
	state := "not_started"
	if h.started {
		state = "stopped"
	}
	if h.running {
		state = "running"
		if h.failures > 0 {
			state = "degraded"
		}
	}
	var category any
	if h.category != "" {
		category = h.category
	}
	value := func(v *float64) any {
		if v == nil {
			return nil
		}
		return *v
	}
	return map[string]any{"state": state, "running": h.running, "operational": true, "consecutive_failures": min(h.failures, 1_000_000),
		"last_error_category": category, "last_error_at": value(h.lastError), "last_success_at": value(h.lastSuccess), "last_recovery_at": value(h.lastRecovery)}
}
