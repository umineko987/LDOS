package discovery

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"

	"ldos/backend/internal/danboorurate"
	"ldos/backend/internal/redaction"
	"ldos/backend/internal/scheduler"
)

const danBaseURL = "https://danbooru.donmai.us"

type DanbooruAdapter struct {
	Transport       *Transport
	GalleryDiscover func(context.Context, Request) (map[string]any, error)
}

type danAPIError struct {
	message               string
	status                int
	retryable, proxyFault bool
}

func (e *danAPIError) Error() string { return e.message }

func IsCloudflareChallenge(status int, body string) bool {
	lower := strings.ToLower(body)
	return status == 403 && (strings.Contains(lower, "cloudflare") || strings.Contains(lower, "just a moment") || strings.Contains(lower, "cf-mitigated") || strings.Contains(lower, "正在进行安全验证"))
}

func danTargetPolicy(policy scheduler.Policy) scheduler.Policy {
	if policy.ProbeURL == nil || *policy.ProbeURL == "" {
		probe := danBaseURL + "/"
		policy.ProbeURL = &probe
	}
	return policy
}

// danRows accepts JSON arrays and the map slices returned by the native pool.
func danRows(value any) ([]any, bool) {
	switch values := value.(type) {
	case []any:
		return values, true
	case []map[string]any:
		rows := make([]any, len(values))
		for i, row := range values {
			rows[i] = row
		}
		return rows, true
	}
	return nil, false
}
func danStrings(value any) []string {
	if values, ok := value.([]string); ok {
		return values
	}
	rows, _ := danRows(value)
	values := make([]string, 0, len(rows))
	for _, row := range rows {
		values = append(values, stringValue(row))
	}
	return values
}
func danTruthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case int:
		return v != 0
	case float64:
		return v != 0
	}
	return true
}
func (a *DanbooruAdapter) danNodeTags(policy scheduler.Policy) ([]string, []string) {
	if len(policy.NodeTags) > 0 {
		return policy.NodeTags, nil
	}
	rows, _ := danRows(a.Transport.Pool.Status()["nodes"])
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		if !ok || !danTruthy(row["healthy"]) {
			continue
		}
		for _, tag := range danStrings(row["tags"]) {
			if tag == "us" {
				return []string{"us"}, []string{}
			}
		}
	}
	return []string{}, nil
}

func (a *DanbooruAdapter) danJSONRequest(ctx context.Context, target string, params url.Values, attempt Attempt, policy scheduler.Policy) (any, error) {
	ratePath := a.Transport.DanbooruRatePath
	if ratePath != "" {
		if err := danboorurate.Wait(ctx, ratePath); err != nil {
			return nil, danRateError(ctx, err)
		}
	}
	response, err := a.Transport.HTTPRequest(ctx, "GET", target, params, nil, attempt.Endpoint(), duration(policy.HTTPTimeout))
	if err != nil {
		return nil, err
	}
	status := response.StatusCode
	if status == 429 && ratePath != "" {
		if err := danboorurate.Cooldown(ctx, ratePath, response.Headers.Get("Retry-After")); err != nil {
			return nil, danRateError(ctx, err)
		}
	}
	if status >= 300 && status < 400 {
		return nil, &danAPIError{message: fmt.Sprintf("Danbooru API 返回了未接受的重定向 (HTTP %d)", status), status: status}
	}
	challenge := IsCloudflareChallenge(status, response.Text)
	if status >= 400 {
		message := fmt.Sprintf("Danbooru API 返回 HTTP %d", status)
		if challenge {
			message = fmt.Sprintf("Danbooru API 遇到 Cloudflare 检查 (HTTP %d)", status)
		}
		return nil, &danAPIError{message: message, status: status, retryable: challenge || status == 408 || status == 425 || status == 429 || status >= 500, proxyFault: challenge}
	}
	if response.JSONError != nil {
		return nil, &danAPIError{message: "Danbooru API 返回了无效 JSON", status: status, retryable: challenge, proxyFault: challenge}
	}
	return response.Payload, nil
}

func (a *DanbooruAdapter) APIJSON(ctx context.Context, target string, params url.Values, policy scheduler.Policy, mode string, secure bool) (Outcome, error) {
	policy = danTargetPolicy(policy)
	if mode == "" {
		mode = policy.ProxyMode
	}
	tags, fallback := a.danNodeTags(policy)
	var lastStatus any
	outcome, err := a.Transport.Execute(ctx, ExecuteOptions{URL: target, Mode: mode, Policy: policy, Prefix: "dan-api", Secure: secure, NodeTags: tags, FallbackTags: fallback, AcquireErrorFatal: secure || mode == "required", RequiredMessage: "当前没有符合 Danbooru API 查询策略的健康代理节点",
		Operation: func(ctx context.Context, attempt Attempt) (any, error) {
			value, err := a.danJSONRequest(ctx, target, params, attempt, policy)
			var apiErr *danAPIError
			if errors.As(err, &apiErr) {
				lastStatus = apiErr.status
				return nil, &Failure{Message: redaction.Text(apiErr.Error(), 1000), Retryable: apiErr.retryable, ProxyFault: attempt.Lease != nil && apiErr.proxyFault, Details: map[string]any{"status_code": apiErr.status}}
			}
			return value, err
		}, Classify: func(err error, attempt Attempt) *Failure {
			return danClassifyFailure(err, attempt)
		},
	})
	if err != nil {
		var exhausted *Exhausted
		if errors.As(err, &exhausted) {
			return Outcome{}, &Error{Code: "danbooru_api_failed", Message: exhausted.Failure.Message, Details: map[string]any{"attempts": exhausted.Attempts, "status_code": lastStatus, "proxy": exhausted.Proxy}}
		}
	}
	return outcome, err
}

func danRateError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return &Error{Code: "danbooru_rate_limit_failed", Message: "Danbooru 本地共享限流状态不可用", Details: map[string]any{"reason": redaction.Text(err.Error(), 500)}}
}

func danClassifyFailure(err error, attempt Attempt) *Failure {
	message := redaction.Text(err.Error(), 1000, leaseSecrets(attempt.Lease)...)
	var apiError *danAPIError
	if errors.As(err, &apiError) {
		return &Failure{Message: message, Retryable: apiError.retryable, ProxyFault: attempt.Lease != nil && apiError.proxyFault, Details: map[string]any{"status_code": apiError.status}}
	}
	var networkError net.Error
	networkFault := errors.As(err, &networkError)
	return &Failure{Message: message, Retryable: networkFault, ProxyFault: attempt.Lease != nil && networkFault}
}
