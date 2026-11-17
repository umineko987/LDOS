// Package danboorurate coordinates Danbooru metadata requests across Go and Python.
package danboorurate

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const FileName = "danbooru-rate.lock"
const Environment = "GDL_DANBOORU_RATE_FILE"
const Interval = time.Second

// The file contains the next allowed Unix timestamp in nanoseconds. Never
// replace it: flock must always refer to the same inode in every process.
func lock(ctx context.Context, path string) (*os.File, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	for {
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			if err = ctx.Err(); err == nil {
				return file, nil
			}
			file.Close()
			return nil, err
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR) {
			file.Close()
			return nil, err
		}
		if err = wait(ctx, 25*time.Millisecond); err != nil {
			file.Close()
			return nil, err
		}
	}
}

func wait(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func readNext(file *os.File) (int64, error) {
	data, err := io.ReadAll(io.LimitReader(file, 64))
	if err != nil {
		return 0, err
	}
	value := strings.TrimSpace(string(data))
	if value == "" {
		return 0, nil
	}
	return strconv.ParseInt(value, 10, 64)
}

func writeNext(file *os.File, next int64) error {
	data := strconv.FormatInt(next, 10) + "\n"
	if _, err := file.WriteAt([]byte(data), 0); err != nil {
		return err
	}
	return file.Truncate(int64(len(data)))
}

// Wait consumes a slot only when it is due. Sleeping callers hold no flock and
// re-read the deadline, so a later 429 also postpones callers already waiting.
func Wait(ctx context.Context, path string) error {
	for {
		file, err := lock(ctx, path)
		if err != nil {
			return err
		}
		next, err := readNext(file)
		now := time.Now()
		delay := time.Unix(0, next).Sub(now)
		if err == nil && delay <= 0 {
			err = writeNext(file, now.Add(Interval).UnixNano())
		}
		file.Close()
		if err != nil || delay <= 0 {
			return err
		}
		if err := wait(ctx, delay); err != nil {
			return err
		}
	}
}

// RetryAfter accepts delta-seconds and HTTP dates; absent, invalid or expired
// values still impose a one-second cooldown.
func RetryAfter(value string, now time.Time) time.Time {
	value = strings.TrimSpace(value)
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil && seconds >= 0 && seconds <= int64((1<<63-1)/time.Second) {
		return now.Add(max(Interval, time.Duration(seconds)*time.Second))
	}
	if until, err := http.ParseTime(value); err == nil && until.After(now.Add(Interval)) {
		return until
	}
	return now.Add(Interval)
}

// Cooldown extends the shared deadline without ever shortening it.
func Cooldown(ctx context.Context, path, retryAfter string) error {
	until := RetryAfter(retryAfter, time.Now()).UnixNano()
	file, err := lock(ctx, path)
	if err != nil {
		return err
	}
	defer file.Close()
	next, err := readNext(file)
	if err != nil {
		return err
	}
	return writeNext(file, max(next, until))
}
