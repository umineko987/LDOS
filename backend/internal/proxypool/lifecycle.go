package proxypool

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"

	"ldos/backend/internal/proxyparse"
	"ldos/backend/internal/proxysources"
	"ldos/backend/internal/redaction"
)

func (p *Pool) Start(ctx context.Context, probeURL string) (map[string]any, error) {
	if err := p.enter(ctx); err != nil {
		return nil, err
	}
	defer p.leave()
	return p.start(ctx, p.sources.Snapshot(), probeURL)
}
func (p *Pool) Reload(ctx context.Context, probeURL string) (map[string]any, error) {
	if err := p.enter(ctx); err != nil {
		return nil, err
	}
	defer p.leave()
	snapshot := p.sources.Snapshot()
	if err := p.stop(ctx, false); err != nil {
		return nil, err
	}
	return p.start(ctx, snapshot, probeURL)
}
func (p *Pool) start(ctx context.Context, snapshot proxysources.Snapshot, probeURL string) (result map[string]any, err error) {
	p.mu.Lock()
	clear(p.cache)
	if !p.settings.Enabled {
		p.mu.Unlock()
		return nil, errors.New("代理池配置为停用状态")
	}
	if len(p.leases) > 0 || len(p.pending) > 0 {
		p.mu.Unlock()
		return nil, ErrConflict
	}
	oldCore := p.core
	p.core = nil
	p.running = false
	p.generation++
	p.coreError = ""
	p.records = nil
	p.cursor = 0
	p.mu.Unlock()
	if oldCore != nil {
		if err = oldCore.Stop(); err != nil {
			return nil, err
		}
	}
	var core Core
	defer func() {
		if err != nil {
			_ = p.stop(context.Background(), true)
			if core != nil {
				_ = core.Stop()
			}
			p.mu.Lock()
			p.lastError = safeWarning(err.Error(), snapshot)
			p.mu.Unlock()
		}
	}()
	if probeURL == "" {
		probeURL = p.settings.ProbeURL
	}
	if _, _, err = probeTarget(probeURL); err != nil {
		return nil, err
	}
	nodes, warnings, err := p.deps.load(ctx, snapshot, p.settings.SubscriptionTimeout)
	if err != nil {
		return nil, err
	}
	records := []*record{}
	tunnels := []proxyparse.Node{}
	counts := map[string]int{}
	seen := map[string]bool{}
	skipped := 0
	for _, node := range nodes {
		scheme := strings.ToLower(node.Scheme)
		if scheme == "" {
			scheme = "unknown"
		}
		counts[scheme]++
		if !node.Usable || node.Endpoint == "" {
			if p.settings.TransportCoreEnabled && len(node.CoreConfig) > 0 {
				tunnels = append(tunnels, node)
			} else {
				skipped++
			}
			continue
		}
		if strings.HasPrefix(scheme, "socks") && !p.settings.AllowSocks {
			skipped++
			continue
		}
		if seen[node.Endpoint] {
			continue
		}
		seen[node.Endpoint] = true
		name := safeName(node.Name)
		if name == "" {
			name = scheme + "-" + node.Host
		}
		digest := sha256.Sum256([]byte(node.Endpoint)) // Preserve public node IDs used in retry allowlists.
		records = append(records, &record{id: hex.EncodeToString(digest[:])[:20], name: name, protocol: scheme, endpoint: node.Endpoint, tags: nodeTags(name, scheme, node.Host)})
	}
	coreCount := 0
	if len(tunnels) > 0 {
		core = p.deps.core()
		endpoints, startErr := core.Start(ctx, tunnels)
		if startErr != nil {
			p.mu.Lock()
			p.coreError = redaction.Text("隧道核心启动失败："+startErr.Error(), 500)
			p.mu.Unlock()
			return nil, startErr
		}
		for _, endpoint := range endpoints {
			name := safeName(endpoint.Name)
			if name == "" {
				name = endpoint.SourceProtocol + "-" + endpoint.SourceHost
			}
			tags := append(nodeTags(name, endpoint.SourceProtocol, endpoint.SourceHost), "http", "transport-core", endpoint.SourceProtocol)
			slices.Sort(tags)
			tags = slices.Compact(tags)
			records = append(records, &record{id: endpoint.ID, name: name, protocol: "http", endpoint: endpoint.LocalHTTP, tags: tags})
		}
		coreCount = len(endpoints)
		skipped += max(0, len(tunnels)-coreCount)
	}
	if len(records) == 0 {
		return nil, errors.New("节点源中未解析出可直接使用的 HTTP/HTTPS/SOCKS 代理")
	}
	cleanWarnings := []string{}
	for _, warning := range warnings[:min(20, len(warnings))] {
		cleanWarnings = append(cleanWarnings, safeWarning(warning, snapshot))
	}
	p.mu.Lock()
	p.records = records
	p.core = core
	p.running = true
	p.generation++
	p.summary = map[string]any{"subscriptions": len(snapshot.SubscriptionURLs), "source_nodes": len(nodes), "pool_nodes": len(records),
		"core_candidates": len(tunnels), "core_nodes": coreCount, "skipped_nodes": skipped, "scheme_counts": counts, "warnings": cleanWarnings}
	p.mu.Unlock()
	probed, err := p.probe(ctx, probeURL, "")
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	revision := snapshot.ConfiguredRevision
	p.activeRevision = &revision
	p.lastError = ""
	if probed.Healthy == 0 {
		p.lastError = "全部代理节点探活未通过"
	}
	p.mu.Unlock()
	return map[string]any{"start": map[string]any{"engine": p.settings.Engine, "nodes": len(records)}, "probe": probed, "status": p.status(snapshot)}, nil
}
func (p *Pool) Stop(ctx context.Context, force bool) (map[string]any, error) {
	if err := p.enter(ctx); err != nil {
		return nil, err
	}
	defer p.leave()
	if err := p.stop(ctx, force); err != nil {
		return nil, err
	}
	return p.Status(), nil
}
func (p *Pool) stop(ctx context.Context, force bool) error {
	p.mu.Lock()
	clear(p.cache)
	if (len(p.leases) > 0 || len(p.pending) > 0) && !force {
		p.mu.Unlock()
		return ErrConflict
	}
	p.running = false
	p.generation++
	owners := make([]string, 0, len(p.leases))
	for owner := range p.leases {
		owners = append(owners, owner)
	}
	pending := make([]*pendingAcquire, 0, len(p.pending))
	for _, work := range p.pending {
		work.cancel()
		pending = append(pending, work)
	}
	core := p.core
	p.core = nil
	p.mu.Unlock()
	var errs []error
	for _, owner := range owners {
		errs = append(errs, p.Release(context.Background(), owner, false, "代理池停止"))
	}
	if core != nil {
		errs = append(errs, core.Stop())
	}
	for _, work := range pending {
		select {
		case <-work.done:
		case <-ctx.Done():
			return errors.Join(append(errs, ctx.Err())...)
		}
	}
	return errors.Join(errs...)
}
func (p *Pool) unavailableLocked() error {
	if p.coreError != "" {
		return fmt.Errorf("%w：%s；请修复传输核心后在 WebUI 重新启动代理池", ErrUnavailable, p.coreError)
	}
	return nil
}
