package reviews

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"testing"

	"golang.org/x/image/bmp"
	"golang.org/x/image/tiff"
)

func referencePNG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if e := png.Encode(&b, image.NewNRGBA(image.Rect(0, 0, 2, 2))); e != nil {
		t.Fatal(e)
	}
	return b.Bytes()
}
func animatedPNG(t *testing.T) []byte {
	t.Helper()
	source := referencePNG(t)
	header := source[16:29]
	payload := []byte{}
	for pos := 8; pos < len(source); {
		n := int(binary.BigEndian.Uint32(source[pos:]))
		if string(source[pos+4:pos+8]) == "IDAT" {
			payload = append(payload, source[pos+8:pos+8+n]...)
		}
		pos += 12 + n
	}
	result := append([]byte("\x89PNG\r\n\x1a\n"), pngChunk("IHDR", header)...)
	control := make([]byte, 8)
	binary.BigEndian.PutUint32(control, 2)
	result = append(result, pngChunk("acTL", control)...)
	fc := make([]byte, 26)
	binary.BigEndian.PutUint32(fc[4:], 2)
	binary.BigEndian.PutUint32(fc[8:], 2)
	result = append(result, pngChunk("fcTL", fc)...)
	result = append(result, pngChunk("IDAT", payload)...)
	binary.BigEndian.PutUint32(fc, 1)
	result = append(result, pngChunk("fcTL", fc)...)
	fd := make([]byte, len(payload)+4)
	binary.BigEndian.PutUint32(fd, 2)
	copy(fd[4:], payload)
	result = append(result, pngChunk("fdAT", fd)...)
	return append(result, pngChunk("IEND", nil)...)
}
func TestNativeReferenceFormatsAndAnimation(t *testing.T) {
	ctx := context.Background()
	pictures := map[string][]byte{"png": referencePNG(t)}
	pixels := image.NewRGBA(image.Rect(0, 0, 2, 2))
	pixels.Set(0, 0, color.White)
	for name, encode := range map[string]func(*bytes.Buffer) error{"bmp": func(b *bytes.Buffer) error { return bmp.Encode(b, pixels) }, "tiff": func(b *bytes.Buffer) error { return tiff.Encode(b, pixels, nil) }} {
		var b bytes.Buffer
		if e := encode(&b); e != nil {
			t.Fatal(e)
		}
		pictures[name] = b.Bytes()
	}
	// A one-pixel WebP, kept in the test rather than requiring a codec binary.
	webp, e := base64.StdEncoding.DecodeString("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
	if e != nil {
		t.Fatal(e)
	}
	pictures["webp"] = webp
	for name, data := range pictures {
		t.Run(name, func(t *testing.T) {
			if e := decodeReference(ctx, data, true); e != nil {
				t.Fatal(e)
			}
			if e := decodeReference(ctx, data[:len(data)/2], false); e == nil {
				t.Fatal("accepted truncated image")
			}
		})
	}
	animated := map[string][]byte{"apng": animatedPNG(t)}
	var g bytes.Buffer
	frame := image.NewPaletted(image.Rect(0, 0, 2, 2), []color.Color{color.Black, color.White})
	if e = gif.EncodeAll(&g, &gif.GIF{Image: []*image.Paletted{frame, frame}, Delay: []int{1, 1}}); e != nil {
		t.Fatal(e)
	}
	animated["gif"] = g.Bytes()
	// TIFF page chains are independent image directories; duplicate this page's IFD.
	page := append([]byte{}, pictures["tiff"]...)
	offset := binary.LittleEndian.Uint32(page[4:])
	count := uint32(binary.LittleEndian.Uint16(page[offset:]))
	end := offset + 2 + 12*count
	second := append([]byte{}, page[offset:end+4]...)
	binary.LittleEndian.PutUint32(page[end:], uint32(len(page)))
	page = append(page, second...)
	animated["tiff"] = page
	// ANMF stores ordinary WebP bitstreams; validate each, including later frames.
	if len(webp) >= 20 {
		frameHeader := make([]byte, 16)
		payload := append(frameHeader, webp[12:]...)
		extended := make([]byte, 10)
		extended[0] = 2
		chunks := append(riffChunk("VP8X", extended), riffChunk("ANIM", make([]byte, 6))...)
		chunks = append(chunks, riffChunk("ANMF", payload)...)
		chunks = append(chunks, riffChunk("ANMF", payload)...)
		outer := make([]byte, 12)
		copy(outer, "RIFF")
		binary.LittleEndian.PutUint32(outer[4:], uint32(len(chunks)+4))
		copy(outer[8:], "WEBP")
		animated["webp"] = append(outer, chunks...)
	}
	for name, data := range animated {
		t.Run(name+"-animated", func(t *testing.T) {
			if e := decodeReference(ctx, data, false); e != nil {
				t.Fatal(e)
			}
			if e := decodeReference(ctx, data, true); e == nil {
				t.Fatal("accepted multiframe character reference")
			}
			broken := data[:len(data)-8]
			if e := decodeReference(ctx, broken, false); e == nil {
				t.Fatal("accepted damaged later frame")
			}
		})
	}
	if e := referenceDimensions(100000, 100000); e == nil {
		t.Fatal("accepted decompression bomb")
	}
	ctx, cancel := context.WithCancel(ctx)
	cancel()
	if e := decodeReference(ctx, pictures["png"], true); e == nil {
		t.Fatal("accepted cancelled decode")
	}
}
