package gallerycatalog

import (
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
)

func (s *Service) probeImage(ctx context.Context, f *os.File) (string, int, int, error) {
	if e := ctx.Err(); e != nil {
		return "", 0, 0, e
	}
	config, format, e := image.DecodeConfig(f)
	if e != nil {
		return "", 0, 0, e
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 100_000_000 {
		return "", 0, 0, failure("image_too_large", 422)
	}
	return strings.ToUpper(format), config.Width, config.Height, nil
}
func contentETag(assetID string, modified, size int64) string {
	sum := sha1.Sum([]byte(fmt.Sprintf("%s:%d:%d", assetID, modified, size)))
	return `W/"` + hex.EncodeToString(sum[:])[:24] + `"`
}
func (s *Service) Thumbnail(ctx context.Context, assetID string, size int) ([]byte, string, error) {
	if size != 256 && size != 512 {
		return nil, "", failure("invalid_thumbnail_size", 422)
	}
	f, _, e := s.OpenImage(ctx, assetID)
	if e != nil {
		return nil, "", e
	}
	defer f.Close()
	before, e := fileStat(f)
	if e != nil {
		return nil, "", e
	}
	key := digest([]byte(fmt.Sprintf("native-v1:%s:%d:%d:%d", assetID, before.Modified, before.Size, size)))
	etag := `"` + key + `"`
	// Serialize only this cache entry; source bytes are descriptor held and checked
	// after decoding. A source symlink swap cannot cause a cached unsafe-path hit.
	release, e := s.locks.Hold(ctx, "thumbnail:"+key)
	if e != nil {
		return nil, "", e
	}
	defer release()
	cacheDir := filepath.Join(s.settings.RuntimeDir, "gallery-thumbnails")
	var cache *SafeRoot
	if s.settings.RuntimeDir != "" {
		if e = os.MkdirAll(cacheDir, 0755); e == nil {
			cache, e = OpenSafeRoot(cacheDir)
			if e == nil {
				defer cache.Close()
				if cached, e := cache.Open(key + ".jpg"); e == nil {
					defer cached.Close()
					data, e := io.ReadAll(io.LimitReader(cached, 4<<20))
					if e == nil {
						return data, etag, nil
					}
				}
			}
		}
	}
	if _, _, _, e = s.probeImage(ctx, f); e != nil {
		return nil, "", failure("thumbnail_unavailable", 422)
	}
	if _, e = f.Seek(0, 0); e != nil {
		return nil, "", e
	}
	header := make([]byte, 256<<10)
	n, _ := f.Read(header)
	orientation := exifOrientation(header[:n])
	_, _ = f.Seek(0, 0)
	img, _, e := image.Decode(f)
	if e != nil {
		return nil, "", &Error{Code: "thumbnail_unavailable", Status: 422, Cause: e}
	}
	img = orientImage(img, orientation)
	resized := resizeImage(img, size)
	var buffer bytes.Buffer
	if e = jpeg.Encode(&buffer, resized, &jpeg.Options{Quality: 85}); e != nil {
		return nil, "", e
	}
	output := buffer.Bytes()
	after, e := fileStat(f)
	if e != nil || !before.sameSnapshot(after) {
		return nil, "", failure("source_changed", 409)
	}
	if cache != nil {
		_, _, _ = cache.AtomicWrite(key+".jpg", output, MissingDiskVersion)
	}
	return output, etag, nil
}
func resizeImage(src image.Image, size int) *image.RGBA {
	bounds := src.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	ratio := math.Min(1, math.Min(float64(size)/float64(w), float64(size)/float64(h)))
	dw, dh := max(1, int(math.Round(float64(w)*ratio))), max(1, int(math.Round(float64(h)*ratio)))
	out := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		sy := (float64(y)+.5)*float64(h)/float64(dh) - .5
		y0 := max(0, int(math.Floor(sy)))
		y1 := min(h-1, y0+1)
		fy := max(0, sy-float64(y0))
		for x := 0; x < dw; x++ {
			sx := (float64(x)+.5)*float64(w)/float64(dw) - .5
			x0 := max(0, int(math.Floor(sx)))
			x1 := min(w-1, x0+1)
			fx := max(0, sx-float64(x0))
			var r, g, b float64
			for i, p := range [4]image.Point{{x0, y0}, {x1, y0}, {x0, y1}, {x1, y1}} {
				weight := []float64{(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy}[i]
				cr, cg, cb, ca := src.At(bounds.Min.X+p.X, bounds.Min.Y+p.Y).RGBA()
				r += float64(cr+65535-ca) * weight
				g += float64(cg+65535-ca) * weight
				b += float64(cb+65535-ca) * weight
			}
			out.SetRGBA(x, y, color.RGBA{uint8(r / 257), uint8(g / 257), uint8(b / 257), 255})
		}
	}
	return out
}
func exifOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xff || data[1] != 0xd8 {
		return 1
	}
	for p := 2; p+4 <= len(data); {
		if data[p] != 0xff {
			return 1
		}
		marker := data[p+1]
		if marker == 0xda || marker == 0xd9 {
			return 1
		}
		size := int(binary.BigEndian.Uint16(data[p+2 : p+4]))
		if size < 2 || p+2+size > len(data) {
			return 1
		}
		if marker == 0xe1 && size >= 16 && string(data[p+4:p+10]) == "Exif\x00\x00" {
			t := data[p+10 : p+2+size]
			var order binary.ByteOrder
			if string(t[:2]) == "II" {
				order = binary.LittleEndian
			} else if string(t[:2]) == "MM" {
				order = binary.BigEndian
			} else {
				return 1
			}
			if len(t) < 8 {
				return 1
			}
			offset := int(order.Uint32(t[4:8]))
			if offset < 0 || offset+2 > len(t) {
				return 1
			}
			count := int(order.Uint16(t[offset : offset+2]))
			for i := 0; i < count; i++ {
				a := offset + 2 + i*12
				if a+12 > len(t) {
					break
				}
				if order.Uint16(t[a:a+2]) == 0x112 && order.Uint16(t[a+2:a+4]) == 3 && order.Uint32(t[a+4:a+8]) == 1 {
					v := int(order.Uint16(t[a+8 : a+10]))
					if v >= 1 && v <= 8 {
						return v
					}
				}
			}
			return 1
		}
		p += size + 2
	}
	return 1
}
func orientImage(src image.Image, o int) image.Image {
	if o == 1 {
		return src
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	out := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			sx, sy := x, y
			switch o {
			case 2:
				sx = w - 1 - x
			case 3:
				sx, sy = w-1-x, h-1-y
			case 4:
				sy = h - 1 - y
			case 5:
				sx, sy = y, x
			case 6:
				sx, sy = y, h-1-x
			case 7:
				sx, sy = w-1-y, h-1-x
			case 8:
				sx, sy = w-1-y, x
			}
			out.Set(x, y, src.At(b.Min.X+sx, b.Min.Y+sy))
		}
	}
	return out
}

