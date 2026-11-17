package scheduler

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestClassificationPrecedence(t *testing.T) {
	for _, tc := range []struct {
		name            string
		code            int
		tail            string
		cancel, timeout bool
		class           string
		retry, proxy    bool
	}{
		{"success", 0, "proxy error", false, false, "success", false, false},
		{"cancel wins", 0, "", true, true, "cancelled", false, false},
		{"timeout", 0, "connection reset", false, true, "task_timeout", true, true},
		{"unsupported", 64 | 16, "", false, false, "unsupported_url", false, false},
		{"input", 32 | 8, "", false, false, "input_error", false, false},
		{"resource access", 16, "insufficient privileges to access this resource", false, false, "authentication", false, false},
		{"resource access text", 4, "[danbooru][error] AuthorizationError: Insufficient privileges to access this resource", false, false, "authentication", false, false},
		{"auth", 16 | 8, "", false, false, "authentication", false, false},
		{"challenge", 8 | 4, "", false, false, "cloudflare_challenge", true, true},
		{"not found", 4, "404 not found", false, false, "not_found", false, false},
		{"continuation", 4, "as input URL to continue downloading from the current position", false, false, "download_error", true, false},
		{"proxy", 4, "SSLEOFError", false, false, "proxy_failure", true, true},
		{"transient", 4, "429 Too Many Requests", false, false, "site_transient", true, false},
		{"network timeout", 4, "timed out", false, false, "network_timeout", true, false},
		{"download", 128 | 4, "", false, false, "download_error", true, false},
		{"extract", 4, "", false, false, "extraction_error", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := Classify(&tc.code, tc.tail, tc.cancel, tc.timeout)
			if d.ErrorClass != tc.class || d.Retryable != tc.retry || d.ProxyFault != tc.proxy {
				t.Fatal(d)
			}
		})
	}
	if d := Classify(nil, "", false, false); d.ErrorClass != "gallery_error" {
		t.Fatal(d)
	}
	code := 1
	d := Classify(&code, "old line\nAuthorization: Bearer credential-secret", false, false)
	if strings.Contains(d.Message, "credential-secret") {
		t.Fatal(d)
	}
}

func TestTransitionsAndRetryAnchor(t *testing.T) {
	d := Decision{ErrorClass: "network_timeout", Retryable: true}
	if Transition(d, true, 1, 3) != "cancelled" || Transition(d, false, 1, 3) != "requeue" || Transition(d, false, 3, 3) != "failed" {
		t.Fatal("transition mismatch")
	}
	if RetryDelay(2, 4, 3, 300, 0.5) != 2.5 || RetryDelay(2, 12, 0, 300, 0.5) != 300.5 || RetryDelay(0, 10000, 0, 300, 0) != 0 {
		t.Fatal("backoff mismatch")
	}
	d = PartialArtifactFailure(Decision{ErrorClass: "extraction_error"}, 1)
	if d.ErrorClass != "extraction_partial" || !d.Retryable {
		t.Fatal(d)
	}
	original := []string{"a"}
	ids := TriedProxyIDs(original, "b", true)
	if len(original) != 1 || len(ids) != 2 || len(TriedProxyIDs(ids, "b", true)) != 2 {
		t.Fatal(ids)
	}
}

func TestTaskPolicySnapshot(t *testing.T) {
	p, err := ParsePolicy(map[string]any{"eh_download": map[string]any{}, "node_tags": []string{" A ", "a", ""}, "allowed_proxy_ids": []string{" node ", "node"}})
	if err != nil || p.MaxConcurrency != 20 || p.EHDownload.GPPolicy != "stop" || len(p.NodeTags) != 1 || len(p.AllowedProxyIDs) != 1 {
		t.Fatal(p, err)
	}
	for _, value := range []any{
		[]any{}, map[string]any{"unknown": true}, map[string]any{"max_concurrency": nil},
		map[string]any{"retry_limit": true}, map[string]any{"max_concurrency": json.Number("3.0")},
		map[string]any{"backoff_base_seconds": math.NaN()}, map[string]any{"http_timeout": 0},
		map[string]any{"probe_url": "http://example.org"}, map[string]any{"eh_download": map[string]any{"gp_policy": "allow"}},
	} {
		if _, err := ParsePolicy(value); err == nil {
			t.Fatalf("accepted %#v", value)
		}
	}
	p, err = ParsePolicy(map[string]any{"allowed_proxy_ids": []string{}})
	if err != nil || p.AllowedProxyIDs == nil {
		t.Fatal("empty allowlist became unrestricted", err)
	}
}
