// Package activity implements the in-process activity log and job projection.
package activity

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	EventBufferSize = 2048
	JobEvent        = "job.updated"
	HelloEvent      = "hello"
	ResyncEvent     = "resync"
)

// Event holds an immutable JSON snapshot. Returned events belong to the caller.
// Seq and Time are zero for stream control markers.
type Event struct {
	Seq   uint64
	ID    string
	Kind  string
	Data  json.RawMessage
	Time  float64
	Retry int
}

// Bus is safe for concurrent publishers and subscribers. Construct it with NewBus.
type Bus struct {
	mu          sync.Mutex
	epoch       string
	seq         uint64
	buffer      []Event
	count       int
	closed      bool
	subscribers map[*Subscription]struct{}
}

// NewBus uses the default 2048-event capacity for size zero. Negative sizes
// are clamped to one, matching the legacy minimum buffer size.
func NewBus(size int) *Bus {
	if size == 0 {
		size = EventBufferSize
	}
	return &Bus{
		epoch:       randomHex(4),
		buffer:      make([]Event, max(1, size)),
		subscribers: make(map[*Subscription]struct{}),
	}
}

func randomHex(size int) string {
	data := make([]byte, size)
	// crypto/rand.Read always fills the buffer; Go terminates on entropy failure.
	rand.Read(data)
	return hex.EncodeToString(data)
}

func timestamp() float64 {
	now := time.Now()
	return float64(now.Unix()) + float64(now.Nanosecond())/1e9
}

func encodeJSON(data any) ([]byte, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(data); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(out.Bytes(), []byte{'\n'}), nil
}

// Publish appends an event and wakes subscribers without blocking on them.
// A closed bus returns (nil, nil). Invalid event names or non-JSON payloads
// return an error without advancing the cursor. nil data is encoded as {}.
func (b *Bus) Publish(kind string, data any) (*Event, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil, nil
	}
	if strings.ContainsAny(kind, "\r\n") {
		return nil, fmt.Errorf("SSE event must be a single line")
	}
	if data == nil {
		data = struct{}{}
	}
	payload, err := encodeJSON(data)
	if err != nil {
		return nil, err
	}
	b.seq++
	event := Event{Seq: b.seq, ID: b.formatID(b.seq), Kind: kind, Data: payload, Time: timestamp()}
	b.buffer[(b.seq-1)%uint64(len(b.buffer))] = event
	b.count = min(b.count+1, len(b.buffer))
	for subscriber := range b.subscribers {
		select {
		case subscriber.wake <- struct{}{}:
		default:
		}
	}
	copy := cloneEvent(event)
	return &copy, nil
}

func cloneEvent(event Event) Event {
	event.Data = bytes.Clone(event.Data)
	return event
}

func (b *Bus) formatID(seq uint64) string {
	return b.epoch + "-" + strconv.FormatUint(seq, 10)
}

func (b *Bus) LastEventID() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.formatID(b.seq)
}

func (b *Bus) SubscriberCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subscribers)
}

func (b *Bus) Closed() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.closed
}

func (b *Bus) ParseEventID(value string) (uint64, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.parseEventIDLocked(value)
}

func (b *Bus) parseEventIDLocked(value string) (uint64, bool) {
	value = strings.TrimSpace(value)
	index := strings.LastIndexByte(value, '-')
	if index < 0 || value[:index] != b.epoch {
		return 0, false
	}
	raw := value[index+1:]
	if raw == "" {
		return 0, false
	}
	for _, digit := range raw {
		if digit < '0' || digit > '9' {
			return 0, false
		}
	}
	seq, err := strconv.ParseUint(raw, 10, 64)
	return seq, err == nil && seq <= b.seq
}

// EventsAfter reports whether all events after seq remain available.
func (b *Bus) EventsAfter(seq uint64) ([]Event, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.eventsAfterLocked(seq)
}

