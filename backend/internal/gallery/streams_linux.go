package gallery

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"ldos/backend/internal/redaction"
)

const maxRawLineBytes = 64 * 1024
const tailLines = 250
const oversizedLine = "<单行输出超出上限，已跳过>"

// Run streams diagnostic lines and retains the last 250 redacted lines. A
// nonzero child exit is a result, not a Go error. Context cancellation, callback
// startup failure, or an orchestration failure returns an error after cleanup.
func (r *Runner) Run(ctx context.Context, req RunRequest) (RunResult, error) {
	result := RunResult{ProcessResult: ProcessResult{ExitCode: -1}}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	p, err := r.prepare(req.Request, req.StallTimeout)
	if err != nil {
		return result, err
	}
	var mu sync.Mutex
	tail := make([]string, 0, tailLines)
	emit := func(stream, line string, skipped bool) {
		mu.Lock()
		defer mu.Unlock()
		safe := line
		if !skipped {
			safe = redaction.Text(line, r.settings.MaxLogLineChars, p.secrets...)
		}
		if len(tail) == tailLines {
			copy(tail, tail[1:])
			tail = tail[:tailLines-1]
		}
		tail = append(tail, "["+stream+"] "+safe)
		if !skipped && req.OnLine != nil {
			_ = req.OnLine(stream, safe)
		}
	}
	read := func(pipe io.Reader, name string) error {
		reader := bufio.NewReaderSize(pipe, maxRawLineBytes)
		discarding := false
		for {
			chunk, err := reader.ReadSlice('\n')
			if errors.Is(err, bufio.ErrBufferFull) {
				if !discarding {
					emit(name, oversizedLine, true)
				}
				discarding = true
				continue
			}
			if !discarding && len(chunk) != 0 {
				line := strings.TrimRight(strings.ToValidUTF8(string(chunk), "�"), "\r\n")
				emit(name, line, false)
			}
			discarding = false
			if err != nil {
				if errors.Is(err, io.EOF) || errors.Is(err, os.ErrClosed) {
					return nil
				}
				return err
			}
		}
	}
	result.ProcessResult, err = r.execute(ctx, req.Request, p, req.StallTimeout, read)
	result.OutputTail = strings.Join(tail, "\n")
	return result, err
}

// Capture preserves metadata protocol output rather than applying URL/token
// redaction to stdout. Only explicit credential values are masked there; stderr
// is diagnostic text. The byte budget is shared by both streams before decoding.
func (r *Runner) Capture(ctx context.Context, req CaptureRequest) (CaptureResult, error) {
	result := CaptureResult{ProcessResult: ProcessResult{ExitCode: -1}}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	limit := req.MaxOutputBytes
	if limit == 0 {
		limit = DefaultMaxOutputBytes
	}
	if limit < 0 {
		return result, errors.New("gallery capture limit must be positive")
	}
	p, err := r.prepare(req.Request, 0)
	if err != nil {
		return result, err
	}
	if req.resolve {
		req.ID = p.marker // Independent lookups must not share an active-operation ID.
	}
	if !req.resolve {
		if err := os.MkdirAll(req.OutputDir, 0o755); err != nil {
			return result, err
		}
	}
	var mu sync.Mutex
	var stdout, stderr bytes.Buffer
	var captured int64
	read := func(pipe io.Reader, name string) error {
		buffer := make([]byte, 64*1024)
		for {
			n, err := pipe.Read(buffer)
			if n > 0 {
				mu.Lock()
				remaining := limit - captured
				accepted := min(int64(n), remaining)
				if name == "stdout" {
					stdout.Write(buffer[:accepted])
				} else {
					stderr.Write(buffer[:accepted])
				}
				captured += accepted
				mu.Unlock()
				if int64(n) > remaining {
					return fmt.Errorf("%w: gallery-dl 元数据输出超过 %d 字节上限", ErrCaptureLimit, limit)
				}
			}
			if err != nil {
				if errors.Is(err, io.EOF) || errors.Is(err, os.ErrClosed) {
					return nil
				}
				return err
			}
		}
	}
	result.ProcessResult, err = r.execute(ctx, req.Request, p, 0, read)
	result.Stdout = strings.ToValidUTF8(stdout.String(), "�")
	for _, secret := range p.secrets {
		if secret != "" {
			result.Stdout = strings.ReplaceAll(result.Stdout, secret, "***")
		}
	}
	result.Stderr = redaction.Text(strings.ToValidUTF8(stderr.String(), "�"), int(limit), p.secrets...)
	return result, err
}
