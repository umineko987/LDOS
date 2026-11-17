package pixivauth

import (
	"encoding/binary"
	"strings"
	"testing"
)

func TestPicklePythonScalarProtocols(t *testing.T) {
	// Python pickle.dumps("token", protocol=n) wire-format fixtures.
	fixtures := []string{
		"Vtoken\np0\n.",
		"X\x05\x00\x00\x00tokenq\x00.",
		"\x80\x02X\x05\x00\x00\x00tokenq\x00.",
		"\x80\x03X\x05\x00\x00\x00tokenq\x00.",
		"\x80\x04\x95\x09\x00\x00\x00\x00\x00\x00\x00\x8c\x05token\x94.",
		"\x80\x05\x95\x09\x00\x00\x00\x00\x00\x00\x00\x8c\x05token\x94.",
	}
	for protocol, fixture := range fixtures {
		got, ok := decodeCacheToken([]byte(fixture))
		if !ok || got != "token" {
			t.Errorf("protocol %d: got %q, %v", protocol, got, ok)
		}
		for i := 0; i < len(fixture); i++ {
			if _, ok := decodeCacheToken([]byte(fixture[:i])); ok {
				t.Errorf("protocol %d accepted truncation at %d", protocol, i)
			}
		}
	}
	unicodeFixture := []byte("V\xe9\\u4e2d\\U0001f600\\u000a\\u005c\np0\n.")
	if got, ok := decodeCacheToken(unicodeFixture); !ok || got != "é中😀\n\\" {
		t.Fatalf("protocol 0 unicode: %q, %v", got, ok)
	}
	for _, token := range []string{"é中😀\n\\", strings.Repeat("é", 508), "token"} {
		if got, ok := decodeCacheToken(pickleToken(token)); !ok || got != token {
			t.Fatalf("unicode round trip: %q, %v", got, ok)
		}
	}
	if got := string(pickleToken("token")); got != "\x80\x02X\x05\x00\x00\x00token." {
		t.Fatalf("unexpected saved pickle %q", got)
	}
	if !validSavedToken(strings.Repeat("x", 1016)) || validSavedToken(strings.Repeat("x", 1017)) {
		t.Fatal("encoded token size boundary")
	}
}

func TestPickleRejectsHostileAndMalformedValues(t *testing.T) {
	framed := []byte("\x80\x04\x95\x09\x00\x00\x00\x00\x00\x00\x00\x8c\x05token\x94.")
	framed = append(framed, []byte("trailing")...)
	binary.LittleEndian.PutUint64(framed[3:11], uint64(len(framed)-11))
	bad := []any{
		nil, 123, []byte{}, []byte("N."), []byte("\x80\x02N."), []byte("\x80\x05N."),
		[]byte("legacy-blob-token"), []byte("cos\nsystem\n(S'touch marker'\ntR."),
		[]byte("Ppersistent\n."), []byte("\x80\x05\x8c\x01x\x93."),
		[]byte("\x80\x05\x8c\x01xQ."), []byte("\x80\x04}\x94."),
		[]byte("\x80\x03C\x05tokenq\x00."), []byte("Vtoken\np0\n.tail"), framed,
		[]byte("V\\ud800\np0\n."), []byte("V\\U00110000\np0\n."),
		[]byte("V\\uZZZZ\np0\n."), []byte("V\\u12\np0\n."),
		[]byte("\x80\x06N."), []byte("\x80\x05\x95\xff\xff\xff\xff\xff\xff\xff\xffN."),
		[]byte("\x8d\xff\xff\xff\xff\xff\xff\xff\xff."), []byte("X\xff\xff\xff\xff."),
		[]byte("Vx\np4294967296\n."), []byte("Vx\np-1\n."),
		[]byte("X\x03\x00\x00\x00\xed\xa0\x80."),
		strings.Repeat("x", 1025), strings.Repeat("é", 513), string([]byte{0xff}),
		pickleToken(strings.Repeat("x", 1024)),
	}
	for i, value := range bad {
		if _, ok := decodeCacheToken(value); ok {
			t.Errorf("accepted hostile/malformed fixture %d", i)
		}
	}
}

func TestRawUnicodeEscapes(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{`\\u0041`, `\\u0041`},
		{`\\\u0041`, `\\A`},
		{`\n`, `\n`},
		{`\u005cn`, `\n`},
	} {
		got, ok := rawUnicode([]byte(tc.input))
		if !ok || got != tc.want {
			t.Errorf("raw Unicode %q: got %q, want %q", tc.input, got, tc.want)
		}
	}
}

func FuzzDecodeCacheToken(f *testing.F) {
	f.Add([]byte("Vtoken\np0\n."))
	f.Add(pickleToken("中😀"))
	f.Add([]byte("\x80\x05N."))
	f.Fuzz(func(t *testing.T, data []byte) { decodeCacheToken(data) })
}
