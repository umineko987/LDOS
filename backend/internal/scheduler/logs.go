package scheduler

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"ldos/backend/internal/store"
)

const maxPendingLogs = 20000

type logWriter struct {
	db                   Repository
	mu                   sync.Mutex
	flushMu              sync.Mutex
	rows                 []store.LogRow
	head, count, dropped int
	droppedTarget        store.LogRow
	wake                 chan struct{}
	stop                 chan struct{}
	done                 chan struct{}
}

func newLogWriter(db Repository) *logWriter {
	return &logWriter{db: db, rows: make([]store.LogRow, maxPendingLogs), wake: make(chan struct{}, 1)}
}
func (l *logWriter) start() {
	l.stop = make(chan struct{})
	l.done = make(chan struct{})
	go func() {
		defer close(l.done)
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			stopping := false
			select {
			case <-ticker.C:
			case <-l.wake:
			case <-l.stop:
				stopping = true
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			l.flush(ctx)
			cancel()
			if stopping {
				return
			}
		}
	}()
}
func (l *logWriter) close() { close(l.stop); <-l.done }
func (l *logWriter) push(taskID, attemptID, stream, line string) {
	l.mu.Lock()
	if l.count == len(l.rows) {
		if l.dropped == 0 {
			l.droppedTarget = l.rows[l.head]
		}
		l.dropped++
		l.head = (l.head + 1) % len(l.rows)
		l.count--
	}
	l.rows[(l.head+l.count)%len(l.rows)] = store.LogRow{TaskID: taskID, AttemptID: &attemptID, Timestamp: unixNow(), Stream: stream, Line: line}
	l.count++
	wake := l.count >= 64
	l.mu.Unlock()
	if wake {
		select {
		case l.wake <- struct{}{}:
		default:
		}
	}
}
func (l *logWriter) flush(ctx context.Context) {
	l.flushMu.Lock()
	defer l.flushMu.Unlock()
	l.mu.Lock()
	rows := make([]store.LogRow, 0, l.count+1)
	if l.dropped > 0 {
		row := l.droppedTarget
		row.Stream = "backend"
		row.Line = fmt.Sprintf("因日志缓冲溢出已丢弃 %d 行输出", l.dropped)
		rows = append(rows, row)
		l.dropped = 0
		l.droppedTarget = store.LogRow{}
	}
	for i := 0; i < l.count; i++ {
		index := (l.head + i) % len(l.rows)
		rows = append(rows, l.rows[index])
		l.rows[index] = store.LogRow{}
	}
	l.count = 0
	l.head = 0
	l.mu.Unlock()
	if len(rows) > 0 {
		if _, err := l.db.AppendLogsBulk(ctx, rows); err != nil {
			log.Printf("task log write failed; dropped_rows=%d", len(rows))
		}
	}
}
