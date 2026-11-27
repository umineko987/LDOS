// Package discovery owns native discovery transport and site adapters.
package discovery

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"ldos/backend/internal/danboorurate"
	"ldos/backend/internal/discoverydata"
	"ldos/backend/internal/gallery"
	"ldos/backend/internal/network"
	"ldos/backend/internal/proxypool"
	"ldos/backend/internal/redaction"
	"ldos/backend/internal/scheduler"
)

type Error = discoverydata.Error
type Pool interface {
	Acquire(context.Context, proxypool.Request) (*proxypool.Lease, error)
	Release(context.Context, string, bool, string) error
	Status() map[string]any
}
type Capturer interface {
	Capture(context.Context, gallery.CaptureRequest) (gallery.CaptureResult, error)
}
type Validator interface {
	ValidateStatic(string) (network.Target, error)
	ValidateDirect(context.Context, string) ([]string, error)
	ValidateProxy(context.Context, string, string) ([]string, error)
}
type Transport struct {
	Gallery          Capturer
	Pool             Pool
	Validator        Validator
	RuntimeDir       string
	DanbooruRatePath string
	AuthFailure      func(context.Context, string, string, string) (bool, error)
	HTTPRequest      func(context.Context, string, string, url.Values, any, string, time.Duration) (HTTPResult, error)
}

