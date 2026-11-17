package proxypool

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"ldos/backend/internal/redaction"
)

func (p *Pool) Probe(ctx context.Context, target, nodeID string) (ProbeResult, error) {
	if err := p.enter(ctx); err != nil {
		return ProbeResult{}, err
	}
	defer p.leave()
	if target == "" {
		target = p.settings.ProbeURL
	}
	return p.probe(ctx, target, nodeID)
}
func (p *Pool) ProbeForTarget(ctx context.Context, target string) (ProbeResult, error) {
	key, _, err := probeTarget(target)
	if err != nil {
		return ProbeResult{}, err
	}
	if cached, ok := p.cached(key); ok {
		return cached, nil
	}
	if err := p.enter(ctx); err != nil {
		return ProbeResult{}, err
	}
	defer p.leave()
	if cached, ok := p.cached(key); ok {
		return cached, nil
	}
	return p.probe(ctx, target, "")
}
func (p *Pool) cached(key string) (ProbeResult, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	cache, ok := p.cache[key]
	if !ok {
		return ProbeResult{}, false
	}
	age := max(0, p.deps.now().Sub(cache.at).Seconds())
	if p.settings.ProbeCacheTTL <= 0 || age >= p.settings.ProbeCacheTTL.Seconds() {
		delete(p.cache, key)
		return ProbeResult{}, false
	}
	result := copyProbe(cache.result)
	result.Cached = true
	result.Age = &age
	return result, true
}
func (p *Pool) probe(ctx context.Context, target, nodeID string) (ProbeResult, error) {
	key, public, err := probeTarget(target)
	if err != nil {
		return ProbeResult{}, err
	}
	p.mu.Lock()
	if !p.running {
		p.mu.Unlock()
		return ProbeResult{}, errors.New("代理池尚未加载")
	}
	records := []*record{}
	for _, r := range p.records {
		if nodeID == "" || r.id == nodeID {
			records = append(records, r)
		}
	}
	generation := p.generation
	p.mu.Unlock()
	if nodeID != "" && len(records) == 0 {
		return ProbeResult{}, errors.New("节点不存在")
	}
	result := ProbeResult{Total: len(records), Results: make([]ProbeNode, len(records)), Target: public}
	jobs := make(chan int)
	var workers sync.WaitGroup
	for range max(1, min(p.settings.ProbeWorkers, len(records), 64)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for i := range jobs {
				result.Results[i] = p.probeEndpoint(ctx, records[i], target, public, generation, true)
			}
		}()
	}
	for i := range records {
		select {
		case jobs <- i:
		case <-ctx.Done():
			close(jobs)
			workers.Wait()
			return ProbeResult{}, ctx.Err()
		}
	}
	close(jobs)
	workers.Wait()
	if err := ctx.Err(); err != nil {
		return ProbeResult{}, err
	}
	for _, row := range result.Results {
		if row.Healthy {
			result.Healthy++
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lastError = ""
	if result.Healthy == 0 {
		p.lastError = fmt.Sprintf("探活目标 %s 无健康节点", public)
	}
	if p.settings.ProbeCacheTTL <= 0 {
		clear(p.cache)
	} else if nodeID == "" {
		p.cache[key] = cachedProbe{at: p.deps.now(), result: copyProbe(result)}
	} else if cached, ok := p.cache[key]; ok {
		matched := false
		for i, row := range cached.result.Results {
			if row.ID == nodeID {
				cached.result.Results[i] = result.Results[0]
				matched = true
			}
		}
		cached.result.Healthy = 0
		for _, row := range cached.result.Results {
			if row.Healthy {
				cached.result.Healthy++
			}
		}
		if !matched || cached.result.Healthy == 0 {
			delete(p.cache, key)
		} else {
			cached.result.Cached = false
			cached.result.Age = nil
			p.cache[key] = cached
		}
	}
	return result, nil
}
func (p *Pool) probeEndpoint(ctx context.Context, r *record, target, public string, generation uint64, update bool) ProbeNode {
	started := p.deps.now()
	status, err := p.deps.probe(ctx, target, r.endpoint, p.settings.ProbeTimeout)
	healthy := err == nil && status < 500 && status != 407
	message := ""
	if err != nil {
		message = redaction.Text(err.Error(), 300)
	} else if !healthy {
		message = fmt.Sprintf("代理探活返回 HTTP %d", status)
	}
	latency := p.deps.now().Sub(started).Seconds() * 1000
	result := ProbeNode{ID: r.id, Healthy: healthy, Error: message, Endpoint: MaskEndpoint(r.endpoint), Target: public}
	if healthy {
		result.Latency = &latency
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.generation != generation || ctx.Err() != nil {
		return result
	}
	r.healthy = healthy
	r.lastError = message
	if healthy {
		r.latency = &latency
		r.cooldown = p.deps.now()
		if update {
			r.successes++
		}
	} else {
		r.cooldown = p.deps.now().Add(p.settings.FailCooldown)
		if update {
			r.failures++
		}
		p.invalidateCachedNode(r.id)
	}
	return result
}

// Caller holds mu; a zero-healthy allowlist must force a full probe next time.
func (p *Pool) invalidateCachedNode(id string) {
	for key, cached := range p.cache {
		cached.result.Healthy = 0
		for i := range cached.result.Results {
			row := &cached.result.Results[i]
			if row.ID == id {
				row.Healthy = false
			}
			if row.Healthy {
				cached.result.Healthy++
			}
		}
		if cached.result.Healthy == 0 {
			delete(p.cache, key)
		} else {
			p.cache[key] = cached
		}
	}
}
