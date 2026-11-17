package proxytransport

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Endpoint IDs are an existing external identity: SHA256(PyYAML safe_dump(...))[:20].
// yaml.v3's formatting is different (indentation, YAML 1.1 string resolution and
// quoting), so identity serialization deliberately follows PyYAML's block emitter.
// This serializer accepts the string-keyed maps and scalar/list values used by
// CoreConfig, and rejects unsupported values instead of silently changing IDs.
func pythonYAML(value map[string]any) (string, error) {
	e := yamlIdentityEmitter{anchors: yamlAnchors(value), emitted: make(map[collectionReference]bool), whitespace: true, indention: true}
	if err := e.node(value, -1, false); err != nil {
		return "", err
	}
	e.indent(0)
	return e.output.String(), nil
}

// PyYAML assigns anchor numbers on the second visit, in sorted-map depth-first
// order. First-visit numbering would change IDs when nested objects repeat first.
func yamlAnchors(value any) map[collectionReference]string {
	seen := make(map[collectionReference]bool)
	anchors := make(map[collectionReference]string)
	var visit func(any)
	visit = func(value any) {
		if reference, identifiable := configReference(value); identifiable {
			if seen[reference] {
				if anchors[reference] == "" {
					anchors[reference] = fmt.Sprintf("id%03d", len(anchors)+1)
				}
				return
			}
			seen[reference] = true
		}
		switch x := value.(type) {
		case map[string]any:
			for _, key := range sortedKeys(x) {
				visit(x[key])
			}
		case []any:
			for _, item := range x {
				visit(item)
			}
		}
	}
	visit(value)
	return anchors
}

type yamlIdentityEmitter struct {
	output                strings.Builder
	anchors               map[collectionReference]string
	emitted               map[collectionReference]bool
	column                int
	whitespace, indention bool
}

func (e *yamlIdentityEmitter) write(text string) {
	e.output.WriteString(text)
	for _, r := range text {
		if yamlBreak(r) {
			e.column = 0
		} else {
			e.column++
		}
	}
}

func (e *yamlIdentityEmitter) indicator(text string, needWhitespace, indention bool) {
	if needWhitespace && !e.whitespace {
		e.write(" ")
	}
	e.write(text)
	e.whitespace = false
	e.indention = e.indention && indention
}

func (e *yamlIdentityEmitter) indent(indent int) {
	if !e.indention || e.column > indent || e.column == indent && !e.whitespace {
		e.write("\n")
		e.whitespace, e.indention = true, true
	}
	if e.column < indent {
		e.write(strings.Repeat(" ", indent-e.column))
		e.whitespace = true
	}
}

func (e *yamlIdentityEmitter) scalar(value any, indent int, simpleKey bool) error {
	if !e.whitespace {
		e.write(" ")
	}
	text, err := yamlScalar(value, e.column, indent, simpleKey)
	if err != nil {
		return err
	}
	e.write(text)
	e.whitespace, e.indention = false, false
	return nil
}