func NewTransport(g Capturer, p Pool, v Validator, runtimeDir string, auth func(context.Context, string, string, string) (bool, error)) (*Transport, error) {
	root, err := os.OpenRoot(runtimeDir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if err := root.Mkdir("discovery", 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	info, err := root.Lstat("discovery")
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("发现任务目录不是普通目录")
	}
	if err := root.Chmod("discovery", 0700); err != nil {
		return nil, err
	}
	ratePath := filepath.Join(runtimeDir, danboorurate.FileName)
	if provider, ok := g.(interface{ DanbooruRatePath() string }); ok {
		ratePath = provider.DanbooruRatePath()
	}
	return &Transport{Gallery: g, Pool: p, Validator: v, RuntimeDir: filepath.Join(runtimeDir, "discovery"), DanbooruRatePath: ratePath, AuthFailure: auth, HTTPRequest: requestJSON}, nil
}

type Attempt struct {
	ID     string
	Number int
	Mode   string
	Lease  *proxypool.Lease
	Proxy  map[string]any
}
type Failure struct {
	Message, ErrorClass, AuthContext string
	Retryable, ProxyFault            bool
	Details                          map[string]any
}

func (f *Failure) Error() string { return f.Message }

type Exhausted struct {
	Failure                *Failure
	Attempts, AttemptCount int
	Proxy                  map[string]any
}

func (e *Exhausted) Error() string { return e.Failure.Message }

type Outcome struct {
	Value    any
	Attempts int
	Proxy    map[string]any
}
type ExecuteOptions struct {
	URL, Mode, Prefix, RequiredMessage            string
	Policy                                        scheduler.Policy
	Secure, AcquireErrorFatal, DirectPrevalidated bool
	WaitIfBusy                                    bool
	NodeTags, FallbackTags                        []string
	Operation                                     func(context.Context, Attempt) (any, error)
	Classify                                      func(error, Attempt) *Failure
	Cleanup                                       func(Attempt)
}

func ProxyMetadata(mode string, lease *proxypool.Lease) map[string]any {
	result := map[string]any{"mode": mode, "used": false, "node_id": nil, "node_name": nil, "protocol": nil}
	if lease != nil {
		secrets := leaseSecrets(lease)
		result["used"] = true
		result["node_id"] = redaction.Text(lease.NodeID, 128, secrets...)
		result["node_name"] = redaction.Text(lease.Name, 200, secrets...)
		result["protocol"] = redaction.Text(lease.Protocol, 50, secrets...)
	}
	return result
}
func leaseSecrets(lease *proxypool.Lease) []string {
	if lease == nil {
		return nil
	}
	values := []string{lease.Endpoint}
	if parsed, err := url.Parse(lease.Endpoint); err == nil {
		values = append(values, parsed.Host, parsed.Hostname(), parsed.Port())
	}
	return values
}
func dnsError(err *network.Error, mode string, lease *proxypool.Lease, attempts int) error {
	return &Error{Code: err.Code, Message: err.Message, Details: map[string]any{"attempts": attempts, "proxy": ProxyMetadata(mode, lease)}}
}
func (t *Transport) ValidateDirect(ctx context.Context, target string) error {
	_, err := t.Validator.ValidateDirect(ctx, target)
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var dns *network.Error
	if errors.As(err, &dns) {
		return dnsError(dns, "direct", nil, 0)
	}
	return &Error{Code: "invalid_network_target", Message: redaction.Text(err.Error(), 500), Details: map[string]any{"attempts": 0, "proxy": ProxyMetadata("direct", nil)}}
}
func (t *Transport) acquire(ctx context.Context, id, mode string, opts ExecuteOptions, tried []string, attempt int, lastProxy map[string]any) (*proxypool.Lease, error) {
	if mode == "direct" {
		return nil, nil
	}
	tags := opts.NodeTags
	if tags == nil {
		tags = opts.Policy.NodeTags
	}
	probeURL := ""
	if opts.Policy.ProbeURL != nil {
		probeURL = *opts.Policy.ProbeURL
	}
	request := proxypool.Request{Owner: id, NodeTags: tags, ExcludeIDs: tried, AllowedIDs: opts.Policy.AllowedProxyIDs, ProbeBeforeUse: opts.Policy.ProbeBeforeUse, ProbeURL: probeURL, WaitIfBusy: opts.WaitIfBusy}
	lease, err := t.Pool.Acquire(ctx, request)
	if err == nil && lease == nil && opts.FallbackTags != nil {
		request.NodeTags = opts.FallbackTags
		lease, err = t.Pool.Acquire(ctx, request)
	}
	fail := func(code, message string) (*proxypool.Lease, error) {
		return nil, &Error{Code: code, Message: message, Details: map[string]any{"attempts": attempt, "proxy": lastProxy}}
	}
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, proxypool.ErrUnavailable) {
			if mode != "prefer" {
				return fail("proxy_unavailable", "代理不可用，已终止（不会回退直连）")
			}
		} else if opts.AcquireErrorFatal {
			return fail("proxy_unavailable", "代理租约获取失败，已拒绝回退直连")
		}
	}
	if lease == nil && mode == "required" {
		message := opts.RequiredMessage
		if message == "" {
			message = "当前没有符合站点策略的健康代理节点"
		}
		return fail("proxy_unavailable", message)
	}
	return lease, nil
}
func (t *Transport) Execute(ctx context.Context, opts ExecuteOptions) (Outcome, error) {
	mode := opts.Mode
	if mode == "" {
		mode = opts.Policy.ProxyMode
	}
	attempts := max(1, opts.Policy.RetryLimit+1)
	tried := []string{}
	lastProxy := ProxyMetadata(mode, nil)
	if opts.Secure && mode == "direct" && !opts.DirectPrevalidated {
		if err := t.ValidateDirect(ctx, opts.URL); err != nil {
			return Outcome{}, err
		}
	}
	for number := 1; ; number++ {
		if err := ctx.Err(); err != nil {
			return Outcome{}, err
		}
		id := opts.Prefix + "-" + strings.ReplaceAll(uuid.NewString(), "-", "")
		lease, err := t.acquire(ctx, id, mode, opts, tried, number, lastProxy)
		if err != nil {
			return Outcome{}, err
		}
		current := Attempt{id, number, mode, lease, ProxyMetadata(mode, lease)}
		lastProxy = current.Proxy
		var failure *Failure
		var dns *network.Error
		value, err := func() (any, error) {
			defer func() {
				if lease != nil {
					fault := failure != nil && failure.ProxyFault
					reason := ""
					if fault {
						reason = redaction.Text(failure.Message, 1000, leaseSecrets(lease)...)
					}
					_ = t.Pool.Release(context.WithoutCancel(ctx), id, fault, reason)
				}
				if opts.Cleanup != nil {
					opts.Cleanup(current)
				}
			}()
			var value any
			var err error
			if opts.Secure && lease != nil {
				_, err = t.Validator.ValidateProxy(ctx, opts.URL, lease.Endpoint)
			} else if opts.Secure && mode == "prefer" {
				_, err = t.Validator.ValidateStatic(opts.URL)
			}
			if err == nil {
				value, err = opts.Operation(ctx, current)
			}
			if err == nil {
				return value, nil
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if errors.As(err, &dns) {
				failure = &Failure{Message: dns.Message, ErrorClass: "network_target", Retryable: dns.Retryable, ProxyFault: lease != nil && dns.ProxyFault}
				if dns.ProxyFault {
					failure.ErrorClass = "proxy_error"
				}
				if !failure.ProxyFault {
					return nil, dnsError(dns, mode, lease, number)
				}
			} else {
				var public *Error
				if errors.As(err, &public) {
					return nil, err
				}
				if !errors.As(err, &failure) {
					failure = opts.Classify(err, current)
				}
			}
			return nil, err
		}()
		if err == nil {
			return Outcome{value, number, current.Proxy}, nil
		}
		if ctx.Err() != nil {
			return Outcome{}, ctx.Err()
		}
		var public *Error
		if errors.As(err, &public) {
			return Outcome{}, err
		}
		if failure.ProxyFault && lease != nil {
			tried = append(tried, lease.NodeID)
		}
		if !failure.Retryable || number == attempts {
			if dns != nil {
				return Outcome{}, dnsError(dns, mode, lease, number)
			}
			return Outcome{}, &Exhausted{failure, attempts, number, current.Proxy}
		}
		delay := time.Duration(min(opts.Policy.BackoffBase*math.Pow(2, float64(number-1)), 10) * float64(time.Second))
		if delay > 0 {
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return Outcome{}, ctx.Err()
			case <-timer.C:
			}
		}
	}
}
func (t *Transport) OperationDirectory(id string) string { return filepath.Join(t.RuntimeDir, id) }
func (t *Transport) CleanupOperation(attempt Attempt) {
	if strings.HasPrefix(attempt.ID, "discover-") && filepath.Base(attempt.ID) == attempt.ID {
		_ = os.RemoveAll(t.OperationDirectory(attempt.ID))
	}
}
func (t *Transport) NotifyAuthFailure(ctx context.Context, site, cookies, message string) {
	if t.AuthFailure != nil {
		_, _ = t.AuthFailure(ctx, site, cookies, message)
	}
}
func (a Attempt) Endpoint() string {
	if a.Lease == nil {
		return ""
	}
	return a.Lease.Endpoint
}
func duration(seconds float64) time.Duration { return time.Duration(seconds * float64(time.Second)) }
func stringValue(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}
func integer(value any) (int, bool) {
	switch n := value.(type) {
	case int:
		return n, true
	case float64:
		return int(n), true
	case string:
		i, err := strconv.Atoi(n)
		return i, err == nil
	}
	i, err := strconv.Atoi(fmt.Sprint(value))
	return i, err == nil
}
