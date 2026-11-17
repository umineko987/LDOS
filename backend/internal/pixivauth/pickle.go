package pixivauth

import (
	"bytes"
	"encoding/binary"
	"strconv"
	"strings"
	"unicode/utf8"
)

const maxCacheValueBytes = 1024

func validSavedToken(token string) bool {
	// Protocol 2 BINUNICODE adds eight bytes; the whole pickle must fit.
	return len(token) <= maxCacheValueBytes-8 && utf8.ValidString(token) && strings.TrimSpace(token) != ""
}

func pickleToken(token string) []byte {
	result := make([]byte, 7, len(token)+8)
	result[0], result[1], result[2] = 0x80, 2, 'X'
	binary.LittleEndian.PutUint32(result[3:], uint32(len(token)))
	result = append(result, token...)
	return append(result, '.')
}

// decodeCacheToken accepts legacy SQLite TEXT or Python's scalar string/None
// pickle encodings (protocols 0-5). This is deliberately not a pickle VM: globals,
// reducers, containers, persistent IDs, stack operations and trailing bytes are
// rejected. No data-driven code can run. None and invalid data both mean a miss.
func decodeCacheToken(value any) (string, bool) {
	if text, ok := value.(string); ok {
		return text, len(text) <= maxCacheValueBytes && utf8.ValidString(text)
	}
	data, ok := value.([]byte)
	if !ok || len(data) == 0 || len(data) > maxCacheValueBytes {
		return "", false
	}
	if data[0] == 0x80 {
		if len(data) < 3 || data[1] > 5 {
			return "", false
		}
		data = data[2:]
	}
	if data[0] == 0x95 { // FRAME: a scalar this small fits in one frame.
		if len(data) < 10 || binary.LittleEndian.Uint64(data[1:9]) != uint64(len(data)-9) {
			return "", false
		}
		data = data[9:]
	}
	var token string
	var none bool
	switch data[0] {
	case 'N':
		none, data = true, data[1:]
	case 'V': // UNICODE uses raw-unicode-escape, not UTF-8.
		end := bytes.IndexByte(data, '\n')
		if end < 0 {
			return "", false
		}
		token, ok = rawUnicode(data[1:end])
		if !ok {
			return "", false
		}
		data = data[end+1:]
	case 'X', 0x8c, 0x8d: // BINUNICODE, SHORT_BINUNICODE, BINUNICODE8
		width := 4
		if data[0] == 0x8c {
			width = 1
		} else if data[0] == 0x8d {
			width = 8
		}
		if len(data) < 1+width {
			return "", false
		}
		var size uint64
		switch width {
		case 1:
			size = uint64(data[1])
		case 4:
			size = uint64(binary.LittleEndian.Uint32(data[1:5]))
		case 8:
			size = binary.LittleEndian.Uint64(data[1:9])
		}
		data = data[1+width:]
		if size > uint64(len(data)) {
			return "", false
		}
		token, data = string(data[:int(size)]), data[int(size):]
	default:
		return "", false
	}
	// Python memoizes strings, even though a scalar has no later references.
	if len(data) > 0 {
		switch data[0] {
		case 'p': // PUT
			end := bytes.IndexByte(data, '\n')
			if end < 2 {
				return "", false
			}
			for _, c := range data[1:end] {
				if c < '0' || c > '9' {
					return "", false
				}
			}
			if _, err := strconv.ParseUint(string(data[1:end]), 10, 32); err != nil {
				return "", false
			}
			data = data[end+1:]
		case 'q': // BINPUT
			if len(data) < 2 {
				return "", false
			}
			data = data[2:]
		case 'r': // LONG_BINPUT
			if len(data) < 5 {
				return "", false
			}
			data = data[5:]
		case 0x94: // MEMOIZE
			data = data[1:]
		}
	}
	if none || len(data) != 1 || data[0] != '.' || len(token) > maxCacheValueBytes || !utf8.ValidString(token) {
		return "", false
	}
	return token, true
}

func rawUnicode(data []byte) (string, bool) {
	var result strings.Builder
	for i := 0; i < len(data); {
		if data[i] != '\\' {
			result.WriteRune(rune(data[i])) // raw-unicode-escape's literal bytes are Latin-1.
			i++
			continue
		}
		start := i
		for i < len(data) && data[i] == '\\' {
			i++
		}
		count := i - start
		if count%2 == 0 || i == len(data) || data[i] != 'u' && data[i] != 'U' {
			result.Write(data[start:i])
			continue
		}
		result.Write(data[start : i-1])
		width := 4
		if data[i] == 'U' {
			width = 8
		}
		i++
		if len(data)-i < width {
			return "", false
		}
		value, err := strconv.ParseUint(string(data[i:i+width]), 16, 32)
		if err != nil || value > utf8.MaxRune || value >= 0xd800 && value <= 0xdfff {
			return "", false
		}
		result.WriteRune(rune(value))
		i += width
	}
	return result.String(), true
}