func (e *yamlIdentityEmitter) node(value any, parentIndent int, mapping bool) error {
	if reference, identifiable := configReference(value); identifiable {
		if anchor := e.anchors[reference]; anchor != "" {
			if e.emitted[reference] {
				e.indicator("*"+anchor, true, false)
				return nil
			}
			e.emitted[reference] = true
			e.indicator("&"+anchor, true, false)
		}
	}
	indent := parentIndent + 2
	if parentIndent < 0 {
		indent = 0
	}
	switch x := value.(type) {
	case map[string]any:
		if len(x) > 0 {
			for _, key := range sortedKeys(x) {
				e.indent(indent)
				// check_simple_key includes the five characters in PyYAML's !!str tag.
				simple := key != "" && utf8.RuneCountInString(key)+5 < 128 && !strings.ContainsAny(key, "\n\u0085\u2028\u2029")
				if simple {
					if err := e.scalar(key, indent+2, true); err != nil {
						return err
					}
					e.indicator(":", false, false)
				} else {
					e.indicator("?", true, true)
					if err := e.scalar(key, indent+2, false); err != nil {
						return err
					}
					e.indent(indent)
					e.indicator(":", true, true)
				}
				if err := e.node(x[key], indent, true); err != nil {
					return err
				}
			}
			return nil
		}
	case []any:
		if len(x) > 0 {
			if mapping && !e.indention && parentIndent >= 0 {
				indent = parentIndent
			}
			for _, item := range x {
				e.indent(indent)
				e.indicator("-", true, true)
				if err := e.node(item, indent, false); err != nil {
					return err
				}
			}
			return nil
		}
	case []string:
		if len(x) > 0 {
			if mapping && !e.indention && parentIndent >= 0 {
				indent = parentIndent
			}
			for _, item := range x {
				e.indent(indent)
				e.indicator("-", true, true)
				if err := e.scalar(item, indent+2, false); err != nil {
					return err
				}
			}
			return nil
		}
	}
	if parentIndent < 0 {
		indent = 2
	}
	return e.scalar(value, indent, false)
}

var pythonImplicit = regexp.MustCompile(`^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|~|null|Null|NULL|<<|=|[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+|[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)$`)

func yamlScalar(v any, column, indent int, key bool) (string, error) {
	switch x := v.(type) {
	case nil:
		return "null", nil
	case bool:
		return strconv.FormatBool(x), nil
	case int:
		return strconv.Itoa(x), nil
	case int64:
		return strconv.FormatInt(x, 10), nil
	case uint64:
		return strconv.FormatUint(x, 10), nil
	case float64:
		return pythonFloat(x), nil
	case json.Number:
		if strings.ContainsAny(string(x), ".eE") {
			f, err := x.Float64()
			return pythonFloat(f), err
		}
		if x == "-0" {
			return "0", nil
		}
		return string(x), nil
	case map[string]any:
		if len(x) == 0 {
			return "{}", nil
		}
	case []any:
		if len(x) == 0 {
			return "[]", nil
		}
	case []string:
		if len(x) == 0 {
			return "[]", nil
		}
	case string:
		style := yamlStringStyle(x)
		if style == '"' {
			return yamlDoubleQuoted(x, column, indent, !key), nil
		}
		return yamlPlainOrSingle(x, column, indent, !key, style == '\''), nil
	}
	return "", fmt.Errorf("unsupported YAML identity scalar %T", v)
}

func pythonFloat(f float64) string {
	if math.IsNaN(f) {
		return ".nan"
	}
	if math.IsInf(f, 1) {
		return ".inf"
	}
	if math.IsInf(f, -1) {
		return "-.inf"
	}
	format := byte('f')
	if f != 0 && (math.Abs(f) < 1e-4 || math.Abs(f) >= 1e16) {
		format = 'e'
	}
	s := strconv.FormatFloat(f, format, -1, 64)
	if !strings.Contains(s, ".") {
		if i := strings.IndexByte(s, 'e'); i >= 0 {
			s = s[:i] + ".0" + s[i:]
		} else {
			s += ".0"
		}
	}
	return s
}

