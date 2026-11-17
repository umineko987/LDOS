package reviews

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"image"
	"image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

// Pillow's default decompression-bomb warning is an error for reference images.
const referencePixelLimit int64 = 89478485

func validateReference(ctx context.Context, v Snapshot, staticOnly bool) error {
	root, e := openRoot(v.RootPath)
	if e != nil {
		return e
	}
	defer root.close()
	identity, e := root.identity()
	if e != nil {
		return e
	}
	if len(v.RootIdentity) != 2 || identity[0] != v.RootIdentity[0] || identity[1] != v.RootIdentity[1] {
		return conflict("review_source_root_changed")
	}
	f, e := root.open(v.RelativePath)
	if e != nil {
		return e
	}
	defer f.Close()
	version, e := heldDiskVersion(ctx, f)
	if e != nil {
		return e
	}
	if version != v.DiskVersion {
		return conflict("review_image_changed")
	}
	data, e := io.ReadAll(f)
	if e != nil {
		return e
	}
	if e = decodeReference(ctx, data, staticOnly); e != nil {
		return e
	}
	version, e = heldDiskVersion(ctx, f)
	if e != nil {
		return e
	}
	if version != v.DiskVersion {
		return conflict("review_image_changed")
	}
	return ctx.Err()
}
func referenceDimensions(width, height int) error {
	if width <= 0 || height <= 0 || int64(width) > referencePixelLimit/int64(height) {
		return fmt.Errorf("reference image dimensions exceed decoding bounds")
	}
	return nil
}
func decodeOne(ctx context.Context, data []byte) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	cfg, _, e := image.DecodeConfig(bytes.NewReader(data))
	if e != nil {
		return e
	}
	if e = referenceDimensions(cfg.Width, cfg.Height); e != nil {
		return e
	}
	_, _, e = image.Decode(bytes.NewReader(data))
	if e != nil {
		return e
	}
	return ctx.Err()
}
func decodeReference(ctx context.Context, data []byte, staticOnly bool) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	switch {
	case len(data) >= 8 && bytes.Equal(data[:8], []byte("\x89PNG\r\n\x1a\n")):
		return decodePNGFrames(ctx, data, staticOnly)
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return decodeWebPFrames(ctx, data, staticOnly)
	case len(data) >= 4 && (string(data[:4]) == "II*\x00" || string(data[:4]) == "MM\x00*"):
		return decodeTIFFPages(ctx, data, staticOnly)
	case len(data) >= 6 && (string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a"):
		cfg, e := gif.DecodeConfig(bytes.NewReader(data))
		if e != nil {
			return e
		}
		if e = referenceDimensions(cfg.Width, cfg.Height); e != nil {
			return e
		}
		g, e := gif.DecodeAll(bytes.NewReader(data))
		if e != nil {
			return e
		}
		if staticOnly && len(g.Image) != 1 {
			return fmt.Errorf("reference must be static")
		}
		return ctx.Err()
	default:
		return decodeOne(ctx, data)
	}
}
func pngChunk(kind string, payload []byte) []byte {
	out := make([]byte, len(payload)+12)
	binary.BigEndian.PutUint32(out, uint32(len(payload)))
	copy(out[4:8], kind)
	copy(out[8:], payload)
	binary.BigEndian.PutUint32(out[len(out)-4:], crc32.ChecksumIEEE(out[4:len(out)-4]))
	return out
}
func decodePNGFrames(ctx context.Context, data []byte, staticOnly bool) error {
	if e := decodeOne(ctx, data); e != nil {
		return e
	}
	var header, shared, frameData []byte
	var frameWidth, frameHeight, canvasWidth, canvasHeight uint32
	declared, frames, sequence := uint32(0), uint32(0), uint32(0)
	animated, hasFrame, sawIDAT, defaultInAnimation := false, false, false, false
	flush := func() error {
		if !hasFrame {
			return nil
		}
		if len(frameData) == 0 {
			return fmt.Errorf("empty APNG frame")
		}
		h := append([]byte{}, header...)
		binary.BigEndian.PutUint32(h, frameWidth)
		binary.BigEndian.PutUint32(h[4:], frameHeight)
		frame := append([]byte("\x89PNG\r\n\x1a\n"), pngChunk("IHDR", h)...)
		frame = append(frame, shared...)
		frame = append(frame, frameData...)
		frame = append(frame, pngChunk("IEND", nil)...)
		return decodeOne(ctx, frame)
	}
	for pos := 8; pos < len(data); {
		if e := ctx.Err(); e != nil {
			return e
		}
		if len(data)-pos < 12 {
			return fmt.Errorf("invalid PNG chunk")
		}
		n := int64(binary.BigEndian.Uint32(data[pos:]))
		if n > int64(len(data)-pos-12) {
			return fmt.Errorf("invalid PNG chunk length")
		}
		end := pos + 12 + int(n)
		chunk := data[pos:end]
		kind := string(chunk[4:8])
		payload := chunk[8 : len(chunk)-4]
		if binary.BigEndian.Uint32(chunk[len(chunk)-4:]) != crc32.ChecksumIEEE(chunk[4:len(chunk)-4]) {
			return fmt.Errorf("invalid PNG checksum")
		}
		switch kind {
		case "IHDR":
			if len(payload) != 13 {
				return fmt.Errorf("invalid PNG header")
			}
			header = append([]byte{}, payload...)
			canvasWidth = binary.BigEndian.Uint32(payload)
			canvasHeight = binary.BigEndian.Uint32(payload[4:])
		case "acTL":
			if len(payload) != 8 || animated {
				return fmt.Errorf("invalid APNG control")
			}
			animated = true
			declared = binary.BigEndian.Uint32(payload)
			if declared < 1 {
				return fmt.Errorf("invalid APNG frame count")
			}
			if staticOnly && declared > 1 {
				return fmt.Errorf("reference must be static")
			}
		case "fcTL":
			if !animated || len(payload) != 26 || binary.BigEndian.Uint32(payload) != sequence {
				return fmt.Errorf("invalid APNG frame control")
			}
			sequence++
			if e := flush(); e != nil {
				return e
			}
			frames++
			hasFrame = true
			frameData = nil
			frameWidth = binary.BigEndian.Uint32(payload[4:])
			frameHeight = binary.BigEndian.Uint32(payload[8:])
			x, y := binary.BigEndian.Uint32(payload[12:]), binary.BigEndian.Uint32(payload[16:])
			if frameWidth == 0 || frameHeight == 0 || uint64(x)+uint64(frameWidth) > uint64(canvasWidth) || uint64(y)+uint64(frameHeight) > uint64(canvasHeight) || payload[24] > 2 || payload[25] > 1 {
				return fmt.Errorf("invalid APNG frame bounds")
			}
			if !sawIDAT {
				defaultInAnimation = true
			}
		case "IDAT":
			sawIDAT = true
			if hasFrame {
				frameData = append(frameData, pngChunk("IDAT", payload)...)
			}
		case "fdAT":
			if !hasFrame || len(payload) < 4 || binary.BigEndian.Uint32(payload) != sequence {
				return fmt.Errorf("invalid APNG frame data")
			}
			sequence++
			frameData = append(frameData, pngChunk("IDAT", payload[4:])...)
		case "IEND":
			if e := flush(); e != nil {
				return e
			}
			if animated && (frames != declared || staticOnly && (!defaultInAnimation || frames != 1)) {
				return fmt.Errorf("reference animation frame count mismatch")
			}
			return nil
		default:
			if !sawIDAT {
				shared = append(shared, chunk...)
			}
		}
		pos = end
	}
	return fmt.Errorf("PNG has no end marker")
}
func u24(b []byte) uint32      { return uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 }
func put24(b []byte, n uint32) { b[0] = byte(n); b[1] = byte(n >> 8); b[2] = byte(n >> 16) }
func riffChunk(kind string, payload []byte) []byte {
	out := make([]byte, 8+len(payload)+(len(payload)&1))
	copy(out, kind)
	binary.LittleEndian.PutUint32(out[4:], uint32(len(payload)))
	copy(out[8:], payload)
	return out
}
func webPFrame(payload []byte, width, height uint32) []byte {
	extended := make([]byte, 10)
	if len(payload) >= 4 && string(payload[:4]) == "ALPH" {
		extended[0] = 0x10
	}
	put24(extended[4:], width-1)
	put24(extended[7:], height-1)
	chunks := append(riffChunk("VP8X", extended), payload...)
	out := make([]byte, 12)
	copy(out, "RIFF")
	binary.LittleEndian.PutUint32(out[4:], uint32(len(chunks)+4))
	copy(out[8:], "WEBP")
	return append(out, chunks...)
}
func decodeWebPFrames(ctx context.Context, data []byte, staticOnly bool) error {
	size := uint64(binary.LittleEndian.Uint32(data[4:])) + 8
	if size > uint64(len(data)) || size < 12 {
		return fmt.Errorf("invalid WebP length")
	}
	var width, height uint32
	animated := false
	frames := 0
	for pos := 12; uint64(pos) < size; {
		if e := ctx.Err(); e != nil {
			return e
		}
		if uint64(pos)+8 > size {
			return fmt.Errorf("invalid WebP chunk")
		}
		n := uint64(binary.LittleEndian.Uint32(data[pos+4:]))
		end := uint64(pos) + 8 + n
		if end > size {
			return fmt.Errorf("invalid WebP chunk length")
		}
		kind := string(data[pos : pos+4])
		payload := data[pos+8 : int(end)]
		switch kind {
		case "VP8X":
			if len(payload) != 10 {
				return fmt.Errorf("invalid WebP header")
			}
			width = u24(payload[4:]) + 1
			height = u24(payload[7:]) + 1
			if e := referenceDimensions(int(width), int(height)); e != nil {
				return e
			}
			animated = payload[0]&2 != 0
		case "ANMF":
			if !animated || len(payload) < 16 {
				return fmt.Errorf("invalid WebP animation frame")
			}
			frames++
			if staticOnly && frames > 1 {
				return fmt.Errorf("reference must be static")
			}
			x, y, w, h := u24(payload)*2, u24(payload[3:])*2, u24(payload[6:])+1, u24(payload[9:])+1
			if uint64(x)+uint64(w) > uint64(width) || uint64(y)+uint64(h) > uint64(height) {
				return fmt.Errorf("invalid WebP frame bounds")
			}
			if e := decodeOne(ctx, webPFrame(payload[16:], w, h)); e != nil {
				return e
			}
		}
		pos = int(end + (n & 1))
	}
	if animated {
		if frames == 0 {
			return fmt.Errorf("WebP animation has no frames")
		}
		return nil
	}
	return decodeOne(ctx, data)
}
func decodeTIFFPages(ctx context.Context, data []byte, staticOnly bool) error {
	if len(data) < 8 {
		return fmt.Errorf("invalid TIFF header")
	}
	var order binary.ByteOrder = binary.LittleEndian
	if data[0] == 'M' {
		order = binary.BigEndian
	}
	offset := order.Uint32(data[4:])
	seen := map[uint32]bool{}
	pages := 0
	copyData := append([]byte{}, data...)
	for offset != 0 {
		if e := ctx.Err(); e != nil {
			return e
		}
		if seen[offset] || uint64(offset)+2 > uint64(len(data)) {
			return fmt.Errorf("invalid TIFF directory")
		}
		seen[offset] = true
		pages++
		if staticOnly && pages > 1 {
			return fmt.Errorf("reference must be static")
		}
		count := uint64(order.Uint16(data[offset:]))
		end := uint64(offset) + 2 + 12*count
		if end+4 > uint64(len(data)) {
			return fmt.Errorf("invalid TIFF directory size")
		}
		order.PutUint32(copyData[4:], offset)
		if e := decodeOne(ctx, copyData); e != nil {
			return e
		}
		offset = order.Uint32(data[end:])
	}
	if pages == 0 {
		return fmt.Errorf("TIFF has no image directory")
	}
	return nil
}
