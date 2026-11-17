package captions

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
)

type Op struct {
	Op       string   `json:"op"`
	Tags     []string `json:"tags,omitempty"`
	Position string   `json:"position,omitempty"`
	From     string   `json:"from,omitempty"`
	To       string   `json:"to,omitempty"`
	Into     string   `json:"into,omitempty"`
}

// UnmarshalJSON enforces the discriminated operation contracts at the HTTP boundary.
func (o *Op) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	var kind string
	if err := json.Unmarshal(raw["op"], &kind); err != nil {
		return err
	}
	allowed := map[string]bool{"op": true}
	switch kind {
	case "add":
		allowed["tags"] = true
		allowed["position"] = true
	case "remove", "pin":
		allowed["tags"] = true
	case "replace":
		allowed["from"] = true
		allowed["from_"] = true
		allowed["to"] = true
	case "merge":
		allowed["tags"] = true
		allowed["into"] = true
	default:
		return fmt.Errorf("unknown caption operation %q", kind)
	}
	for field, value := range raw {
		if !allowed[field] {
			return fmt.Errorf("unexpected field %q for %s", field, kind)
		}
		if string(value) == "null" {
			return fmt.Errorf("%s cannot be null", field)
		}
	}
	if alias, ok := raw["from_"]; ok {
		if _, exists := raw["from"]; exists {
			return fmt.Errorf("duplicate from field")
		}
		raw["from"] = alias
		delete(raw, "from_")
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	type plain Op
	return json.Unmarshal(encoded, (*plain)(o))
}
func Dedupe(tags []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, t := range tags {
		if t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}
func Parse(text string) []string { return splitCaption(text) }

// splitCaption preserves exact case and escaping; only separator-adjacent whitespace is stripped.
func splitCaption(text string) []string {
	out := []string{}
	for _, t := range strings.FieldsFunc(text, func(r rune) bool { return r == ',' || r == '\r' || r == '\n' }) {
		out = append(out, strings.TrimSpace(t))
	}
	return Dedupe(out)
}
func Format(tags []string) string { return strings.Join(tags, ", ") }
func clean(tags []string) []string {
	out := []string{}
	for _, t := range tags {
		out = append(out, strings.TrimSpace(t))
	}
	return Dedupe(out)
}
func PinTrigger(tags []string, trigger string) []string {
	trigger = strings.TrimSpace(trigger)
	if trigger == "" {
		return Dedupe(tags)
	}
	return Dedupe(append([]string{trigger}, tags...))
}
func ApplyOps(tags []string, ops []Op, trigger string) []string {
	out := slices.Clone(tags)
	for _, op := range ops {
		switch op.Op {
		case "add":
			adds := []string{}
			for _, t := range clean(op.Tags) {
				if !slices.Contains(out, t) {
					adds = append(adds, t)
				}
			}
			if op.Position == "front" {
				out = append(adds, out...)
			} else {
				out = append(out, adds...)
			}
		case "remove":
			rm := clean(op.Tags)
			out = slices.DeleteFunc(out, func(t string) bool { return slices.Contains(rm, t) })
		case "replace":
			from, to := strings.TrimSpace(op.From), strings.TrimSpace(op.To)
			if from != to {
				if slices.Contains(out, to) {
					out = slices.DeleteFunc(out, func(t string) bool { return t == from })
				} else {
					for i, t := range out {
						if t == from {
							out[i] = to
						}
					}
				}
			}
		case "merge":
			sources := clean(op.Tags)
			target := strings.TrimSpace(op.Into)
			has := false
			for _, t := range out {
				has = has || slices.Contains(sources, t)
			}
			if has {
				merged := []string{}
				placed := false
				for _, t := range out {
					if t == target || slices.Contains(sources, t) {
						if !placed {
							merged = append(merged, target)
							placed = true
						}
					} else {
						merged = append(merged, t)
					}
				}
				out = merged
			}
		case "pin":
			pinned := []string{}
			for _, t := range clean(op.Tags) {
				if slices.Contains(out, t) {
					pinned = append(pinned, t)
				}
			}
			out = Dedupe(append(pinned, out...))
		}
	}
	if slices.Contains(out, strings.TrimSpace(trigger)) {
		out = PinTrigger(out, trigger)
	}
	return Dedupe(out)
}
func MergeTagger(current, fresh, previous []string, mode, trigger string) []string {
	if mode == "overwrite" || (mode == "fill_empty" && len(current) == 0) {
		return PinTrigger(fresh, trigger)
	}
	if mode == "fill_empty" {
		return slices.Clone(current)
	}
	out := []string{}
	for _, t := range current {
		if !slices.Contains(previous, t) {
			out = append(out, t)
		}
	}
	for _, t := range fresh {
		if !slices.Contains(previous, t) || slices.Contains(current, t) {
			out = append(out, t)
		}
	}
	return PinTrigger(out, trigger)
}
func validateTag(t string) bool {
	return strings.TrimSpace(t) != "" && utf8.RuneCountInString(t) <= 512 && !strings.ContainsAny(t, ",\r\n")
}
func ValidateOps(ops []Op) error {
	if len(ops) < 1 || len(ops) > 50 {
		return Fail(422, "validation_error", "需要 1 到 50 个操作")
	}
	for _, op := range ops {
		switch op.Op {
		case "add", "remove", "pin", "merge":
			if len(op.Tags) < 1 || len(op.Tags) > 200 {
				return Fail(422, "validation_error", "标签数量无效")
			}
			for _, t := range op.Tags {
				if !validateTag(t) {
					return Fail(422, "validation_error", "标签无效")
				}
			}
			if op.Op == "merge" && !validateTag(op.Into) {
				return Fail(422, "validation_error", "目标标签无效")
			}
			if op.Op == "add" && op.Position != "" && op.Position != "front" && op.Position != "back" {
				return Fail(422, "validation_error", "插入位置无效")
			}
		case "replace":
			if !validateTag(op.From) || !validateTag(op.To) {
				return Fail(422, "validation_error", "替换标签无效")
			}
		default:
			return Fail(422, "validation_error", "未知 caption 操作")
		}
	}
	return nil
}
func ValidateIDs(ids []string, min, max int) error {
	if len(ids) < min || len(ids) > max {
		return Fail(422, "validation_error", "图片数量无效")
	}
	for _, id := range ids {
		if len(id) == 0 || utf8.RuneCountInString(id) > 128 {
			return Fail(422, "validation_error", "图片 ID 无效")
		}
	}
	return nil
}
