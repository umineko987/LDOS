package discoverydata

import "strings"

// jsonErrorOffset reports the start of an invalid value (as Python's decoder
// does), rather than the later byte where encoding/json rejects a literal.
// It is used only for diagnostics after the standard decoder rejects input.
func jsonErrorOffset(s string) int {
	p := jsonPosition{s: s}
	if !p.value() {
		return p.failure
	}
	p.space()
	return p.i
}

type jsonPosition struct {
	s          string
	i, failure int
}

func (p *jsonPosition) fail(at int) bool { p.failure = at; return false }
func (p *jsonPosition) space() {
	for p.i < len(p.s) && strings.ContainsRune(" \t\r\n", rune(p.s[p.i])) {
		p.i++
	}
}
func (p *jsonPosition) quoted() bool {
	start := p.i
	p.i++
	for p.i < len(p.s) {
		c := p.s[p.i]
		if c == '"' {
			p.i++
			return true
		}
		if c < 32 {
			return p.fail(p.i)
		}
		if c == '\\' {
			slash := p.i
			p.i++
			if p.i >= len(p.s) {
				return p.fail(start)
			}
			c = p.s[p.i]
			if c == 'u' {
				u := p.i
				for j := 0; j < 4; j++ {
					p.i++
					if p.i >= len(p.s) || !strings.ContainsRune("0123456789abcdefABCDEF", rune(p.s[p.i])) {
						return p.fail(u)
					}
				}
			} else if !strings.ContainsRune(`"\/bfnrt`, rune(c)) {
				return p.fail(slash)
			}
		}
		p.i++
	}
	return p.fail(start)
}
func (p *jsonPosition) value() bool {
	p.space()
	start := p.i
	if p.i >= len(p.s) {
		return p.fail(p.i)
	}
	switch p.s[p.i] {
	case '"':
		return p.quoted()
	case '[', '{':
		object := p.s[p.i] == '{'
		close := byte(']')
		if object {
			close = '}'
		}
		p.i++
		p.space()
		if p.i < len(p.s) && p.s[p.i] == close {
			p.i++
			return true
		}
		for {
			p.space()
			if object {
				if p.i >= len(p.s) || p.s[p.i] != '"' {
					return p.fail(p.i)
				}
				if !p.quoted() {
					return false
				}
				p.space()
				if p.i >= len(p.s) || p.s[p.i] != ':' {
					return p.fail(p.i)
				}
				p.i++
			}
			if !p.value() {
				return false
			}
			p.space()
			if p.i >= len(p.s) {
				return p.fail(p.i)
			}
			if p.s[p.i] == close {
				p.i++
				return true
			}
			if p.s[p.i] != ',' {
				return p.fail(p.i)
			}
			comma := p.i
			p.i++
			p.space()
			if p.i < len(p.s) && p.s[p.i] == close {
				return p.fail(comma)
			}
		}
	}
	for _, literal := range []string{"true", "false", "null"} {
		if strings.HasPrefix(p.s[p.i:], literal) {
			p.i += len(literal)
			return true
		}
	}
	if p.s[p.i] == '-' {
		p.i++
	}
	if p.i >= len(p.s) || p.s[p.i] < '0' || p.s[p.i] > '9' {
		return p.fail(start)
	}
	if p.s[p.i] == '0' {
		p.i++
	} else {
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
		}
	}
	if p.i+1 < len(p.s) && p.s[p.i] == '.' && p.s[p.i+1] >= '0' && p.s[p.i+1] <= '9' {
		p.i += 2
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		end := p.i + 1
		if end < len(p.s) && (p.s[end] == '+' || p.s[end] == '-') {
			end++
		}
		digits := end
		for end < len(p.s) && p.s[end] >= '0' && p.s[end] <= '9' {
			end++
		}
		if end > digits {
			p.i = end
		}
	}
	return true
}