func (s *Service) HashImage(ctx context.Context, assetID string) (string, error) {
	a, e := s.GetImage(ctx, assetID)
	if e != nil {
		return "", e
	}
	if str(a, "content_sha256") != "" {
		return str(a, "content_sha256"), nil
	}
	release, e := s.LockSources(ctx, str(a, "source_id"))
	if e != nil {
		return "", e
	}
	defer release()
	f, a, e := s.OpenImage(ctx, assetID)
	if e != nil {
		return "", e
	}
	defer f.Close()
	before, e := fileStat(f)
	if e != nil {
		return "", e
	}
	if before.Size != num(a, "size_bytes") || before.Modified != num(a, "modified_ns") {
		return "", failure("source_changed", 409)
	}
	h := sha256.New()
	buf := make([]byte, 128<<10)
	for {
		if e = ctx.Err(); e != nil {
			return "", e
		}
		n, re := f.Read(buf)
		h.Write(buf[:n])
		if re == io.EOF {
			break
		}
		if re != nil {
			return "", re
		}
	}
	after, e := fileStat(f)
	if e != nil || !before.sameSnapshot(after) {
		return "", failure("source_changed", 409)
	}
	root, e := s.OpenSource(ctx, str(a, "source_id"))
	if e != nil {
		return "", e
	}
	current, e := root.Stat(str(a, "relative_path"))
	root.Close()
	if e != nil || !before.sameSnapshot(current) {
		return "", failure("source_changed", 409)
	}
	value := hex.EncodeToString(h.Sum(nil))
	e = s.db.WriteTransaction(ctx, func(tx *sql.Tx) error {
		result, e := tx.ExecContext(ctx, "UPDATE gallery_assets SET content_sha256=? WHERE id=? AND size_bytes=? AND modified_ns=? AND lifecycle_state='active' AND content_sha256=''", value, assetID, before.Size, before.Modified)
		return checkRows(result, e, "source_changed")
	})
	return value, e
}
func (s *Service) EnqueueMissingHashes(ctx context.Context, sourceID string) error {
	rows, e := s.db.QueryRows(ctx, "SELECT id FROM gallery_assets WHERE source_id=? AND lifecycle_state='active' AND content_sha256=''", sourceID)
	if e != nil {
		return e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping {
		return failure("service_stopping", 503)
	}
	for _, row := range rows {
		aid := str(row, "id")
		if !s.hashPending[aid] {
			select {
			case s.hashQueue <- aid:
				s.hashPending[aid] = true
			default:
				return nil
			}
		}
	}
	return nil
}
func (s *Service) hashWorker() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case aid := <-s.hashQueue:
			_, _ = s.HashImage(s.ctx, aid)
			s.mu.Lock()
			delete(s.hashPending, aid)
			s.mu.Unlock()
		}
	}
}

// DecodeImageMetadata computes only image metadata. It is suitable for trusted
// peer modules holding a safe file, without reopening a user-supplied path.
func (s *Service) DecodeImageMetadata(ctx context.Context, f *os.File) (Row, error) {
	format, w, h, e := s.probeImage(ctx, f)
	return Row{"format": format, "width": w, "height": h}, e
}
