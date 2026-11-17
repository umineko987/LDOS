package credentials

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const cookieHeader = "# Netscape HTTP Cookie File\n"

func cookieRow(name string) string {
	return ".example.test\tTRUE\t/\tFALSE\t1\t" + name + "\tfake-value\n"
}

func twitterCookies() string { return cookieHeader + cookieRow("auth_token") + cookieRow("ct0") }
func ehCookies() string {
	return cookieHeader + cookieRow("ipb_member_id") + cookieRow("ipb_pass_hash")
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(filepath.Join(t.TempDir(), "managed"))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func putFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestMozillaCookies(t *testing.T) {
	// These fixtures follow http.cookiejar.MozillaCookieJar._really_load and
	// Cookie.__init__; no Python executable or live credentials are needed.
	tests := []struct {
		name, contents string
		valid          bool
	}{
		{"expired allowed and unrelated domain", twitterCookies(), true},
		{"HttpOnly blanks comments", cookieHeader + "\n\t \n # comment\n$ comment\n" + "#HttpOnly_" + cookieRow("auth_token") + cookieRow("ct0"), true},
		{"duplicate cookies", twitterCookies() + cookieRow("auth_token") + cookieRow("ct0"), true},
		{"header alternate case suffix", strings.Replace(twitterCookies(), cookieHeader, "# hTtP CoOkIe FiLe suffix\n", 1), true},
		{"empty values", strings.ReplaceAll(twitterCookies(), "fake-value", ""), true},
		{"nameless cookies take value", cookieHeader + ".x\tTRUE\t\tFALSE\t\t\tauth_token\n.x\tTRUE\t\tFALSE\t0\t\tct0\n", true},
		{"session cookies", strings.ReplaceAll(twitterCookies(), "\t1\t", "\t\t"), true},
		{"zero expiry", strings.ReplaceAll(twitterCookies(), "\t1\t", "\t0\t"), true},
		{"fractional and negative expiry", strings.ReplaceAll(twitterCookies(), "\t1\t", "\t-1.25e3\t"), true},
		{"host flag non TRUE is false", strings.ReplaceAll(strings.ReplaceAll(twitterCookies(), ".example.test", "example.test"), "TRUE", "anything"), true},
		{"secure flag any non TRUE", strings.ReplaceAll(twitterCookies(), "FALSE", "anything"), true},
		{"CRLF", strings.ReplaceAll(twitterCookies(), "\n", "\r\n"), true},
		{"CR", strings.ReplaceAll(twitterCookies(), "\n", "\r"), true},
		{"no terminal newline", strings.TrimSuffix(twitterCookies(), "\n"), true},
		{"Unicode blank line", twitterCookies() + "\u001c\u0085\u00a0\n", true},
		{"empty", "", false},
		{"header only", cookieHeader, false},
		{"missing name", cookieHeader + cookieRow("auth_token"), false},
		{"wrong site names", ehCookies(), false},
		{"wrong name case", strings.ReplaceAll(twitterCookies(), "auth_token", "AUTH_TOKEN"), false},
		{"missing magic", cookieRow("auth_token") + cookieRow("ct0"), false},
		{"BOM", "\ufeff" + twitterCookies(), false},
		{"leading header space", " " + twitterCookies(), false},
		{"Unicode header folding rejected", strings.Replace(twitterCookies(), "Netscape", "Netſcape", 1), false},
		{"too few fields", twitterCookies() + "bad\trow\n", false},
		{"too many fields", twitterCookies() + cookieRow("extra")[:len(cookieRow("extra"))-1] + "\textra\n", false},
		{"domain flag mismatch", strings.Replace(twitterCookies(), "TRUE", "FALSE", 1), false},
		{"domain dot mismatch", strings.Replace(twitterCookies(), ".example.test", "example.test", 1), false},
		{"lowercase true is false", strings.Replace(twitterCookies(), "TRUE", "true", 1), false},
		{"malformed suffix after required names", twitterCookies() + "secret invalid cookie record\n", false},
		{"invalid expiry", strings.Replace(twitterCookies(), "\t1\t", "\tbad\t", 1), false},
		{"invalid UTF8 in comment", twitterCookies() + "#\xff\n", false},
		{"invalid UTF8 value", strings.Replace(twitterCookies(), "fake-value", "\xff", 1), false},
		{"oversized line", twitterCookies() + "#" + strings.Repeat("x", maxCookieLine) + "\n", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStore(t)
			path := filepath.Join(s.managedDir, cookieName("twitter"))
			putFile(t, path, tt.contents)
			got, err := s.CookiesFor(context.Background(), "twitter")
			if err != nil || (got == path) != tt.valid || !tt.valid && got != "" {
				t.Fatalf("CookiesFor valid=%v, err=%v; want valid=%v", got != "", err, tt.valid)
			}
			available, err := s.Available(context.Background(), "twitter", path)
			if err != nil || available != tt.valid {
				t.Fatalf("Available=%v, %v; want %v", available, err, tt.valid)
			}
		})
	}
}

