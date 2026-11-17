package credentials

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// CookieStatus contains only cookie names/counts, never credential values.
type CookieStatus struct {
	Present         bool     `json:"present"`
	Valid           bool     `json:"valid"`
	Count           int      `json:"cookie_count"`
	RequiredPresent []string `json:"required_present"`
	Missing         []string `json:"missing"`
	UpdatedAt       *float64 `json:"updated_at"`
}

func cookiesValid(ctx context.Context, root *os.File, site string) (bool, error) {
	status, err := inspectCookies(ctx, root, site)
	return status.Valid, err
}

// MozillaCookieJar semantics include ignore_discard/ignore_expires=True and
// replacement of duplicate (domain, path, name) keys.
func inspectCookies(ctx context.Context, root *os.File, site string) (CookieStatus, error) {
	required := []string{"auth_token", "ct0"}
	if site == "exhentai" {
		required = []string{"ipb_member_id", "ipb_pass_hash"}
	}
	status := CookieStatus{RequiredPresent: []string{}, Missing: required}
	f, err := openPrivateFile(root, cookieName(site))
	if err != nil || f == nil {
		return status, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return status, ErrStorage
	}
	updated := float64(info.ModTime().UnixNano()) / 1e9
	status.Present, status.UpdatedAt = true, &updated
	limited := &io.LimitedReader{R: f, N: maxCookieBytes + 1}
	scanner := bufio.NewScanner(limited)
	scanner.Buffer(make([]byte, 4096), maxCookieLine+2)
	scanner.Split(universalLine)
	if !scanner.Scan() || !utf8.Valid(scanner.Bytes()) || len(scanner.Bytes()) > maxCookieLine || !mozillaHeader(scanner.Text()) {
		return status, ctx.Err()
	}
	names := map[string]bool{}
	keys := map[[3]string]bool{}
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return status, err
		}
		if !utf8.Valid(scanner.Bytes()) || len(scanner.Bytes()) > maxCookieLine {
			return status, nil
		}
		line := strings.TrimPrefix(scanner.Text(), "#HttpOnly_")
		trimmed := strings.TrimFunc(line, pythonSpace)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "$") {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) != 7 || (fields[1] == "TRUE") != strings.HasPrefix(fields[0], ".") {
			return status, nil
		}
		if fields[4] != "" && fields[4] != "0" && !mozillaExpiry(fields[4]) {
			return status, nil
		}
		name := fields[5]
		if name == "" {
			name = fields[6]
		}
		keys[[3]string{fields[0], fields[2], name}] = true
		names[name] = true
	}
	if err := ctx.Err(); err != nil {
		return status, err
	}
	if scanner.Err() != nil || limited.N == 0 {
		return status, nil
	}
	status.Count, status.Missing = len(keys), []string{}
	for _, name := range required {
		if names[name] {
			status.RequiredPresent = append(status.RequiredPresent, name)
		} else {
			status.Missing = append(status.Missing, name)
		}
	}
	status.Valid = len(status.Missing) == 0
	return status, nil
}

// Python text mode uses universal newlines (LF, CRLF, and bare CR).
func universalLine(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		if data[i] == '\r' {
			if i+1 == len(data) && !atEOF {
				return 0, nil, nil
			}
			if i+1 < len(data) && data[i+1] == '\n' {
				return i + 2, data[:i], nil
			}
		}
		return i + 1, data[:i], nil
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

func pythonSpace(r rune) bool {
	return unicode.IsSpace(r) || r >= '\x1c' && r <= '\x1f'
}

func mozillaHeader(line string) bool {
	// CPython's regex is ASCII case insensitive, prefix-matched, not anchored
	// at the end: '#( Netscape)? HTTP Cookie File'. No BOM/leading whitespace.
	for _, prefix := range []string{"# netscape http cookie file", "# http cookie file"} {
		if len(line) < len(prefix) {
			continue
		}
		match := true
		for i := range len(prefix) {
			b := line[i]
			if b >= 'A' && b <= 'Z' {
				b += 'a' - 'A'
			}
			if b != prefix[i] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

var decimalFloat = regexp.MustCompile(`^[+-]?(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$`)

func mozillaExpiry(value string) bool {
	// Cookie.__init__ calls int(float(expires)); finite negative/fractional and
	// scientific values are accepted, NaN/Inf and Go-only hexadecimal are not.
	// Python float also accepts Unicode decimal digits and numeric underscores.
	value = strings.TrimFunc(value, unicode.IsSpace)
	var normalized strings.Builder
	for _, r := range value {
		if r > 127 {
			var ok bool
			r, ok = decimalDigit(r)
			if !ok {
				return false
			}
		}
		normalized.WriteRune(r)
	}
	value = normalized.String()
	if !decimalFloat.MatchString(value) {
		return false
	}
	f, _ := strconv.ParseFloat(strings.ReplaceAll(value, "_", ""), 64)
	return !math.IsInf(f, 0) && !math.IsNaN(f)
}

func decimalDigit(r rune) (rune, bool) {
	for _, interval := range unicode.Digit.R16 {
		if r >= rune(interval.Lo) && r <= rune(interval.Hi) && (r-rune(interval.Lo))%rune(interval.Stride) == 0 {
			return '0' + (r-rune(interval.Lo))/rune(interval.Stride)%10, true
		}
	}
	for _, interval := range unicode.Digit.R32 {
		if r >= rune(interval.Lo) && r <= rune(interval.Hi) && (r-rune(interval.Lo))%rune(interval.Stride) == 0 {
			return '0' + (r-rune(interval.Lo))/rune(interval.Stride)%10, true
		}
	}
	return 0, false
}
