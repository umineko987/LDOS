package network

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

type DNSResolver interface {
	Resolve(context.Context, string, string) ([]string, error)
}
type ValidatorSettings struct {
	AllowPrivate, Strict bool
	CacheTTL             time.Duration
	CacheMaxEntries      int
}

func DefaultValidatorSettings() ValidatorSettings {
	return ValidatorSettings{Strict: true, CacheTTL: 300 * time.Second, CacheMaxEntries: 512}
}

type cacheEntry struct {
	expires   time.Time
	addresses []string
}
type Validator struct {
	settings ValidatorSettings
	resolver DNSResolver
	lookup   LookupIP
	now      func() time.Time
	mu       sync.Mutex
	cache    map[string]cacheEntry
}

func NewValidator(settings ValidatorSettings, resolver DNSResolver) (*Validator, error) {
	if settings.CacheTTL < 0 || settings.CacheMaxEntries < 0 {
		return nil, errors.New("代理 DoH 缓存 TTL 和容量不能为负数")
	}
	return &Validator{settings: settings, resolver: resolver, now: time.Now, cache: map[string]cacheEntry{}}, nil
}
func (v *Validator) ValidateStatic(value string) (Target, error) {
	return ValidateSyntax(value, v.settings.AllowPrivate)
}
func (v *Validator) ValidateDirect(ctx context.Context, value string) ([]string, error) {
	target, err := v.ValidateStatic(value)
	if err != nil {
		return nil, err
	}
	if v.settings.AllowPrivate {
		if target.LiteralIP.IsValid() {
			return []string{renderIP(target.LiteralIP)}, nil
		}
		return []string{}, nil
	}
	return ValidateDirect(ctx, value, false, v.settings.Strict, v.lookup)
}
func (v *Validator) ValidateProxy(ctx context.Context, value, endpoint string) ([]string, error) {
	target, err := v.ValidateStatic(value)
	if err != nil {
		return nil, &Error{"invalid_network_target", err.Error(), false, false}
	}
	if strings.TrimSpace(endpoint) == "" {
		return nil, missingProxy()
	}
	var addresses []string
	if target.LiteralIP.IsValid() {
		addresses = []string{renderIP(target.LiteralIP)}
	} else {
		addresses, err = v.resolver.Resolve(ctx, target.Hostname, endpoint)
		if err != nil {
			return nil, err
		}
	}
	validated, err := ValidateAddresses(addresses, v.settings.AllowPrivate, v.settings.Strict)
	if err != nil {
		return nil, &Error{"invalid_network_target", "加密 DNS 返回了不允许的目标地址，已拒绝连接", false, false}
	}
	if !target.LiteralIP.IsValid() {
		if strictTarget, err := ValidateSyntax(value, false); err == nil {
			if public, err := ValidateAddresses(addresses, false, true); err == nil {
				v.store(strictTarget.Hostname, public)
			}
		}
	}
	return validated, nil
}

// CacheFallback only admits a batch preflight after a recent public proxy DNS
// validation. It never returns IPs, replaces live connection validation, or looks
// up the host via local DNS.
func (v *Validator) CacheFallback(value string) bool {
	target, err := ValidateSyntax(value, false)
	if err != nil || target.LiteralIP.IsValid() {
		return false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.expire(v.now())
	_, exists := v.cache[target.Hostname]
	return exists
}
func (v *Validator) expire(now time.Time) {
	for host, entry := range v.cache {
		if !entry.expires.After(now) {
			delete(v.cache, host)
		}
	}
}
func (v *Validator) store(host string, addresses []string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now()
	v.expire(now)
	if v.settings.CacheTTL == 0 || v.settings.CacheMaxEntries == 0 {
		clear(v.cache)
		return
	}
	v.cache[host] = cacheEntry{now.Add(v.settings.CacheTTL), append([]string{}, addresses...)}
	for len(v.cache) > v.settings.CacheMaxEntries {
		earliest := ""
		var expiry time.Time
		for candidate, entry := range v.cache {
			if earliest == "" || entry.expires.Before(expiry) || (entry.expires.Equal(expiry) && candidate < earliest) {
				earliest, expiry = candidate, entry.expires
			}
		}
		delete(v.cache, earliest)
	}
}