func yamlBreak(r rune) bool      { return strings.ContainsRune("\n\u0085\u2028\u2029", r) }
func yamlWhitespace(r rune) bool { return strings.ContainsRune("\x00 \t\r\n\u0085\u2028\u2029", r) }
func yamlStringStyle(s string) byte {
	if s == "" {
		return '\''
	}
	runes := []rune(s)
	plain := !pythonImplicit.MatchString(s) && !strings.HasPrefix(s, "---") && !strings.HasPrefix(s, "...")
	single := true
	for i, r := range runes {
		before := i == 0 || yamlWhitespace(runes[i-1])
		after := i == len(runes)-1 || yamlWhitespace(runes[i+1])
		if i == 0 && (strings.ContainsRune("#,[]{}&*!|>'\"%@`", r) || strings.ContainsRune("?:-", r) && after) {
			plain = false
		}
		if r == ':' && after || r == '#' && before {
			plain = false
		}
		if (r == ' ' || yamlBreak(r)) && (i == 0 || i == len(runes)-1) {
			plain = false
		}
		if yamlBreak(r) {
			plain = false
			if i > 0 && runes[i-1] == ' ' {
				single = false
			}
		}
		if r == ' ' && i > 0 && yamlBreak(runes[i-1]) {
			single = false
		}
		if !(r == '\n' || r >= 0x20 && r <= 0x7e || r == 0x85 || r >= 0xa0 && r <= 0xd7ff || r >= 0xe000 && r <= 0xfffd || r >= 0x10000 && r < 0x10ffff) || r == 0xfeff {
			single = false
		}
	}
	if !single {
		return '"'
	}
	if !plain {
		return '\''
	}
	return 0
}

func yamlPlainOrSingle(s string, column, indent int, split, single bool) string {
	var out strings.Builder
	r := []rune(s)
	if single {
		out.WriteByte('\'')
		column++
	}
	for i := 0; i < len(r); {
		if r[i] == ' ' {
			end := i + 1
			for end < len(r) && r[end] == ' ' {
				end++
			}
			if end == i+1 && column > 80 && split && (!single || i != 0 && end != len(r)) {
				out.WriteString("\n" + strings.Repeat(" ", indent))
				column = indent
			} else {
				out.WriteString(string(r[i:end]))
				column += end - i
			}
			i = end
		} else if yamlBreak(r[i]) {
			if r[i] == '\n' {
				out.WriteByte('\n')
			}
			for i < len(r) && yamlBreak(r[i]) {
				out.WriteRune(r[i])
				i++
			}
			out.WriteString(strings.Repeat(" ", indent))
			column = indent
		} else {
			if single && r[i] == '\'' {
				out.WriteByte('\'')
				column++
			}
			out.WriteRune(r[i])
			column++
			i++
		}
	}
	if single {
		out.WriteByte('\'')
	}
	return out.String()
}

func yamlDoubleQuoted(s string, column, indent int, split bool) string {
	escapes := map[rune]string{0: "0", 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r", 27: "e", '"': "\"", '\\': "\\", 0x85: "N", 0xa0: "_", 0x2028: "L", 0x2029: "P"}
	var out strings.Builder
	out.WriteByte('"')
	column++
	r := []rune(s)
	start := 0
	for end := 0; end <= len(r); end++ {
		ch := rune(-1)
		if end < len(r) {
			ch = r[end]
		}
		special := ch == -1 || strings.ContainsRune("\"\\\u0085\u2028\u2029\ufeff", ch) || !(ch >= 0x20 && ch <= 0x7e || ch >= 0xa0 && ch <= 0xd7ff || ch >= 0xe000 && ch <= 0xfffd)
		if special {
			if start < end {
				out.WriteString(string(r[start:end]))
				column += end - start
				start = end
			}
			if ch != -1 {
				var escaped string
				if replacement, ok := escapes[ch]; ok {
					escaped = "\\" + replacement
				} else if ch <= 0xff {
					escaped = fmt.Sprintf("\\x%02X", ch)
				} else if ch <= 0xffff {
					escaped = fmt.Sprintf("\\u%04X", ch)
				} else {
					escaped = fmt.Sprintf("\\U%08X", ch)
				}
				out.WriteString(escaped)
				column += len(escaped)
				start = end + 1
			}
		}
		if end > 0 && end < len(r)-1 && (ch == ' ' || start >= end) && column+end-start > 80 && split {
			if start < end {
				out.WriteString(string(r[start:end]))
				start = end
			}
			out.WriteString("\\\n" + strings.Repeat(" ", indent))
			column = indent
			if r[start] == ' ' {
				out.WriteByte('\\')
				column++
			}
		}
	}
	out.WriteByte('"')
	return out.String()
}
