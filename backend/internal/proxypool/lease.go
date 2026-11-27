package proxypool

import (
	"context"
	"net/url"
	"slices"
	"strings"

	"ldos/backend/internal/redaction"
)

func eligible(r *record, request Request) bool {
	if slices.Contains(request.ExcludeIDs, r.id) {
		return false
	}
	if request.AllowedIDs != nil && !slices.Contains(request.AllowedIDs, r.id) {
		return false
	}
	wanted := false
	matched := false
	for _, tag := range request.NodeTags {
		tag = strings.ToLower(strings.TrimSpace(tag))
		if tag != "" {
			wanted = true
			if slices.Contains(r.tags, tag) {
				matched = true
			}
		}
	}
	return (!wanted || matched) && (request.ProbeBeforeUse || r.healthy)
}

// Capacity counts matching idle nodes plus this consumer's own reservations, so
// starting a request doesn't shrink its advertised window. Busy nodes belonging
// to other consumers can become available again without changing site policy.
func (p *Pool) Capacity(req Request, ownerPrefix string) (slots int, matched bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.running {
		return 0, false
	}
	now := p.deps.now()
	probeable := false
	for _, r := range p.records {
		if !eligible(r, req) || r.cooldown.After(now) {
			continue
		}
		matched = true
		if r.owner == "" || strings.HasPrefix(r.owner, ownerPrefix) {
			if r.healthy {
				slots++
			} else {
				probeable = true
			}
		}
	}
	if slots == 0 && probeable {
		slots = 1
	}
	return slots, matched
}

func (p *Pool) releaseSlotLocked(r *record) {
	r.owner = ""
	if p.slotReleased != nil {
		close(p.slotReleased)
		p.slotReleased = nil
	}
}

func (p *Pool) Acquire(ctx context.Context, request Request) (*Lease, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p.mu.Lock()
	if lease, ok := p.leases[request.Owner]; ok {
		p.mu.Unlock()
		return copyLease(lease.lease), nil
	}
	if pending := p.pending[request.Owner]; pending != nil {
		p.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-pending.done:
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		if lease, ok := p.leases[request.Owner]; ok {
			return copyLease(lease.lease), nil
		}
		return nil, nil
	}
	if !p.running {
		err := p.unavailableLocked()
		p.mu.Unlock()
		return nil, err
	}
	workCtx, cancel := context.WithCancel(ctx)
	work := &pendingAcquire{done: make(chan struct{}), cancel: cancel}
	p.pending[request.Owner] = work
	generation := p.generation
	p.mu.Unlock()
	defer func() { cancel(); p.mu.Lock(); delete(p.pending, request.Owner); close(work.done); p.mu.Unlock() }()
	target := request.ProbeURL
	if target == "" {
		target = p.settings.ProbeURL
	}
	public := ""
	if request.ProbeBeforeUse {
		var err error
		_, public, err = probeTarget(target)
		if err != nil {
			return nil, err
		}
	}
	tried := map[*record]bool{}
	for {
		if err := workCtx.Err(); err != nil {
			return nil, err
		}
		p.mu.Lock()
		var selected *record
		busy := false
		if p.running && p.generation == generation {
			for offset := range len(p.records) {
				i := (p.cursor + offset) % len(p.records)
				r := p.records[i]
				if tried[r] || r.cooldown.After(p.deps.now()) || !eligible(r, request) {
					continue
				}
				if r.owner != "" {
					busy = true
					continue
				}
				selected = r
				r.owner = request.Owner
				p.cursor = (i + 1) % len(p.records)
				break
			}
		}
		if selected == nil && busy && request.WaitIfBusy {
			if p.slotReleased == nil {
				p.slotReleased = make(chan struct{})
			}
			released := p.slotReleased
			p.mu.Unlock()
			select {
			case <-workCtx.Done():
				return nil, workCtx.Err()
			case <-released:
				continue
			}
		}
		p.mu.Unlock()
		if selected == nil {
			return nil, nil
		}
		tried[selected] = true
		releaseReservation := func() { p.mu.Lock(); p.releaseSlotLocked(selected); p.mu.Unlock() }
		if request.ProbeBeforeUse {
			result := p.probeEndpoint(workCtx, selected, target, public, generation, false)
			if err := workCtx.Err(); err != nil {
				releaseReservation()
				return nil, err
			}
			if !result.Healthy {
				p.mu.Lock()
				selected.failures++
				p.releaseSlotLocked(selected)
				p.mu.Unlock()
				continue
			}
		}
		endpoint := selected.endpoint
		var forwarder Forwarder
		parsed, _ := url.Parse(endpoint)
		if (selected.protocol == "http" || selected.protocol == "https") && parsed != nil && parsed.User != nil {
			var err error
			forwarder, err = p.deps.forwarder(endpoint)
			if err == nil {
				endpoint, err = forwarder.Start()
			}
			if err != nil {
				if forwarder != nil {
					_ = forwarder.Stop()
				}
				p.mu.Lock()
				selected.failures++
				selected.lastError = redaction.Text(err.Error(), 300)
				selected.cooldown = p.deps.now().Add(p.settings.FailCooldown)
				p.releaseSlotLocked(selected)
				p.mu.Unlock()
				continue
			}
		}
		lease := Lease{Owner: request.Owner, NodeID: selected.id, Name: selected.name, Protocol: selected.protocol, Endpoint: endpoint, Tags: append([]string{}, selected.tags...), AcquiredAt: unixSeconds(p.deps.now())}
		p.mu.Lock()
		current := p.running && p.generation == generation && workCtx.Err() == nil
		if current {
			p.leases[request.Owner] = heldLease{lease: lease, node: selected, forwarder: forwarder}
		}
		p.mu.Unlock()
		if current {
			return copyLease(lease), nil
		}
		if forwarder != nil {
			_ = forwarder.Stop()
		}
		releaseReservation()
		return nil, workCtx.Err()
	}
}
func (p *Pool) Release(_ context.Context, owner string, proxyFault bool, reason string) error {
	p.mu.Lock()
	held, ok := p.leases[owner]
	if !ok {
		p.mu.Unlock()
		return nil
	}
	delete(p.leases, owner)
	r := held.node
	p.releaseSlotLocked(r)
	if proxyFault {
		r.failures++
		r.healthy = false
		r.lastError = redaction.Text(reason, 300)
		r.cooldown = p.deps.now().Add(p.settings.FailCooldown)
		p.invalidateCachedNode(r.id)
	} else {
		r.successes++
		r.cooldown = p.deps.now()
	}
	p.mu.Unlock()
	if held.forwarder != nil {
		return held.forwarder.Stop()
	}
	return nil
}
