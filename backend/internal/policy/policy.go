// Package policy implements the site-policy API without a Python API dependency.
package policy

import (
	"encoding/json"
	"math"
	"sort"
)

const maxRequestBytes = 16 * 1024

var policyFields = [...]string{"max_concurrency", "retry_limit", "backoff_base_seconds", "proxy_mode"}

var sites = [...]struct {
	id, label, authorization string
}{
	{"danbooru", "Danbooru", "anonymous"},
	{"twitter", "X / Twitter", "managed_browser"},
	{"pixiv", "Pixiv", "oauth"},
	{"exhentai", "EH", "managed_browser_for_private_content"},
	{"pawchive", "Pawchive", "anonymous"},
}

func defaults() map[string]any {
	return map[string]any{
		"max_concurrency": 20, "retry_limit": 2,
		"backoff_base_seconds": float64(2), "proxy_mode": "prefer",
	}
}

func supportedSite(site string) bool {
	for _, definition := range sites {
		if definition.id == site {
			return true
		}
	}
	return false
}

// Validation details contain only controlled names, never submitted values or keys.
type validationDetail struct {
	Field  string `json:"field"`
	Reason string `json:"reason"`
}

// HTTP decoding preserves JSON number tokens, so 3.0 and 3e0 are not integers.
// Existing Go config/repository JSON decoding uses float64; integral floats are
// accepted only at those internal boundaries. UseNumber repositories retain the
// stronger distinction for stored values as well.
func normalizePolicy(value any, decodedFloats bool) (map[string]any, []validationDetail) {
	raw, ok := value.(map[string]any)
	if !ok || raw == nil {
		return nil, []validationDetail{{"policy", "model_attributes_type"}}
	}
	result := defaults()
	var issues []validationDetail
	for _, field := range policyFields {
		value, exists := raw[field]
		if !exists {
			continue
		}
		var reason string
		switch field {
		case "max_concurrency", "retry_limit":
			minimum, maximum := 1.0, 128.0
			if field == "retry_limit" {
				minimum, maximum = 0, 20
			}
			number, valid := integerValue(value, decodedFloats)
			switch {
			case !valid:
				reason = "int_type"
			case number < minimum:
				reason = "greater_than_equal"
			case number > maximum:
				reason = "less_than_equal"
			default:
				result[field] = int(number)
			}
		case "backoff_base_seconds":
			number, valid := numericValue(value)
			switch {
			case !valid:
				reason = "float_type"
			case math.IsNaN(number) || math.IsInf(number, 0):
				reason = "finite_number"
			case number < 0:
				reason = "greater_than_equal"
			case number > 3600:
				reason = "less_than_equal"
			default:
				result[field] = number
			}
		case "proxy_mode":
			mode, valid := value.(string)
			if !valid || (mode != "direct" && mode != "prefer" && mode != "required") {
				reason = "literal_error"
			} else {
				result[field] = mode
			}
		}
		if reason != "" {
			issues = append(issues, validationDetail{field, reason})
		}
	}
	// Unknown fields invalidate the entire policy, including defaults and records.
	// Do not drop them and then claim a corrupted policy is editable.
	unknown := make([]string, 0)
	for field := range raw {
		switch field {
		case "max_concurrency", "retry_limit", "backoff_base_seconds", "proxy_mode":
		default:
			unknown = append(unknown, field)
		}
	}
	sort.Strings(unknown)
	for range unknown {
		issues = append(issues, validationDetail{"policy", "extra_forbidden"})
	}
	if len(issues) != 0 {
		return nil, issues
	}
	return result, nil
}

func integerValue(value any, decodedFloats bool) (float64, bool) {
	switch number := value.(type) {
	case json.Number:
		integer, err := number.Int64()
		return float64(integer), err == nil
	case float64, float32:
		if !decodedFloats {
			return 0, false
		}
	}
	number, ok := numericValue(value)
	return number, ok && !math.IsNaN(number) && !math.IsInf(number, 0) && math.Trunc(number) == number
}

func numericValue(value any) (float64, bool) {
	switch number := value.(type) {
	case json.Number:
		n, err := number.Float64()
		return n, err == nil || math.IsInf(n, 0)
	case float64:
		return number, true
	case float32:
		return float64(number), true
	case int:
		return float64(number), true
	case int8:
		return float64(number), true
	case int16:
		return float64(number), true
	case int32:
		return float64(number), true
	case int64:
		return float64(number), true
	case uint:
		return float64(number), true
	case uint8:
		return float64(number), true
	case uint16:
		return float64(number), true
	case uint32:
		return float64(number), true
	case uint64:
		return float64(number), true
	default:
		return 0, false
	}
}

func safeTimestamp(value any) any {
	number, valid := numericValue(value)
	if !valid || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > 4_102_444_800 {
		return nil
	}
	return number
}

func policyState(policy map[string]any, inherited bool) map[string]any {
	reason := ""
	if policy == nil {
		reason = "unsafe_stored_policy"
		if inherited {
			reason = "unsafe_default_policy"
		}
	}
	return map[string]any{"editable": policy != nil, "reason": reason, "policy": policy}
}

func viewItem(site string, policy map[string]any, inherited bool, updatedAt any) map[string]any {
	item := policyState(policy, inherited)
	for _, definition := range sites {
		if definition.id == site {
			item["site"] = site
			item["label"] = definition.label
			item["authorization"] = definition.authorization
			break
		}
	}
	item["supported"] = true
	item["selection_mode"] = "per_request"
	item["availability"] = "not_probed"
	item["inherited"] = inherited
	item["has_override"] = !inherited
	item["updated_at"] = nil
	if !inherited {
		item["updated_at"] = safeTimestamp(updatedAt)
	}
	return item
}