func TestMozillaExpiry(t *testing.T) {
	for _, value := range []string{"1", "-1", "+.5", "1.", "01", "1e-9999", "1_000.2_5e+1_0", " \t1.5\u00a0", "١٢.٣", "１２３", "𝟡"} {
		if !mozillaExpiry(value) {
			t.Errorf("rejected valid expiry %q", value)
		}
	}
	for _, value := range []string{"", " ", ".", "NaN", "+inf", "Infinity", "1e9999", "0x1p0", "1__0", "_1", "1_", "1e_1", "1 2", "١²", "\x1c1"} {
		if mozillaExpiry(value) {
			t.Errorf("accepted invalid expiry %q", value)
		}
	}
}

func TestCookieByteAndLineLimits(t *testing.T) {
	s := newTestStore(t)
	path := filepath.Join(s.managedDir, cookieName("twitter"))
	putFile(t, path, twitterCookies()+"#"+strings.Repeat("x", maxCookieLine-1))
	if got, err := s.CookiesFor(context.Background(), "twitter"); err != nil || got == "" {
		t.Fatalf("exact line bound rejected: %v", err)
	}
	comment := "#" + strings.Repeat("x", 4094) + "\n"
	contents := twitterCookies() + strings.Repeat(comment, maxCookieBytes/len(comment)+1)
	putFile(t, path, contents[:maxCookieBytes])
	if got, err := s.CookiesFor(context.Background(), "twitter"); err != nil || got == "" {
		t.Fatalf("exact file bound rejected: %v", err)
	}
	putFile(t, path, contents[:maxCookieBytes+1])
	if got, err := s.CookiesFor(context.Background(), "twitter"); err != nil || got != "" {
		t.Fatalf("oversized file not rejected: %v", err)
	}
}

func TestSitesAndAliases(t *testing.T) {
	s := newTestStore(t)
	putFile(t, filepath.Join(s.managedDir, cookieName("twitter")), twitterCookies())
	putFile(t, filepath.Join(s.managedDir, cookieName("exhentai")), ehCookies())
	for alias, site := range map[string]string{"twitter": "twitter", " X ": "twitter", "ExHentai": "exhentai", "eh": "exhentai", "E-Hentai": "exhentai"} {
		want := filepath.Join(s.managedDir, cookieName(site))
		if got, err := s.CookiesFor(context.Background(), alias); err != nil || got != want {
			t.Errorf("CookiesFor(%q) valid=%v, err=%v", alias, got == want, err)
		}
	}
	for _, site := range []string{"pixiv", "danbooru", "", "unknown", "../../twitter"} {
		if got, err := s.CookiesFor(context.Background(), site); err != nil || got != "" {
			t.Errorf("unsupported site %q: %v", site, err)
		}
	}
}

func TestInvalidatedTruthiness(t *testing.T) {
	s := newTestStore(t)
	path := filepath.Join(s.managedDir, cookieName("twitter"))
	putFile(t, path, twitterCookies())
	for _, tc := range []struct {
		values  []string
		blocked bool
	}{
		{[]string{`null`, `false`, `0`, `-0.0`, `0e100`, `1e-9999`, `""`, `[]`, `{}`}, false},
		{[]string{`true`, `1`, `-1`, `0.1`, `1e9999`, `999999999999999999999999999999999999`, `"0"`, `"false"`, `[0]`, `{"a":false}`}, true},
	} {
		for _, value := range tc.values {
			putFile(t, filepath.Join(s.managedDir, metadataName), `{"twitter":{"invalidated_at":`+value+`}}`)
			got, err := s.CookiesFor(context.Background(), "twitter")
			if err != nil || (got == "") != tc.blocked {
				t.Errorf("invalidated_at=%s: blocked=%v err=%v", value, got == "", err)
			}
		}
	}
	for _, value := range []string{`null`, `[]`, `"legacy"`, `42`} {
		putFile(t, filepath.Join(s.managedDir, metadataName), `{"twitter":`+value+`}`)
		if got, err := s.CookiesFor(context.Background(), "twitter"); err != nil || got == "" {
			t.Errorf("non-object site metadata: %s, %v", value, err)
		}
	}
}
