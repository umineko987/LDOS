package scheduler

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strings"
)

type EHOptions struct {
	ImageMode string `json:"image_mode"`
	GPPolicy  string `json:"gp_policy"`
}

type Policy struct {
	MaxConcurrency  int        `json:"max_concurrency"`
	RetryLimit      int        `json:"retry_limit"`
	BackoffBase     float64    `json:"backoff_base_seconds"`
	ProxyMode       string     `json:"proxy_mode"`
	ProbeURL        *string    `json:"probe_url"`
	ProbeBeforeUse  bool       `json:"probe_before_use"`
	NodeTags        []string   `json:"node_tags"`
	HTTPTimeout     float64    `json:"http_timeout"`
	GalleryRetries  int        `json:"gallery_retries"`
	TaskTimeout     float64    `json:"task_timeout_seconds"`
	StallTimeout    float64    `json:"download_stall_timeout_seconds"`
	EHDownload      *EHOptions `json:"eh_download"`
	ExtraArgs       []string   `json:"extra_args"`
	ProxyProbeScope *string    `json:"proxy_probe_scope"`
	AllowedProxyIDs []string   `json:"allowed_proxy_ids"`
}

func DefaultPolicy() Policy {
	return Policy{MaxConcurrency: 20, RetryLimit: 2, BackoffBase: 2, ProxyMode: "prefer", ProbeBeforeUse: true, NodeTags: []string{}, HTTPTimeout: 60, GalleryRetries: 2, TaskTimeout: 7200, StallTimeout: 300, ExtraArgs: []string{}}
}

// ParsePolicy reads the persisted snapshot, never mutable current site settings.
func ParsePolicy(value any) (Policy, error) {
	p := DefaultPolicy()
	if value == nil {
		return p, nil
	}
	data, err := json.Marshal(value)
	if err != nil {
		return p, errors.New("invalid task policy")
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(data, &fields); err != nil || fields == nil {
		return p, errors.New("task policy must be an object")
	}
	for name, raw := range fields {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			switch name {
			case "probe_url", "eh_download", "proxy_probe_scope", "allowed_proxy_ids":
			default:
				return p, errors.New("task policy field cannot be null")
			}
		}
	}
	if raw, ok := fields["eh_download"]; ok && string(raw) != "null" {
		p.EHDownload = &EHOptions{ImageMode: "original", GPPolicy: "stop"}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&p); err != nil {
		return p, errors.New("invalid task policy field")
	}
	if p.MaxConcurrency < 1 || p.MaxConcurrency > 128 || p.RetryLimit < 0 || p.RetryLimit > 20 || p.GalleryRetries < 0 || p.GalleryRetries > 50 {
		return p, errors.New("task policy integer out of range")
	}
	for _, bound := range []struct{ v, min, max float64 }{{p.BackoffBase, 0, 3600}, {p.HTTPTimeout, 1, 3600}, {p.TaskTimeout, 0, 604800}, {p.StallTimeout, 0, 604800}} {
		if math.IsNaN(bound.v) || math.IsInf(bound.v, 0) || bound.v < bound.min || bound.v > bound.max {
			return p, errors.New("task policy duration out of range")
		}
	}
	if p.ProxyMode != "direct" && p.ProxyMode != "prefer" && p.ProxyMode != "required" {
		return p, errors.New("invalid task proxy mode")
	}
	if len(p.NodeTags) > 32 || len(p.ExtraArgs) > 128 || len(p.AllowedProxyIDs) > 2048 {
		return p, errors.New("task policy list too long")
	}
	p.NodeTags = normalizeStrings(p.NodeTags, true)
	if p.AllowedProxyIDs != nil {
		p.AllowedProxyIDs = normalizeStrings(p.AllowedProxyIDs, false)
	}
	if p.ProbeURL != nil {
		value := strings.TrimSpace(*p.ProbeURL)
		if value == "" {
			p.ProbeURL = nil
		} else if !strings.HasPrefix(strings.ToLower(value), "https://") {
			return p, errors.New("probe_url must use https")
		} else {
			p.ProbeURL = &value
		}
	}
	if p.ProxyProbeScope != nil && (len(*p.ProxyProbeScope) < 1 || len(*p.ProxyProbeScope) > 128) {
		return p, errors.New("invalid proxy probe scope")
	}
	if p.EHDownload != nil {
		if p.EHDownload.ImageMode != "original" && p.EHDownload.ImageMode != "resample" {
			return p, errors.New("invalid EH image mode")
		}
		if p.EHDownload.GPPolicy != "stop" && p.EHDownload.GPPolicy != "resized" {
			return p, errors.New("invalid EH GP policy")
		}
	}
	return p, nil
}

func normalizeStrings(values []string, lower bool) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if lower {
			value = strings.ToLower(value)
		}
		if value != "" && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}
