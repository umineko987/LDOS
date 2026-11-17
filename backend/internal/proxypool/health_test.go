package proxypool

import (
	"context"
	"testing"
	"time"
)

func TestHealthFailureRecoveryAndStop(t *testing.T) {
	p, clock, _ := testPool(t)
	if p.HealthSummary()["state"] != "not_started" {
		t.Fatal(p.HealthSummary())
	}
	p.settings.ProbeURL = "http://invalid.example/"
	p.healthTick(context.Background())
	if h := p.HealthSummary(); h["consecutive_failures"] != 1 || h["last_error_at"] == nil || h["last_success_at"] != nil {
		t.Fatal(h)
	}
	clock.Add(int64(time.Second))
	p.settings.ProbeURL = "https://target.example/"
	p.healthTick(context.Background())
	if h := p.HealthSummary(); h["consecutive_failures"] != 0 || h["last_recovery_at"] == nil || h["last_success_at"] == nil {
		t.Fatal(h)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p.RunHealth(ctx)
	if h := p.HealthSummary(); h["state"] != "stopped" || h["running"] != false {
		t.Fatal(h)
	}
	if _, err := p.Stop(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	// A stopped pool is healthy as a service component; monitoring must not load it.
	clock.Add(int64(time.Second))
	p.healthTick(context.Background())
	if h := p.HealthSummary(); h["consecutive_failures"] != 0 || p.Status()["running"] != false {
		t.Fatal(h)
	}
}