func (b *Bus) eventsAfterLocked(seq uint64) ([]Event, bool) {
	if seq >= b.seq {
		return []Event{}, true
	}
	oldest := b.seq - uint64(b.count) + 1
	if seq < oldest-1 {
		return []Event{}, false
	}
	events := make([]Event, 0, b.seq-seq)
	for next := seq + 1; next <= b.seq; next++ {
		events = append(events, cloneEvent(b.buffer[(next-1)%uint64(len(b.buffer))]))
	}
	return events, true
}

// Close cancels all existing subscriptions, including across an immediate Reopen.
func (b *Bus) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	for subscriber := range b.subscribers {
		close(subscriber.done)
		delete(b.subscribers, subscriber)
	}
}

// Reopen keeps the epoch, sequence and replay buffer.
func (b *Bus) Reopen() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = false
}

// Subscription has one Next consumer. Close may be called concurrently.
// Call Close when abandoning a subscription without cancelling Next's context.
type Subscription struct {
	bus     *Bus
	wake    chan struct{}
	done    chan struct{}
	cursor  uint64
	pending []Event
}

// Subscribe starts at the current position for an empty cursor. Other cursors
// replay missed events, or receive resync when they cannot be replayed.
func (b *Bus) Subscribe(cursor string) *Subscription {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := &Subscription{bus: b, wake: make(chan struct{}, 1), done: make(chan struct{})}
	if b.closed {
		close(s.done)
		return s
	}
	b.subscribers[s] = struct{}{}
	s.cursor = b.seq
	if strings.TrimSpace(cursor) == "" {
		s.pending = []Event{b.markerLocked(HelloEvent, "")}
	} else if seq, ok := b.parseEventIDLocked(cursor); ok {
		s.cursor = seq
	} else {
		s.pending = []Event{b.markerLocked(ResyncEvent, "unknown_cursor")}
	}
	return s
}

func (b *Bus) markerLocked(kind, reason string) Event {
	id := b.formatID(b.seq)
	data, _ := encodeJSON(struct {
		LastEventID string `json:"last_event_id"`
		Reason      string `json:"reason"`
	}{id, reason})
	event := Event{ID: id, Kind: kind, Data: data}
	if kind == HelloEvent {
		event.Retry = SSERetryMS
	}
	return event
}

func (s *Subscription) Close() {
	s.bus.mu.Lock()
	defer s.bus.mu.Unlock()
	if _, exists := s.bus.subscribers[s]; exists {
		delete(s.bus.subscribers, s)
		close(s.done)
	}
}

// Next waits for the next event. Cancellation unregisters the subscription;
// closing the bus or subscription returns io.EOF.
func (s *Subscription) Next(ctx context.Context) (*Event, error) {
	return s.next(ctx, nil)
}

// A nil event with no error is a heartbeat tick (only used by the HTTP handler).
func (s *Subscription) next(ctx context.Context, heartbeat <-chan time.Time) (*Event, error) {
	for {
		if err := ctx.Err(); err != nil {
			s.Close()
			return nil, err
		}
		select {
		case <-s.done:
			return nil, io.EOF
		default:
		}
		if len(s.pending) > 0 {
			event := s.pending[0]
			s.pending = s.pending[1:]
			return &event, nil
		}
		s.bus.mu.Lock()
		events, complete := s.bus.eventsAfterLocked(s.cursor)
		if !complete {
			s.cursor = s.bus.seq
			events = []Event{s.bus.markerLocked(ResyncEvent, "buffer_overflow")}
		} else if len(events) > 0 {
			s.cursor = events[len(events)-1].Seq
		}
		s.bus.mu.Unlock()
		if len(events) > 0 {
			s.pending = events
			continue
		}
		select {
		case <-ctx.Done():
			s.Close()
			return nil, ctx.Err()
		case <-s.done:
			return nil, io.EOF
		case <-s.wake:
		case <-heartbeat:
			return nil, nil
		}
	}
}
