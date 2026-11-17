package discoverydata

import (
	"encoding/json"
	"fmt"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"math"
	"math/big"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

type object = map[string]any

func obj(v any) object { m, _ := v.(map[string]any); return m }
func sequence(v any) []any {
	switch x := v.(type) {
	case []any:
		return x
	case []string:
		r := make([]any, len(x))
		for i, s := range x {
			r[i] = s
		}
		return r
	case []map[string]any:
		r := make([]any, len(x))
		for i, s := range x {
			r[i] = s
		}
		return r
	}
	return nil
}
func objects(v any) []object {
	r := []object{}
	for _, x := range sequence(v) {
		if m := obj(x); m != nil {
			r = append(r, m)
		}
	}
	return r
}
func truth(v any) bool {
	if v == nil {
		return false
	}
	switch x := v.(type) {
	case string:
		return x != ""
	case bool:
		return x
	case json.Number:
		f, _ := x.Float64()
		return f != 0
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Map, reflect.Slice, reflect.Array:
		return rv.Len() > 0
	case reflect.Int, reflect.Int64, reflect.Int32:
		return rv.Int() != 0
	case reflect.Float32, reflect.Float64:
		return rv.Float() != 0
	}
	return true
}
func first(values ...any) any {
	for _, v := range values {
		if truth(v) {
			return v
		}
	}
	if len(values) > 0 {
		return values[len(values)-1]
	}
	return nil
}
func str(v any) string {
	if v == nil {
		return "None"
	}
	switch x := v.(type) {
	case string:
		return x
	case bool:
		if x {
			return "True"
		}
		return "False"
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(x))
		for _, k := range keys {
			parts = append(parts, repr(k)+": "+repr(x[k]))
		}
		return "{" + strings.Join(parts, ", ") + "}"
	case []any:
		parts := make([]string, len(x))
		for i, v := range x {
			parts[i] = repr(v)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	default:
		return fmt.Sprint(v)
	}
}
func repr(v any) string {
	s, ok := v.(string)
	if !ok {
		return str(v)
	}
	quote := "'"
	if strings.Contains(s, "'") && !strings.Contains(s, `"`) {
		quote = `"`
	}
	s = strings.NewReplacer("\\", "\\\\", "\n", "\\n", "\r", "\\r", "\t", "\\t").Replace(s)
	return quote + strings.ReplaceAll(s, quote, "\\"+quote) + quote
}
func stringOr(v any) string { return str(first(v, "")) }
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
func text(v any, n int) any {
	if v == nil {
		return nil
	}
	s := strings.TrimSpace(str(v))
	if s == "" {
		return nil
	}
	return truncate(s, n)
}
func integer(v any) any {
	if v == nil {
		return nil
	}
	switch x := v.(type) {
	case bool:
		if x {
			return json.Number("1")
		}
		return json.Number("0")
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return nil
		}
		return json.Number(new(big.Float).SetFloat64(math.Trunc(x)).Text('f', 0))
	case json.Number:
		if strings.ContainsAny(string(x), ".eE") {
			f, err := x.Float64()
			if err != nil {
				return nil
			}
			return integer(f)
		}
	}
	s := strings.TrimSpace(str(v))
	// Python int accepts decimal Unicode digits and underscores only between
	// digits. Preserve that behavior without rounding large gallery IDs.
	s = strings.Map(func(r rune) rune {
		if r <= 127 {
			return r
		}
		for _, span := range unicode.Digit.R16 {
			if uint32(r) >= uint32(span.Lo) && uint32(r) <= uint32(span.Hi) && (uint32(r)-uint32(span.Lo))%uint32(span.Stride) == 0 {
				return '0' + rune((uint32(r)-uint32(span.Lo))/uint32(span.Stride)%10)
			}
		}
		for _, span := range unicode.Digit.R32 {
			if uint32(r) >= span.Lo && uint32(r) <= span.Hi && (uint32(r)-span.Lo)%span.Stride == 0 {
				return '0' + rune((uint32(r)-span.Lo)/span.Stride%10)
			}
		}
		return r
	}, s)
	for i, r := range s {
		if r == '_' && (i == 0 || i+1 == len(s) || s[i-1] < '0' || s[i-1] > '9' || s[i+1] < '0' || s[i+1] > '9') {
			return nil
		}
	}
	s = strings.ReplaceAll(s, "_", "")
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return nil
	}
	return json.Number(n.String())
}
func intValue(v any) int {
	i := integer(v)
	if i == nil {
		return 0
	}
	n, _ := strconv.Atoi(str(i))
	return n
}
func list(v any, n int) []string {
	var values []any
	if s, ok := v.(string); ok {
		values = sequence(strings.Fields(s))
	} else {
		values = sequence(v)
	}
	r := []string{}
	for _, v := range values {
		s := str(v)
		if strings.TrimSpace(s) != "" {
			r = append(r, truncate(s, 200))
			if len(r) >= n {
				break
			}
		}
	}
	return r
}
func stringsOf(v any) []string {
	r := []string{}
	for _, v := range sequence(v) {
		r = append(r, str(v))
	}
	return r
}
func lower(s string) string { return cases.Lower(language.Und).String(s) }
func tagKey(v any) string {
	s := lower(strings.TrimSpace(str(v)))
	var b strings.Builder
	sep := false
	for _, r := range s {
		if unicode.IsSpace(r) || r == '_' || r == '-' {
			sep = true
			continue
		}
		if sep && b.Len() > 0 {
			b.WriteByte('_')
		}
		sep = false
		b.WriteRune(r)
	}
	return b.String()
}
func identity(v any) string { return tagKey(strings.TrimLeft(strings.TrimSpace(stringOr(v)), "@")) }
func contains(a []string, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}
func clone(m object) object {
	r := object{}
	for k, v := range m {
		r[k] = v
	}
	return r
}
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
