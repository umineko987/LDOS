package scheduler

import (
	"math"
	"strings"

	"ldos/backend/internal/redaction"
)

type Decision struct {
	ErrorClass string
	Retryable  bool
	ProxyFault bool
	Message    string
}

var proxyMarkers = []string{
	"proxyerror", "proxy error", "tunnel connection failed", "connect tunnel failed",
	"proxy authentication required", "407 proxy", "socks error", "connection refused",
	"connection aborted", "connection reset", "connectionreseterror",
	"failed to establish a new connection", "tls handshake", "ssl handshake",
	"sslerror", "ssleoferror", "unexpected_eof_while_reading",
	"eof occurred in violation of protocol", "remote end closed connection without response",
	"cloudflare challenge", "just a moment...",
}
var authMarkers = []string{"authenticationerror", "authorizationerror", "authrequired", "invalid login", "login required", "credentials required", "authenticated cookies needed", "could not authenticate you", "not authenticated", "insufficient privileges"}
var transientMarkers = []string{"429 too many requests", "rate limit", "502 bad gateway", "503 service unavailable", "504 gateway timeout", "temporarily unavailable"}

func containsAny(text string, markers []string) bool {
	for _, marker := range markers {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

// Classify preserves gallery-dl's bitwise exit codes and textual fallbacks.
func Classify(exitCode *int, output string, cancelled, timedOut bool) Decision {
	lower := strings.ToLower(output)
	message := "gallery-dl 任务失败"
	if trimmed := strings.TrimSpace(output); trimmed != "" {
		lines := strings.FieldsFunc(trimmed, func(r rune) bool { return r == '\n' || r == '\r' })
		message = redaction.Text(lines[len(lines)-1], 1000)
	}
	if cancelled {
		return Decision{"cancelled", false, false, "任务已取消"}
	}
	proxyFault := containsAny(lower, proxyMarkers)
	if timedOut {
		return Decision{"task_timeout", true, proxyFault, "任务超过执行时限"}
	}
	if exitCode != nil && *exitCode == 0 {
		return Decision{ErrorClass: "success"}
	}
	code := 0
	if exitCode != nil {
		code = *exitCode
	}
	switch {
	case code&64 != 0 || strings.Contains(lower, "unsupported url"):
		return Decision{"unsupported_url", false, false, message}
	case code&32 != 0:
		return Decision{"input_error", false, false, message}
	case code&16 != 0 || containsAny(lower, authMarkers):
		return Decision{"authentication", false, false, message}
	case code&8 != 0:
		return Decision{"cloudflare_challenge", true, true, message}
	case containsAny(lower, []string{"notfounderror", "could not be found", "404 not found"}):
		return Decision{"not_found", false, false, message}
	case containsAny(lower, []string{"as input url to continue downloading from the current position", "as input url to continue downloading from current position"}):
		return Decision{"download_error", true, proxyFault, message}
	case proxyFault:
		return Decision{"proxy_failure", true, true, message}
	case containsAny(lower, transientMarkers):
		return Decision{"site_transient", true, false, message}
	case strings.Contains(lower, "timed out") || strings.Contains(lower, "timeout"):
		return Decision{"network_timeout", true, false, message}
	case code&128 != 0:
		return Decision{"download_error", true, false, message}
	case code&4 != 0:
		return Decision{"extraction_error", false, false, message}
	default:
		return Decision{"gallery_error", false, false, message}
	}
}

func AttemptStatus(d Decision) string {
	if d.ErrorClass == "success" {
		return "succeeded"
	}
	if d.ErrorClass == "cancelled" {
		return "cancelled"
	}
	return "failed"
}

func Transition(d Decision, cancelRequested bool, attempt, maxAttempts int) string {
	if cancelRequested || d.ErrorClass == "cancelled" {
		return "cancelled"
	}
	if d.ErrorClass == "success" {
		return "succeeded"
	}
	if d.Retryable && attempt < maxAttempts {
		return "requeue"
	}
	return "failed"
}

func RetryDelay(base float64, attempt, anchor int, cap, jitter float64) float64 {
	exponent := max(0, attempt-1-anchor)
	delay := 0.0
	if base > 0 {
		delay = math.Min(math.Ldexp(base, exponent), cap)
	}
	return delay + jitter
}

func PartialArtifactFailure(d Decision, artifactCount int) Decision {
	if d.ErrorClass == "extraction_error" && !d.Retryable && artifactCount > 0 {
		d.ErrorClass, d.Retryable = "extraction_partial", true
	}
	return d
}

func TriedProxyIDs(tried []string, node string, fault bool) []string {
	result := append([]string{}, tried...)
	if node != "" && fault {
		for _, id := range result {
			if id == node {
				return result
			}
		}
		result = append(result, node)
	}
	return result
}
